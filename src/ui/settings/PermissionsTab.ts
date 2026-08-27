import { App, Modal, Notice, Setting } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { t } from '../../i18n';
import { addSectionHeading, addSliderInput } from './utils';
import { applyDestructiveStyle } from '../buttonStyle';
import { resetToDefaultDeny } from '../../core/tools/autoApprovalGrant';
import { clearImportedSkillTrust } from '../../core/tools/agent/InvokeSkillTool';
import { PRESETS } from '../../core/tools/agent/UpdateSettingsTool';
import { buildGrantedPermissionsSection, categoryProvenanceText } from './grantedPermissions';
import { BUILT_IN_COMMAND_ALLOWLIST, listEnrolledCommands } from '../../core/tools/agent/commandAllowlist';

const COMMAND_PURPOSE: Record<string, () => string> = {
    'workspace:export-pdf': () => t('settings.permissions.commandPurposeExportPdf'),
    'daily-notes:open': () => t('settings.permissions.commandPurposeDailyNote'),
    'obsidian-excalidraw-plugin:excalidraw-autocreate-newtab': () => t('settings.permissions.commandPurposeExcalidraw'),
    'dbfolder:create-new-database-folder': () => t('settings.permissions.commandPurposeDbFolder'),
};

export class PermissionsTab {
    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {}

    private withProvenance(desc: string, categoryKey: string): string {
        const origin = categoryProvenanceText(this.plugin, categoryKey);
        return origin === null ? desc : `${desc} (${origin})`;
    }

    private getActivePreset(): 'restrictive' | 'balanced' | 'permissive' | 'custom' {
        const a = this.plugin.settings.autoApproval;
        if (!a.enabled) return 'restrictive';
        if (a.noteEdits && a.vaultChanges && a.web && a.mcp) return 'permissive';
        if (!a.noteEdits && !a.vaultChanges && a.web) return 'balanced';
        return 'custom';
    }

    private async applyPreset(presetKey: 'restrictive' | 'balanced' | 'permissive'): Promise<void> {
        const preset = PRESETS[presetKey];
        if (!preset) return;
        Object.assign(this.plugin.settings.autoApproval, preset);
        if (presetKey === 'restrictive') {
            this.plugin.settings.autoApproval.enabled = false;
        } else {
            this.plugin.settings.autoApproval.enabled = true;
        }
        await this.plugin.saveSettings();
        this.rerender();
    }

    private buildHeaderAndPresets(containerEl: HTMLElement): void {
        const header = containerEl.createDiv('agent-settings-header');
        header.createEl('h3', { text: '自动批准策略', cls: 'agent-settings-title' });
        header.createEl('p', {
            text: '配置 AI 在执行操作时的确认策略。自动批准允许 AI 免去弹窗直接执行低风险操作，加快任务速度。',
            cls: 'agent-settings-desc',
        });

        // 3 档预设选择卡片（名称与聊天框的批准模式快捷菜单共用同一组
        // i18n 键，保证两处显示永远一致）
        const activePreset = this.getActivePreset();
        const presetsRow = containerEl.createDiv('agent-permission-presets');

        const presetDefs = [
            {
                key: 'restrictive' as const,
                title: `🛡️ ${t('ui.approval.restrictive')}`,
                badge: t('ui.approval.badgeRestrictive'),
                desc: t('ui.approval.restrictiveDesc'),
            },
            {
                key: 'balanced' as const,
                title: `⚡ ${t('ui.approval.balanced')}`,
                badge: t('ui.approval.badgeBalanced'),
                desc: t('ui.approval.balancedDesc'),
            },
            {
                key: 'permissive' as const,
                title: `🚀 ${t('ui.approval.permissive')}`,
                badge: t('ui.approval.badgePermissive'),
                desc: t('ui.approval.permissiveDesc'),
            },
        ];

        for (const def of presetDefs) {
            const card = presetsRow.createDiv({
                cls: 'agent-permission-preset-card' + (activePreset === def.key ? ' is-active' : ''),
            });
            const top = card.createDiv('agent-preset-card-header');
            top.createSpan({ cls: 'agent-preset-card-title', text: def.title });
            if (def.badge) {
                top.createSpan({ cls: 'agent-preset-badge', text: def.badge });
            }
            card.createDiv({ cls: 'agent-preset-card-desc', text: def.desc });

            card.addEventListener('click', () => {
                void this.applyPreset(def.key);
            });
        }
    }

