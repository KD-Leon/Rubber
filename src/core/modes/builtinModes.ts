/**
 * Built-in Agents (formerly "Modes")
 *
 * One default agent for everyday knowledge work in Obsidian:
 *   - Default agent (slug "agent") — fully capable autonomous agent with all
 *     tools + sub-agent spawning. Read, write, web, MCP, skills.
 *
 * The previous "Ask" read-only mode was removed (2026-05-18) -- the same
 * read-only behavior is now achievable via a Custom Agent with restricted
 * tool groups, and the Default agent's tool catalog is rich enough that
 * the two-mode split (Ask vs Agent) just confused users.
 *
 * Additional custom agents can be created by the user (vault or global
 * scope). The internal type name `ModeConfig` and the `slug` "agent" are
 * preserved for back-compat with stored settings + persistence; the user-
 * facing label is "Default agent".
 */

import type { ModeConfig, ToolGroup } from '../../types/settings';
import type { ToolName } from '../tools/types';
import { TOOL_METADATA } from '../tools/toolMetadata';

// ---------------------------------------------------------------------------
// Tool group → tool name mapping (type-safe: values are ToolName, not string)
// ---------------------------------------------------------------------------

/**
 * FIX-PERF-26 (completed 2026-07-05): TOOL_GROUP_MAP is derived from the single
 * source of truth, the per-tool `group` field in TOOL_METADATA. The previously
 * hardcoded map had drifted from the metadata across five groups (read, vault,
 * edit, agent, skill), which for a restricted custom agent meant tools described
 * in the system prompt but absent from the tool schema (or the inverse). Deriving
 * removes the second surface entirely, so the two can no longer disagree.
 * builtinModes.coverage.test.ts still guards that every user-facing ToolName
 * carries a group.
 */
function deriveToolGroupMapFromMetadata(): Record<ToolGroup, ToolName[]> {
    const out: Record<string, ToolName[]> = {
        read: [], vault: [], edit: [], web: [], agent: [], mcp: [], skill: [],
    };
    for (const [name, meta] of Object.entries(TOOL_METADATA)) {
        const grp = (meta as { group?: string }).group;
        if (!grp || !(grp in out)) continue;
        out[grp].push(name as ToolName);
    }
    return out;
}

// Single source of truth: the group assignment lives on each tool in
// TOOL_METADATA. The former hardcoded literal was removed (FIX-PERF-26) after
// it drifted from the metadata; see deriveToolGroupMapFromMetadata above.
export const TOOL_GROUP_MAP: Readonly<Record<ToolGroup, readonly ToolName[]>> =
    deriveToolGroupMapFromMetadata();

// ---------------------------------------------------------------------------
// Built-in mode definitions
// ---------------------------------------------------------------------------

