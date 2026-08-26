/**
 * FEAT-55-03 (EPIC-55, ADR-171) -- per-path serialized async FIFO queue.
 *
 * InflightStore and ConversationStore persist via an unlocked
 * load -> mutate -> persist on one shared file. Under concurrency (two
 * parallel chats, or the sidebar racing an MCP/background writer) two
 * callers read the same file, mutate their own copy, and the later
 * persist() clobbers the earlier one -- a lost update. Atomic replace
 * (tmp+rename) stops a torn/0-byte file but does NOT stop lost updates.
 *
 * This queue chains operations per key (file path): an op for a given
 * key only starts once the previous op for that key has settled, so a
 * whole read-modify-write runs to completion before the next one begins.
 * Operations on different keys run concurrently. The chain is failure-
 * isolated: a rejecting op propagates to its own caller but does not
 * wedge later ops on the same key.
 *
 * Not a cross-process lock (that is WriterLock, PID-based). This is the
 * in-process serializer that WriterLock does not provide.
 *
 * Architecture-map concept: run-identity-persistence
 * Related: ADR-171
 */
export class PerFileWriteQueue {
    private tails = new Map<string, Promise<unknown>>();

    /**
     * Run `op` after all previously-enqueued ops for `key` have settled.
     * Returns op's result (or rejection). Ops on distinct keys do not wait
     * on each other.
     */
    run<T>(key: string, op: () => Promise<T>): Promise<T> {
        const prev = this.tails.get(key) ?? Promise.resolve();
        // Chain regardless of whether prev resolved or rejected, so one
        // failed op never blocks the queue. `.catch` swallows only for the
        // CHAINING link; the original caller still sees prev's rejection.
        const result = prev.catch(() => undefined).then(() => op());
        // The tail tracks completion (success or failure) without leaking
        // the rejection into the next op's scheduling.
        const tail = result.catch(() => undefined);
        this.tails.set(key, tail);
        // Prune the map entry once this is the last op for the key, so the
        // map does not grow unbounded across many one-shot paths.
        void tail.then(() => {
            if (this.tails.get(key) === tail) this.tails.delete(key);
        });
        return result;
    }
}
