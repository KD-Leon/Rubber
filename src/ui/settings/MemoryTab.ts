/**
 * MemoryTab — Settings sub-tab under Agent Behaviour
 *
 * Sections:
 * 1. Memory (master toggle, auto-extract toggles)
 * 2. Memory Model (dropdown from activeModels[])
 * 3. Extraction Threshold (slider 2-20)
 * 4. Chat History (enable toggle, clear button)
 * 5. Memory Files (stats, view, reset)
 */

import { App, Notice, Setting, setIcon } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { getModelKey } from '../../types/settings';
import type { CustomModel } from '../../types/settings';
import { OnboardingService } from '../../core/memory/OnboardingService';
import { expandProviderConfigsToCustomModels } from '../../core/settings/expandProviderConfigs';
import { t } from '../../i18n';
import { addSectionHeading, addSliderInput } from './utils';
import { confirmModal } from '../modals/PromptModal';
import { FactStore } from '../../core/memory/FactStore';
import { CommunicationStyleStore } from '../../core/memory/CommunicationStyleStore';
import { MemoryAtomizer } from '../../core/memory/MemoryAtomizer';
import {
    MemoryV2UpgradeOrchestrator,
    type UpgradeReport,
} from '../../core/memory/MemoryV2UpgradeOrchestrator';
import type { MigrationReport } from '../../core/memory/MemoryMigrationJob';
import {
    DEFAULT_CROSS_SURFACE_SETTINGS,
    SOURCE_INTERFACES,
    type SyncMode,
    type PerProviderSyncOverride,
    type SourceInterface,
} from '../../core/memory/SourceInterface';

export class MemoryTab {
    /**
     * Local UI state: which model the user picked for the v2 migration.
     * Defaults to the memory-model key on tab open. Reset on tab rebuild --
     * this is a one-shot decision, not worth persisting in plugin settings.
     */
    private migrationModelKey: string;

    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {
        this.migrationModelKey = plugin.settings.memory.memoryModelKey ?? '';
    }

    private buildHeader(containerEl: HTMLElement): void {
        const header = containerEl.createDiv('agent-settings-header');
        header.createEl('h3', { text: '智能记忆与会话历史', cls: 'agent-settings-title' });
        header.createEl('p', {
            text: 'AI 智能体会随着日常对话逐步记住你的偏好、知识背景和常用指令，并在后续回答中自动参考。',
            cls: 'agent-settings-desc',
        });
    }

