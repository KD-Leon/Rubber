/**
 * MemoryV2UpgradeModal -- one-time announcement after upgrading from a
 * v1-memory install to a v2-capable Vault Operator build.
 *
 * Triggered from `main.ts` ON FIRST PLUGIN LOAD AFTER UPDATE when the
 * detector finds legacy `memory/<name>.md` files and no v2 facts in
 * the DB yet (status: 'pending'). Fresh installs never see this modal
 * (status: 'not-applicable').
 *
 * Three exits:
 *   1. "Migrate now"    -> caller opens the migration UI flow
 *   2. "Later"          -> caller marks status='skipped' so the modal
 *                          doesn't reappear; user can run it any time
 *                          via Settings -> Memory -> Memory v2 Migration
 *   3. close (X)        -> same as Later
 *
 * The modal explains the v2 improvements (atomic facts, hybrid search,
 * communication styles) and reassures that originals are backed up,
 * not deleted -- so users feel safe clicking "Migrate now" without
 * reading the docs.
 */

import { App, Modal, Setting } from 'obsidian';
import { t } from '../../i18n';

export type MemoryV2UpgradeChoice = 'migrate' | 'later';

export interface MemoryV2UpgradeOptions {
    /** Reason the modal is being shown (informational, not enforced). */
    reason?: 'auto-on-load' | 'manual-from-settings';
}

class MemoryV2UpgradeModalImpl extends Modal {
    private decided = false;

    constructor(
        app: App,
        private opts: MemoryV2UpgradeOptions,
        private resolve: (choice: MemoryV2UpgradeChoice) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('agent-memory-v2-upgrade-modal');

        contentEl.createEl('h2', { text: t('modal.memoryV2Upgrade.title') });

        const intro = contentEl.createEl('p');
        intro.appendText(t('modal.memoryV2Upgrade.intro'));

        const benefits = contentEl.createEl('ul');
        const items: Array<[string, string]> = [
            [t('modal.memoryV2Upgrade.step1Title'), t('modal.memoryV2Upgrade.step1Body')],
            [t('modal.memoryV2Upgrade.step2Title'), t('modal.memoryV2Upgrade.step2Body')],
            [t('modal.memoryV2Upgrade.step3Title'), t('modal.memoryV2Upgrade.step3Body')],
        ];
        for (const [title, body] of items) {
            const li = benefits.createEl('li');
            li.createEl('strong', { text: title + ': ' });
            li.appendText(body);
        }

        const safety = contentEl.createEl('p', { cls: 'agent-memory-v2-upgrade-safety' });
        safety.createEl('strong', { text: t('modal.memoryV2Upgrade.safetyTitle') + ': ' });
        safety.appendText(t('modal.memoryV2Upgrade.safetyBody'));

        const later = contentEl.createEl('p');
        later.appendText(t('modal.memoryV2Upgrade.laterPrefix') + ' ');
        later.createEl('em', { text: t('modal.memoryV2Upgrade.laterPath') });
        later.appendText(t('modal.memoryV2Upgrade.laterSuffix'));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(t('modal.memoryV2Upgrade.later'))
                .onClick(() => this.decide('later')))
            .addButton(btn => btn
                .setButtonText(t('modal.memoryV2Upgrade.upgradeNow'))
                .setCta()
                .onClick(() => this.decide('migrate')));
    }

    private decide(choice: MemoryV2UpgradeChoice): void {
        this.decided = true;
        this.resolve(choice);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.decided) this.resolve('later');
    }
}

/**
 * Open the upgrade modal and return the user's choice. The caller is
 * responsible for honouring it (running the migration or marking
 * settings.memory.v2MigrationStatus='skipped').
 */
export function memoryV2UpgradeModal(
    app: App,
    opts: MemoryV2UpgradeOptions = {},
): Promise<MemoryV2UpgradeChoice> {
    return new Promise(resolve => new MemoryV2UpgradeModalImpl(app, opts, resolve).open());
}
