/**
 * ssrfGuard -- the SSRF policy and the redirect-safe HTTP transport, extracted
 * from WebFetchTool so clip_web_page can run its image downloads through the
 * EXACT same guard chain (spec 4.5: the image loader is the open door if it
 * skips this). Uses node:http / node:https directly, NOT Obsidian's requestUrl,
 * because requestUrl follows redirects internally without re-running the guard
 * per hop (the L-14 bypass). Every hop -- for the page URL and for every image
 * URL -- is re-validated before it is followed.
 *
 * WebFetchTool re-exports isPrivateIP / hasInternalSuffix from here so its
 * existing SSRF regression suite keeps resolving them.
 */

import dns from 'dns';
import net from 'net';
import http from 'http';
import https from 'https';
import { MAX_RESPONSE_BYTES, readCappedResponseBody, readCappedResponseBodyBuffer } from '../../utils/httpBodyCap';

/**
 * Strict IPv4 dotted-quad regex: exactly four 0-255 octets, no leading zeros beyond a single 0.
 * `net.isIPv4` is the source of truth where available; this is the fallback shape check.
 */
const IPV4_OCTET_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Strip surrounding IPv6 brackets and an optional zone-id suffix (fe80::1%eth0).
 * Returns the bare address text suitable for net.isIP and pattern checks.
 */
export function normalizeHostForIpCheck(host: string): string {
    let h = host.trim().toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) {
        h = h.slice(1, -1);
    }
    // Strip IPv6 zone-id (RFC 6874) so fe80::1%eth0 still matches the link-local pattern.
    const pct = h.indexOf('%');
    if (pct >= 0) {
        h = h.slice(0, pct);
    }
    return h;
}

/**
 * Check whether an IP literal belongs to a private/internal network range.
 * Covers RFC 1918, loopback, CGNAT (RFC 6598), link-local + APIPA, multicast, broadcast,
 * unspecified, and IPv6 equivalents (loopback, link-local, ULA, IPv4-mapped wrappers).
 * Accepts both bracketed and unbracketed IPv6 input.
 */
export function isPrivateIP(ip: string): boolean {
    const bare = normalizeHostForIpCheck(ip);

    // IPv4
    if (net.isIPv4(bare)) {
        const parts = bare.split('.');
        // Each octet must be a strict integer in 0-255; reject anything else.
        if (parts.length !== 4 || !parts.every((p) => IPV4_OCTET_RE.test(p))) return false;
        const [a, b] = parts.map((p) => parseInt(p, 10));
        return (
            a === 0 ||                                   // 0.0.0.0/8     "this" network / unspecified
            a === 10 ||                                  // 10.0.0.0/8    RFC 1918
            a === 127 ||                                 // 127.0.0.0/8   loopback
            (a === 100 && b >= 64 && b <= 127) ||        // 100.64.0.0/10 CGNAT (RFC 6598)
            (a === 169 && b === 254) ||                  // 169.254.0.0/16 link-local / APIPA / cloud metadata
            (a === 172 && b >= 16 && b <= 31) ||         // 172.16.0.0/12 RFC 1918
            (a === 192 && b === 168) ||                  // 192.168.0.0/16 RFC 1918
            (a >= 224 && a <= 239) ||                    // 224.0.0.0/4   multicast
            (a >= 240 && a <= 255)                       // 240.0.0.0/4   reserved + 255.255.255.255 broadcast
        );
    }

    // IPv6
    if (net.isIPv6(bare)) {
        const norm = bare;

        // Unspecified ::
        if (norm === '::' || norm === '::0') return true;
        // Loopback ::1
        if (norm === '::1') return true;
        // Link-local fe80::/10 (covers fe80, fe90, fea0, feb0 prefixes; first nibble after fe is 8-b)
        if (/^fe[89ab][0-9a-f]?:/i.test(norm)) return true;
        // Unique-local fc00::/7 (fc.. or fd..)
        if (/^f[cd][0-9a-f]{2}:/.test(norm)) return true;
        // Multicast ff00::/8
        if (/^ff[0-9a-f]{2}:/.test(norm)) return true;

        // IPv4-mapped IPv6 ::ffff:0:0/96 and IPv4-compatible ::a.b.c.d.
        // Two shapes: ::ffff:127.0.0.1 (dotted) and ::ffff:7f00:1 (hex compressed).
        const dottedMatch = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(norm);
        if (dottedMatch) {
            return isPrivateIP(dottedMatch[1]);
        }
        // Hex form: ::ffff:HHHH:HHHH or ::HHHH:HHHH (IPv4-compatible legacy).
        const hexMatch = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(norm);
        if (hexMatch) {
            const hi = parseInt(hexMatch[1], 16);
            const lo = parseInt(hexMatch[2], 16);
            const a = (hi >> 8) & 0xff;
            const b = hi & 0xff;
            const c = (lo >> 8) & 0xff;
            const d = lo & 0xff;
            return isPrivateIP(`${a}.${b}.${c}.${d}`);
        }
        return false;
    }

    // Not a recognized IP literal.
    return false;
}

