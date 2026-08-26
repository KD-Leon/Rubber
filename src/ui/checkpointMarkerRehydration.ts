/**
 * FIX-44-12: plan how checkpoint markers come back after a conversation reload.
 *
 * Markers were never persisted: they render as siblings of the steps block, so
 * UiMessage.toolStepsHtml (a snapshot of `stepsBlockEl.outerHTML` only) never
 * contained them, and the old rehydration reconstructed purely from the shadow
 * repo -- anchored at the task's LAST bubble, and silently empty once the repo
 * pruned the task's refs (REF_RETENTION_DAYS = 30).
 *
 * The sidebar now persists each turn's markers (UiMessage.checkpoints) and this
 * module turns the stored conversation into a render plan:
 *
 *   - persisted marker, commit still in the shadow repo  -> LIVE (full buttons)
 *   - persisted marker, commit gone / repo unreadable    -> EXPIRED (dimmed,
 *     tooltip; never silently dropped)
 *   - legacy message (taskId, no checkpoints field)      -> FIX-01-07-02
 *     behavior: every loaded checkpoint at the task's last bubble
 *   - repo checkpoint of a persisting task that NO marker references (a turn
 *     that ended without assistant text never persisted its markers)
 *     -> LIVE at the task's last bubble instead of vanishing
 *
 * Pure logic, no DOM: the sidebar walks the returned map and renders via
 * renderCheckpointMarker / renderExpiredCheckpointMarker.
 */

import type { CheckpointInfo } from '../core/checkpoints/GitCheckpointService';
import type { PersistedCheckpointMarker, UiMessage } from '../core/history/ConversationStore';

export type { PersistedCheckpointMarker } from '../core/history/ConversationStore';

/** One marker to render during rehydration. */
export type MarkerRehydration =
    | { kind: 'live'; checkpoint: CheckpointInfo }
    | { kind: 'expired'; marker: PersistedCheckpointMarker };

/** Strip a live CheckpointInfo down to its persistable identity. */
export function toPersistedCheckpointMarker(cp: CheckpointInfo): PersistedCheckpointMarker {
    const marker: PersistedCheckpointMarker = {
        taskId: cp.taskId,
        commitOid: cp.commitOid,
        timestamp: cp.timestamp,
        filesChanged: [...cp.filesChanged],
    };
    if (cp.newFiles && cp.newFiles.length > 0) marker.newFiles = [...cp.newFiles];
    return marker;
}

/** The slice of UiMessage this module needs. */
export type MarkerMessage = Pick<UiMessage, 'taskId' | 'checkpoints'>;

/**
 * Build the per-message render plan. Keys are indices into `messages`.
 *
 * `loadCheckpointsForTask` is called at most once per task (results cached,
 * errors treated as "repo has nothing" so persisted markers degrade to
 * expired instead of vanishing).
 */
export async function planCheckpointMarkerRehydration(
    messages: readonly MarkerMessage[],
    loadCheckpointsForTask: (taskId: string) => Promise<CheckpointInfo[]>,
): Promise<Map<number, MarkerRehydration[]>> {
    const plan = new Map<number, MarkerRehydration[]>();

    const byTask = new Map<string, Map<string, CheckpointInfo>>();
    const loadTask = async (taskId: string): Promise<Map<string, CheckpointInfo>> => {
        let byOid = byTask.get(taskId);
        if (byOid) return byOid;
        let list: CheckpointInfo[] = [];
        try {
            list = await loadCheckpointsForTask(taskId);
        } catch (e) {
            // Repo unreadable: persisted markers below degrade to 'expired'.
            console.warn('[Checkpoints] rehydrate: loading task failed, markers degrade to expired:', taskId, e);
        }
        byOid = new Map(list.map((cp) => [cp.commitOid, cp]));
        byTask.set(taskId, byOid);
        return byOid;
    };

    // Tasks that persisted markers on at least one message: those never get
    // the legacy last-bubble anchor on top (double render).
    const persistedTasks = new Set<string>();
    for (const m of messages) {
        if (m.checkpoints && m.checkpoints.length > 0 && m.taskId) persistedTasks.add(m.taskId);
    }

    // Legacy anchor: last message index per taskId (FIX-01-07-02 behavior).
    const legacyAnchor = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.taskId && !persistedTasks.has(m.taskId) && (!m.checkpoints || m.checkpoints.length === 0)) {
            legacyAnchor.set(m.taskId, i);
        }
    }

    // Oids any persisted marker references, per task. Everything the repo
    // holds beyond these is an orphan (see fallback below).
    const referencedOids = new Map<string, Set<string>>();

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];

        if (m.checkpoints && m.checkpoints.length > 0) {
            const items: MarkerRehydration[] = [];
            for (const marker of m.checkpoints) {
                const byOid = await loadTask(marker.taskId);
                const live = byOid.get(marker.commitOid);
                items.push(live !== undefined
                    ? { kind: 'live', checkpoint: live }
                    : { kind: 'expired', marker });
                let refs = referencedOids.get(marker.taskId);
                if (!refs) {
                    refs = new Set<string>();
                    referencedOids.set(marker.taskId, refs);
                }
                refs.add(marker.commitOid);
            }
            plan.set(i, items);
            continue;
        }

        if (m.taskId && legacyAnchor.get(m.taskId) === i) {
            const byOid = await loadTask(m.taskId);
            if (byOid.size > 0) {
                plan.set(i, [...byOid.values()].map((checkpoint) => ({ kind: 'live', checkpoint })));
            }
        }
    }

    // Orphan fallback (review follow-up 2026-07-14): a turn that ended with
    // empty assistant text never persisted its markers (uiMessages.push is
    // text-gated). For a task where SOME message did persist markers, the
    // persistedTasks exclusion also removed the legacy anchor, so those
    // commits rendered nowhere despite still living in the shadow repo.
    // Append them LIVE at the task's last bubble. Uses only the loads cached
    // above (persisting tasks are always in byTask), no extra repo IO.
    const lastBubble = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.taskId && persistedTasks.has(m.taskId)) lastBubble.set(m.taskId, i);
    }
    for (const taskId of persistedTasks) {
        const byOid = byTask.get(taskId);
        const anchor = lastBubble.get(taskId);
        if (!byOid || anchor === undefined) continue;
        const refs = referencedOids.get(taskId);
        const orphans = [...byOid.values()].filter((cp) => !refs?.has(cp.commitOid));
        if (orphans.length === 0) continue;
        const items = plan.get(anchor) ?? [];
        for (const checkpoint of orphans) items.push({ kind: 'live', checkpoint });
        plan.set(anchor, items);
    }

    return plan;
}
