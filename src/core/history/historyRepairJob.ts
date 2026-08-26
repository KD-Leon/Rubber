/**
 * historyRepairJob -- one-time boot walk that persistently repairs
 * conversations damaged by the broken drain-owner gate (FIX-03-20-02): full
 * API history on disk, but only the user prompts in uiMessages, so the
 * History list showed near-empty chats.
 *
 * The walk is deliberately dependency-injected and pure of plugin globals
 * (ADR-080): the caller wires ConversationStore.repairConversation, the
 * open-session check (a conversation open in a live tab is skipped -- its RAM
 * copy is already load-repaired and persists with the next regular save), a
 * yield between files (renderer thread breathes even when the boot-job
 * starvation deadline lets the job run beside an active task), and a callback
 * per repaired id so the caller re-indexes it for history search.
 *
 * Idempotent: repairConversation is a no-op on healthy files, so an aborted
 * run simply resumes on the next boot while the settings flag stays 'pending'.
 */

export interface HistoryRepairDeps {
    listIds: () => string[];
    /** ConversationStore.repairConversation -- true when the file changed. */
    repair: (id: string) => Promise<boolean>;
    /** True when the conversation is active in a live session/tab. */
    isOpen: (id: string) => boolean;
    /** Called per repaired id (e.g. historyIndexer re-index). */
    onRepaired: (id: string) => void;
    /** Cooperative yield between files (setTimeout(0) in production). */
    yieldNow: () => Promise<void>;
}

export interface HistoryRepairResult {
    scanned: number;
    repaired: number;
    skippedOpen: number;
}

export async function runHistoryRepair(deps: HistoryRepairDeps): Promise<HistoryRepairResult> {
    const result: HistoryRepairResult = { scanned: 0, repaired: 0, skippedOpen: 0 };
    for (const id of deps.listIds()) {
        result.scanned++;
        if (deps.isOpen(id)) {
            result.skippedOpen++;
            continue;
        }
        try {
            if (await deps.repair(id)) {
                result.repaired++;
                deps.onRepaired(id);
            }
        } catch (e) {
            console.warn(`[HistoryRepair] ${id} failed (non-fatal):`, e);
        }
        await deps.yieldNow();
    }
    return result;
}
