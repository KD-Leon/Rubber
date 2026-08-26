/**
 * RelayClient -- HTTP long-polling client connecting to the remote Vault Operator Relay.
 *
 * Uses Obsidian's requestUrl (not WebSocket) to communicate with the relay.
 * This works within Obsidian's renderer CSP which blocks WebSocket to external servers.
 *
 * Flow:
 * 1. Poll POST /poll with Authorization: Bearer header
 * 2. Receive pending MCP requests from AI assistants
 * 3. Process each request via handleToolCall()
 * 4. Send results back via POST /respond with Authorization: Bearer header
 * 5. Repeat
 *
 * Security (AUDIT-005):
 * - Token sent via Authorization header, never in URL (H-4)
 * - No token material in logs (H-2, H-3)
 * - Runtime validation of relay responses (M-1)
 * - URL validation: HTTPS enforced (M-3)
 * - Error messages sanitized before sending to relay (L-1)
 *
 * ADR-055: Remote MCP Relay
 * FEATURE-1403: Remote Transport
 */

import { Notice, requestUrl } from 'obsidian';
import type ObsidianAgentPlugin from '../main';
import { handleToolCall } from './tools/index';

// FIX-14-03-01: 10s default. Workers Free Plan has 100k requests/day per
// account. At 2s the plugin alone burns 43.200/day per open Obsidian instance,
// independent of actual MCP usage. 10s drops that to ~8.640/day, leaving
// headroom for external clients and multi-device setups.
// FIX-23-04-11: only used as the fallback spacing against legacy (not yet
// redeployed) workers that still answer /poll immediately. Redeployed
// workers long-poll (~20s park), so the client re-polls without delay:
// idle traffic is then <= 180 polls/hour (4320/day), half of the old rate.
const POLL_INTERVAL_MS = 10_000;

// FIX-23-04-11: a /poll response that took at least this long means the
// worker parked it (true long-poll). Anything faster with an empty batch
// is a legacy worker answering immediately; re-polling instantly against
// one of those would burn the Cloudflare free-plan quota.
const LONG_POLL_MIN_ELAPSED_MS = 5_000;

/**
 * FIX-23-04-11: decide how long to wait before the next /poll.
 * - Requests delivered: re-poll immediately, more may be queued.
 * - Long-poll response (server parked >= LONG_POLL_MIN_ELAPSED_MS):
 *   re-poll immediately, the server paces us.
 * - Fast empty response (legacy worker): fall back to the FIX-14-03-01
 *   short-poll spacing.
 */
export function computePollDelayMs(elapsedMs: number, requestCount: number): number {
    if (requestCount > 0) return 0;
    if (elapsedMs >= LONG_POLL_MIN_ELAPSED_MS) return 0;
    return POLL_INTERVAL_MS;
}

/**
 * IMP-14-03-01: whether the relay worker live on the user's account differs
 * from the one bundled in this plugin. A worker deployed before the version
 * field existed sends nothing, which counts as outdated. Any mismatch (older,
 * or newer after a plugin downgrade) means "redeploy to match", so the check
 * is a plain inequality rather than an ordered comparison.
 */
export function isWorkerOutdated(seen: string | null | undefined, bundled: string): boolean {
    return (seen ?? '') !== bundled;
}
const INITIAL_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

// FIX-14-03-02: Diagnostic notice after this many consecutive poll failures.
// Plugin reload would reset the counter; the goal is to surface persistent
// outages (Worker quota, expired token, network) without spamming every retry.
const POLL_FAILURE_NOTICE_THRESHOLD = 3;
const ERROR_BODY_MAX_CHARS = 200;

/**
 * FIX-14-03-02: Build a one-line diagnostic from a thrown requestUrl error.
 * Obsidian's requestUrl rejects with `{ status, headers, text? }`-shaped
 * objects on non-2xx responses, but network failures throw plain Errors.
 * We extract status and a short body slice, then run the result through
 * redactToken() so AUDIT-005 H-2/H-3 (no token material in logs) holds.
 */
