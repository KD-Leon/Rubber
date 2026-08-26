/**
 * imageClipper -- deterministic, I/O-free core for the clip_web_page tool.
 *
 * Everything here is a pure function: parse an <img> tag, resolve an image URL
 * against the page, derive a stable filename, and rewrite the markdown image
 * links to point at the locally saved copies. The tool orchestrates these plus
 * the SSRF-guarded transport and the vault writes; keeping the logic pure makes
 * the srcset / relative-URL / dedup / determinism cases unit-testable without a
 * network or an Obsidian instance.
 */

import { createHash } from 'crypto';

/**
 * Content-Type -> file extension for the image formats clip_web_page accepts.
 * The Content-Type is authoritative (checked over the wire); the URL extension
 * is only a fallback. jpg and jpeg both normalise to `.jpg`.
 */
const CONTENT_TYPE_TO_EXT: Readonly<Record<string, string>> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
};

/** Extensions accepted from a URL path when the Content-Type is ambiguous. */
const URL_EXT_TO_EXT: Readonly<Record<string, string>> = {
    png: '.png',
    jpg: '.jpg',
    jpeg: '.jpg',
    gif: '.gif',
    webp: '.webp',
    svg: '.svg',
    avif: '.avif',
};

/** Decode the one HTML entity that routinely appears inside URLs. */
function decodeAmp(s: string): string {
    return s.replace(/&amp;/gi, '&');
}

/** Read a single HTML attribute value (double, single, or unquoted). */
function readAttr(tag: string, name: string): string | null {
    const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const m = re.exec(tag);
    if (!m) return null;
    return m[2] ?? m[3] ?? m[4] ?? null;
}

/**
 * Pick the highest-resolution candidate from a `srcset` value. Prefers the
 * largest width (`w`) or density (`x`) descriptor; falls back to the last
 * listed candidate when none carry a descriptor.
 */
export function pickFromSrcset(srcset: string): string | null {
    const candidates = srcset.split(',').map((c) => c.trim()).filter(Boolean);
    if (candidates.length === 0) return null;
    let bestValue = -1;
    let bestUrl: string | null = null;
    let lastUrl: string | null = null;
    for (const cand of candidates) {
        const parts = cand.split(/\s+/);
        const url = parts[0];
        if (!url) continue;
        lastUrl = url;
        const desc = parts[1];
        const dm = desc ? /^(\d+(?:\.\d+)?)(w|x)$/i.exec(desc) : null;
        const value = dm ? parseFloat(dm[1]) : 0;
        if (dm && value > bestValue) {
            bestValue = value;
            bestUrl = url;
        }
    }
    return bestUrl ?? lastUrl;
}

/**
 * Extract the best raw src and the alt text from an `<img ...>` tag. Returns the
 * `src` attribute if present, otherwise the largest `srcset` candidate. `src` is
 * the raw attribute string (still entity-encoded); resolveImageUrl normalises it.
 */
export function parseImgTag(tag: string): { src: string | null; alt: string } {
    const alt = sanitizeAltText(readAttr(tag, 'alt') ?? '');
    const src = readAttr(tag, 'src');
    if (src && src.trim()) return { src: src.trim(), alt };
    const srcset = readAttr(tag, 'srcset');
    if (srcset && srcset.trim()) {
        const chosen = pickFromSrcset(srcset.trim());
        if (chosen) return { src: chosen, alt };
    }
    return { src: null, alt };
}

/**
 * Resolve a raw image src against the page URL into an absolute http(s) URL.
 * Returns null for data: URIs, non-http(s) schemes, blank input, and anything
 * that fails to parse -- those are simply not downloaded and left in place.
 */
export function resolveImageUrl(rawSrc: string, baseUrl: string): string | null {
    const src = decodeAmp((rawSrc ?? '').trim());
    if (!src) return null;
    if (/^data:/i.test(src)) return null;
    try {
        const u = new URL(src, baseUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.toString();
    } catch {
        return null;
    }
}

/** The markdown image regex: `![alt](src "optional title")`. */
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]*)\)/g;

