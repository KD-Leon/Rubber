/**
 * Forced-workflow application (Issue #57, FIX-02-02-01).
 *
 * A forced workflow prepends a workflow's <explicit_instructions> block to the
 * message the agent receives, on every message in the agent, unless the user
 * typed an explicit command themselves. The sidebar used to do this inline in
 * handleSendMessage and got it wrong in four ways (see the module test). These
 * pure helpers pull the two decisions out of the hot path so they can be
 * asserted directly and reused without dragging in the view.
 */
import type { ContentBlock } from '../../api/types';

/**
 * True when the message begins with an explicit user command (/skill, #prompt,
 * or §workflow). In that case the user stated an intent and a forced workflow
 * must stand back rather than overwrite it (defect c). Mirrors the prefix set
 * recognised by the composer expansion in AgentSidebarView.
 */
export function isUserPrefixedMessage(text: string): boolean {
    return /^[/#§]/.test(text);
}

/**
 * Whether the forced workflow should be applied to this message: a workflow is
 * forced and the user did not type an explicit command.
 */
export function shouldApplyForcedWorkflow(text: string, forcedSlug: string): boolean {
    return forcedSlug !== '' && !isUserPrefixedMessage(text);
}

/**
 * Prepend the workflow instructions to the message the agent will receive,
 * without rebuilding it. The message already carries any #/§ expansion and the
 * full vault context, so prepending preserves both (defects c and d), and it
 * works whether the message is a plain string or a ContentBlock[] carrying
 * attachments (defect b). The input is never mutated.
 */
export function applyForcedWorkflow(
    message: string | ContentBlock[],
    instructions: string,
): string | ContentBlock[] {
    if (typeof message === 'string') {
        return `${instructions}\n\n${message}`;
    }

    const firstTextIdx = message.findIndex((b) => b.type === 'text');
    if (firstTextIdx === -1) {
        // No text block (e.g. image-only message): lead with the instructions.
        return [{ type: 'text', text: instructions }, ...message];
    }

    return message.map((block, i) => {
        if (i !== firstTextIdx || block.type !== 'text') return block;
        return { ...block, text: `${instructions}\n\n${block.text}` };
    });
}

/**
 * The next forced-workflow slug for an agent when the user toggles `slug` on the
 * workflow picker's pin: clears it if `slug` was already forced, otherwise
 * forces `slug` (switching away from any other forced workflow). Empty string
 * means "none". Pure so the pin action can be asserted directly (FEAT-02-12).
 */
export function nextForcedWorkflow(current: string, slug: string): string {
    return current === slug ? '' : slug;
}