/**
 * Proxy fake-ip placeholder ranges. Clash/mihomo (and Surge) in fake-ip DNS
 * mode answer every A/AAAA query with a synthetic address from these ranges --
 * 198.18.0.0/15 (RFC 2544 benchmarking) for IPv4 and fdfe:dcba:9876::/48 for
 * IPv6 -- and resolve the real target inside the proxy tunnel. The synthetic
 * address is NOT an intranet host: without a proxy it is unroutable and the
 * connection dead-ends; with a proxy the egress is the user's own tunnel
 * policy, same as any browser request. Blocking them (the fd.. range trips
 * the ULA rule) breaks web_fetch for every fake-ip user, so the guard
 * exempts exactly these two ranges. Genuine ULA (any other fd../fc.. prefix)
 * stays blocked.
 */
export function isProxyPlaceholderIp(ip: string): boolean {
    const bare = normalizeHostForIpCheck(ip);

    if (net.isIPv4(bare)) {
        const parts = bare.split('.');
        if (parts.length !== 4 || !parts.every((p) => IPV4_OCTET_RE.test(p))) return false;
        const [a, b] = parts.map((p) => parseInt(p, 10));
        return a === 198 && (b === 18 || b === 19); // 198.18.0.0/15
    }
    if (net.isIPv6(bare)) {
        // The /48's leading hextons are non-zero, so they always appear
        // verbatim at the start of the compressed text form.
        return bare.startsWith('fdfe:dcba:9876:');
    }
    return false;
}

/** The address the guard rejects: a private range that is not a proxy placeholder. */
function isBlockedIp(ip: string): boolean {
    return isPrivateIP(ip) && !isProxyPlaceholderIp(ip);
}

/**
 * Hostname suffix denylist: split-horizon corporate networks and common
 * internal-only TLDs that should never be reachable from an agent fetch.
 * Matched case-insensitively against the trimmed bracket-stripped hostname.
 */
const INTERNAL_HOSTNAME_SUFFIXES: ReadonlyArray<string> = [
    '.localhost',
    '.local',
    '.internal',
    '.intranet',
    '.intra',
    '.corp',
    '.lan',
    '.home',
    '.home.arpa',
];

