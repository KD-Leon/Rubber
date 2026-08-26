/**
 * Resolves Inline-Actions settings with defaults (EPIC-33).
 *
 * The settings.inlineActions field is fully optional so existing
 * data.json files do not need migration. resolveInlineActionsSettings
 * returns a fully-populated struct with the canonical defaults applied
 * for every missing field.
 *
 * Related: FEAT-33-01 (Settings-Surface), FEAT-33-09 (Vault-RAG).
 */

import type { InlineActionsSettings, ObsidianAgentSettings } from '../../types/settings';
import { resolveTierModel } from '../routing/tierResolution';

export interface ResolvedInlineActionsSettings {
    enabled: boolean;
    floatingMenuEnabled: boolean;
    vaultRagInLookup: boolean;
    vaultRagConfidenceThreshold: number;
    /** FEAT-33-12: 'cm-block-widget' (default) or 'popover-overlay'. */
    inlineChatDisplay: 'cm-block-widget' | 'popover-overlay';
}

export const INLINE_ACTIONS_DEFAULTS: ResolvedInlineActionsSettings = {
    enabled: true,
    floatingMenuEnabled: false,
    vaultRagInLookup: true,
    vaultRagConfidenceThreshold: 0.7,
    inlineChatDisplay: 'cm-block-widget',
};

export function resolveInlineActionsSettings(
    raw: InlineActionsSettings | undefined,
): ResolvedInlineActionsSettings {
    if (raw === undefined || raw === null) {
        return { ...INLINE_ACTIONS_DEFAULTS };
    }
    // Number.isFinite excludes NaN/Infinity: typeof NaN === 'number' would
    // otherwise let a NaN threshold through the clamp unchanged (Review-Finding).
    const threshold = typeof raw.vaultRagConfidenceThreshold === 'number' && Number.isFinite(raw.vaultRagConfidenceThreshold)
        ? Math.min(1, Math.max(0, raw.vaultRagConfidenceThreshold))
        : INLINE_ACTIONS_DEFAULTS.vaultRagConfidenceThreshold;
    const display: 'cm-block-widget' | 'popover-overlay' =
        raw.inlineChatDisplay === 'popover-overlay'
            ? 'popover-overlay'
            : raw.inlineChatDisplay === 'cm-block-widget'
                ? 'cm-block-widget'
                : INLINE_ACTIONS_DEFAULTS.inlineChatDisplay;
    return {
        enabled: raw.enabled ?? INLINE_ACTIONS_DEFAULTS.enabled,
        floatingMenuEnabled: raw.floatingMenuEnabled ?? INLINE_ACTIONS_DEFAULTS.floatingMenuEnabled,
        vaultRagInLookup: raw.vaultRagInLookup ?? INLINE_ACTIONS_DEFAULTS.vaultRagInLookup,
        vaultRagConfidenceThreshold: threshold,
        inlineChatDisplay: display,
    };
}

/**
 * Resolve the model id + provider for the inline settings snapshot.
 *
 * Review finding B1 (2026-07-14): the first-run wizard writes only the
 * canonical `providerConfigs[]` store (FIX-26-99-03), so the snapshot must
 * read that first. Uses the same tier slot `initApiHandler` resolves
 * (`defaultMainModelTier`, default `mid`, with the mid -> fast cascade).
 * The legacy `activeModels[]` lookup stays as fallback for setups that have
 * not run the provider migration yet.
 */
export function resolveInlineModelSnapshot(
    settings: Pick<ObsidianAgentSettings,
        'activeProviderId' | 'providerConfigs' | 'activeModels' | 'activeModelKey'
    > & Partial<Pick<ObsidianAgentSettings, 'defaultMainModelTier' | 'defaultProvider'>>,
): { modelId: string; provider: string } {
    const canonical = resolveTierModel(settings, settings.defaultMainModelTier ?? 'mid');
    if (canonical) {
        return { modelId: canonical.name, provider: canonical.provider };
    }
    const activeKey = settings.activeModelKey;
    const legacy = settings.activeModels.find((m) => m.name === activeKey) ?? settings.activeModels[0];
    return {
        modelId: legacy?.name ?? '',
        provider: legacy?.provider ?? settings.defaultProvider ?? 'anthropic',
    };
}