/** Split the inner `(...)` of a markdown image into url + optional title. */
function urlFromMarkdownTarget(inner: string): string {
    return inner.trim().split(/\s+/)[0] ?? '';
}

/**
 * Collect the resolved absolute URLs of every markdown image in `markdown`,
 * deduped and in first-seen order. This is the download work-list: every entry
 * is guaranteed to appear in the markdown, so rewriteImageLinks can always find
 * it (no orphan downloads).
 */
export function extractMarkdownImageRefs(markdown: string, baseUrl: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of markdown.matchAll(MD_IMAGE_RE)) {
        const abs = resolveImageUrl(urlFromMarkdownTarget(m[2]), baseUrl);
        if (abs && !seen.has(abs)) {
            seen.add(abs);
            out.push(abs);
        }
    }
    return out;
}

/** Map a Content-Type to an accepted image extension, or null if not an image. */
export function imageExtFromContentType(contentType: string): string | null {
    const base = (contentType ?? '').split(';')[0].trim().toLowerCase();
    return CONTENT_TYPE_TO_EXT[base] ?? null;
}

/** Leading bytes match `sig` starting at `at`. */
function startsWith(bytes: Uint8Array, sig: readonly number[], at = 0): boolean {
    if (bytes.length < at + sig.length) return false;
    return Buffer.from(bytes.subarray(at, at + sig.length)).equals(Buffer.from(sig));
}

/**
 * Latin-1 of a fixed-length span, or '' when the buffer is too short. Latin-1
 * rather than utf8 so every byte maps to exactly one char and offsets stay
 * byte offsets.
 */
function ascii(bytes: Uint8Array, at: number, len: number): string {
    if (bytes.length < at + len) return '';
    return Buffer.from(bytes.subarray(at, at + len)).toString('latin1');
}

/** ISO-BMFF brands we accept. AVIF sequences use `avis`. */
const AVIF_BRANDS: readonly string[] = ['avif', 'avis'];

/**
 * Derive the image format from the bytes themselves.
 *
 * The Content-Type comes from the remote server, so it decides nothing on its
 * own: a page can serve `image/png` and hand over ICNS or HEIF, which is
 * exactly the input class the image-size advisories turn into an endless loop.
 * Sniffing keeps the accepted set closed to what we can name, and anything
 * unrecognised is rejected rather than stored under a guessed extension.
 *
 * SVG has no binary signature, so it is sniffed as text: a BOM and leading
 * whitespace are skipped, an optional XML prolog is allowed, and an `<svg`
 * element must actually open. Returns null when nothing matches.
 */
export function imageExtFromBytes(bytes: Uint8Array): string | null {
    if (bytes.length < 4) return null;

    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return '.png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return '.jpg';

    const gif = ascii(bytes, 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return '.gif';

    // RIFF is a container: only the WEBP form is an image.
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return '.webp';

    // ISO-BMFF: the brand at offset 8 separates AVIF from HEIF/HEIC.
    if (ascii(bytes, 4, 4) === 'ftyp' && AVIF_BRANDS.includes(ascii(bytes, 8, 4).toLowerCase())) {
        return '.avif';
    }

    // ascii() yields one char per byte, so a UTF-8 BOM arrives as its three
    // raw bytes rather than as U+FEFF.
    const head = ascii(bytes, 0, Math.min(bytes.length, 512))
        .replace(/^ï»¿/, '')
        .trimStart()
        .toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return '.svg';

    return null;
}

/** Fallback: derive an accepted image extension from a URL path. */
export function imageExtFromUrl(url: string): string | null {
    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        pathname = url;
    }
    const dot = pathname.lastIndexOf('.');
    if (dot < 0) return null;
    const ext = pathname.slice(dot + 1).toLowerCase();
    return URL_EXT_TO_EXT[ext] ?? null;
}