export function hasInternalSuffix(host: string): boolean {
    const h = host.trim().toLowerCase();
    if (h === 'localhost') return true;
    return INTERNAL_HOSTNAME_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Validate a URL against the SSRF policy.
 * Phase 1: scheme allowlist, bracket-stripped hostname checked against IP private ranges
 *          and the internal-suffix denylist.
 * Phase 2: OS-resolver lookup for non-IP hostnames; any private resolved IP rejects.
 *          Proxy fake-ip placeholders (isProxyPlaceholderIp) are exempt -- see there.
 *          Lookup failures for non-IP hostnames fail closed (return reason), since a
 *          silently-swallowed split-horizon NXDOMAIN previously let public-DNS misses
 *          fall through to the network stack that DID resolve the internal name.
 */
export async function guardUrl(url: string): Promise<GuardResult> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, reason: 'Invalid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: 'URL must start with http:// or https://' };
    }
    const rawHost = parsed.hostname.toLowerCase();
    const bareHost = normalizeHostForIpCheck(rawHost);

    if (hasInternalSuffix(bareHost)) {
        return {
            ok: false,
            reason: 'Access to private/internal network addresses is not allowed',
        };
    }
    if (isBlockedIp(bareHost)) {
        return {
            ok: false,
            reason: 'Access to private/internal network addresses is not allowed',
        };
    }

    // IP literals do not need a DNS lookup.
    if (net.isIP(bareHost)) {
        return { ok: true };
    }

    // Phase 2: OS resolver. Use dns.promises.lookup so the same resolver the network
    // stack uses on connect drives the decision. Split-horizon corporate DNS now
    // returns the same answer to both our guard and the actual request.
    try {
        const addrs = await dns.promises.lookup(bareHost, { all: true, verbatim: true });
        if (addrs.length === 0) {
            return {
                ok: false,
                reason: `Hostname "${bareHost}" could not be resolved`,
            };
        }
        for (const addr of addrs) {
            if (isBlockedIp(addr.address)) {
                return {
                    ok: false,
                    reason: `Hostname "${bareHost}" resolves to private address ${addr.address}; access denied (SSRF protection)`,
                };
            }
        }
        return { ok: true };
    } catch {
        // Fail closed for hostnames we cannot resolve. IP literals are already accepted above.
        return {
            ok: false,
            reason: `Hostname "${bareHost}" could not be resolved; refusing fetch (SSRF protection)`,
        };
    }
}

export interface GuardedResponse {
    status: number;
    headers: Record<string, string>;
    /** Decoded body text (empty string in binary mode). */
    text: string;
    /** Raw bytes (binary mode only; null in text mode). */
    bytes: Buffer | null;
    /** The URL the response was actually served from, after following redirects. */
    finalUrl: string;
}

export interface FetchOptions {
    timeoutMs: number;
    /** 'text' decodes to a string; 'binary' returns raw bytes for image downloads. */
    responseType?: 'text' | 'binary';
    /** Hard body cap for this fetch (default MAX_RESPONSE_BYTES). Images pass a per-image cap. */
    maxBytes?: number;
}

/**
 * Fetch a URL with manual redirect handling. Each redirect hop is re-validated
 * through guardUrl before it is followed, which closes the L-14 redirect-bypass gap
 * (Obsidian's requestUrl follows redirects internally without re-running the guard).
 * The actual transport is node:http / node:https; we never delegate to requestUrl
 * because that would re-introduce the uncapped redirect chain.
 *
 * The caller is responsible for running guardUrl(initialUrl) FIRST (WebFetchTool
 * and ClipWebPageTool both do, so the initial hostname is rejected before the
 * "Fetching" log). This function guards every SUBSEQUENT hop.
 */
export async function fetchWithRedirectGuard(
    initialUrl: string,
    options: FetchOptions,
): Promise<GuardedResponse> {
    const MAX_REDIRECTS = 3;
    let currentUrl = initialUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await requestOnce(currentUrl, options);

        // Not a redirect: return the response payload.
        if (response.status < 300 || response.status >= 400) {
            return { ...response, finalUrl: currentUrl };
        }

        // Redirect: resolve Location relative to current URL, validate, then continue.
        const location = response.headers['location'] ?? response.headers['Location'];
        if (!location) {
            // Redirect status without a Location header: nothing safe to do, return as-is.
            return { ...response, finalUrl: currentUrl };
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
        const guardResult = await guardUrl(nextUrl);
        if (!guardResult.ok) {
            throw new Error(
                `Redirect to "${nextUrl}" blocked: ${guardResult.reason}`,
            );
        }
        currentUrl = nextUrl;
    }
    // Unreachable; the loop returns or throws.
    throw new Error(`Redirect handling exited unexpectedly for ${initialUrl}`);
}

