/**
 * ClipWebPageTool -- archive a web page into the vault the way the Obsidian Web
 * Clipper does: full text as Markdown, images pulled down as real vault files
 * with the links rewritten to point at them, under an agent-written header.
 *
 * Fills the gap between web_fetch (reads a page into context, keeps images as
 * foreign URLs, truncates at 20k chars) and ingest_document (archives a file,
 * but knows no URLs). See _devprocess bau-anleitung-clip-web-page.md.
 *
 * Security posture (spec 4.5): effect class 'web' + vault write. Every URL -- the
 * page AND every image -- goes through the SAME node:http SSRF guard chain as
 * web_fetch (ssrfGuard.ts), including per-redirect-hop re-validation. Image
 * writes go only through writeBinaryToVault -> vaultPathGuard. The full text
 * lands in the FILE, not the model context; only the short title/description are
 * returned to the model, defanged as untrusted content.
 */

import { BaseTool } from '../BaseTool';
import { defangBoundaryTags } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import type { BatchEditPreview } from '../editPreview';
import { assertSafeVaultPath } from '../vault/vaultPathGuard';
import { writeBinaryToVault } from '../vault/writeBinaryToVault';
import { htmlToMarkdown } from './htmlToMarkdown';
import { guardUrl, fetchWithRedirectGuard } from './ssrfGuard';
import {
    extractMarkdownImageRefs,
    rewriteImageLinks,
    imageExtFromBytes,
    imageExtFromContentType,
    imageFilenameFor,
    sanitizeSvg,
    slugForUrl,
} from './imageClipper';
import { t } from '../../../i18n';

interface ClipWebPageInput {
    url: string;
    target_path: string;
    header_content?: string;
    attachments_folder?: string;
    max_images?: number;
}

/** Guard rails (spec 4.2 step 4). */
const PAGE_TIMEOUT_MS = 20_000;
const IMAGE_TIMEOUT_MS = 20_000;
const MAX_PARSE_BYTES = 2_000_000; // 2 MB, mirrors WebFetchTool
const DEFAULT_MAX_IMAGES = 20;
const MAX_MAX_IMAGES = 50;
const PER_IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per image
const TOTAL_IMAGE_BUDGET_BYTES = 40 * 1024 * 1024; // 40 MB across all images

