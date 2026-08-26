/**
 * Shared HTTP response body-cap helper.
 *
 * AUDIT 2026-07-14 (Codex) M-7: both WebFetchTool.requestOnce and
 * SandboxBridge.fetchOnce accumulated response chunks unbounded and only
 * enforced a size limit after Buffer.concat (or not at all). A large or slow
 * response could exhaust the renderer heap. This helper enforces a hard byte
 * cap while streaming and rejects early on an oversized Content-Length.
 * Consolidates the previously-open SEC-039-M2 (SandboxBridge body-size cap).
 */

/** Default hard cap on a single buffered HTTP response body (8 MB). */
export const MAX_RESPONSE_BYTES = 8_000_000;

/** Parse a Content-Length header value; null when absent or invalid. */
export function parseContentLength(v: string | string[] | undefined): number | null {
    const s = Array.isArray(v) ? v[0] : v;
    if (s === undefined) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

interface ByteStream {
    headers: Record<string, string | string[] | undefined>;
    on(event: 'data', cb: (chunk: Buffer) => void): unknown;
    on(event: 'end', cb: () => void): unknown;
    on(event: 'error', cb: (err: Error) => void): unknown;
}

/**
 * Read an HTTP response body into a UTF-8 string, enforcing a hard byte cap
 * while streaming. Rejects (and invokes onAbort to destroy the request) as soon
 * as the declared Content-Length or the received bytes exceed maxBytes, so the
 * process never buffers an unbounded response.
 */
export function readCappedResponseBody(
    res: ByteStream,
    onAbort: () => void,
    maxBytes: number,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const declared = parseContentLength(res.headers['content-length']);
        if (declared !== null && declared > maxBytes) {
            onAbort();
            reject(new Error(`Response exceeds ${maxBytes}-byte cap (Content-Length ${declared})`));
            return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;
        res.on('data', (chunk: Buffer) => {
            if (settled) return;
            received += chunk.length;
            if (received > maxBytes) {
                settled = true;
                onAbort();
                reject(new Error(`Response exceeds ${maxBytes}-byte cap`));
                return;
            }
            chunks.push(chunk);
        });
        res.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
    });
}

/**
 * Binary sibling of {@link readCappedResponseBody}: streams the response into a
 * Buffer under the same hard byte cap, WITHOUT UTF-8 decoding. clip_web_page
 * downloads image bytes (PNG/JPEG/WebP/...), which are not valid UTF-8 and would
 * be corrupted by the string reader. The cap logic is identical: reject early on
 * an oversized Content-Length, abort once streamed bytes exceed maxBytes.
 */
export function readCappedResponseBodyBuffer(
    res: ByteStream,
    onAbort: () => void,
    maxBytes: number,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const declared = parseContentLength(res.headers['content-length']);
        if (declared !== null && declared > maxBytes) {
            onAbort();
            reject(new Error(`Response exceeds ${maxBytes}-byte cap (Content-Length ${declared})`));
            return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;
        res.on('data', (chunk: Buffer) => {
            if (settled) return;
            received += chunk.length;
            if (received > maxBytes) {
                settled = true;
                onAbort();
                reject(new Error(`Response exceeds ${maxBytes}-byte cap`));
                return;
            }
            chunks.push(chunk);
        });
        res.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks));
        });
        res.on('error', (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
    });
}