/**
 * Single HTTP request via node:http / node:https that does NOT follow redirects.
 * Returns the raw status, headers, and body (decoded text or raw bytes). Times out
 * after options.timeoutMs. We intentionally bypass Obsidian's requestUrl here because
 * it follows redirects internally with no exposed cap, which would defeat the per-hop guard.
 */
function requestOnce(
    url: string,
    options: FetchOptions,
): Promise<{ status: number; headers: Record<string, string>; text: string; bytes: Buffer | null }> {
    const binary = options.responseType === 'binary';
    const timeoutMs = options.timeoutMs;
    const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
    return new Promise((resolve, reject) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;

        const req = lib.request(
            {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: `${parsed.pathname}${parsed.search}`,
                method: 'GET',
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (compatible; ObsidianAgent/1.0; +https://obsidian.md)',
                    Accept: binary
                        ? 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8'
                        : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    // Explicit identity: we do not decompress in this transport path.
                    'Accept-Encoding': 'identity',
                    Host: parsed.host,
                },
            },
            (res) => {
                // Socket-level rebinding defense: inspect the actual remoteAddress now
                // that the connection is established. Catches TOCTOU between guard and
                // connect even when the OS resolver agreed with our pre-check.
                const remote = res.socket && (res.socket as { remoteAddress?: string }).remoteAddress;
                if (remote && isBlockedIp(remote)) {
                    req.destroy();
                    reject(
                        new Error(
                            `Connection to "${parsed.hostname}" landed on private address ${remote}; access denied (SSRF protection)`,
                        ),
                    );
                    return;
                }
                const collectHeaders = (): Record<string, string> => {
                    const headers: Record<string, string> = {};
                    for (const [k, v] of Object.entries(res.headers)) {
                        if (typeof v === 'string') headers[k] = v;
                        else if (Array.isArray(v)) headers[k] = v.join(', ');
                    }
                    return headers;
                };
                const status = res.statusCode ?? 0;
                // A redirect response (3xx) is consumed only for its Location header;
                // its BODY is never used. Do NOT download it -- abort after the headers
                // so a redirect-stuffing attacker cannot push a full body on every hop
                // before the redirect-limit throw (spec 4.5: no silent mass download).
                if (status >= 300 && status < 400) {
                    const headers = collectHeaders();
                    req.destroy();
                    resolve({ status, headers, text: '', bytes: null });
                    return;
                }
                // AUDIT 2026-07-14 (Codex) M-7: cap the buffered body while
                // streaming instead of after Buffer.concat.
                const reader = binary
                    ? readCappedResponseBodyBuffer(res, () => req.destroy(), maxBytes).then((bytes) => ({
                          status,
                          headers: collectHeaders(),
                          text: '',
                          bytes,
                      }))
                    : readCappedResponseBody(res, () => req.destroy(), maxBytes).then((body) => ({
                          status,
                          headers: collectHeaders(),
                          text: body,
                          bytes: null as Buffer | null,
                      }));
                reader.then(resolve).catch(reject);
            },
        );
        req.on('error', (err) => reject(err));
        // Idle timeout: fires when no socket activity for timeoutMs.
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timed out after ${timeoutMs / 1000}s`));
        });
        // AUDIT 2026-07-14 (Codex) M-7: absolute ceiling independent of idle
        // activity, so a server that dribbles bytes just under the idle
        // timeout cannot hold the request open indefinitely.
        const absoluteBudgetMs = Math.max(timeoutMs * 3, 45_000);
        // window.setTimeout (not the bare global) for Obsidian popout-window
        // compat -- the review-bot's obsidianmd/platform/use-window-setTimeout
        // rule requires it. In the renderer this handle is a number; under the
        // vitest node env `window` aliases globalThis (safeFsSetup) so it is a
        // Timeout object that would otherwise hold the process open -- unref it
        // wherever the method exists.
        const hardDeadline = window.setTimeout(() => {
            req.destroy(new Error(`Request exceeded absolute time budget of ${absoluteBudgetMs / 1000}s`));
        }, absoluteBudgetMs);
        (hardDeadline as unknown as { unref?: () => void }).unref?.();
        req.on('close', () => window.clearTimeout(hardDeadline));
        req.end();
    });
}
