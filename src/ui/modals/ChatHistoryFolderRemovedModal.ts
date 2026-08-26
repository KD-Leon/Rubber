/**
 * ChatHistoryFolderRemovedModal -- one-shot notice after the storage layout
 * migration removes the chatHistoryFolder setting.
 *
 * Triggered from `main.ts` ON FIRST PLUGIN LOAD after the layout migration
 * has finished and `settings._chatHistoryFolderLegacy` carries the previous
 * vault-relative path that was in use. Acknowledging clears the field so
 * the modal does not reappear.
 */

import { App, Modal, Setting } from 'obsidian';
import { t } from '../../i18n';

export interface ChatHistoryFolderRemovedModalOptions {
    /** The previous chatHistoryFolder value the user had configured. */
    legacyPath: string;
}

class ChatHistoryFolderRemovedModalImpl extends Modal {
    constructor(
        app: App,
        private opts: ChatHistoryFolderRemovedModalOptions,
        private resolve: () => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: t('modal.chatHistoryRemoved.title') });

        const intro = contentEl.createEl('p');
        intro.appendText(t('modal.chatHistoryRemoved.intro'));

        const previous = contentEl.createEl('p');
        previous.createEl('strong', { text: t('modal.chatHistoryRemoved.previousPathLabel') + ' ' });
        previous.createEl('code', { text: this.opts.legacyPath });

        const cleanup = contentEl.createEl('p');
        cleanup.appendText(t('modal.chatHistoryRemoved.cleanup'));

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText(t('modal.chatHistoryRemoved.gotIt'))
                    .onClick(() => {
                        this.resolve();
                        this.close();
                    }),
            );
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/**
 * Open the modal. Resolves when the user acknowledges (button or X). Caller
 * should clear `settings._chatHistoryFolderLegacy` after the resolve so the
 * modal does not appear again on the next plugin reload.
 */
export function openChatHistoryFolderRemovedModal(
    app: App,
    opts: ChatHistoryFolderRemovedModalOptions,
): Promise<void> {
    return new Promise<void>((resolve) => {
        new ChatHistoryFolderRemovedModalImpl(app, opts, resolve).open();
    });
}
