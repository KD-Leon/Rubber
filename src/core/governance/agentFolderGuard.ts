/**
 * agentFolderGuard (FIX-44-22 / FIX-44-24)
 *
 * One predicate, two callers. The agent's own folder holds the security-critical
 * configuration -- settings.json (autoApproval flags, provider apiKeys), the MCP
 * config, the provenance manifest, the cache. Neither the sandbox bridge nor the
 * ordinary vault write tools may touch it, or the agent could grant itself every
 * permission by writing its own settings file.
 *
 * The two exceptions belong to the skill workspace, which the agent legitimately
 * owns: `skills/` (skill-creator authors definitions there) and `skill-data/`
 * (a skill's persistent runtime state). A forged `source: pro` inside skills/ is
 * not a trust hole -- trust comes from the provenance manifest, not the file
 * (FIX-44-05).
 *
 * Keeping this in one place means SandboxBridge and IgnoreService cannot drift
 * into disagreeing about what "the config zone" is.
 */

import { foldPath } from './foldPath';

/**
 * True when `safePath` lives inside the agent folder but outside the skill
 * workspace -- i.e. it is agent configuration that must not be written (and, for
 * the sandbox, not read either).
 *
 * @param safePath  a normalised, traversal-free vault-relative path
 * @param agentRoot the vault-relative agent folder root (e.g. `.vault-operator`)
 */
export function isProtectedAgentConfigPath(safePath: string, agentRoot: string): boolean {
    if (!agentRoot) return false;
    // H-3 (AUDIT 2026-07-14): the root match is case-insensitive. On the primary
    // Obsidian platforms (macOS/APFS, Windows/NTFS, iOS) `.Vault-Operator/...`
    // and `.vault-operator/...` resolve to the same file, so a case-variant must
    // not slip past the deny-zone. The exemption below stays case-sensitive on
    // purpose (fail-closed): an odd-cased `SKILLS/` is treated as config.
    // AUDIT 2026-07-26 (P3 follow-up): was `.toLowerCase()`, a THIRD notion of
    // path sameness alongside IgnoreService's fold and its raw comparisons.
    // Shared fold now, so a non-ASCII agent root folds the same way everywhere.
    const lowerRoot = foldPath(agentRoot);
    const lowerPath = foldPath(safePath);
    if (lowerPath !== lowerRoot && !lowerPath.startsWith(`${lowerRoot}/`)) return false;

    const rel = safePath.slice(agentRoot.length).replace(/^\//, '');
    // Segment-exact so `skills` never matches inside `skill-data`.
    const isSkillWorkspace =
        /(^|\/)skill-data(\/|$)/.test(rel) || /(^|\/)skills(\/|$)/.test(rel);
    return !isSkillWorkspace;
}

/**
 * True when `safePath` is agent config that must not be READ by a vault tool or
 * MCP client -- credentials (settings.json), the data/ DBs, the cache, the
 * provenance manifest. This is the write-deny zone minus `tmp/`: externalised
 * tool results live in `<agentRoot>/tmp/` and the model legitimately reads them
 * back (BUG-020), so tmp stays readable while the secret zone does not.
 *
 * H-2 (AUDIT 2026-07-14): the agent config zone was write-protected but not
 * read-protected, so `read_file`/`execute_vault_op` could exfiltrate
 * settings.json (provider apiKeys in the safeStorage plaintext fallback, MCP
 * auth headers in cleartext).
 *
 * @param safePath  a normalised, traversal-free vault-relative path
 * @param agentRoot the vault-relative agent folder root (e.g. `.vault-operator`)
 */
export function isAgentSecretPath(safePath: string, agentRoot: string): boolean {
    if (!isProtectedAgentConfigPath(safePath, agentRoot)) return false;
    const rel = safePath.slice(agentRoot.length).replace(/^\//, '');
    return !/(^|\/)tmp(\/|$)/.test(rel);
}
