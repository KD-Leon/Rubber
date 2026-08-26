/**
 * AnthropicProvider - LLM provider for Anthropic Claude
 *
 * IMP-41-03-03 / ADR-150: this class owns ONLY auth, endpoint and dispatch.
 * The complete wire format (message/tool conversion, cache layout,
 * generation parameters, stream parsing) lives in the anthropic-blocks
 * adapter (src/api/adapters/anthropicBlocks.ts) and is pinned by the
 * wire-format golden suite.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider } from '../../types/settings';
import type { ApiHandler, ApiStream, MessageParam, ModelInfo } from '../types';
import type { ToolDefinition } from '../../core/tools/types';
import { getModelContextWindow } from '../../types/model-registry';
import { stripThinkingBlocks } from '../../core/utils/stripThinkingBlocks';
import { createNodeFetch } from './openai';
import { validateProviderUrl } from './providerUrlGuard';
import {
    prepareAnthropicRequest,
    parseAnthropicStream,
    convertToAnthropicMessages,
    convertToAnthropicTools,
} from '../adapters/anthropicBlocks';

// Backwards-compatible re-exports: these helpers moved into the adapter
// (ADR-150) but are part of this module's historical public surface.
export { markLastBlock, markRollingHistoryBreakpoints } from '../adapters/anthropicBlocks';

export class AnthropicProvider implements ApiHandler {
    private client: Anthropic;
    private config: LLMProvider;

    constructor(config: LLMProvider) {
        this.config = config;

        // FEAT-26-07: enterprise gateway mode (e.g. Azure APIM in front of
        // Anthropic) -- swap the SDK fetch for the Node-https fetch to
        // bypass Electron's CORS check, and send the subscription key as
        // a custom header instead of `x-api-key`. The toggle is opt-in via
        // `useGateway` so default Anthropic setups stay untouched.
        const headerName = config.gatewayHeaderName?.trim() || 'Ocp-Apim-Subscription-Key';
        const headerValue = config.gatewayHeaderValue?.trim() || '';
        const gatewayMode = config.useGateway === true && headerValue.length > 0;

        const defaultHeaders: Record<string, string> = {};
        if (gatewayMode) {
            defaultHeaders[headerName] = headerValue;
        }

        // AUDIT-038 ISSUE-002: SSRF guard on config.baseUrl. Without this
        // a tainted ProviderConfig could pivot the Anthropic API call
        // (or, worse, the gateway subscription header above) into the
        // local network or AWS IMDS. OpenAI and Bedrock already do this.
        if (config.baseUrl) {
            validateProviderUrl('anthropic', config.baseUrl, { gatewayMode });
        }

        this.client = new Anthropic({
            // In gateway mode the SDK still requires a non-null apiKey, but
            // the actual auth travels via the custom header above. Send the
            // subscription key as a placeholder so the SDK does not throw.
            apiKey: gatewayMode ? (headerValue || 'gateway') : (config.apiKey ?? ''),
            baseURL: config.baseUrl,
            dangerouslyAllowBrowser: true, // Required for Obsidian (Electron)
            ...(gatewayMode ? { fetch: createNodeFetch(), defaultHeaders } : {}),
        });
    }

    getModel(): { id: string; info: ModelInfo } {
        // ADR-158 stage 1: discovery-reported window wins; registry chain as fallback
        const contextWindow = this.config.contextWindow ?? getModelContextWindow(this.config.model);

        return {
            id: this.config.model,
            info: {
                contextWindow,
                supportsTools: true,
                supportsStreaming: true,
            },
        };
    }

    /**
     * IMP-41-01-04 / ADR-148: exact prompt token count via the SDK's
     * count_tokens endpoint. Used once per task as a calibration seed for
     * large prompts. Silent undefined on any failure (older bundled SDK,
     * network, 4xx) — the caller falls back to the char heuristic.
     */
    async countTokens(
        systemPrompt: string,
        messages: MessageParam[],
        tools: ToolDefinition[],
        abortSignal?: AbortSignal,
    ): Promise<number | undefined> {
        try {
            const messagesApi = this.client.messages as unknown as { countTokens?: unknown } | undefined;
            if (typeof messagesApi?.countTokens !== 'function') return undefined;
            const result = await this.client.messages.countTokens({
                model: this.config.model,
                system: systemPrompt,
                messages: convertToAnthropicMessages(stripThinkingBlocks(messages)),
                tools: convertToAnthropicTools(tools),
            }, { signal: abortSignal });
            const count = (result as { input_tokens?: unknown })?.input_tokens;
            return typeof count === 'number' && count > 0 ? count : undefined;
        } catch (e) {
            console.debug('[AnthropicProvider] countTokens failed (non-fatal):',
                e instanceof Error ? e.message : e);
            return undefined;
        }
    }

    async *createMessage(
        systemPrompt: string,
        messages: MessageParam[],
        tools: ToolDefinition[],
        abortSignal?: AbortSignal,
    ): ApiStream {
        const request = prepareAnthropicRequest(this.config, systemPrompt, messages, tools);
        // Create streaming request (pass abort signal for cancellation support)
        const stream = this.client.messages.stream(
            request as unknown as Anthropic.Messages.MessageStreamParams,
            { signal: abortSignal },
        );
        yield* parseAnthropicStream(stream, {
            model: this.config.model,
            cachingEnabled: this.config.promptCachingEnabled === true,
        });
    }

    /**
     * Quick non-streaming classification call (~100 input, ~10 output tokens).
     * Used by skill matching LLM-fallback when regex finds no match.
     */
    async classifyText(prompt: string, abortSignal?: AbortSignal, maxTokens = 50): Promise<string> {
        // FIX-19-05-05: maxTokens parametrisiert (Default 50 fuer den
        // 1-Wort-Prefilter). Der Freshness-Verifier uebergibt ~512, damit sein
        // JSON-Urteil nicht abgeschnitten wird und still auf FAIL_CLOSED faellt.
        const response = await this.client.messages.create({
            model: this.config.model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }],
        }, {
            signal: abortSignal ?? undefined,
        });

        // Extract text from the response
        for (const block of response.content) {
            if (block.type === 'text') return block.text.trim();
        }
        return '';
    }
}

