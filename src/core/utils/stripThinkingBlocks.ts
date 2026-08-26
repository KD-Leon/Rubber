/**
 * stripThinkingBlocks - defensive cross-provider safety filter (FIX-04-03-07)
 *
 * Once `{ type: 'thinking' }` is a first-class ContentBlock (so DeepSeek can
 * round-trip its `reasoning_content` via the OpenAI-compatible provider), a
 * cross-provider switch (DeepSeek conversation loaded under an Anthropic or
 * Bedrock config) would hit `throw new Error('Unknown content block type')`
 * in their strict convertMessages. This helper drops thinking blocks before
 * the strict map runs.
 *
 * Anthropic's signed extended-thinking round-trip is out of scope for this
 * fix - it needs a separate `thinking_signed` block schema and provider
 * support. Until then, plain thinking blocks must not reach Anthropic's API
 * (it would reject them).
 *
 * Returns a NEW array. Input is not mutated.
 */

import type { ContentBlock, MessageParam } from '../../api/types';

export function stripThinkingBlocks(messages: readonly MessageParam[]): MessageParam[] {
    const out: MessageParam[] = [];
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            out.push(msg);
            continue;
        }
        const filtered: ContentBlock[] = msg.content.filter(
            (b) => b.type !== 'thinking' && b.type !== 'redacted_thinking',
        );
        out.push({ ...msg, content: filtered });
    }
    return out;
}

/**
 * Loop-economy FIX C3: a message whose content became empty after a thinking
 * strip (assistant turn that carried ONLY reasoning) would be rejected on the
 * wire (Bedrock 400 "content field ... is empty"; Anthropic requires
 * non-empty content too). Replace empty content with a minimal marker text
 * block right before the strict provider conversion. Returns a NEW array.
 */
export function repairEmptyWireMessages(messages: readonly MessageParam[]): MessageParam[] {
    return messages.map((msg) => {
        const empty = typeof msg.content === 'string'
            ? msg.content.length === 0
            : msg.content.length === 0;
        if (!empty) return msg;
        return { ...msg, content: [{ type: 'text', text: '[reasoning elided]' }] };
    });
}

/**
 * IMP-41-01-05: passback preparation for Anthropic signed extended thinking.
 *
 * The API contract for tool_use loops requires the signed thinking blocks of
 * the LAST assistant message to be echoed back; earlier turns may drop them
 * (saves tokens, the API tolerates it). Unsigned thinking blocks (OpenAI
 * reasoners, display-only remnants) would 400 and are stripped everywhere.
 * Returns a NEW array; input is not mutated.
 */
export function prepareThinkingForPassback(messages: readonly MessageParam[]): MessageParam[] {
    let lastAssistant = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') { lastAssistant = i; break; }
    }
    const out: MessageParam[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (typeof msg.content === 'string') {
            out.push(msg);
            continue;
        }
        const isLastAssistant = i === lastAssistant;
        const filtered: ContentBlock[] = msg.content.filter((b) => {
            if (b.type === 'thinking') {
                return isLastAssistant && typeof b.signature === 'string' && b.signature.length > 0;
            }
            if (b.type === 'redacted_thinking') return isLastAssistant;
            return true;
        });
        out.push({ ...msg, content: filtered });
    }
    return out;
}
