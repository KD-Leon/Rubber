/**
 * BackgroundJobCoordinator (FIX-PERF-39)
 *
 * Central scheduler for periodic background jobs (SnapshotJob,
 * Aging-Sweep, FrontmatterBackfill, InboxTriage, Stufe3Periodic,
 * ActiveMcpSessions evict, McpRateLimiter cleanup, ConsoleRingBuffer
 * cleanup, etc.). Today each job spins its own scheduleRecurring,
 * which means two jobs touching the same resource (e.g. knowledge.db)
 * can serialize at the DB layer or overlap at the cache layer.
 *
 * Responsibilities:
 *   - Job registration with priority (low/normal/high) and per-
 *     resource mutex tags.
 *   - At most one job per resource tag runs at a time. Other jobs
 *     waiting on the same tag queue up.
 *   - Low-priority jobs only fire inside a requestIdleCallback
 *     window so they never pile on top of a user-driven turn.
 *   - Cancellation on disposal: in-flight jobs are awaited, queued
 *     jobs are dropped, future intervals are disabled.
 *   - Telemetry per job (last duration, last error). Used by future
 *     observability tools, kept lightweight.
 *
 * Not a replacement for scheduleRecurring; jobs migrate incrementally
 * over the wave 5 timeframe (SnapshotJob first, FrontmatterBackfill
 * last per Decision 5).
 */

export type JobPriority = 'low' | 'normal' | 'high';

export interface JobOptions {
    /** Unique job id. Used for telemetry and re-registration guards. */
    id: string;
    /** Resource tags - jobs sharing a tag run mutually exclusive. */
    resources: string[];
    /** Interval between successful runs (milliseconds). */
    everyMs: number;
    /** Priority: low jobs wait for requestIdleCallback, high jobs run immediately. */
    priority?: JobPriority;
    /** The actual work. Throwing is logged but does not break the schedule. */
    run: () => void | Promise<void>;
}

interface JobRecord {
    opts: JobOptions;
    timer: number | null;
    running: boolean;
    runPromise: Promise<void> | null;
    lastDurationMs: number;
    lastError: string | null;
    runCount: number;
}

export class BackgroundJobCoordinator {
    private jobs = new Map<string, JobRecord>();
    private resourceLocks = new Set<string>();
    private resourceWaiters = new Map<string, Array<() => void>>();
    private disposed = false;

    /**
     * Register a periodic job. Idempotent: re-registering an existing
     * id replaces the previous record and restarts its interval.
     */
    register(opts: JobOptions): void {
        if (this.disposed) return;
        if (!opts.id || opts.resources.length === 0 || opts.everyMs <= 0) {
            throw new Error('BackgroundJobCoordinator.register: invalid options');
        }
        // Stop any prior registration for this id.
        const previous = this.jobs.get(opts.id);
        if (previous) this.cancelTimer(previous);
        const record: JobRecord = {
            opts: { priority: 'normal', ...opts },
            timer: null,
            running: false,
            runPromise: null,
            lastDurationMs: 0,
            lastError: null,
            runCount: 0,
        };
        this.jobs.set(opts.id, record);
        this.scheduleNext(record);
    }

    /**
     * Cancel a job. In-flight execution is left to complete; future
     * intervals do not fire.
     */
    cancel(id: string): void {
        const record = this.jobs.get(id);
        if (!record) return;
        this.cancelTimer(record);
        this.jobs.delete(id);
    }

    /**
     * Cancel every job. Awaits in-flight tasks. Called on plugin
     * onunload to prevent dangling promises.
     */
    async dispose(): Promise<void> {
        this.disposed = true;
        const pendingRuns: Array<Promise<void>> = [];
        for (const [, record] of this.jobs) {
            this.cancelTimer(record);
            if (record.runPromise) pendingRuns.push(record.runPromise);
        }
        this.jobs.clear();
        this.resourceLocks.clear();
        this.resourceWaiters.clear();
        // Resolve every queued waiter so an acquireResources sitting on
        // a now-vanished lock does not hang the in-flight job.
        for (const waiters of this.resourceWaiters.values()) {
            for (const w of waiters) w();
        }
        await Promise.allSettled(pendingRuns);
    }

    /** Telemetry snapshot for the observability surface. */
    getReport(): Array<{ id: string; running: boolean; runCount: number; lastDurationMs: number; lastError: string | null }> {
        const out = [];
        for (const [id, r] of this.jobs) {
            out.push({
                id,
                running: r.running,
                runCount: r.runCount,
                lastDurationMs: r.lastDurationMs,
                lastError: r.lastError,
            });
        }
        return out;
    }

    private cancelTimer(record: JobRecord): void {
        if (record.timer !== null) {
            window.clearTimeout(record.timer);
            record.timer = null;
        }
    }

    private scheduleNext(record: JobRecord): void {
        if (this.disposed) return;
        record.timer = window.setTimeout(() => { void this.runOnce(record); }, record.opts.everyMs);
    }

    private runOnce(record: JobRecord): Promise<void> {
        const promise = this.runOnceInner(record);
        record.runPromise = promise.finally(() => { record.runPromise = null; });
        return record.runPromise;
    }

    private async runOnceInner(record: JobRecord): Promise<void> {
        if (this.disposed) return;
        record.timer = null;
        // Low-priority jobs wait for idle. If requestIdleCallback is not
        // available (rare in Obsidian) fall through to immediate.
        if (record.opts.priority === 'low') {
            await new Promise<void>((resolve) => {
                const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number }).requestIdleCallback;
                if (typeof idle === 'function') {
                    idle(() => resolve(), { timeout: 30_000 });
                } else {
                    resolve();
                }
            });
            if (this.disposed) return;
        }
        // Acquire every resource tag (mutex). Wait if any is held.
        await this.acquireResources(record.opts.resources);
        if (this.disposed) {
            this.releaseResources(record.opts.resources);
            return;
        }
        record.running = true;
        const start = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now() : 0;
        try {
            const r = record.opts.run();
            if (r && typeof r.then === 'function') {
                await r;
            }
            record.lastError = null;
        } catch (err) {
            record.lastError = err instanceof Error ? err.message : String(err);
            console.warn(`[BackgroundJobCoordinator] job "${record.opts.id}" failed:`, err);
        } finally {
            record.lastDurationMs = (typeof performance !== 'undefined' && typeof performance.now === 'function')
                ? performance.now() - start : 0;
            record.runCount += 1;
            record.running = false;
            this.releaseResources(record.opts.resources);
        }
        // Schedule the next tick only after the prior one completes. This
        // guarantees no two ticks of the same job overlap, mirroring the
        // FIX-PERF-31 fix in scheduleRecurring.
        if (!this.disposed && this.jobs.has(record.opts.id)) {
            this.scheduleNext(record);
        }
    }

    private async acquireResources(resources: string[]): Promise<void> {
        for (const res of resources) {
            while (this.resourceLocks.has(res)) {
                await new Promise<void>((resolve) => {
                    let list = this.resourceWaiters.get(res);
                    if (!list) {
                        list = [];
                        this.resourceWaiters.set(res, list);
                    }
                    list.push(resolve);
                });
            }
            this.resourceLocks.add(res);
        }
    }

    private releaseResources(resources: string[]): void {
        for (const res of resources) {
            this.resourceLocks.delete(res);
            const list = this.resourceWaiters.get(res);
            if (list && list.length > 0) {
                const next = list.shift();
                if (list.length === 0) this.resourceWaiters.delete(res);
                if (next) next();
            }
        }
    }
}