    build(containerEl: HTMLElement): void {
        this.buildHeaderAndPresets(containerEl);

        // ── 常用核心权限开关 ─────────────────────────────────────────────
        const coreSection = containerEl.createDiv('agent-permissions-core');
        addSectionHeading(
            coreSection,
            '常用权限微调',
            { body: '你可以在预设的基础上，按需单独调整以下最常用的权限开关。' },
        );

        const a = this.plugin.settings.autoApproval;

        new Setting(coreSection)
            .setName('总开关：启用自动批准')
            .setDesc('关闭后将进入完全严格模式，任何写操作都会向你请求批准。')
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.enabled).onChange(async (v) => {
                    this.plugin.settings.autoApproval.enabled = v;
                    await this.plugin.saveSettings();
                    this.rerender();
                }),
            );

        new Setting(coreSection)
            .setName('✏️ 自动编辑笔记内容')
            .setDesc(this.withProvenance('允许 AI 直接修改当前或指定笔记的正文内容。', 'noteEdits'))
            .addToggle((t) =>
                t.setValue(a.noteEdits).onChange(async (v) => {
                    a.noteEdits = v;
                    await this.plugin.saveSettings();
                    this.rerender();
                }),
            );

        new Setting(coreSection)
            .setName('📁 自动修改仓库文件结构')
            .setDesc(this.withProvenance('允许 AI 创建新笔记、移动文件或重命名。', 'vaultChanges'))
            .addToggle((t) =>
                t.setValue(a.vaultChanges).onChange(async (v) => {
                    a.vaultChanges = v;
                    await this.plugin.saveSettings();
                    this.rerender();
                }),
            );

        new Setting(coreSection)
            .setName('🌐 自动联网搜索与抓取')
            .setDesc(this.withProvenance('允许 AI 通过网络搜索资料并抓取网页内容。', 'web'))
            .addToggle((t) =>
                t.setValue(a.web).onChange(async (v) => {
                    a.web = v;
                    await this.plugin.saveSettings();
                    this.rerender();
                }),
            );

        new Setting(coreSection)
            .setName('🔌 自动调用 MCP 扩展工具')
            .setDesc(this.withProvenance('允许 AI 直接调用已配置的 MCP 服务器和外部扩展。', 'mcp'))
            .addToggle((t) =>
                t.setValue(a.mcp).onChange(async (v) => {
                    a.mcp = v;
                    await this.plugin.saveSettings();
                    this.rerender();
                }),
            );

        // ── 高级安全与白名单（折叠收纳） ────────────────────────────────────
        const advancedDetails = containerEl.createEl('details', { cls: 'agent-permissions-advanced' });
        advancedDetails.createEl('summary', { text: '⚙️ 高级安全选项与白名单（点击展开）' });
        const advancedBody = advancedDetails.createDiv('agent-permissions-advanced-body');

        // 审批超时
        const approvalTimeoutSetting = new Setting(advancedBody)
            .setName('审批弹窗超时时间（分钟）')
            .setDesc('等待用户批准的最长时间，超时后自动取消该次操作。');
        addSliderInput(approvalTimeoutSetting, {
            min: 0, max: 60, step: 5,
            value: this.plugin.settings.advancedApi.approvalTimeoutMinutes ?? 10,
            onChange: async (v) => {
                this.plugin.settings.advancedApi.approvalTimeoutMinutes = v;
                await this.plugin.saveSettings();
            },
        });

        // 自动学习信任
        new Setting(advancedBody)
            .setName('自动信任高频批准的插件方法')
            .setDesc('当某项插件方法被手动批准多次后，自动提升为安全可信操作。')
            .addToggle((tg) => tg
                .setValue(this.plugin.settings.pluginApi?.autoPromotionEnabled !== false)
                .onChange(async (v) => {
                    if (!this.plugin.settings.pluginApi) {
                        this.plugin.settings.pluginApi = { enabled: true, safeMethodOverrides: {} };
                    }
                    this.plugin.settings.pluginApi.autoPromotionEnabled = v;
                    await this.plugin.saveSettings();
                }));

        // 子任务
        new Setting(advancedBody)
            .setName('自动派发后台子任务')
            .setDesc(this.withProvenance('允许主 Agent 自动创建并运行子任务 Agent。', 'subtasks'))
            .addToggle((t) =>
                t.setValue(a.subtasks).onChange(async (v) => {
                    a.subtasks = v;
                    await this.plugin.saveSettings();
                }),
            );

        // 技能调用
        new Setting(advancedBody)
            .setName('自动执行已配置技能（Skills）')
            .setDesc(this.withProvenance('允许自动运行技能包中的预置流程。', 'skills'))
            .addToggle((t) =>
                t.setValue(a.skills).onChange(async (v) => {
                    a.skills = v;
                    await this.plugin.saveSettings();
                }),
            );

        // 代码沙盒
        new Setting(advancedBody)
            .setName('允许沙盒执行动态脚本')
            .setDesc(this.withProvenance('高风险配置：允许 Agent 编写并在隔离环境中执行临时脚本。', 'sandbox'))
            .addToggle((toggle) =>
                toggle.setValue(a.sandbox ?? false).onChange(async (v) => {
                    if (v) {
                        const confirmed = await this.confirmHighRisk(
                            t('settings.permissions.sandboxConfirmTitle'),
                            t('settings.permissions.sandboxConfirmMessage'),
                        );
                        if (!confirmed) {
                            toggle.setValue(false);
                            return;
                        }
                    }
                    a.sandbox = v;
                    await this.plugin.saveSettings();
                }),
            );

        // 命令白名单
        this.buildCommandAllowlistSection(advancedBody);

        // 紧急重置
        this.buildKillSwitchSection(advancedBody);

        // 具体授权清单
        buildGrantedPermissionsSection(this.plugin, advancedBody, this.rerender);
    }

    private buildCommandAllowlistSection(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            'Obsidian 命令执行白名单',
            { body: '控制 Agent 允许触发哪些 Obsidian 内部核心命令。' },
        );

        const registered = this.plugin.app.commands?.commands ?? {};
        const enrolled = listEnrolledCommands(this.plugin.settings.executeCommandAllowedIds);
        const enrolledIds = new Set(enrolled.map((e) => e.id));

        const disabled = new Set(this.plugin.settings.executeCommandDisabledBuiltIns ?? []);
        const shipped = containerEl.createEl('details', { cls: 'agent-permissions-catalog' });
        shipped.createEl('summary', {
            text: t('settings.permissions.commandsBuiltIn', {
                on: String(BUILT_IN_COMMAND_ALLOWLIST.length - disabled.size),
                total: String(BUILT_IN_COMMAND_ALLOWLIST.length),
            }),
        });
        shipped.createDiv({
            cls: 'setting-item-description',
            text: t('settings.permissions.commandsBuiltInDesc'),
        });
        for (const entry of BUILT_IN_COMMAND_ALLOWLIST) {
            const registeredName = registered[entry.id]?.name;
            new Setting(shipped)
                .setName(registeredName ?? entry.id)
                .setDesc(COMMAND_PURPOSE[entry.id]?.() ?? entry.reason)
                .addToggle((tg) => tg
                    .setValue(!disabled.has(entry.id))
                    .onChange(async (on) => {
                        const next = new Set(this.plugin.settings.executeCommandDisabledBuiltIns ?? []);
                        if (on) next.delete(entry.id); else next.add(entry.id);
                        this.plugin.settings.executeCommandDisabledBuiltIns = [...next];
                        await this.plugin.saveSettings();
                    }));
        }

        const candidates = Object.entries(registered)
            .filter(([id]) => !enrolledIds.has(id) && !BUILT_IN_COMMAND_ALLOWLIST.some((c) => c.id === id))
            .map(([id, cmd]) => ({ id, name: (cmd as { name?: string }).name ?? id }))
            .sort((a, b) => a.name.localeCompare(b.name));

        let chosen = candidates[0]?.id ?? '';
        const add = new Setting(containerEl)
            .setName('添加允许执行的命令')
            .setDesc('为 Agent 额外开放执行指定的第三方插件或自定义命令。');
        add.addDropdown((dd) => {
            if (candidates.length === 0) {
                dd.addOption('', '没有更多可用命令');
                dd.setDisabled(true);
                return;
            }
            for (const c of candidates) dd.addOption(c.id, `${c.name} (${c.id})`);
            dd.setValue(chosen).onChange((v) => { chosen = v; });
        });
        add.addButton((btn) => {
            btn.setButtonText('允许').onClick(async () => {
                if (!chosen) return;
                const name = registered[chosen]?.name ?? '';
                const list = listEnrolledCommands(this.plugin.settings.executeCommandAllowedIds);
                if (!list.some((e) => e.id === chosen)) {
                    list.push({ id: chosen, name, at: Date.now() });
                }
                this.plugin.settings.executeCommandAllowedIds = list;
                await this.plugin.saveSettings();
                new Notice(t('settings.permissions.commandsAllowed', { name: name || chosen }));
                this.rerender();
            });
        });
    }

    private buildKillSwitchSection(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            '重置与紧急控制',
            { body: '快速重置所有临时授权或强制开启全局确认。' },
        );

        new Setting(containerEl)
            .setName('强制全局确认模式')
            .setDesc('开启后，除纯读取外，所有动作都必须手动点击批准，无视任何预设。')
            .addToggle((tg) =>
                tg.setValue(this.plugin.settings.paranoidMode === true).onChange(async (v) => {
                    this.plugin.settings.paranoidMode = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('一键恢复默认严格设置')
            .setDesc('重置所有自动批准开关为关闭，并清空所有临时授予的会话权限。')
            .addButton((btn) => {
                btn.setButtonText('恢复默认');
                applyDestructiveStyle(btn);
                btn.onClick(() => {
                    void (async () => {
                        const ok = await this.confirmHighRisk(
                            '确认重置权限',
                            '此操作将关闭所有自动批准开关并撤销所有已记录的临时授权。',
                            '确认重置',
                        );
                        if (!ok) return;
                        resetToDefaultDeny(this.plugin, PRESETS.restrictive, clearImportedSkillTrust);
                        await this.plugin.saveSettings();
                        new Notice(t('settings.permissions.resetDone'));
                        this.rerender();
                    })();
                });
            });
    }

    private confirmHighRisk(title: string, message: string, acceptLabel?: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new (class extends Modal {
                onOpen(): void {
                    const { contentEl } = this;
                    contentEl.createEl('h3', { text: title });
                    contentEl.createEl('p', { text: message, cls: 'agent-setting-confirm-message' });

                    const btnRow = contentEl.createDiv('agent-setting-confirm-buttons');
                    const cancelBtn = btnRow.createEl('button', { text: '取消' });
                    const confirmBtn = btnRow.createEl('button', {
                        text: acceptLabel ?? '确认继续',
                        cls: 'mod-warning',
                    });
                    cancelBtn.addEventListener('click', () => { this.close(); resolve(false); });
                    confirmBtn.addEventListener('click', () => { this.close(); resolve(true); });
                }
                onClose(): void {
                    resolve(false);
                }
            })(this.app);
            modal.open();
        });
    }
}
