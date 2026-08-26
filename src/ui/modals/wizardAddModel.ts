/**
 * FIX-26-99-03 (issue #48, point 1 rest case): route the first-run wizard's
 * "Add model" into the canonical providerConfigs[] store.
 *
 * Pre-fix the wizard pushed the new model into the legacy
 * `settings.activeModels[]` without stamping `schemaVersion`. The one-shot
 * activeModelsToProviders migration (guard: schemaVersion unset +
 * providerConfigs empty + activeModels non-empty) then ran on the next plugin
 * load and showed the MigrationNotificationModal right after first setup.
 * The sidebar onboarding path was fixed in FIX-26-99-01/02 (OnboardingFlow
 * routes to Settings > Providers); this module closes the wizard path.
 *
 * Pure and free of Obsidian imports so it stays unit-testable. Mirrors the
 * conversion rules of `activeModelsToProviders.ts` for a single model.
 */

import type {
    CustomModel,
    DiscoveredModel,
    ObsidianAgentSettings,
    ProviderConfig,
    ProviderType,
} from '../../types/settings';
import { getProviderBrandLabel } from '../../types/settings';
import { classifyModelTier } from '../../core/routing/ModelTierClassifier';
import { SCHEMA_VERSION } from '../../core/settings/migrations/activeModelsToProviders';

export type WizardModelSettings = Pick<ObsidianAgentSettings,
    'activeModels' | 'activeModelKey' | 'providerConfigs' | 'activeProviderId' | 'schemaVersion'
>;

/** Custom endpoints cannot be tier-classified (same rule as the migration). */
function isCustomEndpoint(providerType: ProviderType): boolean {
    return providerType === 'ollama' || providerType === 'lmstudio' || providerType === 'custom';
}

function allocateInstanceId(existing: ProviderConfig[], type: ProviderType): string {
    const ids = new Set(existing.map((p) => p.id));
    const base = `${type}-main`;
    if (!ids.has(base)) return base;
    let n = 2;
    while (ids.has(`${type}-${n}`)) n++;
    return `${type}-${n}`;
}

function toDiscoveredModel(model: CustomModel): DiscoveredModel {
    const classification = !isCustomEndpoint(model.provider)
        ? classifyModelTier(model.name, { providerType: model.provider })
        : null;
    return {
        id: model.name,
        displayName: model.displayName ?? model.name,
        maxOutputTokens: model.maxTokens,
        autoTier: classification?.tier,
        autoTierSource: classification?.source,
    };
}

/**
 * Apply a wizard-added model to `settings.providerConfigs[]` (in place).
 *
 * - An existing provider config of the same type absorbs the model (deduped
 *   by id; auth/baseUrl fields entered in the wizard overwrite the stored
 *   ones, empty wizard fields keep them).
 * - Otherwise a new ProviderConfig is created from the model's credentials.
 * - `activeProviderId` is set when nothing is active yet.
 * - `schemaVersion` is stamped so the legacy migration never runs for a
 *   wizard-initialized install.
 *
 * The caller persists via plugin.saveSettings().
 */
export function applyWizardModelToProviderConfigs(
    settings: WizardModelSettings,
    model: CustomModel,
): void {
    const list = settings.providerConfigs ?? [];
    const discovered = toDiscoveredModel(model);

    let provider = list.find((p) => p.type === model.provider);
    if (provider) {
        // The user just added a model here through the wizard; a previously
        // disabled config of the same type must come back, otherwise
        // resolveActiveProvider filters it and the model stays invisible.
        provider.enabled = true;
        if (!provider.discoveredModels.some((m) => m.id === discovered.id)) {
            provider.discoveredModels.push(discovered);
        }
        // Review finding C3 (2026-07-14): freshly entered credentials win.
        // The wizard is reachable long after first run; when a stored key is
        // stale (revoked, rotated) the user re-runs the wizard with a new one
        // and the old backfill-only rule silently kept the broken credential.
        // Empty wizard fields leave the stored values untouched.
        if (model.apiKey) provider.apiKey = model.apiKey;
        if (model.baseUrl) provider.baseUrl = model.baseUrl;
        // Review follow-up on C3 (2026-07-14): the same non-empty-wins rule
        // covers the remaining credential fields the wizard's
        // ModelConfigModal collects. A Bedrock user re-running the wizard
        // with rotated AWS keys (or an Azure user with a new apiVersion)
        // otherwise hit the identical silently-kept-stale-credentials
        // failure through these fields.
        if (model.apiVersion) provider.apiVersion = model.apiVersion;
        if (model.awsAuthMode) provider.awsAuthMode = model.awsAuthMode;
        if (model.awsRegion) provider.awsRegion = model.awsRegion;
        if (model.awsApiKey) provider.awsApiKey = model.awsApiKey;
        if (model.awsAccessKey) provider.awsAccessKey = model.awsAccessKey;
        if (model.awsSecretKey) provider.awsSecretKey = model.awsSecretKey;
        if (model.awsSessionToken) provider.awsSessionToken = model.awsSessionToken;
    } else {
        provider = {
            id: allocateInstanceId(list, model.provider),
            type: model.provider,
            displayName: getProviderBrandLabel(model.provider),
            enabled: true,
            apiKey: model.apiKey,
            baseUrl: model.baseUrl,
            apiVersion: model.apiVersion,
            awsAuthMode: model.awsAuthMode,
            awsRegion: model.awsRegion,
            awsApiKey: model.awsApiKey,
            awsAccessKey: model.awsAccessKey,
            awsSecretKey: model.awsSecretKey,
            awsSessionToken: model.awsSessionToken,
            discoveredModels: [discovered],
            lastRefreshAt: 0,
            tierMapping: {},
            tierOverrides: {},
        };
        list.push(provider);
        settings.providerConfigs = list;
    }

    // Fill the model's tier slot when classification found one and the slot
    // is still empty (first occurrence wins, same as the migration).
    if (discovered.autoTier && !provider.tierMapping?.[discovered.autoTier]) {
        provider.tierMapping = { ...provider.tierMapping, [discovered.autoTier]: discovered.id };
    }

    // Guarantee the model is reachable through the default tier cascade
    // (mid -> fast, see resolveTierModel). classifyModelTier returns null
    // for local providers (ollama/lmstudio/custom) and unknown cloud ids,
    // and a flagship-only mapping is never reached by the mid cascade.
    // Without this fallback the wizard reports a configured model while
    // initApiHandler resolves nothing and the first message hits the
    // "no model setup" card. Discovery refresh keeps the slot: its merge
    // only overwrites tiers it actually classified.
    const target = provider;
    const reachableByDefaultCascade = (['mid', 'fast'] as const).some(
        (tier) => Boolean(target.tierOverrides?.[tier] ?? target.tierMapping?.[tier]),
    );
    if (!reachableByDefaultCascade) {
        provider.tierMapping = { ...provider.tierMapping, mid: discovered.id };
    }

    if (!settings.activeProviderId) {
        settings.activeProviderId = provider.id;
    }
    if (!settings.schemaVersion) {
        settings.schemaVersion = SCHEMA_VERSION;
    }
}
