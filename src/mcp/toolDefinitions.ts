/**
 * MCP tool definitions for the external bearer-token surface.
 *
 * FIX-44-47: definitions moved out of McpBridge into a leaf module so the
 * dispatcher (tools/index.ts) can derive the write gate from them without an
 * import cycle. Every definition carries a MANDATORY `effect` declaration
 * (see McpToolEffect in types.ts); the gate set MCP_WRITE_TOOLS is derived
 * from those declarations, and anything undeclared resolves fail-closed to
 * 'write'. The drift contract lives in __tests__/mcpToolEffects.test.ts.
 */

import type { McpToolDefinition, McpToolEffect } from './types';
import {
    resolveExternalSourceInterface,
    type SourceInterface,
} from '../core/memory/SourceInterface';

// Tool definitions exposed to Claude
// Agent-internal tools that don't make sense for external MCP clients.
// FIX-23-09-02: extended with polymorphic / arbitrary-code-execution tools
// (execute_command, use_mcp_tool, invoke_mcp_server, invoke_skill,
// run_skill_script, evaluate_expression) and identity-mutating tools
// (update_soul) that GitHub issue #46 correctly flagged as too broad for
// the catch-all execute_vault_op surface.
export const AGENT_INTERNAL_TOOLS = new Set([
    'ask_followup_question', 'attempt_completion', 'switch_agent', 'new_task',
    'update_todo_list', 'execute_recipe', 'manage_mcp_server',
    'manage_source', 'resolve_capability_gap', 'configure_model', 'read_agent_logs',
    'update_settings', 'enable_plugin', 'call_plugin_api',
    // FIX-23-09-02: polymorphic dispatch / arbitrary-code surfaces
    'execute_command', 'use_mcp_tool', 'invoke_mcp_server', 'invoke_skill',
    'run_skill_script', 'evaluate_expression',
    // FIX-23-09-02: identity / soul mutation
    'update_soul',
]);

// ---------------------------------------------------------------------------
// Source isolation (FIX-23-09-08)
// ---------------------------------------------------------------------------

/**
 * Operations whose result is memory or history content and therefore carries
 * the strictSourceIsolation promise: without an explicit source_interface the
 * read is not scoped to one surface.
 */
export const SOURCE_ISOLATED_OPERATIONS: ReadonlySet<string> = new Set([
    'recall_memory',
    'search_history',
]);

export type SourceIsolationVerdict =
    | { blocked: false; sourceFilter: SourceInterface | undefined }
    | { blocked: true; message: string };

/**
 * FIX-23-09-08: the single source-isolation check for the whole MCP surface.
 *
 * The guard used to live inside the recall_memory and search_history wrappers.
 * execute_vault_op reaches the SAME core tools without passing a wrapper, so the
 * identical request was refused on one path and answered with memory content on
 * the other -- the promise was a property of the chosen path, not of the system.
 * Every entry point now asks this function before it dispatches.
 *
 * `scopesBySource` says whether the CALLER actually applies the resolved filter.
 * The wrappers do. The dispatcher does not: the core RecallMemoryTool and
 * SearchHistoryTool know no source_interface at all, so a value smuggled through
 * `params` would look like scoping while the read stayed vault-wide. There the
 * honest answer is a refusal that names the path which can scope.
 */
export function enforceSourceIsolation(input: {
    operation: string;
    args: Record<string, unknown>;
    strictSourceIsolation: boolean;
    scopesBySource: boolean;
}): SourceIsolationVerdict {
    // AUDIT 2026-07-14 (Codex) H-1: a client-supplied 'obsilo' is coerced to
    // 'unknown' so an external caller cannot read the plugin-internal partition.
    const sourceFilter: SourceInterface | undefined = input.args.source_interface !== undefined
        ? resolveExternalSourceInterface(input.args.source_interface)
        : undefined;

    if (!input.strictSourceIsolation || !SOURCE_ISOLATED_OPERATIONS.has(input.operation)) {
        return { blocked: false, sourceFilter };
    }

    if (!input.scopesBySource) {
        return {
            blocked: true,
            message: 'strictSourceIsolation is enabled in Settings -- execute_vault_op cannot scope '
                + `"${input.operation}" by source. Call the dedicated ${input.operation} tool with an `
                + 'explicit source_interface argument instead.',
        };
    }

    if (!sourceFilter) {
        return {
            blocked: true,
            message: `strictSourceIsolation is enabled in Settings -- ${input.operation} requires `
                + 'an explicit source_interface argument to scope the read.',
        };
    }

    return { blocked: false, sourceFilter };
}