    build(containerEl: HTMLElement): void {
        this.buildHeader(containerEl);

        const mem = this.plugin.settings.memory;

        // ── 🧠 长期记忆管理 ─────────────────────────────────────────────
        const memorySection = containerEl.createDiv('agent-memory-core');
        addSectionHeading(
            memorySection,
            '长期记忆（Memory）',
            { body: '允许 AI 提炼并长期记住你的个人习惯、背景信息与指令偏好。' },
        );

        new Setting(memorySection)
            .setName('启用长期记忆')
            .setDesc('开启后，AI 将在对话中自动检索并应用相关的历史记忆。')
            .addToggle((t) =>
                t.setValue(mem.enabled).onChange(async (v) => {
                    this.plugin.settings.memory.enabled = v;
                    await this.plugin.saveSettings();
                    this.rerender();
                }),
            );

        if (mem.enabled) {
            new Setting(memorySection)
                .setName('自动从对话中提炼记忆')
                .setDesc('在对话进行一段后，自动提取有价值的偏好与事实存入记忆库。')
                .addToggle((t) =>
                    t.setValue(mem.autoExtractSessions).onChange(async (v) => {
                        this.plugin.settings.memory.autoExtractSessions = v;
                        await this.plugin.saveSettings();
                        this.rerender();
                    }),
                );

            // 查看与管理记忆库
            new Setting(memorySection)
                .setName('查看与管理记忆库')
                .setDesc('浏览、搜索并管理 AI 目前记住的所有事实与习惯。')
                .addButton((b) =>
                    b.setButtonText('查看记忆库').onClick(async () => {
                        const { MemoryViewerModal } = await import('../modals/MemoryViewerModal');
                        new MemoryViewerModal(this.app, this.plugin).open();
                    }),
                );

            // 清空记忆库
            new Setting(memorySection)
                .setName('清空所有记忆')
                .setDesc('一键清除 AI 记住的所有个人偏好与事实数据（不可撤回）。')
                .addButton((b) => {
                    b.setButtonText('清空记忆');
                    b.setWarning();
                    b.onClick(async () => {
                        const { confirmAndWipeAllMemory } = await import('../modals/wipeAllMemory');
                        await confirmAndWipeAllMemory(this.app, this.plugin);
                        this.rerender();
                    });
                });
        }

        // ── 💬 会话历史管理 ─────────────────────────────────────────────
        const historySection = containerEl.createDiv('agent-history-core');
        addSectionHeading(
            historySection,
            '会话历史记录',
            { body: '管理本地侧边栏的所有对话会话记录。' },
        );

        new Setting(historySection)
            .setName('保存会话历史')
            .setDesc('允许在关闭 Obsidian 或切换主题后继续恢复之前的对话。')
            .addToggle((t) =>
                t.setValue(this.plugin.settings.enableChatHistory).onChange(async (v) => {
                    this.plugin.settings.enableChatHistory = v;
                    await this.plugin.saveSettings();
                }),
            );

        const store = this.plugin.conversationStore;
        if (store) {
            const count = store.count();
            new Setting(historySection)
                .setName('已存储的对话')
                .setDesc(`当前已保存 ${count} 个会话。`)
                .addButton((b) =>
                    b.setButtonText('清空全部对话').onClick(async () => {
                        const ok = await confirmModal(this.app, {
                            title: '清空所有会话历史',
                            message: '确定要删除所有的历史对话记录吗？此操作无法撤销。',
                            confirmLabel: '确认清空',
                            cancelLabel: '取消',
                        });
                        if (!ok) return;
                        await store.deleteAll();
                        new Notice('所有会话历史已清空');
                        this.rerender();
                    }),
                );
        }

        // ── ⚙️ 高级配置与向导（折叠收纳） ─────────────────────────
        const advancedDetails = containerEl.createEl('details', { cls: 'agent-permissions-advanced' });
        advancedDetails.createEl('summary', { text: '⚙️ 高级提取规则与向导（点击展开）' });
        const advancedBody = advancedDetails.createDiv('agent-permissions-advanced-body');

        if (mem.enabled && mem.autoExtractSessions) {
            const minMessagesSetting = new Setting(advancedBody)
                .setName('自动提取触发阈值（消息数）')
                .setDesc('单次对话中最少达到多少条消息后才开始提炼记忆。');
            addSliderInput(minMessagesSetting, {
                min: 2, max: 20, step: 1,
                value: mem.extractionThreshold,
                onChange: async (v) => {
                    this.plugin.settings.memory.extractionThreshold = v;
                    await this.plugin.saveSettings();
                },
            });
        }

        // 偏好向导
        const memService = this.plugin.memoryService;
        if (memService) {
            const onboarding = new OnboardingService(memService, this.plugin);
            const isComplete = !onboarding.needsOnboarding();

            const setupSetting = new Setting(advancedBody)
                .setName('用户偏好初始化向导')
                .setDesc(isComplete ? '你已完成初始偏好设置。' : '尚未进行偏好初始化向导。');

            setupSetting.addButton((b) =>
                b.setButtonText(isComplete ? '重新运行向导' : '开始向导').onClick(async () => {
                    await onboarding.reset();
                    this.plugin.settings.onboarding.modalCompleted = false;
                    await this.plugin.saveSettings();
                    this.app.setting?.close();
                    const { FirstRunWizardModal } = await import('../modals/FirstRunWizardModal');
                    new FirstRunWizardModal(this.app, this.plugin).open();
                }),
            );
        }

        // 跨端同步 (仅在高级中折叠展示)
        this.buildCrossSurfaceSection(advancedBody);

        // v2 迁移 (若存在)
        const v2Status = this.plugin.settings.memory.v2MigrationStatus;
        if (v2Status === 'pending' || v2Status === 'skipped') {
            this.buildMemoryV2MigrationSection(advancedBody);
        }
    }

