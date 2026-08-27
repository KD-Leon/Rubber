/**
 * FirstRunWizardModal -- Phase 2.3.
 *
 * One-shot setup wizard that walks new users through the seven
 * choices the plugin can't sensibly default to: LLM model, embedding
 * model, role models (titling/internal calls/memory/contextual),
 * search provider, and the two optional asset downloads (reranker,
 * self-development source).
 *
 * Auto-opens on plugin load for the first three sessions unless the
 * user has dismissed it or completed it. Also triggerable from the
 * command palette. Every step is skippable; skipped steps appear as
 * inline banners in their respective settings tabs.
 *
 * After the final step closes the modal, the existing OnboardingFlow
 * starts in the sidebar to fill Memory + Soul via chat.
 */

import { App, Modal, Notice, Setting, setIcon, getLanguage } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { resolveLocale, t, type SupportedLocale } from '../../i18n';
import { ModelConfigModal } from '../settings/ModelConfigModal';
import type { CustomModel } from '../../types/settings';
import { getModelKey } from '../../types/settings';
import { applyWizardModelToProviderConfigs } from './wizardAddModel';
import { resolveCoreTemplatesFolder } from '../../core/utils/templatesFolder';
import { TemplateMaterializer } from '../../core/templates/TemplateMaterializer';
import { makeTemplateTranslator } from '../../core/templates/translateTemplate';
import { BUNDLED_NOTE_TEMPLATES } from '../../_generated/bundled-templates';
import { castGenerated } from '../../core/utils/runtime';

// FEAT-24-08 Welle A follow-up (2026-05-18): the dedicated 'role-models'
// wizard step was removed. The 4 role-model dropdowns (titling, internal,
// memory, contextual) all enumerated the legacy `activeModels[]` which is
// empty after the EPIC-26 migration; the resolvers now auto-fall-back to
// the active provider's fast tier, so the step had nothing to configure.
type StepId =
    | 'welcome'
    | 'llm-model'
    | 'embedding-model'
    | 'search-provider'
    | 'templates'
    | 'optional-downloads'
    | 'done';

const STEPS: { id: StepId; titleKey: string; canSkip: boolean }[] = [
    { id: 'welcome',            titleKey: 'modal.firstRunWizard.stepWelcome',           canSkip: false },
    { id: 'llm-model',          titleKey: 'modal.firstRunWizard.stepLlmModel',          canSkip: true  },
    { id: 'embedding-model',    titleKey: 'modal.firstRunWizard.stepEmbeddingModel',    canSkip: true  },
    { id: 'search-provider',    titleKey: 'settings.webSearch.headingProvider',         canSkip: true  },
    { id: 'templates',          titleKey: 'modal.firstRunWizard.stepTemplates',         canSkip: true  },
    { id: 'optional-downloads', titleKey: 'modal.firstRunWizard.stepOptionalDownloads', canSkip: true  },
    { id: 'done',               titleKey: 'modal.vaultHealth.doneBtn',                  canSkip: false },
];

export class FirstRunWizardModal extends Modal {
    private stepIndex = 0;
    private headerEl!: HTMLElement;
    private progressEl!: HTMLElement;
    private bodyEl!: HTMLElement;
    private footerEl!: HTMLElement;

    // FEAT-29-14 templates-step state. Survives re-renders within the
    // wizard session but is not persisted -- the materialization itself
    // writes the chosen values into settings on advance.
    // FIX-42-01-02: the default follows the Obsidian app language instead
    // of pinning German. Unsupported template languages route through the
    // 'other' LLM-translation path with a prefilled language name.
    private templatesLang = FirstRunWizardModal.defaultTemplatesLang();
    private templatesCustomLang = FirstRunWizardModal.defaultTemplatesCustomLang();
    private templatesFolder = '';
    private templatesShouldMaterialize = true;

    constructor(app: App, private readonly plugin: ObsidianAgentPlugin) {
        super(app);
    }

    /** Template language preset from the Obsidian app language. */
    private static defaultTemplatesLang(): string {
        const locale = resolveLocale(getLanguage());
        if (locale === 'en') return locale;
        return 'other';
    }

