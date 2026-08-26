/**
 * runOwnership -- resolves which run owns the shared view state at teardown
 * (onComplete/onError): drain-end, Resume card, uiMessages push, save,
 * task-end titling.
 *
 * FIX-03-20-02 root cause: the ownership gate used to be computed AFTER the
 * FIX-24-08-03 cleanup block had already nulled
 * `session.currentAbortController`, so its first disjunct compared
 * `null === myController` and every cleanly finishing run lost ownership --
 * the assistant uiMessage push and the auto-save were skipped for ALL natural
 * completions, leaving conversation files with a full API history but a
 * uiMessages array containing only the user prompts. Only stopped runs
 * survived, because handleStop records `drainingController` BEFORE nulling.
 *
 * This helper applies handleStop's own rule to the teardown path: resolve
 * ownership from the PRE-cleanup controller state, then let the caller null
 * things. Pure function so the invariant stays unit-testable (the enclosing
 * callbacks are DOM-bound closures).
 *
 * Ownership semantics (Issue 3 Wave B, unchanged):
 *   - the live run owns the view state, and
 *   - a stopped run still draining owns it via drainingController,
 *   - a superseded old run owns nothing (must not write into the newer
 *     conversation, FIX-01-01-02).
 */

export interface RunTeardown {
    /** The run was still the session's live run when teardown began. */
    wasLiveRun: boolean;
    /** The run owns drain-end, uiMessages push, save, titling, surfaces. */
    drainOwner: boolean;
}

export function resolveRunTeardown(
    currentController: AbortController | null,
    drainingController: AbortController | null,
    myController: AbortController,
): RunTeardown {
    const wasLiveRun = currentController === myController;
    return {
        wasLiveRun,
        drainOwner: wasLiveRun || drainingController === myController,
    };
}
