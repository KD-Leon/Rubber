/**
 * migrateAgentLayout -- consolidate plugin storage into {vault}/.vault-operator/.
 *
 * Background (FEAT-29-01, ADR-119 third iteration 2026-05-20):
 *
 * Plugin storage drifted across four roots over multiple naming waves:
 *   - {vault}/.obsidian-agent/                Legacy (telemetry remains)
 *   - {vault}/.obsilo-vault/                  vault-local agent data
 *   - {vault}/.vault-operator/                vault-local optional asset cache
 *   - {vault-parent}/obsilo-shared/           cross-vault shared data + cache
 *
 * This service consolidates all four into:
 *   - {vault}/.vault-operator/data/           persistent user state
 *   - {vault}/.vault-operator/cache/          regenerable artefacts
 *
 * Cross-vault sharing is provided by a separate backup-export tool
 * (FEAT-29-12 Welle 4), not by a vault-parent root anymore.
 *
 * Phase order (idempotent, resumable via settings._layoutMigrationStatus):
 *   1. backup            full snapshot outside iCloud-synced vault tree
 *   2. data-vault        .obsilo-vault/* (data files)     -> .vault-operator/data/*
 *   3. cache-vault       .vault-operator/{assets,runtime} -> .vault-operator/cache/*
 *   4. data-shared       obsilo-shared/{history,memory,...} -> .vault-operator/data/*
 *   5. cache-shared      obsilo-shared/{checkpoints,...}  -> .vault-operator/cache/*
 *   6. skills-resolve    drift-merge skills/ from two sources (mtime precedence)
 *   7. cleanup           remove emptied legacy roots
 *   8. settings          flip agentFolderPath default, remove chatHistoryFolder
 *  10. report            write migration-report.json
 *
 * Phase 9 (chatHistoryFolder removal notice) lives in the trigger (plugin.onload)
 * because it requires a UI-modal that the pure migration service does not own.
 * The service returns a flag indicating whether the notice should fire.
 *
 * Strategy per file: fs.rename (atomic, same partition) with copy+delete
 * fallback on EXDEV / EPERM / EBUSY. Pattern adapted from
 * migratePluginDataDirs (FIX-28-00-03).
 *
 * Desktop-only: rawFs require would crash on Mobile. Caller must gate with
 * Platform.isDesktop (plugin currently isDesktopOnly anyway).
 */

/* eslint-disable @typescript-eslint/no-require-imports -- rawFs needed for
 * destinations outside the vault and for atomic renames; same pattern as
 * migratePluginDataDirs and GitCheckpointService.
 */
const rawFs = require('fs') as typeof import('fs');
import * as pathModule from 'path';
import * as osModule from 'os';

// ─────────────────────────────────────────────────────────────────────────
// ADR-162 / FIX-30-07-04: Fresh-install fast-path probe
// ─────────────────────────────────────────────────────────────────────────

/**
 * Single source of truth for the historical storage-root names that the
 * FEAT-29-01 consolidation replaces (Review-Finding: was string-duplicated
 * across the migration phases, GlobalFileService and the probe below).
 * '.vault-operator' is intentionally NOT in these lists: it is the
 * consolidated target root, not a legacy source.
 */
export const LEGACY_VAULT_LOCAL_ROOTS = ['.obsidian-agent', '.obsilo-vault', 'obsilo-vault'] as const;
export const LEGACY_VAULT_PARENT_ROOTS = ['obsilo-shared', 'vault-operator-shared', '.obsidian-agent'] as const;

/**
 * Shared roots the migration READS, in precedence order.
 *
 * FIX-29-01-01 (Issue #69): every functional phase used to hardcode
 * 'obsilo-shared', the name the product carried before it was renamed. The
 * root the GlobalFileService actually writes to is 'vault-operator-shared'
 * (GLOBAL_DIR_NAME), and it appeared only in LEGACY_VAULT_PARENT_ROOTS above,
 * which is a DETECTION list. So the plugin could see the folder, report a
 * legacy layout, run a migration that moved nothing out of it, stamp the
 * status 'complete' and re-point globalFs at an empty vault-local root. The
 * bytes survived on disk, but nothing pointed at them any more.
 *
 * Order matters and is not alphabetical: the active root comes first because
 * it holds the newer truth for anyone who lived through the rename and has
 * both. moveOne() refuses to overwrite a populated destination, so the first
 * root to supply an entry keeps it, and later roots contribute only what the
 * earlier ones did not have.
 *
 * Keep this in sync with GLOBAL_DIR_NAME / LEGACY_GLOBAL_DIR_NAME in
 * GlobalFileService: a root the service can write must be a root the
 * migration can read.
 */
export const SHARED_SOURCE_ROOTS = ['vault-operator-shared', 'obsilo-shared'] as const;
/** Pre-consolidation vault-local asset-cache root; counts as legacy only for the fresh-install fast-path. */
const PRE_CONSOLIDATION_LOCAL_ROOT = '.vault-operator';

