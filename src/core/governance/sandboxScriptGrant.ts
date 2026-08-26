/**
 * sandboxScriptGrant -- the grant key for a content-hash approval of a
 * vault-authored sandbox script.
 *
 * AUDIT 2026-07-26 M-1 keeps unverified sandbox code (run_skill_script bytes
 * loaded from the writable skills/ workspace) OUT of the effect-class grants:
 * an `autoApproval.sandbox` yes must never cover arbitrary vault code. But that
 * left every user- and pro-authored skill asking on every run -- and since the
 * pro skills were externalised (3.3.3), that is all of them.
 *
 * The resolution is to grant on the SHA-256 of the exact bytes instead of the
 * effect class. Same bytes -> same key -> auto-approved. One byte changes ->
 * new key -> the card returns. The hash is the security anchor; the skill and
 * script names ride along only so a person can read and revoke the grant.
 */

export const SANDBOX_SCRIPT_GRANT_PREFIX = 'sandbox-script:';

/**
 * Upper bound on persisted per-script grants. Oldest entries are evicted first
 * when this is exceeded (the list is append-ordered by grantedAt). A stale
 * entry from a deleted skill simply never matches again; pruning it is optional.
 */
export const MAX_SANDBOX_SCRIPT_GRANTS = 200;

/** A grant key scoped to one byte-state of one script. */
export type SandboxScriptGrantKey = `sandbox-script:${string}`;

/**
 * Build the grant key. Format: `sandbox-script:<skill>/<script>:<sha256hex>`.
 * The trailing hash is authoritative; the skill/script segment is for humans.
 */
export function sandboxScriptGrantKey(
    skillFolder: string,
    scriptName: string,
    contentHash: string,
): SandboxScriptGrantKey {
    return `${SANDBOX_SCRIPT_GRANT_PREFIX}${skillFolder}/${scriptName}:${contentHash}`;
}

/** True when a grant key is a content-hash sandbox-script key, not an effect class. */
export function isSandboxScriptGrantKey(key: string): key is SandboxScriptGrantKey {
    return key.startsWith(SANDBOX_SCRIPT_GRANT_PREFIX);
}
