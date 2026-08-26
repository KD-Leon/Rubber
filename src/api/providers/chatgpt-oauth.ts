/**
 * ChatGptOAuthProvider -- LLM provider for ChatGPT OAuth (Subscription) backend.
 *
 * Talks to https://chatgpt.com/backend-api/codex/responses, which is the
 * Responses API endpoint that codex-cli uses. We do NOT route via the OpenAI
 * SDK because the SDK posts to /chat/completions, which the Codex backend
 * does not expose.
 *
 * Schema as observed 2026-04-28 against codex-rs/core/src/client.rs.
 *
 * @see ADR-088 (Provider Architecture)
 * @see FEATURE-021-002 (Codex Responses-API Handler)
 */

import OpenAI from 'openai';
import { requestUrl } from 'obsidian';
import type { LLMProvider } from '../../types/settings';
import type { ApiHandler, ApiStream, ApiStreamChunk, MessageParam, ModelInfo } from '../types';
import { truncatedToolInputError } from '../types';
import type { ToolDefinition } from '../../core/tools/types';
import { ChatGptOAuthService } from '../../core/auth/ChatGptOAuthService';
import { prepareResponsesRequest, resolveGptEffort, isGpt5Family, type ResponsesRequestBody } from '../adapters/openaiResponses';
import { getModelInfo } from '../../types/model-registry';

void OpenAI; // retained: Errors instance kept for compatibility but not actively used

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';

/**
 * First-party originator + user-agent. The Codex backend rejects everything
 * outside this allowlist with 403 + "no active subscription" regardless of
 * the user's actual plan. Verified against pi-mono#1828 and codex-rs.
 *
 * The version in the User-Agent is load-bearing: the Codex backend gates the
 * available model set on the reported client version (the /codex/models
 * response is keyed by client_version). A stale version is served the old,
 * now-removed model set, so EVERY current model (gpt-5.5, gpt-5.6, ...) comes
 * back "not supported when using Codex with a ChatGPT account". Keep this at a
 * current codex-cli release.
 *
 * FIX-55-03 (issue #55): 0.140.0 -> 0.144.3, verified 2026-07-13 against
 * https://registry.npmjs.org/@openai/codex/latest ("version" field). Exported
 * so the pin is test-guarded (chatgptOAuthModelFetch.test.ts).
 */
export const CODEX_CLIENT_VERSION = '0.144.3';
const CODEX_HEADERS: Record<string, string> = {
    'OpenAI-Beta': 'responses=experimental',
    'Originator': 'codex_cli_rs',
    'User-Agent': `codex_cli_rs/${CODEX_CLIENT_VERSION} (Obsidian Plugin) Vault Operator`,
    'Accept': 'text/event-stream',
};

/**
 * Static FALLBACK lineup of Codex models for the ChatGPT OAuth backend, used
 * when the live `/codex/models` fetch (fetchChatGptOAuthModels) is unavailable
 * (offline, not signed in). The authoritative source is the live endpoint:
 * the available set is account- and version-specific and rotates as OpenAI
 * ships new frontier models and retires old ones. This list is the current
 * known lineup (2026-07, FIX-55-03: gpt-5.6 added, reporter-confirmed in
 * issue #55 against a live Codex account; the gpt-5.6-sol/-terra/-luna ids on
 * developers.openai.com are PLATFORM API ids, not Codex slugs, and are
 * deliberately not listed). Older ids (gpt-5, gpt-5.1, gpt-5.2, the -codex
 * variants) were retired by the backend and now 400 as "not supported".
 *
 * @see ADR-088
 */
const KNOWN_MODELS: Record<string, ModelInfo> = {
    'gpt-5.6':       { contextWindow: 272_000, supportsTools: true, supportsStreaming: true },
    'gpt-5.5':       { contextWindow: 272_000, supportsTools: true, supportsStreaming: true },
    'gpt-5.4':       { contextWindow: 272_000, supportsTools: true, supportsStreaming: true },
    'gpt-5.4-mini':  { contextWindow: 272_000, supportsTools: true, supportsStreaming: true },
};

