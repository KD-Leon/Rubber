import { App, Modal, Notice, Setting } from 'obsidian';
import { t } from '../../i18n';

/**
 * SoakReportModal -- shows the Memory v2 health snapshot as a JSON
 * blob that the user can copy to the chat for analysis.
 *
 * Background: the previous "copy to clipboard on command" path
 * silently failed when the sidebar didn't own the focus (browser
 * clipboard API rejects in that case, but our Notice was already
 * fired). A modal makes the copy a real user gesture and gives a
 * Save-to-vault fallback so the data is never lost.
 */
export class SoakReportModal extends Modal {
    constructor(
        app: App,
        private json: string,
        private saveToVault: () => Promise<string>,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('vault-operator-soak-report-modal');

        contentEl.createEl('h3', { text: t('modal.soakReport.title') });

        const desc = contentEl.createEl('p');
        desc.appendText(t('modal.soakReport.desc'));

        const ta = contentEl.createEl('textarea', {
            cls: 'vault-operator-soak-report-textarea',
        });
        ta.value = this.json;
        ta.readOnly = true;
        ta.spellcheck = false;
        ta.rows = 18;
        // Auto-select on focus so a fast Cmd+A / Cmd+C still works.
        ta.addEventListener('focus', () => ta.select());

        new Setting(contentEl)
            .addButton((btn) => btn
                .setButtonText(t('modal.promptPreview.copy'))
                .setCta()
                .onClick(async () => {
                    try {
                        await navigator.clipboard.writeText(this.json);
                        new Notice(t('notice.memory.soakCopied'));
                    } catch {
                        // Clipboard rejected (no focus, permission denied).
                        // The textarea is auto-selected on focus, so the
                        // user can still copy manually with Cmd/Ctrl+C, or
                        // use "Save to vault" instead.
                        ta.focus();
                        new Notice(t('notice.memory.soakCopyBlocked'));
                    }
                }))
            .addButton((btn) => btn
                .setButtonText(t('modal.soakReport.saveToVault'))
                .onClick(async () => {
                    try {
                        const path = await this.saveToVault();
                        new Notice(t('notice.memory.soakSaved', { path }));
                    } catch (e) {
                        console.warn('[SoakReportModal] Save to vault failed:', e);
                        new Notice(t('notice.memory.soakSaveFailed'));
                    }
                }))
            .addButton((btn) => btn
                .setButtonText(t('modal.vaultHealth.closeBtn'))
                .onClick(() => this.close()));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
