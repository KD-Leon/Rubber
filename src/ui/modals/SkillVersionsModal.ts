/**
 * FEAT-29-09 Step C: SkillVersionsModal.
 *
 * Lists snapshot history for a single skill. User can restore an old
 * version, tag a version with a name (so it survives prune), or remove
 * a tag. Restore always creates a pre-restore snapshot first so the
 * operation is reversible from within the modal.
 */

import { App, Modal, Notice, setIcon } from 'obsidian';
import type { SkillSnapshotService, SnapshotMetadata } from '../../core/skills/SkillSnapshotService';
import { confirmModal, promptModal } from './PromptModal';
import { t } from '../../i18n';

export class SkillVersionsModal extends Modal {
    constructor(
        app: App,
        private skillName: string,
        private snapshotService: SkillSnapshotService,
        private onAfterChange?: () => void,
    ) {
        super(app);
    }

    async onOpen(): Promise<void> {
        this.titleEl.setText(t('modal.skillVersions.title', { skill: this.skillName }));
        await this.render();
    }

    private async render(): Promise<void> {
        this.contentEl.empty();
        const snapshots = await this.snapshotService.list(this.skillName);

        if (snapshots.length === 0) {
            const empty = this.contentEl.createDiv({ cls: 'mod-muted' });
            empty.setText(t('modal.skillVersions.empty'));
            return;
        }

        const intro = this.contentEl.createEl('p', { cls: 'mod-muted' });
        intro.setText(t('modal.skillVersions.intro', { count: snapshots.length }));

        const list = this.contentEl.createDiv({ cls: 'skill-versions-list' });
        for (const snap of snapshots) {
            this.renderSnapshotRow(list, snap);
        }
    }

    private renderSnapshotRow(parent: HTMLElement, snap: SnapshotMetadata): void {
        const row = parent.createDiv({ cls: 'skill-version-row' });

        const info = row.createDiv({ cls: 'skill-version-info' });
        const when = new Date(snap.createdAt).toLocaleString();
        const fileText = snap.fileCount === 1
            ? t('modal.skillVersions.fileCountOne')
            : t('modal.skillVersions.fileCountMany', { count: snap.fileCount });
        info.createDiv({ text: when });
        const meta = info.createDiv({ cls: 'mod-muted skill-version-meta' });
        const labelBadge = snap.label === 'pre-restore' ? t('modal.skillVersions.preRestoreBadge') + ' ' : '';
        const tagText = snap.tags.length > 0 ? ` · ${t('modal.skillVersions.tagsLabel', { tags: snap.tags.join(', ') })}` : '';
        meta.setText(`${labelBadge}${fileText}, ${this.formatBytes(snap.totalBytes)}${tagText}`);

        const actions = row.createDiv({ cls: 'skill-version-actions' });

        const restoreBtn = actions.createEl('button', { cls: 'mod-cta' });
        setIcon(restoreBtn, 'rotate-ccw');
        restoreBtn.setAttribute('aria-label', t('modal.skillVersions.restoreAriaLabel'));
        restoreBtn.addEventListener('click', () => { void this.handleRestore(snap); });

        const tagBtn = actions.createEl('button');
        setIcon(tagBtn, 'tag');
        tagBtn.setAttribute('aria-label', t('modal.skillVersions.tagAriaLabel'));
        tagBtn.addEventListener('click', () => { void this.handleTag(snap); });
    }

    private async handleRestore(snap: SnapshotMetadata): Promise<void> {
        const ok = await confirmModal(this.app, {
            title: t('modal.skillVersions.restoreConfirmTitle'),
            message: t('modal.skillVersions.restoreConfirmMessage', {
                skill: this.skillName,
                date: new Date(snap.createdAt).toLocaleString(),
            }),
            confirmLabel: t('ui.editReview.restore'),
        });
        if (!ok) return;

        try {
            await this.snapshotService.restore(this.skillName, snap.id);
            new Notice(t('modal.skillVersions.restoredNotice', { skill: this.skillName, snapshotId: snap.id }));
            this.onAfterChange?.();
            await this.render();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(t('modal.skillVersions.restoreFailed', { error: msg }), 10_000);
        }
    }

    private async handleTag(snap: SnapshotMetadata): Promise<void> {
        const existing = snap.tags.join(', ');
        const input = await promptModal(this.app, {
            title: t('modal.skillVersions.editTagsTitle'),
            message: t('modal.skillVersions.editTagsMessage'),
            defaultValue: existing,
            submitLabel: t('modal.skillVersions.saveTagsButton'),
        });
        if (input === null) return;

        const newTags = input
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        try {
            // Remove tags that were dropped
            for (const oldTag of snap.tags) {
                if (!newTags.includes(oldTag)) {
                    await this.snapshotService.untag(this.skillName, snap.id, oldTag);
                }
            }
            // Add new tags
            for (const newTag of newTags) {
                if (!snap.tags.includes(newTag)) {
                    await this.snapshotService.tag(this.skillName, snap.id, newTag);
                }
            }
            new Notice(t('modal.skillVersions.tagsUpdated'));
            await this.render();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(t('modal.skillVersions.tagUpdateFailed', { error: msg }), 10_000);
        }
    }

    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
}
