/**
 * Approval-card timeout wiring (IMP-41-01-02).
 *
 * showApprovalCard used to park the agent loop on an unresolved Promise with
 * no wall clock and no abort coupling: a walked-away user left the task (and
 * its provider session) pinned forever, and Stop during an open card still
 * required a second click on the card itself. This helper owns the timer and
 * abort listener; the card owns the DOM and resolves its Promise from the
 * callbacks.
 */

import { scheduleRecurring, type RecurringHandle } from '../../util/scheduleRecurring';

export interface ApprovalTimeoutHandle {
    dispose(): void;
}

export function wireApprovalTimeout(opts: {
    /** 0 disables the timeout entirely (legacy behaviour). */
    timeoutMs: number;
    abortSignal?: AbortSignal;
    onExpire: () => void;
    onAbort: () => void;
    /** Called once per second while 60 or fewer seconds remain. */
    onCountdownTick?: (remainingSec: number) => void;
}): ApprovalTimeoutHandle {
    let timeoutId: number | undefined;
    let countdown: RecurringHandle | undefined;
    let disposed = false;

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        countdown?.stop();
        opts.abortSignal?.removeEventListener('abort', onAbortEvent);
    };

    const onAbortEvent = (): void => {
        dispose();
        opts.onAbort();
    };

    if (opts.abortSignal?.aborted) {
        disposed = true;
        opts.onAbort();
        return { dispose: () => { /* already settled */ } };
    }
    opts.abortSignal?.addEventListener('abort', onAbortEvent, { once: true });

    if (opts.timeoutMs > 0) {
        const expiresAt = Date.now() + opts.timeoutMs;
        timeoutId = window.setTimeout(() => {
            dispose();
            opts.onExpire();
        }, opts.timeoutMs);
        if (opts.onCountdownTick) {
            // FIX-PERF-44: scheduleRecurring instead of window.setInterval --
            // the post-build rename (esbuild.config.mjs) breaks direct
            // setInterval calls at runtime.
            countdown = scheduleRecurring(() => {
                const remainingSec = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
                if (remainingSec <= 60) opts.onCountdownTick?.(remainingSec);
            }, 1000);
        }
    }

    return { dispose };
}
