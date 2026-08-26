/**
 * StorageLayoutUpgradeModal -- one-time prompt for installs whose persistent
 * data still lives next to the vault instead of inside it.
 *
 * FEAT-29-01-02 (Issue #69). The consolidation and its settings button existed
 * long before this modal, but nothing ever told anyone they were on the old
 * layout. The reporter only found the setting after debugging why their model
 * configuration and workflows had not followed a synced vault to a second
 * machine. Passive availability is not discoverability for a migration whose
 * whole point is that you do not notice you need it.
 *
 * The modal deliberately leads with the consequence (your settings and
 * workflows do not travel with the vault) rather than with the mechanism
 * (folder names, backup snapshots). The settings section had it the other way
 * round, which is why it read like internal maintenance.
 *
 * Two exits, and "later" is a real answer:
 *   1. "Move data into the vault" -> caller sets the opt-in flag and reloads
 *   2. "Keep as is"               -> caller records the one-shot flag
 *   3. close (X)                  -> same as "Keep as is"
 *
 * Gated on hasMigratableSharedData(), NOT on detectLegacyLayoutPresence():
 * the latter is a fail-safe veto for the fast path and answers true in cases
 * where there is nothing to migrate.
 */

import { App, Modal, Setting } from 'obsidian';
import { t } from '../../i18n';

export type StorageLayoutUpgradeChoice = 'migrate' | 'later';

class StorageLayoutUpgradeModalImpl extends Modal {
    private decided = false;

    constructor(
        app: App,
        private resolve: (choice: StorageLayoutUpgradeChoice) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('agent-storage-layout-upgrade-modal');

        contentEl.createEl('h2', { text: t('modal.storageLayoutUpgrade.title') });
        contentEl.createEl('p', { text: t('modal.storageLayoutUpgrade.intro') });

        const affected = contentEl.createEl('ul');
        for (const item of [
            t('modal.storageLayoutUpgrade.item1'),
            t('modal.storageLayoutUpgrade.item2'),
            t('modal.storageLayoutUpgrade.item3'),
        ]) {
            affected.createEl('li', { text: item });
        }

        const safety = contentEl.createEl('p');
        safety.createEl('strong', { text: t('modal.storageLayoutUpgrade.safetyTitle') + ': ' });
        safety.appendText(t('modal.storageLayoutUpgrade.safetyBody'));

        contentEl.createEl('p', { text: t('modal.storageLayoutUpgrade.laterHint') });

        new Setting(contentEl)
            .addButton((btn) => btn
                .setButtonText(t('modal.storageLayoutUpgrade.later'))
                .onClick(() => this.decide('later')))
            .addButton((btn) => btn
                .setButtonText(t('modal.storageLayoutUpgrade.migrateNow'))
                .setCta()
                .onClick(() => this.decide('migrate')));
    }

    private decide(choice: StorageLayoutUpgradeChoice): void {
        this.decided = true;
        this.resolve(choice);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
        // Dismissing without choosing is "not now", never an implicit yes:
        // this migration moves user data.
        if (!this.decided) this.resolve('later');
    }
}

/**
 * Open the prompt and return the choice. The caller honours it (set
 * `_layoutMigrationOptIn` and reload, or record the one-shot flag).
 */
export function storageLayoutUpgradeModal(app: App): Promise<StorageLayoutUpgradeChoice> {
    return new Promise((resolve) => new StorageLayoutUpgradeModalImpl(app, resolve).open());
}
