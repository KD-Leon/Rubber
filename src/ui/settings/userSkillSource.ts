/**
 * FEAT-29-11: source-discriminator predicate for the "User Skills" section
 * of the SkillsTab.
 *
 * Background: after Welle-2 -> FEAT-29-11 layout consolidation, plugin-managed
 * skills live in the same `data/skills/{name}/` folder as user-/builtin-skills.
 * Two readers walk that folder (SelfAuthoredSkillLoader and
 * SkillsManager.discoverSkills via GlobalFileService.useVaultLocalRoot pointing
 * at the data/ root). Without a shared source-filter, plugin entries would
 * surface twice: once in the User Skills list, once in the Plugin Skills list.
 *
 * This module is intentionally split from SkillsTab.ts so it stays
 * import-light (no obsidian types) and can be loaded in vitest without
 * pulling Modal / setIcon / friends.
 *
 * FEAT-29-13 follow-up: also owns the human-readable label mapping for
 * the Source column and the tooltip text. Both used to live as a private
 * method on SkillsTab — extracted so the contract can be pinned in tests
 * and so the badge-CSS class names stay in sync with the label set.
 */

/**
 * Source values that belong in the User Skills section. Anything outside
 * the set is a plugin-id from VaultDNAScanner and is rendered separately.
 *
 * `agent` (FEAT-29-13) is what `init_skill` from the skill-creator
 * workflow stamps on new skills; `learned` is the legacy
 * recipe-promotion discriminator and folds into the same Agent bucket.
 * `pro` marks monetized skills that are downloaded on demand after
 * purchase into the same `data/skills/{name}/` folder; they belong in
 * the Skills list with their own Pro badge, not filtered out as if
 * they were a plugin-id entry.
 */
export const USER_SKILL_SOURCES: ReadonlySet<string> = new Set([
    'user', 'agent', 'registry', 'builtin',
    // Legacy, read but never written. `bundled` predates the materializer's
    // normalisation to `builtin`, `learned` predates `agent`, and `pro` is the
    // abandoned monetization tier. Dropping any of them here would filter
    // existing on-disk skills out of the list, which reads as data loss.
    'bundled', 'learned', 'pro',
]);

/**
 * Predicate counterpart to `USER_SKILL_SOURCES`. Returns true when the
 * skill's `source` value (or its default `'user'` fallback) belongs in
 * the User Skills list, false when it is a plugin-managed entry.
 *
 * `null` / `undefined` are treated as the default user source so legacy
 * SKILL.md files that predate the source-frontmatter discriminator do
 * not get filtered out.
 */
export function isUserSkillSource(source: string | null | undefined): boolean {
    if (source === null || source === undefined) return true;
    return USER_SKILL_SOURCES.has(source);
}

/**
 * Four top-level labels surfaced in the Source column of the SkillsTab.
 * Unknown values fall through unchanged so plugin-id badges keep their raw
 * discriminator.
 *
 * The label says where a skill came from. It does NOT say what the skill is
 * allowed to do: only `builtin` is trusted, and everything else runs through
 * the normal approval chain regardless of badge. A user who edits a Registry
 * skill breaks its content hash and it resolves to `user` from then on, which
 * is the tier demotion working as intended rather than a separate mechanism.
 */
export function getSourceLabel(source: string): string {
    switch (source) {
        case 'bundled':
        case 'builtin':
            return 'Built-in';
        case 'registry':
            return 'Registry';
        case 'agent':
        case 'learned':
            return 'Agent';
        case 'user':
            return 'User';
        case 'pro':
            // A pre-EPIC-31 Pro skill was never checked against a registry
            // catalogue and has no installer provenance. Calling it Registry
            // would claim an origin it does not have, so it degrades to User.
            return 'User';
        default:
            return source;
    }
}

/**
 * Hover-tooltip for the "Source" column header. Single source of truth
 * so the UI and the test contract cannot drift.
 */
export const SOURCE_TOOLTIP =
    'Built-in: ships with the plugin. ' +
    'Registry: installed from the public skill registry. ' +
    'Agent: created for you by the skill-creator workflow. ' +
    'User: written, copied or imported by you, or a skill you have edited.';
