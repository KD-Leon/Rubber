/**
 * repairUiMessages -- reconstructs missing assistant answers in a stored
 * conversation's UI trace from its full API history, at load time.
 *
 * FIX-03-20-02: while the drain-owner gate in the sidebar's onComplete was
 * broken (ownership computed AFTER the cleanup nulled the controller), every
 * cleanly finishing run skipped the assistant uiMessage push and the save ran
 * later with a thin UI trace -- the files kept the FULL `messages` array
 * (AgentTask appends into the live reference) but `uiMessages` held only the
 * user prompts. Chats looked empty in History although nothing was lost.
 *
 * This repair is display-side and conservative:
 *   - the API history is segmented at real user text messages (tool_result
 *     batches also carry role 'user' but are part of the running segment);
 *   - per segment the LAST non-empty assistant text block is the answer the
 *     user saw; ask_followup_question calls tell us how many extra user
 *     uiMessages (the typed answers) the segment claims;
 *   - an answer is only inserted when the segment's trailing assistant
 *     uiMessages do not already carry it (text-equality guard), so healthy
 *     conversations pass through untouched.
 *
 * Limits (accepted): steering bubbles are not modelled (rare; worst case an
 * answer renders one bubble early), and a run whose only text was narration
 * before a final silent tool call reconstructs that narration instead.
 * Pure function -- no obsidian, no plugin globals (ADR-080).
 */

import type { MessageParam } from '../../api/types';
import type { UiMessage } from './ConversationStore';

interface Segment {
    /** 1 (the send) + number of ask_followup answers typed by the user. */
    claimedUserMessages: number;
    /** Last non-empty assistant text in the segment; null when none. */
    finalText: string | null;
}

interface LooseBlock { type?: string; text?: string; name?: string }

function blocksOf(m: MessageParam): LooseBlock[] {
    return Array.isArray(m.content) ? (m.content) : [];
}

/** Real user turn: role user with text content and no tool_result batch.
 *  Exported for the edit+resend cut (phase D) so both consumers share ONE
 *  definition of "user anchor" and cannot drift. */
export function isRealUserMessage(m: MessageParam): boolean {
    if (m.role !== 'user') return false;
    if (typeof m.content === 'string') return m.content.trim().length > 0;
    const blocks = blocksOf(m);
    return blocks.some((b) => b.type === 'text') && !blocks.some((b) => b.type === 'tool_result');
}

function segmentApiHistory(messages: MessageParam[]): Segment[] {
    const segments: Segment[] = [];
    let current: Segment | null = null;
    for (const m of messages) {
        if (isRealUserMessage(m)) {
            current = { claimedUserMessages: 1, finalText: null };
            segments.push(current);
            continue;
        }
        if (!current || m.role !== 'assistant') continue;
        for (const b of blocksOf(m)) {
            if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
                current.finalText = b.text;
            } else if (b.type === 'tool_use' && b.name === 'ask_followup_question') {
                current.claimedUserMessages++;
            }
        }
    }
    return segments;
}

export function repairUiMessages(messages: MessageParam[], uiMessages: UiMessage[]): UiMessage[] {
    const segments = segmentApiHistory(messages);
    const reconstructable = segments.filter((s) => s.finalText !== null).length;
    const assistantCount = uiMessages.filter((m) => m.role === 'assistant').length;
    // Healthy (or over-covered via question flushes): leave untouched.
    if (reconstructable === 0 || assistantCount >= reconstructable) return uiMessages;

    const out: UiMessage[] = [];
    let uiIdx = 0;
    let lastUserTs = '';

    for (const seg of segments) {
        // Take this segment's user messages (send + typed followup answers),
        // carrying any interleaved assistant flushes along in original order.
        let usersTaken = 0;
        while (uiIdx < uiMessages.length && usersTaken < seg.claimedUserMessages) {
            const msg = uiMessages[uiIdx++];
            if (msg.role === 'user') { usersTaken++; lastUserTs = msg.ts; }
            out.push(msg);
        }
        // Trailing assistant uiMessages belong to this segment's close.
        let sawFinal = false;
        while (uiIdx < uiMessages.length && uiMessages[uiIdx].role === 'assistant') {
            const msg = uiMessages[uiIdx++];
            if (seg.finalText !== null && msg.text === seg.finalText) sawFinal = true;
            out.push(msg);
        }
        if (seg.finalText !== null && !sawFinal) {
            out.push({ role: 'assistant', text: seg.finalText, ts: lastUserTs });
        }
    }
    // Anything left (defensive: more ui anchors than segments) passes through.
    while (uiIdx < uiMessages.length) out.push(uiMessages[uiIdx++]);
    return out;
}
