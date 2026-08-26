/**
 * MCP activation state -- the single source of truth for "which connected MCP
 * servers may this AGENT call" (FEAT-04-12, ADR-161; formerly global,
 * IMP-04-10-02).
 *
 * One vault-local field on settings encodes it:
 * - `modeMcpOverrides: Record<modeSlug, string[]>` -- per-agent explicit
 *   server list. An ABSENT key means "all connected servers active" (the
 *   untouched default; auto-includes servers added later). A list is a user
 *   narrowing for that agent; an EMPTY list means "none" (this replaces the
 *   old global `mcpDisabled` per agent -- unlike the legacy model, "none" is
 *   representable without a second flag).
 *
 * The deprecated global fields `activeMcpServers`/`mcpDisabled` are only read
 * by the one-time migration in loadSettings; no consumer writes them anymore.
 *
 * All gates (use_mcp_tool, invoke_mcp_server, read_mcp_tool) key on the
 * running task's mode (ToolExecutionContext.mode) and the picker on the
 * active mode, all through these helpers, so the runtime and the checkbox UI
 * can never disagree. This filter is a convenience layer, not the security
 * boundary: only connected servers are callable and every MCP call passes the
 * 'mcp' effect approval gate.
 */

export interface McpActivationState {
    modeMcpOverrides?: Record<string, string[]>;
    /** @deprecated ADR-161: legacy global subset; read only by the one-time migration. */
    activeMcpServers?: string[];
    /** @deprecated ADR-161: legacy global off-switch; read only by the one-time migration. */
    mcpDisabled?: boolean;
}

/** True when `name` may be called by the agent `modeSlug`: no override for
 *  that mode (all-active default) or explicitly listed. */
export function isMcpServerActive(s: McpActivationState, modeSlug: string, name: string): boolean {
    const override = s.modeMcpOverrides?.[modeSlug];
    if (override === undefined) return true;
    return override.includes(name);
}

/**
 * Resolve the agent's activation state to the `allowedMcpServers` value the
 * system prompt's tool catalogue expects, so the advertised MCP tools match
 * what the gates allow:
 * - `undefined` -> no restriction (all connected servers, the default)
 * - `[]`        -> none (MCP off for this agent) -> catalogue advertises nothing
 * - subset      -> only those server names are advertised
 * The catalogue treats a defined array (including empty) as an explicit filter.
 */
export function resolveAllowedMcpServers(s: McpActivationState, modeSlug: string): string[] | undefined {
    const override = s.modeMcpOverrides?.[modeSlug];
    return override === undefined ? undefined : [...override];
}

/** The agent's current effective active set as an explicit list of names. */
function effectiveActive(s: McpActivationState, modeSlug: string, allServers: string[]): string[] {
    const override = s.modeMcpOverrides?.[modeSlug];
    if (override === undefined) return [...allServers];
    return override.filter((n) => allServers.includes(n));
}

/** Persist a normalized selection for one agent: all -> delete the key
 *  (all-active, future-proof), otherwise the explicit list ([] = none).
 *  Mutates `s`; other agents' keys are never touched. */
function writeSelection(s: McpActivationState, modeSlug: string, selected: string[], allServers: string[]): void {
    const unique = [...new Set(selected)].filter((n) => allServers.includes(n));
    if (!s.modeMcpOverrides) s.modeMcpOverrides = {};
    if (unique.length >= allServers.length && allServers.every((n) => unique.includes(n))) {
        delete s.modeMcpOverrides[modeSlug];
    } else {
        s.modeMcpOverrides[modeSlug] = unique;
    }
}

/** Apply a per-server checkbox change for one agent and normalize. Mutates `s`. */
export function setMcpServerActive(
    s: McpActivationState,
    modeSlug: string,
    name: string,
    active: boolean,
    allServers: string[],
): void {
    let cur = effectiveActive(s, modeSlug, allServers);
    if (active) { if (!cur.includes(name)) cur.push(name); }
    else cur = cur.filter((n) => n !== name);
    writeSelection(s, modeSlug, cur, allServers);
}

/** Turn all MCP on (delete the override) or off (empty list) for one agent.
 *  Mutates `s`. */
export function setAllMcpActive(s: McpActivationState, modeSlug: string, active: boolean): void {
    if (!s.modeMcpOverrides) s.modeMcpOverrides = {};
    if (active) delete s.modeMcpOverrides[modeSlug];
    else s.modeMcpOverrides[modeSlug] = [];
}

/**
 * Ensure a newly added/enabled server is active for EVERY agent (the settings
 * add path: "enabled in settings means usable in chat", explicit user
 * expectation). Appends to every explicit list -- including empty ones, which
 * activates just this server there without re-enabling the rest. Absent keys
 * stay absent: the all-active default already covers the new server. Mutates `s`.
 */
export function activateMcpServerForAllModes(s: McpActivationState, name: string): void {
    const overrides = s.modeMcpOverrides;
    if (!overrides) return;
    for (const slug of Object.keys(overrides)) {
        if (!overrides[slug].includes(name)) overrides[slug] = [...overrides[slug], name];
    }
}
