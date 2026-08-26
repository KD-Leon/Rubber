/**
 * Shared helpers for OOXML parsers (PPTX, XLSX, DOCX).
 *
 * All OOXML formats are ZIP archives with XML content.
 * This module provides ZIP security checks and XML parsing utilities.
 */

import JSZip from 'jszip';
import { MAX_DECOMPRESSED_SIZE } from '../types';

/**
 * Per-entry advertised uncompressed size cap (AUDIT-034 M-7).
 *
 * Even with a 500 MB cumulative cap, a single ZIP entry can declare
 * hundreds of MB of decompressed content. Decompressing it via
 * file.async('text') materialises the whole buffer in V8 memory before
 * any size-tracker check can fire. We refuse outright at 50 MB per
 * entry, which is well above any legitimate OOXML XML part.
 */
export const MAX_SINGLE_ENTRY_DECOMPRESSED_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * Read JSZip's advertised uncompressed size for an entry.
 *
 * Mirrors the helper in src/core/utils/extractZip.ts (getUncompressedSize)
 * so the OOXML pre-decompression bomb check uses the same metadata the
 * extract-zip tool already trusts.
 */
function getUncompressedSize(file: JSZip.JSZipObject): number {
    const raw = (file as unknown as {
        _data?: { uncompressedSize?: number; compressedSize?: number };
    })._data;
    return raw?.uncompressedSize ?? raw?.compressedSize ?? 0;
}

/**
 * Open a ZIP archive with security checks:
 * - Path traversal: rejects entries with `../` or absolute paths
 * - ZIP bomb (pre-decompression): rejects when JSZip's advertised
 *   uncompressed size for a single entry exceeds
 *   MAX_SINGLE_ENTRY_DECOMPRESSED_SIZE, or when the cumulative
 *   advertised size of all entries exceeds MAX_DECOMPRESSED_SIZE.
 *   This catches a high-compression-ratio bomb BEFORE
 *   file.async('text'/'arraybuffer') ever runs.
 * - ZIP bomb (post-decompression, in getXmlDoc): cumulative actual
 *   decompressed bytes are still tracked as a defence in depth.
 */
export async function openZipSafe(data: ArrayBuffer): Promise<JSZip> {
    const zip = await JSZip.loadAsync(data);

    let cumulative = 0;
    for (const [name, file] of Object.entries(zip.files)) {
        // Path traversal check
        if (name.includes('..') || name.startsWith('/')) {
            throw new Error(`Suspicious path in ZIP: "${name}"`);
        }

        if (file.dir) continue;

        // Pre-decompression size check (AUDIT-034 M-7).
        // Uses JSZip's advertised uncompressedSize so we never have to
        // decompress a malicious entry just to find out it is too big.
        const advertised = getUncompressedSize(file);
        if (advertised > MAX_SINGLE_ENTRY_DECOMPRESSED_SIZE) {
            throw new Error(
                `ZIP entry "${name}" advertised uncompressed size ` +
                    `${advertised} exceeds per-entry safety limit ` +
                    `${MAX_SINGLE_ENTRY_DECOMPRESSED_SIZE}`,
            );
        }
        cumulative += advertised;
        if (cumulative > MAX_DECOMPRESSED_SIZE) {
            throw new Error(
                'ZIP advertised cumulative uncompressed size exceeds safety limit',
            );
        }
    }

    return zip;
}

/**
 * Read an XML file from the ZIP and parse it to a Document.
 * Returns null if the file doesn't exist in the archive.
 * Tracks cumulative decompressed size and throws on ZIP bomb.
 */
export async function getXmlDoc(
    zip: JSZip,
    path: string,
    sizeTracker: { total: number },
): Promise<Document | null> {
    const file = zip.file(path);
    if (!file) return null;

    const text = await file.async('text');
    sizeTracker.total += text.length;
    if (sizeTracker.total > MAX_DECOMPRESSED_SIZE) {
        throw new Error('ZIP decompressed size exceeds safety limit');
    }

    const parser = new DOMParser();
    return parser.parseFromString(text, 'text/xml');
}

/**
 * Get text content of all matching XML elements, ignoring namespace prefixes.
 * Uses local name matching since OOXML namespaces vary between generators.
 */
export function getElementsText(parent: Element, localName: string): string[] {
    const results: string[] = [];
    const elements = parent.getElementsByTagName('*');
    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (el.localName === localName) {
            const text = el.textContent?.trim();
            if (text) results.push(text);
        }
    }
    return results;
}

/**
 * Find all elements matching a local name (namespace-agnostic).
 */
export function getElementsByLocalName(parent: Element | Document, localName: string): Element[] {
    const results: Element[] = [];
    const elements = parent.getElementsByTagName('*');
    for (let i = 0; i < elements.length; i++) {
        if (elements[i].localName === localName) {
            results.push(elements[i]);
        }
    }
    return results;
}
