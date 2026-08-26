import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { t } from '../../i18n';
import { addSectionHeading, addSliderInput } from './utils';
import { PLUGIN_API_ALLOWLIST } from '../../core/tools/agent/pluginApiAllowlist';
import { applyDestructiveStyle } from '../buttonStyle';
import { resetToDefaultDeny } from '../../core/tools/autoApprovalGrant';
import { clearImportedSkillTrust } from '../../core/tools/agent/InvokeSkillTool';
import { PRESETS } from '../../core/tools/agent/UpdateSettingsTool';
import { buildGrantedPermissionsSection, categoryProvenanceText } from './grantedPermissions';
import { BUILT_IN_COMMAND_ALLOWLIST, listEnrolledCommands } from '../../core/tools/agent/commandAllowlist';


/**
 * Plain-language purpose per built-in command. An explicit table rather than a
 * built key path: the key-usage gate can only verify static t() calls, and a
 * key that silently falls back to its own path is worse than no text at all.
 */
const COMMAND_PURPOSE: Record<string, () => string> = {
    'workspace:export-pdf': () => t('settings.permissions.commandPurposeExportPdf'),
    'daily-notes:open': () => t('settings.permissions.commandPurposeDailyNote'),
    'obsidian-excalidraw-plugin:excalidraw-autocreate-newtab': () => t('settings.permissions.commandPurposeExcalidraw'),
    'dbfolder:create-new-database-folder': () => t('settings.permissions.commandPurposeDbFolder'),
};

export class PermissionsTab {
    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {}

    /**
     * AUDIT 2026-07-26 M-18 (second pass): a toggle says WHAT is allowed but
     * never WHO allowed it. Someone who clicked "Always allow" on a card three
     * days ago sees a switch that is on and no sign they are the reason. The
     * first attempt answered that with a second row in a list, which duplicated
     * the control; the answer belongs on the control itself.
     */
    private withProvenance(desc: string, categoryKey: string): string {
        const origin = categoryProvenanceText(this.plugin, categoryKey);
        return origin === null ? desc : `${desc} (${origin})`;
    }

    private buildIntroSection(containerEl: HTMLElement): void {
        // 2026-05-18: this tab grants the agent the right to act without
        // asking. Render the intro as an orange warning callout instead
        // of the neutral blue one used on the rest of the tabs, and roll
        // up the individual per-row warnings into one explicit notice.
        const banner = containerEl.createDiv('vault-op-box vault-op-box--warning');
        const icon = banner.createSpan({ cls: 'vault-op-box__icon' });
        setIcon(icon, 'shield-alert');
        const text = banner.createDiv({ cls: 'vault-op-box__text' });
        text.createEl('strong', { text: t('settings.permissions.introTitle') });
        text.createDiv({ text: t('settings.permissions.introDesc') });

        // AUDIT-030 L-4: users who add a provider in settings but skip the
        // onboarding wizard never see the "consent to permissive defaults"
        // step. Master toggle ships off (fail-closed), so this is polish
        // not a security fix, but a one-line hint makes the posture explicit.
        if (this.plugin.settings.onboarding?.completed === false) {
            const hint = containerEl.createDiv('vault-op-box vault-op-box--info');
            const hintIcon = hint.createSpan({ cls: 'vault-op-box__icon' });
            setIcon(hintIcon, 'info');
            const hintText = hint.createDiv({ cls: 'vault-op-box__text' });
            hintText.setText(t('settings.permissions.onboardingHint'));
        }
    }