/**
 * Models we used to expose but the ChatGPT subscription backend rejects.
 * Used by the error path to spot stale picks from older settings and tell
 * the user to refresh the model list.
 */
const KNOWN_UNSUPPORTED_ON_CHATGPT_ACCOUNT: ReadonlySet<string> = new Set([
    'gpt-5-codex-mini',
    'gpt-5.1-codex-mini',
]);

/** Test-Connection fallback when no tier mapping / discovered list exists yet. */
export const CHATGPT_OAUTH_DEFAULT_TEST_MODEL = 'gpt-5.5';

/** The static fallback list, used when the live fetch cannot run. */
export function listKnownChatGptOAuthModels(): { id: string; label: string }[] {
    return Object.keys(KNOWN_MODELS).map((id) => ({ id, label: id }));
}

/** One entry of the Codex `/codex/models` response. */
interface CodexModelEntry {
    slug?: string;
    display_name?: string;
    visibility?: string;
}

/**
 * Parse the Codex `/codex/models` JSON body into the id/label pairs the model
 * picker expects. Hidden models are dropped; everything visible is offered.
 * Pure (no I/O) so it can be unit-tested against recorded payloads.
 */
export function parseCodexModelsResponse(body: unknown): { id: string; label: string }[] {
    const models = (body as { models?: unknown })?.models;
    if (!Array.isArray(models)) return [];
    const out: { id: string; label: string }[] = [];
    for (const raw of models as CodexModelEntry[]) {
        const slug = typeof raw?.slug === 'string' ? raw.slug : '';
        if (!slug || raw.visibility === 'hidden') continue;
        out.push({ id: slug, label: typeof raw.display_name === 'string' ? raw.display_name : slug });
    }
    return out;
}

/**
 * FIX-55-03 (issue #55): outcome of the most recent fetchChatGptOAuthModels
 * call. Previously any failure was swallowed by a bare catch and silently
 * replaced by the static lineup; combined with the 24h discovery cache the
 * user saw a stale 3-model list with no signal. The provider-settings
 * Refresh flow reads this to surface an i18n Notice when the static
 * fallback was used.
 */
export interface ChatGptOAuthModelFetchStatus {
    source: 'live' | 'fallback';
    reason?: 'no-token' | 'http-error' | 'empty-list' | 'exception';
    at: number;
}

let lastModelFetchStatus: ChatGptOAuthModelFetchStatus = {
    source: 'fallback',
    reason: 'no-token',
    at: 0,
};

/** Status of the most recent live model-discovery attempt (FIX-55-03). */
export function getLastChatGptOAuthModelFetch(): ChatGptOAuthModelFetchStatus {
    return lastModelFetchStatus;
}

function markModelFetch(
    source: ChatGptOAuthModelFetchStatus['source'],
    reason?: ChatGptOAuthModelFetchStatus['reason'],
): void {
    lastModelFetchStatus = { source, reason, at: Date.now() };
}

/**
 * Model lineup plus its provenance (review finding AL1, 2026-07-14).
 * `source` travels IN-BAND with the models so the discovery service can
 * decide whether to persist the result without racing on the
 * getLastChatGptOAuthModelFetch side channel (which stays for the
 * provider-modal Notice, FIX-55-03).
 */
export interface ChatGptOAuthModelLineup {
    models: { id: string; label: string }[];
    source: 'live' | 'fallback';
}

/**
 * Discover the models the signed-in ChatGPT account can actually use, from
 * the live Codex `/codex/models` endpoint (the same source the official Codex
 * client caches). Falls back to the static KNOWN_MODELS lineup on any failure
 * so the picker is never empty. The endpoint is account- and version-specific,
 * so this is the authoritative list, not the hardcoded one. Every fallback is
 * recorded via getLastChatGptOAuthModelFetch and logged (FIX-55-03); the
 * returned lineup additionally carries the provenance in-band (AL1) so the
 * discovery cache never persists a fallback over a live lineup.
 */