    /**
     * BA-26 / FEAT-23-04: Cross-Surface Sync settings (global default
     * + per-provider override).
     */
    private buildCrossSurfaceSection(containerEl: HTMLElement): void {
        const remoteMcpEnabled = this.plugin.settings.enableMcpServer ?? false;
        if (!remoteMcpEnabled) {
            return;
        }

        addSectionHeading(
            containerEl,
            '跨平台记忆同步（Cross-Surface Sync）',
            { body: '允许其他客户端或 MCP 连接器与当前知识库同步记忆。' },
        );

        // Ensure settings block exists
        if (!this.plugin.settings.memory.crossSurface) {
            this.plugin.settings.memory.crossSurface = { ...DEFAULT_CROSS_SURFACE_SETTINGS };
        }
        const cs = this.plugin.settings.memory.crossSurface;
        // Defensive Init der Sub-Objekte (gleicher Bug-Klasse wie VaultTab
        // 2026-05-04: shallow Object.assign in loadSettings ueberschreibt
        // memory.crossSurface komplett wenn es im persistenten data.json
        // existiert, neue Felder fehlen dann.).
        if (!cs.perProvider) cs.perProvider = { ...DEFAULT_CROSS_SURFACE_SETTINGS.perProvider };
        if (cs.livingDocumentByDefault === undefined) cs.livingDocumentByDefault = true;
        if (cs.strictSourceIsolation === undefined) cs.strictSourceIsolation = false;
        if (!cs.defaultSyncMode) cs.defaultSyncMode = 'auto';

        new Setting(containerEl)
            .setName(t('settings.memory.defaultSyncMode'))
            .setDesc(t('settings.memory.defaultSyncModeDesc'))
            .addDropdown((d) => {
                d.addOption('auto', t('settings.memory.syncModeAuto'));
                d.addOption('manual', t('settings.memory.syncModeManual'));
                d.setValue(cs.defaultSyncMode);
                d.onChange(async (v) => {
                    cs.defaultSyncMode = v as SyncMode;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName(t('settings.memory.livingDocument'))
            .setDesc(t('settings.memory.livingDocumentDesc'))
            .addToggle((t) => {
                t.setValue(cs.livingDocumentByDefault ?? true);
                t.onChange(async (v) => {
                    cs.livingDocumentByDefault = v;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName(t('settings.memory.strictIsolation'))
            .setDesc(t('settings.memory.strictIsolationDesc'))
            .addToggle((t) => {
                t.setValue(cs.strictSourceIsolation ?? false);
                t.onChange(async (v) => {
                    cs.strictSourceIsolation = v;
                    await this.plugin.saveSettings();
                });
            });

        // Per-source overrides
        const PROVIDER_LABELS: Record<SourceInterface, string> = {
            'obsilo': t('settings.memory.sourceObsilo'),
            'claude-ai': t('settings.memory.sourceClaudeAi'),
            'claude-code': t('settings.memory.sourceClaudeCode'),
            'chatgpt': t('settings.memory.sourceChatgpt'),
            'perplexity': t('settings.memory.sourcePerplexity'),
            'unknown': t('settings.memory.sourceUnknown'),
        };
        for (const provider of SOURCE_INTERFACES) {
            new Setting(containerEl)
                .setName(PROVIDER_LABELS[provider])
                .addDropdown((d) => {
                    d.addOption('global', t('settings.memory.syncModeGlobal'));
                    d.addOption('auto', t('settings.memory.syncModeAuto'));
                    d.addOption('manual', t('settings.memory.syncModeManual'));
                    const current = cs.perProvider[provider] ?? 'global';
                    d.setValue(current);
                    d.onChange(async (v) => {
                        cs.perProvider[provider] = v as PerProviderSyncOverride;
                        await this.plugin.saveSettings();
                    });
                });
        }
    }

    private buildSoulSection(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            t('settings.memory.headingContents'),
            { body: t('settings.memory.sectionContentsInfo') },
        );

        new Setting(containerEl)
            .setName(t('settings.memory.viewMemory'))
            .setDesc(t('settings.memory.viewMemoryDesc'))
            .addButton((b) => b
                .setButtonText(t('settings.memory.viewMemoryButton'))
                
                .onClick(async () => {
                    const { MemoryViewerModal } = await import('../modals/MemoryViewerModal');
                    new MemoryViewerModal(this.app, this.plugin).open();
                }));

        new Setting(containerEl)
            .setName(t('settings.memory.deleteAll'))
            .setDesc(t('settings.memory.deleteAllDesc'))
            .addButton((b) => b
                .setButtonText(t('settings.memory.deleteAllButton'))
                
                .onClick(async () => {
                    const { confirmAndWipeAllMemory } = await import('../modals/wipeAllMemory');
                    await confirmAndWipeAllMemory(this.app, this.plugin);
                    this.rerender();
                }));
    }

    private buildMemoryV2MigrationSection(containerEl: HTMLElement): void {
        const status = this.plugin.settings.memory.v2MigrationStatus;

        containerEl.createEl('h3', { cls: 'agent-settings-section', text: t('settings.memory.headingUpgrade') });

        // Status banner -- different copy per pre-upgrade state.
        const banner = containerEl.createDiv('vault-op-box vault-op-box--intro');
        const bannerText = banner.createDiv({ cls: 'vault-op-box__text' });
        if (status === 'pending') {
            bannerText.createEl('strong', { text: t('settings.memory.upgradePendingTitle') + ' ' });
            bannerText.appendText(t('settings.memory.upgradePendingBody'));
        } else if (status === 'skipped') {
            bannerText.createEl('strong', { text: t('settings.memory.upgradeSkippedTitle') + ' ' });
            bannerText.appendText(t('settings.memory.upgradeSkippedBody'));
        }

        // Model dropdown (BUG-031): the global chat provider can be on a
        // quota-limited tier (e.g. Copilot 402). The atomiser step is the
        // only LLM-heavy part of the cascade; let the user pick a model
        // that is known to have quota.
        // REF-08: providerConfigs[] is the post-EPIC-26 canonical store;
        // expandProviderConfigsToCustomModels bridges the two shapes so
        // this dropdown is no longer empty on migrated installs.
        const fromProviders = expandProviderConfigsToCustomModels(this.plugin.settings.providerConfigs ?? []);
        const legacy = this.plugin.settings.activeModels.filter(m => m.enabled);
        const activeModels: CustomModel[] = fromProviders.length > 0 ? fromProviders : legacy;
        new Setting(containerEl)
            .setName(t('settings.memory.atomiserModel'))
            .setDesc(t('settings.memory.atomiserModelDesc'))
            .addDropdown(d => {
                d.addOption('', t('settings.memory.atomiserModelDefaultOption'));
                for (const m of activeModels) {
                    d.addOption(getModelKey(m), `${m.displayName ?? m.name} (${m.provider})`);
                }
                d.setValue(this.migrationModelKey);
                d.onChange((v) => { this.migrationModelKey = v; });
            });

        const upgradeSetting = new Setting(containerEl)
            .setName(t('settings.memory.runUpgrade'))
            .setDesc(t('settings.memory.runUpgradeDesc'));
        upgradeSetting.addButton((b) =>
            b.setButtonText(t('settings.memory.upgradeNowButton'))
                .onClick(() => void this.runMemoryV2Migration(b.buttonEl)),
        );
    }

    private async runMemoryV2Migration(btn: HTMLButtonElement): Promise<void> {
        const memDB = this.plugin.memoryDB;
        const fs = this.plugin.globalFs;
        const embeddingService = this.plugin.embeddingService;
        if (!memDB?.isOpen() || !fs || !embeddingService) {
            new Notice(t('settings.memory.upgradeNotReady'));
            return;
        }

        // Atomiser uses an independent model selection (BUG-031, 2026-04-28).
        // Falls back to the memory model, then the global chat provider.
        const selectedKey = this.migrationModelKey;
        const candidate = selectedKey
            ? this.plugin.settings.activeModels.find(m => getModelKey(m) === selectedKey && m.enabled)
            : null;
        const fallback = this.plugin.getMemoryModel();
        const chosen = candidate ?? fallback;

        let atomizerApi = this.plugin.apiHandler;
        let providerLabel = t('settings.memory.globalChatProvider');
        if (chosen) {
            const { buildApiHandlerForModel } = await import('../../api/index');
            atomizerApi = buildApiHandlerForModel(chosen);
            providerLabel = `${chosen.displayName ?? chosen.name} (${chosen.provider})`;
        }
        if (!atomizerApi) {
            new Notice(t('settings.memory.upgradeNoApiHandler'), 10000);
            return;
        }

        const ok = await confirmModal(this.app, {
            title: t('settings.memory.upgradeConfirmTitle'),
            message: t('settings.memory.upgradeConfirmMessage', { provider: providerLabel }),
            confirmLabel: t('settings.memory.upgradeConfirmButton'),
            cancelLabel: t('settings.memory.upgradeCancelButton'),
        });
        if (!ok) return;

        btn.setText(t('settings.memory.upgrading'));
        btn.disabled = true;
        const factStore = new FactStore(memDB);
        const styleStore = new CommunicationStyleStore(memDB);
        const atomizer = new MemoryAtomizer(atomizerApi);
        const orchestrator = new MemoryV2UpgradeOrchestrator();

        const progressNotice = new Notice(t('settings.memory.upgradeRunning'), 0);
        try {
            const report = await orchestrator.run({
                fs, factStore, styleStore, atomizer, embeddingService,
                memoryDB: memDB,
                onProgress: (msg) => progressNotice.setMessage(t('settings.memory.upgradeProgress', { msg })),
            });
            progressNotice.hide();

            if (report.aborted) {
                const failed = report.steps.find(s => !s.ok);
                new Notice(t('settings.memory.upgradeAborted', { reason: failed?.error ?? t('settings.memory.unknownError') }), 12000);
                console.error('[VaultOperatorUpgrade] Aborted:', report);
                return;
            }

            new Notice(formatReport(report), 14000);
            console.debug('[VaultOperatorUpgrade] Report:', report);

            // Persist outcome from the migration step so the settings banner
            // switches state and the modal stops appearing on next load.
            const migrationReport = MemoryV2UpgradeOrchestrator.findMigrationReport(report);
            if (migrationReport) {
                this.plugin.settings.memory.v2MigrationStatus = 'completed';
                this.plugin.settings.memory.v2MigrationReport = {
                    completedAt: migrationReport.timestamp,
                    factsInserted: migrationReport.totalFactsInserted,
                    stylesInserted: migrationReport.totalStylesInserted,
                    backupFolder: migrationReport.backupFolder,
                };
                await this.plugin.saveSettings();
            }
        } catch (e) {
            progressNotice.hide();
            console.error('[VaultOperatorUpgrade] Failed:', e);
            new Notice(t('settings.memory.upgradeFailed', { message: (e as Error).message }), 10000);
        } finally {
            btn.setText(t('settings.memory.upgradeNowButton'));
            btn.disabled = false;
            this.rerender();
        }
    }
}

function formatReport(report: UpgradeReport): string {
    const lines = [t('settings.memory.upgradeDone')];
    for (const step of report.steps) {
        const tag = step.skipped
            ? t('settings.memory.upgradeStepSkipped')
            : step.ok ? t('settings.memory.upgradeStepOk') : t('settings.memory.upgradeStepFailed');
        lines.push(`  ${step.label}: ${tag}${step.detail ? ` -- ${step.detail}` : ''}`);
    }
    return lines.join('\n');
}

// Re-export for legacy callers (kept for type imports until Phase 4 cleanup).
export type { MigrationReport };
