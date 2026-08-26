/**
 * Provider retry layer (IMP-41-01-01, ADR-146).
 *
 * Structured error classification for all provider call sites. Detection order:
 * SDK/HTTP status and error.type first, network codes second, message regex
 * only as a last resort. AgentTask consumes the classes for its loop-level
 * retry/emergency-condense decisions; executeWithRetry wraps non-loop call
 * sites (helpers, probes).
 */

export type ProviderErrorClass =
    | 'rate-limit'
    | 'overloaded'
    | 'server'
    | 'network'
    | 'context-overflow'
    | 'output-cap'
    | 'effort-tools-unsupported'
    | 'auth'
    | 'client'
    | 'abort'
    | 'unknown';

export const RETRY_BASE_DELAY_MS = 2000;
export const RETRY_MAX_ATTEMPTS = 4;
const RETRY_AFTER_MIN_MS = 1000;
const RETRY_AFTER_MAX_MS = 120_000;

const NETWORK_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET',
]);

const CONTEXT_OVERFLOW_RE =
    /context.?length|too.?long|too.?many.?tokens|token.?limit|prompt.?too|content.?size|request.?too.?large|exceeds.*context/i;
const RATE_LIMIT_RE = /rate.?limit|\b429\b/i;
const NETWORK_RE = /fetch failed|network|socket hang up|connection (reset|refused|closed)/i;

// ADR-148: the provider rejected our max_tokens as above the model's real
// output limit. Anthropic wording: "max_tokens: 32000 > 8192, which is the
// maximum ...". Bedrock ValidationException wording varies and does not
// always carry the number.
const OUTPUT_CAP_ANTHROPIC_RE = /max_tokens\D{0,3}(\d+)\s*>\s*(\d+)/i;
const OUTPUT_CAP_HINT_RE = /max_?tokens|maximum tokens|output tokens/i;
const OUTPUT_CAP_VERB_RE = /exceed|greater than|maximum|too (?:high|large)/i;
const BUDGET_TOKENS_RE = /budget_tokens/i;

