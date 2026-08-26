/**
 * Mode-scoped config cleanup and copy (FEAT-04-12, closes FIX-02-02-02).
 *
 * Four vault-local settings maps key on the mode slug. Deleting an agent must
 * drop its entries so a later agent that reuses the deterministic
 * `{slug}-copy` slug cannot silently inherit the old configuration (the
 * `agent-copy` trap from Issue #57); duplicating must bring them along so the
 * clone behaves like the original. Pure helpers so both paths are directly
 * assertable; ModesTab calls them and persists.
 */

export interface ModeScopedConfig {
    modeToolOverrides?: Record<string, string[]>;
    forcedWorkflow?: Record<string, string>;
    modeMcpOverrides?: Record<string, string[]>;
    modeModelKeys?: Record<string, string>;
}

/** Drop every per-mode entry of `slug`. Mutates `s`. */
export function removeModeScopedConfig(s: ModeScopedConfig, slug: string): void {
    delete s.modeToolOverrides?.[slug];
    delete s.forcedWorkflow?.[slug];
    delete s.modeMcpOverrides?.[slug];
    delete s.modeModelKeys?.[slug];
}

/** Copy every present per-mode entry of `fromSlug` onto `toSlug` (deep for
 *  the array maps, so clone and original stay independent). Mutates `s`. */
export function copyModeScopedConfig(s: ModeScopedConfig, fromSlug: string, toSlug: string): void {
    const tools = s.modeToolOverrides?.[fromSlug];
    if (tools !== undefined) s.modeToolOverrides![toSlug] = [...tools];
    const wf = s.forcedWorkflow?.[fromSlug];
    if (wf !== undefined) s.forcedWorkflow![toSlug] = wf;
    const mcp = s.modeMcpOverrides?.[fromSlug];
    if (mcp !== undefined) s.modeMcpOverrides![toSlug] = [...mcp];
    const model = s.modeModelKeys?.[fromSlug];
    if (model !== undefined) s.modeModelKeys![toSlug] = model;
}
