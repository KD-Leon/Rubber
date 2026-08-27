/**
 * FolderSyncService -- bidirectional vault-folder <-> S3 mirror.
 *
 * Compares local file stats against a ListObjectsV2 listing and resolves each
 * difference deterministically:
 *   - only local  -> upload
 *   - only remote -> download
 *   - both sides  -> newest mtime wins (sizes equal within clock skew => skip)
 *
 * Deliberately simple v1 semantics:
 *   - deletions are NOT propagated (either direction); stale remote copies stay
 *     until overwritten, nothing on disk is ever removed automatically.
 *   - hidden folders (dot-prefixed segments like `.obsidian/`) never sync.
 *
 * The decision function `decideSyncAction` is pure so the comparison rules
 * are unit-testable without network or vault access.
 */

import { Notice, TFolder, normalizePath } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import type { CloudStorageSettings } from '../../types/settings';
import { t } from '../../i18n';
import { S3Client } from './S3Client';

const CLOCK_SKEW_MS = 2_000;

export interface LocalEntry {
    /** Path relative to the synced folder, '/'-separated */
    relPath: string;
    size: number;
    mtimeMs: number;
}

export interface RemoteEntry {
    /** Object key relative to the mirror prefix */
    relPath: string;
    size: number;
    lastModifiedMs: number;
}

export type SyncAction = 'upload' | 'download' | 'skip';

export function decideSyncAction(
    local: LocalEntry | null,
    remote: RemoteEntry | null,
): SyncAction {
    if (local && !remote) return 'upload';
    if (!local && remote) return 'download';
    if (local && remote) {
        if (local.size === remote.size && Math.abs(local.mtimeMs - remote.lastModifiedMs) <= CLOCK_SKEW_MS) {
            return 'skip';
        }
        return local.mtimeMs >= remote.lastModifiedMs ? 'upload' : 'download';
    }
    return 'skip';
}

export interface SyncResult {
    uploaded: number;
    downloaded: number;
    deleted: number;
    skipped: number;
    errors: string[];
}

/** True when any path segment starts with a dot (.obsidian, .trash, ...). */
export function hasHiddenSegment(path: string): boolean {
    return path.split('/').some((seg) => seg.startsWith('.'));
}

export class FolderSyncService {
    constructor(private plugin: ObsidianAgentPlugin) {}

    /** Guard against overlapping passes (timer vs manual vs background). */
    private inFlight = false;

    private cfg(): CloudStorageSettings | null {
        const cs = this.plugin.settings.cloudStorage;
        if (!cs?.enabled || !cs.endpoint || !cs.bucket || !cs.accessKeyId || !cs.secretAccessKey) {
            return null;
        }
        return cs;
    }

    /**
     * Record a delete/rename tombstone so the next pass removes the old
     * remote copy instead of downloading it back. Persisted immediately --
     * deletes are rare and a lost tombstone means a resurrected file.
     */
    recordTombstone(absVaultPath: string): void {
        const cs = this.plugin.settings.cloudStorage;
        if (!cs) return;
        const clean = absVaultPath.replace(/^\/+/, '');
        if (!clean || hasHiddenSegment(clean)) return;
        cs.tombstones = { ...cs.tombstones, [clean]: Date.now() };
        void this.plugin.saveSettings();
    }

    /** A recreated path is alive again -- drop its tombstone. */
    clearTombstone(absVaultPath: string): void {
        const cs = this.plugin.settings.cloudStorage;
        if (!cs?.tombstones?.[absVaultPath]) return;
        const { [absVaultPath]: _gone, ...rest } = cs.tombstones;
        cs.tombstones = rest;
        void this.plugin.saveSettings();
    }

    /**
     * Quiet pass for background triggers (edit-settle debounce).
     * No Notices -- failures only surface in the console.
     */
    async syncSilently(): Promise<void> {
        try {
            await this.syncNow();
        } catch (e) {
            console.warn('[CloudStorage] Background sync failed:', e);
        }
    }

    async syncNow(onProgress?: (done: number, total: number) => void): Promise<SyncResult> {
        if (this.inFlight) throw new Error('sync-already-running');
        this.inFlight = true;
        try {
            return await this.runPass(onProgress);
        } finally {
            this.inFlight = false;
        }
    }

