/**
 * SandboxBridge
 *
 * Plugin-side bridge that handles requests from the sandboxed iframe.
 * Controls vault access, URL allowlisting, path validation, and rate limiting.
 *
 * Part of Self-Development Phase 3: Sandbox + Dynamic Modules.
 */

import { TFile, TFolder, Notice } from 'obsidian';
import https from 'https';
import http from 'http';
import { MAX_RESPONSE_BYTES, readCappedResponseBody } from '../utils/httpBodyCap';
import type ObsidianAgentPlugin from '../../main';
import { validateVaultRelativePath } from '../tools/vault/pathValidation';
import { atomicAdapterWrite, atomicAdapterWriteBinary } from '../utils/atomicAdapterWrite';
import { followAllowlistedRedirects, type HopResponse } from './redirectGuard';
import { getInternalAgentFolderPath, DEFAULT_AGENT_FOLDER } from '../utils/agentFolder';
import { isProtectedAgentConfigPath } from '../governance/agentFolderGuard';

// ---------------------------------------------------------------------------
// SandboxBridge
// ---------------------------------------------------------------------------

export class SandboxBridge {
    private writeCount = 0;
    private requestCount = 0;
    private lastReset = Date.now();
    private readonly MAX_WRITES_PER_MIN = 10;
    private readonly MAX_REQUESTS_PER_MIN = 5;

    // M-8: Circuit breaker — disable bridge after excessive consecutive errors.
    // BUG-027 (2026-04-19): auto-reset after COOLDOWN_MS so a stuck circuit
    // doesn't permanently wedge the agent for the rest of the session. Once
    // tripped, the bridge stays closed for the cooldown window, then gives
    // the caller one chance to succeed and resets the counter.
    private consecutiveErrors = 0;
    private lastErrorAt = 0;
    private static readonly MAX_CONSECUTIVE_ERRORS = 20;
    private static readonly CIRCUIT_COOLDOWN_MS = 30_000;
    private circuitOpen = false;

    private readonly URL_ALLOWLIST = [
        'unpkg.com',
        'cdn.jsdelivr.net',
        'registry.npmjs.org',
        'esm.sh',
    ];

    constructor(private plugin: ObsidianAgentPlugin) {}

    // FIX-44-04 / FIX-44-43: this bridge is a warm singleton shared by every
    // task, so the governance taskId is NOT bridge state. It travels with each
    // write operation (executor resolves the execution's taskId and passes it
    // per call). The predecessor design -- a single mutable slot plus a
    // refcount -- was last-writer-wins: with two overlapping sandbox
    // executions from different tasks, the earlier task's writes were
    // checkpointed under the wrong taskId and restore_checkpoint missed them.

    async vaultRead(path: string): Promise<string> {
        this.checkCircuitBreaker();
        try {
            const normalised = normaliseVaultPath(path);
            this.validateVaultPath(normalised);
            this.logBridgeOp('vault-read', normalised);
            // FEAT-29-05: paths under hidden folders (.vault-operator/, etc.)
            // are not in Obsidian's TFile index, so getAbstractFileByPath
            // returns null and the read fails. Fall back to adapter.read
            // which works directly on the filesystem path.
            if (this.isHiddenPath(normalised)) {
                if (!(await this.plugin.app.vault.adapter.exists(normalised))) {
                    throw new Error(`Not a file: ${path}`);
                }
                const result = await this.plugin.app.vault.adapter.read(normalised);
                this.recordSuccess();
                return result;
            }
            const file = this.plugin.app.vault.getAbstractFileByPath(normalised);
            if (!(file instanceof TFile)) throw new Error(`Not a file: ${path}`);
            const result = await this.plugin.app.vault.read(file);
            this.recordSuccess();
            return result;
        } catch (e) {
            this.recordError();
            throw e;
        }
    }

    async vaultReadBinary(path: string): Promise<ArrayBuffer> {
        this.checkCircuitBreaker();
        try {
            const normalised = normaliseVaultPath(path);
            this.validateVaultPath(normalised);
            this.logBridgeOp('vault-read-binary', normalised);
            if (this.isHiddenPath(normalised)) {
                if (!(await this.plugin.app.vault.adapter.exists(normalised))) {
                    throw new Error(`Not a file: ${path}`);
                }
                const result = await this.plugin.app.vault.adapter.readBinary(normalised);
                this.recordSuccess();
                return result;
            }
            const file = this.plugin.app.vault.getAbstractFileByPath(normalised);
            if (!(file instanceof TFile)) throw new Error(`Not a file: ${path}`);
            const result = await this.plugin.app.vault.readBinary(file);
            this.recordSuccess();
            return result;
        } catch (e) {
            this.recordError();
            throw e;
        }
    }

