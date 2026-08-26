import type { DataAdapter } from 'obsidian';

/**
 * P0 (2026-07-05 data-loss). Atomic adapter write via a temp sibling + rename
 * so an interrupted write never leaves the primary file at 0 bytes.
 * adapter.write is a truncate-then-write (fs.writeFile, O_TRUNC) with no
 * temp+rename, so an interruption after the truncate zeroes the target. Uses
 * the Obsidian adapter (not raw fs) to stay mobile-compatible. On failure the
 * temp file is cleaned up and the existing target is left untouched.
 *
 * Shared by WriteFileTool (agent write_file) and the post-task review apply
 * path (FIX-01-07-04) -- every non-indexed (.obsidian/, agent folder) write
 * must go through here instead of a raw adapter.write.
 */
export async function atomicAdapterWrite(adapter: DataAdapter, safePath: string, content: string): Promise<void> {
    await atomicWriteWith(adapter, safePath, (tmpPath) => adapter.write(tmpPath, content));
}

/** Binary twin of atomicAdapterWrite; same temp sibling + rename contract. */
export async function atomicAdapterWriteBinary(adapter: DataAdapter, safePath: string, content: ArrayBuffer): Promise<void> {
    await atomicWriteWith(adapter, safePath, (tmpPath) => adapter.writeBinary(tmpPath, content));
}

let tmpCounter = 0;

/**
 * AUDIT 2026-07-07 ATW-1: the temp name must be unique per write. With a
 * fixed `<target>.vo-tmp`, two concurrent writers to the same target staged
 * over each other's temp file, and the losing writer's fallback then deleted
 * the freshly written target. The `.vo-tmp` suffix stays as the marker the
 * orphan sweep recognises.
 */
function uniqueTmpPath(safePath: string): string {
    tmpCounter = (tmpCounter + 1) & 0xffff;
    return `${safePath}.${Date.now().toString(36)}-${tmpCounter.toString(36)}.vo-tmp`;
}

/** Orphaned temp files younger than this are treated as in-flight writes of
 *  a concurrent writer and left alone. */
const ORPHAN_TMP_MIN_AGE_MS = 5 * 60_000;

async function atomicWriteWith(adapter: DataAdapter, safePath: string, stage: (tmpPath: string) => Promise<void>): Promise<void> {
    const tmpPath = uniqueTmpPath(safePath);
    try {
        await stage(tmpPath);
    } catch (err) {
        // Staged write failed before it touched the target: drop the temp
        // file (best-effort) and surface the error; the target is intact.
        try { await adapter.remove(tmpPath); } catch { /* temp may not exist */ }
        throw err;
    }
    try {
        await adapter.rename(tmpPath, safePath);
    } catch (err) {
        // ATW-1: only enter the remove-then-rename fallback while OUR temp
        // file still exists. If a concurrent writer consumed it, removing
        // the target now would end in silent deletion -- surface the error
        // and leave the (concurrently written) target untouched.
        if (!(await adapter.exists(tmpPath))) throw err;
        // Some platforms refuse rename onto an existing target. The full
        // content already lives in the temp file, so removing the stale
        // target first is safe. Accepted residual (audit 2026-07-07 ATW-2):
        // a hard crash inside this milliseconds-wide window leaves the temp
        // file behind and the target missing; the sweep below only removes
        // stale orphans, it does not restore them. The rescue path in the
        // inner catch covers every non-crash failure.
        if (await adapter.exists(safePath)) {
            await adapter.remove(safePath);
        }
        try {
            await adapter.rename(tmpPath, safePath);
        } catch {
            // ATW-2: at this point the target has been removed. A second
            // rename failure (iCloud lock, AV scanner) must never leave the
            // file deleted -- stage the content directly onto the target as
            // a last resort. Non-atomic, but this path only opens after two
            // failed renames, and the alternative is a missing file.
            await stage(safePath);
            try { await adapter.remove(tmpPath); } catch { /* best effort */ }
        }
    }
    await sweepStaleOrphanTmps(adapter, safePath);
}

/**
 * AUDIT 2026-07-07 ATW-2: unique temp names mean a crashed write leaves an
 * orphan no later write would ever overwrite. After a successful write,
 * sweep stale `<target>.<uid>.vo-tmp` siblings. Fresh temps stay untouched
 * (a concurrent writer may still be staging); everything is best-effort and
 * silent -- the sweep must never fail the write that triggered it.
 */
async function sweepStaleOrphanTmps(adapter: DataAdapter, safePath: string): Promise<void> {
    try {
        const slash = safePath.lastIndexOf('/');
        const folder = slash >= 0 ? safePath.slice(0, slash) : '/';
        const listing = await adapter.list(folder);
        const prefix = `${safePath}.`;
        const cutoff = Date.now() - ORPHAN_TMP_MIN_AGE_MS;
        for (const candidate of listing.files) {
            if (!candidate.startsWith(prefix) || !candidate.endsWith('.vo-tmp')) continue;
            try {
                const stat = await adapter.stat(candidate);
                if (stat && stat.mtime < cutoff) await adapter.remove(candidate);
            } catch { /* best effort */ }
        }
    } catch { /* listing unavailable: skip the sweep */ }
}