export function describeRequestError(err: unknown, token: string): string {
    const e = err as { status?: number; text?: string; message?: string; name?: string };
    const status = typeof e?.status === 'number' ? `HTTP ${e.status}` : null;
    const body = typeof e?.text === 'string' ? e.text : (e?.message ?? '');
    const trimmed = body.length > ERROR_BODY_MAX_CHARS
        ? `${body.slice(0, ERROR_BODY_MAX_CHARS)}...`
        : body;
    const sanitized = redactToken(trimmed.replace(/\s+/g, ' ').trim(), token);
    if (status && sanitized) return `${status}: ${sanitized}`;
    if (status) return status;
    if (sanitized) return sanitized;
    return e?.name ?? 'unknown error';
}

export function redactToken(text: string, token: string): string {
    if (!text) return text;
    let out = text;
    if (token && token.length > 0) {
        out = out.split(token).join('<redacted>');
    }
    // Generic Bearer header pattern, in case some other path leaked the token.
    return out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer <redacted>');
}

/**
 * FIX-23-09-03: shared JSON-RPC dispatch for the relay path.
 *
 * Routes the small set of MCP methods the relay needs to forward to the
 * Vault Operator backend. Extracted so RelayClient.handleRequest stays a
 * thin IO wrapper and the routing is unit-testable without spinning up
 * the polling loop. Unknown methods return an empty object, matching the
 * prior behaviour.
 */
export async function dispatchRelayMethod(
    plugin: ObsidianAgentPlugin,
    method: string,
    params: Record<string, unknown> | undefined,
): Promise<unknown> {
    const bridge = plugin.mcpBridge as unknown as {
        buildInitializeResponse?: (requested?: string) => unknown;
        getToolsWithContext?: () => unknown[];
        buildResourceList?: () => unknown[];
        listPrompts?: () => unknown;
        getPrompt?: (name: string | undefined) => unknown;
    } | undefined;

    if (method === 'initialize') {
        const requested = typeof (params as { protocolVersion?: unknown } | undefined)?.protocolVersion === 'string'
            ? (params as { protocolVersion: string }).protocolVersion
            : undefined;
        return bridge?.buildInitializeResponse?.(requested) ?? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {}, prompts: {}, resources: {} },
            serverInfo: { name: 'Vault Operator', version: '1.0.0' },
        };
    }
    if (method === 'tools/list') {
        return { tools: bridge?.getToolsWithContext?.() ?? [] };
    }
    if (method === 'tools/call') {
        const p = params as { name?: unknown; arguments?: Record<string, unknown> } | undefined;
        if (p && typeof p.name === 'string') {
            const toolResult = await handleToolCall(plugin, p.name, p.arguments ?? {});
            return { content: toolResult.content, isError: toolResult.isError };
        }
        return { content: [{ type: 'text', text: 'Missing tool name' }], isError: true };
    }
    if (method === 'resources/list') {
        return { resources: bridge?.buildResourceList?.() ?? [] };
    }
    if (method === 'prompts/list') {
        return bridge?.listPrompts?.() ?? {};
    }
    if (method === 'prompts/get') {
        if (!bridge?.getPrompt) return {};
        const rawName = (params as { name?: unknown } | undefined)?.name;
        const name = typeof rawName === 'string' ? rawName : undefined;
        return await bridge.getPrompt(name);
    }
    return {};
}

export class RelayClient {
    private polling = false;
    private _connected = false;
    private _connecting = false;
    private shouldReconnect = true;
    private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    private maxReconnectDelay = MAX_RECONNECT_DELAY_MS;
    private relayUrl = '';
    private token = '';
    private consecutivePollFailures = 0;
    private noticeShownForCurrentOutage = false;
    // FIX-23-04-14: incremented on every startPolling(). disconnect() cannot
    // abort an in-flight requestUrl, so a connect() during a parked poll
    // starts a second loop; the stale loop detects the generation mismatch
    // when its poll settles and exits without touching shared state.
    private pollGeneration = 0;
    // IMP-14-03-01: version reported by the worker on the most recent /poll,
    // or null until a poll has completed. The settings tab compares it against
    // the bundled RELAY_WORKER_VERSION to warn about a stale deployment.
    private _lastSeenWorkerVersion: string | null = null;

