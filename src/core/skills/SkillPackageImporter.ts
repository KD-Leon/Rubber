/**
 * SkillPackageImporter -- extracts `.skill` or `.zip` skill packages.
 *
 * FEATURE-2202 / ADR-075 / EPIC-022. Security layers (all applied before any
 * file hits disk):
 *   1. Path-traversal check: no `..`, no absolute paths, no null bytes.
 *   2. Whitelist: only SKILL.md + files under scripts/ references/ assets/
 *      plus `*.skill.md` sub-roles at the root.
 *   3. Zip-bomb check: cumulative `_data.uncompressedSize` must stay below
 *      the configured limit (default 100 MB).
 *   4. Slug validation: the archive must contain a single top-level dir
 *      OR SKILL.md at the root; the dir name is used as the skill slug.
 */

import JSZip from 'jszip';
import type { DataAdapter } from 'obsidian';
import { normalizePath } from 'obsidian';
import { isDangerousVaultPath } from '../utils/safeVaultPath';

export interface SkillPackageImportInput {
    adapter: DataAdapter;
    /** Target skills dir (e.g. result of getSelfAuthoredSkillsDir). */
    targetSkillsDir: string;
    /** Raw zip bytes. */
    buffer: ArrayBuffer;
    /** Optional hint for the filename, used when the zip has no root dir. */
    fallbackSlug?: string;
    /** Overwrite the destination even if it already exists. Default: false. */
    overwrite?: boolean;
    /** Max cumulative uncompressed size in bytes (default 100 MB). */
    maxUncompressedBytes?: number;
}

export interface SkillPackageImportResult {
    /** Slug of the imported skill (folder name under targetSkillsDir). */
    slug: string;
    /** Absolute destination folder. */
    destFolder: string;
    /** Files written, relative to destFolder. */
    writtenFiles: string[];
    /** Entries skipped because they didn't match the whitelist. */
    skippedEntries: string[];
}

const DEFAULT_MAX_UNCOMPRESSED = 100 * 1024 * 1024;

/**
 * Whitelist is permissive on depth for the three sidecar directories because
 * real-world skills nest them (e.g. `assets/templates/master.potx`,
 * `assets/icons/...`). Zip-bomb protection still enforces the size cap and
 * path-traversal is rejected in Phase 0, so depth itself is not a risk.
 * `*.skill.md` only at the root to keep coordinator sub-roles discoverable.
 */
const WHITELIST_PATTERNS: RegExp[] = [
    /^SKILL\.md$/,
    /^scripts\/.+$/,
    /^references\/.+$/,
    /^assets\/.+$/,
    /^[^/]+\.skill\.md$/,
    // The licence travels with the skill. Dropping it on import would leave a
    // folder in the vault whose terms the user accepted at install time and
    // then has no copy of, which is the one file a redistributable package
    // must not lose. Root only, inert text, no execution path.
    /^LICEN[CS]E(\.[A-Za-z0-9.-]+)?$/,
];

export class SkillPackageImportError extends Error {
    constructor(message: string, public readonly code: SkillPackageImportErrorCode) {
        super(message);
        this.name = 'SkillPackageImportError';
    }
}

export type SkillPackageImportErrorCode =
    | 'PATH_TRAVERSAL'
    | 'ZIP_BOMB'
    | 'NO_SKILL_MD'
    | 'NO_SLUG'
    | 'DESTINATION_EXISTS'
    | 'READ_FAILED';

/**
 * Extract a `.skill`/`.zip` buffer into `targetSkillsDir/<slug>/`. Returns a
 * report of written files. Throws `SkillPackageImportError` on any security
 * or content failure (the caller is responsible for surfacing these to the UI).
 */