export async function fetchChatGptOAuthModelLineup(): Promise<ChatGptOAuthModelLineup> {
    try {
        const auth = ChatGptOAuthService.getInstance();
        const token = await auth.getValidAccessToken();
        if (!token) {
            markModelFetch('fallback', 'no-token');
            return { models: listKnownChatGptOAuthModels(), source: 'fallback' };
        }
        const accountId = auth.getAccountId();
        const headers: Record<string, string> = {
            'OpenAI-Beta': CODEX_HEADERS['OpenAI-Beta'],
            'Originator': CODEX_HEADERS['Originator'],
            'User-Agent': CODEX_HEADERS['User-Agent'],
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
        };
        if (accountId) {
            headers['chatgpt-account-id'] = accountId;
            headers['ChatGPT-Account-ID'] = accountId;
        }
        const res = await requestUrl({ url: CODEX_MODELS_URL, method: 'GET', headers, throw: false });
        if (res.status === 200) {
            const list = parseCodexModelsResponse(res.json);
            if (list.length > 0) {
                markModelFetch('live');
                return { models: list, source: 'live' };
            }
            markModelFetch('fallback', 'empty-list');
            console.debug('[chatgpt-oauth] /codex/models returned HTTP 200 but no parseable models; using the static fallback lineup');
        } else {
            markModelFetch('fallback', 'http-error');
            console.debug(`[chatgpt-oauth] /codex/models returned HTTP ${res.status}; using the static fallback lineup`);
        }
    } catch (e) {
        markModelFetch('fallback', 'exception');
        console.debug('[chatgpt-oauth] live model discovery failed; using the static fallback lineup:', e instanceof Error ? e.message : String(e));
    }
    return { models: listKnownChatGptOAuthModels(), source: 'fallback' };
}

/** Models-only convenience wrapper around fetchChatGptOAuthModelLineup. */
export async function fetchChatGptOAuthModels(): Promise<{ id: string; label: string }[]> {
    return (await fetchChatGptOAuthModelLineup()).models;
}

const DEFAULT_MODEL_INFO: ModelInfo = {
    contextWindow: 400_000,
    supportsTools: true,
    supportsStreaming: true,
};

// ---------------------------------------------------------------------------
// Responses API types (observed 2026-04-28)
// ---------------------------------------------------------------------------

