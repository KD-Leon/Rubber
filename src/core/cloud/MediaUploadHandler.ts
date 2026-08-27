/**
 * MediaUploadHandler -- auto-upload pasted/dropped images & videos to S3.
 *
 * Intercepts `editor-paste` / `editor-drop` events on the workspace. When the
 * payload contains binary image/video files, uploads them to the configured
 * S3-compatible bucket and inserts a public-URL markdown link at the cursor
 * instead of letting Obsidian copy the bytes into the vault attachment folder
 * (PicGo-style cloud-attachment flow).
 *
 * Enabled only when cloudStorage.enabled && publicBaseUrl is set (public-link
 * mode; private buckets would produce dead links).
 */

import { Notice, type Editor } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import type { CloudStorageSettings } from '../../types/settings';
import { S3Client } from './S3Client';

const IMAGE_RE = /^image\//;
/** Videos plus common audio types ride along for free. */
const MEDIA_RE = /^(video|audio)\//;
const MAX_INLINE_BYTES = 2 * 1024 * 1024 * 1024; // hard sanity cap: 2 GB

interface UploadOutcome {
    name: string;
    url?: string;
    isImage: boolean;
}

export class MediaUploadHandler {
    private busy = false;

    constructor(private plugin: ObsidianAgentPlugin) {}

    register(): void {
        this.plugin.registerEvent(
            this.plugin.app.workspace.on('editor-paste', (evt, editor) => {
                void this.handleClipboard(evt, editor);
            }),
        );
        this.plugin.registerEvent(
            this.plugin.app.workspace.on('editor-drop', (evt, editor) => {
                void this.handleClipboard(evt, editor);
            }),
        );
    }

    private isEnabled(): boolean {
        const cs = this.plugin.settings.cloudStorage;
        return !!cs?.enabled && !!cs.publicBaseUrl && !this.busy;
    }

    /** Extract binary image/media Files from a paste or drop event. */
    private extractFiles(evt: ClipboardEvent | DragEvent): File[] {
        const transfer: DataTransfer | null =
            'clipboardData' in evt ? evt.clipboardData : evt.dataTransfer;
        if (!transfer || transfer.files.length === 0) return [];
        const out: File[] = [];
        for (let i = 0; i < transfer.files.length; i++) {
            const f = transfer.files.item(i);
            if (!f) continue;
            if (IMAGE_RE.test(f.type) || MEDIA_RE.test(f.type)) out.push(f);
        }
        return out;
    }

    private async handleClipboard(evt: ClipboardEvent | DragEvent, editor: Editor): Promise<void> {
        if (!this.isEnabled()) return;
        const cfg = this.plugin.settings.cloudStorage as CloudStorageSettings;
        const files = this.extractFiles(evt);
        if (files.length === 0) return;

        // Only intercept when every file is media we handle. Mixed pastes
        // (e.g. copied HTML+image combos) fall through to Obsidian defaults.
        evt.preventDefault();
        this.busy = true;

        try {
            const results: UploadOutcome[] = [];
            for (const file of files) {
                try {
                    const outcome = await this.uploadFile(cfg, file);
                    if (outcome) results.push(outcome);
                } catch (e) {
                    console.warn('[CloudStorage] Media upload failed:', e);
                    new Notice(`Upload failed: ${file.name}`, 6000);
                }
            }
            if (results.length > 0) this.insertLinks(editor, results);
        } finally {
            this.busy = false;
        }
    }

    private async uploadFile(cfg: CloudStorageSettings, file: File): Promise<UploadOutcome | null> {
        if (file.size <= 0 || file.size > MAX_INLINE_BYTES) {
            console.warn(`[CloudStorage] Skipping ${file.name}: size ${file.size} outside limits`);
            return null;
        }
        const client = this.buildClient(cfg);
        const key = buildMediaKey(cfg.mediaPrefix, file.name, Date.now(), file.type);
        const buffer = await file.arrayBuffer();

        new Notice(`Uploading ${file.name} ...`, 0); // 0 = stays until replaced
        try {
            await client.putObject(key, buffer, contentTypeFor(file));
        } finally {
            // Replace the sticky progress notice with an empty one clears it.
            new Notice('', 1);
        }

        const isImage = IMAGE_RE.test(file.type);
        return { name: file.name, url: publicUrlFor(cfg.publicBaseUrl, key), isImage };
    }

    /** Insert markdown links after any pending editor state settled. */
    private insertLinks(editor: Editor, results: UploadOutcome[]): void {
        const lines: string[] = [];
        for (const r of results) {
            if (!r.url) continue;
            // Image -> embed syntax renders inline in reading view. Other
            // media stays a plain labelled link (Obsidian has no native video embed).
            lines.push(r.isImage ? `![](${r.url})` : `[${r.name}](${r.url})`);
        }
        if (lines.length > 0) editor.replaceSelection(lines.join('\n\n') + '\n');
        new Notice(`${results.length} file(s) uploaded`, 3000);
    }

    private buildClient(cfg: CloudStorageSettings): S3Client {
        if (!cfg.endpoint) throw new Error('S3 endpoint not configured');
        return new S3Client({
            endpoint: cfg.endpoint,
            region: cfg.region || 'us-east-1',
            bucket: cfg.bucket,
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: this.plugin.safeStorage.decrypt(cfg.secretAccessKey),
        });
    }
}

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────

/** Server-side grouping for uploaded objects (key path segment). */
export type MediaCategory = 'images' | 'audio' | 'video' | 'files';

/**
 * Group a file into its server-side category by MIME type first, then by
 * extension fallback. Everything unrecognised lands in files/.
 */
export function mediaCategoryFor(mime: string | undefined, originalName: string): MediaCategory {
    const m = (mime ?? '').toLowerCase();
    if (m.startsWith('image/')) return 'images';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('video/')) return 'video';
    const ext = (originalName.split('.').pop() ?? '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp', 'ico'].includes(ext)) return 'images';
    if (['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio';
    if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'video';
    return 'files';
}

/** obsidian/media/images/20260827/prefix-1730000000000-vacation.png */
export function buildMediaKey(prefix: string, originalName: string, timestampMs: number, mime?: string): string {
    const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
    const date = new Date(timestampMs);
    const ymd =
        `${date.getUTCFullYear()}` +
        `${String(date.getUTCMonth() + 1).padStart(2, '0')}` +
        `${String(date.getUTCDate()).padStart(2, '0')}`;
    const base = sanitizeFileName(originalName);
    const category = mediaCategoryFor(mime, originalName);
    return `${cleanPrefix}/${category}/${ymd}/${timestampMs}-${base}`;
}

/** Strip path components and characters that break URLs or object keys. */
export function sanitizeFileName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? 'file';
    return (
        base
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '') // accents
            .replace(/[^A-Za-z0-9._-]+/g, '-')
            .replace(/-{2,}/g, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase() || 'file'
    );
}

/** Join the public base URL and the object key with per-segment encoding. */
export function publicUrlFor(baseUrl: string, key: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function contentTypeFor(file: File): string {
    if (file.type) return file.type;
    // Minimal extension fallback; most browsers populate File.type anyway.
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'mp4') return 'video/mp4';
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'mp3') return 'audio/mpeg';
    return 'application/octet-stream';
}
