/**
 * InlineActionsTab -- Settings UI for Inline-Editor-AI-Actions (FEAT-33-01 TR-1.6, EPIC-33).
 *
 * Renders toggles + sliders for the inlineActions settings block.
 * The tab is registered as a sub-tab in AgentSettingsTab's advanced
 * area.
 *
 * Bot-Compliance: uses Obsidian Setting API + createDiv/createEl;
 * no innerHTML or direct style mutation.
 */

import { Setting, type App } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { resolveInlineActionsSettings } from '../../core/inline/inlineSettings';
import type { InlineActionsSettings } from '../../types/settings';
import { t } from '../../i18n';

export class InlineActionsTab {
    constructor(private plugin: ObsidianAgentPlugin, private _app: App, private _rerender: () => void) {}

    private getSettings(): InlineActionsSettings {
        if (this.plugin.settings.inlineActions === undefined) {
            this.plugin.settings.inlineActions = {};
        }
        return this.plugin.settings.inlineActions;
    }

    private async save(): Promise<void> {
        await this.plugin.saveSettings();
    }

    build(containerEl: HTMLElement): void {
        const header = containerEl.createDiv('agent-settings-header');
        header.createEl('h3', { text: '内联 AI 操作与聊天', cls: 'agent-settings-title' });
        header.createEl('p', {
            text: '在编辑器中选中文本后唤出浮动操作，或直接在笔记正文中内嵌发起 AI 问答与润色。',
            cls: 'agent-settings-desc',
        });

        const settings = this.getSettings();
        const resolved = resolveInlineActionsSettings(settings);

        new Setting(containerEl)
            .setName(t('settings.inlineActions.enabled'))
            .setDesc('开启后，可在编辑器中使用快捷键直接唤起内嵌 AI 交互。')
            .addToggle(t => t
                .setValue(resolved.enabled)
                .onChange(async (v) => { settings.enabled = v; await this.save(); }),
            );

        new Setting(containerEl)
            .setName(t('settings.inlineActions.floatingMenu'))
            .setDesc('选中文本后，在光标附近自动弹出轻量 AI 操作栏（总结、润色、翻译等）。')
            .addToggle(t => t
                .setValue(resolved.floatingMenuEnabled)
                .onChange(async (v) => { settings.floatingMenuEnabled = v; await this.save(); }),
            );

        new Setting(containerEl)
            .setName(t('settings.inlineActions.vaultRag'))
            .setDesc('执行内联操作时，自动检索库中相关笔记作为上下文补充。')
            .addToggle(t => t
                .setValue(resolved.vaultRagInLookup)
                .onChange(async (v) => { settings.vaultRagInLookup = v; await this.save(); }),
            );

        if (resolved.vaultRagInLookup) {
            new Setting(containerEl)
                .setName(t('settings.inlineActions.ragThreshold'))
                .setDesc('相关度置信度阈值（0~1），过滤低相关性的笔记。')
                .addSlider(s => s
                    .setLimits(0, 1, 0.05)
                    .setValue(resolved.vaultRagConfidenceThreshold)
                    .onChange(async (v) => { settings.vaultRagConfidenceThreshold = v; await this.save(); }),
                );
        }
    }
}