    private async runPass(onProgress?: (done: number, total: number) => void): Promise<SyncResult> {
        const cs = this.cfg();
        if (!cs) throw new Error('cloud-storage-not-configured');
        // Empty sync folder means the WHOLE vault (root); there is no
        // opt-out anymore -- to disable syncing just leave the connection
        // incomplete or toggle cloudStorage off.
        const folder = normalizeFolderPath(cs.syncFolder);

        const client = new S3Client({
            endpoint: cs.endpoint,
            region: cs.region || 'us-east-1',
            bucket: cs.bucket,
            accessKeyId: cs.accessKeyId,
            secretAccessKey: this.plugin.safeStorage.decrypt(cs.secretAccessKey),
        });

        const prefix = mirrorPrefixFor(folder, cs.remotePrefix);
        const mediaPrefix = `${normalizeFolderPath(cs.mediaPrefix)}/`;

        // Prune stale tombstones (30 days) and map the rest to rel paths
        // under the current sync root.
        const tombstones = { ...cs.tombstones };
        const cutoff = Date.now() - 30 * 24 * 3600_000;
        let tombstonesChanged = false;
        for (const [abs, ts] of Object.entries(tombstones)) {
            if (ts < cutoff) {
                delete tombstones[abs];
                tombstonesChanged = true;
            }
        }
        const tombstonedRels = new Set<string>();
        for (const abs of Object.keys(tombstones)) {
            const rel = folder ? (abs.startsWith(`${folder}/`) ? abs.slice(folder.length + 1) : null) : abs;
            if (rel && !hasHiddenSegment(rel)) tombstonedRels.add(rel);
        }
        if (tombstonesChanged) {
            cs.tombstones = tombstones;
            void this.plugin.saveSettings();
        }

        const remoteAll = await client.listObjects(prefix);
        const localFiles = listLocalEntries(this.plugin, folder);

        // Map remote keys back to relative paths under the prefix.
        const remote = new Map<string, RemoteEntry>();
        for (const obj of remoteAll) {
            if (!obj.key.startsWith(prefix)) continue;
            // Never mirror our own media uploads back into the vault.
            if (mediaPrefix !== '/' && obj.key.startsWith(mediaPrefix)) continue;
            const rel = obj.key.slice(prefix.length).replace(/^\/+/, '');
            if (!rel || hasHiddenSegment(rel)) continue; // trailing "/" pseudo-folders drop out here too
            remote.set(rel, { relPath: rel, size: obj.size, lastModifiedMs: obj.lastModifiedMs });
        }

        // Union of both sides keyed by relative path.
        const allPaths = new Set<string>([...localFiles.keys(), ...remote.keys()]);
        const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, skipped: 0, errors: [] };
        let done = 0;
        const total = allPaths.size;

        for (const rel of sortedPaths(allPaths)) {
            try {
                const localEntry = localFiles.get(rel) ?? null;
                const remoteEntry = remote.get(rel) ?? null;
                const action = decideSyncAction(
                    localEntry
                        ? { relPath: rel, size: localEntry.size, mtimeMs: localEntry.mtimeMs }
                        : null,
                    remoteEntry,
                );
                if (action === 'upload') {
                    // Recreated after a delete -- the old tombstone is void.
                    if (tombstonedRels.has(rel)) {
                        delete cs.tombstones?.[joinVaultPath(folder, rel)];
                    }
                    const buf = await readVaultBinary(this.plugin, joinVaultPath(folder, rel));
                    await client.putObject(`${prefix}/${rel}`, buf, guessContentType(rel));
                    result.uploaded++;
                } else if (action === 'download') {
                    // Tombstoned means "deleted/renamed locally" -- remove
                    // the stale remote copy instead of resurrecting it.
                    if (tombstonedRels.has(rel)) {
                        await client.deleteObject(`${prefix}/${rel}`);
                        result.deleted++;
                    } else {
                        const abs = joinVaultPath(folder, rel);
                        await ensureParentFolder(this.plugin, abs);
                        const data = await client.getObject(`${prefix}/${rel}`);
                        await this.plugin.app.vault.adapter.writeBinary(normalizePath(abs), data);
                        result.downloaded++;
                    }
                } else {
                    result.skipped++;
                }
            } catch (e) {
                result.errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
            }
            done++;
            onProgress?.(done, total);
        }

