/**
 * TaskMonitor -- per-task cost display + telemetry persistence.
 *
 * Encapsulates the two pieces of behaviour that AgentSidebarView would
 * otherwise inline as 50+ lines of bookkeeping inside its callback hash:
 *
 *   1. onUsage -> compute EUR cost, render the footer.
 *   2. onTaskTelemetry -> persist a JSON-Lines entry for offline analysis.
 *
 * The view stays a view; this service knows the model lookup, pricing,
 * subscription detection, and telemetry I/O.
 *
 * FEATURE-1804 / ADR-090.
 */

import type { App } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import type { ApiHandler } from '../../api/types';
import { getModelKey } from '../../types/settings';
import { computeCost, computeCostForBuckets, type UsageByModel } from '../../core/pricing/ModelPricing';
import { TaskTelemetry, formatTelemetryFooter, type RequestTelemetryEntry } from '../../core/telemetry/TaskTelemetry';
import { VaultDataFileAdapter } from '../../core/storage/VaultDataFileAdapter';
import { getAgentDataDir } from '../../core/utils/agentFolder';

export interface TaskMonitorOptions {
    plugin: ObsidianAgentPlugin;
    app: App;
    /** Resolved API handler for the current task. Provides the actual model id. */
    apiHandler: ApiHandler | null;
    /**
     * Footer element rendered next to the chat input.
     *
     * FIX-19-06-01: prefer `getFooterEl`. The view can swap in a fresh message
     * element mid-task (e.g. after an agent question round), and onUsage fires
     * once at the very end -- so the monitor must resolve the footer lazily at
     * write time rather than binding a snapshot here. `footerEl` stays as a
     * backward-compatible fallback for callers that never reassign it.
     */
    footerEl?: HTMLElement;
    /** Lazily resolves the CURRENT footer element at write time. Wins over footerEl. */
    getFooterEl?: () => HTMLElement;
    /** Function returning the currently effective model key, used for provider detection. */
    getEffectiveModelKey: () => string;
    /** First 200 chars of the user message, captured at task start. */
    promptPreview: string;
    /** Mode slug the task is running in (ask / agent / ...). */
    mode: string;
    /** Optional context tracker hook -- forwarded usage updates so condensing logic stays accurate. */
    contextTracker?: { updateUsage: (input: number, output: number) => void };
}

export interface TaskTelemetryData {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    toolSequence: string[];
    iterations: number;
    outcome: 'completed' | 'aborted' | 'error';
    errorMessage?: string;
}

const SUBSCRIPTION_PROVIDERS = new Set(['github-copilot', 'chatgpt-oauth']);

export class TaskMonitor {
    /**
     * FIX-24-05-02: the model that actually served the last reported usage.
     * The final onUsage of a task carries the routed model id; telemetry
     * must persist that id, not the configured main model.
     */
    private lastActualModelId?: string;

    /**
     * FIX-24-05-05: the per-model breakdown of the last reported usage.
     * Persisted with the telemetry entry so mixed-model tasks are priced
     * per model there too.
     */
    private lastUsageByModel?: UsageByModel;

    /**
     * FEAT-24-11: task start, captured when the monitor is created (one
     * monitor per task). TaskTelemetry is constructed at persist time, so
     * its own start stamp would be the write time and every record would
     * read 0 ms.
     */
    private readonly startedAt = Date.now();

    constructor(private opts: TaskMonitorOptions) {}

    /**
     * FEAT-24-11: telemetry lives under the agent data root
     * (.vault-operator/data/telemetry), not the legacy .obsidian-agent
     * folder. One place to compute it so all three JSONL files agree.
     */
    private telemetryDir(): string {
        return `${getAgentDataDir(this.opts.plugin)}/telemetry`;
    }

    private makeTelemetry(): TaskTelemetry {
        const fs = new VaultDataFileAdapter(this.opts.app.vault.adapter);
        return new TaskTelemetry(fs, { dir: this.telemetryDir() });
    }

