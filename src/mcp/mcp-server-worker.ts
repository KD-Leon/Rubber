/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- File-level disable: interacts with external SDK / JSON / Obsidian internals where untyped 'any' values are unavoidable. Inputs are validated at boundaries via type guards or schema checks where security-relevant. */
/**
 * MCP Server Worker -- Thin stdio-to-HTTP proxy for Claude Desktop.
 *
 * Claude Desktop starts this process and communicates via stdio using
 * newline-delimited JSON (one JSON object per line, terminated with \n).
 *
 * This worker forwards all requests to Vault Operator's HTTP endpoint (localhost:27182)
 * where the real MCP server runs inside Obsidian.
 *
 * Architecture:
 *   Claude Desktop  ←stdio (JSON lines)→  this worker  ←HTTP→  Vault Operator (:27182)
 *
 * The worker carries fixed English wire texts and knows no i18n: its output is
 * read by client SDKs and by whoever debugs a connector, never rendered as UI.
 */

const VAULT_OPERATOR_URL = 'http://127.0.0.1:27182';

// AUDIT-006 H-1: auth token from the well-known file, read at proxy start.
let mcpToken = '';

function readMcpToken(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- standalone Node.js worker process, not bundled by esbuild
        const fs = require('fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- standalone Node.js worker process, not bundled by esbuild
        const path = require('path');
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- standalone Node.js worker process, not bundled by esbuild
        const os = require('os');
        return fs.readFileSync(path.join(os.homedir(), '.obsidian-agent', 'mcp-token'), 'utf-8').trim();
    } catch {
        // token file not found -- requests will be rejected by the server, and
        // that rejection now reaches the client as an error (FIX-14-04-01)
        return '';
    }
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

/** The id of the request the proxy just forwarded, if the client sent a usable one. */
function requestIdOf(request: unknown): string | number | null {
    const id = (request as { id?: unknown } | null | undefined)?.id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** A JSON-RPC error object the bridge already shaped, or null if the body is something else. */
function extractJsonRpcError(rawBody: string): { code: number; message: string } | null {
    try {
        const parsed = JSON.parse(rawBody) as { error?: { code?: unknown; message?: unknown } };
        const error = parsed?.error;
        if (!error || typeof error.code !== 'number' || typeof error.message !== 'string') return null;
        return { code: error.code, message: error.message.slice(0, 400) };
    } catch {
        return null;
    }
}

/** One-line, length-bounded echo of a body that is not JSON-RPC (HTML error page, proxy text). */
function bodyDetail(rawBody: string): string {
    const collapsed = rawBody.replace(/\s+/g, ' ').trim();
    if (!collapsed) return '';
    return `: ${collapsed.slice(0, 200)}`;
}

/**
 * FIX-14-04-01: map an HTTP response to the single stdout line the client gets.
 *
 * The old proxy piped the body to stdout without ever reading res.statusCode.
 * The bridge rejects before it parses the body (auth and the 1 MB size limit
 * both run first), so its error bodies carry `id: null`. A client SDK discards
 * a line whose id is null, because RequestId is string | number, and the open
 * request then sits there until the client's own 30 s connection timeout --
 * a hang where a refusal was due. The proxy holds the id of the request it
 * just forwarded, so it is the place that can repair the line.
 *
 * Returns the line to write (without the trailing newline), or null when the
 * client expects nothing (notifications, empty 2xx bodies).
 */
export function buildProxyStdoutLine(
    request: unknown,
    statusCode: number,
    rawBody: string,
    expectResponse: boolean,
): string | null {
    if (!expectResponse) return null;

    if (statusCode >= 200 && statusCode < 300) {
        const trimmed = rawBody.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    const error = extractJsonRpcError(rawBody) ?? {
        code: -32603,
        message: `Vault Operator returned HTTP ${statusCode}${bodyDetail(rawBody)}`,
    };
    return JSON.stringify({ jsonrpc: '2.0', id: requestIdOf(request), error });
}

/**
 * The transport-failure line (Obsidian not running, timeout). This path always
 * kept the request id and named the cause, which is why it never hung; it is
 * the model buildProxyStdoutLine follows for status codes.
 */
export function buildProxyErrorLine(request: unknown, cause: unknown): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: requestIdOf(request),
        error: {
            code: -32603,
            message: `Vault Operator not reachable. Is Obsidian running with the connector enabled? (${cause instanceof Error ? cause.message : String(cause)})`,
        },
    });
}

// ---------------------------------------------------------------------------
// Forward to Vault Operator HTTP and write response as JSON line to stdout
// ---------------------------------------------------------------------------

async function forwardToVaultOperator(request: unknown, expectResponse = true): Promise<void> {
    try {
        const http = await import('http');
        const body = JSON.stringify(request);

        const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
            const req = http.request(VAULT_OPERATOR_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    ...(mcpToken ? { 'Authorization': `Bearer ${mcpToken}` } : {}),
                },
                timeout: 30000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                // FIX-14-04-01: the status code travels with the body from here on.
                res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(body);
            req.end();
        });

        const line = buildProxyStdoutLine(request, response.statusCode, response.body, expectResponse);
        if (line !== null) {
            process.stdout.write(line + '\n');
            if (response.statusCode < 200 || response.statusCode >= 300) {
                process.stderr.write(`[mcp-proxy] Vault Operator rejected the request with HTTP ${response.statusCode}\n`);
            }
        }
    } catch (e) {
        process.stdout.write(buildProxyErrorLine(request, e) + '\n');
    }
}

// ---------------------------------------------------------------------------
// Bootstrap: read newline-delimited JSON from stdin
// ---------------------------------------------------------------------------

/**
 * Wire stdin and start proxying. Only the direct process start calls this
 * (see the guard below), so importing this module -- in a test, for instance --
 * touches no stdio.
 */
export function startProxy(): void {
    mcpToken = readMcpToken();

    let buffer = '';

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
        buffer += chunk;

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
            buffer = buffer.slice(newlineIdx + 1);
            if (!line.trim()) continue;

            try {
                const request = JSON.parse(line) as { id?: unknown; method?: string };
                // Notifications (no id) still forward but we suppress empty HTTP responses
                void forwardToVaultOperator(request, request.id !== undefined && request.id !== null);
            } catch {
                process.stderr.write(`[mcp-proxy] Invalid JSON: ${line.slice(0, 100)}\n`);
            }
        }
    });

    // Keep alive
    process.stdin.resume();
    process.stderr.write('[mcp-proxy] Vault Operator MCP proxy started\n');
}

// FIX-14-04-01: run only when Node started this file as the process entry.
// Under an import the module stays inert, which is what makes the mapping
// above testable at all.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    startProxy();
}

/* eslint-enable -- end of file-level disable for boundary code (SDK/JSON/Obsidian internals) */
