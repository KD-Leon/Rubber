/**
 * ADR-153: effect-based approval gate.
 *
 * The single source of truth for whether a tool call needs user confirmation.
 *
 * Previously two independent sources decided this: the `isWriteOperation`
 * boolean that every tool declares ABOUT ITSELF, and a hand-maintained name map
 * in the Pipeline. A tool that declared `false` skipped the approval check
 * entirely -- even when it mutated configuration, persona or the vault. Five
 * tools did exactly that (update_settings, update_soul, manage_mcp_server,
 * mark_for_memory, get_daily_note), which let the agent turn off its own
 * default-deny via `update_settings apply_preset permissive` without the user
 * ever seeing a single approval card.
 *
 * Now the effect is declared centrally here, not claimed by the tool.
 * `isWriteOperation` only drives checkpoint snapshots and read-cache
 * invalidation.
 *
 * A tool with NO entry requires approval (fail-closed). The burden of proof is
 * inverted: a tool is harmless only once it is listed as harmless here.
 * `toolEffectCompleteness.test.ts` enforces that every registered tool has an
 * entry, so the drift that produced the original bug cannot recur unnoticed.
 */

import type { AutoApprovalConfig } from '../../types/settings';

/**
 * Effect class of a tool. NOT the same as the mode-level `ToolGroup` in
 * settings.ts, which controls tool AVAILABILITY per mode.
 */
export type ToolEffect =
    /** No mutation, no egress. Always runs automatically. */
    | 'read'
    /** Pure loop/UI control, nothing is persisted. Always runs automatically. */
    | 'ui'
    /** Note content CUD. */
    | 'note-edit'
    /** Vault structure CUD: delete, move, folders, Office binaries, checkpoint restore. */
    | 'vault-change'
    /** Plugin or agent configuration CUD. ALWAYS asks, never auto-approvable. */
    | 'config'
    /** Persona, long-term memory, own source code. ALWAYS asks (M-7). */
    | 'self-modify'
    /** Network egress: vault content can leave the device. */
    | 'web'
    /** Calls an external MCP tool. */
    | 'mcp'
    /** Spawns a subtask. */
    | 'subtask'
    /** Skill invocation or plugin command. */
    | 'skill'
    /** Executes sandboxed code with full SandboxBridge access. */
    | 'sandbox'
    /** Calls a foreign plugin's API (read vs write is decided from the input). */
    | 'plugin-api'
    /** Recipe execution. */
    | 'recipe';

/** The effect may depend on the input (get_daily_note only creates with create=true). */
export type ToolEffectSpec = ToolEffect | ((input: Record<string, unknown> | undefined) => ToolEffect);

/**
 * FIX-44-39: the key under which a run-/session-scope grant is stored AND
 * looked up. Plain effects use their class as-is. Input-dependent effects must
 * be resolved per call: `plugin-api` splits into read/write via the same
 * `isPluginApiWriteCall` helper the gate and the permanent grant use, so a
 * grant given on a READ card can never cover WRITE calls. The coarse
 * 'plugin-api' class itself is deliberately NOT a valid grant key.
 */
export type ApprovalGrantKey =
    | Exclude<ToolEffect, 'plugin-api'>
    | 'plugin-api:read'
    | 'plugin-api:write'
    // Content-hash grant for ONE byte-state of ONE vault-authored sandbox
    // script (built by sandboxScriptGrant.ts). Keyed on the SHA-256 of the
    // bytes, so a grant for one script can never cover a different one -- the
    // coarse 'sandbox' effect class stays deliberately un-grantable for
    // unverified vault code (AUDIT 2026-07-26 M-1 invariant).
    | `sandbox-script:${string}`;

/**
 * Prefix of dynamically loaded skill code tools. These declare their own
 * approval class inside the skill's source -- a self-report we do not trust.
 * They run sandboxed code with a vault.write bridge, so they are pinned to
 * 'sandbox' regardless of what they claim about themselves.
 */
export const DYNAMIC_TOOL_PREFIX = 'custom_';

/**
 * Meta-tools that are ALWAYS injected into the model schema (AgentTask), even for
 * a restricted Custom Agent whose toolGroups omit the `agent` group, to keep
 * progressive disclosure alive. The runtime mode gate (FIX-44-29) must exempt
 * exactly these, or it would deny a tool the model was explicitly told it has.
 * Single source of truth so the injection and the gate cannot drift.
 */
