/**
 * GlobalFileService
 *
 * FileAdapter implementation backed by Node.js `fs` at {vault-parent}/.obsidian-agent/.
 * Used by all services whose data is shared across vaults (memory, history,
 * rules, workflows, skills, recipes, episodes, logs, etc.).
 *
 * FEATURE-1508: Root changed from ~/.obsidian-agent/ to {vault-parent}/.obsidian-agent/
 * so that all global data lives next to the vault and syncs via iCloud/OneDrive/etc.
 *
 * Pattern follows GlobalModeStore (same require-based Node.js access
 * available in Obsidian's Electron runtime).
 */

import type { FileAdapter } from './types';
import * as fsModule from '../security/safeFs';
import osModule from 'os';
import pathModule from 'path';

/** Cross-vault data directory next to the vault. Fresh installs get
 *  "vault-operator-shared". Existing installs may still be on the
 *  legacy names; the constructor below detects them and stays put,
 *  so no migration is required for current users. */
const GLOBAL_DIR_NAME = 'vault-operator-shared';
/** Legacy names. Looked up in order; the first existing one wins. */
const LEGACY_GLOBAL_DIR_NAMES = ['obsilo-shared', '.obsidian-agent'] as const;
/** Legacy name. Used by onload migration to detect old installs. */
export const LEGACY_GLOBAL_DIR_NAME = '.obsidian-agent';

/** Owner-only file mode for POSIX. Windows relies on user-profile ACLs
 *  and ignores POSIX modes, so the chmod path is platform-gated below. */
const OWNER_ONLY_MODE = 0o600;
const IS_WINDOWS = process.platform === 'win32';

/** Best-effort chmod to 0o600. Skipped on Windows. Errors are swallowed
 *  because they are non-fatal (the file content is already persisted) and
 *  may surface on filesystems that do not honor POSIX modes (FAT, exFAT). */
async function chmodOwnerOnly(absPath: string): Promise<void> {
    if (IS_WINDOWS) return;
    try {
        await fsModule.promises.chmod(absPath, OWNER_ONLY_MODE);
    } catch {
        // Non-fatal: filesystem may not support POSIX modes. The audit
        // remediation flagged this as best-effort (M-6 in AUDIT-034).
    }
}

/**
 * Optional hint to short-circuit the legacy-folder probe. When the caller
 * already knows that the FEAT-29-01 layout migration is complete, the
 * constructor lands directly on {vault}/{agentFolderPath}/data/ instead of
 * probing legacy paths. This fixes a boot-race where saveSettings() calls
 * that ran before the post-migration useVaultLocalRoot() hop would land
 * in a stale legacy folder (obsilo-shared/) and shadow newer values on
 * the next boot.
 */
export interface GlobalFileServiceLayoutHint {
    /** Vault-relative agent folder (e.g. ".vault-operator"). */
    agentFolderPath: string;
    /** FEAT-29-01 migration status from vault-local settings: 'pending' | 'in-progress' | 'complete' (forward-compatible with unknown values). */
    layoutMigrationStatus: string;
}

export class GlobalFileService implements FileAdapter {
    private root: string;
    private readonly vaultBasePath: string | undefined;

