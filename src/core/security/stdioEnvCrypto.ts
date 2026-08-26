/**
 * stdioEnvCrypto -- encrypt/decrypt the credential-bearing env vars of a stdio
 * MCP server config at rest (FEAT-04-13, ADR-168).
 *
 * Mirrors mcpOAuthCrypto in style (same structural SafeStorageLike seam, same
 * `enc:v1:` primitive, same idempotency-via-isEncrypted), but operates on a
 * single `McpServerConfig.env` because stdio configs live in the standalone
 * DeviceLocalStore, OUTSIDE the settings encrypt/decrypt cycle the walkers are
 * bound to.
 *
 * Design difference from the header walker (deliberate): the header walker
 * encrypts EVERY value because settings are held decrypted in memory. stdio env
 * stays ENCRYPTED in memory (decrypted only at spawn, McpClient.buildStdioTransport),
 * so the UI must render non-secret env values (e.g. AZURE_DEVOPS_ORG_URL)
 * without decrypting. We therefore encrypt only secret-NAMED keys; decrypt at
 * spawn walks all values (passthrough leaves plaintext ones untouched), so the
 * split is safe.
 */

import type { McpServerConfig } from '../../types/settings';

/** The subset of SafeStorageService this module needs (kept structural for tests). */
export interface SafeStorageLike {
    encrypt(plainText: string): string;
    decrypt(value: string): string;
    isEncrypted(value: string | undefined): boolean;
    isAvailable(): boolean;
}

// Env var names that carry credentials. Mirrors isSecretHeaderName
// (McpTab.ts), plus pat/credential for Azure DevOps (AZURE_DEVOPS_PAT /
// AZURE_DEVOPS_EXT_PAT).
//
// AUDIT-034 stdio-secret-regex-gap: broadened to catch key/private/ssh/signing/
// cookie/jwt/auth shapes that were previously left plaintext at rest, which
// contradicted the UI's at-rest-encryption hint. The delimited alternatives
// (^|_)pat|key|auth($|_) match only whole underscore-delimited segments, so
// PATH / KEYBOARD / AUTHOR / MONKEY are never swept in. Erring toward
// over-encryption is safe: decrypt is passthrough for plaintext, so a
// false-positive on a non-secret value costs nothing.
const SECRET_ENV_RE = /token|api[-_ ]?key|secret|bearer|password|credential|cookie|private|jwt|(^|_)pat($|_)|(^|_)key($|_)|(^|_)auth($|_)/i;

/** True for env var names that look like they carry a credential. */
export function isSecretEnvName(name: string): boolean {
    return SECRET_ENV_RE.test(name);
}

/**
 * Encrypt secret-named env values in place. Idempotent via isEncrypted(), so
 * re-saving an already-encrypted config does not double-encrypt. When the OS
 * keychain is unavailable, encrypt() returns plaintext unchanged (the caller
 * writes the _encrypted=false marker and fires the one-time warning), matching
 * the API-key fallback.
 */
export function encryptStdioEnvInPlace(config: McpServerConfig, safe: SafeStorageLike): void {
    if (!config.env) return;
    for (const [k, v] of Object.entries(config.env)) {
        if (isSecretEnvName(k) && typeof v === 'string' && v && !safe.isEncrypted(v)) {
            config.env[k] = safe.encrypt(v);
        }
    }
}
