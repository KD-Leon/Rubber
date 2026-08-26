/**
 * agentBusyGate (IMP-01-04-03, Lever A step 2) -- admission gate for
 * boot-deferred background work.
 *
 * The full semantic reindex and the contextual-enrichment sidecar (a Haiku
 * Bedrock call per file) are kicked off on plugin load and keep running while
 * the user's first agent task is in flight, competing for the model provider
 * and the single renderer thread. Awaiting this gate at each batch boundary
 * pauses that work while a task is busy and resumes it when the task finishes.
 *
 * General: any skill run shortly after boot benefits. Not skill-specific.
 */

/** Default max time a background pipeline defers to a running task before proceeding anyway. */
export const BACKGROUND_STARVATION_MS = 90_000;
/** Default poll interval while waiting for the agent to go idle. */
export const BACKGROUND_POLL_MS = 1000;

export interface BusyGateOptions {
    /** Give up deferring after this long, so back-to-back tasks cannot starve indexing forever. */
    maxWaitMs: number;
    /** How often to re-check the busy flag. */
    pollMs: number;
    /** Stop waiting if the pipeline itself was cancelled. */
    isCancelled?: () => boolean;
    /** Injectable for tests; defaults to a real setTimeout sleep. */
    sleep?: (ms: number) => Promise<void>;
    /** Injectable for tests; defaults to Date.now. */
    now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Resolve as soon as `isBusy()` is false, the pipeline is cancelled, or the
 * starvation deadline passes -- whichever comes first. Never rejects.
 */
export async function waitWhileBusy(isBusy: () => boolean, opts: BusyGateOptions): Promise<void> {
    const sleep = opts.sleep ?? defaultSleep;
    const now = opts.now ?? Date.now;
    const deadline = now() + opts.maxWaitMs;
    while (isBusy() && now() < deadline) {
        if (opts.isCancelled?.()) return;
        await sleep(opts.pollMs);
    }
}
