/**
 * extractZip — generic ZIP-extraction helper backing the `extract_zip`
 * built-in tool. Used by skill-translator and any other workflow that
 * needs to unpack a ZIP from the vault without juggling jszip inside
 * the sandbox.
 *
 * Path-traversal and zip-bomb guards are mandatory; the helper refuses
 * archives that try to escape the target folder or exceed the cumulative
 * uncompressed-size limit.
 */

import JSZip from 'jszip';

export interface ExtractZipAdapter {
    exists(p: string): Promise<boolean>;
    mkdir(p: string): Promise<void>;
    writeBinary(p: string, data: ArrayBuffer): Promise<void>;
    readBinary(p: string): Promise<ArrayBuffer>;
}

export interface ExtractZipInput {
    adapter: ExtractZipAdapter;
    zipPath: string;
    targetFolder: string;
    /** Overwrite existing files (default false). */
    overwrite?: boolean;
    /**
     * If true and the archive has exactly one top-level folder, strip it
     * so the children are written directly under `targetFolder`.
     */
    stripRootFolder?: boolean;
    /** Cumulative uncompressed size cap. Default 100 MB. */
    maxUncompressedBytes?: number;
    /**
     * FEAT-44-02b: plan without writing. Every guard (traversal, zip-bomb,
     * target validation) and every existence check runs exactly as in a real
     * extraction, but no folder is created and no byte is written. The
     * result's writtenFiles/skippedEntries ARE the plan -- the batch approval
     * gate shows them, and a subsequent real run over unchanged inputs
     * produces the same sets.
     */
    dryRun?: boolean;
    /**
     * FEAT-44-02b: only extract entries whose ABSOLUTE vault path the filter
     * admits. Used to honour the approved subset of a batch gate
     * (context.approvedBatchPaths). Filtered-out entries are reported in
     * skippedEntries.
     */
    entryFilter?: (absPath: string) => boolean;
}

export interface ExtractZipResult {
    writtenFiles: string[];
    skippedEntries: string[];
    strippedRoot: string | null;
    totalUncompressedBytes: number;
    /** FEAT-44-02b: the normalised target folder (for absolute-path composition). */
    targetRoot: string;
    /**
     * FEAT-44-02b: subset of writtenFiles that already existed and are being
     * replaced (only non-empty with overwrite=true). The gate renders these
     * as changes instead of new files.
     */
    overwrittenFiles: string[];
}

export type ExtractZipErrorCode =
    | 'PATH_TRAVERSAL'
    | 'ZIP_BOMB'
    | 'READ_FAILED'
    | 'INVALID_TARGET';

export class ExtractZipError extends Error {
    constructor(message: string, public readonly code: ExtractZipErrorCode) {
        super(message);
        this.name = 'ExtractZipError';
    }
}

const DEFAULT_MAX_UNCOMPRESSED = 100 * 1024 * 1024;
// AUDIT 2026-07-14 M-3: cap the entry count so an archive with hundreds of
// thousands of tiny (or zero-declared) entries cannot exhaust memory before the
// per-byte guard trips.
const MAX_ENTRIES = 10_000;

export async function extractZip(input: ExtractZipInput): Promise<ExtractZipResult> {
    const limit = input.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED;
    const target = normaliseTarget(input.targetFolder);

    const zipBytes = await input.adapter.readBinary(input.zipPath);
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(zipBytes);
    } catch (e) {
        throw new ExtractZipError(
            `Could not read ZIP archive at ${input.zipPath}: ${messageOf(e)}`,
            'READ_FAILED',
        );
    }

    for (const name of Object.keys(zip.files)) {
        if (isDangerousPath(name)) {
            throw new ExtractZipError(
                `Suspicious path in archive: "${name}"`,
                'PATH_TRAVERSAL',
            );
        }
    }

    const strippedRoot = input.stripRootFolder ? detectSingleRoot(zip) : null;
    const entries = collectFileEntries(zip, strippedRoot);

    if (entries.length > MAX_ENTRIES) {
        throw new ExtractZipError(
            `Archive has ${entries.length} entries, exceeding the ${MAX_ENTRIES} limit.`,
            'ZIP_BOMB',
        );
    }

    // First line: the declared central-directory sizes. Cheap, but an attacker
    // controls them and can declare 0 (AUDIT 2026-07-14 M-3), so the real
    // decompressed bytes are counted again during extraction below.
    let total = 0;
    for (const entry of entries) {
        total += getUncompressedSize(entry.file);
        if (total > limit) {
            throw new ExtractZipError(
                `Archive cumulative uncompressed size exceeds ${limit} bytes.`,
                'ZIP_BOMB',
            );
        }
    }

    if (!input.dryRun && !(await input.adapter.exists(target))) {
        await input.adapter.mkdir(target);
    }

    const written: string[] = [];
    const skipped: string[] = [];
    const overwritten: string[] = [];
    // AUDIT 2026-07-14 M-3: count the bytes we actually decompress, independent
    // of the attacker-declared header sizes, and abort if the real total blows
    // the limit (a header can lie; a 4 GB entry can declare uncompressedSize=0).
    let realBytes = 0;

    for (const entry of entries) {
        const absPath = target ? `${target}/${entry.relPath}` : entry.relPath;

        // FEAT-44-02b: honour the approved subset of a batch gate. Checked
        // BEFORE the exists-check so a filtered entry is always "skipped",
        // never silently overwritten.
        if (input.entryFilter && !input.entryFilter(absPath)) {
            skipped.push(entry.relPath);
            continue;
        }

        const exists = await input.adapter.exists(absPath);
        if (exists && !input.overwrite) {
            skipped.push(entry.relPath);
            continue;
        }
        if (exists) {
            overwritten.push(entry.relPath);
        }

        if (input.dryRun) {
            written.push(entry.relPath);
            continue;
        }

        const parentDir = absPath.slice(0, absPath.lastIndexOf('/'));
        if (parentDir && parentDir !== target && !(await input.adapter.exists(parentDir))) {
            await ensureFolderChain(input.adapter, parentDir);
        }

        const data = await entry.file.async('arraybuffer');
        realBytes += data.byteLength;
        if (realBytes > limit) {
            throw new ExtractZipError(
                `Archive real uncompressed size exceeds ${limit} bytes during extraction.`,
                'ZIP_BOMB',
            );
        }
        await input.adapter.writeBinary(absPath, data);
        written.push(entry.relPath);
    }

    return {
        writtenFiles: written,
        skippedEntries: skipped,
        strippedRoot,
        totalUncompressedBytes: total,
        targetRoot: target,
        overwrittenFiles: overwritten,
    };
}

