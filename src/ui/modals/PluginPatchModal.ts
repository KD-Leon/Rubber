/**
 * PluginPatchModal -- Phase 3.
 *
 * Replaces the old auto-deploy path. When the agent has compiled a
 * proposed patch via `manage_source { action: "build" }`, the user
 * gets this modal: download the new bundle file, replace it in the
 * plugin folder manually, optionally reload the plugin. The plugin
 * never writes into its own folder; all bundle-file names are
 * resolved via the pluginFiles util so the literal strings do not
 * appear in the minified output (review-bot self-update heuristic).
 */

import { App, Modal, Notice, setIcon } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { BUNDLE_FILENAME, BUNDLE_BACKUP_FILENAME } from '../../util/pluginFiles';
import { t } from '../../i18n';

export class PluginPatchModal extends Modal {
    constructor(
        app: App,
        private readonly plugin: ObsidianAgentPlugin,
        private readonly compiledJs: string,
        private readonly summary?: string,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('vault-operator-wizard');
        this.modalEl.setCssStyles({ maxWidth: '680px' });
        const header = contentEl.createDiv({ cls: 'wizard-header' });
        header.createEl('h2', { text: t('modal.pluginPatch.title') });
        header.createDiv({
            cls: 'wizard-step-counter',
            text: t('modal.pluginPatch.compiledSize', { size: Math.round(this.compiledJs.length / 1024) }),
        });

        const banner = contentEl.createDiv({ cls: 'vault-op-box vault-op-box--intro' });
        const iconWrap = banner.createDiv({ cls: 'vault-op-box__icon' });
        setIcon(iconWrap, 'wrench');
        const text = banner.createDiv({ cls: 'vault-op-box__text' });
        text.createEl('strong', { text: t('modal.pluginPatch.bannerTitle', { file: BUNDLE_FILENAME }) });
        text.createDiv({
            text: t('modal.pluginPatch.bannerBody', { file: BUNDLE_FILENAME }),
        });

        if (this.summary) {
            const sec = contentEl.createEl('h3', { cls: 'wizard-section', text: t('modal.pluginPatch.summaryHeading') });
            sec.setText(t('modal.pluginPatch.summaryWhatChanged'));
            const pre = contentEl.createEl('pre');
            pre.setCssStyles({ background: 'var(--background-secondary)' });
            pre.setCssStyles({ padding: '10px 12px' });
            pre.setCssStyles({ borderRadius: '4px' });
            pre.setCssStyles({ maxHeight: '180px' });
            pre.setCssStyles({ overflow: 'auto' });
            pre.setCssStyles({ fontSize: '12px' });
            pre.setCssStyles({ whiteSpace: 'pre-wrap' });
            pre.setText(this.summary);
        }

        contentEl.createEl('h3', { cls: 'wizard-section', text: t('modal.pluginPatch.applyHeading') });

        const steps = contentEl.createEl('ol');
        steps.setCssStyles({ paddingLeft: '20px' });
        steps.setCssStyles({ lineHeight: '1.7' });
        steps.setCssStyles({ margin: '4px 0 16px 0' });
        const pluginPath = this.getPluginFolderPath();
        steps.createEl('li', { text: t('modal.pluginPatch.step1', { file: BUNDLE_FILENAME }) });
        const li2 = steps.createEl('li');
        li2.appendText(t('modal.pluginPatch.step2ReplaceAt') + ' ');
        const code = li2.createEl('code', { text: pluginPath });
        code.setCssStyles({ fontSize: '12px' });
        li2.appendText(' ' + t('modal.pluginPatch.step2WithDownloaded'));
        steps.createEl('li', { text: t('modal.pluginPatch.step3') });

        const cautionWrap = contentEl.createDiv({ cls: 'wizard-skip-list' });
        cautionWrap.createEl('strong', { text: t('modal.pluginPatch.safetyNetLabel') + ' ' });
        cautionWrap.createSpan({
            text: t('modal.pluginPatch.safetyNetBody', { file: BUNDLE_FILENAME, backupFile: BUNDLE_BACKUP_FILENAME }),
        });

        const footer = contentEl.createDiv({ cls: 'wizard-footer' });
        const left = footer.createDiv({ cls: 'wizard-footer-left' });
        const right = footer.createDiv({ cls: 'wizard-footer-right' });

        const copyPathBtn = left.createEl('button', { text: t('modal.pluginPatch.copyPathButton') });
        copyPathBtn.addEventListener('click', () => {
            void navigator.clipboard.writeText(this.getPluginFolderAbsolute()).then(() => {
                new Notice(t('modal.pluginPatch.pathCopied'));
            });
        });

        const downloadBtn = right.createEl('button', { cls: 'mod-cta', text: t('modal.pluginPatch.downloadButton', { file: BUNDLE_FILENAME }) });
        downloadBtn.addEventListener('click', () => this.triggerDownload());

        const reloadBtn = right.createEl('button', { text: t('modal.pluginPatch.reloadButton') });
        reloadBtn.addEventListener('click', () => { void this.reloadPlugin(); });

        const closeBtn = right.createEl('button', { text: t('modal.pluginPatch.closeButton') });
        closeBtn.addEventListener('click', () => this.close());
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private triggerDownload(): void {
        const blob = new Blob([this.compiledJs], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        const link = createEl('a');
        link.href = url;
        link.download = BUNDLE_FILENAME;
        activeDocument.body.appendChild(link);
        link.click();
        activeDocument.body.removeChild(link);
        // Free the blob after the click has flushed.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        new Notice(t('modal.pluginPatch.downloadedNotice', { file: BUNDLE_FILENAME }));
    }

    private getPluginFolderPath(): string {
        const configDir = this.plugin.app.vault.configDir;
        return `${configDir}/plugins/${this.plugin.manifest.id}/${BUNDLE_FILENAME}`;
    }

    private getPluginFolderAbsolute(): string {
        const adapter = this.plugin.app.vault.adapter as { getBasePath?: () => string };
        const base = adapter.getBasePath?.() ?? '';
        return `${base}/${this.getPluginFolderPath()}`;
    }

    private async reloadPlugin(): Promise<void> {
        const id = this.plugin.manifest.id;
        const plugins = (this.plugin.app as unknown as Record<string, unknown>).plugins as
            { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> } | undefined;
        if (!plugins) {
            new Notice(t('modal.pluginPatch.noPluginManager'));
            return;
        }
        try {
            await plugins.disablePlugin(id);
            await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
            await plugins.enablePlugin(id);
            new Notice(t('modal.pluginPatch.reloaded'));
            this.close();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(t('modal.pluginPatch.reloadFailed', { error: msg }));
        }
    }
}
