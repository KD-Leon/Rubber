/**
 * SnapshotJob -- daily DB snapshots into `.bak/{YYYY-MM-DD}.db`.
 *
 * Why: the live `.bak` rotation only ever holds the most recent prior version.
 * One bad day of writes (silent corruption, sync conflict, agent bug) replaces
 * it before the user notices. A rolling window of date-stamped copies gives a
 * meaningful Undo on top of the per-write rotation.
 *
 * These ARE full copies, so the window is bounded twice: by age
 * (RETENTION_DAYS) and by a byte budget per target (SNAPSHOT_BUDGET_BYTES).
 * Age alone stopped bounding anything once a target grew -- seven daily copies
 * of a 580 MB knowledge.db are 4 GB on disk, which is how this was found.
 *
 * Scope: only for storage modes where the DB lives on the local filesystem
 * (`global` and `local`). For `obsidian-sync` we'd be duplicating files inside
 * a synced folder, which iCloud/Dropbox would then replicate -- the same DB
 * three times in three places. C2-Beschluss 2026-04-26 deferred sync-mode
 * snapshots to the persistence service in Klasse C.
 *
 * ADR-079, FEATURE-0314.
 */

import * as fs from '../security/safeFs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';

const SNAPSHOT_DIR = '.bak';
const RETENTION_DAYS = 7;
/**
 * Both spellings on purpose. `.db.gz` is what we write now; the plain `.db`
 * is what earlier versions wrote and stays readable, so the existing
 * snapshots keep working and simply age out through the budget instead of
 * needing a migration step.
 */
const SNAPSHOT_FILE_REGEX = /^(\d{4}-\d{2}-\d{2})\.db(\.gz)?$/;

/**
 * Byte budget for ONE target's snapshot directory. Per target, not global, so
 * a large knowledge.db cannot evict the much smaller memory and history
 * snapshots that would still fit comfortably.
 */
const SNAPSHOT_BUDGET_BYTES = 1024 * 1024 * 1024; // 1 GB

export interface SnapshotJobOptions {
    /** Override the per-target byte budget. Tests work in bytes, not gigabytes. */
    budgetBytes?: number;
}

/** What a cleanup pass actually did. Bytes included so callers can report it. */
export interface CleanupResult {
    removed: number;
    freedBytes: number;
}

export interface SnapshotTarget {
    /** Logical name used as snapshot file basename, e.g. 'memory', 'knowledge'. */
    name: string;
    /** Absolute path to the live DB file. */
    sourcePath: string;
}

export interface SnapshotResult {
    name: string;
    action: 'created' | 'skipped-existing' | 'skipped-no-source' | 'error';
    snapshotPath?: string;
    error?: string;
}

export class SnapshotJob {
    private readonly budgetBytes: number;

    constructor(options: SnapshotJobOptions = {}) {
        this.budgetBytes = options.budgetBytes ?? SNAPSHOT_BUDGET_BYTES;
    }

    /**
     * Run the daily snapshot pass for the given targets. Idempotent for the
     * day: a second call within the same date is a no-op per target.
     */
    async runDailySnapshot(targets: SnapshotTarget[]): Promise<SnapshotResult[]> {
        const today = formatDate(new Date());
        const results: SnapshotResult[] = [];

        for (const target of targets) {
            const result = await this.snapshotTarget(target, today);
            results.push(result);
        }

        return results;
    }

    /**
     * Drop snapshots that are too old, then those that do not fit the budget.
     *
     * Both passes are needed and the order matters: an expired snapshot goes
     * even when there is room to spare, and a young one goes when the directory
     * is over budget. The newest snapshot always survives -- a backup that
     * deletes itself for being large is worse than no backup at all.
     */
    async cleanupOldSnapshots(targets: SnapshotTarget[]): Promise<CleanupResult> {
        const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        let removed = 0;
        let freedBytes = 0;

        const seenDirs = new Set<string>();
        for (const target of targets) {
            const snapshotDir = path.join(path.dirname(target.sourcePath), SNAPSHOT_DIR, target.name);
            if (seenDirs.has(snapshotDir)) continue;
            seenDirs.add(snapshotDir);

            const exists = await fs.promises.access(snapshotDir).then(() => true).catch(() => false);
            if (!exists) continue;

            const entries = await fs.promises.readdir(snapshotDir).catch(() => []);

            // Pass 1: age.
            const survivors: { date: string; filePath: string; size: number }[] = [];
            for (const entry of entries) {
                const match = entry.match(SNAPSHOT_FILE_REGEX);
                if (!match) continue;

                const dateStr = match[1];
                const filePath = path.join(snapshotDir, entry);
                try {
                    const stats = await fs.promises.stat(filePath);
                    const ageMs = Date.now() - new Date(dateStr).getTime();
                    if (ageMs > RETENTION_DAYS * 24 * 60 * 60 * 1000 && stats.mtimeMs < cutoffMs) {
                        await fs.promises.unlink(filePath);
                        removed += 1;
                        freedBytes += stats.size;
                        continue;
                    }
                    survivors.push({ date: dateStr, filePath, size: stats.size });
                } catch (e) {
                    console.warn('[SnapshotJob] cleanup failed for', filePath, e);
                }
            }

            // Pass 2: budget, newest first, so what gets dropped is the oldest
            // history rather than the copy most likely to be restored.
            survivors.sort((a, b) => b.date.localeCompare(a.date));
            let used = 0;
            for (let i = 0; i < survivors.length; i += 1) {
                const snapshot = survivors[i];
                used += snapshot.size;
                // i === 0 is the newest: kept unconditionally.
                if (i === 0 || used <= this.budgetBytes) continue;
                try {
                    await fs.promises.unlink(snapshot.filePath);
                    removed += 1;
                    freedBytes += snapshot.size;
                    used -= snapshot.size;
                } catch (e) {
                    console.warn('[SnapshotJob] budget cleanup failed for', snapshot.filePath, e);
                }
            }
        }

        return { removed, freedBytes };
    }