    /**
     * FEAT-24-11: one line per API request. Appended as it arrives; the
     * file is trimmed once when the task record is written.
     */
    onRequestTelemetry(entry: RequestTelemetryEntry): void {
        void (async () => {
            await this.makeTelemetry().recordRequest(entry);
        })().catch((e) => console.warn('[Telemetry] request record failed (non-fatal):', e));
    }

    /**
     * FIX-19-06-01: the footer to write into, resolved at call time. The
     * getter (if given) reflects any mid-task element swap; otherwise the
     * static footerEl is used.
     */
    private footerEl(): HTMLElement | undefined {
        return this.opts.getFooterEl ? this.opts.getFooterEl() : this.opts.footerEl;
    }

    /**
     * Live usage update -- compute cost, render footer. Called per turn.
     *
     * v2.10.2: the optional `actualModelId` argument lets the caller report
     * the model that *actually* served the call. Without it we fall back
     * to the configured main-model id, which is wrong when TaskRouter has
     * routed the task onto the helper model and the call actually ran on
     * Haiku or Sonnet. The footer now prices the call on the correct
     * model and resolves provider / subscription state from the same id.
     */
    onUsage(
        inputTokens: number,
        outputTokens: number,
        cacheReadTokens?: number,
        cacheCreationTokens?: number,
        actualModelId?: string,
        routingMode?: 'auto' | 'override' | 'advisor' | 'subagent',
        usageByModel?: UsageByModel,
    ): void {
        const cR = cacheReadTokens ?? 0;
        const cW = cacheCreationTokens ?? 0;
        if (actualModelId) this.lastActualModelId = actualModelId;
        if (usageByModel && Object.keys(usageByModel).length > 0) this.lastUsageByModel = usageByModel;
        const modelId = actualModelId ?? this.modelIdForCost();
        const provider = this.providerFor(modelId);
        // FIX-24-05-05: mixed-model tasks are priced as the sum of
        // per-model costs; without a breakdown fall back to single-id.
        const cost = (usageByModel && Object.keys(usageByModel).length > 0)
            ? computeCostForBuckets(usageByModel)
            : computeCost(modelId, inputTokens, outputTokens, cR, cW);
        const isSubscription = provider !== undefined && SUBSCRIPTION_PROVIDERS.has(provider);
        // EPIC-26 / FEAT-26-01 / ADR-120: tag the [Cost] line with the
        // routing mode so it is easy to scan for advisor/subagent calls
        // when validating Welle 1 cost numbers.
        const modeTag = routingMode ?? 'auto';

        // FIX-24-05-05: surface the per-model split in the cost log so
        // mixed-model tasks are auditable from the console.
        const mixedModels = usageByModel ? Object.keys(usageByModel) : [];
        const mixedTag = mixedModels.length > 1 ? ` models=[${mixedModels.join(', ')}]` : '';
        console.debug(
            `[Cost] model="${modelId}" provider=${provider ?? '?'} mode=${modeTag}${mixedTag} ` +
            `in=${inputTokens} out=${outputTokens} cacheR=${cR} cacheW=${cW} ` +
            `usd=${cost.totalUsd.toFixed(4)} eur=${cost.totalEur.toFixed(4)} subscription=${isSubscription}`,
        );

        // FIX-19-06-01: resolve the CURRENT footer, so a mid-task element swap
        // (question round) does not send the cost line to an orphaned bubble.
        const footerEl = this.footerEl();
        if (!footerEl) return;
        footerEl.setText(formatTelemetryFooter({
            inputTokens,
            outputTokens,
            cacheReadTokens: cR,
            cacheCreationTokens: cW,
            costEur: cost.totalEur,
            isSubscription,
        }));
        footerEl.classList.remove('agent-u-hidden');

        // FEAT-24-05: visible signal when the task's running cost crosses the
        // warn threshold (the would-be API spend is worth flagging even on
        // subscription providers). 0 disables the warning.
        const warnEur = this.opts.plugin.settings.advancedApi.costWarnThresholdEur ?? 0;
        footerEl.classList.toggle('agent-cost-warn', warnEur > 0 && cost.totalEur >= warnEur);

        if (this.opts.contextTracker) {
            this.opts.contextTracker.updateUsage(inputTokens, outputTokens);
        }
    }

