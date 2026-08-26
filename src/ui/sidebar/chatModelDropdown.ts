/**
 * EPIC-26 / FEAT-26-05 -- chat-header model dropdown options.
 *
 * Pure function: given a ProviderConfig (the active provider) and the
 * current override state, returns the list of options the dropdown
 * should render. Extracted from AgentSidebarView so the option-shaping
 * rules stay unit-testable.
 *
 * Option shape:
 *   { id: 'auto', label: 'Auto', kind: 'auto', advisorDisabled?: boolean }
 *   { id: <modelId>, label: <displayName>, kind: 'override' }
 *
 * The auto option may carry `advisorDisabled: true` when the flagship
 * tier slot is empty. The caller renders that as a subtitle hint.
 */

import type { CustomModel, DiscoveredModel, ModelTier, ProviderConfig } from '../../types/settings';
import { isEffortOptedIn, resolveEffortLevels, type EffortLevel } from '../../types/model-registry';
import { providerConfigToCustomModel } from '../../core/routing/tierResolution';
import { isExplicitThinkingOverride, resolveEffectiveThinkingEnabled, type ThinkingOverride } from './thinkingOverride';
import { resolveEffectiveEffort, thinkingSwitchIsOn, type EffortOverride } from './effortOverride';

export type ChatModelDropdownOption =
    | { id: 'auto'; label: string; kind: 'auto'; advisorDisabled: boolean }
    | { id: string; label: string; kind: 'override' };

export interface BuildOptionsInput {
    /** Active provider (null when no provider is configured / migration pending). */
    provider: ProviderConfig | null;
    /** Localised "Auto" label, e.g. "Auto". */
    autoLabel: string;
    /** Localised "advisor disabled" suffix, e.g. "advisor pattern disabled". */
    advisorDisabledLabel: string;
}

/**
 * Build the option list for the chat-header model dropdown. Always
 * returns at least the Auto option; provider-models follow if the
 * provider has discoveredModels populated.
 */
export function buildChatModelDropdownOptions(input: BuildOptionsInput): ChatModelDropdownOption[] {
    const { provider, autoLabel, advisorDisabledLabel } = input;
    const advisorDisabled = !provider
        || !(provider.tierOverrides?.flagship ?? provider.tierMapping?.flagship);

    const autoOption: ChatModelDropdownOption = {
        id: 'auto',
        label: advisorDisabled ? `${autoLabel} (${advisorDisabledLabel})` : autoLabel,
        kind: 'auto',
        advisorDisabled,
    };

    if (!provider) return [autoOption];

    const overrides: ChatModelDropdownOption[] = (provider.discoveredModels ?? []).map((m: DiscoveredModel) => ({
        id: m.id,
        label: m.displayName ?? m.id,
        kind: 'override',
    }));

    return [autoOption, ...overrides];
}

/**
 * One row of the chat model picker. `manual: true` marks an id the user
 * typed into a tier slot (provider.tierOverrides) that discovery does not
 * know; the picker renders those with a small "manual" badge.
 */
export interface ChatModelPickerRow {
    model: DiscoveredModel;
    manual: boolean;
}

/** Fixed iteration order so manual rows render deterministically. */
const TIER_MERGE_ORDER: ModelTier[] = ['flagship', 'mid', 'fast'];

/**
 * FIX-55-01 (issue #55): build the picker row list by merging the provider's
 * discoveredModels with any tierOverrides ids that discovery does not know.
 * Manually typed ids (ChatGPT OAuth / custom endpoints without a model
 * listing) were previously saved but invisible: the picker read only
 * discoveredModels, so the user could never see or pin them. Deduped: an id
 * that later shows up in discovery keeps its discovered entry (with
 * displayName/tier metadata) and loses the manual flag.
 */
