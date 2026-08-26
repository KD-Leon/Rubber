/**
 * IMP-54-05b (issue #54): pure view logic for the ProviderDetailModal
 * "Reasoning effort" opt-in section.
 *
 * Custom / OpenAI-compatible endpoints can serve reasoning models the static
 * registry cannot know (GLM-5.2, DeepSeek-R1, Qwen reasoning models). The
 * per-model opt-in stored in ProviderConfig.effortOptIn tells the plugin the
 * endpoint accepts an OpenAI-style reasoning_effort field; this module
 * decides which models the modal offers for it. Kept free of any Obsidian
 * import so it stays unit-testable.
 */

import type { ProviderConfig } from '../../types/settings';
import {
    getModelEffortLevels,
    isEffortOptedIn,
    providerSupportsEffortOptIn,
} from '../../types/model-registry';
import { buildChatModelPickerRows } from '../sidebar/chatModelDropdown';

export interface EffortOptInView {
    /** Model ids currently opted in (including stale ids no longer listed, so they stay removable). */
    optedIn: string[];
    /** Pinnable model ids the static registry resolves to [] and that are not yet opted in. */
    available: string[];
}

/**
 * Build the opt-in section view for a provider draft.
 *
 * Returns null for provider types outside the OpenAI-compatible wire path
 * (their requests could never carry the field, so no control is shown).
 * Candidates are exactly the picker rows (discovered models plus FIX-55-01
 * manual tier-override ids) whose STATIC effort levels are empty -- models
 * that already resolve native levels (gpt-5 on openai) must not show the
 * control.
 */
export function buildEffortOptInView(provider: ProviderConfig): EffortOptInView | null {
    if (!providerSupportsEffortOptIn(provider.type)) return null;

    const optedIn = Object.keys(provider.effortOptIn ?? {})
        .filter((id) => isEffortOptedIn(provider.effortOptIn, id));

    const available = buildChatModelPickerRows(provider)
        .map(({ model }) => model.id)
        .filter((id) => !optedIn.includes(id))
        .filter((id) => getModelEffortLevels(id, provider.type).length === 0);

    return { optedIn, available };
}
