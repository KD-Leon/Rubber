/**
 * mcpCredentialScope -- credentials stay where they were granted.
 *
 * AUDIT 2026-07-26 M-4 (CWE-522). `manage_mcp_server action=update` could
 * repoint an existing server at an agent-chosen URL while carrying along the
 * stored auth headers and the OAuth session, because the update spread
 * `...existing` and then overwrote only `url`. A prompt-injected agent could
 * therefore forward the user's bearer token to a host of its choosing without
 * ever reading it.
 *
 * WHAT THE GUARD IS ANCHORED ON
 *
 * The finding is explicit: anchor on the ORIGIN CHANGE, not on `isBuiltIn`.
 * Whose server it is has nothing to do with where the credential is allowed to
 * travel. Adversarial review then added two corrections that this module
 * implements:
 *
 * - Fire on the EFFECTIVE change, not on parameter presence. Guarding on
 *   `params.url !== undefined` refuses a no-op update that re-sends the same
 *   URL, and disagrees with the line above it, where `params.url ?? existing.url`
 *   treats null as "no change" while `!== undefined` treats it as a change.
 *   Compare the resolved target against the stored one instead.
 *
 * - Origin alone is the wrong unit for a bearer header. It is the right unit
 *   for a cookie, which the browser scopes by origin, but a token for a
 *   multi-tenant MCP host is scoped by the tenant, and the tenant is a path
 *   segment. Moving `/tenant-a/mcp` to `/tenant-b/mcp` is the same exfiltration
 *   with a shorter hop. So the path must stay equal or extend at a segment
 *   boundary: `/mcp` -> `/mcp/v2` is fine, `/tenant-a` -> `/tenant-b` is not.
 *
 * Pure and dependency-free, so the tool, the settings tab and the tests agree
 * on one definition of "the same place".
 */

/** Credential kinds a server config can carry. */
export function hasStoredCredentials(config: {
    headers?: Record<string, string>;
    env?: Record<string, string>;
    authType?: string;
    oauth?: unknown;
}): boolean {
    if (config.headers && Object.keys(config.headers).length > 0) return true;
    if (config.env && Object.keys(config.env).length > 0) return true;
    if (config.authType === 'oauth') return true;
    if (config.oauth !== undefined && config.oauth !== null) return true;
    return false;
}

/**
 * True when `next` is close enough to `stored` that a credential granted for
 * `stored` still applies.
 *
 * Requires the same scheme, host and port, and a path that is equal to the
 * stored path or extends it at a segment boundary. Anything unparseable is
 * NOT the same scope: a URL we cannot read is a URL we cannot vouch for.
 */
export function sameCredentialScope(stored: string | undefined, next: string | undefined): boolean {
    if (typeof stored !== 'string' || typeof next !== 'string') return false;
    let a: URL;
    let b: URL;
    try {
        a = new URL(stored);
        b = new URL(next);
    } catch {
        return false;
    }
    if (a.protocol !== b.protocol) return false;
    // `host` covers hostname and port together.
    if (a.host !== b.host) return false;

    const norm = (p: string): string => (p.endsWith('/') ? p.slice(0, -1) : p);
    const from = norm(a.pathname);
    const to = norm(b.pathname);
    if (from === to) return true;
    // Extension only, and only at a segment boundary, so `/tenant-a` does not
    // cover `/tenant-abc`.
    return to.startsWith(`${from}/`);
}

/**
 * Strip every stored credential from a config, keeping the rest.
 *
 * Used when a config legitimately moves to a new place: the server keeps
 * working as an anonymous endpoint and the user re-authenticates deliberately,
 * rather than the plugin silently forwarding what it holds.
 */
export function withoutCredentials<T extends {
    headers?: Record<string, string>;
    env?: Record<string, string>;
    authType?: string;
    oauth?: unknown;
}>(config: T): T {
    const out = { ...config };
    delete out.headers;
    delete out.env;
    delete out.authType;
    delete out.oauth;
    return out;
}
