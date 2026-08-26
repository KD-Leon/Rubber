/**
 * Structured logging for auth-class provider errors (401/403).
 *
 * Field report 2026-07-14: gpt-5.6-sol succeeded on turn 1 and 401ed on
 * the follow-up tool_result call with "insufficient permissions". The
 * log carried only the message, so we could not tell scope-restriction,
 * quota-as-401, and tool_result-continuation-restriction apart. This
 * helper extracts the diagnostic surface OpenAI (and other providers)
 * actually sends -- x-request-id, rate-limit-remaining, retry-after --
 * so the next incident is traceable without a repro.
 *
 * Wired into `withCircuitBreaker` so it fires provider-agnostically at
 * the one place every non-local handler's errors funnel through.
 */

interface ErrorShape {
    message?: unknown;
    status?: unknown;
    headers?: unknown;
    error?: unknown;
    code?: unknown;
}

interface HeadersGetter {
    get(name: string): string | null | undefined;
}

function hasGetter(h: unknown): h is HeadersGetter {
    return typeof h === 'object' && h !== null
        && typeof (h as { get?: unknown }).get === 'function';
}

function readHeader(headers: unknown, name: string): string | undefined {
    if (headers === undefined || headers === null || typeof headers !== 'object') return undefined;
    if (hasGetter(headers)) {
        const raw = headers.get(name) ?? headers.get(name.toLowerCase());
        return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    }
    const rec = headers as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
        if (key.toLowerCase() === name.toLowerCase()) {
            const v = rec[key];
            return typeof v === 'string' && v.length > 0 ? v : undefined;
        }
    }
    return undefined;
}

const BODY_MAX = 1024;

export interface AuthDiagnosticsContext {
    providerType: string;
    model: string;
}

export interface AuthDiagnosticsPayload {
    providerType: string;
    model: string;
    status?: number;
    body?: string;
    requestId?: string;
    rateLimitRemainingRequests?: string;
    rateLimitRemainingTokens?: string;
    rateLimitResetRequests?: string;
    rateLimitResetTokens?: string;
    retryAfter?: string;
}

/**
 * Emit a single structured warn line for an auth-class provider error.
 * Never throws -- the caller is already in a catch handler and we must
 * not shadow the original error.
 */
export function logAuthErrorDiagnostics(err: unknown, ctx: AuthDiagnosticsContext): void {
    try {
        const payload: AuthDiagnosticsPayload = {
            providerType: ctx.providerType,
            model: ctx.model,
        };

        if (typeof err === 'object' && err !== null) {
            const e = err as ErrorShape;

            if (typeof e.status === 'number') payload.status = e.status;

            if (typeof e.message === 'string') {
                payload.body = e.message.length > BODY_MAX
                    ? e.message.slice(0, BODY_MAX)
                    : e.message;
            }

            const requestId = readHeader(e.headers, 'x-request-id');
            if (requestId !== undefined) payload.requestId = requestId;

            const rlrReq = readHeader(e.headers, 'x-ratelimit-remaining-requests');
            if (rlrReq !== undefined) payload.rateLimitRemainingRequests = rlrReq;

            const rlrTok = readHeader(e.headers, 'x-ratelimit-remaining-tokens');
            if (rlrTok !== undefined) payload.rateLimitRemainingTokens = rlrTok;

            const rlResReq = readHeader(e.headers, 'x-ratelimit-reset-requests');
            if (rlResReq !== undefined) payload.rateLimitResetRequests = rlResReq;

            const rlResTok = readHeader(e.headers, 'x-ratelimit-reset-tokens');
            if (rlResTok !== undefined) payload.rateLimitResetTokens = rlResTok;

            const retryAfter = readHeader(e.headers, 'retry-after');
            if (retryAfter !== undefined) payload.retryAfter = retryAfter;
        }

        // Emit both an inline one-line string AND the object so the log is
        // useful in copy-paste form (DevTools collapses object args to
        // "Object") and still expandable for header details.
        const inline = Object.entries(payload)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
            .join(' ');
        console.warn(`[AuthDiag] ${inline}`, payload);
    } catch {
        // Diagnostic logging must never mask the original error.
    }
}
