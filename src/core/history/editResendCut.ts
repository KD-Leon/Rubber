/**
 * editResendCut -- computes where the pencil (edit+resend) action may cut the
 * two conversation representations.
 *
 * History hardening phase D (FIX-03-20-03): the old inline logic counted
 * every role==='user' entry of the API history, but tool_result batches,
 * steering lines and system nudges are role 'user' too -- editing the 2nd
 * real user bubble truncated the history at the first tool_result, deleting
 * finished turns and leaving an orphaned tool_use tail.
 *
 * The cut anchors on REAL user text messages (shared isRealUserMessage
 * definition with repairUiMessages) and is deliberately defensive: when the
 * DOM bubble count and the two arrays disagree (hidden sends exist only in
 * the history; discarded steering exists only in the ui trace), it returns
 * null and the caller must NOT cut -- a wrong cut silently corrupts the
 * conversation, a refused cut merely keeps the old messages visible.
 *
 * Pure function, no obsidian imports (ADR-080).
 */

import type { MessageParam } from '../../api/types';
import type { UiMessage } from './ConversationStore';
import { isRealUserMessage } from './repairUiMessages';

export interface EditResendCut {
    /** First uiMessages index to remove (splice from here). */
    uiCutIndex: number;
    /** First conversationHistory index to remove (splice from here). */
    historyCutIndex: number;
}

export function computeEditResendCut(
    messages: MessageParam[],
    uiMessages: UiMessage[],
    userBubblesBefore: number,
): EditResendCut | null {
    // Every user bubble in the UI, in order, tagged as a real send or a typed
    // ask_followup_question answer. `userBubblesBefore` counts ALL user bubbles
    // (both kinds render identically), so it indexes into this list.
    const uiUserBubbles: { index: number; isAnswer: boolean }[] = [];
    uiMessages.forEach((m, i) => {
        if (m.role === 'user') uiUserBubbles.push({ index: i, isAnswer: m.isFollowupAnswer === true });
    });

    const historyUserIndices: number[] = [];
    messages.forEach((m, i) => { if (isRealUserMessage(m)) historyUserIndices.push(i); });

    // Review F4: only REAL sends have an anchor in the API history. A followup
    // answer is a UI-only user bubble (it lands in the history as a
    // tool_result, filtered out by isRealUserMessage). Aligning on the
    // real-send count keeps the guard's protection against hidden sends /
    // discarded steering (those are UNmarked user bubbles that still mismatch),
    // while no longer refusing every conversation that used a followup.
    const uiRealSendCount = uiUserBubbles.filter((b) => !b.isAnswer).length;
    if (uiRealSendCount !== historyUserIndices.length) return null;
    if (userBubblesBefore >= uiUserBubbles.length) return null;

    const clicked = uiUserBubbles[userBubblesBefore];
    // Editing a followup answer is not an independent turn; refuse rather than
    // cut the history mid-turn at its tool_result.
    if (clicked.isAnswer) return null;

    // The clicked bubble's position among the REAL sends maps to the history
    // anchor; the UI splice still starts at the bubble itself so any followup
    // answers after it are removed with the rest of the tail.
    const realSendOrdinal = uiUserBubbles.slice(0, userBubblesBefore).filter((b) => !b.isAnswer).length;

    return {
        uiCutIndex: clicked.index,
        historyCutIndex: historyUserIndices[realSendOrdinal],
    };
}