        if (result.errors.length === 0) {
            cs.lastSyncAt = Date.now();
            await this.plugin.saveSettings();
        }
        return result;
    }

    /**
     * Manual trigger path: run a pass with Notices for feedback.
     * Returns true when the sync ran at all (config valid).
     */
    async syncWithNotices(): Promise<boolean> {
        if (!this.cfg()) {
            new Notice(t('settings.cloud.errorNotConfigured'), 6000);
            return false;
        }
        const progressNotice = new Notice('', 0);
        try {
            const res = await this.syncNow((done, total) => {
                progressNotice.setMessage(
                    `${t('settings.cloud.syncProgress')} ${done}/${total}`,
                );
            });
            if (res.errors.length > 0) {
                console.warn('[CloudStorage] Sync finished with errors:', res.errors);
                new Notice(`${t('settings.cloud.syncDone')}: ${res.errors.length} error(s) -- see console`, 8000);
            }
            new Notice(
                `${t('settings.cloud.syncDone')}: +${res.uploaded} ↑ / +${res.downloaded} ↓ / ${res.deleted} ✕ / ${res.skipped} ✓`,
                5000,
            );
            return true;
        } catch (e) {
            console.error('[CloudStorage] Sync failed:', e);
            const raw = e instanceof Error ? e.message : String(e);
            // Predefined error conditions carry their own i18n key.
            const msg =
                raw === 'sync-folder-not-set' ? t('settings.cloud.errorFolderNotSet')
                : raw === 'cloud-storage-not-configured' ? t('settings.cloud.errorNotConfigured')
                : raw;
            new Notice(msg, 8000);
            return false;
        } finally {
            // Clearing pattern for sticky notices (timeout ~0): replace text then expire.
            progressNotice.hide();
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function normalizeFolderPath(raw: string): string {
    const p = raw.trim().replace(/^[\\/]+|[\\/]+$/g, '');
    return p && p !== '/' ? p : '';
}

/** Mirror prefix defaults to the folder's own name (keeps bucket tidy). */
export function mirrorPrefixFor(folder: string, explicitRemote?: string): string {
    const clean = (explicitRemote ?? '').replace(/^\/+|\/+$/g, '');
    if (clean) return clean;
    const normalized = normalizeFolderPath(folder);
    // Whole-vault mode (empty folder) mirrors under a stable root prefix
    // instead of the bucket top level -- keeps it separate from media/.
    return normalized ? normalized.split('/').pop() ?? normalized : 'vault';
}

function joinVaultPath(folder: string, rel: string): string {
    return folder ? `${folder}/${rel}` : rel;
}

function sortedPaths(paths: Iterable<string>): string[] {
    return [...paths].sort();
}

/**
 * Collect every non-hidden file below `folder` with its stat snapshot.
 * An empty folder collects the whole vault. Returns a map keyed by path
 * relative to the folder.
 */
function listLocalEntries(plugin: ObsidianAgentPlugin, folder: string): Map<string, LocalEntry> {
    const prefix = folder ? `${folder}/` : '';
    const out = new Map<string, LocalEntry>();
    for (const f of plugin.app.vault.getFiles()) {
        if (!f.path.startsWith(prefix)) continue;
        const rel = f.path.slice(prefix.length);
        if (!rel || hasHiddenSegment(rel)) continue;
        out.set(rel, { relPath: rel, size: f.stat.size, mtimeMs: f.stat.mtime });
    }
    return out;
}

async function readVaultBinary(plugin: ObsidianAgentPlugin, path: string): Promise<ArrayBuffer> {
    const adapter = plugin.app.vault.adapter;
    return adapter.readBinary(normalizePath(path));
}

/** Create every missing ancestor folder for an absolute vault path. */
async function ensureParentFolder(plugin: ObsidianAgentPlugin, filePath: string): Promise<void> {
    const parts = filePath.split('/').slice(0, -1);
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const existing = plugin.app.vault.getAbstractFileByPath(current);
        if (existing instanceof TFolder) continue;
        try {
            await plugin.app.vault.createFolder(current);
        } catch {
            // Raced creation or already exists -- safe to ignore, the next
            // write will surface a real error if the folder is still absent.
        }
    }
}

function guessContentType(path: string): string {
    const ext = (path.split('.').pop() ?? '').toLowerCase();
    switch (ext) {
        case 'md': case 'markdown': return 'text/markdown';
        case 'txt': return 'text/plain';
        case 'json': return 'application/json';
        case 'png': return 'image/png';
        case 'jpg': case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'svg': return 'image/svg+xml';
        case 'mp4': return 'video/mp4';
        case 'mov': return 'video/quicktime';
        case 'mp3': return 'audio/mpeg';
        case 'pdf': return 'application/pdf';
        default: return 'application/octet-stream';
    }
}