    constructor(private plugin: ObsidianAgentPlugin) {}

    get connected(): boolean { return this._connected; }
    get connecting(): boolean { return this._connecting; }
    get lastSeenWorkerVersion(): string | null { return this._lastSeenWorkerVersion; }

    connect(relayUrl: string, token: string): void {
        const cleanUrl = relayUrl.replace(/\/$/, '');

        // M-3: Validate relay URL
        if (!cleanUrl.startsWith('https://')) {
            console.error('[RelayClient] Relay URL must use HTTPS');
            return;
        }

        this.relayUrl = cleanUrl;
        this.token = token;
        this.shouldReconnect = true;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        this.startPolling();
    }

    disconnect(): void {
        this.shouldReconnect = false;
        this.polling = false;
        this._connected = false;
        this._connecting = false;
    }

    private startPolling(): void {
        if (this.polling) return;
        this.polling = true;
        this._connecting = true;
        this.pollGeneration += 1;
        void this.pollLoop(this.pollGeneration);
    }

    private async pollLoop(generation: number): Promise<void> {
        while (this.polling && this.shouldReconnect) {
            // FIX-23-04-14: a newer connect() owns the loop state now.
            if (generation !== this.pollGeneration) return;
            try {
                // FIX-23-04-11: measure how long the relay held the poll so
                // computePollDelayMs can tell long-poll from legacy workers.
                const pollStartedAt = Date.now();

                // Review 2026-07-14: pin the connection identity this poll
                // was issued under. connect() overwrites relayUrl/token
                // BEFORE bumping the generation, so at resolve time the
                // instance fields may already describe a different endpoint
                // or a rotated credential.
                const pollRelayUrl = this.relayUrl;
                const pollToken = this.token;

                // H-4: Token in Authorization header, not URL
                const response = await requestUrl({
                    url: `${pollRelayUrl}/poll`,
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${pollToken}` },
                });

                // M-1: Runtime validation of relay response.
                // Processed BEFORE the stale-generation exit: the Durable
                // Object already spliced this batch off its queue when it
                // answered the poll, so a superseded loop must still hand
                // the work to handleRequest (answering via /respond is
                // generation-independent; the DO keeps the pending entries
                // until the response arrives). Only the loop-continuation
                // decision below belongs to the generation guard.
                //
                // Review 2026-07-14: that handoff is only safe when the
                // reconnect kept the SAME relay + token (bridge restart,
                // FIX-44-C2). If either changed, this batch was delivered
                // under a superseded endpoint or a rotated (possibly
                // revoked) credential; executing it and answering the NEW
                // relay with the OLD relay's correlation id would be wrong
                // on both ends. Drop it instead (pre-FIX-44-C2 behaviour
                // for the cross-relay case).
                const data = response.json as { requests?: unknown[]; workerVersion?: unknown };
                // IMP-14-03-01: remember the worker's self-reported version so
                // the settings tab can flag a stale deployment. Legacy workers
                // send nothing, leaving this null.
                if (typeof data.workerVersion === 'string') {
                    this._lastSeenWorkerVersion = data.workerVersion;
                }
                let requestCount = 0;
                if (data.requests && Array.isArray(data.requests) && data.requests.length > 0) {
                    requestCount = data.requests.length;
                    const sameConnection =
                        pollRelayUrl === this.relayUrl && pollToken === this.token;
                    if (sameConnection) {
                        for (const reqBody of data.requests) {
                            if (typeof reqBody === 'string') {
                                void this.handleRequest(reqBody, pollRelayUrl, pollToken);
                            }
                        }
                    }
                }

                // FIX-23-04-14: stale loop (superseded by a reconnect while
                // this poll was parked at the relay) must exit here instead
                // of re-entering the loop next to the new one. It must not
                // touch the shared connection state either.
                if (generation !== this.pollGeneration) return;

                // First successful poll means we're connected
                if (!this._connected) {
                    this._connected = true;
                    this._connecting = false;
                    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
                    console.debug('[RelayClient] Connected to relay');
                }
                this.consecutivePollFailures = 0;
                this.noticeShownForCurrentOutage = false;

                // FIX-23-04-11: re-poll immediately after a long-poll response
                // or delivered work; only a fast empty response (legacy worker)
                // keeps the FIX-14-03-01 short-poll spacing.
                const delayMs = computePollDelayMs(Date.now() - pollStartedAt, requestCount);
                if (delayMs > 0) {
                    await new Promise(resolve => window.setTimeout(resolve, delayMs));
                }
            } catch (err) {
                // FIX-23-04-14: same guard on the failure path -- a stale
                // loop's rejected poll must not clobber the new loop's
                // connection state or failure counters.
                if (generation !== this.pollGeneration) return;
                if (!this.shouldReconnect) break;

                this._connected = false;
                this._connecting = true;
                this.consecutivePollFailures += 1;

                // FIX-14-03-02: Log status + sanitized body so an outage is
                // diagnosable without devtools. H-2 / H-3 (AUDIT-005) still
                // require zero token material in logs, so the message is
                // run through redactToken() before printing.
                const detail = describeRequestError(err, this.token);
                console.warn(
                    `[RelayClient] Poll failed (${detail}), retrying in ${this.reconnectDelay} ms`,
                );

                if (
                    this.consecutivePollFailures >= POLL_FAILURE_NOTICE_THRESHOLD &&
                    !this.noticeShownForCurrentOutage
                ) {
                    new Notice(
                        `Vault Operator MCP relay nicht erreichbar (${detail}). Details in der Konsole.`,
                        8000,
                    );
                    this.noticeShownForCurrentOutage = true;
                }

                await new Promise(resolve => window.setTimeout(resolve, this.reconnectDelay));
                this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
            }
        }

        // FIX-23-04-14: only the loop that still owns the current generation
        // may reset the shared state on exit.
        if (generation !== this.pollGeneration) return;
        this.polling = false;
        this._connected = false;
        this._connecting = false;
    }

    /**
     * Review 2026-07-14: relayUrl/token are passed in from the poll that
     * delivered the batch instead of read from the instance fields, so the
     * response always goes back to the relay (and under the credential) the
     * request actually came from, even when a reconnect swaps the fields
     * mid-dispatch.
     */
    private async handleRequest(reqBody: string, relayUrl: string, token: string): Promise<void> {
        try {
            const request = JSON.parse(reqBody) as {
                jsonrpc?: string;
                method?: string;
                id?: number | string;
                params?: Record<string, unknown>;
                __correlationId?: string;
            };

            // M-1: Validate required fields
            if (typeof request.method !== 'string') return;

            // Notification (no id) -- process but don't respond
            if (request.id === undefined || request.id === null) {
                return;
            }

            // M-7: Use correlation ID for internal routing, keep original ID for response
            const correlationId = request.__correlationId ?? String(request.id);

            const result: unknown = await dispatchRelayMethod(
                this.plugin,
                request.method,
                request.params,
            );

            // Send response back to relay using correlation ID
            const responseBody = { jsonrpc: '2.0', id: correlationId, result };
            await requestUrl({
                url: `${relayUrl}/respond`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(responseBody),
            });
        } catch {
            // L-1: Sanitize error messages -- don't leak internal details
            console.warn('[RelayClient] Error handling request');
            try {
                const parsed = JSON.parse(reqBody) as { id?: unknown; __correlationId?: string };
                if (parsed.id !== undefined && parsed.id !== null) {
                    const rawId = parsed.__correlationId ?? parsed.id;
                    const correlationId = typeof rawId === 'string' ? rawId : JSON.stringify(rawId ?? '');
                    await requestUrl({
                        url: `${relayUrl}/respond`,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id: correlationId,
                            error: { code: -32603, message: 'Tool execution failed' },
                        }),
                    });
                }
            } catch { /* give up */ }
        }
    }
}
