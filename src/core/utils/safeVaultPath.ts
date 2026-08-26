/**
 * safeVaultPath
 *
 * Shared validation for vault-relative paths that come from untrusted
 * input (backup ZIP manifests, skill package archives, etc.). The
 * checks mirror SkillPackageImporter.isDangerousPath so both call sites
 * stay in sync after FIX-29-40-01 (AUDIT-040 H-1).
 *
 * Two surfaces:
 *   - isDangerousVaultPath(p): primary boolean check used by
 *     SkillPackageImporter today; kept as the low-level primitive.
 *   - validateVaultRelativePath(p, opts?): adds optional
 *     `expectedPrefix` confinement so a backup-import call can assert
 *     the path stays under the category root.
 *
 * The functions never throw. Callers receive a structured result so
 * they can surface a precise error to the user.
 */

export interface VaultPathValidation {
    ok: boolean;
    reason?:
        | 'empty'
        | 'null-byte'
        | 'absolute-posix'
        | 'absolute-windows-drive'
        | 'absolute-unc'
        | 'parent-segment'
        | 'outside-prefix';
}

/**
 * Returns true when the path is unsafe to write inside the vault.
 * Mirrors SkillPackageImporter.isDangerousPath (kept verbatim
 * semantics for backward compatibility - that function now delegates
 * to this helper).
 */
export function isDangerousVaultPath(p: string): boolean {
    return !validateVaultRelativePath(p).ok;
}

export interface VaultPathOptions {
    /**
     * When set, the validated path must start with this prefix followed
     * by '/' (or equal the prefix when it is empty). Use to confine a
     * backup-import write to its declared category root.
     */
    expectedPrefix?: string;
}

export function validateVaultRelativePath(
    p: string,
    opts: VaultPathOptions = {},
): VaultPathValidation {
    if (typeof p !== 'string' || p.length === 0) {
        return { ok: false, reason: 'empty' };
    }
    if (p.includes('\0')) {
        return { ok: false, reason: 'null-byte' };
    }
    if (p.startsWith('/')) {
        return { ok: false, reason: 'absolute-posix' };
    }
    // Windows absolute drive (C:\ or C:/)
    if (/^[a-zA-Z]:[\\/]/.test(p)) {
        return { ok: false, reason: 'absolute-windows-drive' };
    }
    // UNC path (\\server\share\...)
    if (p.startsWith('\\\\')) {
        return { ok: false, reason: 'absolute-unc' };
    }
    // Parent-dir segments anywhere in the path - normalize both
    // separators so a Windows-style 'a\\..\\b' is caught too.
    const normalized = p.replace(/\\/g, '/');
    for (const segment of normalized.split('/')) {
        if (segment === '..') {
            return { ok: false, reason: 'parent-segment' };
        }
    }
    if (opts.expectedPrefix !== undefined) {
        const prefix = opts.expectedPrefix;
        if (prefix === '') {
            // Root-level write inside the vault is fine when no prefix
            // is required, except we still reject leading '/' above.
            return { ok: true };
        }
        // Normalise both sides to '/'-separated, no trailing slash.
        const canonPrefix = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
        const canonPath = normalized.replace(/\/+$/, '');
        if (canonPath !== canonPrefix && !canonPath.startsWith(`${canonPrefix}/`)) {
            return { ok: false, reason: 'outside-prefix' };
        }
    }
    return { ok: true };
}