    build(containerEl: HTMLElement): void {
        this.buildIntroSection(containerEl);
        this.buildKillSwitchSection(containerEl);

        // ── Auto-approve master toggle + visibility helper ───────────────
        addSectionHeading(
            containerEl,
            t('settings.permissions.headingAutoApprove'),
            { body: t('settings.permissions.sectionAutoApproveInfo') },
        );

        // FIX-44-31: the "Permissive warning" the intro copy promises. It was
        // defined in i18n but never rendered. Render it here and re-evaluate it
        // live whenever a relevant toggle changes, so the promise is real.
        const permissiveWarning = containerEl.createDiv('vault-op-box vault-op-box--warning');
        {
            const wi = permissiveWarning.createSpan({ cls: 'vault-op-box__icon' });
            setIcon(wi, 'alert-triangle');
            permissiveWarning.createDiv({ cls: 'vault-op-box__text' })
                .setText(t('settings.permissions.permissiveWarning'));
        }
        const refreshPermissiveWarning = (): void => {
            const a = this.plugin.settings.autoApproval;
            const risky = a.enabled === true && a.web === true
                && (a.noteEdits === true || a.vaultChanges === true);
            permissiveWarning.toggleClass('agent-u-hidden', !risky);
        };

        // eslint-disable-next-line prefer-const -- forward-declared for closure capture below; assigned after the master toggles to preserve DOM order
        let categoryContainer: HTMLDivElement;
        const refreshCategoryDisabled = (): void => {
            const masterOn = this.plugin.settings.autoApproval.enabled;
            categoryContainer.classList.toggle('agent-approval-categories--disabled', !masterOn);
            // Hard-disable every interactive control inside the category
            // block when the master is off. CSS opacity alone left toggles
            // clickable, so a user could "approve sandbox" while the master
            // gate silently overrode the choice in the pipeline.
            const inputs = categoryContainer.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
                'input, button',
            );
            inputs.forEach((el) => { el.disabled = !masterOn; });
            refreshPermissiveWarning();
        };

        new Setting(containerEl)
            .setName(t('settings.permissions.enableAutoApprove'))
            .setDesc(t('settings.permissions.enableAutoApproveDesc'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.enabled).onChange(async (v) => {
                    this.plugin.settings.autoApproval.enabled = v;
                    await this.plugin.saveSettings();
                    refreshCategoryDisabled();
                }),
            );

        // FEAT-30-07: aus dem Loop-Tab hierher verschoben. Der Timeout
        // gehoert zum Approval-System (Auto-Deny unbeantworteter Karten,
        // IMP-41-01-02) und wirkt unabhaengig vom Auto-Approve-Master,
        // deshalb steht er ausserhalb des Kategorie-Containers.
        const approvalTimeoutSetting = new Setting(containerEl)
            .setName(t('settings.loop.approvalTimeout'))
            .setDesc(t('settings.loop.approvalTimeoutDesc'));
        addSliderInput(approvalTimeoutSetting, {
            min: 0, max: 60, step: 5,
            value: this.plugin.settings.advancedApi.approvalTimeoutMinutes ?? 10,
            onChange: async (v) => {
                this.plugin.settings.advancedApi.approvalTimeoutMinutes = v;
                await this.plugin.saveSettings();
            },
        });

        // FEAT-30-07: Auto-Promotion (Tier-2-Methode wird nach N echten
        // User-Approvals dauerhaft als Read auto-genehmigt) ist eine
        // Consent-Entscheidung und lebt deshalb hier statt im Plugin-API-
        // Tab. Review-Finding: sie greift bei ECHTEN User-Approvals, also
        // gerade auch bei ausgeschaltetem Auto-Approve-Master; deshalb
        // steht der Toggle ausserhalb des Kategorie-Containers. Widerruf
        // promoteter Methoden: Advanced > Plugin API.
        new Setting(containerEl)
            .setName(t('settings.shell.autoPromote'))
            .setDesc(t('settings.shell.autoPromoteDesc'))
            .addToggle((tg) => tg
                .setValue(this.plugin.settings.pluginApi?.autoPromotionEnabled !== false)
                .onChange(async (v) => {
                    if (!this.plugin.settings.pluginApi) {
                        this.plugin.settings.pluginApi = { enabled: true, safeMethodOverrides: {} };
                    }
                    this.plugin.settings.pluginApi.autoPromotionEnabled = v;
                    await this.plugin.saveSettings();
                }));

        // FIX-44-03c: the "Show approval bar in chat" toggle was removed. It
        // wrote autoApproval.showMenuInChat, which nothing consumed -- the
        // quick-toggle bar it promised does not exist. A toggle that does
        // nothing is a lie about the settings surface.

        // ── Per-category toggles ─────────────────────────────────────────
        categoryContainer = containerEl.createDiv('agent-approval-categories');

        addSectionHeading(
            categoryContainer,
            t('settings.permissions.headingPerCategory'),
            { body: t('settings.permissions.sectionPerCategoryInfo') },
        );

