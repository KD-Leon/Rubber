/**
 * CloudStorageTab -- S3-compatible cloud storage configuration.
 *
 * Lives as a sub-tab of the Advanced settings group. Covers three areas:
 * 1. Connection (endpoint/region/bucket/keys, test button)
 * 2. Media auto-upload (paste/drop images & videos -> public links)
 * 3. Folder sync (bidirectional mirror of one vault folder)
 */

import { App, Notice, Setting } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { DEFAULT_SETTINGS, type CloudStorageSettings } from '../../types/settings';
import { S3Client } from '../../core/cloud/S3Client';
import { FolderSyncService } from '../../core/cloud/FolderSyncService';
import { FolderInputSuggest } from './FolderInputSuggest';
import { addSectionHeading } from './utils';
import { t } from '../../i18n';

export class CloudStorageTab {
    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {}

    private cs(): CloudStorageSettings {
        // Guard against data.json files written before this feature existed.
        if (!this.plugin.settings.cloudStorage) {
            this.plugin.settings.cloudStorage = JSON.parse(
                JSON.stringify(DEFAULT_SETTINGS.cloudStorage),
            ) as CloudStorageSettings;
        }
        return this.plugin.settings.cloudStorage;
    }

    async save(): Promise<void> {
        await this.plugin.saveSettings();
    }

    build(containerEl: HTMLElement): void {
        const cs = this.cs();

        new Setting(containerEl)
            .setName(t('settings.cloud.enable'))
            .setDesc(t('settings.cloud.enableDesc'))
            .addToggle((tg) =>
                tg.setValue(cs.enabled).onChange(async (v) => {
                    cs.enabled = v;
                    await this.save();
                    this.rerender();
                }),
            );

        if (!cs.enabled) return;

        // ── Connection ─────────────────────────────────────────────────────
        addSectionHeading(containerEl, t('settings.cloud.headingConnection'), {
            body: t('settings.cloud.sectionConnectionInfo'),
        });

        this.addTextField(containerEl, 'endpoint', cs.endpoint, async (v) => { await this.update('endpoint', v); });
        this.addTextField(containerEl, 'region', cs.region, async (v) => { await this.update('region', v); });
        this.addTextField(containerEl, 'bucket', cs.bucket, async (v) => { await this.update('bucket', v); });
        this.addTextField(containerEl, 'accessKeyId', cs.accessKeyId, async (v) => { await this.update('accessKeyId', v); });
        this.addSecretField(containerEl, cs.secretAccessKey);

        const test = new Setting(containerEl)
            .setName(t('settings.cloud.testConnection'))
            .setDesc(t('settings.cloud.testConnectionDesc'));
        test.addButton((btn) =>
            btn.setButtonText(t('settings.cloud.testButton')).onClick(async () => {
                btn.setDisabled(true);
                try {
                    const client = new S3Client({
                        endpoint: cs.endpoint,
                        region: cs.region || 'us-east-1',
                        bucket: cs.bucket,
                        accessKeyId: cs.accessKeyId,
                        secretAccessKey: this.plugin.safeStorage.decrypt(cs.secretAccessKey),
                    });
                    await client.testConnection();
                    new Notice(t('settings.cloud.testOk'), 4000);
                } catch (e) {
                    console.warn('[CloudStorage] Test connection failed:', e);
                    new Notice(`${t('settings.cloud.testFail')}: ${e instanceof Error ? e.message : String(e)}`, 8000);
                } finally {
                    btn.setDisabled(false);
                }
            }),
        );

        // ── Media upload ───────────────────────────────────────────────────
        addSectionHeading(containerEl, t('settings.cloud.headingMedia'), {
            body: t('settings.cloud.sectionMediaInfo'),
        });

        this.addTextField(containerEl, 'publicBaseUrl', cs.publicBaseUrl, async (v) => { await this.update('publicBaseUrl', v); });
        this.addTextField(containerEl, 'mediaPrefix', cs.mediaPrefix, async (v) => { await this.update('mediaPrefix', v); });

        // ── Folder sync ────────────────────────────────────────────────────
        addSectionHeading(containerEl, t('settings.cloud.headingSync'), {
            body: t('settings.cloud.sectionSyncInfo'),
        });

        new Setting(containerEl)
            .setName(t('settings.cloud.syncFolder'))
            .setDesc(t('settings.cloud.syncFolderDesc'))
            .addText((txt) => {
                txt
                    .setPlaceholder('Cloud')
                    .setValue(cs.syncFolder)
                    .onChange(async (v) => { await this.update('syncFolder', v.trim()); });
                const suggest = new FolderInputSuggest(this.app, txt.inputEl, []);
                suggest.onPick = (path: string) => { txt.setValue(path); };
            });

        this.addTextField(containerEl, 'remotePrefix', cs.remotePrefix ?? '', async (v) => { await this.update('remotePrefix', v.trim()); });

        new Setting(containerEl)
            .setName(t('settings.cloud.syncInterval'))
            .setDesc(t('settings.cloud.syncIntervalDesc'))
            .addText((txt) => {
                txt.inputEl.type = 'number';
                txt.inputEl.min = '0';
                txt
                    .setValue(String(cs.syncIntervalMinutes))
                    .onChange(async (v) => {
                        const n = Number.parseInt(v, 10);
                        await this.update('syncIntervalMinutes', Number.isFinite(n) && n >= 0 ? n : 0);
                    });
            });

        const lastRun = new Setting(containerEl)
            .setName(t('settings.cloud.lastSync'))
            .setDesc(lastSyncText(cs.lastSyncAt));
        lastRun.addButton((btn) =>
            btn.setButtonText(t('settings.cloud.syncNow')).onClick(() => {
                void new FolderSyncService(this.plugin).syncWithNotices().then(() => {
                    this.rerender();
                });
            }),
        );
    }

    // ── Field helpers ──────────────────────────────────────────────────────

    private async update<K extends keyof CloudStorageSettings>(key: K, value: CloudStorageSettings[K]): Promise<void> {
        this.cs()[key] = value;
        await this.save();
    }

    private addTextField(
        containerEl: HTMLElement,
        labelKey: string,
        value: string,
        onChange: (v: string) => Promise<void>,
    ): void {
        new Setting(containerEl)
            .setName(t(`settings.cloud.${labelKey}`))
            .setDesc(t(`settings.cloud.${labelKey}Desc`))
            .addText((txt) =>
                txt.setValue(value).onChange((v) => { void onChange(v.trim()); }),
            );
    }

    private addSecretField(containerEl: HTMLElement, value: string): void {
        new Setting(containerEl)
            .setName(t('settings.cloud.secretAccessKey'))
            .setDesc(t('settings.cloud.secretAccessKeyDesc'))
            .addText((txt) => {
                txt.inputEl.type = 'password';
                txt.setValue(value).onChange(async (v) => {
                    // Store encrypted at rest (ADR-019 pass-through).
                    this.cs().secretAccessKey = this.plugin.safeStorage.encrypt(v.trim());
                    await this.save();
                });
            });
    }
}

function lastSyncText(lastSyncAt: number): string {
    if (!lastSyncAt) return t('settings.cloud.neverSynced');
    return t('settings.cloud.lastSyncAt').replace('{{when}}', new Date(lastSyncAt).toLocaleString());
}