    /**
     * FEAT-29-05: a vault path is "hidden" when ANY segment starts with a
     * dot (`.vault-operator/`, `.obsidian/`, but NOT `notes/My.File.md`).
     * The TFile API skips those folders; the adapter handles them.
     */
    private isHiddenPath(path: string): boolean {
        return path.split('/').some((seg) => seg.startsWith('.'));
    }

    async vaultList(path: string): Promise<string[]> {
        this.checkCircuitBreaker();
        try {
            // BUG-022: vaultList('/') used to throw because
            // getAbstractFileByPath('/') returns null -- Obsidian addresses the
            // vault root with an empty string and offers vault.getRoot() for
            // the special case.
            // BUG-028 (2026-04-19): trailing slashes on folder paths
            // (e.g. 'Notes/') also returned null from getAbstractFileByPath.
            // normaliseVaultPath now strips them globally.
            const normalised = normaliseVaultPath(path);
            this.validateVaultPath(normalised);
            this.logBridgeOp('vault-list', normalised);
            // FEAT-29-05: adapter.list for hidden folders (TFolder skips them).
            if (normalised !== '' && this.isHiddenPath(normalised)) {
                if (!(await this.plugin.app.vault.adapter.exists(normalised))) {
                    throw new Error(`Not a folder: ${path}`);
                }
                const listing = await this.plugin.app.vault.adapter.list(normalised);
                const result = [...listing.files, ...listing.folders];
                this.recordSuccess();
                return result;
            }
            const folder = normalised === ''
                ? this.plugin.app.vault.getRoot()
                : this.plugin.app.vault.getAbstractFileByPath(normalised);
            if (!(folder instanceof TFolder)) throw new Error(`Not a folder: ${path}`);
            const result = folder.children.map(c => c.path);
            this.recordSuccess();
            return result;
        } catch (e) {
            this.recordError();
            throw e;
        }
    }