        // FIX-44-03c: reads are always auto-approved and master-independent
        // (EFFECT_POLICY.read has key:null). The old "Read operations" TOGGLE
        // wrote autoApproval.read, which the gate never reads -- turning it off
        // did nothing. Replaced with a non-interactive statement of fact so the
        // posture is honest instead of a dead switch.
        new Setting(categoryContainer)
            .setName(t('settings.permissions.readsAlwaysRun'))
            .setDesc(t('settings.permissions.readsAlwaysRunDesc'))
            .setDisabled(true);

        new Setting(categoryContainer)
            .setName(t('settings.permissions.noteEdits'))
            .setDesc(this.withProvenance(t('settings.permissions.noteEditsDesc'), 'noteEdits'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.noteEdits).onChange(async (v) => {
                    this.plugin.settings.autoApproval.noteEdits = v;
                    await this.plugin.saveSettings();
                    refreshPermissiveWarning();
                }),
            );

        new Setting(categoryContainer)
            .setName(t('settings.permissions.vaultChanges'))
            .setDesc(this.withProvenance(t('settings.permissions.vaultChangesDesc'), 'vaultChanges'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.vaultChanges).onChange(async (v) => {
                    this.plugin.settings.autoApproval.vaultChanges = v;
                    await this.plugin.saveSettings();
                    refreshPermissiveWarning();
                }),
            );

        new Setting(categoryContainer)
            .setName(t('settings.permissions.webOps'))
            .setDesc(this.withProvenance(t('settings.permissions.webOpsDesc'), 'web'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.web).onChange(async (v) => {
                    this.plugin.settings.autoApproval.web = v;
                    await this.plugin.saveSettings();
                    refreshPermissiveWarning();
                }),
            );

