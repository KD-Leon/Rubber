/**
 * ReadDocumentTool — parse an Office/data document from the vault or chat attachment.
 *
 * Supports: PPTX, XLSX, DOCX, PDF, JSON, XML, CSV.
 * Returns structured text extracted from the document.
 * Read-only: no approval needed.
 *
 * For large documents, supports page-range reading via start_page/end_page
 * to avoid context overflow. Pages are identified by `## Page N` headings
 * in the extracted text (PDF format).
 */

import { TFile } from 'obsidian';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { parseDocument } from '../../document-parsers/parseDocument';
import { SUPPORTED_DOCUMENT_EXTENSIONS, BINARY_DOCUMENT_EXTENSIONS, MAX_DOCUMENT_FILE_SIZE } from '../../document-parsers/types';

interface ReadDocumentInput {
    path?: string;
    attachment_index?: number;
    start_page?: number;
    end_page?: number;
}

/**
 * FIX-PERF-46: extensions read_document tolerates via plain-text fallback
 * instead of erroring. LLMs routinely route .md transcripts here despite
 * the tool description; a hard error costs a full agent turn. Mirrors the
 * read_file cap so a fallback read cannot blow up the context.
 */
const PLAINTEXT_FALLBACK_EXTENSIONS = new Set([
    'md', 'markdown', 'txt', 'canvas', 'log',
    'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'sh', 'sql',
    'html', 'css', 'yaml', 'yml', 'toml', 'ini',
]);
const PLAINTEXT_FALLBACK_MAX_CHARS = 50_000;