// IMP-41-03-03 / ADR-150: Responses-API types, conversion and request
// construction live in ../adapters/openaiResponses.

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ChatGptOAuthProvider implements ApiHandler {
    private config: LLMProvider;
    private auth: ChatGptOAuthService;

    constructor(config: LLMProvider) {
        this.config = config;
        this.auth = ChatGptOAuthService.getInstance();
    }

    getModel(): { id: string; info: ModelInfo } {
        // Registry first for the context window (covers any GPT id it knows and
        // future Claude routing); KNOWN_MODELS stays as the override for the
        // GPT-5.x Codex ids the registry does not carry, then the 400k default
        // for unknown ids. The table also supplies the tools/streaming flags.
        const known = KNOWN_MODELS[this.config.model] ?? DEFAULT_MODEL_INFO;
        // ADR-158 stage 1: discovery-reported window wins over registry and table
        const contextWindow = this.config.contextWindow
            ?? getModelInfo(this.config.model)?.contextWindow ?? known.contextWindow;
        return { id: this.config.model, info: { ...known, contextWindow } };
    }

    async *createMessage(
        systemPrompt: string,
        messages: MessageParam[],
        tools: ToolDefinition[],
        abortSignal?: AbortSignal,
    ): ApiStream {
        const body = prepareResponsesRequest(this.config, systemPrompt, messages, tools);

        let response = await this.streamRequest(body, abortSignal);
        if (response.status === 401) {
            this.auth.invalidateAccessToken();
            response = await this.streamRequest(body, abortSignal);
        }
        if (response.status >= 400) {
            const detail = await readBody(response);
            throw this.enhanceError(response.status, detail);
        }

        yield* parseSseEvents(response, abortSignal);
    }

    async classifyText(prompt: string, abortSignal?: AbortSignal): Promise<string> {
        const body: ResponsesRequestBody = {
            model: this.config.model,
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
            stream: true,
            store: false,
        };
        if (isGpt5Family(this.config.model)) {
            // Same low-floor default as createMessage; an explicit user effort
            // overrides it. (This is a tiny classification call, so the effort
            // rarely matters, but the surface stays consistent.)
            body.reasoning = { effort: resolveGptEffort(this.config.reasoningEffort), summary: 'auto' };
        }
        const response = await this.streamRequest(body, abortSignal);
        if (response.status >= 400) {
            const detail = await readBody(response);
            throw this.enhanceError(response.status, detail);
        }
        const buffer: string[] = [];
        for await (const chunk of parseSseEvents(response, abortSignal)) {
            if (chunk.type === 'text') buffer.push(chunk.text);
        }
        return buffer.join('').trim();
    }

    // -----------------------------------------------------------------------
    // HTTP layer (Node https module to bypass Electron's CORS on chatgpt.com)
    // -----------------------------------------------------------------------

    private async streamRequest(body: ResponsesRequestBody, signal?: AbortSignal): Promise<NodeStreamResponse> {
        const token = await this.auth.getValidAccessToken();
        const accountId = this.auth.getAccountId();
        const headers: Record<string, string> = {
            ...CODEX_HEADERS,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        };
        if (accountId) {
            headers['chatgpt-account-id'] = accountId;
            headers['ChatGPT-Account-ID'] = accountId;
        }

        return openStream(CODEX_RESPONSES_URL, JSON.stringify(body), headers, signal);
    }

    // -----------------------------------------------------------------------
    // Format conversion
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Error mapping
    // -----------------------------------------------------------------------

    private enhanceError(status: number, detail: string): Error {
        const trimmed = detail.length > 400 ? detail.slice(0, 400) + '...' : detail;
        if (status === 400) {
            const serverMsg = extractServerDetail(detail);
            // The Codex backend returns this exact wording when the model is not
            // available on a ChatGPT subscription (only on the API-key tier).
            if (/not supported when using Codex with a ChatGPT account/i.test(serverMsg ?? '')) {
                const supported = Object.keys(KNOWN_MODELS).join(', ');
                // Any id outside KNOWN_MODELS is a stale pick from older settings
                // (e.g. the dead gpt-5.5 default or a `-mini` variant). Steer the
                // user back to a supported model instead of leaving them stuck.
                const isStalePick = KNOWN_UNSUPPORTED_ON_CHATGPT_ACCOUNT.has(this.config.model)
                    || !Object.prototype.hasOwnProperty.call(KNOWN_MODELS, this.config.model);
                const hint = isStalePick
                    ? ' This model is not on the supported list -- click "Fetch" in Provider settings to refresh, then pick a supported model for the affected tier.'
                    : '';
                // Surface whether the account-id header was attached and the
                // raw backend wording. If even a supported base model is
                // rejected WITH an account id present, the account itself has
                // no Codex entitlement (a plan-level limitation, not a plugin
                // bug). Without an account id, the rejection may instead be the
                // missing header -- re-authenticate.
                const hasAccountId = !!this.auth.getAccountId();
                const accountNote = hasAccountId
                    ? ' A chatgpt-account-id was sent, so if a supported base model is still rejected your ChatGPT plan likely has no Codex access.'
                    : ' No chatgpt-account-id was sent for this request, which can itself trigger this rejection -- sign out and sign in again in Provider settings.';
                const serverNote = serverMsg ? ` Backend said: "${serverMsg}".` : '';
                return new Error(
                    `ChatGPT subscription does not support model "${this.config.model}" on the Codex backend.${hint}${accountNote}${serverNote} Supported: ${supported}.`,
                );
            }
            return new Error(`ChatGPT request rejected (400). ${serverMsg ?? trimmed}`);
        }
        switch (status) {
            case 401:
                return new Error('ChatGPT authentication failed. Please sign in again in Provider settings.');
            case 403:
                return new Error(`ChatGPT subscription check failed (403). The Codex backend rejected the request. Detail: ${trimmed}`);
            case 404:
                return new Error(`ChatGPT endpoint not found (404). The model "${this.config.model}" may not be available on your plan, or the backend path changed. Detail: ${trimmed}`);
            case 429:
                return new Error('ChatGPT rate limit reached. Please wait a moment and retry.');
            default:
                return new Error(`ChatGPT API error (${status}): ${trimmed}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Node https streaming helpers
// ---------------------------------------------------------------------------

interface NodeStreamResponse {
    status: number;
    headers: Record<string, string>;
    stream: AsyncIterable<Buffer>;
}

function openStream(url: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<NodeStreamResponse> {
    const parsed = new URL(url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node.js https module is the only Electron-renderer transport that bypasses CORS for chatgpt.com (same pattern as openai.ts gemini path)
    const https = require('https') as typeof import('https');

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                ...headers,
                'Content-Length': Buffer.byteLength(body).toString(),
            },
        }, (res) => {
            const responseHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
                if (v) responseHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
            }

            const stream = (async function* () {
                for await (const chunk of res) {
                    yield chunk as Buffer;
                }
            })();

            resolve({
                status: res.statusCode ?? 500,
                headers: responseHeaders,
                stream,
            });
        });

        req.on('error', reject);

        if (signal) {
            const onAbort = () => { req.destroy(); reject(new DOMException('Aborted', 'AbortError')); };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }

        req.write(body);
        req.end();
    });
}

async function readBody(response: NodeStreamResponse): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of response.stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Pull a human-readable message out of a Codex JSON error body. Common shapes:
 *   {"detail": "..."}
 *   {"error": {"message": "..."}}
 *   {"message": "..."}
 * Falls back to undefined if nothing recognisable is present so the caller can
 * decide whether to show the raw trimmed body instead.
 */
function extractServerDetail(body: string): string | undefined {
    if (!body) return undefined;
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (typeof parsed.detail === 'string') return parsed.detail;
        if (typeof parsed.message === 'string') return parsed.message;
        const err = parsed.error;
        if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
            return (err as Record<string, unknown>).message as string;
        }
    } catch {
        // not JSON -- fall through
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// SSE parser for Responses API stream
//
// Event names observed 2026-04-28 in codex-cli/codex-rs:
//   response.created
//   response.output_item.added            (new function_call or message)
//   response.output_text.delta            (text delta)
//   response.function_call_arguments.delta (tool args delta)
//   response.output_item.done             (item finished)
//   response.completed                    (terminal, includes usage)
//   response.failed                       (terminal, with error)
// ---------------------------------------------------------------------------

interface ToolCallState {
    callId: string;
    name: string;
    argsJson: string;
}

async function* parseSseEvents(response: NodeStreamResponse, _signal?: AbortSignal): ApiStream {
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCalls = new Map<string, ToolCallState>();

    for await (const chunk of response.stream) {
        buffer += decoder.decode(chunk, { stream: true });

        let eventEnd: number;
        while ((eventEnd = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, eventEnd);
            buffer = buffer.slice(eventEnd + 2);
            const parsed = parseSseBlock(rawEvent);
            if (!parsed) continue;
            yield* dispatchEvent(parsed.eventName, parsed.data, toolCalls);
        }
    }

    // Flush any remaining tool calls (shouldn't happen if response.completed arrived)
    for (const tc of toolCalls.values()) {
        yield* finalizeToolCall(tc);
    }
}

function parseSseBlock(block: string): { eventName: string; data: string } | null {
    const lines = block.split('\n');
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
        if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
        }
    }
    if (dataLines.length === 0) return null;
    return { eventName, data: dataLines.join('\n') };
}

function* dispatchEvent(
    eventName: string,
    data: string,
    toolCalls: Map<string, ToolCallState>,
): Generator<ApiStreamChunk> {
    if (data === '[DONE]') return;

    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
        return;
    }

    // type field on the event payload, fallback to eventName
    const type = (parsed.type as string | undefined) ?? eventName;

    if (type === 'response.output_text.delta') {
        const delta = parsed.delta;
        if (typeof delta === 'string' && delta.length > 0) {
            yield { type: 'text', text: delta };
        }
        return;
    }

    if (type === 'response.output_item.added') {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item && item.type === 'function_call') {
            const callId = (item.call_id as string | undefined) ?? (item.id as string);
            const name = (item.name as string | undefined) ?? '';
            toolCalls.set(callId, { callId, name, argsJson: '' });
        }
        return;
    }

    if (type === 'response.function_call_arguments.delta') {
        const callId = (parsed.item_id as string | undefined) ?? (parsed.call_id as string | undefined);
        const delta = parsed.delta as string | undefined;
        if (callId && delta) {
            const state = toolCalls.get(callId);
            if (state) state.argsJson += delta;
            else toolCalls.set(callId, { callId, name: '', argsJson: delta });
        }
        return;
    }

    if (type === 'response.output_item.done') {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item && item.type === 'function_call') {
            const callId = (item.call_id as string | undefined) ?? (item.id as string);
            const state = toolCalls.get(callId);
            if (state) {
                if (!state.name && typeof item.name === 'string') state.name = item.name;
                if (!state.argsJson && typeof item.arguments === 'string') state.argsJson = item.arguments;
                yield* finalizeToolCall(state);
                toolCalls.delete(callId);
            }
        }
        return;
    }

    if (type === 'response.completed') {
        const responseObj = parsed.response as Record<string, unknown> | undefined;
        const usage = responseObj?.usage as Record<string, unknown> | undefined;
        if (usage) {
            const input = num(usage.input_tokens) ?? num(usage.prompt_tokens) ?? 0;
            const output = num(usage.output_tokens) ?? num(usage.completion_tokens) ?? 0;
            // FIX-21-02-01 / IMP-18-01-02: input_tokens INCLUDES the cached
            // prefix (input_tokens_details.cached_tokens). Report the
            // non-cached part as inputTokens and the cached part separately,
            // matching the other OpenAI-shaped providers, so the cost calc
            // bills the cached prefix at the cache-read rate.
            const details = usage.input_tokens_details as Record<string, unknown> | undefined;
            const cachedIn = num(details?.cached_tokens) ?? 0;
            yield {
                type: 'usage',
                inputTokens: Math.max(0, input - cachedIn),
                outputTokens: output,
                cacheReadTokens: cachedIn > 0 ? cachedIn : undefined,
            };
        }
        // Drain any tool calls that didn't get an explicit done event
        for (const tc of toolCalls.values()) yield* finalizeToolCall(tc);
        toolCalls.clear();
        return;
    }

    if (type === 'response.failed') {
        const responseObj = parsed.response as Record<string, unknown> | undefined;
        const error = responseObj?.error as Record<string, unknown> | undefined;
        const message = (error?.message as string | undefined) ?? 'response.failed';
        throw new Error(`ChatGPT response failed: ${message}`);
    }

    // Other events (response.created, .in_progress, .output_item.added for messages, etc.)
    // are ignored. Add handlers as the schema reveals them.
}

function* finalizeToolCall(state: ToolCallState): Generator<ApiStreamChunk> {
    if (!state.callId || !state.name) {
        console.warn('[ChatGptOAuth] Skipping incomplete tool_call', state);
        return;
    }
    let input: Record<string, unknown> = {};
    try {
        input = state.argsJson.trim() ? JSON.parse(state.argsJson) as Record<string, unknown> : {};
    } catch (e) {
        // BUG-032: tool_error so AgentTask records the failure and breaks the loop.
        yield {
            type: 'tool_error',
            id: state.callId,
            name: state.name,
            error: truncatedToolInputError(state.name, (e as Error).message),
        };
        return;
    }
    yield { type: 'tool_use', id: state.callId, name: state.name, input };
}

function num(v: unknown): number | undefined {
    return typeof v === 'number' ? v : undefined;
}