export const PROGRESSIVE_DISCLOSURE_META_TOOLS: readonly string[] = ['find_tool', 'read_skill'];

export const TOOL_EFFECTS: Record<string, ToolEffectSpec> = {
    // --- Read: no writes, no egress -----------------------------------------
    read_file: 'read',
    read_document: 'read',
    list_files: 'read',
    search_files: 'read',
    compute_plaud_delta: 'read',
    search_by_tag: 'read',
    semantic_search: 'read',
    query_base: 'read',
    get_frontmatter: 'read',
    get_linked_notes: 'read',
    get_vault_stats: 'read',
    find_notes_by_type: 'read',
    list_checkpoints: 'read',
    read_checkpoint: 'read',
    diff_checkpoint: 'read',
    list_memory_source_notes: 'read',
    list_pinned_conversations: 'read',
    recall_memory: 'read',
    search_history: 'read',
    inspect_self: 'read',
    read_agent_logs: 'read',
    read_skill: 'read',
    read_mcp_tool: 'read',
    // Only reads a foreign plugin's API surface, mutates nothing.
    probe_plugin: 'read',
    // Only reads vault-dna.json.
    resolve_capability_gap: 'read',

    // get_daily_note is the one read that CAN write: with create=true it creates
    // the folder and the note. It used to be pinned to 'read', which made it a
    // vault create outside the gate.
    get_daily_note: (input) => (input?.create === true ? 'note-edit' : 'read'),

    // --- UI / loop control: nothing is persisted -----------------------------
    attempt_completion: 'ui',
    ask_followup_question: 'ui',
    update_todo_list: 'ui',
    open_note: 'ui',
    switch_agent: 'ui',
    find_tool: 'ui',
    plan_presentation: 'ui',
    // An LLM call with no vault effect, against the already-configured provider.
    consult_flagship: 'ui',

    // --- Note content --------------------------------------------------------
    write_file: 'note-edit',
    edit_file: 'note-edit',
    append_to_file: 'note-edit',
    build_meeting_note_from_sink: 'note-edit',
    update_frontmatter: 'note-edit',
    set_block_anchors: 'note-edit',
    ingest_triage: 'note-edit',
    ingest_deep: 'note-edit',
    ingest_document: 'note-edit',
    mark_note_as_memory_source: 'note-edit',
    unmark_note_as_memory_source: 'note-edit',

    // --- Vault structure -----------------------------------------------------
    create_folder: 'vault-change',
    delete_file: 'vault-change',
    move_file: 'vault-change',
    generate_canvas: 'vault-change',
    create_base: 'vault-change',
    update_base: 'vault-change',
    create_pptx: 'vault-change',
    create_docx: 'vault-change',
    create_xlsx: 'vault-change',
    create_excalidraw: 'vault-change',
    create_drawio: 'vault-change',
    extract_zip: 'vault-change',
    // Touches every tracked file at once.
    restore_checkpoint: 'vault-change',
    vault_health_check: 'vault-change',

    // --- Configuration: ALWAYS asks ------------------------------------------
    // update_settings can set autoApproval.* (self-escalation) and turn off
    // enableCheckpoints, i.e. the undo safety net.
    update_settings: 'config',
    // AUDIT-037 H-2: can re-point model, apiKey and baseUrl.
    configure_model: 'config',
    // Registers MCP servers and opens the connection immediately.
    manage_mcp_server: 'config',

    // --- Self-modification: ALWAYS asks (M-7) --------------------------------
    // Persists facts that get injected into every future system prompt.
    update_soul: 'self-modify',
    // Forces memory extraction into long-term storage.
    mark_for_memory: 'self-modify',
    manage_source: 'self-modify',
    // Rewrites a skill's instructions. A trusted skill overrides tool selection
    // and guidelines, so editing one changes future agent behaviour -- the same
    // class of effect as update_soul. Always asks; never auto-approvable.
    write_skill: 'self-modify',

    // --- Network egress ------------------------------------------------------
    web_fetch: 'web',
    web_search: 'web',
    anti_echo_search: 'web',
    // Fetches a page + its images and writes them to the vault. Egress class 'web'
    // (never auto-approvable without the web flag); vault writes go through
    // writeBinaryToVault -> vaultPathGuard.
    clip_web_page: 'web',

    // --- MCP -----------------------------------------------------------------
    use_mcp_tool: 'mcp',
    // The effect is an MCP tool call, not a skill invocation. This used to be
    // 'skill', which let the skills toggle override the mcp toggle.
    invoke_mcp_server: 'mcp',

    // --- Subtasks ------------------------------------------------------------
    new_task: 'subtask',
    // FEAT-24-10 / ADR-159: read-only delegation, same effect class as new_task.
    investigate: 'subtask',
    run_in_background: 'subtask',

    // --- Skills / plugin commands --------------------------------------------
    invoke_skill: 'skill',
    execute_command: 'skill',
    enable_plugin: 'skill',

    // --- Sandbox: executes arbitrary code ------------------------------------
    evaluate_expression: 'sandbox',
    // Runs a skill's scripts/*.js in the sandbox with full SandboxBridge access
    // (vault.write). This used to be 'skill', so the much weaker skills toggle
    // auto-approved foreign script code.
    run_skill_script: 'sandbox',

    // --- Other ---------------------------------------------------------------
    call_plugin_api: 'plugin-api',
    execute_recipe: 'recipe',
};

