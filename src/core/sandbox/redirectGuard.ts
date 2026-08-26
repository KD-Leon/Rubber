/**
 * AUDIT-038 ISSUE-004 -- per-hop redirect validation.
 *
 * Obsidian's `requestUrl` follows HTTP redirects internally without
 * giving callers a chance to re-validate each hop. SandboxBridge's
 * URL allowlist therefore only covered the START url; an allowlisted
 * CDN that issues a redirect to a non-allowlisted host (or to AWS IMDS
 * / RFC 1918 / a custom port) would silently complete because the
 * second request happens inside requestUrl.
 *
 * The WebFetchTool already solves this by talking to node:http(s)
 * directly. This helper packages the same per-hop walk into a pure
 * function so the SandboxBridge can apply it without re-implementing
 * the loop, and so the loop itself is unit-testable with a stubbed
 * fetcher.
 */

export interface HopResponse {
    status: number;
    headers: Record<string, string>;
    text: string;
}

export type HopFetcher = (url: string) => Promise<HopResponse>;
export type HopGuard = (url: string) => boolean;

export interface RedirectChainOptions {
    /** Hard ceiling on number of follow-throughs (defaults to 3). */
    maxRedirects?: number;
}

/**
 * Walk a chain of HTTP responses, re-validating every redirect target
 * through `isAllowed` before fetching it. Returns the final non-redirect
 * response. Throws when:
 *   - a redirect target is not allowed by `isAllowed`,
 *   - the chain exceeds `maxRedirects`,
 *   - the `Location` header is missing on a 3xx,
 *   - the `Location` header is not a parsable URL relative to the
 *     current URL.
 *
 * The fetcher MUST not follow redirects on its own; this helper
 * assumes it returns the raw status, headers and body.
 */
export async function followAllowlistedRedirects(
    initialUrl: string,
    doFetch: HopFetcher,
    isAllowed: HopGuard,
    options: RedirectChainOptions = {},
): Promise<HopResponse> {
    const MAX_REDIRECTS = options.maxRedirects ?? 3;

    if (!isAllowed(initialUrl)) {
        throw new Error(`URL not on allowlist: ${initialUrl}`);
    }

    let currentUrl = initialUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await doFetch(currentUrl);

        if (response.status < 300 || response.status >= 400) {
            return response;
        }

        const location = response.headers['location'] ?? response.headers['Location'];
        if (!location) {
            return response;
        }
        if (hop === MAX_REDIRECTS) {
            throw new Error(
                `Redirect limit (${MAX_REDIRECTS}) exceeded while fetching ${initialUrl}`,
            );
        }
        let nextUrl: string;
        try {
            nextUrl = new URL(location, currentUrl).toString();
        } catch {
            throw new Error(`Invalid redirect target "${location}" from ${currentUrl}`);
        }
        if (!isAllowed(nextUrl)) {
            throw new Error(`Redirect to "${nextUrl}" blocked by allowlist`);
        }
        currentUrl = nextUrl;
    }
    throw new Error(`Redirect handling exited unexpectedly for ${initialUrl}`);
}