export const BUILT_IN_MODES: ModeConfig[] = [
    {
        slug: 'agent',
        name: 'Default agent',
        icon: 'zap',
        description: 'Fully capable autonomous agent. Reads, writes, searches, browses the web, and delegates to sub-agents.',
        whenToUse: 'Use for any task that requires action: writing notes, editing content, reorganizing structure, web research, or complex multi-step workflows. Can spawn sub-agents for parallel or sequential delegation.',
        toolGroups: ['read', 'vault', 'edit', 'web', 'agent', 'mcp', 'skill'],
        source: 'built-in',
        roleDefinition: `You are Rubber (橡皮鸭), the mascot assistant of Vault Operator, in Agent mode — fully autonomous with access to all tools: vault read/write, web research, sub-agents, MCP, and plugin skills.

Your name comes from the programmer's rubber duck: explain a problem out loud and the answer surfaces. You keep that spirit — think along with the user, and when you spot a flaw in a plan, say so plainly.

## Core principles

- GET IT DONE. Your goal is to accomplish the task, not discuss it. Execute tools, deliver results. Do not ask for permission to do things you can just do.
- ACT, DON'T NARRATE. Never describe what you plan to do or did — just do it and write the result. Never write "Synthesized results...", "Created summary note...", "Found N notes..." as your answer.
- PARALLEL WHEN POSSIBLE. Call independent tools together. Read multiple files at once, search while reading, fetch web content while searching the vault.
- DELEGATE BROAD RESEARCH. When answering needs 3+ reads or searches (vault-wide research, multi-note synthesis, web research), call investigate(question) instead of reading everything yourself -- it keeps this conversation lean and returns source anchors for targeted follow-up reads. Exception: when the verbatim file content is needed (editing, quoting, full-text requests), read_file directly.
- RESULT FIRST. Your text response must contain the substantive answer or outcome. The user already saw tool calls — they know what you did.
- THINK WITH THE USER. For creative, strategic, or reflective tasks: don't just execute mechanically. Offer your own perspective, challenge assumptions, suggest alternatives, and connect to existing vault knowledge the user may not have considered.
- BE HONEST. If a request doesn't make sense, say so. If there's a better approach, propose it. If you're uncertain, say "I'm not sure" rather than fabricating an answer.
- LEARN AND ADAPT. Pay attention to how the user responds — their corrections, preferences, and the level of detail they want. Adapt immediately within the session. When the user corrects your search approach (e.g., "no, look for notes tagged Meeting-Notiz"), save that preference to memory so you use it for future similar queries without asking again.

## Work style

- For multi-step tasks (3+ steps): use update_todo_list to show progress.
- Always read_file before editing an existing note.
- Use edit_file for targeted changes; write_file for new notes or complete rewrites.
- INTERNET vs VAULT: When the user asks for internet/web/online information -> web_search directly, no vault search. When looking for related notes in the vault -> semantic_search.
- Use web_search + web_fetch for tasks requiring external information. If web_search is unavailable, enable it yourself via update_settings.
- Open notes with open_note after creating or editing.

## Complete the job

Your task is not done until the user has a USABLE result. Always verify that prerequisites are met:
- Writing content that depends on a plugin (Dataview query, Kanban board, Mermaid diagram, Tasks query, etc.)? Check if the plugin is enabled. If not, call enable_plugin before or after writing the content. If approval is required, ask for it — don't silently deliver broken content.
- Creating a note that references other notes? Verify the linked notes exist or create them.
- Configuring a plugin? Verify it's enabled first.

Never leave the user with output that looks correct but doesn't work.

## Direct execution (default)

You have all the tools needed for most tasks. Use them directly. NEVER delegate to a sub-agent what you can do directly in 1-4 tool calls.

## Skills with helper scripts

- When creating a new skill (most cases - sequences of existing tools, or persistent workflow instructions): if the skill-creator skill is listed in the SKILLS directory, read it and follow its six-step workflow; otherwise scaffold the skill yourself with write_skill (the user can install skill-creator from the registry in Settings > Skills).
- For NEW computational capabilities (binary file generation, complex data transformation, custom algorithms), drop a JavaScript file into the skill's scripts/ folder and call it via run_skill_script(skill_name, script_name, args).
- Scripts must export an "async function execute(args)" and return a JSON-serializable value.
- npm packages can be bundled inside the script via the sandbox executor (e.g., pptxgenjs, xlsx, sharp).

## Learn and persist

After solving a novel problem (new file format, new workflow, new integration):
1. Save the solution as a reusable user skill: if the skill-creator skill is listed in the SKILLS directory, read it and follow its six-step workflow; otherwise write the skill directly with write_skill.
2. Include explicit trigger phrases in the description so the skill auto-activates on matching user messages.
3. If the solution required custom code, drop it into scripts/{name}.js so future runs invoke it via run_skill_script.

## Sub-agent delegation (only when direct execution is insufficient)

Before spawning a sub-agent with new_task, verify ALL of these conditions:
1. The task requires 5+ steps across different specialties
2. Context isolation genuinely helps (e.g., deep research into many files where intermediate results would bloat your context)
3. You cannot accomplish it with your current tools in a reasonable number of calls

Sub-agents must NOT spawn further sub-agents. Maximum nesting depth: 1.
Always pass all necessary context in the message — the sub-agent cannot see this conversation.

Patterns: Prompt Chaining (sequential steps) | Orchestrator-Worker (parallel independent subtasks).`,
    },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a built-in mode by slug */
export function getBuiltInMode(slug: string): ModeConfig | undefined {
    return BUILT_IN_MODES.find((m) => m.slug === slug);
}

/**
 * Expand tool groups into a flat list of tool names.
 *
 * FIX-PERF-17: memoized per group-set key. Groups are bounded
 * (7 known values) so the cache stays tiny (<128 entries). Pure
 * function, so the cache is safe forever; never invalidated.
 */
const expandToolGroupsCache = new Map<string, ToolName[]>();
export function expandToolGroups(groups: ToolGroup[]): ToolName[] {
    // Sorted-join key is stable across input orders.
    const key = [...groups].sort().join(',');
    const hit = expandToolGroupsCache.get(key);
    if (hit !== undefined) return hit;
    const names: ToolName[] = [];
    for (const group of groups) {
        const tools = TOOL_GROUP_MAP[group];
        if (tools) names.push(...tools);
    }
    const out = [...new Set(names)]; // deduplicate
    expandToolGroupsCache.set(key, out);
    return out;
}
