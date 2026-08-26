/**
 * Loop-level error policy (IMP-41-01-01, ADR-146).
 *
 * Pure decision function for AgentTask.run()'s catch block. Replaces the two
 * message-regex checks (context overflow, 429) with structured classification
 * from src/api/retry.ts, and widens the retryable set to transient
 * server/overloaded/network failures. Extracted as a pure function so the
 * policy is testable without driving the full loop (and ready for the
 * ADR-145 engine extraction).
 */

import {
    classifyProviderError,
    getRetryDelayMs,
    isRetryable,
    type ProviderErrorClass,
} from '../../api/retry';

export type LoopErrorAction =
    | { action: 'retry'; waitMs: number; retryNumber: number; maxRetries: number; cls: ProviderErrorClass }
    | { action: 'emergency-condense'; cls: ProviderErrorClass }
    | { action: 'corrective-retry'; cls: ProviderErrorClass }
    | { action: 'abort'; cls: ProviderErrorClass }
    | { action: 'fail'; cls: ProviderErrorClass };

export interface LoopErrorState {
    retriesUsed: number;
    maxRetries: number;
    emergencyRetried: boolean;
    /** ADR-148: one output-cap corrective retry per task. */
    outputCapRetried: boolean;
    /** FIX-54-10: one effort-with-tools corrective retry per task. */
    effortToolsRetried: boolean;
    historyLength: number;
    /**
     * Base backoff for rate-limit errors WITHOUT a Retry-After header. Kept at
     * the legacy 30s so providers that do not announce a window are not
     * hammered; all other transient classes use the short RETRY_BASE_DELAY_MS
     * curve.
     */
    rateLimitBaseWaitMs: number;
}

/** Minimum history length for emergency condensing to be worthwhile. */
const EMERGENCY_CONDENSE_MIN_HISTORY = 7;

export function decideLoopErrorAction(err: unknown, state: LoopErrorState): LoopErrorAction {
    const cls = classifyProviderError(err);

    if (cls === 'abort') return { action: 'abort', cls };

    // ADR-148: the provider named a real output limit below our request.
    // One corrective retry: the caller learns the cap (clamping all later
    // requests) and re-enters the loop.
    if (cls === 'output-cap' && !state.outputCapRetried) {
        return { action: 'corrective-retry', cls };
    }

    // FIX-54-10: the provider rejected function tools combined with
    // reasoning_effort (gpt-5.6 platform generation on chat/completions).
    // One corrective retry: the caller learns the per-model flag (forcing
    // reasoning_effort 'none' whenever tools are present, this task and all
    // future sessions) and re-enters the loop.
    if (cls === 'effort-tools-unsupported' && !state.effortToolsRetried) {
        return { action: 'corrective-retry', cls };
    }

    if (cls === 'context-overflow'
        && state.historyLength >= EMERGENCY_CONDENSE_MIN_HISTORY
        && !state.emergencyRetried) {
        return { action: 'emergency-condense', cls };
    }

    if (isRetryable(cls) && state.retriesUsed < state.maxRetries) {
        const retryNumber = state.retriesUsed + 1;
        const waitMs = getRetryDelayMs(err, retryNumber, {
            baseDelayMs: cls === 'rate-limit' ? state.rateLimitBaseWaitMs : undefined,
        });
        return { action: 'retry', waitMs, retryNumber, maxRetries: state.maxRetries, cls };
    }

    return { action: 'fail', cls };
}