export interface LegacyLayoutProbeInput {
    /** Absolute filesystem path to the vault root. Empty = cannot probe. */
    vaultBasePath: string;
    /** Absolute filesystem path to the vault parent (one level up). */
    vaultParent: string;
    /** Injectable existence probe (tests). Default: fs.existsSync. */
    exists?: (p: string) => boolean;
    /** Injectable home dir (tests). Default: os.homedir(). */
    homeDir?: string;
    /**
     * ADR-162 sync guard: when set, the consolidated target root
     * (typically '.vault-operator') is EXCLUDED from the candidate list.
     * The fresh-install fast-path leaves this unset (a pre-consolidation
     * `.vault-operator` cache means "not truly fresh"); the guard for an
     * already-'complete' vault sets it so the consolidated root itself is
     * not mistaken for legacy inventory (Review-Finding: false 'pending'
     * reset when only cache/ but no data/ exists yet).
     */
    consolidatedFolder?: string;
}

/**
 * Returns true when ANY known legacy storage root exists for this vault.
 * Conservative by design (ADR-162): only a fully clean probe qualifies a
 * fresh install for the automatic `_layoutMigrationStatus='complete'`
 * fast-path; every hit keeps the explicit opt-in migration flow. An empty
 * vaultBasePath fails safe (legacy assumed, no fast-path).
 */
export function detectLegacyLayoutPresence(input: LegacyLayoutProbeInput): boolean {
    if (!input.vaultBasePath || !input.vaultParent) return true;
    const exists = input.exists ?? ((p: string) => {
        try { return rawFs.existsSync(p); } catch { return true; }
    });
    const localRoots: string[] = [...LEGACY_VAULT_LOCAL_ROOTS];
    // The pre-consolidation asset-cache root only counts as legacy for the
    // fast-path (consolidatedFolder unset); the guard excludes the very root
    // it is checking so a consolidated install's own '.vault-operator' does
    // not register as legacy inventory.
    if (input.consolidatedFolder !== PRE_CONSOLIDATION_LOCAL_ROOT) {
        localRoots.push(PRE_CONSOLIDATION_LOCAL_ROOT);
    }
    const candidates = [
        ...localRoots.map((r) => pathModule.join(input.vaultBasePath, r)),
        ...LEGACY_VAULT_PARENT_ROOTS.map((r) => pathModule.join(input.vaultParent, r)),
        // Prae-FEATURE-1508 Home-Root (migrateToParentDir behandelt ihn
        // weiterhin, also zaehlt er als Legacy-Bestand).
        pathModule.join(input.homeDir ?? osModule.homedir(), '.obsidian-agent'),
    ];
    return candidates.some((p) => exists(p));
}

/**
 * Whether there is user data the migration would actually move.
 *
 * FEAT-29-01-02 (Issue #69): deliberately NOT detectLegacyLayoutPresence.
 * That probe is a fast-path veto and is built to fail safe, so it answers true
 * for a machine-wide ~/.obsidian-agent belonging to a different vault, for a
 * consolidated install's own .vault-operator, and for an empty vaultBasePath.
 * Those are the right semantics for "do not auto-complete", and the wrong ones
 * for "interrupt the user": a prompt on that basis would ask people to decide
 * about a migration that has nothing to migrate.
 *
 * This asks the narrower question the prompt needs: does a shared root hold
 * one of the entries the migration carries across? Only then is the user's
 * data genuinely sitting outside the vault, which is what the prompt is about.
 */