export async function importSkillPackage(
    input: SkillPackageImportInput,
): Promise<SkillPackageImportResult> {
    const limit = input.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED;

    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(input.buffer);
    } catch (e) {
        throw new SkillPackageImportError(
            `Could not read zip archive: ${messageOf(e)}`,
            'READ_FAILED',
        );
    }

    // Phase 0: reject the whole archive if ANY raw entry looks dangerous.
    // Runs before slug detection so absolute paths / traversal can't dictate
    // the import target via a crafted top-level name.
    for (const name of Object.keys(zip.files)) {
        if (isDangerousPath(name)) {
            throw new SkillPackageImportError(
                `Suspicious path in zip: "${name}"`,
                'PATH_TRAVERSAL',
            );
        }
    }

    // Determine slug + layout: either a single root folder in the zip, or
    // the fallbackSlug when SKILL.md sits at the root (root-based layout).
    const layout = detectLayout(zip, input.fallbackSlug);
    if (!layout) {
        throw new SkillPackageImportError(
            'Zip must contain either a single root folder or SKILL.md at the top with a filename hint.',
            'NO_SLUG',
        );
    }

    const { slug } = layout;
    const stripped = collectEntries(zip, layout);

    if (!stripped.hasSkillMd) {
        throw new SkillPackageImportError(
            'Archive has no SKILL.md.',
            'NO_SKILL_MD',
        );
    }

    // Pre-flight: path traversal + size check before we write anything.
    let totalSize = 0;
    const whitelisted: Array<{ path: string; file: JSZip.JSZipObject }> = [];
    const skipped: string[] = [];

    for (const [relPath, file] of stripped.entries) {
        if (isDangerousPath(relPath)) {
            throw new SkillPackageImportError(
                `Suspicious path in zip: "${relPath}"`,
                'PATH_TRAVERSAL',
            );
        }
        if (!matchesWhitelist(relPath)) {
            skipped.push(relPath);
            continue;
        }
        const size = getUncompressedSize(file);
        totalSize += size;
        if (totalSize > limit) {
            throw new SkillPackageImportError(
                `Zip cumulative uncompressed size exceeds ${limit} bytes.`,
                'ZIP_BOMB',
            );
        }
        whitelisted.push({ path: relPath, file });
    }

    const destFolder = normalizePath(`${input.targetSkillsDir}/${slug}`);
    const destExists = await input.adapter.exists(destFolder);
    // FIX-31-01-01: an installed skill is a SKILL.md, not a folder. The
    // versioning interceptor writes `.versions/{id}/snapshot.json` before the
    // first file of an install lands, so an install that is cancelled or fails
    // leaves an empty folder behind -- and the loader never sees such a folder
    // as a skill. Blocking on the folder turned that leftover into a wall: the
    // user deleted the skill, saw it disappear from the list, and every later
    // install answered "already exists" about a skill that was not there.
    const skillExists = destExists
        && await input.adapter.exists(normalizePath(`${destFolder}/SKILL.md`));
    if (skillExists && !input.overwrite) {
        throw new SkillPackageImportError(
            `Skill "${slug}" already exists.`,
            'DESTINATION_EXISTS',
        );
    }

    if (!destExists) await input.adapter.mkdir(destFolder);

    const writtenFiles: string[] = [];
    // L-3 (AUDIT 2026-08-13): the pre-flight size check above trusts the zip's
    // DECLARED uncompressed size (getUncompressedSize), which a crafted central
    // directory can under-report. Re-check the ACTUAL decompressed bytes here so
    // a package that lied about its size is rejected before it is written,
    // instead of inflating unbounded into the vault.
    let actualBytes = 0;
    for (const { path: relPath, file } of whitelisted) {
        const absPath = `${destFolder}/${relPath}`;
        const parentDir = absPath.slice(0, absPath.lastIndexOf('/'));
        if (parentDir !== destFolder && !(await input.adapter.exists(parentDir))) {
            await input.adapter.mkdir(parentDir);
        }
        const data = await file.async('arraybuffer');
        actualBytes += data.byteLength;
        if (actualBytes > limit) {
            throw new SkillPackageImportError(
                `Zip actual decompressed size exceeds ${limit} bytes.`,
                'ZIP_BOMB',
            );
        }
        await input.adapter.writeBinary(absPath, data);
        writtenFiles.push(relPath);
    }

    return {
        slug,
        destFolder,
        writtenFiles,
        skippedEntries: skipped,
    };
}

// -- Helpers ----------------------------------------------------------------

// FIX-29-40-01 (AUDIT-040 H-1): delegate to the shared utility so this
// importer and BackupTab.doImport cannot drift. Kept as a thin wrapper
// so the existing call sites do not need to change.
function isDangerousPath(p: string): boolean {
    return isDangerousVaultPath(p);
}

function matchesWhitelist(p: string): boolean {
    return WHITELIST_PATTERNS.some((re) => re.test(p));
}

/**
 * Returns the JSZip entry's uncompressed size if available, else falls back
 * to a conservative estimate (the compressed size). Public JSZip does not
 * expose `_data` officially, so we reach for it and fall back gracefully.
 */
function getUncompressedSize(file: JSZip.JSZipObject): number {
    const raw = (file as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data;
    return raw?.uncompressedSize ?? raw?.compressedSize ?? 0;
}

interface ZipLayout {
    slug: string;
    /** true = zip root is the skill folder; false = single top dir named {slug}. */
    rootBased: boolean;
}

function detectLayout(zip: JSZip, fallback?: string): ZipLayout | null {
    const topLevel = new Set<string>();
    let hasRootSkillMd = false;
    for (const name of Object.keys(zip.files)) {
        if (name.endsWith('/')) continue;
        const firstSlash = name.indexOf('/');
        if (firstSlash === -1) {
            if (name === 'SKILL.md') hasRootSkillMd = true;
            continue;
        }
        topLevel.add(name.slice(0, firstSlash));
    }

    // SKILL.md at the root wins: the whole archive is one skill, the
    // fallback slug (usually the uploaded filename) names it.
    if (hasRootSkillMd) {
        if (!fallback) return null;
        const cleaned = sanitizeSlug(fallback);
        return cleaned ? { slug: cleaned, rootBased: true } : null;
    }
    // Otherwise: single top-level dir becomes the slug.
    if (topLevel.size === 1) {
        const cleaned = sanitizeSlug([...topLevel][0]);
        return cleaned ? { slug: cleaned, rootBased: false } : null;
    }
    return null;
}

function sanitizeSlug(raw: string): string | null {
    const cleaned = raw.trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    return cleaned.length === 0 ? null : cleaned;
}

interface StrippedEntries {
    entries: Array<[string, JSZip.JSZipObject]>;
    hasSkillMd: boolean;
}

function collectEntries(zip: JSZip, layout: ZipLayout): StrippedEntries {
    const entries: Array<[string, JSZip.JSZipObject]> = [];
    let hasSkillMd = false;

    for (const [name, file] of Object.entries(zip.files)) {
        if (file.dir) continue;

        let relPath: string;
        if (layout.rootBased) {
            // Zip root IS the skill folder -- keep the full path.
            relPath = name;
        } else {
            const firstSlash = name.indexOf('/');
            if (firstSlash === -1) continue; // stray root file in dir-based zip
            const topDir = name.slice(0, firstSlash);
            if (sanitizeSlug(topDir) !== layout.slug) continue;
            relPath = name.slice(firstSlash + 1);
        }

        if (relPath === 'SKILL.md') hasSkillMd = true;
        entries.push([relPath, file]);
    }

    return { entries, hasSkillMd };
}

function messageOf(e: unknown): string {
    const raw = (e as { message?: unknown })?.message;
    if (typeof raw === 'string') return raw;
    if (typeof e === 'string') return e;
    return 'unknown error';
}