interface FileEntry {
    relPath: string;
    file: JSZip.JSZipObject;
}

function collectFileEntries(zip: JSZip, strippedRoot: string | null): FileEntry[] {
    const entries: FileEntry[] = [];
    const prefix = strippedRoot ? `${strippedRoot}/` : '';
    for (const [name, file] of Object.entries(zip.files)) {
        if (file.dir) continue;
        if (strippedRoot) {
            if (!name.startsWith(prefix)) continue;
            entries.push({ relPath: name.slice(prefix.length), file });
        } else {
            entries.push({ relPath: name, file });
        }
    }
    return entries;
}

function detectSingleRoot(zip: JSZip): string | null {
    const topLevel = new Set<string>();
    for (const name of Object.keys(zip.files)) {
        if (name.endsWith('/')) {
            const idx = name.indexOf('/');
            if (idx === name.length - 1) {
                topLevel.add(name.slice(0, idx));
            }
            continue;
        }
        const firstSlash = name.indexOf('/');
        if (firstSlash === -1) {
            // file at root → multiple top-level entries, cannot strip
            return null;
        }
        topLevel.add(name.slice(0, firstSlash));
    }
    if (topLevel.size !== 1) return null;
    return [...topLevel][0];
}

function normaliseTarget(raw: string): string {
    const trimmed = raw.trim().replace(/\\/g, '/');
    if (trimmed === '' || trimmed === '/') {
        throw new ExtractZipError(
            'targetFolder must point at a folder inside the vault.',
            'INVALID_TARGET',
        );
    }
    if (trimmed.startsWith('/')) {
        throw new ExtractZipError(
            `targetFolder must be a vault-relative path, got "${raw}".`,
            'INVALID_TARGET',
        );
    }
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
        throw new ExtractZipError(
            `targetFolder must be a vault-relative path, got "${raw}".`,
            'INVALID_TARGET',
        );
    }
    const segments = trimmed.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => s === '..')) {
        throw new ExtractZipError(
            `targetFolder must not contain parent-dir segments, got "${raw}".`,
            'INVALID_TARGET',
        );
    }
    // AUDIT 2026-07-26 H-1: reject "." exactly like ".." instead of dropping it.
    // The filter above only removed EMPTY segments, so "." and "./" survived as
    // a target of ".", every entry became "./<entry>", and Obsidian's
    // FileSystemAdapter.getFullPath (path.join) resolved that straight into the
    // vault root. An archive entry named ".obsidian/plugins/<id>/main.js" then
    // landed in the real config dir: code executed on the next reload, plus
    // ".vault-operator/data/settings.json" for the auto-approval flags. The
    // governance layer could not catch it either, because validatePaths only
    // ever saw the literal string "." (which is neither ignored nor protected)
    // and the per-entry paths are not tool inputs at all.
    //
    // Covers ".", "./", ".//", " . " (trimmed above) and ".\\" (backslashes are
    // normalised above). An implicit vault-root target is refused outright: if
    // the caller means the root it has to be a real folder.
    if (segments.some((s) => s === '.')) {
        throw new ExtractZipError(
            `targetFolder must not contain "." segments, got "${raw}".`,
            'INVALID_TARGET',
        );
    }
    if (segments.length === 0) {
        throw new ExtractZipError(
            'targetFolder must point at a folder inside the vault, not the vault root.',
            'INVALID_TARGET',
        );
    }
    return segments.join('/');
}

function isDangerousPath(p: string): boolean {
    if (!p) return true;
    if (p.includes('\0')) return true;
    if (p.startsWith('/')) return true;
    if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
    if (p.startsWith('\\\\')) return true;
    // BYP-4 (AUDIT 2026-07-14): normalise backslashes before splitting so a
    // `..\.obsidian\x` entry is broken into real segments. On Windows `\` is a
    // path separator; without this the `..` segment escapes detection.
    const segments = p.replace(/\\/g, '/').split('/');
    if (segments.some((s) => s === '..')) return true;
    return false;
}

async function ensureFolderChain(adapter: ExtractZipAdapter, folder: string): Promise<void> {
    const parts = folder.split('/').filter((p) => p.length > 0);
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!(await adapter.exists(current))) {
            await adapter.mkdir(current);
        }
    }
}

function getUncompressedSize(file: JSZip.JSZipObject): number {
    const raw = (file as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data;
    return raw?.uncompressedSize ?? raw?.compressedSize ?? 0;
}

function messageOf(e: unknown): string {
    const raw = (e as { message?: unknown })?.message;
    if (typeof raw === 'string') return raw;
    if (typeof e === 'string') return e;
    return 'unknown error';
}
