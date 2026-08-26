/**
 * FIX-29-11-01 (Issue #67): resolving the on-disk folder of a skill.
 *
 * The "Edit" entry in the skill context menu used to REBUILD the path for
 * SkillsManager-owned skills: it took the slug out of `globalPath` and glued
 * it onto `getPluginSkillsDir()`. That assumption only holds once the storage
 * layout migration has completed. Before it has, the SkillsManager root sits
 * next to the vault ({vault-parent}/vault-operator-shared/) while the rebuilt
 * path points inside it ({vault}/.vault-operator/plugin-skills/{slug}), so
 * Electron got a path that does not exist and answered "Failed to open path".
 *
 * The reporter blamed iCloud, and that turned out to be half right for an
 * unexpected reason: the ADR-162 guard deliberately demotes a device back to
 * 'pending' when a synced data.json claims 'complete' without a local
 * consolidated data root. iCloud or Obsidian Sync is therefore a common way to
 * ENTER the broken state, but nothing in this path touches tilde expansion,
 * shell quoting, or evicted placeholder files.
 *
 * The fix is to stop guessing: ask whoever owns the skill where it lives. That
 * is what the export path 60 lines further down has always done.
 *
 * Kept as a pure function behind a minimal contract, following the
 * skillFolderDelete precedent, so the layout-dependent case is testable
 * without loading Obsidian.
 */

/** The subset of GlobalFileService this resolution needs. */
export interface SkillPathOwner {
    /** Absolute path for a root-relative path. Throws on traversal. */
    resolvePath(relativePath: string): string;
}

export interface SkillPathInput {
    /** Vault-relative SKILL.md path, when the loader found the skill in the vault. */
    selfAuthoredFilePath?: string;
    /** Owner-relative path (`skills/{folder}/SKILL.md`), when it came from the SkillsManager. */
    globalPath?: string;
}

export type SkillFolderLocation =
    /** Vault-relative folder; the caller turns it absolute via the vault adapter. */
    | { kind: 'vault'; relativePath: string }
    /** Already-absolute folder, resolved by the owner of the storage root. */
    | { kind: 'absolute'; absolutePath: string }
    | { kind: 'unresolved' };

/** Strip the SKILL.md (or `<name>.skill.md`) leaf off a manifest path. */
function toFolder(manifestPath: string): string {
    return manifestPath
        .replace(/\/SKILL\.md$/, '')
        .replace(/\/[^/]+\.skill\.md$/, '');
}

/**
 * Where a skill's folder actually is.
 *
 * A vault-relative hit wins: that path demonstrably worked, because the loader
 * read the file through it. Otherwise the owner resolves its own root, which
 * is correct in every layout instead of only in the migrated one.
 */
export function resolveSkillFolder(
    skill: SkillPathInput,
    owner: SkillPathOwner | null | undefined,
): SkillFolderLocation {
    if (skill.selfAuthoredFilePath) {
        return { kind: 'vault', relativePath: toFolder(skill.selfAuthoredFilePath) };
    }
    if (skill.globalPath && owner) {
        try {
            return { kind: 'absolute', absolutePath: owner.resolvePath(toFolder(skill.globalPath)) };
        } catch {
            // resolvePath throws on traversal; treat it as unresolvable rather
            // than handing a suspicious path to the shell.
            return { kind: 'unresolved' };
        }
    }
    return { kind: 'unresolved' };
}
