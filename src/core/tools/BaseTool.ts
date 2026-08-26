/**
 * BaseTool - Abstract base class for all tools
 *
 * Adapted from Kilo Code's tool architecture.
 * All tools (internal and MCP) extend this class.
 */

import type { App } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import type {
    ToolName,
    ToolDefinition,
    ToolExecutionContext,
} from './types';

/**
 * Abstract base class for all tools
 */
export abstract class BaseTool<TName extends ToolName = ToolName> {
    /**
     * The unique name of this tool
     */
    abstract readonly name: TName;

    /**
     * Whether this tool writes vault FILES.
     *
     * Drives ONLY the pre-write checkpoint snapshot and read-cache invalidation.
     *
     * NOT the approval decision. That is made solely by the central effect
     * registry (ADR-153, `src/core/tools/toolEffects.ts`). The approval gate used
     * to hang off this flag, and because every tool declares it ABOUT ITSELF,
     * five tools with real side effects (update_settings, update_soul,
     * manage_mcp_server, mark_for_memory, get_daily_note) skipped the check
     * simply by having `false` here.
     */
    abstract readonly isWriteOperation: boolean;

    /**
     * Obsidian app instance
     */
    protected app: App;

    /**
     * Plugin instance
     */
    protected plugin: ObsidianAgentPlugin;

    constructor(plugin: ObsidianAgentPlugin) {
        this.plugin = plugin;
        this.app = plugin.app;
    }

    /**
     * Get the tool definition (schema) for the LLM
     */
    abstract getDefinition(): ToolDefinition;