/**
 * Deterministic filename for a downloaded image: `clip-<16 hex>.ext`, keyed on
 * the SHA-256 of the absolute URL. The determinism is load-bearing: re-clipping
 * the same page targets the same paths, so writeBinaryToVault modifies the
 * existing file instead of creating a duplicate (acceptance criterion 2).
 */
export function imageFilenameFor(absoluteUrl: string, ext: string): string {
    const hash = createHash('sha256').update(absoluteUrl).digest('hex').slice(0, 16);
    return `clip-${hash}${ext}`;
}

/** Strip characters that would break a markdown `![alt](...)` link. */
export function sanitizeAltText(alt: string): string {
    return (alt ?? '').replace(/[[\]]/g, '').replace(/[\r\n]+/g, ' ');
}

/**
 * Rewrite markdown image links. Downloaded images become Obsidian embeds
 * (`![[vault/path]]`) so they render in preview, offline. Images that were not
 * downloaded are absolutised to their remote URL (a bare relative path would be
 * a dead link inside a vault note). Unresolvable targets (data: URIs, parse
 * failures) are left exactly as they are.
 *
 * @param localFor maps an absolute URL to the vault path it was saved at, or null.
 */
export function rewriteImageLinks(
    markdown: string,
    baseUrl: string,
    localFor: (absoluteUrl: string) => string | null,
): string {
    return markdown.replace(MD_IMAGE_RE, (whole, alt: string, inner: string) => {
        const abs = resolveImageUrl(urlFromMarkdownTarget(inner), baseUrl);
        if (!abs) return whole; // data:, unparseable -- leave untouched
        const local = localFor(abs);
        if (local) return `![[${local}]]`;
        return `![${sanitizeAltText(alt)}](${abs})`;
    });
}

/**
 * Neutralise the obvious script vectors in an SVG before it is written to the
 * vault (AUDIT 2026-07-31 L-1). SVG is XML that can carry executable content;
 * whether Obsidian's renderer would run it is renderer-dependent and not
 * decidable from the plugin code, so this is defense-in-depth, not a proof.
 * Removes <script> and <foreignObject> elements (looped to a fixpoint so a
 * removal cannot leave a reconstructed live tag, CWE-116), strips inline event-
 * handler attributes (on*), and neutralises javascript: URIs. It is a
 * best-effort filter over untrusted markup, not a complete XSS sanitiser.
 */
export function sanitizeSvg(svg: string): string {
    let s = svg ?? '';
    const ELEMENT_RES = [
        /<script[\s\S]*?<\/script[^>]*>/gi,
        /<foreignObject[\s\S]*?<\/foreignObject[^>]*>/gi,
        /<\/?(?:script|foreignObject)[^>]*>/gi,
    ];
    // Each changing pass deletes at least one tag, so a length-bounded loop
    // reaches a true fixpoint; a clean input matches nothing and exits at once.
    let prev: string;
    let guard = s.length + 16;
    do {
        prev = s;
        for (const re of ELEMENT_RES) s = s.replace(re, '');
    } while (s !== prev && guard-- > 0);
    // Inline event handlers: onload=, onclick=, ... (quoted or bare), fixpoint.
    const onRe = /\son[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
    guard = s.length + 16;
    do { prev = s; s = s.replace(onRe, ''); } while (s !== prev && guard-- > 0);
    // Neutralise javascript: URIs in href / xlink:href / src (and anywhere else).
    s = s.replace(/javascript\s*:/gi, '#');
    return s;
}

/**
 * A filesystem-safe slug for a page URL, used to build the default per-page
 * attachment subfolder. Keeps the attachment folder sorted and makes deleting a
 * clip note plus its images one folder operation.
 */
export function slugForUrl(url: string): string {
    let raw: string;
    try {
        const u = new URL(url);
        raw = `${u.hostname}${u.pathname}`;
    } catch {
        raw = url;
    }
    const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return slug || 'page';
}
