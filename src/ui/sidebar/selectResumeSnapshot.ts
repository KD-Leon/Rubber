/**
 * FEAT-55-01 (EPIC-55, ADR-169) -- conversation-scoped resume selection.
 *
 * Picks which interrupted-task snapshot (if any) to offer for resume:
 *  - with a conversationId (opened from History, or the post-Stop active
 *    chat): only a snapshot belonging to THAT conversation. Never leaks an
 *    unrelated conversation's snapshot into a fresh/other chat.
 *  - without one: the newest unclaimed snapshot (listRecoverable is already
 *    sorted newest-first).
 * The chosen snapshot is claimed via the shared guard so a second leaf does
 * not also offer it. Pure over its inputs (the claim mutation is the guard's).
 *
 * User decision 2026-07-25: resume belongs to the concrete chat, reached via
 * History -- not a global banner in a new chat.
 *
 * Architecture-map concept: run-identity-persistence
 * Related: ADR-171, InflightResumeClaims
 */
import type { InflightResumeClaims } from './inflightResumeClaim';

export interface ResumeCandidate {
    taskId: string;
    conversationId?: string;
}

export function selectResumeSnapshot<T extends ResumeCandidate>(
    recoverable: readonly T[],
    conversationId: string | undefined,
    claims: InflightResumeClaims,
): T | null {
    const candidates = conversationId
        ? recoverable.filter((s) => s.conversationId === conversationId)
        : recoverable;
    const unclaimed = claims.filterUnclaimed(candidates);
    if (unclaimed.length === 0) return null;
    const chosen = unclaimed[0];
    if (!claims.claim(chosen.taskId)) return null;
    return chosen;
}