    /**
     * Execute the tool with the given input
     *
     * @param input - Tool input parameters from LLM
     * @param context - Execution context
     */
    abstract execute(
        input: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<void>;

    /**
     * Validate the tool input (optional)
     * Override this to add custom validation
     */
    protected validate(input: Record<string, unknown>): void {
        // Default: no validation
        // Subclasses can override to validate input
    }

    /**
     * Format an error message for the LLM
     */
    protected formatError(error: unknown): string {
        if (error instanceof Error) {
            return `<error>${error.message}</error>`;
        }
        return `<error>Unknown error: ${String(error)}</error>`;
    }

    /**
     * Format a success message for the LLM
     */
    protected formatSuccess(message: string): string {
        return `<success>${message}</success>`;
    }

    /**
     * Format content for the LLM
     *
     * AUDIT-034 L-15: attribute values are XML-escaped to prevent attribute
     * injection via crafted metadata coming from vault paths, search hits, or
     * external tool results.
     */
    protected formatContent(content: string, metadata?: Record<string, string>): string {
        const attrs = metadata
            ? Object.entries(metadata)
                  .map(([key, value]) => `${key}="${escapeXmlAttribute(value)}"`)
                  .join(' ')
            : '';

        return attrs ? `<content ${attrs}>\n${content}\n</content>` : content;
    }

    /**
     * Wrap untrusted content from external sources (web pages, document
     * parsers, MCP responses, semantic-search excerpts) in a boundary tag the
     * model recognises as user data, not as instructions.
     *
     * AUDIT-034 L-15 / L-16: aligns with wrapVaultContentForMcp at
     * McpBridge.ts:866. The system prompt's SECURITY BOUNDARY section
     * enumerates the recognised wrappers and how to treat them.
     *
     * @param source A short trust-domain label, e.g. "web", "mcp", "document".
     * @param content Raw text returned by the tool.
     * @param metadata Optional attribute map (url, server, tool, path).
     */
    protected formatUntrustedContent(
        source: string,
        content: string,
        metadata?: Record<string, string>
    ): string {
        const baseAttrs: Record<string, string> = {
            source,
            trust: 'user-data',
            ...(metadata ?? {}),
        };
        const attrs = Object.entries(baseAttrs)
            .map(([key, value]) => `${key}="${escapeXmlAttribute(value)}"`)
            .join(' ');
        return `<untrusted-content ${attrs}>\n${defangBoundaryTags(content)}\n</untrusted-content>`;
    }
}

/**
 * Boundary-wrapper tag names the agent loop emits (see securityBoundary.ts).
 * Kept in sync with that enumeration; `defangBoundaryTags` strips these from
 * untrusted bodies so a crafted document cannot pre-close the wrapper.
 *
 * FIX-29-05-05: added `imported-skill` (ReadSkillTool.frameSkill and
 * InvokeSkillTool emit it as the untrusted-skill trust envelope) and
 * `explicit_instructions` (AgentSidebarView, WorkflowLoader).
 *
 * IMPORTANT, and the reason this note exists: listing a tag here protects
 * NOTHING on its own. Protection comes from an emitter calling
 * defangBoundaryTags on the untrusted part before wrapping it. An earlier
 * revision of this comment claimed adding `imported-skill` stopped wrapped
 * content from closing its own envelope; it did not, because no caller
 * defanged the skill BODY (audit FIX-29-05 H-1). Both emitters now do. When
 * adding a tag here, find and fix its emitter in the same change.
 *
 * FIX-29-05 audit L-2: `success` and `error` were briefly on this list and have
 * been removed. Unlike every other entry they are ordinary XML element names,
 * so stripping them corrupted legitimate content the user asked the agent to
 * read (a JUnit report's `<error type="...">` silently read as a pass). The
 * one real concern -- a literal `<error>` in vault content skewing result
 * classification -- belongs at the classifier, which is now anchored
 * (summarizeForLedger.ts).
 *
 * The prefix `(?:\s*\/\s*|\/?)` allows whitespace variants of a CLOSING tag --
 * `< /available_skills >`, `</ available_skills>` -- which used to slip past
 * every layer that delegates here (audit FIX-29-05 M-1). Two properties of this
 * shape are load-bearing and must survive any edit (re-audit N-1, N-2):
 *
 *   1. Whitespace is tolerated ONLY together with the slash. A first attempt
 *      used `<\s*\/?\s*`, which made the slash optional while allowing space,
 *      so `if (count < history.length && x > 0)` matched `history` as a tag and
 *      `[^>]*` ate through to the next `>`, silently deleting source from every
 *      file the agent reads.
 *   2. The slash is a REQUIRED anchor between the two `\s*`. Two adjacent
 *      optional whitespace runs give the engine O(n^2) ways to split one run:
 *      80k spaces measured at ~2.8s on the renderer thread, reachable through
 *      the uncapped wrapVaultContentForMcp path.
 *
 * The tail is `[^<>\n]*` rather than `[^>]*` so a match cannot span lines and
 * swallow unrelated content on the way to a distant `>`.
 */
const BOUNDARY_TAG_RE =
    /<(?:\s*\/\s*|\/?)(?:untrusted-content|vault-content|vault_context|web_fetch|web_context|web_search|attached_document|attached_file|attached_folder|available_skills|mcp_response|history|selection|imported-skill|explicit_instructions)\b[^<>\n]*>/gi;

/**
 * Neutralise literal boundary-wrapper tags inside untrusted content.
 *
 * AUDIT 2026-07-14 M-1: `formatUntrustedContent` only escaped attribute values,
 * so a body containing `</untrusted-content>` (or any other wrapper's closing
 * tag) could pre-close the trust boundary and inject fresh instructions into
 * the trusted prompt scope. This is the defence for every tool-result path.
 * (The comment here used to claim the inline-action path already had it; AUDIT
 * 2026-07-26 M-6 found that `escapeForPromptBlock` was a single pass over three
 * tag names, so it was neither reconstruction-safe nor complete. It now calls
 * defangBoundaryTags, which is what this comment always implied.)
 * Exported for the non-BaseTool emitters (wrapVaultContentForMcp, AttachmentHandler).
 */
/**
 * Strip every match of `re` from `content`, iterating to a fixpoint.
 *
 * AUDIT 2026-07-14 (Codex review): a single `String.replace` pass is NOT
 * reconstruction-safe. A nested payload such as
 * `</available_<available_skills>skills>` becomes `</available_skills>` after the
 * inner tag is stripped, re-forming a live tag. Any tag-stripping sanitiser must
 * loop until the string stops changing (bounded). Shared so sibling sanitisers
 * (e.g. MemoryRetriever's structural-tag strip) cannot reintroduce the bug.
 */
export function stripToFixpoint(content: string, re: RegExp): string {
    // Each changing pass deletes at least one whole tag, so a TRUE fixpoint is
    // reached in at most content.length passes. Bounding by length (not a
    // constant) is essential: a deeply nested payload could otherwise out-run a
    // constant cap and leave a reassembled live tag in the returned string
    // (Codex review 2026-07-14). A tag-free input matches nothing on the first
    // pass and the loop body never runs, so legitimate content stays O(n).
    let prev = content;
    let out = content.replace(re, '');
    let guard = content.length;
    while (out !== prev && guard-- > 0) {
        prev = out;
        out = out.replace(re, '');
    }
    return out;
}

export function defangBoundaryTags(content: string): string {
    return stripToFixpoint(content, BOUNDARY_TAG_RE);
}

/**
 * Sanitise a single directory-entry field (skill name/description, MCP tool
 * description) before it goes into the cached system-prompt prefix.
 *
 * AUDIT 2026-07-14 (Codex) M-1: imported skill names/descriptions and MCP tool
 * descriptions were rendered raw between `<available_skills>` / tool-listing
 * wrappers. A crafted description could pre-close the wrapper and inject a
 * fresh instruction, or add extra list lines. This neutralises boundary tags,
 * collapses newlines to a single space (one entry = one line), and caps length.
 */
export function sanitizeDirectoryEntry(text: string, maxLen: number): string {
    const flat = defangBoundaryTags(text).replace(/[\r\n]+/g, ' ').trim();
    if (flat.length <= maxLen) return flat;
    return flat.slice(0, maxLen).trimEnd() + '...';
}

/**
 * XML-attribute-escape helper. Exported for unit tests and reuse by
 * subclasses that build their own boundary tags (WebFetchTool, UseMcpToolTool,
 * SemanticSearchTool).
 *
 * AUDIT-034 L-15.
 */
export function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