    /**
     * @param vaultBasePath - Absolute path to the vault root (from vault.adapter.getBasePath()).
     *   Fresh installs land in {vault-parent}/vault-operator-shared/.
     *   If an existing user already has a legacy folder
     *   ({vault-parent}/obsilo-shared/ or {vault-parent}/.obsidian-agent/),
     *   that path is used instead so their data is never abandoned.
     *   Falls back to ~/vault-operator-shared/ if no vaultBasePath.
     *
     * @param layoutHint - When `layoutMigrationStatus === 'complete'` the
     *   constructor skips the legacy probe and lands directly on
     *   {vault}/{agentFolderPath}/data/. Same end-state as calling
     *   useVaultLocalRoot() right after construction, but without the
     *   intermediate window where the legacy root is active (which is what
     *   leaked saveSettings() writes into obsilo-shared/ on every reload).
     *
     * FEAT-29-01: after the layout migration completes, call
     * useVaultLocalRoot(agentFolderPath) to re-point the service at
     * {vault}/.vault-operator/data/.
     */
    constructor(vaultBasePath?: string, layoutHint?: GlobalFileServiceLayoutHint) {
        this.vaultBasePath = vaultBasePath;

        // Boot-Race fix: if the FEAT-29-01 layout migration is already
        // complete and we have a vault path, skip the legacy probe and land
        // directly on the consolidated data root.
        if (
            vaultBasePath
            && layoutHint?.layoutMigrationStatus === 'complete'
            && layoutHint.agentFolderPath
        ) {
            this.root = pathModule.join(vaultBasePath, layoutHint.agentFolderPath, 'data');
            return;
        }

        const baseDir = vaultBasePath ? pathModule.dirname(vaultBasePath) : osModule.homedir();

        // Prefer existing legacy folders if they exist (preserves user data).
        // probePathExists is the documented bypass for this case -- the
        // candidate paths live in the vault-parent and may not be in the
        // allowlist on every install layout.
        for (const legacy of LEGACY_GLOBAL_DIR_NAMES) {
            const candidate = pathModule.join(baseDir, legacy);
            if (fsModule.probePathExists(candidate)) {
                this.root = candidate;
                return;
            }
        }

        this.root = pathModule.join(baseDir, GLOBAL_DIR_NAME);
    }

    /**
     * FEAT-29-01: switch this service to the vault-local data layout
     * ({vault}/<agentFolderPath>/data/). Called from plugin.onload after the
     * migration completes so that all dependent services (rulesLoader,
     * workflowLoader, skillsManager, memory, history, etc.) read from the
     * new consolidated location. Idempotent.
     *
     * @param agentFolderPath - vault-relative root, typically ".vault-operator"
     */
    useVaultLocalRoot(agentFolderPath: string): void {
        if (!this.vaultBasePath) return;
        const newRoot = pathModule.join(this.vaultBasePath, agentFolderPath, 'data');
        this.root = newRoot;
    }

