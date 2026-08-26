/**
 * EPIC-26 / FEAT-26-04 -- one-shot notification modal shown after the
 * automatic activeModels[] -> providerConfigs[] migration. Summarises
 * what was migrated and lists anomalies the user should review.
 */

import { App, Modal, setIcon } from 'obsidian';
import type { MigrationSummary } from '../../core/settings/migrations/activeModelsToProviders';
import { t } from '../../i18n';

export interface MigrationModalCallbacks {
    onOpenSettings: () => void;
    onDismiss: () => void;
}

export class MigrationNotificationModal extends Modal {
    constructor(
        app: App,
        private readonly summary: MigrationSummary,
        private readonly callbacks: MigrationModalCallbacks,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl, summary } = this;
        contentEl.empty();

        // Header
        const header = contentEl.createDiv({ cls: 'mig-modal-header' });
        const icon = header.createSpan({ cls: 'mig-modal-icon' });
        setIcon(icon, 'sparkles');
        header.createEl('h2', { text: t('modal.migrationNotification.title') });

        // Body summary
        const body = contentEl.createDiv({ cls: 'mig-modal-body' });
        body.createEl('p', {
            text: t('modal.migrationNotification.summary', {
                providers: summary.providersCreated,
                models: summary.modelsClassified,
            }),
        });

        if (!summary.activeProviderResolved) {
            const warning = body.createDiv({ cls: 'vault-op-box vault-op-box--warning' });
            const wText = warning.createDiv({ cls: 'vault-op-box__text' });
            wText.createEl('strong', { text: `${t('modal.migrationNotification.noProviderResolved')} ` });
            wText.appendText(t('modal.migrationNotification.pickProvider'));
        }

        if (summary.anomalies.length > 0) {
            body.createEl('h3', { text: t('modal.migrationNotification.reviewHeading') });
            const list = body.createEl('ul', { cls: 'mig-modal-anomalies' });
            for (const anomaly of summary.anomalies) {
                const item = list.createEl('li');
                const label = item.createEl('strong');
                label.setText(`${anomalyLabel(anomaly.kind)}: `);
                item.appendText(anomaly.detail);
            }
        } else {
            body.createEl('p', {
                cls: 'mig-modal-allgood',
                text: t('modal.migrationNotification.noAnomalies'),
            });
        }

        body.createEl('p', {
            cls: 'mig-modal-backup-note',
            text: t('modal.migrationNotification.backupNote'),
        });

        // Buttons
        const buttons = contentEl.createDiv({ cls: 'mig-modal-buttons' });
        const openBtn = buttons.createEl('button', {
            cls: 'mod-cta',
            text: t('onboarding.noModel.settingsButton'),
        });
        openBtn.addEventListener('click', () => {
            this.callbacks.onOpenSettings();
            this.close();
        });

        const okBtn = buttons.createEl('button', { text: t('settings.log.statusOk') });
        okBtn.addEventListener('click', () => {
            this.close();
        });
    }

    onClose(): void {
        this.contentEl.empty();
        this.callbacks.onDismiss();
    }
}

function anomalyLabel(kind: string): string {
    switch (kind) {
        case 'multi-auth':
            return t('modal.migrationNotification.anomalyMultiAuth');
        case 'missing-flagship':
            return t('modal.migrationNotification.anomalyMissingFlagship');
        case 'manual-tier-required':
            return t('modal.migrationNotification.anomalyManualTier');
        case 'no-active-model':
            return t('modal.migrationNotification.anomalyNoActiveProvider');
        default:
            return kind;
    }
}
