/**
 * bootJobQueue -- serialize and idle-gate the heavy startup jobs.
 *
 * PERF 2026-07-25 (send-latency RCA). Vault Operator kicked off six heavy jobs
 * in a single `onLayoutReady` tick: graph extraction over every note, the
 * ontology bootstrap, the vault-health checks, the incoming-links regeneration,
 * the implicit-connections sweep (a full 432k-pair cosine triangle) and the
 * reranker model load. Nothing staggered them and nothing deferred them while
 * the user was working, so they interleaved with the first agent send and, on a
 * single-threaded renderer, starved it: one measured send spent 75 s of HOST
 * time against 1.3 s of provider time.
 *
 * The fix is scheduling, not deletion -- every one of those jobs is wanted, just
 * not all at once and not while a task is in flight:
 *
 *   - one job at a time (they compete for the same thread and the same DB),
 *   - each waits while an agent task is busy (the admission gate from
 *     agentBusyGate, which until now only the semantic reindex used), and
 *   - a breathing gap between jobs so the UI can paint and the event loop can
 *     drain queued work.
 *
 * The starvation deadline inside the gate still applies, so back-to-back tasks
 * can never postpone startup work forever.
 *
 * Pure except for the injected sleep, so the ordering and gating are unit
 * testable without a workspace.
 *
 * Architecture-map concept: boot-job-scheduling
 * Related: agentBusyGate, IMP-01-04-03
 */

/** Breathing room between two boot jobs, so the renderer can paint. */
export const BOOT_JOB_GAP_MS = 250;

export interface BootJob {
    /** Short label for logging; also what a stuck job is identified by. */
    label: string;
    /**
     * The work. Its return value is ignored -- several of these jobs report
     * counts to their own callers, and the queue only cares that they finished.
     */
    run: () => unknown;
}

export interface BootJobQueueDeps {
    /** True while an agent task is running; jobs defer until it clears. */
    isBusy: () => boolean;
    /** Defer helper (agentBusyGate.waitWhileBusy), injected for tests. */
    waitWhileBusy: (isBusy: () => boolean) => Promise<void>;
    /** Injectable sleep; defaults to a real timer. */
    sleep?: (ms: number) => Promise<void>;
    /** Gap between jobs. */
    gapMs?: number;
    /** Log sink; defaults to console.debug. */
    log?: (msg: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Drain `jobs` one at a time, deferring to a busy agent before each.
 *
 * CONSUMES the array: each job is shifted off before it runs. Two properties
 * follow, and both are load-bearing.
 *
 * Jobs appended while the queue is draining are still picked up, because the
 * loop re-reads `jobs.length` every turn. Registration happens across an async
 * load and the layout can become ready mid-way, so late arrivals are the normal
 * case, not the exception.
 *
 * And a SECOND call is safe: whatever is left is drained, and nothing already
 * finished runs twice. USER 2026-07-26: with index-based iteration the queue
 * exited as soon as it caught up, and every job registered after that moment
 * was pushed onto an array nobody was draining any more. On a plugin reload
 * (layout already ready, so onLayoutReady fires immediately) that stranded four
 * of the six jobs -- including the vault-health check, whose missing findings
 * are why the health button above the chat disappeared.
 *
 * Never rejects: a failing job is logged and the queue continues. A boot job
 * that throws must not take the remaining startup work down with it.
 */
export async function drainBootJobs(jobs: BootJob[], deps: BootJobQueueDeps): Promise<void> {
    const sleep = deps.sleep ?? defaultSleep;
    const gapMs = deps.gapMs ?? BOOT_JOB_GAP_MS;
    const log = deps.log ?? ((m: string) => console.debug(m));

    while (jobs.length > 0) {
        const job = jobs.shift();
        if (job === undefined) break;
        await deps.waitWhileBusy(deps.isBusy);
        const startedAt = Date.now();
        try {
            await job.run();
            log(`[BootJobs] ${job.label} done in ${Date.now() - startedAt} ms`);
        } catch (e) {
            console.warn(`[BootJobs] ${job.label} failed (non-fatal):`, e);
        }
        // Yield even after the last job: cheap, and it keeps the shape simple.
        await sleep(gapMs);
    }
}