        new Setting(categoryContainer)
            .setName(t('settings.permissions.mcpCalls'))
            .setDesc(this.withProvenance(t('settings.permissions.mcpCallsDesc'), 'mcp'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.mcp).onChange(async (v) => {
                    this.plugin.settings.autoApproval.mcp = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(categoryContainer)
            .setName(t('settings.permissions.subtasks'))
            .setDesc(this.withProvenance(t('settings.permissions.subtasksDesc'), 'subtasks'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.subtasks).onChange(async (v) => {
                    this.plugin.settings.autoApproval.subtasks = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(categoryContainer)
            .setName(t('settings.permissions.pluginSkills'))
            .setDesc(this.withProvenance(t('settings.permissions.pluginSkillsDesc'), 'skills'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.skills).onChange(async (v) => {
                    this.plugin.settings.autoApproval.skills = v;
                    await this.plugin.saveSettings();
                }),
            );

        addSectionHeading(
            categoryContainer,
            t('settings.permissions.headingPluginApi'),
            { body: t('settings.permissions.sectionPluginApiInfo') },
        );

        new Setting(categoryContainer)
            .setName(t('settings.permissions.pluginApiReads'))
            .setDesc(this.withProvenance(t('settings.permissions.pluginApiReadsDesc'), 'pluginApiRead'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.pluginApiRead ?? true).onChange(async (v) => {
                    this.plugin.settings.autoApproval.pluginApiRead = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(categoryContainer)
            .setName(t('settings.permissions.pluginApiWrites'))
            .setDesc(this.withProvenance(t('settings.permissions.pluginApiWritesDesc'), 'pluginApiWrite'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.pluginApiWrite ?? false).onChange(async (v) => {
                    this.plugin.settings.autoApproval.pluginApiWrite = v;
                    await this.plugin.saveSettings();
                }),
            );

        // FEAT-30-07: die read/write-Klassifikation, die diese beiden Toggles
        // steuern, kommt aus der kuratierten Built-in-Allowlist. Die Liste
        // stand vorher als 23 statische Zeilen im Shell-Tab; hier ist sie
        // die einklappbare Erklaerung direkt neben den Consent-Toggles.
        this.buildAllowlistCatalog(categoryContainer);

        new Setting(categoryContainer)
            .setName(t('settings.permissions.recipes'))
            .setDesc(this.withProvenance(t('settings.permissions.recipesDesc'), 'recipes'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.autoApproval.recipes ?? false).onChange(async (v) => {
                    this.plugin.settings.autoApproval.recipes = v;
                    await this.plugin.saveSettings();
                }),
            );

        addSectionHeading(
            categoryContainer,
            t('settings.permissions.headingSandbox'),
            { body: t('settings.permissions.sectionSandboxInfo') },
        );

        new Setting(categoryContainer)
            .setName(t('settings.permissions.sandbox'))
            .setDesc(this.withProvenance(t('settings.permissions.sandboxDesc'), 'sandbox'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.autoApproval.sandbox ?? false).onChange(async (v) => {
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
                    this.plugin.settings.autoApproval.sandbox = v;
                    await this.plugin.saveSettings();
                }),
            );

        // Apply the initial disabled state (after every control exists).
        refreshCategoryDisabled();

        this.buildCommandAllowlistSection(containerEl);

        // AUDIT 2026-07-26 M-18 (second pass): the granted-permissions list
        // sits at the END, and holds only the SPECIFIC grants -- the ones with
        // no toggle anywhere. The categories above are not repeated in it: one
        // piece of state rendered as two controls reads as two pieces of state,
        // so taking one back looked broken even when it worked. Where a
        // category came from is shown on its own toggle instead (see the
        // provenance suffix on the descriptions above).
        buildGrantedPermissionsSection(this.plugin, containerEl, this.rerender);
    }

    /**
     * FEAT-30-07: einklappbarer Katalog der kuratierten Plugin-API-Methoden.
     * Er ist die Datenquelle der pluginApiRead/pluginApiWrite-Toggles
     * (isPluginApiWriteCall klassifiziert Calls gegen genau diese Liste)
     * und stand vorher als 23 statische Zeilen im Shell-Tab.
     */
    private buildAllowlistCatalog(containerEl: HTMLElement): void {
        const details = containerEl.createEl('details', { cls: 'agent-permissions-catalog' });
        details.createEl('summary', {
            text: t('settings.permissions.allowlistCatalog', { count: PLUGIN_API_ALLOWLIST.length }),
        });
        details.createDiv({
            cls: 'setting-item-description',
            text: t('settings.permissions.allowlistCatalogDesc'),
        });
        for (const entry of PLUGIN_API_ALLOWLIST) {
            const badge = entry.isWrite ? t('settings.shell.badgeWrite') : t('settings.shell.badgeRead');
            new Setting(details)
                .setName(`${entry.pluginId}.${entry.method}`)
                .setDesc(`${entry.description}${badge}`);
        }
    }

    /**
     * FEAT-44-07: the kill switch, rendered ABOVE the auto-approve controls so
     * the way back to fail-closed is always in sight, never buried below the
     * grants it revokes. Two parts:
     *
     * (b) "Always ask (paranoid mode)": a persisted plain setting (survives the
     *     reload -- a brake that silently drops off on restart would be a trap).
     *     While on, the pipeline asks for every effect except read/ui,
     *     regardless of the toggles below, presets, and run-/session grants.
     *     Deliberately NOT an autoApproval category key, so the EFFECT_POLICY
     *     drift contract stays untouched.
     *
     * (a) "Reset to default-deny": one click (plus confirm) back to the
     *     restrictive preset, revoking all run- and session-scope grants.
     */
    /**
     * AUDIT 2026-07-26 M-8: enrolment for Obsidian commands.
     *
     * `execute_command` now runs only what is on its list, so there has to be a
     * way to put something on it -- otherwise the fix is a feature removal.
     *
     * Enrolment lives HERE and not on an approval card, deliberately. The list
     * is the capability boundary, so letting one card click (on a command id the
     * agent itself chose) add an arbitrary third-party command forever would
     * reduce the allowlist to a one-time prompt. Taking one back happens in the
     * granted-permissions list at the bottom of this tab.
     */
    private buildCommandAllowlistSection(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            t('settings.permissions.headingCommands'),
            { body: t('settings.permissions.sectionCommandsInfo') },
        );

        const registered = this.plugin.app.commands?.commands ?? {};
        const enrolled = listEnrolledCommands(this.plugin.settings.executeCommandAllowedIds);
        const enrolledIds = new Set(enrolled.map((e) => e.id));

        // USER 2026-07-26: this used to be a read-only catalogue, which is a poor
        // thing to put in a settings screen -- four rows nobody could act on,
        // explained in developer language. Each one is a toggle now: if someone
        // does not want the agent exporting PDFs, there is no reason they should
        // not be able to say so. The text says what the command DOES, not why
        // the codebase shipped it enabled.
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

        // Everything registered in THIS vault that is not already allowed.
        const candidates = Object.entries(registered)
            .filter(([id]) => !enrolledIds.has(id) && !BUILT_IN_COMMAND_ALLOWLIST.some((c) => c.id === id))
            .map(([id, cmd]) => ({ id, name: (cmd as { name?: string }).name ?? id }))
            .sort((a, b) => a.name.localeCompare(b.name));

        let chosen = candidates[0]?.id ?? '';
        const add = new Setting(containerEl)
            .setName(t('settings.permissions.commandsAdd'))
            .setDesc(t('settings.permissions.commandsAddDesc'));
        add.addDropdown((dd) => {
            if (candidates.length === 0) {
                dd.addOption('', t('settings.permissions.commandsNone'));
                dd.setDisabled(true);
                return;
            }
            for (const c of candidates) dd.addOption(c.id, `${c.name} (${c.id})`);
            dd.setValue(chosen).onChange((v) => { chosen = v; });
        });
        add.addButton((btn) => {
            btn.setButtonText(t('settings.permissions.commandsAllow')).onClick(async () => {
                if (!chosen) return;
                const name = registered[chosen]?.name ?? '';
                const list = listEnrolledCommands(this.plugin.settings.executeCommandAllowedIds);
                if (!list.some((e) => e.id === chosen)) {
                    // The NAME is recorded on purpose: a command id is an index
                    // for some plugins, so the name is what makes a later swap
                    // detectable.
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
            t('settings.permissions.headingKillSwitch'),
            { body: t('settings.permissions.sectionKillSwitchInfo') },
        );

        new Setting(containerEl)
            .setName(t('settings.permissions.paranoidMode'))
            .setDesc(t('settings.permissions.paranoidModeDesc'))
            .addToggle((tg) =>
                tg.setValue(this.plugin.settings.paranoidMode === true).onChange(async (v) => {
                    this.plugin.settings.paranoidMode = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settings.permissions.resetDefaultDeny'))
            .setDesc(t('settings.permissions.resetDefaultDenyDesc'))
            .addButton((btn) => {
                btn.setButtonText(t('settings.permissions.resetDefaultDenyButton'));
                applyDestructiveStyle(btn);
                btn.onClick(() => {
                    void (async () => {
                        const ok = await this.confirmHighRisk(
                            t('settings.permissions.resetConfirmTitle'),
                            t('settings.permissions.resetConfirmMessage'),
                            t('settings.permissions.resetConfirmAccept'),
                        );
                        if (!ok) return;
                        // AUDIT 2026-07-26 M-13: the reset now also clears the
                        // consents that live outside settings.autoApproval --
                        // inbound MCP write access, promoted plugin-API methods
                        // and their counts, and imported-skill trust.
                        resetToDefaultDeny(this.plugin, PRESETS.restrictive, clearImportedSkillTrust);
                        await this.plugin.saveSettings();
                        new Notice(t('settings.permissions.resetDone'));
                        // Re-render so every toggle shows its post-reset state.
                        this.rerender();
                    })();
                });
            });
    }

    /**
     * Show a confirmation dialog for high-risk settings.
     * Returns true if the user confirmed, false otherwise.
     */
    private confirmHighRisk(title: string, message: string, acceptLabel?: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new (class extends Modal {
                onOpen(): void {
                    const { contentEl } = this;
                    contentEl.createEl('h3', { text: title });
                    contentEl.createEl('p', { text: message, cls: 'agent-setting-confirm-message' });

                    const btnRow = contentEl.createDiv('agent-setting-confirm-buttons');
                    const cancelBtn = btnRow.createEl('button', { text: t('settings.permissions.sandboxConfirmCancel') });
                    const confirmBtn = btnRow.createEl('button', {
                        text: acceptLabel ?? t('settings.permissions.sandboxConfirmAccept'),
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
