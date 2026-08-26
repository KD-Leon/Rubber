/**
 * Explicit, serializable agent-loop state (IMP-41-02-01a, ADR-145).
 *
 * AgentTask.run() held its runtime state in ~20 closure variables scattered
 * across an 1800-line function — unserializable (blocks task resume,
 * IMP-41-03-01), untestable in isolation, and invisible when debugging a
 * stuck loop. This object replaces them 1:1. Field semantics and reset
 * points are IDENTICAL to the closure variables they replace; the engine
 * extraction (IMP-41-02-01b) then moves ownership into AgentLoopEngine.
 *
 * Everything here must stay JSON-serializable: no functions, no class
 * instances, no AbortSignal/Map/Set.
 */

export type LoopPhase =
    | 'preamble'
    | 'streaming'
    | 'executing-tools'
    | 'condensing'
    | 'completing'
    | 'done'
    | 'aborted'
    | 'failed';

export interface AgentLoopState {
    /** Coarse phase for diagnostics and (W3) resume. */
    phase: LoopPhase;
    /** Current iteration of the inner for-loop (0-based). */
    iteration: number;

    // --- exit / completion ---
    /** Set by attempt_completion; non-null ends the loop after the turn. */
    completionResult: string | null;
    attemptCompletionFired: boolean;
    /** True when a FastPath recipe pre-ran before the loop. */
    fastPathFired: boolean;
    /** Natural end without cap/error (episode outcome grading). */
    cleanNaturalExit: boolean;
    /** Turn outcome, resolved at the return sites. */
    turnOutcome: 'accept' | 'abandon';

    // --- guards / budgets ---
    consecutiveMistakes: number;
    totalToolErrors: number;
    /** Loop-level transient-error retries used (rate-limit/5xx/network). */
    rateLimitRetries: number;
    emergencyRetried: boolean;
    /** ADR-148: one corrective retry per task after an output-cap 400. */
    outputCapRetried: boolean;
    /** FIX-54-10: one corrective retry per task after an effort-with-tools 400. */
    effortToolsRetried: boolean;
    advisorCallsUsed: number;

    // --- stream / reply bookkeeping ---
    hasStreamedText: boolean;
    /**
     * FIX-41-03-01: total characters of narration/answer text streamed this
     * run. The completion gate compares attempt_completion.result against
     * this so an answer that only lives in the result param (model streamed
     * a few narration sentences, put the deliverable into the tool input)
     * is rendered instead of silently discarded.
     */
    streamedTextChars: number;
    hasRetriedEmpty: boolean;

    // --- mode / prompt-cache ---
    pendingModeSwitch: string | null;
    cacheInvalidated: boolean;
    recentPluginSkillUsage: boolean;

    // --- telemetry / usage totals ---
    telemetryIterations: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
}

/**
 * IMP-41-03-01: loop-state initialization for fresh AND resumed runs.
 * Snapshots are taken AFTER the tool-results push (the iteration
 * completed), so a resume continues with the NEXT iteration. Budgets,
 * mistake counters and usage totals carry over — no double billing, no
 * budget reset; per-turn stream flags reset because the resumed run
 * streams its own turns.
 */
export function initLoopStateForRun(resumeFrom?: AgentLoopState): AgentLoopState {
    if (!resumeFrom) return createInitialLoopState();
    const state: AgentLoopState = JSON.parse(JSON.stringify(resumeFrom)) as AgentLoopState;
    state.iteration = resumeFrom.iteration + 1;
    state.phase = 'preamble';
    state.hasStreamedText = false;
    state.streamedTextChars = 0;
    state.hasRetriedEmpty = false;
    // FIX-41-03-01 follow-on: snapshots are stamped right after the
    // completion tool_result push, so a resumed run would otherwise hit the
    // completion break before its first own iteration and insta-complete.
    state.completionResult = null;
    state.attemptCompletionFired = false;
    return state;
}

export function createInitialLoopState(opts: { fastPathFired?: boolean } = {}): AgentLoopState {
    return {
        phase: 'preamble',
        iteration: 0,
        completionResult: null,
        attemptCompletionFired: false,
        fastPathFired: opts.fastPathFired ?? false,
        cleanNaturalExit: false,
        turnOutcome: 'abandon',
        consecutiveMistakes: 0,
        totalToolErrors: 0,
        rateLimitRetries: 0,
        emergencyRetried: false,
        outputCapRetried: false,
        effortToolsRetried: false,
        advisorCallsUsed: 0,
        hasStreamedText: false,
        streamedTextChars: 0,
        hasRetriedEmpty: false,
        pendingModeSwitch: null,
        cacheInvalidated: false,
        recentPluginSkillUsage: false,
        telemetryIterations: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
    };
}
