/**
 * OpenAI-chat wire adapter (IMP-41-03-03, ADR-150).
 *
 * ONE implementation of the Anthropic-internal -> OpenAI chat-completions
 * message/tool conversion, shared by the three OpenAI-shape provider classes
 * (openai/gemini/ollama/lmstudio/openrouter/azure/custom via OpenAiProvider,
 * github-copilot, kilo-gateway). Before this adapter each provider carried a
 * near-identical private copy — FIX-04-03-09 had to patch all three, which
 * is exactly the drift pattern ADR-150 removes.
 *
 * Reasoning passback (FIX-04-03-07) stays gated per provider TYPE inside the
 * conversion, so copilot/kilo callers get byte-identical output to their
 * former copies (their types are not in the passback set).
 */

import type { MessageParam } from '../types';
import type { ToolDefinition } from '../../core/tools/types';
import { appendOpenAiChatUserMessage, type OpenAiChatMessage } from '../openaiShapeUserBlocks';

export type OpenAIContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null | OpenAIContentPart[];
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    name?: string;
    // FIX-04-03-07: DeepSeek deepseek-reasoner requires the original
    // reasoning_content to be echoed back on assistant messages that contain
    // tool_calls, otherwise a follow-up request returns 400.
    reasoning_content?: string;
}

export interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface OpenAITool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

// FIX-04-03-07: only OpenAI-compatible backends that *can* consume a passed-back
// reasoning_content field get one on the wire. Excluded:
//   - openai/azure: official OpenAI does not expect the field; future strict
//     validation could 400.
//   - openrouter: has its own server-side reasoning passthrough via the
//     top-level `reasoning: {...}` request param (Claude extended thinking).
//     Echoing reasoning_content too could interfere.
//   - gemini: uses different reasoning conventions.
//   - github-copilot / kilo-gateway: route through Claude/GPT which do not
//     consume a plain reasoning_content field.
export const REASONING_PASSBACK_PROVIDER_TYPES = new Set<string>(['custom', 'ollama', 'lmstudio']);
export const MAX_REASONING_CONTENT_CHARS = 50_000;

/**
 * Convert internal MessageParam[] to OpenAI chat messages, system prompt
 * first. `providerType` gates the DeepSeek reasoning passback: for the LAST
 * assistant message with tool_use only (older ThinkingBlocks are dropped
 * from the wire — caps per-request overhead at one turn of reasoning).
 */
export function convertToOpenAiChatMessages(
    systemPrompt: string,
    messages: MessageParam[],
    providerType: string,
): OpenAIMessage[] {
    const result: OpenAIMessage[] = [
        { role: 'system', content: systemPrompt },
    ];

    const emitReasoningPassback = REASONING_PASSBACK_PROVIDER_TYPES.has(providerType);
    let lastAssistantWithToolUseIdx = -1;
    if (emitReasoningPassback) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role !== 'assistant' || typeof m.content === 'string') continue;
            if (m.content.some((b) => b.type === 'tool_use')) {
                lastAssistantWithToolUseIdx = i;
                break;
            }
        }
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (typeof msg.content === 'string') {
            result.push({ role: msg.role, content: msg.content });
            continue;
        }

        // Array of ContentBlock
        const blocks = msg.content;

        if (msg.role === 'assistant') {
            // Assistant messages may contain text + tool_use blocks.
            // Thinking blocks are filtered out of textParts here (they never
            // belong in visible content) and live in reasoning_content
            // instead, gated on the allow-list + last-assistant rule above.
            const textParts = blocks
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('');

            const toolUseParts = blocks.filter(
                (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
                    b.type === 'tool_use',
            );

            let reasoningContent: string | undefined;
            if (emitReasoningPassback && i === lastAssistantWithToolUseIdx) {
                const joined = blocks
                    .filter((b): b is { type: 'thinking'; text: string } => b.type === 'thinking')
                    .map((b) => b.text)
                    .join('');
                if (joined.length > 0) {
                    reasoningContent = joined.length > MAX_REASONING_CONTENT_CHARS
                        ? `${joined.slice(0, MAX_REASONING_CONTENT_CHARS)}\n[reasoning truncated]`
                        : joined;
                }
            }

            if (toolUseParts.length > 0) {
                // Message with tool calls
                const assistantMsg: OpenAIMessage = {
                    role: 'assistant',
                    content: textParts || null,
                    tool_calls: toolUseParts.map((b) => ({
                        id: b.id,
                        type: 'function',
                        function: {
                            name: b.name,
                            arguments: JSON.stringify(b.input),
                        },
                    })),
                };
                if (reasoningContent !== undefined) {
                    assistantMsg.reasoning_content = reasoningContent;
                }
                result.push(assistantMsg);
            } else {
                result.push({ role: 'assistant', content: textParts });
            }
        } else {
            // REF-06: user-message conversion (text + image + tool_result)
            // lives in the shared appendOpenAiChatUserMessage helper.
            appendOpenAiChatUserMessage(result as OpenAiChatMessage[], msg);
        }
    }

    return result;
}

/** Convert ToolDefinition[] to OpenAI function-tool format. */
export function convertToOpenAiChatTools(tools: ToolDefinition[]): OpenAITool[] {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
        },
    }));
}