export const TOOLS: McpToolDefinition[] = [
    {
        name: 'get_context',
        effect: 'read',
        description: 'Returns vault statistics, available skills, and rules. When strictSourceIsolation is off and the caller is the plugin itself, also returns user profile and memory context. Recommended as the first call of a session.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'search_vault',
        effect: 'read',
        description: 'Intelligent vault search: combines semantic similarity, keyword matching, tag-match, weighted RRF fusion, graph expansion (Wikilinks + MOC + implicit), and cross-encoder reranking in one call. Returns rich results with excerpts, scores, and connection context.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural-language search query' },
                top_k: { type: 'number', description: 'Max results (default: 8, max: 20)' },
                folder: { type: 'string', description: 'Restrict to folder (prefix match)' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any match)' },
                since: { type: 'string', description: 'Only notes modified on or after this date (ISO: "2026-01-01")' },
            },
            required: ['query'],
        },
    },
    {
        name: 'read_notes',
        effect: 'read',
        description: 'Read one or more vault files. Returns content with frontmatter, tags, and linked notes for each file.',
        inputSchema: {
            type: 'object',
            properties: {
                // FIX-14-00-02: the handler reads at most 20 paths per call.
                // maxItems keeps a conforming client from sending more; the
                // handler still names the dropped count for clients that do.
                paths: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'File paths relative to vault root (max 20 per call)' },
            },
            required: ['paths'],
        },
    },
    {
        name: 'write_vault',
        // FIX-44-47: vault file CUD; pre-write checkpoint in handleWriteVault (FIX-44-27)
        effect: 'write',
        description: 'Create, edit, or delete vault files. Supports batch operations.',
        inputSchema: {
            type: 'object',
            properties: {
                operations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            type: { type: 'string', enum: ['create', 'edit', 'append', 'delete'] },
                            path: { type: 'string' },
                            content: { type: 'string' },
                        },
                        required: ['type', 'path'],
                    },
                },
            },
            required: ['operations'],
        },
    },
    {
        name: 'execute_vault_op',
        // FIX-44-47: per-operation governance via ToolExecutionPipeline + headless policy (FIX-44-46)
        effect: 'dispatch',
        // IMP-14-00-01: the description used to end at the list of names, which
        // left every parameter name to be guessed. It now points at the lookup.
        // The bridge appends the runtime operation list to this text instead of
        // replacing it, so both halves reach the client (see getToolsWithContext).
        description:
            'Execute any vault operation by name. The available operations are appended to this '
            + 'description at runtime. '
            + 'Operation parameters are NOT part of this schema: call operation="describe_operation" with '
            + 'params.operation set to an operation name to get its parameter schema from the registry. '
            + 'A failed call answers with the same schema.',
        inputSchema: {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    description: 'Operation name, or "describe_operation" to look up the parameters of one.',
                },
                params: {
                    type: 'object',
                    description: 'Operation-specific parameters, as returned by describe_operation.',
                },
            },
            required: ['operation'],
        },
    },
    {
        name: 'sync_session',
        effect: 'session',
        description:
            'Legacy auto-tracking tool: replicates the current MCP-session conversation into Obsidian\'s chat history. ' +
            'For cross-surface use cases, save_conversation is the preferred entry point: it provides Living-Document ' +
            'semantics (the conversation grows over multiple turns, no duplication) and Cross-Interface-Threads. ' +
            'sync_session is intended as a one-shot session-end snapshot when no structured messages array is available. ' +
            'Passing source_interface lets the conversation appear in the matching History tab.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short title (2-5 words)' },
                transcript: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            role: { type: 'string', enum: ['user', 'assistant'] },
                            text: { type: 'string', description: 'The exact message text' },
                        },
                        required: ['role', 'text'],
                    },
                    description: 'Copy every message from this conversation. User messages verbatim. Your responses as you wrote them. Simply replicate the chat.',
                },
                learnings: { type: 'string', description: 'Optional: anything to remember for next time' },
                source_interface: {
                    type: 'string',
                    enum: ['claude-ai', 'claude-code', 'chatgpt', 'perplexity', 'unknown'],
                    description: 'Source tag. Defaults to "unknown" -- always pass the right value (e.g. "claude-ai") so the conversation lands in the matching History-Sidebar tab.',
                },
            },
            required: ['title', 'transcript'],
        },
    },
    {
        name: 'update_memory',
        // FIX-44-47: legacy alias of save_to_memory; same non-vault memory.db target
        effect: 'write',
        description:
            '[deprecated, use save_to_memory] Update persistent memory: user profile, behavioral patterns, known errors, or active projects. ' +
            'This call is now routed to save_to_memory (Memory v2); the legacy memory/{category}.md V1 files are no longer written.',
        inputSchema: {
            type: 'object',
            properties: {
                category: { type: 'string', enum: ['profile', 'patterns', 'errors', 'projects'] },
                content: { type: 'string', description: 'Content to append' },
                source_interface: {
                    type: 'string',
                    enum: ['obsilo', 'claude-ai', 'claude-code', 'chatgpt', 'perplexity', 'unknown'],
                    description: 'Optional source tag (BA-26). Default: unknown.',
                },
            },
            required: ['category', 'content'],
        },
    },
    // BA-26 / EPIC-23 -- Cross-Surface MCP Tools (FEAT-23-01, -02, -05)
    {
        name: 'save_to_memory',
        // FIX-44-47: persists into the user-global sql.js DB ({vault-parent}/.obsidian-agent/memory.db) OUTSIDE the vault, so the git checkpoint (vault shadow repo) cannot apply; undo path is fact deletion in the Memory tab, each insert is one additive fact
        effect: 'write',
        description:
            'Persist a single fact or insight in Vault Operator Memory v2. Each call produces one fact entry. ' +
            'Use this when the user explicitly asks to remember something across their chat tools ' +
            '(Vault Operator, Claude Desktop, Claude.ai, ChatGPT, Claude Code, Perplexity). Tags are optional. ' +
            'The configured source_interface tag (per connector config) labels the entry so it stays filterable later.',
        inputSchema: {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'The fact text. Single statement, max 4000 chars.' },
                tags: {
                    type: 'array', items: { type: 'string' },
                    description: 'Optional 1-5 short lowercase tags (e.g. ["coding", "preferences"]).',
                },
                kind: {
                    type: 'string',
                    enum: ['fact', 'preference', 'identity', 'event'],
                    description: 'Default "fact".',
                },
                importance: {
                    type: 'number',
                    description: '0..1 (default 0.5). 0.9 = identity-level, 0.7 = stable preference.',
                },
                source_interface: {
                    type: 'string',
                    enum: ['obsilo', 'claude-ai', 'claude-code', 'chatgpt', 'perplexity', 'unknown'],
                    description: 'Source tag. Configure as a connector constant. Default "unknown".',
                },
                source_uri: {
                    type: 'string',
                    description: 'Optional URI of origin (chat link, vault path, web URL).',
                },
            },
            required: ['content'],
        },
    },
    {
        name: 'save_conversation',
        effect: 'session',
        description:
            'Copy a conversation from an external chat tool into Vault Operator\'s shared History sidebar. ' +
            'Conversations appear in the matching source-tab.\n\n' +
            'Living-document behaviour (default on): when the user asks to save the current ' +
            'conversation again later in the same session, call save_conversation again with ' +
            'the new turns. The plugin auto-detects the active conversation (within 30 minutes ' +
            'from the same source_interface) and appends. Tracking the conversation_id yourself ' +
            'is optional. Either the full transcript (plugin computes the delta) or only the new ' +
            'turns (plugin appends them as-is) can be sent. For explicit control, pass the ' +
            'conversation_id from the previous result.\n\n' +
            'CROSS-INTERFACE THREADS: the first save_conversation result returns a ' +
            'cross_interface_thread_id. When the user continues the same topic in a different ' +
            'tool (e.g. claude-ai -> claude-code), pass that thread_id to link both conversations.\n\n' +
            'SYNC-MODE: per-provider Auto vs Manual is user-configured. Auto triggers memory-' +
            'extraction immediately with the same thresholds as Vault Operator-internal conversations; ' +
            'Manual parks the conversation as pending until the user confirms. ChatGPT and ' +
            'Perplexity default to Manual to keep family-shared accounts out of personal memory.',
        inputSchema: {
            type: 'object',
            properties: {
                messages: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            role: { type: 'string', enum: ['user', 'assistant'] },
                            text: { type: 'string' },
                            ts: { type: 'string', description: 'Optional ISO timestamp.' },
                        },
                        required: ['role', 'text'],
                    },
                    description: 'Up to 500 messages.',
                },
                title: { type: 'string', description: 'Optional title (max 200 chars).' },
                source_interface: {
                    type: 'string',
                    enum: ['claude-ai', 'claude-code', 'chatgpt', 'perplexity', 'unknown'],
                    description: 'Source tag (required, "obsilo" reserved for the plugin).',
                },
                living_document: {
                    type: 'boolean',
                    description: 'Default: true (Settings). Set false to force a new standalone conversation.',
                },
                conversation_id: {
                    type: 'string',
                    description: 'Optional: conversation_id returned by a previous save_conversation. Forces append into the same conversation.',
                },
                cross_interface_thread_id: {
                    type: 'string',
                    description: 'Optional: thread-YYYY-MM-DD-{6-hex} ID. Links the new conversation to an existing cross-interface thread.',
                },
            },
            required: ['messages', 'source_interface'],
        },
    },
    {
        name: 'close_conversation',
        effect: 'session',
        description:
            'Explicitly end the Living-Document Active-Session for a given conversation. After this ' +
            'call, the next save_conversation from the same MCP-Session creates a new conversation ' +
            'instead of appending. Use when the user signals end-of-topic.',
        inputSchema: {
            type: 'object',
            properties: {
                conversation_id: { type: 'string', description: 'The conversation_id returned by save_conversation.' },
            },
            required: ['conversation_id'],
        },
    },
    {
        name: 'recall_memory',
        effect: 'read',
        description:
            'Search Vault Operator Memory v2 facts by meaning. Returns top-K hits ranked by cosine over ' +
            'fact_embeddings (with token-overlap fallback). Optional source_interface filter to ' +
            'restrict to facts from a specific tool.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural-language search query.' },
                top_k: { type: 'number', description: '1-30, default 10.' },
                kind: {
                    type: 'string',
                    enum: ['fact', 'preference', 'identity', 'event'],
                    description: 'Optional kind filter.',
                },
                source_interface: {
                    type: 'string',
                    enum: ['obsilo', 'claude-ai', 'claude-code', 'chatgpt', 'perplexity', 'unknown'],
                    description: 'Optional: restrict to facts from this surface only.',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'search_history',
        effect: 'read',
        description:
            'Keyword-search across past conversations from any source (Vault Operator, ChatGPT, Claude.ai, ' +
            'Claude Code, Perplexity). Returns matching messages with clickable obsidian://vault-operator-chat ' +
            'links to the source conversation. Optional source_interface filter.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Keyword or short phrase, case-insensitive.' },
                top_k: { type: 'number', description: '1-30, default 10.' },
                role: {
                    type: 'string',
                    enum: ['user', 'assistant', 'system', 'tool'],
                    description: 'Optional role filter.',
                },
                source_interface: {
                    type: 'string',
                    enum: ['obsilo', 'claude-ai', 'claude-code', 'chatgpt', 'perplexity', 'unknown'],
                    description: 'Optional: restrict to one chat surface.',
                },
            },
            required: ['query'],
        },
    },
    // Memory v2 Phase 3 (FEATURE-0317 / PLAN-006 task 10): expose
    // implicit-edge + note-metadata reads so a Setup-C standalone engine
    // (McpKnowledgeAdapter) can route Vault-graph queries through the
    // Plugin-MCP. Read-only.
    {
        name: 'get_vault_implicit_edges',
        effect: 'read',
        description:
            'Return implicit (cosine-based) neighbours of a vault note. Used by Memory v2 ' +
            'cross-DB walks when the engine runs as a standalone service.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Vault-relative note path.' },
                hops: { type: 'number', description: 'BFS depth (1-3, default 1).' },
                limit: { type: 'number', description: 'Max neighbours (default 20).' },
            },
            required: ['path'],
        },
    },
    {
        name: 'get_vault_note_metadata',
        effect: 'read',
        description:
            'Return tags + last-indexed timestamp for a vault note. Used by Memory v2 ' +
            'edge-resolution to detect stale references.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Vault-relative note path.' },
            },
            required: ['path'],
        },
    },
];

