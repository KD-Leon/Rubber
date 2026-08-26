/**
 * ShellTab -- seit FEAT-30-07 der Sub-Tab "Plugin API" unter Advanced.
 * (Der historische Name "Shell" blieb als Dateiname; der Tab hat nie eine
 * Shell konfiguriert, sondern immer nur das call_plugin_api-Tool.)
 *
 * Enthaelt nur noch: Master-Toggle (Existenz-Gate, CallPluginApiTool) und
 * die "User safe-marked methods"-Liste (einziger Widerrufsweg fuer
 * auto-promotete Tier-2-Methoden). Die read/write-Klassifikations-Info und
 * das Auto-Promotion-Toggle leben bei den Permissions (dort greifen die
 * zugehoerigen Consent-Toggles); Timeout-Regler und Threshold sind feste
 * Defaults (Keys bleiben als data.json-Escape-Hatch, pluginApiAdaptive
 * liest sie weiterhin).
 */

import { App, Setting } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { t } from '../../i18n';
import { addSectionHeading } from './utils';


export class ShellTab {
    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {}

    build(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            t('settings.shell.headingPluginApi'),
            { body: t('settings.shell.sectionPluginApiInfo') },
        );

        new Setting(containerEl)
            .setName(t('settings.shell.enablePluginApi'))
            .setDesc(t('settings.shell.enablePluginApiDesc'))
            .addToggle((tg) =>
                tg.setValue(this.plugin.settings.pluginApi?.enabled ?? true).onChange(async (v) => {
                    if (!this.plugin.settings.pluginApi) {
                        this.plugin.settings.pluginApi = { enabled: true, safeMethodOverrides: {} };
                    }
                    this.plugin.settings.pluginApi.enabled = v;
                    await this.plugin.saveSettings();
                    this.rerender();
                }),
            );

        if (this.plugin.settings.pluginApi?.enabled !== false) {
            const overrides = this.plugin.settings.pluginApi?.safeMethodOverrides ?? {};
            const overrideKeys = Object.keys(overrides).filter((k) => overrides[k]);
            if (overrideKeys.length > 0) {
                addSectionHeading(
                    containerEl,
                    t('settings.shell.headingUserSafe'),
                    { body: t('settings.shell.sectionUserSafeInfo') },
                );
                for (const key of overrideKeys) {
                    new Setting(containerEl)
                        .setName(key)
                        .setDesc(t('settings.shell.markedSafe'))
                        .addButton((btn) =>
                            btn.setButtonText(t('settings.shell.remove')).onClick(async () => {
                                delete this.plugin.settings.pluginApi.safeMethodOverrides[key];
                                // AUDIT 2026-07-26 M-15: drop the promotion count too.
                                // Auto-promotion fires when the count reaches the
                                // threshold, and the count survived the removal --
                                // so the very next approval of this method promoted
                                // it straight back, and the Remove button looked
                                // broken to the user. Revoking a grant has to revoke
                                // the accumulator that granted it.
                                if (this.plugin.settings.pluginApi.approvalCounts) {
                                    delete this.plugin.settings.pluginApi.approvalCounts[key];
                                }
                                await this.plugin.saveSettings();
                                this.rerender();
                            }),
                        );
                }
            }
        }
    }
}