    /** Return the legacy root path (~/.obsidian-agent/) for migration purposes. */
    static getLegacyRoot(): string {
        return pathModule.join(osModule.homedir(), LEGACY_GLOBAL_DIR_NAME);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** Resolve a relative path to an absolute path under the root. */
    resolvePath(relativePath: string): string {
        const resolved = pathModule.join(this.root, relativePath);
        // H-5: Prevent path traversal — resolved path must stay within root
        if (!resolved.startsWith(this.root + pathModule.sep) && resolved !== this.root) {
            throw new Error(`Path traversal blocked: ${relativePath}`);
        }
        return resolved;
    }

    /** Return the root directory path (~/.obsidian-agent/). */
    getRoot(): string {
        return this.root;
    }

    // ── FileAdapter implementation ───────────────────────────────────────────

    async exists(p: string): Promise<boolean> {
        try {
            await fsModule.promises.access(this.resolvePath(p));
            return true;
        } catch {
            return false;
        }
    }

    async read(p: string): Promise<string> {
        return fsModule.promises.readFile(this.resolvePath(p), 'utf-8');
    }

    /**
     * Write via a temp file in the same directory, then rename over the target.
     *
     * FIX-13-02-04 (Issue #64): plain writeFile truncates the target and then
     * fills it. A crash, a quit or an overlapping writer in that window leaves
     * a zero-byte or half-written file -- which is how a settings.json turned
     * into "Unexpected end of JSON input" on the next boot. saveSettings is
     * fired without await from several places in main.ts, so overlapping
     * writers are a real case, not a theoretical one.
     *
     * rename() is atomic within a filesystem, so a reader sees either the old
     * file or the new one, never a half of either. The temp file lives in the
     * SAME directory so the rename cannot hit EXDEV, and carries a unique
     * suffix so two concurrent writers cannot share one temp path.
     *
     * The mode is clamped on the temp file BEFORE the rename (M-6, AUDIT-034):
     * doing it afterwards would leave a brief window where a secret-bearing
     * file is world-readable.
     */
    private async writeAtomic(abs: string, data: string | Uint8Array): Promise<void> {
        await fsModule.promises.mkdir(pathModule.dirname(abs), { recursive: true });
        const tmp = `${abs}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        try {
            await fsModule.promises.writeFile(
                tmp,
                data,
                typeof data === 'string'
                    ? { encoding: 'utf-8', mode: OWNER_ONLY_MODE }
                    : { mode: OWNER_ONLY_MODE },
            );
            await chmodOwnerOnly(tmp);
            await fsModule.promises.rename(tmp, abs);
        } catch (e) {
            // Leave the previous file untouched and take the temp file with us.
            try { await fsModule.promises.unlink(tmp); } catch { /* nothing to clean */ }
            throw e;
        }
    }

    async write(p: string, data: string): Promise<void> {
        // M-6 (AUDIT-034): the owner-only clamp lives in writeAtomic, applied
        // to the temp file before it becomes visible under the real name.
        await this.writeAtomic(this.resolvePath(p), data);
    }

    /** Binary read for SQLite DBs and other non-UTF8 payloads (FEATURE-0319b backup-zip). */
    async readBinary(p: string): Promise<Uint8Array> {
        const buf = await fsModule.promises.readFile(this.resolvePath(p));
        return new Uint8Array(buf);
    }

    /** Binary write counterpart. */
    async writeBinary(p: string, data: Uint8Array): Promise<void> {
        // Same atomic path as write(). Binary payloads include knowledge.db,
        // which carries memory facts and history transcripts -- a torn write
        // there costs considerably more than a torn settings.json.
        await this.writeAtomic(this.resolvePath(p), data);
    }

    async mkdir(p: string): Promise<void> {
        await fsModule.promises.mkdir(this.resolvePath(p), { recursive: true });
    }

    async list(p: string): Promise<{ files: string[]; folders: string[] }> {
        const abs = this.resolvePath(p);
        try {
            const entries = await fsModule.promises.readdir(abs, { withFileTypes: true });
            const files: string[] = [];
            const folders: string[] = [];
            for (const entry of entries) {
                // Return paths relative to the adapter root (matching Obsidian convention)
                const relPath = p ? `${p}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    folders.push(relPath);
                } else {
                    files.push(relPath);
                }
            }
            return { files: files.sort(), folders: folders.sort() };
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
                return { files: [], folders: [] };
            }
            throw err;
        }
    }

    async remove(p: string): Promise<void> {
        const abs = this.resolvePath(p);
        const stat = await fsModule.promises.stat(abs).catch(() => null);
        if (!stat) return;
        if (stat.isDirectory()) {
            await fsModule.promises.rm(abs, { recursive: true, force: true });
        } else {
            await fsModule.promises.unlink(abs);
        }
    }

    async append(p: string, data: string): Promise<void> {
        const abs = this.resolvePath(p);
        // Ensure parent directory exists
        await fsModule.promises.mkdir(pathModule.dirname(abs), { recursive: true });
        // M-6 (AUDIT-034): owner-only on create; chmod after every append
        // to cover the case where the file already existed with a wider
        // mode (e.g. created by a previous build before this fix).
        await fsModule.promises.appendFile(abs, data, { encoding: 'utf-8', mode: OWNER_ONLY_MODE });
        await chmodOwnerOnly(abs);
    }

    async stat(p: string): Promise<{ mtime: number; size: number } | null> {
        try {
            const s = await fsModule.promises.stat(this.resolvePath(p));
            return { mtime: s.mtimeMs, size: s.size };
        } catch {
            return null;
        }
    }
}