export class ReadDocumentTool extends BaseTool<'read_document'> {
    readonly name = 'read_document' as const;
    readonly isWriteOperation = false;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'read_document',
            description:
                'Parse and extract text from an Office or data document. ' +
                'Supports vault files (path) and chat attachments (attachment_index, 0-based). ' +
                'For large documents, use start_page/end_page to read specific page ranges ' +
                '(1-based, inclusive). Pages are identified by "## Page N" headings in the text. ' +
                'Supports PPTX, XLSX, DOCX, PDF, JSON, XML, CSV. ' +
                'Returns structured text (Markdown-formatted). ' +
                'Use this instead of read_file for binary document formats.',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Path to the document relative to vault root (e.g., "Reports/Q3-results.pptx"). ' +
                            'Use this for vault files. Either path or attachment_index is required.',
                    },
                    attachment_index: {
                        type: 'integer',
                        description:
                            'Index of the chat attachment (0-based). Use this when the document was added ' +
                            'via drag & drop or file picker, not from the vault.',
                    },
                    start_page: {
                        type: 'integer',
                        description:
                            'First page to return (1-based, inclusive). Only works with documents that have ' +
                            '"## Page N" headings (typically PDFs). Omit to start from the beginning.',
                    },
                    end_page: {
                        type: 'integer',
                        description:
                            'Last page to return (1-based, inclusive). Omit to read to the end.',
                    },
                },
                required: [],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { path, attachment_index, start_page, end_page } = input as unknown as ReadDocumentInput;
        const { callbacks } = context;

        try {
            let fullText: string;
            let sourceName: string;
            let format: string;
            let totalPageCount: number | undefined;

            if (path) {
                // Parse from vault file
                const result = await this.parseFromVault(path, context);
                fullText = result.text;
                sourceName = path;
                format = result.format;
                totalPageCount = result.pageCount;
            } else if (attachment_index !== undefined && attachment_index >= 0) {
                // FEAT-55-02 (ADR-170): run-scoped attachments from the context,
                // not a shared instance field -- two parallel chats never share
                // or wipe each other's attachments.
                const attachmentTexts = context.getAttachmentTexts?.() ?? [];
                // Read from stored attachment text
                if (attachment_index >= attachmentTexts.length) {
                    // BUG-029 (Issue #312): Chat-Attachments leben nur einen Turn.
                    // Bei attachmentTexts.length === 0 ist die Datei garantiert
                    // weg -- der Agent darf NICHT auf gleichnamige Vault-Files
                    // ausweichen oder den Inhalt aus dem Kontext rekonstruieren.
                    // Wir geben eine actionable Meldung analog zu IngestDocumentTool.
                    if (attachmentTexts.length === 0) {
                        throw new Error(
                            'No chat attachments available on this turn. The chat-attachment lifetime is one turn -- ' +
                            'the document the user uploaded earlier is no longer accessible via attachment_index. ' +
                            'STOP. Do NOT fall back to similarly-named vault files (e.g. an existing mirror) or ' +
                            'reconstruct content from the <attached_document> block in your context as if it were a verified read. ' +
                            'Action: ask the user to save the file to the vault (e.g. drag into Attachements/), then re-run ' +
                            'with path="Attachements/<filename>". If you only need a single page-range and the original ' +
                            '<attached_document> text is still in your context, extract from there explicitly and tell the ' +
                            'user you are doing so -- never silently substitute another source.'
                        );
                    }
                    throw new Error(
                        `Attachment index ${attachment_index} out of range. ` +
                        `${attachmentTexts.length} attachment(s) available (use index 0..${attachmentTexts.length - 1}).`
                    );
                }
                fullText = attachmentTexts[attachment_index];
                sourceName = `attachment[${attachment_index}]`;
                format = 'attachment';
            } else {
                throw new Error('Either path or attachment_index is required.');
            }

            // Apply page range if requested
            let outputText = fullText;
            let pagesReturned: string | undefined;

            if (start_page !== undefined || end_page !== undefined) {
                const pageResult = this.extractPageRange(fullText, start_page, end_page);
                outputText = pageResult.text;
                pagesReturned = pageResult.rangeLabel;
                if (totalPageCount === undefined) {
                    totalPageCount = pageResult.totalPages;
                }
            }

            // Format output. AUDIT-2026-07-07 M-1: parsed document text and
            // plain-text fallback reads are externally-sourced data -- wrap
            // them in the untrusted-content boundary (same rationale as
            // read_file, AUDIT-034 L-15). The trust-domain label lives in
            // the wrapper's `source` attribute, so the origin file moves to
            // `path`.
            const meta: Record<string, string> = { path: sourceName, format };
            if (totalPageCount !== undefined) {
                meta['total_pages'] = String(totalPageCount);
            }
            if (pagesReturned) {
                meta['pages_returned'] = pagesReturned;
            }

            callbacks.pushToolResult(this.formatUntrustedContent(
                path ? 'vault' : 'attachment',
                outputText,
                meta,
            ));
            callbacks.log(`Parsed document: ${sourceName} (${format}, ${outputText.length} chars${pagesReturned ? `, pages ${pagesReturned}` : ''})`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('read_document', error);
        }
    }

    private async parseFromVault(path: string, ctx?: ToolExecutionContext): Promise<{ text: string; format: string; pageCount?: number }> {
        const ext = path.split('.').pop()?.toLowerCase() ?? '';
        if (!SUPPORTED_DOCUMENT_EXTENSIONS.has(ext)) {
            // FIX-PERF-46: tolerate plain-text files instead of burning an
            // agent turn on an error round-trip.
            if (PLAINTEXT_FALLBACK_EXTENSIONS.has(ext)) {
                return this.readPlainTextFallback(path, ext);
            }
            throw new Error(
                `Unsupported format: .${ext}. Supported: ${[...SUPPORTED_DOCUMENT_EXTENSIONS].join(', ')}. ` +
                'For plain text files (.md, .txt, .ts, etc.), use read_file instead.'
            );
        }

        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFile)) {
            throw new Error(`File not found: ${path}`);
        }

        if (file.stat.size > MAX_DOCUMENT_FILE_SIZE) {
            throw new Error(
                `File too large: ${(file.stat.size / 1024 / 1024).toFixed(1)} MB ` +
                `(limit: ${MAX_DOCUMENT_FILE_SIZE / 1024 / 1024} MB)`
            );
        }

        let data: ArrayBuffer;
        if (BINARY_DOCUMENT_EXTENSIONS.has(ext)) {
            data = await this.app.vault.readBinary(file);
        } else {
            const text = await this.app.vault.read(file);
            data = new TextEncoder().encode(text).buffer;
        }

        const result = await parseDocument(data, ext, this.plugin, ctx);
        return { text: result.text, format: ext, pageCount: result.metadata.pageCount };
    }

    /**
     * FIX-PERF-46: plain-text fallback for misrouted read_document calls.
     * Mirrors the read_file 50k cap and steers the model back to read_file
     * (which supports offset-based chunk reading) for the rest.
     */
    private async readPlainTextFallback(path: string, ext: string): Promise<{ text: string; format: string }> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFile)) {
            throw new Error(`File not found: ${path}`);
        }
        const full = await this.app.vault.read(file);
        if (full.length > PLAINTEXT_FALLBACK_MAX_CHARS) {
            const text = full.slice(0, PLAINTEXT_FALLBACK_MAX_CHARS);
            return {
                text: text +
                    `\n[Truncated: showing chars 0-${PLAINTEXT_FALLBACK_MAX_CHARS} of ${full.length}. ` +
                    `Plain-text file -- continue with read_file offset=${PLAINTEXT_FALLBACK_MAX_CHARS}.]`,
                format: `${ext} (plain text -- prefer read_file)`,
            };
        }
        return {
            text: full + '\n[Note: plain-text file -- prefer read_file for this format.]',
            format: `${ext} (plain text -- prefer read_file)`,
        };
    }

    /**
     * Extract a page range from text that contains `## Page N` headings.
     * Returns the text for the requested range and metadata about what was returned.
     */
    private extractPageRange(
        text: string,
        startPage?: number,
        endPage?: number,
    ): { text: string; rangeLabel: string; totalPages: number } {
        // Split text into pages by ## Page N headings
        const pagePattern = /^## Page (\d+)$/gm;
        const pages: { num: number; startIdx: number }[] = [];
        let match: RegExpExecArray | null;
        while ((match = pagePattern.exec(text)) !== null) {
            const num = parseInt(match[1], 10);
            if (num > 0 && num <= 100_000) { // sanity bound
                pages.push({ num, startIdx: match.index });
            }
        }

        if (pages.length === 0) {
            // No page structure -- return full text with a note
            return {
                text: text,
                rangeLabel: 'all (no page structure detected)',
                totalPages: 0,
            };
        }

        const totalPages = pages[pages.length - 1].num;
        const effectiveStart = startPage ?? 1;
        const effectiveEnd = endPage ?? totalPages;

        // Find the indices of requested pages
        const startIdx = pages.findIndex(p => p.num >= effectiveStart);
        if (startIdx === -1) {
            return {
                text: `(No pages found in range ${effectiveStart}-${effectiveEnd}. Document has ${totalPages} pages.)`,
                rangeLabel: `${effectiveStart}-${effectiveEnd}`,
                totalPages,
            };
        }

        // Find where to end
        const endIdx = pages.findIndex(p => p.num > effectiveEnd);
        const sliceStart = pages[startIdx].startIdx;
        const sliceEnd = endIdx !== -1 ? pages[endIdx].startIdx : text.length;

        const extractedText = text.slice(sliceStart, sliceEnd).trim();

        return {
            text: extractedText,
            rangeLabel: `${effectiveStart}-${effectiveEnd}`,
            totalPages,
        };
    }
}
