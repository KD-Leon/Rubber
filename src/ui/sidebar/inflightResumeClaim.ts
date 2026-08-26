/**
 * FEAT-55-04 (EPIC-55, ADR-171) -- per-snapshot boot-recovery ownership.
 *
 * A plugin-level guard so each interrupted-run snapshot is offered for
 * resume in exactly ONE chat leaf. Boot-recovery used to run in every
 * leaf's onOpen against the shared inflight store, so N restored leaves
 * each showed a Resume card for the same snapshot; clicking one left the
 * others stale and a second click replayed an already-cleared task.
 *
 * The first leaf to claim a taskId wins; other leaves skip it. release()
 * frees it again when the user discards without resuming, so a later
 * reopen can offer it once more. User decision 2026-07-24: one manual
 * resume prompt per snapshot, in its owning chat.
 *
 * Architecture-map concept: run-identity-persistence
 * Related: ADR-171
 */
export class InflightResumeClaims {
    private claimed = new Set<string>();

    /** Returns true if THIS caller won the claim (first one); false if already claimed. */
    claim(taskId: string): boolean {
        if (this.claimed.has(taskId)) return false;
        this.claimed.add(taskId);
        return true;
    }

    /** Free a claim so the snapshot can be offered again (e.g. discarded without resuming). */
    release(taskId: string): void {
        this.claimed.delete(taskId);
    }

    /** Keep only the entries not yet claimed by another leaf. */
    filterUnclaimed<T extends { taskId: string }>(snapshots: readonly T[]): T[] {
        return snapshots.filter((s) => !this.claimed.has(s.taskId));
    }
}