/**
 * What may an effect do, and which settings flag governs it?
 *
 * - `key: null` + `alwaysAsk: false` -> ALWAYS auto (read, ui). Deliberately
 *   independent of the master toggle, which is OFF by default: otherwise every
 *   read_file would raise an approval card.
 * - `key: <flag>`                    -> auto only when master AND flag are on.
 * - `alwaysAsk: true`                -> never auto, whatever the settings say.
 */
export const EFFECT_POLICY: Record<
    ToolEffect,
    { key: keyof AutoApprovalConfig | null; alwaysAsk: boolean }
> = {
    read: { key: null, alwaysAsk: false },
    ui: { key: null, alwaysAsk: false },
    'note-edit': { key: 'noteEdits', alwaysAsk: false },
    'vault-change': { key: 'vaultChanges', alwaysAsk: false },
    web: { key: 'web', alwaysAsk: false },
    mcp: { key: 'mcp', alwaysAsk: false },
    subtask: { key: 'subtasks', alwaysAsk: false },
    skill: { key: 'skills', alwaysAsk: false },
    sandbox: { key: 'sandbox', alwaysAsk: false },
    recipe: { key: 'recipes', alwaysAsk: false },
    // Special case: read vs write is decided from the input (pluginApiRead vs
    // pluginApiWrite); the Pipeline resolves it.
    'plugin-api': { key: null, alwaysAsk: false },
    // No toggle. Otherwise the agent could unlock itself.
    config: { key: null, alwaysAsk: true },
    'self-modify': { key: null, alwaysAsk: true },
};

/**
 * Every AutoApprovalConfig flag that actually gates a category, derived from
 * EFFECT_POLICY so it can never drift. `plugin-api` contributes both of its
 * input-resolved flags. Used to clear dormant grants when the master toggle is
 * flipped on (FIX-44-03b) and by the drift contract test.
 */
export const AUTO_APPROVAL_CATEGORY_KEYS: readonly string[] = (() => {
    const keys = new Set<string>();
    for (const policy of Object.values(EFFECT_POLICY)) {
        if (policy.key) keys.add(policy.key);
    }
    // plugin-api resolves to one of these from the call input; neither is a
    // policy.key, so add them explicitly.
    keys.add('pluginApiRead');
    keys.add('pluginApiWrite');
    return [...keys];
})();

/**
 * Resolve the effect class of a tool call.
 *
 * `undefined` means: unknown tool. The Pipeline treats that fail-closed as
 * requiring approval. There is NO fallback to a harmless class -- that fallback
 * was the bug.
 */
export function resolveToolEffect(
    toolName: string,
    input?: Record<string, unknown>,
): ToolEffect | undefined {
    // Dynamic skill code tools do not get to classify themselves.
    if (toolName.startsWith(DYNAMIC_TOOL_PREFIX)) return 'sandbox';

    // AUDIT 2026-08-25 L-3: own-property lookup. TOOL_EFFECTS is a plain object
    // literal, so a prototype key like 'valueOf' or 'constructor' would hit an
    // inherited function and get called as an effect spec. The untrusted caller
    // (MCP) already wraps this in try/catch, but the guard belongs here so the
    // safety does not hang on every caller remembering the wrapper.
    const spec = Object.prototype.hasOwnProperty.call(TOOL_EFFECTS, toolName)
        ? TOOL_EFFECTS[toolName]
        : undefined;
    if (spec === undefined) return undefined;
    return typeof spec === 'function' ? spec(input) : spec;
}
