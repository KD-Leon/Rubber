/**
 * webHostGrants -- remember which sites the agent may fetch, one host at a time.
 *
 * AUDIT 2026-07-26 M-5. `web_fetch` sat under a single `web` category flag, so
 * the only persistent answer to "may the agent fetch this page?" was "yes, any
 * page, forever". A user who wanted the agent to read one documentation site
 * had to hand it the whole web, and there was no list afterwards showing what
 * that had covered.
 *
 * Per host, not per URL: a grant for one page of a site is in practice a grant
 * for the site (the next path on the same origin carries the same trust and the
 * same data-exfiltration reach), and a per-URL list grows to hundreds of rows
 * nobody reviews. Per host is the coarsest unit that is still honest.
 *
 * Scheme is deliberately NOT part of the key. http and https to the same host
 * reach the same operator, and splitting them would double the list for no
 * decision the user actually wants to make. Port IS part of it: a different port
 * is a different service.
 *
 * Pure and dependency-free so the pipeline, the settings list and the tests all
 * agree on what "the same host" means.
 */

/**
 * The host key for a URL, or null when the URL is unusable.
 *
 * Lowercased and IDNA-normalised by URL parsing. IPv6 hosts keep their
 * brackets (`[::1]:9000`), which is what makes a host:port key unambiguous.
 * Default ports are dropped so `https://x` and `https://x:443` do not become
 * two rows the user has to revoke separately.
 */
export function hostKeyOf(rawUrl: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    // Only the two schemes web_fetch accepts. Anything else must not be able to
    // mint a list entry that a later http call could then match against.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // URL already lowercases and punycodes the hostname.
    const host = parsed.hostname;
    if (host.length === 0) return null;
    const isDefaultPort = parsed.port === ''
        || (parsed.protocol === 'http:' && parsed.port === '80')
        || (parsed.protocol === 'https:' && parsed.port === '443');
    return isDefaultPort ? host : `${host}:${parsed.port}`;
}

/**
 * True when the user has allowed this URL's host.
 *
 * Exact host match only. No suffix matching: allowing `example.com` must not
 * silently allow `evil-example.com`, and allowing it for subdomains would make
 * one click cover an attacker-controlled `user-content.example.com`. If someone
 * wants a subdomain, they grant the subdomain.
 */
export function isHostAllowed(allowed: readonly string[] | undefined, rawUrl: string): boolean {
    const key = hostKeyOf(rawUrl);
    if (key === null) return false;
    return (allowed ?? []).includes(key);
}

/**
 * Add a host to the list. Returns the new list, or null when the URL yields no
 * usable host (so the caller can refuse rather than store a junk row).
 */
export function allowHost(allowed: readonly string[] | undefined, rawUrl: string): string[] | null {
    const key = hostKeyOf(rawUrl);
    if (key === null) return null;
    const list = [...(allowed ?? [])];
    if (!list.includes(key)) list.push(key);
    list.sort();
    return list;
}

/** Remove a host from the list. */
export function revokeHost(allowed: readonly string[] | undefined, host: string): string[] {
    return (allowed ?? []).filter((h) => h !== host);
}
