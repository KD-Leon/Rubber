/**
 * Token-bucket request rate limiter per (provider, model) — IMP-41-02-03,
 * ADR-146.
 *
 * The legacy rateLimitMs was a fixed sleep between loop iterations: helper
 * calls, subtasks and FastPath planners bypassed it entirely, and one global
 * value throttled every provider including local ones. This bucket sits in
 * the ApiHandler wrapper (see buildApiHandler) so every call site passes
 * through, keyed per provider+model so local models stay unlimited while a
 * low-tier cloud key is throttled.
 *
 * Adaptive: reportRateLimited() halves the effective rate for a cooldown
 * window (the retry layer calls it on a classified 429), then the configured
 * rate applies again.
 */

const ADAPTIVE_COOLDOWN_MS = 5 * 60_000;

interface Bucket {
    rpm: number;
    tokens: number;
    burst: number;
    lastRefillMs: number;
    rateLimitedUntilMs: number;
    waiters: Array<{ resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal; onAbort?: () => void }>;
    timer?: number;
}

function abortError(): Error {
    const err = new Error('Rate limiter acquire aborted');
    err.name = 'AbortError';
    return err;
}

export class RequestRateLimiter {
    private buckets = new Map<string, Bucket>();
    // FEAT-55-04 (ADR-172): global budget-wait observer. Counts currently-
    // parked acquisitions so the UI can show one "waiting on shared API
    // budget" indicator across concurrent chats: fires true on 0->>0 and
    // false on >0->0, not per individual waiter.
    private waitObserver: ((waiting: boolean) => void) | null = null;
    private parkedCount = 0;

    /** Register (or clear with null) the single global wait observer. */
    setWaitObserver(observer: ((waiting: boolean) => void) | null): void {
        this.waitObserver = observer;
    }

    private enterWait(): void {
        this.parkedCount++;
        if (this.parkedCount === 1) {
            try { this.waitObserver?.(true); } catch { /* observer is best-effort */ }
        }
    }

    private leaveWait(): void {
        if (this.parkedCount === 0) return;
        this.parkedCount--;
        if (this.parkedCount === 0) {
            try { this.waitObserver?.(false); } catch { /* best-effort */ }
        }
    }

    private key(providerType: string, modelId: string): string {
        return `${providerType}::${modelId}`;
    }

    /** Configure requests-per-minute for a key. 0 = unlimited. */
    configure(providerType: string, modelId: string, rpm: number): void {
        const key = this.key(providerType, modelId);
        if (rpm <= 0) {
            this.buckets.delete(key);
            return;
        }
        const existing = this.buckets.get(key);
        const burst = Math.max(1, Math.floor(rpm / 6));
        if (existing) {
            existing.rpm = rpm;
            existing.burst = burst;
            existing.tokens = Math.min(existing.tokens, burst);
        } else {
            this.buckets.set(key, {
                rpm, burst, tokens: burst,
                lastRefillMs: Date.now(),
                rateLimitedUntilMs: 0,
                waiters: [],
            });
        }
    }

    /** Effective rpm right now (0 = unlimited), halved during a 429 cooldown. */
    getEffectiveRpm(providerType: string, modelId: string): number {
        const bucket = this.buckets.get(this.key(providerType, modelId));
        if (!bucket) return 0;
        return Date.now() < bucket.rateLimitedUntilMs ? Math.floor(bucket.rpm / 2) : bucket.rpm;
    }

    /** Adaptive throttle: called by the retry layer on a classified 429. */
    reportRateLimited(providerType: string, modelId: string): void {
        const bucket = this.buckets.get(this.key(providerType, modelId));
        if (bucket) bucket.rateLimitedUntilMs = Date.now() + ADAPTIVE_COOLDOWN_MS;
    }

    /**
     * Wait until a token is available. Unconfigured keys resolve instantly.
     *
     * FEAT-55-04 (ADR-172): the optional `notify` hooks let a caller show a
     * "waiting on shared budget" indicator. onWait fires ONLY when the call
     * actually parks (no token now); onResume fires when it later proceeds.
     * An instant acquisition fires neither, so the indicator never flickers
     * for uncontended calls.
     */
    acquire(
        providerType: string,
        modelId: string,
        signal?: AbortSignal,
        notify?: { onWait?: () => void; onResume?: () => void },
    ): Promise<void> {
        const bucket = this.buckets.get(this.key(providerType, modelId));
        if (!bucket) return Promise.resolve();
        if (signal?.aborted) return Promise.reject(abortError());

        this.refill(bucket);
        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return Promise.resolve();
        }

        // Parking: signal the wait now (per-caller notify + global observer)
        // and the resume when the promise settles (resolve OR abort).
        try { notify?.onWait?.(); } catch { /* indicator is best-effort */ }
        this.enterWait();
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const settleResume = () => {
                if (settled) return;
                settled = true;
                try { notify?.onResume?.(); } catch { /* best-effort */ }
                this.leaveWait();
            };
            const waiter: Bucket['waiters'][number] = {
                resolve: () => { settleResume(); resolve(); },
                reject,
                signal,
            };
            if (signal) {
                waiter.onAbort = () => {
                    const idx = bucket.waiters.indexOf(waiter);
                    if (idx >= 0) bucket.waiters.splice(idx, 1);
                    settleResume();
                    reject(abortError());
                };
                signal.addEventListener('abort', waiter.onAbort, { once: true });
            }
            bucket.waiters.push(waiter);
            this.scheduleDrain(bucket);
        });
    }

    private refill(bucket: Bucket): void {
        const now = Date.now();
        const effectiveRpm = now < bucket.rateLimitedUntilMs ? Math.max(1, Math.floor(bucket.rpm / 2)) : bucket.rpm;
        const elapsed = now - bucket.lastRefillMs;
        if (elapsed <= 0) return;
        bucket.tokens = Math.min(bucket.burst, bucket.tokens + (elapsed / 60_000) * effectiveRpm);
        bucket.lastRefillMs = now;
    }

    private scheduleDrain(bucket: Bucket): void {
        if (bucket.timer !== undefined) return;
        const effectiveRpm = Date.now() < bucket.rateLimitedUntilMs
            ? Math.max(1, Math.floor(bucket.rpm / 2))
            : bucket.rpm;
        const msPerToken = 60_000 / effectiveRpm;
        bucket.timer = window.setTimeout(() => {
            bucket.timer = undefined;
            this.refill(bucket);
            while (bucket.tokens >= 1 && bucket.waiters.length > 0) {
                bucket.tokens -= 1;
                const waiter = bucket.waiters.shift();
                if (waiter) {
                    if (waiter.signal && waiter.onAbort) {
                        waiter.signal.removeEventListener('abort', waiter.onAbort);
                    }
                    waiter.resolve();
                }
            }
            if (bucket.waiters.length > 0) this.scheduleDrain(bucket);
        }, msPerToken);
    }
}

/** Process-wide singleton shared by all ApiHandler wrappers. */
export const requestRateLimiter = new RequestRateLimiter();