    /**
     * @param governanceTaskId FIX-44-43: the task of the execution that issued
     * this write (threaded per operation by the executor). Snapshot attribution
     * only -- validation and rate limits apply regardless.
     */
    async vaultWrite(path: string, content: string, governanceTaskId?: string): Promise<void> {
        this.checkCircuitBreaker();
        this.validateVaultPath(path, true);
        // M-2: Write-Size-Limit
        if (content.length > SandboxBridge.MAX_WRITE_SIZE) {
            throw new Error(`Write too large: ${content.length} bytes (max ${SandboxBridge.MAX_WRITE_SIZE})`);
        }
        this.checkWriteRateLimit();
        await this.snapshotBeforeWrite(path, governanceTaskId);
        this.logBridgeOp('vault-write', `${path} (${content.length} chars)`);
        // FEAT-29-05: adapter.write for hidden folders (Vault.create skips them).
        // FIX-01-07-04 parity: atomic temp+rename so a skill bug or crash
        // mid-write cannot leave persistent skill state at 0 bytes.
        if (this.isHiddenPath(path)) {
            await atomicAdapterWrite(this.plugin.app.vault.adapter, path, content);
            this.recordSuccess();
            return;
        }
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.plugin.app.vault.modify(file, content);
        } else {
            await this.plugin.app.vault.create(path, content);
        }
        this.recordSuccess();
    }

    /**
     * FEAT-29-05: create a folder (and parents on the way) inside the
     * vault. Obsidian's adapter.mkdir is not recursive, so we walk the
     * path segment by segment. Idempotent -- existing folders are a
     * silent success.
     */
    async vaultMkdir(path: string): Promise<void> {
        this.checkCircuitBreaker();
        try {
            const normalised = normaliseVaultPath(path);
            this.validateVaultPath(normalised, true);
            // AUDIT 2026-07-14 (Codex) M-5: mkdir is a write and must count
            // against the write rate limit, like vaultWrite. Otherwise delayed
            // or looping sandbox code can spam folder creation unbounded.
            this.checkWriteRateLimit();
            this.logBridgeOp('vault-mkdir', normalised);
            const adapter = this.plugin.app.vault.adapter;
            const segments = normalised.split('/').filter((s) => s.length > 0);
            let current = '';
            for (const seg of segments) {
                current = current ? `${current}/${seg}` : seg;
                if (!(await adapter.exists(current))) {
                    await adapter.mkdir(current);
                }
            }
            this.recordSuccess();
        } catch (e) {
            this.recordError();
            throw e;
        }
    }

    /** @param governanceTaskId FIX-44-43: see {@link vaultWrite}. */
    async vaultWriteBinary(path: string, content: ArrayBuffer, governanceTaskId?: string): Promise<void> {
        this.checkCircuitBreaker();
        this.validateVaultPath(path, true);
        // M-2: Write-Size-Limit
        if (content.byteLength > SandboxBridge.MAX_WRITE_SIZE) {
            throw new Error(`Write too large: ${content.byteLength} bytes (max ${SandboxBridge.MAX_WRITE_SIZE})`);
        }
        this.checkWriteRateLimit();
        await this.snapshotBeforeWrite(path, governanceTaskId);
        this.logBridgeOp('vault-write-binary', `${path} (${content.byteLength} bytes)`);
        if (this.isHiddenPath(path)) {
            // FIX-01-07-04 parity: see vaultWrite above.
            await atomicAdapterWriteBinary(this.plugin.app.vault.adapter, path, content);
            this.recordSuccess();
            return;
        }
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.plugin.app.vault.modifyBinary(file, content);
        } else {
            await this.plugin.app.vault.createBinary(path, content);
        }
        this.recordSuccess();
    }

    async requestUrlBridge(
        url: string,
        options?: { method?: string; body?: string },
    ): Promise<{ status: number; text: string }> {
        this.checkCircuitBreaker();
        this.checkRequestRateLimit();
        // M-8: Validate options payload for prototype pollution
        if (options && this.hasPollutionKeys(options)) {
            throw new Error('Rejected: payload contains prototype pollution keys');
        }
        this.logBridgeOp('request-url', url);
        // AUDIT-038 ISSUE-004: per-hop allowlist validation. Obsidian's
        // requestUrl follows 3xx internally without re-running our guard,
        // so an allowlisted CDN that issues a redirect to a non-allowlisted
        // host (or to AWS IMDS / RFC 1918) would silently complete. We talk
        // to node:http(s) directly and re-validate every redirect target.
        const response = await followAllowlistedRedirects(
            url,
            (hopUrl) => this.fetchOnceWithoutRedirects(hopUrl, options),
            (hopUrl) => this.isAllowedUrl(hopUrl),
        );
        this.recordSuccess();
        return { status: response.status, text: response.text };
    }

    /**
     * Single HTTP(S) request that does NOT follow redirects. Returns raw
     * status / headers / body so {@link followAllowlistedRedirects} can
     * decide per-hop whether to continue.
     */
    private fetchOnceWithoutRedirects(
        url: string,
        options?: { method?: string; body?: string },
    ): Promise<HopResponse> {
        return new Promise((resolve, reject) => {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                reject(new Error(`Invalid URL: ${url}`));
                return;
            }
            const isHttps = parsed.protocol === 'https:';
            const lib = isHttps ? https : http;
            const method = (options?.method ?? 'GET').toUpperCase();
            const req = lib.request(
                {
                    protocol: parsed.protocol,
                    hostname: parsed.hostname,
                    port: parsed.port || (isHttps ? 443 : 80),
                    path: `${parsed.pathname}${parsed.search}`,
                    method,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; ObsidianAgent-Sandbox/1.0)',
                        Accept: '*/*',
                        Host: parsed.host,
                    },
                },
                (res) => {
                    // AUDIT 2026-07-14 (Codex) M-7 / SEC-039-M2: cap the buffered
                    // body while streaming instead of after Buffer.concat.
                    readCappedResponseBody(res, () => req.destroy(), MAX_RESPONSE_BYTES)
                        .then((text) => {
                            const headers: Record<string, string> = {};
                            for (const [k, v] of Object.entries(res.headers)) {
                                if (typeof v === 'string') headers[k] = v;
                                else if (Array.isArray(v)) headers[k] = v.join(', ');
                            }
                            resolve({
                                status: res.statusCode ?? 0,
                                headers,
                                text,
                            });
                        })
                        .catch(reject);
                },
            );
            req.on('error', (err: Error) => reject(err));
            // Idle timeout.
            req.setTimeout(15_000, () => {
                req.destroy(new Error('Sandbox request timed out after 15s'));
            });
            // AUDIT 2026-07-14 (Codex) M-7 / SEC-039-M3: absolute ceiling so a
            // slow-drip response cannot hold the request open indefinitely.
            const hardDeadline = window.setTimeout(() => {
                req.destroy(new Error('Sandbox request exceeded absolute time budget of 45s'));
            }, 45_000);
            // In the renderer this handle is a number; under the node test env
            // `window` aliases globalThis, so it is a timer object that would
            // otherwise hold the process open. unref it wherever it exists.
            (hardDeadline as unknown as { unref?: () => void }).unref?.();
            req.on('close', () => window.clearTimeout(hardDeadline));
            if (options?.body && method !== 'GET' && method !== 'HEAD') {
                req.write(options.body);
            }
            req.end();
        });
    }

    // -----------------------------------------------------------------------
    // M-8: Security Hardening
    // -----------------------------------------------------------------------

    /**
     * Check for prototype pollution keys in bridge payloads.
     * Rejects objects containing __proto__, constructor, or prototype.
     */
    hasPollutionKeys(obj: unknown): boolean {
        if (typeof obj !== 'object' || obj === null) return false;
        const keys = Object.keys(obj);
        if (keys.some(k => k === '__proto__' || k === 'constructor' || k === 'prototype')) {
            return true;
        }
        for (const k of keys) {
            if (this.hasPollutionKeys((obj as Record<string, unknown>)[k])) {
                return true;
            }
        }
        return false;
    }

    /** Log a bridge operation for observability. */
    private logBridgeOp(type: string, detail: string): void {
        console.debug(`[SandboxBridge] ${type}: ${detail}`);
    }

    /**
     * Check circuit breaker — throws if bridge is disabled. BUG-027: the
     * circuit auto-resets after CIRCUIT_COOLDOWN_MS of inactivity so a stuck
     * state doesn't permanently block the agent. The one probe that follows
     * the cooldown either succeeds (recordSuccess clears the counter) or
     * fails (recordError re-trips).
     */
    private checkCircuitBreaker(): void {
        if (!this.circuitOpen) return;
        const sinceLast = Date.now() - this.lastErrorAt;
        if (sinceLast >= SandboxBridge.CIRCUIT_COOLDOWN_MS) {
            console.debug('[SandboxBridge] Circuit auto-reset after', sinceLast, 'ms cooldown');
            this.consecutiveErrors = 0;
            this.circuitOpen = false;
            return;
        }
        throw new Error(
            `SandboxBridge circuit open — too many consecutive errors. Will auto-reset in ${Math.max(0, SandboxBridge.CIRCUIT_COOLDOWN_MS - sinceLast)} ms.`,
        );
    }

    /** Record a successful operation — resets error counter and closes the circuit. */
    private recordSuccess(): void {
        this.consecutiveErrors = 0;
        this.circuitOpen = false;
    }

    /** Record a failed operation — may trip the circuit breaker. */
    recordError(): void {
        this.consecutiveErrors++;
        this.lastErrorAt = Date.now();
        if (this.consecutiveErrors >= SandboxBridge.MAX_CONSECUTIVE_ERRORS && !this.circuitOpen) {
            this.circuitOpen = true;
            console.warn(`[SandboxBridge] Circuit breaker tripped — bridge disabled after ${SandboxBridge.MAX_CONSECUTIVE_ERRORS} consecutive errors. Auto-reset in ${SandboxBridge.CIRCUIT_COOLDOWN_MS / 1000}s.`);
            // AUDIT-037 L-3: surface the trip to the user instead of failing
            // silently. A buggy or hostile sandbox script can repeatedly
            // throw to disable the bridge; without a notice the user sees
            // tools become inert with no explanation.
            try {
                new Notice(
                    `Vault Operator sandbox bridge paused after ${SandboxBridge.MAX_CONSECUTIVE_ERRORS} errors. Auto-reset in ${SandboxBridge.CIRCUIT_COOLDOWN_MS / 1000}s. Reset manually from settings if needed.`,
                    8000,
                );
            } catch { /* Notice may be unavailable in non-UI tests */ }
        }
    }

    /** Reset the circuit breaker (e.g. when sandbox is recreated). */
    resetCircuitBreaker(): void {
        this.consecutiveErrors = 0;
        this.circuitOpen = false;
    }

    // -----------------------------------------------------------------------
    // Validation
    // -----------------------------------------------------------------------

    private static readonly MAX_WRITE_SIZE = 10 * 1024 * 1024; // 10 MB (Audit M-2)

    private validateVaultPath(path: string, isWrite = false): void {
        // AUDIT-034 L-1: delegate to the shared validateVaultRelativePath
        // helper so SandboxBridge applies the same rules as the vault tools
        // (segment-based `..` / `.`, NUL bytes, url-encoded traversal,
        // backslash normalisation). Keeps the strict rejection of absolute
        // paths that the inline check enforced. The empty string is the
        // canonical vault-root identifier (normaliseVaultPath maps '/' to
        // ''), so it must keep passing for vaultList('/').
        //
        // AUDIT-034 M-5: also reject Windows-style absolute paths so a
        // cross-platform script cannot escape the vault by passing
        // `C:\\users\\evil.md` or `\\\\server\\share` on Windows.
        if (typeof path === 'string') {
            if (path.startsWith('/') === true || path.startsWith('\\') === true) {
                throw new Error(`Invalid path: ${path}`);
            }
            if (/^[A-Za-z]:[/\\]/.test(path) === true) {
                throw new Error(`Invalid path (drive-letter prefix rejected): ${path}`);
            }
            if (path.startsWith('\\\\') === true) {
                throw new Error(`Invalid path (UNC prefix rejected): ${path}`);
            }
        }
        let safe: string;
        if (path === '') {
            safe = '';
        } else {
            const checked = validateVaultRelativePath(path);
            if (checked === null) {
                throw new Error(`Invalid path: ${path}`);
            }
            safe = checked;
        }

        // Shai Hulud Mitigation: Block reads AND writes to configDir.
        // AUDIT-034 M-4: previously this gate ran only when isWrite=true,
        // which let the sandbox bridge READ data.json (containing
        // safeStorage-encrypted credentials) and exfiltrate it via
        // requestUrl(). Symmetric read+write block makes configDir an
        // absolute deny-zone for sandboxed skill code.
        // H-3 (AUDIT 2026-07-14): case-insensitive so `.Obsidian/...` cannot slip
        // past on case-insensitive filesystems. The IgnoreService pass below
        // enforces the same zone; this inline check is the first line.
        const configDir = this.plugin.app.vault.configDir;
        const safeLower = safe.toLowerCase();
        const cfgLower = configDir.toLowerCase();
        if (safeLower.startsWith(`${cfgLower}/`) || safeLower === cfgLower) {
            throw new Error(`Sandbox ${isWrite ? 'write' : 'read'} blocked: ${configDir}/ is protected`);
        }

        // FIX-44-22 / FIX-44-24: the agent's own data root holds the security
        // knobs -- settings.json (autoApproval flags, provider apiKeys), the MCP
        // config, and the skill definitions whose `source: pro` decides trust.
        // configDir (.obsidian) was a deny-zone; .vault-operator/ was not, so a
        // sandboxed script could grant itself every permission or forge a paid
        // skill. Close it: inside the agent folder the sandbox may only touch
        // skill-data/ (its own runtime state), and may READ (not write) skills/.
        this.checkAgentFolderAccess(safe, isWrite);

        // FIX-44-04: obey the same IgnoreService the vault tools obey. Ignored
        // paths are off-limits entirely; protected paths are read-only. Without
        // this, .obsidian-agentprotected meant nothing to sandbox code.
        const ignore = this.plugin.ignoreService;
        if (ignore) {
            if (ignore.isIgnored(safe)) {
                throw new Error(`Sandbox blocked: ${ignore.getDenialReason(safe)}`);
            }
            if (isWrite && ignore.isProtected(safe)) {
                throw new Error(`Sandbox write blocked: ${ignore.getDenialReason(safe)}`);
            }
        }
    }

    /**
     * FIX-44-22: enforce the agent-folder deny-zone.
     *
     * The agent folder holds the security-critical configuration -- settings.json
     * (autoApproval flags, provider apiKeys), the MCP config, and the cache. A
     * sandboxed script could write settings.json and grant itself every
     * auto-approval flag; configDir was blocked, this root was not. Close it.
     *
     * The two exceptions are the skill workspace, which legitimately belongs to
     * the sandbox:
     *   - `skills/`     -- the skill-creator's `init_skill` script writes SKILL.md
     *                      and scripts here. It is NOT a trust hole: a skill's
     *                      trust class comes from the materializer manifest, not
     *                      from its frontmatter (resolveSkillSource, FIX-44-05),
     *                      so a script-authored skill is always `user`.
     *   - `skill-data/` -- a skill's own persistent runtime state.
     * Everything else under the agent folder (settings.json, mcp config, provider
     * configs, cache) is denied for both read and write.
     */
    private checkAgentFolderAccess(safe: string, isWrite: boolean): void {
        let root: string;
        try {
            root = getInternalAgentFolderPath(this.plugin);
        } catch {
            // No settings in scope (e.g. a bare unit test): fall back to the
            // default folder name so the deny-zone still applies fail-safe.
            root = DEFAULT_AGENT_FOLDER;
        }
        if (!isProtectedAgentConfigPath(safe, root)) return;

        throw new Error(
            `Sandbox ${isWrite ? 'write' : 'read'} blocked: ${root}/ is protected ` +
            `(agent configuration: settings, credentials, cache). ` +
            `Only skills/ and skill-data/ are accessible.`,
        );
    }

    /**
     * FIX-44-04: snapshot the target before a sandbox write, so a bad script is
     * recoverable via restore_checkpoint just like a bad tool write. No-op when
     * no task travelled with the write (FIX-44-43: the executor resolves the
     * issuing execution's taskId and passes it per operation) or checkpoints are
     * off. Never throws -- a failed snapshot must not block the write path.
     */
    private async snapshotBeforeWrite(path: string, taskId: string | undefined): Promise<void> {
        if (!taskId) return;
        if (this.plugin.settings?.enableCheckpoints === false) return;
        try {
            await this.plugin.checkpointService?.snapshot(taskId, [path], 'sandbox:write');
        } catch (e) {
            console.warn('[SandboxBridge] Checkpoint failed (non-fatal):', e);
        }
    }

    private isAllowedUrl(url: string): boolean {
        try {
            const parsed = new URL(url);
            const host = parsed.hostname;

            // Block non-HTTPS (data:, file:, ftp:, etc.)
            if (parsed.protocol !== 'https:') return false;

            // Block IP addresses (IPv4 and IPv6) — require domain names only
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
            if (host.startsWith('[') || host === 'localhost') return false;

            // Block non-standard ports
            if (parsed.port && parsed.port !== '443') return false;

            return this.URL_ALLOWLIST.some(
                a => host === a || host.endsWith('.' + a)
            );
        } catch {
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Rate Limiting
    // -----------------------------------------------------------------------

    private checkWriteRateLimit(): void {
        this.resetIfMinuteElapsed();
        // Fix: increment AFTER check (>= instead of > after ++)
        if (this.writeCount >= this.MAX_WRITES_PER_MIN) {
            throw new Error('Write rate limit exceeded (max 10/min)');
        }
        this.writeCount++;
    }

    private checkRequestRateLimit(): void {
        this.resetIfMinuteElapsed();
        if (this.requestCount >= this.MAX_REQUESTS_PER_MIN) {
            throw new Error('Request rate limit exceeded (max 5/min)');
        }
        this.requestCount++;
    }

    private resetIfMinuteElapsed(): void {
        if (Date.now() - this.lastReset > 60000) {
            this.writeCount = 0;
            this.requestCount = 0;
            this.lastReset = Date.now();
        }
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * BUG-028 (2026-04-19): Obsidian's `getAbstractFileByPath` treats `Notes`
 * and `Notes/` as different paths -- the trailing slash makes it return
 * null. Agents naturally type folder paths with a trailing slash
 * (`vault.list('Notes/')`), so every vault-bridge entry normalises the
 * path before validation. Also translates root variants (`/`, `.`) to the
 * empty string so vaultList's getRoot() branch is reachable.
 *
 * Exported for unit tests.
 */
export function normaliseVaultPath(raw: string): string {
    if (raw === '/' || raw === '.' || raw === './') return '';
    // Strip trailing slashes (except on the root which is already ''); leave
    // leading characters alone so validateVaultPath can still reject
    // absolute paths.
    return raw.replace(/\/+$/, '');
}
