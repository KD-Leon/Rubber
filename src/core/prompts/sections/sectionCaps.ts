/**
 * Volatile-tail section caps (IMP-41-01-03, completes the ADR-062 invariant).
 *
 * The tail below CACHE_BREAKPOINT_MARKER is uncached and paid on every
 * iteration. MemorySection (4000) and MCP descriptions (200) were already
 * bounded; this module bounds the remaining tail sections so a bloated
 * section (40 plugins, huge vault context, giant user rules) cannot silently
 * dominate per-turn input cost. Values are deliberate constants, not user
 * settings: there is no sensible per-user decision here, only a guard rail.
 *
 * Caps apply at assembly time in buildSystemPromptForMode; the section
 * builders stay pure. The stable prefix is NEVER capped (its size is a
 * one-time cache write, not a per-turn cost).
 */

export const TAIL_SECTION_CAPS = {
    /** Full plugin-skills form is ~5k tokens; lean form ~30. Cap the full form. */
    pluginSkills: 8000,
    /** Mirrors MemorySection.MAX_MEMORY_CHARS (single source kept there). */
    memory: 4000,
    /** RecipeMatchingService budgets ~2000 chars; hard stop above it. */
    recipes: 3000,
    /** Global + mode custom instructions combined. */
    customInstructions: 6000,
    /** User rules files (rulesContent). */
    rules: 6000,
    /** Vault tree / stats context. */
    vaultContext: 8000,
} as const;

const TRUNCATION_MARKER = (cap: number): string => `[section truncated at ${cap} chars]`;

/**
 * Cap `text` at `cap` chars, cutting at the last full line and appending a
 * truncation marker. Sections at or below the cap return unchanged
 * (byte-identical, no marker).
 */
export function capSection(text: string, cap: number): string {
    if (text.length <= cap) return text;
    let cut = text.lastIndexOf('\n', cap);
    if (cut <= 0) cut = cap; // single overlong line: hard cut
    return `${text.slice(0, cut)}\n${TRUNCATION_MARKER(cap)}`;
}
