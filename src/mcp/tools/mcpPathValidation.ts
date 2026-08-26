/**
 * MCP Path Validation -- Governance checks for MCP tool handlers (AUDIT-006 H-2).
 *
 * Applies the same path safety rules as the internal tool pipeline:
 * - Path traversal prevention (SandboxBridge pattern)
 * - IgnoreService checks (agentignore / agentprotected)
 * - configDir protection
 */

import type ObsidianAgentPlugin from '../../main';

export interface McpPathValidation {
    allowed: boolean;
    reason?: string;
}

/**
 * Validate a vault path for MCP access.
 * @param plugin Plugin instance (for vault.configDir and IgnoreService)
 * @param path Vault-relative path
 * @param isWrite Whether this is a write operation
 */
export function validateMcpVaultPath(
    plugin: ObsidianAgentPlugin,
    path: string,
    isWrite: boolean,
): McpPathValidation {
    // 1. Path traversal check. MCP-5: normalize-then-verify by splitting on both
    // separators and rejecting any `.`/`..` segment (plus absolute paths),
    // instead of a `.includes('..')` substring denylist that also mis-rejects
    // legitimate names like `foo..bar.md` and is brittle for non-normalized
    // callers.
    const segments = path.split(/[/\\]/);
    if (path.startsWith('/') || path.startsWith('\\') || segments.some((s) => s === '.' || s === '..')) {
        return { allowed: false, reason: 'Invalid path: traversal or absolute path rejected' };
    }

    // 2. configDir protection. H-2 (AUDIT 2026-07-14): the read-side of this
    // block used to be missing here (writes only), which let a remote MCP client
    // read `.obsidian/plugins/*/data.json` and the agent settings via read_file.
    // The IgnoreService pass below now covers configDir and the agent secret
    // zone symmetrically for reads and writes; this inline check stays as a
    // case-insensitive first line for the config dir.
    const configDir = plugin.app.vault.configDir;
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    const cfgLower = configDir.toLowerCase();
    if (normalized.startsWith(`${cfgLower}/`) || normalized === cfgLower) {
        return { allowed: false, reason: `Blocked: ${configDir}/ is protected` };
    }

    // 3. IgnoreService checks (configDir + agent secret zone read+write, plus
    // user ignore/protected patterns).
    const ignoreService = plugin.ignoreService;
    if (ignoreService) {
        if (ignoreService.isIgnored(path)) {
            return { allowed: false, reason: 'Path is ignored by .obsidian-agentignore' };
        }
        if (isWrite && ignoreService.isProtected(path)) {
            return { allowed: false, reason: 'Path is write-protected by .obsidian-agentprotected' };
        }
    }

    return { allowed: true };
}