    /** English language name prefilled for the 'other' translation route. */
    private static defaultTemplatesCustomLang(): string {
        const names: Partial<Record<SupportedLocale, string>> = {
            zh: 'Simplified Chinese',
            'zh-TW': 'Traditional Chinese',
        };
        return names[resolveLocale(getLanguage())] ?? '';
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('vault-operator-wizard');
        this.modalEl.setCssStyles({ maxWidth: '720px' });
        this.headerEl   = contentEl.createDiv({ cls: 'wizard-header' });
        this.progressEl = contentEl.createDiv({ cls: 'wizard-progress' });
        this.bodyEl     = contentEl.createDiv({ cls: 'wizard-body' });
        this.footerEl   = contentEl.createDiv({ cls: 'wizard-footer' });

        void this.renderStep();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async renderStep(): Promise<void> {
        const step = STEPS[this.stepIndex];

        this.headerEl.empty();
        this.headerEl.createEl('h2', { text: t(step.titleKey) });
        this.headerEl.createDiv({
            cls: 'wizard-step-counter',
            text: t('modal.firstRunWizard.stepCounter', { current: this.stepIndex + 1, total: STEPS.length }),
        });

        this.renderProgress();
        this.bodyEl.empty();
        this.footerEl.empty();

        await this.renderStepBody(step.id);
        this.renderFooter(step);
    }

    private renderProgress(): void {
        this.progressEl.empty();
        STEPS.forEach((_step, idx) => {
            this.progressEl.createDiv({
                cls: `wizard-progress-segment${idx <= this.stepIndex ? ' active' : ''}`,
            });
        });
    }

    private renderFooter(step: { id: StepId; canSkip: boolean }): void {
        const left = this.footerEl.createDiv({ cls: 'wizard-footer-left' });
        const right = this.footerEl.createDiv({ cls: 'wizard-footer-right' });

        if (this.stepIndex > 0 && step.id !== 'done') {
            const backBtn = left.createEl('button', { text: t('modal.firstRunWizard.backBtn') });
            backBtn.addEventListener('click', () => {
                this.stepIndex = Math.max(0, this.stepIndex - 1);
                void this.renderStep();
            });
        }

        if (step.id === 'welcome') {
            const dismissBtn = left.createEl('button', { text: t('modal.firstRunWizard.dontShowAgainBtn') });
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- event handler / callback returns Promise; errors handled inside
            dismissBtn.addEventListener('click', async () => {
                this.plugin.settings.onboarding.dontShowFirstRunAgain = true;
                await this.plugin.saveSettings();
                this.close();
            });
        }

        if (step.canSkip) {
            const skipBtn = right.createEl('button', { text: t('modal.firstRunWizard.skipStepBtn') });
            skipBtn.addEventListener('click', () => { void this.skipStep(); });
        }

        if (step.id === 'done') {
            const finishBtn = right.createEl('button', { cls: 'mod-cta', text: t('modal.firstRunWizard.startChatBtn') });
            finishBtn.addEventListener('click', () => { void this.finishAndStartChat(); });
            const closeBtn = right.createEl('button', { text: t('modal.vaultHealth.closeBtn') });
            closeBtn.addEventListener('click', () => { void this.finishWithoutChat(); });
        } else {
            const nextBtn = right.createEl('button', {
                cls: 'mod-cta',
                text: this.stepIndex === 0 ? t('modal.firstRunWizard.getStartedBtn') : t('modal.firstRunWizard.nextBtn'),
            });
            nextBtn.addEventListener('click', () => { void this.advance(); });
        }
    }

    private async skipStep(): Promise<void> {
        const step = STEPS[this.stepIndex];
        const skipped = this.plugin.settings.onboarding.skippedSteps as string[];
        if (!skipped.includes(step.id)) {
            skipped.push(step.id);
            await this.plugin.saveSettings();
        }
        await this.advance();
    }

    private async advance(): Promise<void> {
        // FEAT-29-14: if the user is leaving the templates step (not via
        // Skip) and asked for materialization, run it here before moving
        // on. Failures are surfaced as a Notice but do not block the
        // wizard -- the user can re-trigger via the VaultTab button.
        const currentStep = STEPS[this.stepIndex];
        if (currentStep.id === 'templates' && this.templatesShouldMaterialize) {
            await this.runTemplatesMaterialization();
        }
        if (this.stepIndex < STEPS.length - 1) {
            this.stepIndex++;
            await this.plugin.saveSettings();
            await this.renderStep();
        }
    }

    /**
     * AUDIT-024 M-1: human-readable provider name for the privacy
     * banner in the Templates step. Falls back to a generic label
     * when no model is configured yet.
     */
    private resolveActiveProviderName(): string {
        // REF-08: prefer providerConfigs[] (post-EPIC-26 canonical store).
        // Fall back to legacy activeModels[] for pre-migration installs.
        for (const p of this.plugin.settings.providerConfigs ?? []) {
            if (!p.enabled) continue;
            const dm = (p.discoveredModels ?? [])[0];
            if (!dm) continue;
            const name = dm.displayName ?? dm.id;
            return `${p.type} / ${name}`;
        }
        const active = this.plugin.settings.activeModels.find((m) => m.enabled !== false);
        if (!active) return t('modal.firstRunWizard.noProviderConfigured');
        const provider = (active as { provider?: string; type?: string }).provider
            ?? (active as { provider?: string; type?: string }).type
            ?? t('modal.firstRunWizard.unknownProvider');
        const name = (active as { displayName?: string; modelName?: string }).displayName
            ?? (active as { displayName?: string; modelName?: string }).modelName
            ?? t('modal.firstRunWizard.unknownModel');
        return `${provider} / ${name}`;
    }

    private async runTemplatesMaterialization(): Promise<void> {
        const folder = this.templatesFolder.trim();
        if (!folder) {
            new Notice(t('notice.templates.noFolder'));
            return;
        }
        const lang = this.templatesLang === 'other'
            ? this.templatesCustomLang.trim().toLowerCase() || 'en'
            : this.templatesLang;

        // `_generated/` is gitignored, so its exports are untyped at check time.
        const materializer = new TemplateMaterializer(
            this.app,
            castGenerated<Record<string, Record<string, string>>>(BUNDLED_NOTE_TEMPLATES),
        );
        const translator = (lang !== 'de' && lang !== 'en')
            ? makeTemplateTranslator(this.plugin)
            : undefined;

        try {
            const result = await materializer.materialize(folder, lang, { translator });
            this.applyTemplatePathsToSettings(folder, lang);
            const wn = result.written.length;
            const sk = result.skipped.length;
            const fl = result.failed.length;
            const summary = fl > 0
                ? t('notice.templates.materializeSummaryWithFailures', { written: wn, skipped: sk, failed: fl })
                : t('notice.templates.materializeSummary', { written: wn, skipped: sk });
            new Notice(summary);
            if (fl > 0) {
                console.warn('[templates] materialization failures:', result.failed);
            }
        } catch (e) {
            console.error('[templates] materialization failed:', e);
            new Notice(t('notice.templates.materializeFailed', { error: (e as Error).message ?? String(e) }));
        }
    }

    private applyTemplatePathsToSettings(_folder: string, lang: string): void {
        // FEAT-30-07: nur noch die Sprachwahl wird persistiert. Die vier
        // Template-Pfad-Settings sind entfernt (nie von Code gelesen).
        this.plugin.settings.vaultIngest.templates.templatesLanguage = lang;
    }

    private async finishAndStartChat(): Promise<void> {
        this.plugin.settings.onboarding.modalCompleted = true;
        await this.plugin.saveSettings();
        this.close();
        try {
            await this.plugin.startOnboarding();
        } catch (e) {
            console.warn('[FirstRunWizard] Could not start onboarding chat:', e);
        }
    }

    private async finishWithoutChat(): Promise<void> {
        this.plugin.settings.onboarding.modalCompleted = true;
        await this.plugin.saveSettings();
        this.close();
    }

    // -----------------------------------------------------------------------
    // Reusable building blocks (Settings-look)
    // -----------------------------------------------------------------------

    private addInfoBanner(parent: HTMLElement, icon: string, headline: string, body: string): HTMLElement {
        const banner = parent.createDiv({ cls: 'vault-op-box vault-op-box--intro' });
        const iconWrap = banner.createDiv({ cls: 'vault-op-box__icon' });
        setIcon(iconWrap, icon);
        const text = banner.createDiv({ cls: 'vault-op-box__text' });
        text.createEl('strong', { text: headline });
        text.createDiv({ text: body });
        return banner;
    }

    private addSection(parent: HTMLElement, title: string): void {
        parent.createEl('h3', { cls: 'wizard-section', text: title });
    }

    private addStatusLine(parent: HTMLElement, count: number, singularLabel: string, pluralLabel: string): HTMLElement {
        const cls = count > 0 ? 'wizard-status is-ok' : 'wizard-status is-empty';
        const status = parent.createDiv({ cls });
        const iconWrap = status.createDiv({ cls: 'wizard-status-icon' });
        setIcon(iconWrap, count > 0 ? 'check-circle-2' : 'circle');
        const text = status.createDiv();
        if (count > 0) {
            text.createEl('strong', {
                text: t('modal.firstRunWizard.statusConfigured', { count, label: count === 1 ? singularLabel : pluralLabel }),
            });
            text.createSpan({ text: ' ' + t('modal.firstRunWizard.statusCanSkip') });
        } else {
            text.createEl('strong', { text: t('modal.firstRunWizard.statusNoneConfigured', { label: singularLabel }) });
            text.createSpan({ text: ' ' + t('modal.firstRunWizard.statusPickOption') });
        }
        return status;
    }

    private addProviderCard(
        parent: HTMLElement,
        opts: { name: string; tier: 'free' | 'paid' | 'recommended'; tierLabel: string; url: string; note: string },
    ): void {
        const card = parent.createDiv({ cls: 'wizard-provider-card' });
        const header = card.createDiv({ cls: 'wizard-provider-header' });
        header.createDiv({ cls: 'wizard-provider-name', text: opts.name });
        const badge = header.createSpan({ cls: `wizard-provider-badge is-${opts.tier}`, text: opts.tierLabel });
        badge.setAttr('title', opts.tierLabel);
        card.createDiv({ cls: 'wizard-provider-note', text: opts.note });
        if (opts.url) {
            const link = card.createEl('a', { cls: 'wizard-provider-link', text: t('modal.firstRunWizard.getApiKeyLink'), href: opts.url });
            link.setAttr('target', '_blank');
            link.setAttr('rel', 'noopener noreferrer');
        }
    }

    // -----------------------------------------------------------------------
    // Step bodies
    // -----------------------------------------------------------------------

    private async renderStepBody(id: StepId): Promise<void> {
        switch (id) {
            case 'welcome':             return this.renderWelcome();
            case 'llm-model':           return this.renderLlmStep();
            case 'embedding-model':     return this.renderEmbeddingStep();
            case 'search-provider':     return this.renderSearchProviderStep();
            case 'templates':           return this.renderTemplatesStep();
            case 'optional-downloads':  return this.renderOptionalDownloadsStep();
            case 'done':                return this.renderDoneStep();
        }
    }

    private renderWelcome(): void {
        this.addInfoBanner(
            this.bodyEl,
            'sparkles',
            t('modal.firstRunWizard.welcomeTitle'),
            t('modal.firstRunWizard.welcomeBody'),
        );

        this.addSection(this.bodyEl, t('modal.firstRunWizard.welcomeWhatItDoes'));

        const list = this.bodyEl.createEl('ul');
        list.setCssStyles({ paddingLeft: '20px' });
        list.setCssStyles({ margin: '4px 0 8px 0' });
        list.setCssStyles({ lineHeight: '1.7' });
        const items = [
            t('modal.firstRunWizard.welcomeItemLlm'),
            t('modal.firstRunWizard.welcomeItemEmbedding'),
            t('modal.firstRunWizard.welcomeItemSplit'),
            t('modal.firstRunWizard.welcomeItemSearch'),
            t('modal.firstRunWizard.welcomeItemDownloads'),
        ];
        for (const item of items) {
            list.createEl('li', { text: item });
        }

        const note = this.bodyEl.createDiv();
        note.setCssStyles({ fontSize: '12px' });
        note.setCssStyles({ color: 'var(--text-muted)' });
        note.setCssStyles({ marginTop: '16px' });
        note.setText(t('modal.firstRunWizard.welcomePrivacyNote'));
    }

    // eslint-disable-next-line @typescript-eslint/require-await -- kept async for caller type consistency
    private async renderLlmStep(): Promise<void> {
        this.addInfoBanner(
            this.bodyEl,
            'brain',
            t('modal.firstRunWizard.llmWhyTitle'),
            t('modal.firstRunWizard.llmWhyBody'),
        );

        this.addSection(this.bodyEl, t('modal.firstRunWizard.currentStatus'));
        const renderStatus = (parent: HTMLElement): HTMLElement => {
            // REF-08: count enabled provider models from providerConfigs[]
            // (post-EPIC-26 canonical store); fall back to activeModels[]
            // for pre-migration installs.
            const providerCount = (this.plugin.settings.providerConfigs ?? [])
                .filter((p) => p.enabled)
                .reduce((sum, p) => sum + (p.discoveredModels?.length ?? 0), 0);
            const legacyCount = this.plugin.settings.activeModels.filter(m => m.enabled).length;
            const count = providerCount > 0 ? providerCount : legacyCount;
            return this.addStatusLine(parent, count, t('modal.firstRunWizard.stepLlmModel'), t('modal.firstRunWizard.llmModelsPlural'));
        };
        const statusWrap = this.bodyEl.createDiv();
        let statusEl = renderStatus(statusWrap);
        const refresh = () => {
            statusEl.remove();
            statusEl = renderStatus(statusWrap);
        };

        this.addSection(this.bodyEl, t('modal.firstRunWizard.llmWhereToGetKey'));

        this.addProviderCard(this.bodyEl, {
            name: t('modal.firstRunWizard.providerGeminiName'),
            tier: 'free',
            tierLabel: t('modal.firstRunWizard.tierFree'),
            url: 'https://aistudio.google.com/app/apikey',
            note: t('modal.firstRunWizard.providerGeminiNote'),
        });
        this.addProviderCard(this.bodyEl, {
            name: t('modal.firstRunWizard.providerClaudeName'),
            tier: 'paid',
            tierLabel: t('modal.firstRunWizard.tierPaid'),
            url: 'https://console.anthropic.com/settings/keys',
            note: t('modal.firstRunWizard.providerClaudeNote'),
        });
        this.addProviderCard(this.bodyEl, {
            name: t('modal.firstRunWizard.providerOpenaiName'),
            tier: 'paid',
            tierLabel: t('modal.firstRunWizard.tierPaid'),
            url: 'https://platform.openai.com/api-keys',
            note: t('modal.firstRunWizard.providerOpenaiNote'),
        });
        this.addProviderCard(this.bodyEl, {
            name: t('modal.firstRunWizard.providerOllamaName'),
            tier: 'free',
            tierLabel: t('modal.firstRunWizard.tierFreeLocal'),
            url: 'https://ollama.com',
            note: t('modal.firstRunWizard.providerOllamaNote'),
        });

        const actionRow = this.bodyEl.createDiv({ cls: 'wizard-action-row' });
        const addBtn = actionRow.createEl('button', { cls: 'mod-cta', text: t('modal.modelConfig.addModel') });
        addBtn.addEventListener('click', () => {
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- event handler / callback returns Promise; errors handled inside
            new ModelConfigModal(this.app, null, async (newModel: CustomModel) => {
                // FIX-26-99-03 (issue #48 point 1): write to the canonical
                // providerConfigs[] store. The legacy activeModels[] push
                // (without schemaVersion) made the one-shot migration run on
                // the next load and show the MigrationNotificationModal right
                // after first setup.
                applyWizardModelToProviderConfigs(this.plugin.settings, newModel);
                await this.plugin.saveSettings();
                refresh();
            }, false).open();
        });
    }

    // eslint-disable-next-line @typescript-eslint/require-await -- kept async for caller type consistency
    private async renderEmbeddingStep(): Promise<void> {
        this.addInfoBanner(
            this.bodyEl,
            'search',
            t('modal.firstRunWizard.embeddingWhyTitle'),
            t('modal.firstRunWizard.embeddingWhyBody'),
        );

        this.addSection(this.bodyEl, t('modal.firstRunWizard.currentStatus'));
        const renderStatus = (parent: HTMLElement): HTMLElement => {
            const count = (this.plugin.settings.embeddingModels ?? []).filter(m => m.enabled).length;
            return this.addStatusLine(parent, count, t('modal.firstRunWizard.embeddingModelSingular'), t('modal.firstRunWizard.embeddingModelsPlural'));
        };
        const statusWrap = this.bodyEl.createDiv();
        let statusEl = renderStatus(statusWrap);
        const refresh = () => {
            statusEl.remove();
            statusEl = renderStatus(statusWrap);
        };

        this.addSection(this.bodyEl, t('modal.firstRunWizard.embeddingRecommendedProviders'));

        this.addProviderCard(this.bodyEl, {
            name: t('modal.firstRunWizard.embeddingOpenaiName'),
            tier: 'paid',
            tierLabel: t('modal.firstRunWizard.tierCheap'),
            url: 'https://platform.openai.com/api-keys',
            note: t('modal.firstRunWizard.embeddingOpenaiNote'),
        });
        this.addProviderCard(this.bodyEl, {
            name: t('modal.firstRunWizard.embeddingGoogleName'),
            tier: 'free',
            tierLabel: t('modal.firstRunWizard.tierFree'),
            url: 'https://aistudio.google.com/app/apikey',
            note: t('modal.firstRunWizard.embeddingGoogleNote'),
        });
        this.addProviderCard(this.bodyEl, {
            name: t('modal.firstRunWizard.providerOllamaName'),
            tier: 'free',
            tierLabel: t('modal.firstRunWizard.tierFreeLocal'),
            url: 'https://ollama.com',
            note: t('modal.firstRunWizard.embeddingOllamaNote'),
        });

        const actionRow = this.bodyEl.createDiv({ cls: 'wizard-action-row' });
        const addBtn = actionRow.createEl('button', { cls: 'mod-cta', text: t('modal.modelConfig.addEmbedding') });
        addBtn.addEventListener('click', () => {
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- event handler / callback returns Promise; errors handled inside
            new ModelConfigModal(this.app, null, async (newModel: CustomModel) => {
                if (!this.plugin.settings.embeddingModels) this.plugin.settings.embeddingModels = [];
                this.plugin.settings.embeddingModels.push(newModel);
                if (!this.plugin.settings.activeEmbeddingModelKey) {
                    this.plugin.settings.activeEmbeddingModelKey = getModelKey(newModel);
                }
                await this.plugin.saveSettings();
                refresh();
            }, true).open();
        });
    }

    private renderSearchProviderStep(): void {
        this.addInfoBanner(
            this.bodyEl,
            'globe',
            t('modal.firstRunWizard.searchWhyTitle'),
            t('modal.firstRunWizard.searchWhyBody'),
        );

        this.addSection(this.bodyEl, t('modal.firstRunWizard.searchPickProvider'));

        const providers: { id: 'tavily' | 'brave' | 'none'; label: string; tier: 'free' | 'paid' | 'recommended'; tierLabel: string; url: string; note: string }[] = [
            {
                id: 'tavily',
                label: t('modal.firstRunWizard.searchTavilyName'),
                tier: 'free',
                tierLabel: t('modal.firstRunWizard.searchTavilyTier'),
                url: 'https://app.tavily.com',
                note: t('modal.firstRunWizard.searchTavilyNote'),
            },
            {
                id: 'brave',
                label: t('modal.firstRunWizard.searchBraveName'),
                tier: 'free',
                tierLabel: t('modal.firstRunWizard.searchBraveTier'),
                url: 'https://api.search.brave.com/app/keys',
                note: t('modal.firstRunWizard.searchBraveNote'),
            },
            {
                id: 'none',
                label: t('modal.firstRunWizard.searchNoneName'),
                tier: 'paid',
                tierLabel: t('modal.firstRunWizard.searchNoneTier'),
                url: '',
                note: t('modal.firstRunWizard.searchNoneNote'),
            },
        ];

        const wt = this.plugin.settings.webTools;
        let currentProvider: 'tavily' | 'brave' | 'none' = wt.provider ?? 'none';
        const keyRowsByProvider: Record<string, HTMLElement> = {};

        for (const p of providers) {
            const card = this.bodyEl.createDiv({ cls: 'wizard-provider-card' });

            const radioRow = card.createDiv({ cls: 'wizard-radio-row' });
            const radio = radioRow.createEl('input', { type: 'radio' });
            radio.name = 'search-provider';
            radio.value = p.id;
            radio.checked = currentProvider === p.id;
            const label = radioRow.createEl('label');

            const header = label.createDiv({ cls: 'wizard-provider-header' });
            header.createDiv({ cls: 'wizard-provider-name', text: p.label });
            header.createSpan({ cls: `wizard-provider-badge is-${p.tier}`, text: p.tierLabel });

            label.createDiv({ cls: 'wizard-provider-note', text: p.note });
            label.addEventListener('click', () => { radio.checked = true; radio.dispatchEvent(new Event('change')); });

            if (p.id !== 'none') {
                const link = card.createEl('a', { cls: 'wizard-provider-link', text: t('modal.firstRunWizard.getProviderApiKeyLink', { provider: p.label }), href: p.url });
                link.setAttr('target', '_blank');
                link.setAttr('rel', 'noopener noreferrer');

                const keyRow = card.createDiv({ cls: 'wizard-keyrow' });
                const input = keyRow.createEl('input', { type: 'password', placeholder: t('modal.firstRunWizard.providerApiKeyPlaceholder', { provider: p.label }) });
                input.value = p.id === 'tavily' ? (wt.tavilyApiKey ?? '') : (wt.braveApiKey ?? '');
                // eslint-disable-next-line @typescript-eslint/no-misused-promises -- event handler / callback returns Promise; errors handled inside
                input.addEventListener('input', async () => {
                    if (p.id === 'tavily') wt.tavilyApiKey = input.value.trim();
                    else if (p.id === 'brave') wt.braveApiKey = input.value.trim();
                    await this.plugin.saveSettings();
                });
                keyRow.setCssStyles({ display: currentProvider === p.id ? '' : 'none' });
                keyRowsByProvider[p.id] = keyRow;
            }

            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- event handler / callback returns Promise; errors handled inside
            radio.addEventListener('change', async () => {
                if (!radio.checked) return;
                currentProvider = p.id;
                wt.provider = p.id;
                wt.enabled = p.id !== 'none';
                await this.plugin.saveSettings();
                for (const [pid, row] of Object.entries(keyRowsByProvider)) {
                    row.setCssStyles({ display: (pid === currentProvider) ? '' : 'none' });
                }
            });
        }
    }

    private async renderTemplatesStep(): Promise<void> {
        this.addInfoBanner(
            this.bodyEl,
            'file-text',
            t('modal.firstRunWizard.templatesWhyTitle'),
            t('modal.firstRunWizard.templatesWhyBody'),
        );

        // ---- Auto-detect target folder ----
        if (!this.templatesFolder) {
            const detected = await resolveCoreTemplatesFolder(this.app);
            this.templatesFolder = detected ?? '';
        }

        this.addSection(this.bodyEl, t('modal.firstRunWizard.templatesFolderSection'));
        const folderRow = this.bodyEl.createDiv({ cls: 'wizard-action-row' });
        const folderInput = folderRow.createEl('input', {
            type: 'text',
            value: this.templatesFolder,
            placeholder: t('modal.firstRunWizard.templatesFolderPlaceholder'),
        });
        folderInput.setCssStyles({ flex: '1 1 auto' });
        folderInput.addEventListener('change', () => {
            this.templatesFolder = folderInput.value.trim();
        });
        folderInput.addEventListener('input', () => {
            this.templatesFolder = folderInput.value.trim();
        });
        const folderHint = this.bodyEl.createDiv();
        folderHint.setCssStyles({ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' });
        folderHint.setText(
            this.templatesFolder
                ? t('modal.firstRunWizard.templatesFolderDetectedHint')
                : t('modal.firstRunWizard.templatesFolderMissingHint'),
        );

        // ---- Language picker ----
        this.addSection(this.bodyEl, t('modal.firstRunWizard.templatesLanguageSection'));
        const langWrap = this.bodyEl.createDiv({ cls: 'wizard-action-row' });
        const langSelect = langWrap.createEl('select');
        const options: Array<{ value: string; label: string }> = [
            { value: 'en', label: t('modal.firstRunWizard.templatesLangEnglish') },
            { value: 'de', label: t('modal.firstRunWizard.templatesLangGerman') },
            { value: 'other', label: t('modal.firstRunWizard.templatesLangOther') },
        ];
        for (const opt of options) {
            const o = langSelect.createEl('option', { value: opt.value, text: opt.label });
            if (opt.value === this.templatesLang) o.selected = true;
        }

        const customWrap = this.bodyEl.createDiv();
        customWrap.setCssStyles({ marginTop: '8px' });
        const customInput = customWrap.createEl('input', {
            type: 'text',
            value: this.templatesCustomLang,
            placeholder: t('modal.firstRunWizard.templatesCustomLangPlaceholder'),
        });
        customInput.setCssStyles({ width: '100%' });
        customInput.addEventListener('input', () => {
            this.templatesCustomLang = customInput.value.trim();
        });
        const customHint = customWrap.createDiv();
        customHint.setCssStyles({ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' });
        customHint.setText(t('modal.firstRunWizard.templatesCustomLangHint'));

        // AUDIT-024 M-1: explicit consent banner whenever the language
        // is "Other" because that triggers an LLM round-trip with the
        // bundled template content as input. Banner names the provider
        // so the user can decide before clicking Next.
        const privacyBanner = customWrap.createDiv({ cls: 'vault-op-box vault-op-box--intro' });
        privacyBanner.setCssStyles({ marginTop: '8px' });
        const privacyIcon = privacyBanner.createSpan({ cls: 'vault-op-box__icon' });
        setIcon(privacyIcon, 'shield');
        const privacyText = privacyBanner.createDiv({ cls: 'vault-op-box__text' });
        privacyText.createEl('strong', { text: t('modal.firstRunWizard.templatesPrivacyTitle') });
        const activeProviderName = this.resolveActiveProviderName();
        privacyText.createDiv({
            text: t('modal.firstRunWizard.templatesPrivacyBody', { provider: activeProviderName }),
        });

        const setCustomVisibility = () => {
            customWrap.setCssStyles({ display: this.templatesLang === 'other' ? '' : 'none' });
        };
        setCustomVisibility();
        langSelect.addEventListener('change', () => {
            this.templatesLang = langSelect.value;
            setCustomVisibility();
        });

        // ---- Materialize-now toggle ----
        new Setting(this.bodyEl)
            .setName(t('modal.firstRunWizard.templatesMaterializeNow'))
            .setDesc(t('modal.firstRunWizard.templatesMaterializeNowDesc'))
            .addToggle((toggle) => toggle
                .setValue(this.templatesShouldMaterialize)
                .onChange((v) => { this.templatesShouldMaterialize = v; }),
            );
    }

    private async renderOptionalDownloadsStep(): Promise<void> {
        this.addInfoBanner(
            this.bodyEl,
            'download',
            t('modal.firstRunWizard.downloadsTitle'),
            t('modal.firstRunWizard.downloadsBody'),
        );

        const { OptionalAssetManager, buildRerankerSpec, buildRerankerJsBundleSpec, buildSelfDevSourceSpec, buildOfficeBundleSpec, buildPdfjsBundleSpec } = await import('../../core/assets/OptionalAssetManager');
        const { RERANKER_WASM_SHA256, OFFICE_BUNDLE_SHA256, PDFJS_BUNDLE_SHA256, RERANKER_JS_BUNDLE_SHA256 } = await import('../../core/assets/assetHashes');
        const { SELF_DEV_SOURCE_SHA256 } = castGenerated<{ SELF_DEV_SOURCE_SHA256: string }>(
            await import('../../_generated/source-hash'),
        );

        const manager = new OptionalAssetManager(this.plugin);
        const items: {
            label: string;
            recommended: boolean;
            what: string;
            size: string;
            sha: string;
            spec: ReturnType<typeof buildRerankerSpec>;
        }[] = [
            {
                label: t('modal.firstRunWizard.assetOfficeName'),
                recommended: true,
                what: t('modal.firstRunWizard.assetOfficeDesc'),
                size: '1.7 MB',
                sha: OFFICE_BUNDLE_SHA256,
                spec: buildOfficeBundleSpec(this.plugin.manifest.version, OFFICE_BUNDLE_SHA256),
            },
            {
                label: t('settings.optionalAssets.headingPdf'),
                recommended: true,
                what: t('modal.firstRunWizard.assetPdfDesc'),
                size: '1.6 MB',
                sha: PDFJS_BUNDLE_SHA256,
                spec: buildPdfjsBundleSpec(this.plugin.manifest.version, PDFJS_BUNDLE_SHA256),
            },
            {
                label: t('modal.firstRunWizard.assetRerankerLibName'),
                recommended: true,
                what: t('modal.firstRunWizard.assetRerankerLibDesc'),
                size: '0.6 MB',
                sha: RERANKER_JS_BUNDLE_SHA256,
                spec: buildRerankerJsBundleSpec(this.plugin.manifest.version, RERANKER_JS_BUNDLE_SHA256),
            },
            {
                label: t('modal.firstRunWizard.assetRerankerName'),
                recommended: true,
                what: t('modal.firstRunWizard.assetRerankerDesc'),
                size: '12 MB',
                sha: RERANKER_WASM_SHA256,
                spec: buildRerankerSpec(this.plugin.manifest.version, RERANKER_WASM_SHA256),
            },
            {
                label: t('settings.optionalAssets.headingSelfDev'),
                recommended: false,
                what: t('modal.firstRunWizard.assetSelfDevDesc'),
                size: '5 MB',
                sha: SELF_DEV_SOURCE_SHA256,
                spec: buildSelfDevSourceSpec(this.plugin.manifest.version, SELF_DEV_SOURCE_SHA256),
            },
        ];

        for (const item of items) {
            const card = this.bodyEl.createDiv({
                cls: item.recommended ? 'wizard-provider-card is-recommended' : 'wizard-provider-card',
            });

            const header = card.createDiv({ cls: 'wizard-provider-header' });
            header.createDiv({ cls: 'wizard-provider-name', text: `${item.label} (${item.size})` });
            if (item.recommended) {
                header.createSpan({ cls: 'wizard-provider-badge is-recommended', text: t('modal.firstRunWizard.badgeRecommended') });
            }

            card.createDiv({ cls: 'wizard-provider-note', text: item.what });

            const statusEl = card.createDiv({ cls: 'wizard-asset-status' });
            const actions = card.createDiv({ cls: 'wizard-asset-actions' });
            const installBtn = actions.createEl('button', { cls: 'mod-cta', text: t('modal.firstRunWizard.installBtn') });
            const fileBtn = actions.createEl('button', { text: t('modal.firstRunWizard.installFromFileBtn') });
            fileBtn.setAttr('title', t('modal.firstRunWizard.installFromFileTooltip'));
            const removeBtn = actions.createEl('button', { text: t('settings.providers.remove') });

            const refreshStatus = async () => {
                statusEl.empty();
                statusEl.className = 'wizard-asset-status';
                if (!item.sha) {
                    statusEl.classList.add('is-missing');
                    setIcon(statusEl.createDiv(), 'circle');
                    statusEl.createSpan({ text: t('modal.firstRunWizard.assetNotAvailableDev') });
                    installBtn.disabled = true;
                    installBtn.setCssStyles({ display: '' });
                    removeBtn.setCssStyles({ display: 'none' });
                    return;
                }
                const snap = await manager.snapshot(item.spec);
                if (snap.status === 'installed') {
                    statusEl.classList.add('is-installed');
                    setIcon(statusEl.createDiv(), 'check-circle-2');
                    statusEl.createSpan({ text: t('modal.firstRunWizard.assetInstalled') });
                    // Hide the Install button when the asset is healthy --
                    // clicking it would attempt a fresh download that just
                    // burns bandwidth or hits 404 on releases that do not
                    // ship this asset yet.
                    installBtn.setCssStyles({ display: 'none' });
                    removeBtn.setCssStyles({ display: '' });
                } else if (snap.status === 'outdated') {
                    statusEl.classList.add('is-outdated');
                    setIcon(statusEl.createDiv(), 'circle-alert');
                    statusEl.createSpan({ text: t('modal.firstRunWizard.assetOutdated') });
                    installBtn.setText(t('modal.firstRunWizard.reinstallBtn'));
                    installBtn.setCssStyles({ display: '' });
                    removeBtn.setCssStyles({ display: '' });
                } else {
                    statusEl.classList.add('is-missing');
                    setIcon(statusEl.createDiv(), 'circle');
                    statusEl.createSpan({ text: t('modal.firstRunWizard.assetNotInstalled') });
                    installBtn.setText(t('modal.firstRunWizard.installBtn'));
                    installBtn.setCssStyles({ display: '' });
                    removeBtn.setCssStyles({ display: 'none' });
                }
            };
            await refreshStatus();

            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- event handler / callback returns Promise; errors handled inside
            installBtn.addEventListener('click', async () => {
                installBtn.disabled = true;
                installBtn.setText(t('modal.firstRunWizard.downloadingBtn'));
                try {
                    await manager.install(item.spec);
                    new Notice(t('notice.assets.installed', { label: item.label }));
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    new Notice(t('notice.assets.installFailed', { error: msg }), 10_000);
                } finally {
                    installBtn.disabled = false;
                    await refreshStatus();
                }
            });

            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- event handler / callback returns Promise; errors handled inside
            removeBtn.addEventListener('click', async () => {
                try {
                    await manager.remove(item.spec);
                    new Notice(t('notice.assets.removed', { name: item.label }));
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    new Notice(t('notice.assets.removeFailed', { error: msg }));
                } finally {
                    await refreshStatus();
                }
            });

            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- event handler / callback returns Promise; errors handled inside
            fileBtn.addEventListener('click', async () => {
                const { pickAndInstallAsset } = await import('../settings/installFromFile');
                pickAndInstallAsset(manager, item.spec, refreshStatus);
            });
        }
    }

    private renderDoneStep(): void {
        this.addInfoBanner(
            this.bodyEl,
            'check-circle-2',
            t('modal.firstRunWizard.doneTitle'),
            t('modal.firstRunWizard.doneBody'),
        );

        const p = (text: string): HTMLElement => {
            const el = this.bodyEl.createEl('p');
            el.setText(text);
            return el;
        };
        p(t('modal.firstRunWizard.doneSkipChatNote'));

        const skipped = this.plugin.settings.onboarding.skippedSteps;
        if (skipped && skipped.length > 0) {
            const note = this.bodyEl.createDiv({ cls: 'wizard-skip-list' });
            const label = skipped.map(id => {
                const step = STEPS.find(s => s.id === id);
                return step ? t(step.titleKey) : id;
            }).join(', ');
            note.createEl('strong', { text: t('modal.firstRunWizard.doneYouSkipped') + ' ' });
            note.createSpan({ text: label + '. ' + t('modal.firstRunWizard.doneRevisitHint') });
        }
    }
}