    /**
     * Persist one telemetry entry for the completed task. Best-effort,
     * never throws; failures are logged at warn level.
     */
    onTaskTelemetry(data: TaskTelemetryData): void {
        // Run in background -- the view should not wait on filesystem.
        void this.persist(data).catch((e) =>
            console.warn('[Telemetry] record failed (non-fatal):', e),
        );
    }

    /**
     * FIX-COMPACT-07: persist a per-condense-pass telemetry event.
     * Best-effort, never throws.
     */
    onCondenseTelemetry(event: import('../../core/telemetry/TaskTelemetry').CondenseTelemetryEntry): void {
        void (async () => {
            await this.makeTelemetry().recordCondense(event);
        })().catch((e) => console.warn('[Telemetry] condense record failed (non-fatal):', e));
    }

    private async persist(data: TaskTelemetryData): Promise<void> {
        const telemetry = this.makeTelemetry();
        // AUDIT-013 M-2: promptPreview is opt-in. Vault sync may share the
        // telemetry file, so user prompts only land on disk if the user
        // explicitly enables the flag.
        const recordPreview = this.opts.plugin.settings.advancedApi.telemetryRecordPromptPreview ?? false;
        await telemetry.record({
            promptPreview: recordPreview ? this.opts.promptPreview : '',
            // FIX-24-05-02: prefer the model that actually served the task.
            modelId: this.lastActualModelId ?? this.modelIdForCost(),
            mode: this.opts.mode,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            cacheReadTokens: data.cacheReadTokens,
            cacheCreationTokens: data.cacheCreationTokens,
            outcome: data.outcome,
            errorMessage: data.errorMessage,
            // FIX-24-05-05: per-model breakdown for correct mixed-model pricing.
            usageByModel: this.lastUsageByModel,
            // FEAT-24-11: the task facts the loop reported. Before this they
            // were dropped here and every record read iterations 0.
            iterations: data.iterations,
            toolSequence: data.toolSequence,
            startedAt: this.startedAt,
        });
        // FEAT-24-11: keep the per-request log bounded, once per task.
        await telemetry.trimRequestLog();
    }

    private modelIdForCost(): string {
        return this.opts.apiHandler?.getModel().id ?? '';
    }

    /**
     * Resolve provider from a model id. v2.10.2: looks the model up by its
     * concrete id (the `id` field on CustomModel, after normalisation)
     * rather than via getEffectiveModelKey(). When TaskRouter has routed
     * to the helper model, the model id we see at usage-report time
     * belongs to the helper, not to the user-selected main model.
     *
     * v2.10.4 (AUDIT-026 L-1): prefer exact match, then by descending name
     * length, so an entry called "claude" cannot shadow "claude-haiku-4.5"
     * for the lookup of `"claude-haiku-4.5"`. Without this ordering the
     * first overlapping substring match wins, which mislabels the
     * provider and breaks the isSubscription flag.
     */
    private providerFor(modelId: string): string | undefined {
        if (!modelId) {
            return this.opts.plugin.settings.activeModels.find(
                (m) => getModelKey(m) === this.opts.getEffectiveModelKey(),
            )?.provider;
        }
        const idLower = modelId.toLowerCase();

        // Exact match wins.
        const exact = this.opts.plugin.settings.activeModels.find(
            (m) => (m.name || '').toLowerCase() === idLower,
        );
        if (exact) return exact.provider;

        // Then by descending name-length so the most specific overlap wins.
        const candidates = [...this.opts.plugin.settings.activeModels]
            .filter((m) => (m.name || '').length > 0)
            .sort((a, b) => (b.name || '').length - (a.name || '').length);
        const match = candidates.find((m) => {
            const candidate = (m.name || '').toLowerCase();
            return idLower.endsWith(candidate) ||
                candidate.endsWith(idLower) ||
                idLower.includes(candidate);
        });
        return match?.provider;
    }
}