    /**
     * Restore a target's live DB from the snapshot taken on `date`. The caller
     * is expected to have closed the live DB first (otherwise sql.js will
     * still have the old bytes in memory when it next saves).
     */
    async restoreFromSnapshot(target: SnapshotTarget, date: string): Promise<void> {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new Error(`Invalid date format, expected YYYY-MM-DD: ${date}`);
        }
        const snapshotPath = await this.findSnapshot(target, date);
        if (!snapshotPath) {
            throw new Error(`No snapshot found for ${target.name} on ${date}`);
        }

        // Materialise the restored bytes NEXT to the live DB before touching
        // it. A failure mid-decompression then costs nothing: the live DB is
        // still in place and only a stray .restore-tmp is left behind.
        const restoreTmp = target.sourcePath + '.restore-tmp';
        const source = fs.createReadStream(snapshotPath);
        if (snapshotPath.endsWith('.gz')) {
            await pipeline(source, zlib.createGunzip(), fs.createWriteStream(restoreTmp));
        } else {
            await pipeline(source, fs.createWriteStream(restoreTmp));
        }

        // Move the current live DB out of the way before overwriting; this makes
        // an accidental restore reversible by inspecting the .pre-restore file.
        const preRestorePath = target.sourcePath + '.pre-restore';
        try {
            await fs.promises.rename(target.sourcePath, preRestorePath);
        } catch {
            // No live DB -- restore is starting from scratch.
        }
        await fs.promises.rename(restoreTmp, target.sourcePath);
    }

    /** List available snapshots per target (for the agent tool / UI). */
    async listSnapshots(target: SnapshotTarget): Promise<string[]> {
        const dir = this.snapshotDir(target);
        const exists = await fs.promises.access(dir).then(() => true).catch(() => false);
        if (!exists) return [];

        const entries = await fs.promises.readdir(dir);
        return entries
            .map((e) => e.match(SNAPSHOT_FILE_REGEX))
            .filter((m): m is RegExpMatchArray => m !== null)
            .map((m) => m[1])
            .sort()
            .reverse();
    }

    private async snapshotTarget(target: SnapshotTarget, today: string): Promise<SnapshotResult> {
        const sourceExists = await fs.promises
            .access(target.sourcePath)
            .then(() => true)
            .catch(() => false);
        if (!sourceExists) {
            return { name: target.name, action: 'skipped-no-source' };
        }

        // Look for either spelling: a snapshot written by an earlier version
        // earlier the same day still means "today is covered", otherwise the
        // first restart after an update stores the same day twice.
        const existing = await this.findSnapshot(target, today);
        if (existing) {
            return { name: target.name, action: 'skipped-existing', snapshotPath: existing };
        }

        const snapshotPath = this.snapshotPath(target, today);
        try {
            await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
            // Write to a temp name first so an interrupted run cannot leave a
            // truncated file that later looks like a valid snapshot.
            const tmpPath = snapshotPath + '.tmp';
            await pipeline(
                fs.createReadStream(target.sourcePath),
                zlib.createGzip(),
                fs.createWriteStream(tmpPath),
            );
            await fs.promises.rename(tmpPath, snapshotPath);
            return { name: target.name, action: 'created', snapshotPath };
        } catch (e) {
            return {
                name: target.name,
                action: 'error',
                error: (e as Error).message,
            };
        }
    }

    /**
     * The path of an existing snapshot for `date`, compressed or legacy,
     * or null when that day has none.
     */
    private async findSnapshot(target: SnapshotTarget, date: string): Promise<string | null> {
        const dir = this.snapshotDir(target);
        for (const candidate of [`${date}.db.gz`, `${date}.db`]) {
            const full = path.join(dir, candidate);
            const exists = await fs.promises.access(full).then(() => true).catch(() => false);
            if (exists) return full;
        }
        return null;
    }

    private snapshotDir(target: SnapshotTarget): string {
        return path.join(path.dirname(target.sourcePath), SNAPSHOT_DIR, target.name);
    }

    private snapshotPath(target: SnapshotTarget, date: string): string {
        return path.join(this.snapshotDir(target), `${date}.db.gz`);
    }
}

function formatDate(d: Date): string {
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
