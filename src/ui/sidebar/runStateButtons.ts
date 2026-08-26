/**
 * FIX-24-08-03: primary-action button visibility.
 *
 * FEAT-24-08 originally MORPHED Stop into Send as soon as the textarea
 * held text, which made Stop unreachable during a running task -- the
 * click queued a steering message instead of aborting (live incident
 * 2026-07-08: "Stop wirkt nicht"). Stop therefore stays visible for the
 * whole task lifetime; Send appears NEXT TO it while the user types a
 * steering message.
 */
export interface RunStateButtonVisibility {
    showSend: boolean;
    showStop: boolean;
}

export function resolveRunStateButtons(running: boolean, hasText: boolean): RunStateButtonVisibility {
    return {
        showSend: !running || hasText,
        showStop: running,
    };
}
