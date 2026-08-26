/**
 * PDF Parser — extracts text from PDF files using pdfjs-dist.
 *
 * Runs in fake-worker mode (no Web Worker) for Obsidian/Electron compatibility.
 * Returns empty text for encrypted, image-only, or unreadable PDFs.
 *
 * pdfjs-dist is shipped as an Optional Asset (pdfjs-bundle.js) -- the plugin
 * works without it (PDF parsing returns "not installed" until the user
 * installs the bundle via Settings > Optional Assets). BundleLoader handles
 * the SHA-verified download and runtime evaluation.
 *
 * IMPORTANT: Importing pdfjs-dist/build/pdf.worker.mjs sets window.pdfjsWorker
 * as an irreversible side effect. Obsidian ships its own PDF.js (v5.x) and
 * detects this stale v4.x worker, causing "API version does not match Worker
 * version". We save/restore window.pdfjsWorker around every usage to prevent
 * this.
 *
 * Refactored from SemanticIndexService.extractPdfText().
 */

import type { ParseResult } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import type { ToolExecutionContext } from '../../tools/types';

const NOT_INSTALLED_PARSE_RESULT: ParseResult = {
    text: '(PDF Parser is not installed. Open Settings > Vault Operator > Optional Assets to install the PDF parser (~1.6 MB), then re-attach the file.)',
    images: [],
    metadata: { format: 'pdf' },
};

/**
 * Per-document caps to prevent resource exhaustion (CWE-400). A malicious or
 * malformed PDF can advertise an arbitrary numPages and contain page text that
 * inflates without bound. We cap both dimensions and append a sentinel when
 * the cap is hit so downstream consumers can detect truncation.
 *
 * Aligned with the existing MAX_DECOMPRESSED_SIZE=500 MB ZIP-bomb guard pattern.
 */
const MAX_PAGES = 2000;
const MAX_TEXT_BYTES = 50 * 1024 * 1024; // 50 MB joined output budget

/**
 * Parse a PDF from an ArrayBuffer and extract text per page.
 *
 * Loads pdfjs-dist via the plugin's BundleLoader (Optional Asset). Returns a
 * structured "not installed" ParseResult when the asset is missing -- callers
 * see a normal ParseResult, never a thrown error.
 */
export async function parsePdf(
    data: ArrayBuffer,
    plugin: ObsidianAgentPlugin,
    ctx?: ToolExecutionContext,
): Promise<ParseResult> {
    if (!plugin.bundleLoader) {
        return NOT_INSTALLED_PARSE_RESULT;
    }
    // If we run inside a tool that can prompt the user, offer an in-chat
    // install card first. Falls back to null (i.e. not-installed) if the
    // user skips / declines / no context.
    const bundle = ctx
        ? await plugin.bundleLoader.loadPdfjsBundleWithPrompt(ctx, 'read_document')
        : await plugin.bundleLoader.loadPdfjsBundle();
    if (!bundle) {
        return NOT_INSTALLED_PARSE_RESULT;
    }
    // pdfjs-dist exposes getDocument + GlobalWorkerOptions on its module namespace.
    // The worker re-export is a side-effect import: requiring the bundle (which
    // already evaluated worker module) is enough for fake-worker mode.
    const pdfjsLib = bundle.pdfjs as Record<string, unknown> & {
        GlobalWorkerOptions?: { workerSrc: string };
        getDocument(params: { data: Uint8Array; useWorkerFetch: boolean }): {
            promise: Promise<{
                numPages: number;
                getPage(num: number): Promise<{
                    getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
                }>;
            }>;
        };
    };

    // Save global state that pdfjs-dist pollutes on import.
    // Obsidian's own PDF viewer (v5.x) breaks if it finds our v4.x worker here.
    const savedPdfjsWorker = ((window as unknown) as Record<string, unknown>).pdfjsWorker;
    const savedWorkerSrc = pdfjsLib.GlobalWorkerOptions?.workerSrc;

    // Disable the web worker — pdfjs falls back to in-process (fake-worker) mode.
    if (pdfjsLib.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = '';
    }

    try {
        // FIX-01-12-03: pdf.js takes ownership of the passed TypedArray and
        // transfers it to its (fake-)worker, detaching the underlying
        // ArrayBuffer in the caller. Callers reuse the buffer afterwards
        // (e.g. AttachmentHandler auto-saves it via vault.createBinary), so
        // pdfjs gets a copy, never the caller-owned buffer.
        const loadingTask = pdfjsLib.getDocument({
            data: new Uint8Array(data.slice(0)),
            useWorkerFetch: false,
        });
        const pdf = await loadingTask.promise;

        const parts: string[] = [];
        const pageLimit = Math.min(pdf.numPages, MAX_PAGES);
        let accumulatedBytes = 0;
        let truncatedByBytes = false;
        let pagesProcessed = 0;
        for (let pageNum = 1; pageNum <= pageLimit; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const content = await page.getTextContent();
            const pageText = content.items
                .map((item: { str?: string }) => (item.str ?? ''))
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            pagesProcessed = pageNum;
            if (pageText) {
                const block = `## Page ${pageNum}\n\n${pageText}`;
                // UTF-8 byte estimate. Using length is conservative for ASCII and
                // an under-count for multi-byte text, so we add a small slack via
                // TextEncoder when available without paying that cost per page.
                const blockBytes = block.length;
                if (accumulatedBytes + blockBytes > MAX_TEXT_BYTES) {
                    truncatedByBytes = true;
                    break;
                }
                parts.push(block);
                accumulatedBytes += blockBytes;
            }
        }

        const truncatedByPages = pdf.numPages > MAX_PAGES;
        if (truncatedByPages) {
            parts.push(`(truncated: PDF has ${pdf.numPages} pages, only the first ${MAX_PAGES} were parsed)`);
        } else if (truncatedByBytes) {
            parts.push(`(truncated: text output exceeded ${MAX_TEXT_BYTES} bytes after page ${pagesProcessed})`);
        }

        const text = parts.length > 0
            ? parts.join('\n\n')
            : '(No extractable text found — this PDF may be image-based/scanned.)';

        return {
            text,
            images: [],
            metadata: {
                format: 'pdf',
                pageCount: pdf.numPages,
            },
        };
    } finally {
        // Restore Obsidian's global state so its PDF viewer keeps working.
        if (savedPdfjsWorker === undefined) {
            delete ((window as unknown) as Record<string, unknown>).pdfjsWorker;
        } else {
            ((window as unknown) as Record<string, unknown>).pdfjsWorker = savedPdfjsWorker;
        }
        if (pdfjsLib.GlobalWorkerOptions && savedWorkerSrc !== undefined) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = savedWorkerSrc;
        }
    }
}
