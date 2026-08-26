/**
 * Unified model-capability registry (IMP-41-02-04, ADR-147).
 *
 * One lookup for every capability dimension that was previously scattered
 * across four modules (capabilities.ts cache table, model-registry.ts
 * temperature/thinking/effort/window helpers, per-provider vision branches).
 * The FIX-04-03-12 live incident (Sonnet 5 temperature 400) was the fourth
 * drift of this class; the parity test in __tests__/modelCapabilities.test.ts
 * pins this aggregator against the legacy helpers so they cannot diverge.
 *
 * Design note vs. ADR-147: the aggregator DELEGATES to the existing
 * generation-regex helpers instead of duplicating them into a second glob
 * table — the regexes already cover future lineup members (claude-*-6,
 * gpt-6) without per-model entries, which a static table would not.
 * Vision and parallel-tool-calls are new dimensions and live here.
 */

import type { ProviderType } from '../types/settings';
import { getCacheCapability, type CacheStyle } from './capabilities';
import {
    modelSupportsTemperature,
    modelUsesBudgetTokensThinking,
    getModelEffortLevels,
    getModelContextWindow,
    getModelMaxTokens,
    normalizeModelId,
    type EffortLevel,
} from '../types/model-registry';

export type ThinkingShape = 'adaptive' | 'budget-tokens' | 'none';

export interface ModelCapabilities {
    cacheStyle: CacheStyle;
    supportsPromptCache: boolean;
    supportsTemperature: boolean;
    supportsVision: boolean;
    thinkingShape: ThinkingShape;
    effortLevels: EffortLevel[];
    contextWindow: number;
    maxOutputTokens: number;
    supportsParallelToolCalls: boolean;
}

/** Model families with documented multimodal (image) input support. */
const VISION_PATTERNS: RegExp[] = [
    /^claude-/,               // all Claude generations accept images
    /^gpt-4o/, /^gpt-4\.1/, /^gpt-4-turbo/, /^gpt-5/,
    /^o[1-9](\b|[.-])/,       // OpenAI reasoning series
    /^gemini-/,
    /^(llava|pixtral|qwen[0-9.]*-vl)/,
];

/** Families that reliably execute multiple tool calls per turn. */
const PARALLEL_TOOL_PATTERNS: RegExp[] = [
    /^claude-/, /^gpt-4/, /^gpt-5/, /^o[1-9](\b|[.-])/, /^gemini-/,
];

function matchesAny(patterns: RegExp[], normalized: string): boolean {
    return patterns.some((p) => p.test(normalized));
}

export function getModelCapabilities(providerType: string, modelId: string): ModelCapabilities {
    const normalized = normalizeModelId(modelId ?? '').toLowerCase();
    const cache = getCacheCapability(providerType as ProviderType, modelId ?? '');

    const isClaude = normalized.startsWith('claude-');
    const thinkingShape: ThinkingShape = isClaude
        ? (modelUsesBudgetTokensThinking(modelId) ? 'budget-tokens' : 'adaptive')
        : 'none';

    return {
        cacheStyle: cache.cacheStyle,
        supportsPromptCache: cache.supportsPromptCache,
        supportsTemperature: modelSupportsTemperature(modelId),
        supportsVision: matchesAny(VISION_PATTERNS, normalized),
        thinkingShape,
        effortLevels: getModelEffortLevels(modelId, providerType),
        contextWindow: getModelContextWindow(modelId),
        maxOutputTokens: getModelMaxTokens(modelId),
        supportsParallelToolCalls: matchesAny(PARALLEL_TOOL_PATTERNS, normalized),
    };
}