export function buildChatModelPickerRows(provider: ProviderConfig): ChatModelPickerRow[] {
    const discovered = provider.discoveredModels ?? [];
    const rows: ChatModelPickerRow[] = discovered.map((m) => ({ model: m, manual: false }));
    const seen = new Set(discovered.map((m) => m.id));
    for (const tier of TIER_MERGE_ORDER) {
        const id = (provider.tierOverrides?.[tier] ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rows.push({ model: { id }, manual: true });
    }
    return rows;
}

/**
 * Helper: locate the discovered model entry for the current override id.
 * Returns null when override is 'auto' or the id is unknown.
 *
 * FIX-55-01: a manually typed tier-override id is a valid pin target even
 * though it never appears in discoveredModels (providers without a listing
 * endpoint). It resolves to a synthetic entry carrying just the id, so the
 * send-time handler build, the sticky restore (issue #54.3) and the effort
 * lookup all treat it like any discovered model.
 */
export function resolveOverrideModel(
    provider: ProviderConfig | null,
    overrideId: string | null,
): DiscoveredModel | null {
    if (!provider || !overrideId || overrideId === 'auto') return null;
    const found = (provider.discoveredModels ?? []).find((m) => m.id === overrideId);
    if (found) return found;
    const isManualOverride = TIER_MERGE_ORDER.some(
        (tier) => (provider.tierOverrides?.[tier] ?? '').trim() === overrideId,
    );
    return isManualOverride ? { id: overrideId } : null;
}

/**
 * IMP-54-05b (issue #54): native effort levels for the PINNED chat-header
 * model, or [] when nothing is pinned. Effort is a pin-only control: in Auto
 * mode the tier router picks the model, so no effort dial is offered and the
 * model keeps its own vendor default. Resolution goes through the same
 * resolveEffortLevels choke point the openai.ts request-body validation uses,
 * with the provider's per-model opt-in applied first, so an opted-in custom
 * model (e.g. GLM-5.2) that shows a slider also sends the field.
 */
export function resolveEffortLevelsForPin(
    provider: ProviderConfig,
    overrideId: string | null,
): EffortLevel[] {
    if (!overrideId) return [];
    const m = resolveOverrideModel(provider, overrideId);
    if (!m) return [];
    return resolveEffortLevels(m.id, provider.type, isEffortOptedIn(provider.effortOptIn, m.id));
}

/**
 * FIX-30-07-05: shared pin-to-CustomModel resolution for BOTH chat
 * surfaces. Given the active provider and the per-conversation pin state
 * (model id + thinking + effort), returns the fully resolved CustomModel
 * the turn must run on, or null when nothing is pinned. The sidebar and
 * the inline panel build their api handler from exactly this value, so
 * the two cannot drift again (the inline pin used to be cosmetic).
 *
 * Effort is pin-only AND thinking-gated: with the thinking switch off no
 * effort level is sent and the model keeps its vendor default.
 */
export function buildPinnedCustomModel(
    provider: ProviderConfig | null,
    overrideId: string | null,
    thinkingOverride: ThinkingOverride,
    effortOverride: EffortOverride,
): CustomModel | null {
    const m = resolveOverrideModel(provider, overrideId);
    if (!provider || !m) return null;
    let cm = providerConfigToCustomModel(provider, m.id, m);
    if (isExplicitThinkingOverride(thinkingOverride)) {
        cm = {
            ...cm,
            thinkingEnabled: resolveEffectiveThinkingEnabled(thinkingOverride, cm.thinkingEnabled),
        };
    }
    if (thinkingSwitchIsOn(thinkingOverride)) {
        const effort = resolveEffectiveEffort(effortOverride);
        if (effort !== undefined) {
            cm = { ...cm, reasoningEffort: effort };
        }
    }
    return cm;
}

/**
 * Issue #54.3: resolve the sticky chat-model override for the active provider.
 * Returns the persisted model id only when persistence is on, a provider is
 * active, and the saved id still exists on that provider (a deprovisioned model
 * falls back to Auto). Otherwise null (= Auto).
 */
export function resolveStickyChatModel(
    provider: ProviderConfig | null,
    savedMap: Record<string, string> | undefined,
    providerId: string | null,
    enabled: boolean,
): string | null {
    if (!enabled || !provider || !providerId) return null;
    const saved = savedMap?.[providerId] ?? null;
    return resolveOverrideModel(provider, saved) ? saved : null;
}