export async function hasMigratableSharedData(
    vaultParent: string,
    probe: (p: string) => Promise<boolean> = pathExists,
): Promise<boolean> {
    if (!vaultParent) return false;
    const names = [...DATA_SHARED_ENTRIES.map((e) => e.name), 'skills'];
    for (const rootName of SHARED_SOURCE_ROOTS) {
        const root = pathModule.join(vaultParent, rootName);
        if (!(await probe(root))) continue;
        for (const name of names) {
            if (await probe(pathModule.join(root, name))) return true;
        }
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Status flag for resume
// ─────────────────────────────────────────────────────────────────────────

export type LayoutMigrationStatus =
    | 'pending'
    | 'backup-done'
    | 'data-vault-done'
    | 'cache-vault-done'
    | 'data-shared-done'
    | 'cache-shared-done'
    | 'skills-resolved'
    | 'cleanup-done'
    | 'settings-done'
    | 'complete';

const PHASE_ORDER: LayoutMigrationStatus[] = [
    'pending',
    'backup-done',
    'data-vault-done',
    'cache-vault-done',
    'data-shared-done',
    'cache-shared-done',
    'skills-resolved',
    'cleanup-done',
    'settings-done',
    'complete',
];

function isPhaseDone(current: LayoutMigrationStatus, phase: LayoutMigrationStatus): boolean {
    return PHASE_ORDER.indexOf(current) >= PHASE_ORDER.indexOf(phase);
}

// ─────────────────────────────────────────────────────────────────────────
// Report shape
// ─────────────────────────────────────────────────────────────────────────

export interface PhaseEntry {
    phase: LayoutMigrationStatus;
    /** Items processed in this phase (paths or skill names). */
    items: Array<{
        from: string;
        to: string;
        status: 'renamed' | 'copied' | 'skipped-no-source' | 'skipped-destination-populated' | 'failed';
        error?: string;
    }>;
    /** Wall-clock duration in milliseconds. */
    durationMs: number;
}

export interface LayoutMigrationReport {
    /** Final status the service reached. */
    status: LayoutMigrationStatus;
    /** When the migration started (ISO timestamp). */
    startedAt: string;
    /** When the migration finished (ISO timestamp). */
    finishedAt: string;
    /** Backup snapshot path, written in phase 1. */
    backupPath: string | null;
    /** Per-phase report. */
    phases: PhaseEntry[];
    /** True iff the chatHistoryFolder setting had a non-empty value before
     * migration. Caller (trigger) uses this to fire the removal-notice modal. */
    chatHistoryFolderHadValue: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Input contract
// ─────────────────────────────────────────────────────────────────────────

export interface AgentLayoutMigrationInput {
    /** Absolute filesystem path to the vault root. */
    vaultBasePath: string;
    /** Absolute filesystem path to the vault parent (one level up). */
    vaultParent: string;
    /** Absolute filesystem path to the directory where the backup snapshot
     * is written. MUST live outside every migration source root (recursive
     * self-copy bug, 14 GB ENAMETOOLONG explosion observed 2026-05-20) AND
     * outside any sync container (iCloud / Obsidian-Sync would replicate the
     * knowledge.db clone to remote servers; M-1 in AUDIT-FEAT-29-01).
     * Recommended layout: {homedir}/.vault-operator-migration-backups/{hash}/. */
    pluginDataDir: string;
    /** Current value of settings.agentFolderPath. Default is .vault-operator. */
    agentFolderPath: string;
    /** Current value of settings.chatHistoryFolder. May be empty. */
    chatHistoryFolder: string;
    /** Current status flag from settings._layoutMigrationStatus. */
    currentStatus: LayoutMigrationStatus;
    /** Callback to persist the status flag after each phase. */
    setStatus: (status: LayoutMigrationStatus) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────
// Filesystem helpers (lifted from migratePluginDataDirs, kept private)
// ─────────────────────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
    try {
        await rawFs.promises.access(p);
        return true;
    } catch {
        return false;
    }
}

async function isDirEmpty(p: string): Promise<boolean> {
    try {
        const entries = await rawFs.promises.readdir(p);
        return entries.length === 0;
    } catch {
        return true;
    }
}

async function copyRecursive(src: string, dest: string): Promise<void> {
    // lstat (NOT stat) so symlinks don't get followed. A malicious symlink in
    // the vault (e.g. .obsidian-agent/foo -> /etc/passwd) would otherwise
    // pipe host-file contents into the backup snapshot. L-4 in AUDIT-FEAT-29-01.
    const stat = await rawFs.promises.lstat(src);
    if (stat.isSymbolicLink()) {
        // Skip silently. The backup is for recovery; symlinks are user-vault-
        // specific and don't represent migration state. A subsequent restore
        // would never need them.
        return;
    }
    if (stat.isDirectory()) {
        await rawFs.promises.mkdir(dest, { recursive: true });
        const entries = await rawFs.promises.readdir(src, { withFileTypes: true });
        for (const entry of entries) {
            const s = pathModule.join(src, entry.name);
            const d = pathModule.join(dest, entry.name);
            await copyRecursive(s, d);
        }
    } else {
        await rawFs.promises.mkdir(pathModule.dirname(dest), { recursive: true });
        await rawFs.promises.copyFile(src, dest);
        // 0600 so a snapshot of knowledge.db / memory.db is owner-only. The
        // chmod is best-effort: Windows ignores it, but on macOS/Linux it
        // matters because the backup folder lives in the home dir, which on
        // multi-user systems may otherwise be world-readable. L-2 in AUDIT-FEAT-29-01.
        try {
            await rawFs.promises.chmod(dest, 0o600);
        } catch {
            // chmod failed (Windows or unusual FS) -- non-fatal, the file is
            // copied either way. The next pass of the audit can flag this.
        }
    }
}

/**
 * Move a single source path to destination. Strategy:
 *   1. fs.rename (atomic on same partition)
 *   2. on EXDEV/EPERM/EBUSY/ENOTEMPTY: copy + delete
 *
 * Returns one of the documented status values. Never throws.
 */
async function moveOne(from: string, to: string): Promise<{
    status: PhaseEntry['items'][0]['status'];
    error?: string;
}> {
    if (!(await pathExists(from))) {
        return { status: 'skipped-no-source' };
    }
    if ((await pathExists(to)) && !(await isDirEmpty(to))) {
        return { status: 'skipped-destination-populated' };
    }
    await rawFs.promises.mkdir(pathModule.dirname(to), { recursive: true });
    if (await pathExists(to)) {
        try { await rawFs.promises.rmdir(to); } catch { /* tolerate */ }
    }
    try {
        await rawFs.promises.rename(from, to);
        return { status: 'renamed' };
    } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code ?? '';
        if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
            return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
        }
    }
    try {
        await copyRecursive(from, to);
        await rawFs.promises.rm(from, { recursive: true, force: true });
        return { status: 'copied' };
    } catch (e) {
        return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 1: Backup snapshot
// ─────────────────────────────────────────────────────────────────────────

interface BackupResult {
    backupPath: string;
    bytesCopied: number;
}

/**
 * Create a backup snapshot of all four legacy roots under the Obsidian
 * plugin data directory (outside the vault, outside iCloud sync). Returns
 * the absolute backup path. Skips silently when a source root does not exist.
 *
 * Naming: vault-operator-backup-{ISO-timestamp}/{root-name}/...
 *
 * Hard safety: the backup destination must NOT live inside any migration
 * source path. If it does, the backup would copy itself recursively and
 * blow up with ENAMETOOLONG once the OS path limit is hit (observed in the
 * field 2026-05-20: a 14 GB recursive copy at depth 13 before the failure).
 */
async function phaseBackup(input: AgentLayoutMigrationInput): Promise<BackupResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = pathModule.join(input.pluginDataDir, `vault-operator-backup-${timestamp}`);

    const sources = [
        { label: 'obsidian-agent', from: pathModule.join(input.vaultBasePath, '.obsidian-agent') },
        { label: 'obsilo-vault', from: pathModule.join(input.vaultBasePath, '.obsilo-vault') },
        { label: 'vault-operator', from: pathModule.join(input.vaultBasePath, '.vault-operator') },
        // FIX-29-01-01: back up EVERY shared root, not just the old name.
        // A snapshot that misses the root holding the user's workflows is
        // worse than no snapshot, because it looks like one.
        ...SHARED_SOURCE_ROOTS.map((name) => ({
            label: name,
            from: pathModule.join(input.vaultParent, name),
        })),
    ];

    // Safety-belt: refuse to start the backup if its destination would sit
    // inside any of the source roots. Recursive self-copy is the only way
    // this function can corrupt user data, so we make the check explicit.
    for (const src of sources) {
        const normalizedFrom = pathModule.resolve(src.from);
        const normalizedBackup = pathModule.resolve(backupRoot);
        if (normalizedBackup.startsWith(normalizedFrom + pathModule.sep)
            || normalizedBackup === normalizedFrom) {
            throw new Error(
                `Backup destination (${backupRoot}) lives inside migration source ${src.from}. `
                + 'Choose a backup folder outside every legacy root (typically the Obsidian '
                + 'plugin data directory under {vault}/<config-dir>/plugins/<id>/).',
            );
        }
    }

    await rawFs.promises.mkdir(backupRoot, { recursive: true });

    let bytesCopied = 0;
    for (const src of sources) {
        if (!(await pathExists(src.from))) continue;
        const dest = pathModule.join(backupRoot, src.label);
        await copyRecursive(src.from, dest);
        // approximate byte count via du-like recursive sum
        bytesCopied += await sumBytes(dest);
    }

    // Retention: keep at most BACKUP_RETENTION snapshots, delete the rest.
    // L-1 in AUDIT-FEAT-29-01. Each snapshot can be hundreds of MB
    // (288 MB knowledge.db plus skills plus memory), so 3 snapshots cap the
    // disk-use at roughly 1 GB.
    await pruneOldBackups(input.pluginDataDir, backupRoot);

    return { backupPath: backupRoot, bytesCopied };
}

const BACKUP_RETENTION = 3;

/**
 * Delete all `vault-operator-backup-*` folders under `pluginDataDir` except
 * the most recent BACKUP_RETENTION (including the just-written `keepRoot`).
 * Order is ISO-timestamp-sorted; newest wins.
 */
async function pruneOldBackups(pluginDataDir: string, keepRoot: string): Promise<void> {
    try {
        const entries = await rawFs.promises.readdir(pluginDataDir, { withFileTypes: true });
        const snapshots = entries
            .filter((e) => e.isDirectory() && e.name.startsWith('vault-operator-backup-'))
            .map((e) => pathModule.join(pluginDataDir, e.name))
            .sort()
            .reverse(); // newest first
        // Always keep `keepRoot` in the survivors, then fill up to BACKUP_RETENTION.
        const survivors = new Set<string>([keepRoot]);
        for (const s of snapshots) {
            if (survivors.size >= BACKUP_RETENTION) break;
            survivors.add(s);
        }
        for (const s of snapshots) {
            if (survivors.has(s)) continue;
            try {
                await rawFs.promises.rm(s, { recursive: true, force: true });
            } catch {
                // non-fatal -- a leftover snapshot is recoverable manually
            }
        }
    } catch {
        // pluginDataDir may not exist on first migration; non-fatal.
    }
}

async function sumBytes(p: string): Promise<number> {
    try {
        const stat = await rawFs.promises.stat(p);
        if (!stat.isDirectory()) return stat.size;
        let total = 0;
        const entries = await rawFs.promises.readdir(p, { withFileTypes: true });
        for (const entry of entries) {
            total += await sumBytes(pathModule.join(p, entry.name));
        }
        return total;
    } catch {
        return 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 2: Data-Move vault-local (.obsilo-vault/* -> .vault-operator/data/*)
// ─────────────────────────────────────────────────────────────────────────

interface DataVaultMoveEntry {
    /** Folder or file name relative to .obsilo-vault/ */
    name: string;
}

/**
 * Items moved in phase 2. Drift Note: skills/ is intentionally NOT in this
 * list because phase 6 resolves it from two sources. plugin-skills/ stays in
 * this phase because FEAT-29-02 (Plugin-Skill-Format-Migration) is a
 * follow-up; here we only move bytes, not format.
 *
 * tmp/ and soak-reports/ go to cache/ in phase 3, not here.
 */
const DATA_VAULT_ENTRIES: DataVaultMoveEntry[] = [
    { name: 'knowledge.db' },
    { name: 'knowledge.db.bak' },
    { name: '.bak' },
    { name: 'plugin-skills' },
    { name: 'vault-dna.json' },
];

async function phaseDataVault(input: AgentLayoutMigrationInput): Promise<PhaseEntry['items']> {
    const sourceRoot = pathModule.join(input.vaultBasePath, '.obsilo-vault');
    const destRoot = pathModule.join(input.vaultBasePath, '.vault-operator', 'data');
    await rawFs.promises.mkdir(destRoot, { recursive: true });

    const results: PhaseEntry['items'] = [];
    for (const entry of DATA_VAULT_ENTRIES) {
        const from = pathModule.join(sourceRoot, entry.name);
        const to = pathModule.join(destRoot, entry.name);
        const r = await moveOne(from, to);
        results.push({ from, to, ...r });
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 3: Cache-Move vault-local
//   .vault-operator/{assets, runtime}    -> .vault-operator/cache/{assets, runtime}
//   .obsilo-vault/{tmp, soak-reports}    -> .vault-operator/cache/{tmp, soak-reports}
// ─────────────────────────────────────────────────────────────────────────

async function phaseCacheVault(input: AgentLayoutMigrationInput): Promise<PhaseEntry['items']> {
    const vaultOperatorRoot = pathModule.join(input.vaultBasePath, '.vault-operator');
    const cacheRoot = pathModule.join(vaultOperatorRoot, 'cache');
    const obsiloVaultRoot = pathModule.join(input.vaultBasePath, '.obsilo-vault');
    await rawFs.promises.mkdir(cacheRoot, { recursive: true });

    // Restructure inside .vault-operator/: assets and runtime move into cache/
    const inPlace: Array<{ name: string }> = [{ name: 'assets' }, { name: 'runtime' }];
    // Move throwaway data from .obsilo-vault into cache/
    const fromVault: Array<{ name: string }> = [{ name: 'tmp' }, { name: 'soak-reports' }];

    const results: PhaseEntry['items'] = [];
    for (const entry of inPlace) {
        const from = pathModule.join(vaultOperatorRoot, entry.name);
        const to = pathModule.join(cacheRoot, entry.name);
        const r = await moveOne(from, to);
        results.push({ from, to, ...r });
    }
    for (const entry of fromVault) {
        const from = pathModule.join(obsiloVaultRoot, entry.name);
        const to = pathModule.join(cacheRoot, entry.name);
        const r = await moveOne(from, to);
        results.push({ from, to, ...r });
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 4: Data-Move shared
//   obsilo-shared/{history, history.db[.bak], memory, memory.db[.bak],
//   memory-v1-backup, episodes, logs, rules, workflows, pending-extractions.json}
//     -> .vault-operator/data/*
// ─────────────────────────────────────────────────────────────────────────

const DATA_SHARED_ENTRIES: Array<{ name: string }> = [
    { name: 'history' },
    { name: 'history.db' },
    { name: 'history.db.bak' },
    { name: 'memory' },
    { name: 'memory.db' },
    { name: 'memory.db.bak' },
    { name: 'memory-v1-backup' },
    { name: 'episodes' },
    { name: 'logs' },
    { name: 'rules' },
    { name: 'workflows' },
    { name: 'pending-extractions.json' },
];

async function phaseDataShared(input: AgentLayoutMigrationInput): Promise<PhaseEntry['items']> {
    const destRoot = pathModule.join(input.vaultBasePath, '.vault-operator', 'data');
    await rawFs.promises.mkdir(destRoot, { recursive: true });

    const results: PhaseEntry['items'] = [];
    // FIX-29-01-01: iterate the roots in precedence order. moveOne() reports
    // 'skipped-destination-populated' rather than overwriting, so the first
    // root that supplies an entry keeps it and the later ones fill gaps.
    for (const rootName of SHARED_SOURCE_ROOTS) {
        const sourceRoot = pathModule.join(input.vaultParent, rootName);
        if (!(await pathExists(sourceRoot))) continue;
        for (const entry of DATA_SHARED_ENTRIES) {
            const from = pathModule.join(sourceRoot, entry.name);
            const to = pathModule.join(destRoot, entry.name);
            const r = await moveOne(from, to);
            results.push({ from, to, ...r });
        }
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 5: Cache-Move shared
//   obsilo-shared/{checkpoints, dev-env, tmp, .bak}
//     -> .vault-operator/cache/{checkpoints, dev-env, tmp-shared, .bak-shared}
// (tmp and .bak get the -shared suffix to avoid collision with vault-local
//  counterparts that already moved in phase 3 and phase 2 respectively.)
// ─────────────────────────────────────────────────────────────────────────

const CACHE_SHARED_ENTRIES: Array<{ name: string; destName?: string }> = [
    { name: 'checkpoints' },
    { name: 'dev-env' },
    { name: 'tmp', destName: 'tmp-shared' },
    { name: '.bak', destName: '.bak-shared' },
];

async function phaseCacheShared(input: AgentLayoutMigrationInput): Promise<PhaseEntry['items']> {
    const destRoot = pathModule.join(input.vaultBasePath, '.vault-operator', 'cache');
    await rawFs.promises.mkdir(destRoot, { recursive: true });

    const results: PhaseEntry['items'] = [];
    // FIX-29-01-01: same precedence walk as the data phase.
    for (const rootName of SHARED_SOURCE_ROOTS) {
        const sourceRoot = pathModule.join(input.vaultParent, rootName);
        if (!(await pathExists(sourceRoot))) continue;
        for (const entry of CACHE_SHARED_ENTRIES) {
            const from = pathModule.join(sourceRoot, entry.name);
            const to = pathModule.join(destRoot, entry.destName ?? entry.name);
            const r = await moveOne(from, to);
            results.push({ from, to, ...r });
        }
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 6: Skills drift-resolve (PLAN-27 Task 11)
//
// Two skill sources existed in parallel before this migration:
//   - {vault}/.obsilo-vault/skills/        vault-local (SelfAuthoredSkillLoader)
//   - {vault-parent}/obsilo-shared/skills/ vault-parent (GlobalFileService)
//
// They drifted with different content. Resolve by union with mtime precedence:
//   - skill only in one source -> move to .vault-operator/data/skills/<name>/
//   - skill in both -> compare SKILL.md mtimes, newer wins, loser archived
//     under .vault-operator/data/skills/<name>/.versions/<loser-mtime-iso>/
//
// Implementation note: this phase runs before phase 7 cleanup so the
// emptied skills/ folders can be removed together with the rest of the
// legacy roots.
// ─────────────────────────────────────────────────────────────────────────

interface SkillEntry {
    name: string;
    sourcePath: string;
    skillMdPath: string;
    mtimeMs: number;
}

async function listSkillsAt(skillsRoot: string): Promise<SkillEntry[]> {
    if (!(await pathExists(skillsRoot))) return [];
    const entries: SkillEntry[] = [];
    const dirents = await rawFs.promises.readdir(skillsRoot, { withFileTypes: true });
    for (const d of dirents) {
        if (!d.isDirectory()) continue;
        const sourcePath = pathModule.join(skillsRoot, d.name);
        // Anthropic convention is SKILL.md; legacy used skill.md. Prefer SKILL.md.
        const upper = pathModule.join(sourcePath, 'SKILL.md');
        const lower = pathModule.join(sourcePath, 'skill.md');
        const skillMd = (await pathExists(upper)) ? upper : (await pathExists(lower)) ? lower : null;
        if (!skillMd) continue;
        try {
            const stat = await rawFs.promises.stat(skillMd);
            entries.push({ name: d.name, sourcePath, skillMdPath: skillMd, mtimeMs: stat.mtimeMs });
        } catch {
            // skip unreadable
        }
    }
    return entries;
}

async function archiveLoser(
    loserSourcePath: string,
    winnerDestPath: string,
    loserMtimeMs: number,
): Promise<string> {
    const isoMtime = new Date(loserMtimeMs).toISOString().replace(/[:.]/g, '-');
    const archiveDir = pathModule.join(winnerDestPath, '.versions', isoMtime);
    await rawFs.promises.mkdir(archiveDir, { recursive: true });
    await copyRecursive(loserSourcePath, archiveDir);
    return archiveDir;
}

async function phaseSkillsResolve(input: AgentLayoutMigrationInput): Promise<PhaseEntry['items']> {
    const vaultLocal = pathModule.join(input.vaultBasePath, '.obsilo-vault', 'skills');
    const destRoot = pathModule.join(input.vaultBasePath, '.vault-operator', 'data', 'skills');
    await rawFs.promises.mkdir(destRoot, { recursive: true });

    const local = await listSkillsAt(vaultLocal);

    // FIX-29-01-01: skills can sit in either shared root. Collect them in
    // precedence order and let the newer mtime win within the shared side, so
    // the drift resolution below stays a two-way decision (vault-local against
    // shared) instead of growing a third axis.
    const sharedByName = new Map<string, SkillEntry>();
    for (const rootName of SHARED_SOURCE_ROOTS) {
        const dir = pathModule.join(input.vaultParent, rootName, 'skills');
        for (const e of await listSkillsAt(dir)) {
            const seen = sharedByName.get(e.name);
            if (!seen || e.mtimeMs > seen.mtimeMs) sharedByName.set(e.name, e);
        }
    }
    const shared = [...sharedByName.values()];

    const byName = new Map<string, { local?: SkillEntry; shared?: SkillEntry }>();
    for (const e of local) byName.set(e.name, { ...byName.get(e.name), local: e });
    for (const e of shared) byName.set(e.name, { ...byName.get(e.name), shared: e });

    const results: PhaseEntry['items'] = [];
    for (const [name, pair] of byName) {
        const dest = pathModule.join(destRoot, name);
        // Both sources present -> mtime precedence
        if (pair.local && pair.shared) {
            const winner = pair.local.mtimeMs >= pair.shared.mtimeMs ? pair.local : pair.shared;
            const loser = winner === pair.local ? pair.shared : pair.local;
            // Move winner to destination
            const r = await moveOne(winner.sourcePath, dest);
            // Archive loser under winner's .versions/
            try {
                const archiveDir = await archiveLoser(loser.sourcePath, dest, loser.mtimeMs);
                // Remove loser source after successful archive
                await rawFs.promises.rm(loser.sourcePath, { recursive: true, force: true });
                results.push({
                    from: `${winner.sourcePath} (winner) + ${loser.sourcePath} -> ${archiveDir}`,
                    to: dest,
                    status: r.status === 'failed' ? 'failed' : r.status,
                    error: r.error,
                });
            } catch (e) {
                results.push({
                    from: `${winner.sourcePath} + ${loser.sourcePath}`,
                    to: dest,
                    status: 'failed',
                    error: e instanceof Error ? e.message : String(e),
                });
            }
            continue;
        }
        // Single source -> straight move
        const only = (pair.local ?? pair.shared)!;
        const r = await moveOne(only.sourcePath, dest);
        results.push({ from: only.sourcePath, to: dest, ...r });
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 7: Legacy cleanup
//   Remove emptied .obsidian-agent/, .obsilo-vault/, obsilo-shared/ folders.
//   Telemetry inside .obsidian-agent/ is first moved to .vault-operator/data/
//   telemetry/. obsilo-shared/settings.json is evaluated separately (left in
//   place for now; FEAT-29-01 follow-up decides merge vs legacy-backup).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Recursive emptiness check: a directory counts as effectively empty if its
 * only contents are .DS_Store, iCloud sync conflict copies (filename
 * patterns like "foo 2.ext"), and other directories that are themselves
 * effectively empty. Used by phase 7 cleanup to remove legacy roots whose
 * sub-tree was drained by phases 2-6 but where empty intermediate folders
 * remained.
 */
async function isEffectivelyEmpty(dir: string): Promise<boolean> {
    try {
        const entries = await rawFs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const name = entry.name;
            if (name === '.DS_Store') continue;
            if (entry.isDirectory()) {
                const child = pathModule.join(dir, name);
                if (!(await isEffectivelyEmpty(child))) return false;
            } else {
                // Non-directory entry (file). Anything other than .DS_Store counts.
                return false;
            }
        }
        return true;
    } catch {
        return true;
    }
}

async function phaseCleanup(input: AgentLayoutMigrationInput): Promise<PhaseEntry['items']> {
    const results: PhaseEntry['items'] = [];

    // 7a: Move .obsidian-agent/telemetry to .vault-operator/data/telemetry
    const legacyAgent = pathModule.join(input.vaultBasePath, '.obsidian-agent');
    const telemetrySrc = pathModule.join(legacyAgent, 'telemetry');
    const telemetryDest = pathModule.join(input.vaultBasePath, '.vault-operator', 'data', 'telemetry');
    if (await pathExists(telemetrySrc)) {
        const r = await moveOne(telemetrySrc, telemetryDest);
        results.push({ from: telemetrySrc, to: telemetryDest, ...r });
    }

    // 7b: Remove emptied legacy roots. Empty intermediate sub-folders count
    // as empty for this purpose, otherwise leftover skills/ or similar shells
    // would keep the parent alive forever.
    const candidateRoots = [
        pathModule.join(input.vaultBasePath, '.obsidian-agent'),
        pathModule.join(input.vaultBasePath, '.obsilo-vault'),
        // FIX-29-01-01: every shared root the migration read is a root it may
        // now be able to remove.
        ...SHARED_SOURCE_ROOTS.map((name) => pathModule.join(input.vaultParent, name)),
    ];
    for (const root of candidateRoots) {
        if (!(await pathExists(root))) continue;
        if (await isEffectivelyEmpty(root)) {
            try {
                await rawFs.promises.rm(root, { recursive: true, force: true });
                results.push({ from: root, to: '(removed)', status: 'renamed' });
            } catch (e) {
                results.push({
                    from: root,
                    to: '(remove failed)',
                    status: 'failed',
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        } else {
            // Surface what is keeping the root alive so the user can decide
            // whether to clean it up by hand. Include both immediate entries
            // and the first non-empty file we find.
            const entries = await rawFs.promises.readdir(root);
            const meaningful = entries.filter((e) => e !== '.DS_Store');
            results.push({
                from: root,
                to: '(left in place)',
                status: 'skipped-destination-populated',
                error: `remaining entries: ${meaningful.join(', ')}`,
            });
        }
    }
    return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 8: Settings update (run inline by caller via setStatus + return flag)
// Phase 10: Report write
// ─────────────────────────────────────────────────────────────────────────

async function writeReport(
    input: AgentLayoutMigrationInput,
    report: LayoutMigrationReport,
): Promise<void> {
    const reportPath = pathModule.join(
        input.vaultBasePath,
        '.vault-operator',
        'data',
        'migration-report.json',
    );
    await rawFs.promises.mkdir(pathModule.dirname(reportPath), { recursive: true });
    await rawFs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run the layout migration. Resumes from input.currentStatus if a prior run
 * was interrupted. Always returns a report; never throws.
 *
 * NOTE: Phases 3-7 are placeholders; this commit only covers phases 1+2+10.
 * The full ten-phase implementation lands in follow-up commits as PLAN-27
 * progresses.
 */
export async function migrateAgentLayout(
    input: AgentLayoutMigrationInput,
): Promise<LayoutMigrationReport> {
    const startedAt = new Date().toISOString();
    const phases: PhaseEntry[] = [];
    let backupPath: string | null = null;
    let status = input.currentStatus;
    const chatHistoryFolderHadValue = input.chatHistoryFolder?.trim() || null;

    // Phase 1: Backup snapshot (always runs unless already past)
    if (!isPhaseDone(status, 'backup-done')) {
        const t0 = Date.now();
        const backup = await phaseBackup(input);
        backupPath = backup.backupPath;
        phases.push({
            phase: 'backup-done',
            items: [{ from: '(all legacy roots)', to: backup.backupPath, status: 'copied' }],
            durationMs: Date.now() - t0,
        });
        status = 'backup-done';
        await input.setStatus(status);
    }

    // Phase 2: Data-Move vault-local
    if (!isPhaseDone(status, 'data-vault-done')) {
        const t0 = Date.now();
        const items = await phaseDataVault(input);
        phases.push({ phase: 'data-vault-done', items, durationMs: Date.now() - t0 });
        status = 'data-vault-done';
        await input.setStatus(status);
    }

    // Phase 3: Cache-Move vault-local
    if (!isPhaseDone(status, 'cache-vault-done')) {
        const t0 = Date.now();
        const items = await phaseCacheVault(input);
        phases.push({ phase: 'cache-vault-done', items, durationMs: Date.now() - t0 });
        status = 'cache-vault-done';
        await input.setStatus(status);
    }

    // Phase 4: Data-Move shared (vault-parent -> vault-local)
    if (!isPhaseDone(status, 'data-shared-done')) {
        const t0 = Date.now();
        const items = await phaseDataShared(input);
        phases.push({ phase: 'data-shared-done', items, durationMs: Date.now() - t0 });
        status = 'data-shared-done';
        await input.setStatus(status);
    }

    // Phase 5: Cache-Move shared (vault-parent -> vault-local)
    if (!isPhaseDone(status, 'cache-shared-done')) {
        const t0 = Date.now();
        const items = await phaseCacheShared(input);
        phases.push({ phase: 'cache-shared-done', items, durationMs: Date.now() - t0 });
        status = 'cache-shared-done';
        await input.setStatus(status);
    }

    // Phase 6: skills-resolve  (drift-merge across two source roots)
    if (!isPhaseDone(status, 'skills-resolved')) {
        const t0 = Date.now();
        const items = await phaseSkillsResolve(input);
        phases.push({ phase: 'skills-resolved', items, durationMs: Date.now() - t0 });
        status = 'skills-resolved';
        await input.setStatus(status);
    }

    // Phase 7: cleanup
    if (!isPhaseDone(status, 'cleanup-done')) {
        const t0 = Date.now();
        const items = await phaseCleanup(input);
        phases.push({ phase: 'cleanup-done', items, durationMs: Date.now() - t0 });
        status = 'cleanup-done';
        await input.setStatus(status);
    }

    // Phase 8: settings-update  (PLAN-27 Task 4 trigger, follow-up commit)
    // Phase 9: chatHistoryFolder removal notice  (PLAN-27 Task 10, follow-up)

    // Phase 10: Report (always runs at the end of whatever phases ran)
    const finishedAt = new Date().toISOString();
    const report: LayoutMigrationReport = {
        status,
        startedAt,
        finishedAt,
        backupPath,
        phases,
        chatHistoryFolderHadValue,
    };

    try {
        await writeReport(input, report);
    } catch {
        // report-write failure is non-fatal; the in-memory report is the
        // primary handoff to the trigger
    }

    return report;
}

/* eslint-enable @typescript-eslint/no-require-imports -- end of file scope */
