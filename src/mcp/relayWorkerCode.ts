/**
 * Embedded Cloudflare Worker code for the Vault Operator Relay.
 * This is uploaded to Cloudflare via REST API when the user clicks "Deploy".
 *
 * Architecture: HTTP long-polling (NOT WebSocket) for Obsidian compatibility.
 * Obsidian's renderer CSP blocks WebSocket to external servers,
 * so we use requestUrl-based polling instead.
 *
 * Flow:
 *   1. AI assistant (claude.ai) sends POST /{token}/mcp with JSON-RPC
 *   2. Relay stores the request in the DO
 *   3. Plugin polls POST /poll with Authorization: Bearer header
 *   4. Plugin processes request, sends result via POST /respond with Bearer header
 *   5. DO resolves the original HTTP response to the AI assistant
 *
 * URL structure:
 *   /health                  -- static status (no auth); plugin liveness
 *                               only with relay token (Bearer or ?token=)
 *   /poll                    -- plugin long-polls for pending requests (Bearer auth)
 *   /respond                 -- plugin sends tool results back (Bearer auth)
 *   /{token}/mcp             -- MCP endpoint for AI assistants (token in URL)
 *   POST with Bearer header  -- MCP endpoint (Bearer auth)
 *
 * FIX-23-04-11 (issue #53): /poll is a true long-poll. The DO parks the
 * poll until a request arrives or POLL_PARK_MS elapses, and the plugin
 * re-polls immediately. First-byte latency for a POSTed initialize drops
 * from ~10-12s (short-poll gap, over Perplexity's 15s fetch timeout under
 * load) to the dispatch round-trip. The DO tracks lastPollAt and fails
 * POSTs fast with a JSON-RPC 502 when the plugin has not polled for
 * 2.5x the park window, instead of parking them for the 30s timeout.
 *
 * Security (AUDIT-005):
 *   - Constant-time token comparison (SHA-256 digest)
 *   - No debug/diagnostic endpoints
 *   - Queue size limits (DoS protection)
 *   - Request body size limit (1 MB)
 *   - CORS restricted per endpoint
 *   - Random correlation IDs
 *
 * FEATURE-1403: Remote Transport
 */

/**
 * IMP-14-03-01: worker version identity. Bump this whenever RELAY_WORKER_CODE
 * below changes, so a worker already deployed to a user's Cloudflare account
 * can be recognised as outdated (the settings tab warns, prompting a redeploy).
 * It is interpolated into the worker as WORKER_VERSION at build time -- this is
 * the ONLY unescaped ${} in the template; the runtime interpolation at sseFrame
 * is escaped (\\${...}) on purpose. Deployed pre-IMP-14-03-01 workers carry no
 * version field and are treated as outdated (isWorkerOutdated).
 */
export const RELAY_WORKER_VERSION = '1';

