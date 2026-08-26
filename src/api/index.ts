/**
 * API Handler Factory
 *
 * Adapted from Kilo Code's src/api/index.ts (buildApiHandler)
 */

import type { LLMProvider, CustomModel } from '../types/settings';
import { modelToLLMProvider } from '../types/settings';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiProvider } from './providers/openai';
import { GitHubCopilotProvider } from './providers/github-copilot';
import { KiloGatewayProvider } from './providers/kilo-gateway';
import { BedrockProvider } from './providers/bedrock';
import { ChatGptOAuthProvider } from './providers/chatgpt-oauth';
import type { ApiHandler, ApiStream, MessageParam } from './types';
import type { ToolDefinition } from '../core/tools/types';
import { RequestRateLimiter, requestRateLimiter } from './RequestRateLimiter';
import { ProviderHealth, providerHealth } from './ProviderHealth';
import { classifyProviderError } from './retry';
import { logAuthErrorDiagnostics } from './authDiagnostics';

export type { ApiHandler, ApiStream, ApiStreamChunk, MessageParam, ContentBlock, ModelInfo } from './types';

/** Local inference has no provider-side rate limits — never wrapped. */
const UNLIMITED_PROVIDER_TYPES = new Set(['ollama', 'lmstudio']);

/**
 * IMP-41-02-03 / ADR-146: decorate createMessage with the token bucket so
 * EVERY call site (main loop, condensing helper, subtasks, FastPath
 * planners) passes through. The provider classes themselves stay
 * resilience-free.
 */
export function withRateLimit(
    handler: ApiHandler,
    providerType: string,
    limiter: RequestRateLimiter = requestRateLimiter,
): ApiHandler {
    const wrapped: ApiHandler = Object.create(handler) as ApiHandler;
    wrapped.createMessage = function (
        systemPrompt: string,
        messages: MessageParam[],
        tools: ToolDefinition[],
        abortSignal?: AbortSignal,
    ): ApiStream {
        return (async function* () {
            await limiter.acquire(providerType, handler.getModel().id, abortSignal);
            yield* handler.createMessage(systemPrompt, messages, tools, abortSignal);
        })();
    };
    return wrapped;
}

/**
 * IMP-41-03-02 / ADR-146: circuit-breaker decorator. Fails fast while the
 * provider's breaker is open (microseconds instead of a retry cascade
 * against a dead provider) and feeds outcomes back into the health record.
 * Abort/auth outcomes never open the breaker (classified upstream).
 */
export function withCircuitBreaker(
    handler: ApiHandler,
    providerType: string,
    health: ProviderHealth = providerHealth,
): ApiHandler {
    const wrapped: ApiHandler = Object.create(handler) as ApiHandler;
    wrapped.createMessage = function (
        systemPrompt: string,
        messages: MessageParam[],
        tools: ToolDefinition[],
        abortSignal?: AbortSignal,
    ): ApiStream {
        return (async function* () {
            // FEAT-55-04 (ADR-172): key the breaker by provider::model (same
            // scheme as RequestRateLimiter.key) instead of providerType alone.
            // Under parallel chats a struggling model must not fail-fast or
            // starve the half-open probe of a healthy model on the same
            // provider (one model = one endpoint). The user-facing message
            // keeps the readable providerType.
            const breakerKey = `${providerType}::${handler.getModel().id}`;
            if (!health.canRequest(breakerKey)) {
                const wait = health.secondsUntilProbe(breakerKey);
                throw new Error(
                    `Provider "${providerType}" is currently unreachable (circuit open). `
                    + `Next automatic attempt in ${wait}s.`,
                );
            }
            try {
                yield* handler.createMessage(systemPrompt, messages, tools, abortSignal);
                health.reportSuccess(breakerKey);
            } catch (err) {
                const cls = classifyProviderError(err);
                // FIX-54-11 follow-up: structured diagnostic line on auth-class
                // errors so scope-restriction, quota-as-401 and continuation-
                // restriction are distinguishable in the console without a
                // repro. Field report 2026-07-14 (gpt-5.6-sol succeeded on
                // turn 1, 401ed on the follow-up tool_result call).
                if (cls === 'auth') {
                    logAuthErrorDiagnostics(err, { providerType, model: handler.getModel().id });
                }
                health.reportFailure(breakerKey, cls);
                throw err;
            }
        })();
    };
    return wrapped;
}

/**
 * Build an ApiHandler from a CustomModel (new path)
 */
export function buildApiHandlerForModel(model: CustomModel) {
    return buildApiHandler(modelToLLMProvider(model));
}

/**
 * Build an ApiHandler from a LLMProvider config (legacy / internal path)
 */
export function buildApiHandler(config: LLMProvider) {
    const providerType = config.type;
    // ADR-158: name the winning context-window source once at construction
    // (getModel() is hot-path; logging there would spam every turn).
    // AUDIT 2026-07-18 L-1 / AUDIT-034 M-26: never log the model id -- it is
    // sensitive for custom endpoints. Provider type + source suffice.
    console.debug(
        `[ApiHandler] context window source (${providerType}): `
        + (config.contextWindow !== undefined
            ? `discovery-reported (${config.contextWindow})`
            : 'registry chain'),
    );
    const handler = ((): ApiHandler => {
        switch (providerType) {
            case 'anthropic':
                return new AnthropicProvider(config);
            case 'github-copilot':
                return new GitHubCopilotProvider(config);
            case 'kilo-gateway':
                return new KiloGatewayProvider(config);
            case 'bedrock':
                return new BedrockProvider(config);
            case 'chatgpt-oauth':
                return new ChatGptOAuthProvider(config);
            case 'openai':
            case 'gemini':
            case 'ollama':
            case 'lmstudio':
            case 'openrouter':
            case 'azure':
            case 'custom':
                return new OpenAiProvider(config);
            default: {
                const _exhaustive: never = providerType;
                throw new Error(`Unknown provider type: ${String(_exhaustive)}`);
            }
        }
    })();
    // IMP-41-02-03: every non-local handler passes the shared token bucket.
    // Unconfigured keys resolve instantly, so this is a no-op until a rate
    // is set (rateLimitMs mapping or future per-provider settings).
    handler.providerType = providerType;
    if (UNLIMITED_PROVIDER_TYPES.has(providerType)) return handler;
    // Composition order: breaker OUTERMOST so an open circuit fails fast
    // without first waiting on (and consuming) a rate-limit token; the
    // limiter then paces only requests that are actually going out. Both
    // are no-ops until configured / until failures accumulate.
    const limited = withRateLimit(handler, providerType);
    const wrapped = withCircuitBreaker(limited, providerType);
    wrapped.providerType = providerType;
    return wrapped;
}