export class ClipWebPageTool extends BaseTool<'clip_web_page'> {
    readonly name = 'clip_web_page' as const;
    readonly isWriteOperation = true;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    /**
     * Scope-only preview (like ingest_document): the composed note is the header
     * plus the full page text with an unknown number of images, so no diff can
     * be rendered up front. The card names the note, the source URL, and the
     * attachment target folder.
     */
    async previewBatch(input: Record<string, unknown>): Promise<BatchEditPreview | null> {
        const { url, target_path, attachments_folder } = input as unknown as ClipWebPageInput;
        if (typeof target_path !== 'string' || target_path.length === 0) return null;
        if (typeof url !== 'string' || url.length === 0) return null;
        const exists = this.app.vault.getAbstractFileByPath(target_path) !== null;
        const folder = await this.resolveAttachmentsFolder(attachments_folder, url);
        return {
            entries: [{ path: target_path, before: '', after: '', isNew: !exists }],
            summary: t('ui.approval.scope.clipWebPage', { url, path: target_path, folder }),
            scopeOnly: true,
        };
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'clip_web_page',
            description:
                'Archive a web page into the vault like the Obsidian Web Clipper: the full page text as Markdown, ' +
                'its images downloaded as real vault files with the links rewritten to point at them, under a header ' +
                'you write. Use this to permanently save an article/source (unlike web_fetch, which only reads a page ' +
                'into context, keeps images as remote URLs, and truncates long pages). ' +
                'You provide header_content (complete frontmatter incl. the opening and closing ---, plus your summary); ' +
                'the tool appends a "## Originaltext" heading and the full text automatically, bypassing output token ' +
                'limits. If you omit header_content, a minimal frontmatter is written. ' +
                'LIMITS: it does NOT run JavaScript -- content a page loads only in the browser is not in the HTML and ' +
                'is not clipped; no paywall bypass, no login, no cookies. This is a deferred tool: activate it with ' +
                'find_tool("clip web page") before the first call.',
            input_schema: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The page URL to clip (must start with http:// or https://).',
                    },
                    target_path: {
                        type: 'string',
                        description: 'Vault-relative path for the new note. Must end with .md.',
                    },
                    header_content: {
                        type: 'string',
                        description:
                            'Optional. Complete frontmatter (YAML, incl. the opening and closing ---) plus your overview/summary. ' +
                            'Everything ABOVE the "## Originaltext" section. If omitted, a minimal frontmatter (url, type, description) is written.',
                    },
                    attachments_folder: {
                        type: 'string',
                        description:
                            'Optional. Vault folder for the downloaded images. Default: the Obsidian attachment folder ' +
                            'plus /clips/<page-slug>/, which keeps images sorted and makes deleting a clip one folder operation.',
                    },
                    max_images: {
                        type: 'number',
                        description: `Optional. Max images to download (default ${DEFAULT_MAX_IMAGES}, hard cap ${MAX_MAX_IMAGES}).`,
                    },
                },
                required: ['url', 'target_path'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { url, target_path, header_content, attachments_folder, max_images } =
            input as unknown as ClipWebPageInput;
        const { callbacks } = context;

        try {
            if (!url || typeof url !== 'string') {
                throw new Error('url is required');
            }
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                throw new Error('url must start with http:// or https://');
            }
            if (!target_path || typeof target_path !== 'string') {
                throw new Error('target_path is required');
            }
            // Reject traversal / absolute / wrong-extension BEFORE any network work.
            assertSafeVaultPath(target_path, { paramName: 'target_path', expectedExtension: '.md' });
            if (this.app.vault.getAbstractFileByPath(target_path) !== null) {
                throw new Error(`File already exists: ${target_path}. Choose a different target_path.`);
            }

            // SSRF phase-1/2 on the page URL before the "Fetching" log.
            const pageGuard = await guardUrl(url);
            if (!pageGuard.ok) {
                throw new Error(pageGuard.reason);
            }

            callbacks.log(`Clipping: ${url}`);
            const pageResponse = await fetchWithRedirectGuard(url, {
                timeoutMs: PAGE_TIMEOUT_MS,
                responseType: 'text',
            });
            if (pageResponse.status >= 400) {
                throw new Error(`HTTP ${pageResponse.status} error fetching ${url}`);
            }
            const finalUrl = pageResponse.finalUrl;

            const rawHtml = pageResponse.text ?? '';
            const safeHtml = rawHtml.length > MAX_PARSE_BYTES ? rawHtml.slice(0, MAX_PARSE_BYTES) : rawHtml;
            const title = this.extractTitle(safeHtml);
            const markdown = htmlToMarkdown(safeHtml);

            // Image work-list from the CONVERTED markdown (every ref is guaranteed
            // present, so the rewrite always finds it -- no orphan downloads).
            const allRefs = extractMarkdownImageRefs(markdown, finalUrl);
            const maxImages = this.resolveMaxImages(max_images);
            const refs = allRefs.slice(0, maxImages);
            if (allRefs.length > refs.length) {
                callbacks.log(`clip_web_page: capping images at ${maxImages} of ${allRefs.length} found.`);
            }

            const folder = await this.resolveAttachmentsFolder(attachments_folder, url);
            // The pipeline governs the RAW attachments_folder, but resolveAttachmentsFolder
            // trims it, so a whitespace-divergent value like " .obsidian/plugins" collapses
            // onto a real deny zone AFTER the pipeline check passed. Re-run the deny-zone
            // check on the RESOLVED folder the write actually uses, fail-closed (spec 4.5:
            // no writes into configDir or the agent-config zone).
            const ignore = this.plugin.ignoreService;
            if (ignore && (ignore.isIgnored(folder) || ignore.isProtected(folder))) {
                throw new Error(`Refused to write images into "${folder}": ${ignore.getDenialReason(folder)}`);
            }

            const downloadMap = new Map<string, string>();
            let imagesFailed = 0;
            let cappedByBudget = 0;
            // The budget is accounted against bytes pulled OFF THE WIRE (egress), NOT only
            // bytes written. A page full of non-image, oversized, or redirect-stuffed
            // responses must not force a silent multi-hundred-MB download (spec 4.5:
            // "kein stiller Massen-Download").
            let downloadedBytes = 0;

            for (const ref of refs) {
                if (context.abortSignal?.aborted) break;
                if (downloadedBytes >= TOTAL_IMAGE_BUDGET_BYTES) {
                    cappedByBudget++;
                    continue;
                }
                try {
                    const res = await this.downloadImage(ref, folder);
                    downloadedBytes += res.downloaded;
                    if (!res.saved) {
                        imagesFailed++;
                        continue;
                    }
                    downloadMap.set(ref, res.saved.path);
                } catch {
                    // A single image failing must not abort the clip (acceptance criterion 4).
                    imagesFailed++;
                }
            }
            if (cappedByBudget > 0) {
                callbacks.log(`clip_web_page: ${cappedByBudget} image(s) skipped after the ${TOTAL_IMAGE_BUDGET_BYTES / 1024 / 1024} MB total budget.`);
            }

            const rewritten = rewriteImageLinks(markdown, finalUrl, (u) => downloadMap.get(u) ?? null);

            const header = header_content && header_content.trim().length > 0
                ? header_content.trimEnd()
                : this.buildMinimalHeader(url, title, safeHtml, markdown);
            const note = `${header}\n\n## Originaltext\n\n${rewritten}\n`;

            await this.writeNote(target_path, note);

            const trusted = this.formatSuccess(
                `Clipped ${url}\n` +
                `Note: ${target_path}\n` +
                `Text: ${rewritten.length} chars\n` +
                `Images saved: ${downloadMap.size}, failed/skipped: ${imagesFailed + cappedByBudget}`,
            );
            // The page title is untrusted page content: return it in the untrusted
            // boundary wrapper (spec 4.5), never inside the trusted <success> envelope.
            const titleBlock = title
                ? this.formatUntrustedContent('web-clip', title, { field: 'title', url })
                : '';
            callbacks.pushToolResult(titleBlock ? `${trusted}\n${titleBlock}` : trusted);
        } catch (e) {
            callbacks.pushToolResult(this.formatError(e instanceof Error ? e : new Error(String(e))));
        }
    }

    /**
     * Download one image through the SSRF-guarded binary transport and write it
     * to the vault under a deterministic, URL-hashed filename. ALWAYS reports the
     * bytes pulled off the wire (`downloaded`) so the caller can budget egress
     * even for rejected downloads; `saved` is null for a blocked host, an HTTP
     * error, a non-image Content-Type, or an empty body.
     */
    private async downloadImage(
        absoluteUrl: string,
        folder: string,
    ): Promise<{ downloaded: number; saved: { path: string; size: number } | null }> {
        // Same guard chain as the page (spec 4.5): the image loader is the open
        // door if it skips this. No bytes fetched yet, so egress is 0.
        const guard = await guardUrl(absoluteUrl);
        if (!guard.ok) return { downloaded: 0, saved: null };

        const resp = await fetchWithRedirectGuard(absoluteUrl, {
            timeoutMs: IMAGE_TIMEOUT_MS,
            responseType: 'binary',
            maxBytes: PER_IMAGE_MAX_BYTES,
        });
        const downloaded = resp.bytes?.byteLength ?? 0;
        if (resp.status >= 400) return { downloaded, saved: null };

        // The Content-Type only decides whether this response claims to be an
        // image at all. It is the remote server's word, so it cannot decide the
        // format: a page can serve `image/png` and hand over ICNS or HEIF.
        const contentType = resp.headers['content-type'] ?? '';
        if (!imageExtFromContentType(contentType)) return { downloaded, saved: null };

        const bytes = resp.bytes;
        if (!bytes || bytes.byteLength === 0) return { downloaded, saved: null };

        // The bytes decide. Anything we cannot name is rejected rather than
        // written under an extension the server picked for us.
        const ext = imageExtFromBytes(bytes);
        if (!ext) return { downloaded, saved: null };

        // AUDIT L-1: SVG is XML that can carry <script>/on*/javascript:. Strip the
        // obvious vectors before the bytes land in the vault and get embedded.
        const outBytes = ext === '.svg'
            ? Buffer.from(sanitizeSvg(bytes.toString('utf8')), 'utf8')
            : bytes;

        const filename = imageFilenameFor(absoluteUrl, ext);
        const path = `${folder}/${filename}`;
        // writeBinaryToVault runs assertSafeVaultPath on the full path and
        // creates-or-modifies, so a re-clip lands on the same file (no dupes).
        const ab = outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength);
        await writeBinaryToVault(this.app.vault, path, ab, ext);
        return { downloaded, saved: { path, size: outBytes.byteLength } };
    }

    /** Create the note, making the parent folder first. Never overwrites (checked in execute). */
    private async writeNote(targetPath: string, content: string): Promise<void> {
        const parent = targetPath.includes('/') ? targetPath.split('/').slice(0, -1).join('/') : '';
        if (parent && this.app.vault.getAbstractFileByPath(parent) === null) {
            await this.app.vault.createFolder(parent).catch(() => { /* race: already exists */ });
        }
        const file = await this.app.vault.create(targetPath, content);
        try {
            const leaf = this.app.workspace.getLeaf(true);
            await leaf.openFile(file);
        } catch {
            // Opening the note is a nicety, not a requirement -- headless/mobile may not have a leaf.
        }
    }

    private resolveMaxImages(raw: number | undefined): number {
        const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_MAX_IMAGES;
        return Math.max(1, Math.min(MAX_MAX_IMAGES, n));
    }

    /**
     * Where downloaded images go. An explicit attachments_folder wins verbatim.
     * Otherwise: the Obsidian attachment folder (or 'Attachments') plus
     * /clips/<page-slug>/, which keeps the folder sorted and makes deleting a
     * clip note plus its images one operation.
     */
    private async resolveAttachmentsFolder(explicit: string | undefined, url: string): Promise<string> {
        if (typeof explicit === 'string' && explicit.trim().length > 0) {
            return explicit.trim().replace(/\/+$/, '');
        }
        return `${await this.readAttachmentBase()}/clips/${slugForUrl(url)}`;
    }

    /**
     * The Obsidian attachment base folder, read from `<configDir>/app.json` the
     * same way AttachmentHandler does (via vault.configDir, never a hardcoded
     * '.obsidian'). Relative-to-note ("./") and root ("/") settings are treated
     * as the default to keep the target predictable; the user can always pass an
     * explicit attachments_folder. Falls back to 'Attachments' on any error.
     */
    private async readAttachmentBase(): Promise<string> {
        try {
            const configDir = this.app.vault.configDir;
            const raw = await this.app.vault.adapter.read(`${configDir}/app.json`);
            const parsed = JSON.parse(raw) as { attachmentFolderPath?: unknown };
            const v = parsed.attachmentFolderPath;
            if (typeof v === 'string') {
                const trimmed = v.trim();
                if (trimmed && trimmed !== '/' && !trimmed.startsWith('.')) {
                    return trimmed.replace(/^\/+|\/+$/g, '');
                }
            }
        } catch {
            /* fall through to the default */
        }
        return 'Attachments';
    }

    /** Extract a page title from <title> or an og:title meta tag. */
    private extractTitle(html: string): string {
        const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        if (titleTag && titleTag[1].trim()) return this.decodeBasicEntities(titleTag[1].trim());
        const og = this.metaContent(html, 'og:title');
        return og ? this.decodeBasicEntities(og) : '';
    }

    /** Find a <meta name/property="key" content="..."> value regardless of attribute order. */
    private metaContent(html: string, key: string): string | null {
        const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
        for (const tag of metas) {
            const nameMatch = /\b(?:name|property)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
            const name = (nameMatch?.[2] ?? nameMatch?.[3] ?? nameMatch?.[4] ?? '').toLowerCase();
            if (name !== key.toLowerCase()) continue;
            const contentMatch = /\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
            const content = contentMatch?.[2] ?? contentMatch?.[3] ?? contentMatch?.[4] ?? null;
            if (content) return this.decodeBasicEntities(content.trim());
        }
        return null;
    }

    /**
     * Minimal frontmatter when the agent supplied no header_content (spec 4.1):
     * url, type: source, description from the meta description or the first
     * paragraph. Description/title are untrusted page text, flattened + defanged
     * and YAML-quoted.
     */
    private buildMinimalHeader(url: string, title: string, html: string, markdown: string): string {
        const desc = this.metaContent(html, 'description')
            ?? this.metaContent(html, 'og:description')
            ?? this.firstParagraph(markdown);
        const y = (v: string): string => `"${this.sanitizeForContext(v).slice(0, 300).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        const lines = ['---', `url: ${y(url)}`, 'type: source'];
        if (title) lines.push(`title: ${y(title)}`);
        if (desc) lines.push(`description: ${y(desc)}`);
        lines.push('---', '');
        return lines.join('\n');
    }

    private firstParagraph(markdown: string): string {
        for (const block of markdown.split(/\n{2,}/)) {
            const line = block.trim();
            if (!line) continue;
            if (line.startsWith('#') || line.startsWith('![') || line.startsWith('|')) continue;
            return line;
        }
        return '';
    }

    /** Neutralise boundary tags and collapse whitespace for text returned to the model or a YAML scalar. */
    private sanitizeForContext(text: string): string {
        return defangBoundaryTags(text ?? '').replace(/[\r\n]+/g, ' ').trim();
    }

    private decodeBasicEntities(s: string): string {
        return s
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&');
    }
}
