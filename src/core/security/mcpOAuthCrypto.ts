/**
 * mcpOAuthCrypto -- pure walkers that encrypt/decrypt the secret-bearing OAuth
 * session fields nested under `settings.mcpServers[name].oauth` (FEAT-04-10,
 * ADR-155). Mirrors the shape of providerCredentialCrypto so the settings
 * encrypt/decrypt passes in main.ts stay symmetric and unit-testable.
 *
 * Secret fields: `oauth.tokens.access_token`, `oauth.tokens.refresh_token`,
 * `oauth.clientInformation.client_secret`. Non-secret fields (token_type,
 * expires_in, scope, client_id, ...) are left untouched.
 */

import type { ObsidianAgentSettings } from '../../types/settings';

/** The subset of SafeStorageService this module needs (kept structural for tests). */
export interface SafeStorageLike {
    encrypt(plainText: string): string;
    decrypt(value: string): string;
    isEncrypted(value: string | undefined): boolean;
}

/**
 * Encrypt the OAuth secret fields in place. Idempotent via `isEncrypted()`, so
 * re-saving already-encrypted settings does not double-encrypt.
 */
export function encryptMcpOAuthInPlace(settings: ObsidianAgentSettings, safe: SafeStorageLike): void {
    for (const srv of Object.values(settings.mcpServers ?? {})) {
        // FEAT-04-11: header values carry user-supplied tokens/API keys for
        // token-based servers (e.g. GitHub PAT in Authorization). Encrypt them
        // like the OAuth token fields so nothing sensitive is at rest in clear.
        if (srv.headers) {
            for (const [key, value] of Object.entries(srv.headers)) {
                if (typeof value === 'string' && value && !safe.isEncrypted(value)) {
                    srv.headers[key] = safe.encrypt(value);
                }
            }
        }
        const o = srv.oauth;
        if (!o) continue;
        if (o.tokens?.access_token && !safe.isEncrypted(o.tokens.access_token)) {
            o.tokens.access_token = safe.encrypt(o.tokens.access_token);
        }
        if (o.tokens?.refresh_token && !safe.isEncrypted(o.tokens.refresh_token)) {
            o.tokens.refresh_token = safe.encrypt(o.tokens.refresh_token);
        }
        if (o.clientInformation?.client_secret && !safe.isEncrypted(o.clientInformation.client_secret)) {
            o.clientInformation.client_secret = safe.encrypt(o.clientInformation.client_secret);
        }
    }
}

/**
 * Decrypt the OAuth secret fields in place. `decrypt()` passes cleartext
 * through, so pre-fix installs (plaintext at rest) migrate transparently.
 */
export function decryptMcpOAuthInPlace(settings: ObsidianAgentSettings, safe: SafeStorageLike): void {
    for (const srv of Object.values(settings.mcpServers ?? {})) {
        if (srv.headers) {
            for (const [key, value] of Object.entries(srv.headers)) {
                if (typeof value === 'string' && value) srv.headers[key] = safe.decrypt(value);
            }
        }
        const o = srv.oauth;
        if (!o) continue;
        if (o.tokens?.access_token) o.tokens.access_token = safe.decrypt(o.tokens.access_token);
        if (o.tokens?.refresh_token) o.tokens.refresh_token = safe.decrypt(o.tokens.refresh_token);
        if (o.clientInformation?.client_secret) {
            o.clientInformation.client_secret = safe.decrypt(o.clientInformation.client_secret);
        }
    }
}