export const RELAY_WORKER_CODE = `
// Vault Operator Relay Worker -- deployed via Vault Operator Plugin
const WORKER_VERSION = "${RELAY_WORKER_VERSION}";

// FIX-23-04-11: long-poll park window for /poll. Kept safely below
// Obsidian requestUrl's implicit timeout; Cloudflare does not bill
// IO wait as CPU time. Request quota: idle long-polling is <= 180
// polls/hour (4320/day), half of the old fixed 10s short-poll (8640/day).
// FIX-23-04-14 (quota arithmetic, DO duration dimension): Durable Object
// duration is billed wall-clock while a request is open, so a parked poll
// with immediate re-poll keeps the single 'default' DO resident around
// the clock: 0.125 GB x 86,400 s = ~10,800 GB-s/day against the Workers
// Free plan cap of 13,000 GB-s/day. This is NOT a regression: DOs stay
// in memory ~10 s after the last request, so the old 10s short-poll
// already pinned the DO continuously, and one DO's wall clock cannot
// exceed 86,400 s/day, i.e. the relay alone cannot blow the cap. The
// remaining ~2,200 GB-s/day of headroom is shared with any OTHER Durable
// Objects on the same Cloudflare account (documented in connectors.md).
const POLL_PARK_MS = 20000;

// FIX-23-04-11: plugin counts as disconnected when it has not polled
// for 2.5x the park window. POSTs then fail fast with a JSON-RPC 502
// instead of parking for the 30s pending timeout.
const PLUGIN_STALE_MS = 50000;

// Constant-time token comparison via SHA-256 digest (H-1)
async function safeTokenCompare(a, b) {
    if (!a || !b) return false;
    const enc = new TextEncoder();
    const [da, db] = await Promise.all([
        crypto.subtle.digest('SHA-256', enc.encode(a)),
        crypto.subtle.digest('SHA-256', enc.encode(b)),
    ]);
    const ba = new Uint8Array(da);
    const bb = new Uint8Array(db);
    if (ba.length !== bb.length) return false;
    let result = 0;
    for (let i = 0; i < ba.length; i++) result |= ba[i] ^ bb[i];
    return result === 0;
}

// CORS only for MCP endpoint (AI assistants need it) -- not for plugin endpoints (H-6).
// FIX-23-04-01: erweitert um GET (Streamable-HTTP SSE-Subscribe) und DELETE
// (Session-Termination), plus Mcp-Session-Id im Allow-Headers damit
// Spec-strikte Clients wie Perplexity nicht im Preflight haengen bleiben.
const MCP_CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

// FIX-23-04-14: H-6 requires plugin endpoints (/poll, /respond) to stay
// CORS-free, including error envelopes and HEAD responses.
function isPluginPath(pathname) {
    return pathname === '/poll' || pathname === '/respond';
}

// FIX-23-04-12: shared JSON-RPC error envelope for internal failures.
function relayInternalError(extraHeaders) {
    return new Response(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32603, message: 'Relay internal error' },
    }), {
        status: 500,
        headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    });
}

export default {
    async fetch(request, env) {
        // FIX-23-04-12: no exception may escape the handler -- Cloudflare
        // renders escaped exceptions as an 1101 HTML page, which strict MCP
        // clients (Perplexity) report as FETCHER_HTML_STATUS_CODE_ERROR.
        try {
            return await handleWorkerFetch(request, env);
        } catch (e) {
            // FIX-23-04-14: keep the H-6 invariant on the failure path --
            // plugin endpoints never carry CORS headers.
            let pluginPath = false;
            try { pluginPath = isPluginPath(new URL(request.url).pathname); } catch { /* keep false */ }
            return relayInternalError(pluginPath ? {} : MCP_CORS_HEADERS);
        }
    },
};

async function handleWorkerFetch(request, env) {
        const mcpCorsHeaders = MCP_CORS_HEADERS;

        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: mcpCorsHeaders });
        }

        // FIX-23-04-12: HEAD probes (client preflights) get a clean
        // 200 with no body instead of a 405. FIX-23-04-14: CORS headers
        // only off plugin paths (H-6).
        if (request.method === 'HEAD') {
            return new Response(null, {
                status: 200,
                headers: isPluginPath(url.pathname) ? {} : mcpCorsHeaders,
            });
        }

        // FIX-23-04-12: OAuth discovery probes (/.well-known/oauth-*) got a
        // 401 before, so OAuth-probing clients hung on auth they can never
        // complete. A clean JSON 404 makes them fail fast: this relay only
        // supports Auth: None with the tokenized URL.
        if (url.pathname.startsWith('/.well-known/')) {
            return new Response(JSON.stringify({
                error: 'not_found',
                message: 'This relay does not support OAuth. Configure the client with Auth: None and the tokenized MCP URL.',
            }), { status: 404, headers: Object.assign({ 'Content-Type': 'application/json' }, mcpCorsHeaders) });
        }

        if (url.pathname === '/health') {
            // FIX-23-04-11: expose plugin liveness (age of the last /poll)
            // so users can tell 'relay up, plugin gone' from a client
            // incompatibility without guessing.
            // FIX-23-04-14: the DO liveness probe requires the relay token
            // (Bearer header, or ?token= for browser diagnosis since a
            // browser cannot set headers). Anonymous callers get the static
            // status only -- an unauthenticated hit must not burn DO
            // request quota or open DO requests.
            const healthBearer = (request.headers.get('Authorization') || '').replace('Bearer ', '');
            const healthQueryToken = url.searchParams.get('token') || '';
            const healthAuthed = (await safeTokenCompare(healthBearer, env.RELAY_TOKEN))
                || (await safeTokenCompare(healthQueryToken, env.RELAY_TOKEN));
            if (!healthAuthed) {
                return new Response(JSON.stringify({ status: 'ok', relay: 'obsilo' }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            let plugin = { connected: false, lastPollAgeMs: null };
            try {
                const id = env.RELAY_DO.idFromName('default');
                const relay = env.RELAY_DO.get(id);
                const resp = await relay.fetch(new Request(url.origin + '/health', { method: 'GET' }));
                const data = await resp.json();
                plugin = {
                    connected: data.pluginConnected === true,
                    lastPollAgeMs: typeof data.lastPollAgeMs === 'number' ? data.lastPollAgeMs : null,
                };
            } catch (e) { /* DO unavailable -> report disconnected */ }
            return new Response(JSON.stringify({ status: 'ok', relay: 'obsilo', plugin, workerVersion: WORKER_VERSION }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Plugin endpoints: auth via Authorization Bearer header (H-4)
        if (url.pathname === '/poll' || url.pathname === '/respond') {
            const bearer = (request.headers.get('Authorization') || '').replace('Bearer ', '');
            const valid = await safeTokenCompare(bearer, env.RELAY_TOKEN);
            if (!valid) {
                return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                    status: 401, headers: { 'Content-Type': 'application/json' },
                });
            }
            const id = env.RELAY_DO.idFromName('default');
            const relay = env.RELAY_DO.get(id);
            const resp = await relay.fetch(request);
            return new Response(resp.body, resp);
        }

        // MCP endpoint: auth via URL path (/{token}/mcp) or Bearer header
        let authenticated = false;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length === 2 && parts[1] === 'mcp') {
            authenticated = await safeTokenCompare(parts[0], env.RELAY_TOKEN);
        }
        if (!authenticated) {
            const bearer = (request.headers.get('Authorization') || '').replace('Bearer ', '');
            if (bearer) {
                authenticated = await safeTokenCompare(bearer, env.RELAY_TOKEN);
            }
        }
        if (!authenticated) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401, headers: { 'Content-Type': 'application/json', ...mcpCorsHeaders },
            });
        }

        // FIX-23-04-01: Streamable-HTTP-Spec-Methoden vor dem
        // POST-Forward abfangen, damit jede Antwort einen korrekten
        // Content-Type-Header traegt. Perplexity (und neuere
        // Streamable-HTTP-Clients) erwarten das streng -- ohne
        // Content-Type werfen sie "Unexpected content type:" (leer).
        if (request.method === 'GET') {
            // Optional SSE-Subscribe-Endpunkt. Wir halten heute keinen
            // server-initiated Stream, antworten aber Spec-konform mit
            // einer leeren text/event-stream-Response statt 405 plain.
            // Client kann nichts streamen, aber der Connect-Handshake
            // bleibt sauber und der Client faellt auf den POST-Pfad zurueck.
            return new Response(': sse keep-alive\\n\\n', {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-store',
                    'Connection': 'keep-alive',
                    ...mcpCorsHeaders,
                },
            });
        }

        if (request.method === 'DELETE') {
            // Spec: DELETE auf MCP-Endpunkt terminiert Session.
            // Wir halten keine persistenten Sessions auf Worker-Ebene
            // (state liegt im DO + Plugin), daher Acknowledge mit 204.
            return new Response(null, {
                status: 204,
                headers: mcpCorsHeaders,
            });
        }

        if (request.method !== 'POST') {
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32601, message: 'Method not allowed: ' + request.method },
            }), {
                status: 405,
                headers: { 'Content-Type': 'application/json', 'Allow': 'POST, GET, DELETE, OPTIONS', ...mcpCorsHeaders },
            });
        }

        // FIX-23-04-01 Pass 3: Body MUSS vor DO-fetch geparst werden,
        // sonst hat der DO den Stream konsumiert und unser clone() ist
        // leer. Wir parsen einmal, leiten den Body als String an die
        // DO weiter und nutzen das parsed Object fuer Method-Detection.
        const acceptHeader = (request.headers.get('Accept') || '').toLowerCase();
        const wantsSSE = acceptHeader.includes('text/event-stream');
        const wantsJSON = acceptHeader.includes('application/json') || acceptHeader.includes('*/*');
        const sseOnly = wantsSSE && !wantsJSON;

        let bodyText = '';
        let isInitialize = false;
        try {
            bodyText = await request.text();
            const parsed = JSON.parse(bodyText);
            isInitialize = parsed?.method === 'initialize';
        } catch { /* not JSON or no body */ }

        // Forward to DO with the already-read body (rebuild request).
        const id = env.RELAY_DO.idFromName('default');
        const relay = env.RELAY_DO.get(id);
        const forwardReq = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: bodyText.length > 0 ? bodyText : undefined,
        });
        const resp = await relay.fetch(forwardReq);

        // Read the upstream response body.
        const upstreamBody = await resp.text();

        const finalHeaders = new Headers();
        for (const [k, v] of Object.entries(mcpCorsHeaders)) finalHeaders.set(k, v);

        // Content-Type-Handling: passthrough was upstream lieferte.
        // FIX-23-04-01 Pass 5: kein Default-CT mehr aufzwingen --
        // Notifications kommen jetzt mit 202 + leerem Body + kein CT
        // (Spec-konform "no body to parse"); 200/JSON-Responses tragen
        // den CT bereits selbst. Default 'application/json' nur dann,
        // wenn der Status weder 202 noch 204 ist UND ein nicht-leerer
        // Body vorhanden ist (defensiv).
        const upstreamCT = resp.headers.get('content-type');
        if (upstreamCT) {
            finalHeaders.set('Content-Type', upstreamCT);
        } else if (resp.status !== 202 && resp.status !== 204 && upstreamBody.length > 0) {
            finalHeaders.set('Content-Type', 'application/json');
        }

        // Set Mcp-Session-Id on initialize response.
        if (isInitialize) {
            finalHeaders.set('Mcp-Session-Id', crypto.randomUUID());
        }

        if (sseOnly && upstreamBody && upstreamBody.trim().startsWith('{')) {
            // Wrap JSON-RPC body as a single SSE event.
            finalHeaders.set('Content-Type', 'text/event-stream');
            finalHeaders.set('Cache-Control', 'no-store');
            const sseFrame = \`data: \${upstreamBody.trim()}\\n\\n\`;
            return new Response(sseFrame, { status: resp.status, headers: finalHeaders });
        }

        return new Response(upstreamBody.length > 0 ? upstreamBody : null, {
            status: resp.status,
            headers: finalHeaders,
        });
}

const MAX_QUEUE = 100;     // H-5: max pending requests in queue
const MAX_PENDING = 50;    // H-5: max concurrent pending responses
const MAX_BODY = 1048576;  // M-5: 1 MB max request body

export class RelayDO {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.pending = new Map();
        this.requestQueue = [];
        // FIX-23-04-11: liveness via lastPollAt instead of the old sticky
        // pluginConnected latch, which was set on the first /poll and never
        // reset -- an absent plugin parked every POST for the full 30s.
        this.lastPollAt = 0;
        this.pollWaiter = null;
    }

    isPluginAlive() {
        return this.lastPollAt > 0 && (Date.now() - this.lastPollAt) <= PLUGIN_STALE_MS;
    }

    async fetch(request) {
        // FIX-23-04-12: same guard as the worker fetch handler -- an
        // unhandled DO exception (e.g. invalid JSON on /respond) must
        // surface as a JSON-RPC envelope, not a Cloudflare 1101 HTML page.
        try {
            return await this.handle(request);
        } catch (e) {
            return relayInternalError();
        }
    }

    async handle(request) {
        const url = new URL(request.url);

        // FIX-23-04-11: internal liveness probe for the worker /health handler.
        if (url.pathname === '/health') {
            return new Response(JSON.stringify({
                pluginConnected: this.isPluginAlive(),
                lastPollAgeMs: this.lastPollAt > 0 ? Date.now() - this.lastPollAt : null,
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        // Plugin long-polls for pending MCP requests.
        // FIX-23-04-11: park the poll until a request arrives or
        // POLL_PARK_MS elapses, so a POSTed initialize reaches the plugin
        // immediately instead of waiting out a poll interval.
        if (url.pathname === '/poll') {
            this.lastPollAt = Date.now();
            if (this.requestQueue.length > 0) {
                const requests = this.requestQueue.splice(0);
                return new Response(JSON.stringify({ requests, workerVersion: WORKER_VERSION }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (this.pollWaiter) {
                // Supersede: the plugin runs exactly one poll loop, so a new
                // poll releases a stale parked one with an empty batch.
                // FIX-23-04-14: with two devices on the same token the polls
                // evict each other; no requests are lost, but the evicted
                // device degrades to the 10s legacy spacing (fast-empty
                // response). Documented in the FIX-23-04-14 spec.
                const prev = this.pollWaiter;
                this.pollWaiter = null;
                prev.deliver([]);
            }
            const requests = await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    this.pollWaiter = null;
                    resolve([]);
                }, POLL_PARK_MS);
                this.pollWaiter = {
                    deliver: (reqs) => { clearTimeout(timeout); resolve(reqs); },
                };
            });
            this.lastPollAt = Date.now();
            return new Response(JSON.stringify({ requests, workerVersion: WORKER_VERSION }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Plugin sends response to an MCP request
        if (url.pathname === '/respond' && request.method === 'POST') {
            const body = await request.json();
            const id = String(body.id ?? '');
            const pending = this.pending.get(id);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pending.delete(id);
                pending.resolve(JSON.stringify(body));
            }
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // MCP request from AI assistant (POST)
        if (request.method === 'POST') {
            // FIX-23-04-11: fail fast when the plugin never polled (fresh
            // or evicted DO) OR when its last poll is stale, instead of
            // parking the client for the full 30s pending timeout.
            if (!this.isPluginAlive()) {
                return new Response(JSON.stringify({
                    jsonrpc: '2.0', id: null,
                    error: { code: -32603, message: 'Vault Operator not connected. Make sure Obsidian is running with remote access enabled.' },
                }), { status: 502, headers: { 'Content-Type': 'application/json' } });
            }

            // M-5: Request size limit
            const contentLength = parseInt(request.headers.get('Content-Length') || '0');
            if (contentLength > MAX_BODY) {
                return new Response(JSON.stringify({ error: 'Request too large' }), {
                    status: 413, headers: { 'Content-Type': 'application/json' },
                });
            }

            // H-5: Queue overflow protection
            if (this.requestQueue.length >= MAX_QUEUE || this.pending.size >= MAX_PENDING) {
                return new Response(JSON.stringify({
                    jsonrpc: '2.0', id: null,
                    error: { code: -32603, message: 'Too many pending requests. Try again later.' },
                }), { status: 429, headers: { 'Content-Type': 'application/json' } });
            }

            const body = await request.text();
            if (body.length > MAX_BODY) {
                return new Response(JSON.stringify({ error: 'Request too large' }), {
                    status: 413, headers: { 'Content-Type': 'application/json' },
                });
            }

            let parsed;
            try { parsed = JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400 }); }

            // Notification (no id) -- fire and forget. FIX-23-04-01 Pass 5:
            // MCP Streamable HTTP Spec verlangt: "Server MUST respond with
            // HTTP status code 202 Accepted with no body". Pydantic von
            // Perplexity lehnt 'null' als Body ab, weil JSON-RPC schemas
            // einen Object erwarten. 202 + leer + kein Content-Type ist
            // spec-konform: Status 202 signalisiert "no body to parse".
            if (parsed.id === undefined || parsed.id === null) {
                this.enqueueForPlugin(body);
                return new Response(null, {
                    status: 202,
                    headers: { 'Content-Length': '0' },
                });
            }

            // M-7: Use random correlation ID instead of client-provided sequential ID
            const correlationId = crypto.randomUUID();
            const originalId = parsed.id;

            const responsePromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pending.delete(correlationId);
                    reject(new Error('Plugin response timeout (30s)'));
                }, 30000);
                this.pending.set(correlationId, { resolve, reject, timeout });
            });

            // Rewrite request with correlation ID for internal routing
            parsed.__correlationId = correlationId;
            this.enqueueForPlugin(JSON.stringify(parsed));

            try {
                const response = await responsePromise;
                // Restore original JSON-RPC ID in the response
                const respParsed = JSON.parse(response);
                respParsed.id = originalId;
                return new Response(JSON.stringify(respParsed), {
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (e) {
                return new Response(JSON.stringify({
                    jsonrpc: '2.0', id: originalId,
                    error: { code: -32603, message: 'Request timeout' },
                }), { status: 504, headers: { 'Content-Type': 'application/json' } });
            }
        }

        // FIX-23-04-01: Spec-strikte Clients erwarten Content-Type
        // auf jeder Antwort. Kein plain-text 405 mehr.
        return new Response(JSON.stringify({
            jsonrpc: '2.0', id: null,
            error: { code: -32601, message: 'Method not allowed: ' + request.method },
        }), {
            status: 405,
            headers: { 'Content-Type': 'application/json', 'Allow': 'POST' },
        });
    }

    enqueueForPlugin(body) {
        this.requestQueue.push(body);
        // FIX-23-04-11: wake a parked poll immediately with the whole batch.
        if (this.pollWaiter) {
            const waiter = this.pollWaiter;
            this.pollWaiter = null;
            waiter.deliver(this.requestQueue.splice(0));
        }
    }
}
`;

/** Metadata for the Cloudflare Worker upload (Durable Object bindings + migrations). */
export const RELAY_WORKER_METADATA = {
    main_module: 'worker.js',
    bindings: [
        { type: 'durable_object_namespace', name: 'RELAY_DO', class_name: 'RelayDO' },
    ],
    compatibility_date: '2024-09-01',
    migrations: {
        tag: 'v1',
        new_sqlite_classes: ['RelayDO'],
    },
};