// FIX-54-10: the gpt-5.6 platform generation (gpt-5.6-sol/-terra/-luna)
// rejects function tools combined with reasoning_effort on
// /v1/chat/completions: "Function tools with reasoning_effort are not
// supported for <model> in /v1/chat/completions. To use function tools, use
// /v1/responses or set reasoning_effort to 'none'." Matched structurally
// (an effort field + a tools mention + a rejection verb) so wording variants
// and other OpenAI-compatible backends classify too.
const EFFORT_FIELD_RE = /reasoning[._\s-]?effort/i;
const EFFORT_TOOLS_RE = /\btools?\b|\bfunction.?call/i;
const EFFORT_REJECT_RE = /not supported|unsupported|not compatible|incompatible|cannot be (?:used|combined|set)/i;
// Guards against effort-ONLY rejections, where a retry with 'none' cannot
// help because the parameter itself is unsupported: (a) the vLLM/LM-Studio
// shape "Unsupported parameter: reasoning_effort. Supported parameters
// are: ..., tools, ...", whose tools mention merely enumerates what IS
// supported; (b) generally, a tools mention that only occurs after such an
// enumeration opener.
const EFFORT_PARAM_UNSUPPORTED_RE = /unsupported\s+(?:parameter|argument|field)s?\s*[:'"\s]\s*['"]?reasoning[._\s-]?effort/i;
const SUPPORTED_ENUM_RE = /supported\s+(?:parameter|argument|field)s?\s+(?:are|include)/i;

function isEffortToolsUnsupportedMessage(message: string): boolean {
    if (EFFORT_PARAM_UNSUPPORTED_RE.test(message)) return false;
    if (!EFFORT_FIELD_RE.test(message) || !EFFORT_REJECT_RE.test(message)) return false;
    const toolsMatch = EFFORT_TOOLS_RE.exec(message);
    if (!toolsMatch) return false;
    const enumMatch = SUPPORTED_ENUM_RE.exec(message);
    if (enumMatch && toolsMatch.index > enumMatch.index) return false;
    return true;
}

function isOutputCapMessage(message: string): boolean {
    if (BUDGET_TOKENS_RE.test(message)) return false;
    if (/prompt is too long|input.{0,20}too long/i.test(message)) return false;
    return OUTPUT_CAP_ANTHROPIC_RE.test(message)
        || (OUTPUT_CAP_HINT_RE.test(message) && OUTPUT_CAP_VERB_RE.test(message));
}

/**
 * The model's real output limit from an output-cap 400, when the provider
 * names it (Anthropic does; Bedrock usually does not — callers fall back to
 * halving their previous request).
 */
export function parseOutputCapLimit(err: unknown): number | null {
    if (typeof err !== 'object' || err === null) return null;
    const message = typeof (err as ErrorShape).message === 'string'
        ? (err as ErrorShape).message as string : '';
    const m = OUTPUT_CAP_ANTHROPIC_RE.exec(message);
    if (!m) return null;
    const limit = parseInt(m[2], 10);
    return Number.isFinite(limit) && limit > 0 ? limit : null;
}

interface ErrorShape {
    message?: unknown;
    name?: unknown;
    status?: unknown;
    code?: unknown;
    error?: { type?: unknown };
    headers?: unknown;
    /** AWS Smithy errors carry the HTTP status here instead of `.status`. */
    $metadata?: { httpStatusCode?: unknown };
}

/**
 * Classify a provider error. Structured fields win over message text so a 401
 * whose body happens to mention "rate limit" stays auth (no retry storm on a
 * bad key).
 */
export function classifyProviderError(err: unknown): ProviderErrorClass {
    if (typeof err !== 'object' || err === null) return 'unknown';
    const e = err as ErrorShape;
    const message = typeof e.message === 'string' ? e.message : '';

    if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return 'abort';

    // AWS Smithy errors (Bedrock) have no `.status`; they carry `name` plus
    // `$metadata.httpStatusCode`. Without this they all classified as
    // `unknown` and failed the task (ADR-148).
    const smithyStatus = typeof e.$metadata?.httpStatusCode === 'number'
        ? e.$metadata.httpStatusCode
        : (e.name === 'ValidationException' ? 400 : undefined);
    const status = typeof e.status === 'number' ? e.status : smithyStatus;
    const errorType = typeof e.error?.type === 'string' ? e.error.type : undefined;

    if (errorType === 'overloaded_error') return 'overloaded';
    if (status !== undefined) {
        if (status === 429) return 'rate-limit';
        if (status === 529) return 'overloaded';
        if (status === 401 || status === 403) return 'auth';
        if (status >= 500) return 'server';
        if (status >= 400) {
            if (isEffortToolsUnsupportedMessage(message)) return 'effort-tools-unsupported';
            if (isOutputCapMessage(message)) return 'output-cap';
            return CONTEXT_OVERFLOW_RE.test(message) ? 'context-overflow' : 'client';
        }
    }

    if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return 'network';

    // Message-level fallbacks for errors without structured fields.
    if (isEffortToolsUnsupportedMessage(message)) return 'effort-tools-unsupported';
    if (CONTEXT_OVERFLOW_RE.test(message)) return 'context-overflow';
    if (RATE_LIMIT_RE.test(message)) return 'rate-limit';
    if (NETWORK_RE.test(message)) return 'network';
    return 'unknown';
}

export function isRetryable(cls: ProviderErrorClass): boolean {
    return cls === 'rate-limit' || cls === 'overloaded' || cls === 'server' || cls === 'network';
}

function readRetryAfterHeader(headers: unknown): string | undefined {
    if (typeof headers !== 'object' || headers === null) return undefined;
    const h = headers as { get?: (k: string) => unknown } & Record<string, unknown>;
    let raw: unknown;
    if (typeof h.get === 'function') {
        raw = h.get('retry-after') ?? h.get('Retry-After');
    } else {
        raw = h['retry-after'] ?? h['Retry-After'];
    }
    return typeof raw === 'string' ? raw : undefined;
}

/**
 * Delay before retry `attempt` (1-based). Retry-After header (seconds or
 * HTTP-date) wins, clamped to [1s, 120s]; otherwise exponential backoff from
 * opts.baseDelayMs (default RETRY_BASE_DELAY_MS) with +-20 percent jitter.
 */
export function getRetryDelayMs(err: unknown, attempt: number, opts: { baseDelayMs?: number } = {}): number {
    const headers = (typeof err === 'object' && err !== null)
        ? (err as ErrorShape).headers
        : undefined;
    const retryAfter = readRetryAfterHeader(headers);
    if (retryAfter !== undefined) {
        const seconds = Number(retryAfter);
        let ms: number | undefined;
        if (Number.isFinite(seconds)) {
            ms = seconds * 1000;
        } else {
            const dateMs = Date.parse(retryAfter);
            if (Number.isFinite(dateMs)) ms = dateMs - Date.now();
        }
        if (ms !== undefined) {
            return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
        }
    }
    const baseDelay = opts.baseDelayMs ?? RETRY_BASE_DELAY_MS;
    const base = baseDelay * Math.pow(2, Math.max(0, attempt - 1));
    const jitter = 1 + (Math.random() * 0.4 - 0.2);
    return Math.round(base * jitter);
}

function abortError(): Error {
    const err = new Error('Retry aborted');
    err.name = 'AbortError';
    return err;
}

/**
 * Sleep that rejects with AbortError the moment the signal fires, instead of
 * waiting out the full delay and checking afterwards.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(abortError()); return; }
        const timer = window.setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            window.clearTimeout(timer);
            reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Run `fn`, retrying transient provider failures. Non-retryable classes and
 * abort propagate immediately; the backoff wait itself is abort-aware.
 */
export async function executeWithRetry<T>(
    fn: () => Promise<T>,
    opts: { abortSignal?: AbortSignal; maxAttempts?: number } = {},
): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? RETRY_MAX_ATTEMPTS;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (opts.abortSignal?.aborted) throw abortError();
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const cls = classifyProviderError(err);
            if (!isRetryable(cls) || attempt === maxAttempts) throw err;
            const delay = getRetryDelayMs(err, attempt);
            console.debug(`[retry] ${cls} on attempt ${attempt}/${maxAttempts}, waiting ${delay}ms`);
            await abortableDelay(delay, opts.abortSignal);
        }
    }
    throw lastError;
}