// ---------------------------------------------------------------------------
// Derived write gate (FIX-44-47)
// ---------------------------------------------------------------------------

/**
 * Resolve the effect class of an MCP tool on the external surface.
 *
 * Fail-closed by construction: an unknown tool, or a definition whose effect
 * declaration is missing at runtime (JS fixture, cast), resolves to 'write'
 * and is therefore gated behind settings.mcpAllowWriteTools. There is NO
 * fallback to 'read' -- that fallback was the fail-open allowlist bug.
 */
export function resolveMcpToolEffect(
    toolName: string,
    definitions: readonly McpToolDefinition[] = TOOLS,
): McpToolEffect {
    const declared: unknown = definitions.find((t) => t.name === toolName)?.effect;
    if (declared === 'read' || declared === 'session' || declared === 'dispatch') {
        return declared;
    }
    return 'write';
}

/**
 * MCP-2 / FIX-44-26 / FIX-44-47: MCP tools that mutate vault content or
 * long-term memory; gated behind settings.mcpAllowWriteTools (default off,
 * fail-closed). Derived from the effect declarations above -- do not
 * hand-maintain a name list next to the registrations.
 */
export const MCP_WRITE_TOOLS: ReadonlySet<string> = new Set(
    TOOLS.filter((t) => t.effect === 'write').map((t) => t.name),
);
