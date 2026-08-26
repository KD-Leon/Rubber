/**
 * McpClient — simplified MCP client for Vault Operator
 *
 * Manages connections to MCP servers (stdio, SSE, streamable-http) and
 * forwards tool calls from the agent to the appropriate server.
 *
 * Intentionally lean: no OAuth, no file-watching, no auto-reconnect.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpServerConfig, McpOAuthSession } from '../../types/settings';
import { MCP_ALLOW_LOCAL_HEADER, obsidianFetch } from './obsidianFetch';
import { McpOAuthProvider } from './McpOAuthProvider';
import { isLocalHostname, isPrivateIpHostname, validateProviderUrl } from '../../api/providers/providerUrlGuard';
import { assertStdioCommandAllowed, SpawnNotAllowed } from '../security/spawnAllowlist';
import { stdioTrustFingerprint } from './stdioTrustFingerprint';
import { Platform } from 'obsidian';

/**
 * FEAT-04-13 / ADR-168: environment variables a stdio MCP process is allowed to
 * inherit. Paths and locale only; NO credential-bearing variables. CLI-config
 * LOCATIONS (not secrets) let az/gcloud/kubectl/gh find their own config, so a
 * server the user runs against their existing login works without VO handing
 * over tokens. Extra vars can be set explicitly per-server via config.env.
 *
 * NOTE (AUDIT-034 R4, 2026-07-23): this is the set VO explicitly forwards, not
 * the child's full env. StdioClientTransport spreads its own
 * getDefaultEnvironment() UNDER our env, adding posix LOGNAME/SHELL/USER (or the
 * Windows equivalents). None carry credentials, but the effective child env is
 * this allowlist UNION the SDK defaults UNION config.env. If a strict ceiling is
 * ever required, pass an SDK option to suppress its default env.
 */
const STDIO_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
    'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'PATHEXT',
    'AZURE_CONFIG_DIR', 'CLOUDSDK_CONFIG', 'KUBECONFIG', 'GH_CONFIG_DIR',
]);

/**
 * AUDIT-034 L-4: McpClient.connect formerly logged the raw transport error,
 * which can echo configured bearer tokens or query-string credentials back
 * into `conn.error` (visible in Settings) and `console.error`. This helper
 * strips known credential shapes before the string ever leaves the module.
 *
 * Mirrors the approach of src/mcp/RelayClient.ts:redactToken so the project
 * stays consistent with AUDIT-005 H-2/H-3.
 */
export function redactMcpError(
    message: string,
    config: { url?: string; headers?: Record<string, string>; env?: Record<string, string> } | undefined,
): string {
    if (!message) return message;
    let out = message;

    // Strip header-supplied bearer tokens (exact match).
    if (config?.headers) {
        for (const [k, v] of Object.entries(config.headers)) {
            if (!v) continue;
            if (k.toLowerCase() === 'authorization') {
                const bearer = v.replace(/^Bearer\s+/i, '').trim();
                if (bearer.length >= 8) out = out.split(bearer).join('<redacted>');
            } else if (/(token|secret|api[-_]?key|key)$/i.test(k) && v.length >= 8) {
                out = out.split(v).join('<redacted>');
            }
        }
    }

    // AUDIT-034 redact-mcp-error-no-env: stdio servers carry credentials in
    // config.env, not in headers/url. A spawn/transport error can echo the
    // value handed to the child, so scrub any non-trivial env value. Redacting
    // every value (not only secret-named ones) is safe: an error rarely echoes a
    // benign env value verbatim, and over-redaction only affects the error text.
    if (config?.env) {
        for (const v of Object.values(config.env)) {
            if (typeof v === 'string' && v.length >= 8) {
                out = out.split(v).join('<redacted>');
            }
        }
    }

    // Strip the full configured URL (it may carry userinfo or a token in the
    // query string) and its userinfo portion separately.
    if (config?.url) {
        try {
            const u = new URL(config.url);
            if (u.username || u.password) {
                u.username = '';
                u.password = '';
                // Preserve a <redacted> marker so the operator can see that
                // sensitive userinfo was scrubbed (not silently dropped).
                const scrubbed = u.toString().replace(
                    /^([a-z][a-z0-9+.-]*:\/\/)/i,
                    '$1<redacted>@',
                );
                out = out.split(config.url).join(scrubbed);
            }
            const search = u.search;
            if (search && /[?&](token|api[-_]?key|key|access[-_]?token|auth)=/i.test(search)) {
                const sanitized = search.replace(
                    /([?&](?:token|api[-_]?key|key|access[-_]?token|auth)=)[^&]+/gi,
                    '$1<redacted>',
                );
                const sanitizedUrl = u.toString().replace(search, sanitized);
                out = out.split(u.toString()).join(sanitizedUrl);
            }
        } catch {
            // ignore malformed URLs; the bare-text patterns below still apply
        }
    }

    // Generic header / query patterns, in case the SDK reformatted the error.
    out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer <redacted>');
    out = out.replace(
        /([?&](?:token|api[-_]?key|key|access[-_]?token|auth)=)[^&\s"']+/gi,
        '$1<redacted>',
    );
    out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<redacted>@');
    return out;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

export type McpConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error' | 'awaiting-auth';

export interface McpConnection {
    name: string;
    config: McpServerConfig;
    client?: Client;
    tools: McpToolInfo[];
    status: McpConnectionStatus;
    error?: string;
}

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

export interface McpClientOptions {
    /**
     * AUDIT-034 M-14: opt-in for loopback / RFC 1918 MCP servers. The SSRF
     * guard in obsidianFetch and the URL validation in McpClient.connect
     * default to rejecting local hosts. Set to true once an explicit
     * "allow local MCP URLs" checkbox in McpTab is checked.
     */
    allowLocalUrls?: boolean;
    /**
     * FEAT-04-10: opens an OAuth authorization URL in the user's external
     * browser. Injected by main.ts (Electron shell.openExternal); required
     * for OAuth connectors, unused for header-token servers.
     */
    openExternal?: (url: string) => void | Promise<void>;
    /**
     * FEAT-04-10: persists the OAuth session for a server after the SDK stored
     * client registration or tokens. The live `config.oauth` is already mutated
     * in place; this callback triggers the encrypted settings save.
     */
    persistOAuth?: (name: string) => void | Promise<void>;
    /**
     * FEAT-04-10: fired whenever a connection status changes out-of-band (the
     * async OAuth redirect completing). The connectors UI subscribes to refresh.
     */
    onStatusChange?: () => void;
    /** Test seam for the OAuth state generator. Defaults to Web Crypto. */
    randomState?: () => string;
    /**
     * FEAT-04-13 / ADR-168: per-device spawn-trust check for stdio servers.
     * Returns true only when the user has confirmed this stdio server on THIS
     * device. Injected by main.ts from the DeviceLocalStore. When undefined,
     * stdio is treated as untrusted (fail-closed) and connect() rejects.
     */
    isStdioTrusted?: (name: string, fingerprint?: string) => boolean;
    /**
     * FEAT-04-13 / ADR-168: decrypts a stdio env secret right before spawn.
     * Injected from main.ts (SafeStorageService.decrypt). Passthrough for
     * unprefixed (plaintext / non-secret) values, so mixed env maps work.
     */
    decryptSecret?: (value: string) => string;
}

export class McpClient {
    private connections = new Map<string, McpConnection>();
    private allowLocalUrls: boolean;
    // FEAT-04-10 OAuth state.
    private oauthProviders = new Map<string, McpOAuthProvider>();
    /** OAuth state parameter -> server name, for the pending redirect flow. */
    private pendingByState = new Map<string, string>();
    private oauthOpenExternal?: (url: string) => void | Promise<void>;
    private persistOAuth?: (name: string) => void | Promise<void>;
    private onStatusChange?: () => void;
    private randomState: () => string;
    private isStdioTrusted?: (name: string, fingerprint?: string) => boolean;
    private decryptSecret?: (value: string) => string;

    constructor(options: McpClientOptions = {}) {
        this.allowLocalUrls = options.allowLocalUrls === true;
        this.oauthOpenExternal = options.openExternal;
        this.persistOAuth = options.persistOAuth;
        this.onStatusChange = options.onStatusChange;
        this.randomState = options.randomState ?? randomUrlSafeState;
        this.isStdioTrusted = options.isStdioTrusted;
        this.decryptSecret = options.decryptSecret;
    }

    /** Used by the settings UI when the user toggles the allow-local option. */
    setAllowLocalUrls(allow: boolean): void {
        this.allowLocalUrls = allow === true;
    }

    /** Wire the OAuth callbacks after construction (main.ts boot ordering). */
    setOAuthCallbacks(cb: {
        openExternal?: (url: string) => void | Promise<void>;
        persistOAuth?: (name: string) => void | Promise<void>;
        onStatusChange?: () => void;
    }): void {
        if (cb.openExternal) this.oauthOpenExternal = cb.openExternal;
        if (cb.persistOAuth) this.persistOAuth = cb.persistOAuth;
        if (cb.onStatusChange) this.onStatusChange = cb.onStatusChange;
    }

    // ── Connection management ──────────────────────────────────────────────

    async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
        await Promise.all(
            Object.entries(servers).map(([name, config]) => this.connect(name, config))
        );
    }

    /**
     * @param opts.interactive Whether the USER started this attempt. Only an
     * interactive attempt may open a browser for OAuth; automatic connects
     * (boot, reconnect) stop at 'awaiting-auth' instead. Defaults to false, so
     * any new caller is silent unless it opts in.
     */
    async connect(
        name: string,
        config: McpServerConfig,
        opts?: { ignoreDisabled?: boolean; interactive?: boolean },
    ): Promise<void> {
        // Skip disabled servers unless an explicit authorize() forces the flow.
        if (config.disabled && !opts?.ignoreDisabled) {
            this.connections.set(name, { name, config, tools: [], status: 'disconnected' });
            return;
        }

        const conn: McpConnection = { name, config, tools: [], status: 'connecting' };
        this.connections.set(name, conn);

        // FEAT-04-10: assigned inside the try once the URL passes the SSRF
        // guard; declared here so the catch can clean up the pending-state entry.
        let authProvider: McpOAuthProvider | undefined;

        try {
            const isStdio = config.type === 'stdio';
            const client = new Client({ name: 'obsidian-agent', version: '1.0.0' });
            let transport;

            if (isStdio) {
                // FEAT-04-13 / ADR-168: URL-less local path. Desktop-only,
                // spawn gated by per-device trust; no SSRF/OAuth/header logic.
                transport = await this.buildStdioTransport(name, config);
            } else {
            if (!config.url) {
                throw new Error(`MCP server "${name}" has no URL configured`);
            }

            // AUDIT-034 M-14: SSRF guard.
            // Per-server opt-in wins over the instance-level default so that
            // one local dev server can be allowed without lowering the guard
            // for any other configured MCP server.
            const allowLocal = config.allowLocalUrls === true || this.allowLocalUrls;
            // Step 1: providerUrlGuard handles protocol (http/https only) and
            // the BLOCKED_HOSTNAMES set (AWS / GCP metadata, 0.0.0.0). We use
            // providerType='custom' because an MCP URL is user-elected.
            const parsedUrl = validateProviderUrl('custom', config.url, {
                allowLocalhost: allowLocal,
            });
            // Step 2: providerUrlGuard's "custom" branch returns local IPs by
            // design (community OpenAI-compatible gateways). For MCP the
            // policy is stricter -- local / RFC 1918 hosts are rejected
            // unless the user explicitly enabled "allow local MCP URLs" for
            // this server.
            if (parsedUrl) {
                const host = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
                const isLocal = isLocalHostname(host) || isPrivateIpHostname(host);
                if (isLocal && !allowLocal) {
                    throw new Error(
                        `MCP server "${name}" URL targets a local or private network host "${parsedUrl.host}". `
                        + 'Enable "Allow local URLs" on this server to permit loopback or RFC 1918 hosts.',
                    );
                }
            }

            // FEAT-04-10: OAuth connectors run through the SDK authProvider.
            // Register the state so the obsidian:// redirect can map back to
            // this server; cleared on a successful connect (no redirect needed).
            if (config.authType === 'oauth') {
                authProvider = this.getOrCreateProvider(name);
                // Re-decided on every attempt: providers are cached per server,
                // so a flag left over from an earlier user-driven authorization
                // must not license a later automatic connect to open a browser.
                authProvider.setInteractive(opts?.interactive === true);
                this.pendingByState.set(authProvider.getState(), name);
            }

            // Merged headers carry the per-request allow-local opt-in so the
            // SSRF guard in obsidianFetch keeps loopback connections working
            // for users who enabled the toggle. The header is stripped before
            // the wire request, so it never reaches the remote server.
            // AUDIT 2026-07-26 (P3): the config headers were spread in FIRST and
            // the opt-in only ever ADDED. Since the agent can write an MCP server
            // config (manage_mcp_server), it could simply put
            // `x-obsilo-allow-local: 1` in the headers and grant itself the
            // loopback/RFC-1918 access the setting exists to withhold. An internal
            // control channel that travels in the same map as caller-supplied data
            // has to be scrubbed from that map before it is trusted.
            const baseHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(config.headers ?? {})) {
                if (k.toLowerCase() === MCP_ALLOW_LOCAL_HEADER) continue;
                baseHeaders[k] = v;
            }
            if (allowLocal) {
                baseHeaders[MCP_ALLOW_LOCAL_HEADER] = '1';
            }
            const hasExplicitHeaders = Object.keys(baseHeaders).length > 0;

            if (config.type === 'sse') {
                const sseOptions: Record<string, unknown> = {
                    // Use CORS-free Node.js fetch -- Electron's browser fetch blocks cross-origin SSE
                    fetch: obsidianFetch,
                    eventSourceInit: { fetch: obsidianFetch },
                };
                if (hasExplicitHeaders) {
                    (sseOptions.eventSourceInit as Record<string, unknown>).headers = baseHeaders;
                    sseOptions.requestInit = { headers: baseHeaders };
                }
                // SSE transport kept as fallback for older MCP servers (config.type === 'sse')
                // Access via Record cast to avoid @typescript-eslint/no-deprecated (not disableable per ReviewBot)
                const sseMod = await import('@modelcontextprotocol/sdk/client/sse.js') as Record<string, unknown>;
                type TransportCtor = new (url: URL, opts?: Record<string, unknown>) => import('@modelcontextprotocol/sdk/shared/transport.js').Transport;
                const SseTransportCtor = sseMod['SSEClientTransport'] as TransportCtor;
                transport = new SseTransportCtor(new URL(config.url), sseOptions);
            } else {
                const httpOptions: Record<string, unknown> = {
                    // Use CORS-free Node.js fetch -- Electron's browser fetch blocks cross-origin requests
                    fetch: obsidianFetch,
                };
                if (hasExplicitHeaders) {
                    httpOptions.requestInit = { headers: baseHeaders };
                }
                if (authProvider) {
                    // The transport threads obsidianFetch into all OAuth calls (ADR-154).
                    httpOptions.authProvider = authProvider;
                }
                transport = new StreamableHTTPClientTransport(new URL(config.url), httpOptions);
            }
            } // end non-stdio (HTTP/SSE) branch

            const timeoutMs = (config.timeout ?? 60) * 1000;
            await Promise.race([
                client.connect(transport),
                new Promise<never>((_, reject) =>
                    window.setTimeout(() => reject(new Error(`Connection to "${name}" timed out`)), timeoutMs)
                ),
            ]);

            const toolsResult = await client.listTools();
            conn.client = client;
            conn.tools = (toolsResult.tools ?? []).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
            }));
            conn.status = 'connected';
            conn.error = undefined;
            if (authProvider) this.pendingByState.delete(authProvider.getState());
        } catch (e) {
            if (e instanceof UnauthorizedError) {
                // FEAT-04-10: the SDK opened the browser via the authProvider and
                // is waiting for the obsidian:// redirect. Not a failure; the
                // pending-state entry stays so completeOAuth can finish it.
                conn.status = 'awaiting-auth';
                conn.error = undefined;
            } else {
                conn.status = 'error';
                // AUDIT-034 L-4: redact bearer tokens, URL credentials, and
                // token-shaped query params before the message reaches conn.error
                // (Settings UI) or console.error.
                const raw = e instanceof Error ? e.message : String(e);
                const sanitized = redactMcpError(raw, config);
                conn.error = sanitized;
                console.error(`[McpClient] Failed to connect to "${name}": ${sanitized}`);
                if (authProvider) this.pendingByState.delete(authProvider.getState());
            }
        }
        this.notifyStatus();
    }

    /**
     * FEAT-04-13 / ADR-168: build the stdio transport after the three guards.
     * (1) Desktop-only: Node child_process is unavailable in the mobile iframe.
     * (2) Per-device trust: fail-closed unless the user confirmed THIS server
     *     on THIS device (isStdioTrusted). A config that traveled in some other
     *     way never spawns on its own.
     * (3) Binary allowlist: MVP restricts the command to node/npx
     *     (ALLOWED_BINARIES). Anything else errors instead of spawning.
     * The child inherits only STDIO_ENV_ALLOWLIST (plus explicit config.env),
     * never the full process env.
     */
    private async buildStdioTransport(name: string, config: McpServerConfig) {
        if (!Platform.isDesktopApp) {
            throw new Error(`stdio MCP server "${name}" is Desktop-only (no Node runtime on mobile).`);
        }
        if (!config.command) {
            throw new Error(`stdio MCP server "${name}" has no command configured.`);
        }
        // AUDIT 2026-07-26 M-16: trust is bound to the command line it was
        // granted for, not to the server NAME. Before this, confirming
        // "npx @vendor/mcp" once kept spawning under that trust even after the
        // config was edited to run something else entirely.
        const fingerprint = stdioTrustFingerprint(config);
        if (!this.isStdioTrusted || !this.isStdioTrusted(name, fingerprint)) {
            throw new Error(`stdio MCP server "${name}" is not trusted on this device for this command. Confirm it in Settings before it can run.`);
        }
        // AUDIT-034 R2/R3: single-source-of-truth guard in spawnAllowlist.
        // Restricts to node/npx (MVP), rejects a path-qualified command (basename
        // spoof like /tmp/evil/node) and shell metacharacters. The actual spawn
        // is the SDK's cross-spawn (shell:false); this is the policy the SDK
        // spawn itself does not enforce.
        try {
            assertStdioCommandAllowed(config.command);
        } catch (e) {
            if (e instanceof SpawnNotAllowed) {
                throw new Error(
                    `stdio MCP server "${name}" command "${config.command}" is not allowed. `
                    + `Only node / npx may be spawned as a bare command (FEAT-04-13 MVP).`,
                );
            }
            throw e;
        }

        // Filtered environment: allowlist from the current process, then the
        // server's explicit extras on top.
        const parentEnv = (window as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
        const env: Record<string, string> = {};
        for (const key of STDIO_ENV_ALLOWLIST) {
            const v = parentEnv[key];
            if (typeof v === 'string') env[key] = v;
        }
        // PATH enrichment: a GUI-launched Obsidian (Dock/Finder) inherits a
        // minimal PATH that usually lacks the Node/npx install dir, so `npx`
        // would not be found. Prepend the common install locations (Homebrew,
        // /usr/local, nvm), deduped, so the spawn resolves the binary.
        // Non-macOS/Windows keep their own dirs; missing ones are harmless
        // noise in PATH.
        if (process.platform !== 'win32') {
            const home = parentEnv.HOME ?? '';
            const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
                ...(home ? [`${home}/.nvm/current/bin`, `${home}/.local/bin`] : [])];
            const existing = (env.PATH ?? '').split(':').filter(Boolean);
            env.PATH = [...extra, ...existing].filter((p, i, a) => a.indexOf(p) === i).join(':');
        }
        // Force the public npm registry for npx-launched servers. A user's
        // ~/.npmrc may point npm at a private/corporate mirror that does not
        // serve public MCP packages (npx then fails with an auth error and the
        // process dies as "connection closed" before MCP starts). An env-level
        // npm_config_registry overrides every .npmrc in npm's config chain.
        // A per-server config.env entry still wins (set below).
        env.npm_config_registry = 'https://registry.npmjs.org/';

        if (config.env) {
            // Decrypt secret env right before spawn. The plaintext PAT lives
            // only in this local `env` object handed to the transport, never
            // back in config or on disk. Passthrough for plaintext values.
            for (const [k, v] of Object.entries(config.env)) {
                env[k] = this.decryptSecret ? this.decryptSecret(v) : v;
            }
        }

        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        return new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env,
        });
    }

    // ── OAuth (FEAT-04-10) ─────────────────────────────────────────────────

    /**
     * Start (or restart) the browser OAuth flow for an OAuth connector. Ignores
     * the `disabled` flag so a not-yet-authorized built-in can be authorized.
     * Regenerates the state so a stale flow cannot be replayed, then connects;
     * the SDK opens the browser and connect() lands in 'awaiting-auth'.
     */
    async authorize(name: string, config: McpServerConfig): Promise<void> {
        const provider = this.getOrCreateProvider(name);
        provider.beginAuth();
        // The one entry point that carries real user intent, so the only one
        // allowed to open a browser window.
        await this.connect(name, config, { ignoreDisabled: true, interactive: true });
    }

    /**
     * Handle the obsidian:// OAuth redirect. Validates the state against the
     * pending flow (CSRF, ADR-155) before exchanging the code. Unknown or
     * missing state is dropped without any token exchange.
     */
    async handleOAuthRedirect(params: Record<string, string>): Promise<void> {
        const state = params.state;
        const name = state ? this.pendingByState.get(state) : undefined;
        if (!name || !state) return; // unknown / mismatched state -> reject silently
        this.pendingByState.delete(state);

        if (params.error) {
            const conn = this.connections.get(name);
            if (conn) {
                const detail = params.error_description || params.error;
                conn.status = 'error';
                conn.error = `Authorization failed: ${redactMcpError(detail, conn.config)}`;
            }
            this.notifyStatus();
            return;
        }
        if (!params.code) return;
        await this.completeOAuth(name, params.code);
    }

    /**
     * Finish an OAuth flow: exchange the authorization code for tokens on a
     * fresh transport that shares the in-memory provider (holding the PKCE
     * verifier), then reconnect. On first success the connector is enabled so
     * later boots auto-connect using the stored (refreshable) tokens.
     */
    private async completeOAuth(name: string, code: string): Promise<void> {
        const conn = this.connections.get(name);
        const provider = this.oauthProviders.get(name);
        if (!conn || !provider || !conn.config.url) return;
        conn.status = 'connecting';
        conn.error = undefined;
        this.notifyStatus();
        try {
            const client = new Client({ name: 'obsidian-agent', version: '1.0.0' });
            const transport = new StreamableHTTPClientTransport(new URL(conn.config.url), {
                fetch: obsidianFetch,
                authProvider: provider,
            });
            // Exchanges the code + PKCE verifier for tokens; provider.saveTokens
            // persists them (encrypted on the next settings save).
            await transport.finishAuth(code);
            const timeoutMs = (conn.config.timeout ?? 60) * 1000;
            await Promise.race([
                client.connect(transport),
                new Promise<never>((_, reject) =>
                    window.setTimeout(() => reject(new Error(`Connection to "${name}" timed out`)), timeoutMs),
                ),
            ]);
            const toolsResult = await client.listTools();
            conn.client = client;
            conn.tools = (toolsResult.tools ?? []).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
            }));
            conn.status = 'connected';
            conn.error = undefined;
            // First authorization: enable so connectAll() reconnects on boot.
            if (conn.config.disabled) {
                conn.config.disabled = false;
            }
            void this.persistOAuth?.(name);
        } catch (e) {
            conn.status = 'error';
            const raw = e instanceof Error ? e.message : String(e);
            conn.error = redactMcpError(raw, conn.config);
            console.error(`[McpClient] OAuth completion failed for "${name}": ${conn.error}`);
        }
        this.notifyStatus();
    }

    /** Lazily create (and cache) the OAuth provider for a server. */
    private getOrCreateProvider(name: string): McpOAuthProvider {
        let provider = this.oauthProviders.get(name);
        if (!provider) {
            provider = new McpOAuthProvider({
                loadSession: () => this.connections.get(name)?.config.oauth,
                saveSession: (patch) => {
                    const cfg = this.connections.get(name)?.config;
                    if (cfg) cfg.oauth = mergeOAuthSession(cfg.oauth, patch);
                    void this.persistOAuth?.(name);
                },
                openBrowser: (url) => this.openExternal(url),
                randomState: () => this.randomState(),
            });
            this.oauthProviders.set(name, provider);
        }
        return provider;
    }

    private async openExternal(url: string): Promise<void> {
        // AUDIT 2026-07-17 L-1: the authorization URL is built from
        // server-controlled discovery metadata (authorization_endpoint). The
        // SDK's SafeUrlSchema only blocks javascript:/data:/vbscript:, leaving
        // file:// and custom OS protocol handlers reachable at the
        // shell.openExternal sink. Enforce https-only before opening the
        // system browser (CWE-601 / open-redirect to a dangerous scheme).
        assertHttpsAuthorizationUrl(url);
        if (this.oauthOpenExternal) {
            await this.oauthOpenExternal(url);
            return;
        }
        throw new Error('No external-browser opener configured for the OAuth redirect.');
    }

    private notifyStatus(): void {
        try {
            this.onStatusChange?.();
        } catch {
            // A settings-tab listener must never break the connection flow.
        }
    }

    async disconnect(name: string): Promise<void> {
        const conn = this.connections.get(name);
        if (!conn?.client) return;
        try {
            await conn.client.close();
        } catch {
            // ignore close errors
        }
        conn.client = undefined;
        conn.tools = [];
        conn.status = 'disconnected';
        conn.error = undefined;
    }

    async disconnectAll(): Promise<void> {
        await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)));
        this.connections.clear();
    }

    // ── Tool execution ─────────────────────────────────────────────────────

    async callTool(
        serverName: string,
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<string> {
        const conn = this.connections.get(serverName);
        if (!conn) {
            return `Error: MCP server "${serverName}" is not configured`;
        }
        if (conn.status !== 'connected' || !conn.client) {
            return `Error: MCP server "${serverName}" is not connected (status: ${conn.status}${conn.error ? ' — ' + conn.error : ''})`;
        }

        try {
            const result = await conn.client.callTool({ name: toolName, arguments: args });
            const content = result.content as Array<{ type: string; text?: string }> | undefined;
            if (!content || content.length === 0) return '(no output)';

            return content
                .filter((c) => c.type === 'text' && c.text != null)
                .map((c) => c.text as string)
                .join('\n') || '(non-text response)';
        } catch (e) {
            // AUDIT-034 L-4: same redaction applies to tool-call failures.
            const raw = e instanceof Error ? e.message : String(e);
            const sanitized = redactMcpError(raw, conn.config);
            return `Error calling ${toolName} on ${serverName}: ${sanitized}`;
        }
    }

    // ── Reconnect & Test ────────────────────────────────────────────────────

    /**
     * Reconnect a server by disconnecting and re-connecting with existing config.
     */
    async reconnect(name: string): Promise<void> {
        const conn = this.connections.get(name);
        if (!conn) throw new Error(`MCP server "${name}" is not configured`);
        await this.disconnect(name);
        await this.connect(name, conn.config);
    }

    /**
     * Test a connection by listing tools and optionally calling a no-op.
     * Returns a status report string.
     */
    async testConnection(name: string): Promise<string> {
        const conn = this.connections.get(name);
        if (!conn) return `Error: MCP server "${name}" is not configured`;
        if (conn.status !== 'connected' || !conn.client) {
            return `Error: MCP server "${name}" is not connected (status: ${conn.status}${conn.error ? ' — ' + conn.error : ''})`;
        }

        try {
            const toolsResult = await conn.client.listTools();
            const toolCount = toolsResult.tools?.length ?? 0;
            return `OK: Server "${name}" is connected with ${toolCount} tool(s) available.`;
        } catch (e) {
            // AUDIT-034 L-4
            const raw = e instanceof Error ? e.message : String(e);
            const sanitized = redactMcpError(raw, conn.config);
            return `Error: Test failed for "${name}": ${sanitized}`;
        }
    }

    // ── Introspection ──────────────────────────────────────────────────────

    getConnections(): McpConnection[] {
        return [...this.connections.values()];
    }

    getConnection(name: string): McpConnection | undefined {
        return this.connections.get(name);
    }

    getAllTools(): { serverName: string; tool: McpToolInfo }[] {
        const results: { serverName: string; tool: McpToolInfo }[] = [];
        for (const conn of this.connections.values()) {
            if (conn.status === 'connected') {
                for (const tool of conn.tools) {
                    results.push({ serverName: conn.name, tool });
                }
            }
        }
        return results;
    }
}

// ---------------------------------------------------------------------------
// OAuth helpers (FEAT-04-10)
// ---------------------------------------------------------------------------

/** Shallow-merge an OAuth session patch; an explicit `undefined` clears a field. */
function mergeOAuthSession(
    existing: McpOAuthSession | undefined,
    patch: McpOAuthSession,
): McpOAuthSession {
    return { ...(existing ?? {}), ...patch };
}

/**
 * URL-safe random state via Web Crypto. Uses the renderer's `window.crypto`
 * (no `require`, no `globalThis`) and base64url encoding.
 */
function randomUrlSafeState(): string {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * AUDIT 2026-07-17 L-1: reject any OAuth authorization URL that is not https
 * before it reaches shell.openExternal. The authorization_endpoint is
 * server-controlled discovery metadata; https-only closes the file:// and
 * custom OS-protocol-handler vectors the SDK's SafeUrlSchema leaves open.
 */
export function assertHttpsAuthorizationUrl(url: string): void {
    let scheme: string;
    try {
        scheme = new URL(url).protocol;
    } catch {
        throw new Error('Refusing to open an invalid authorization URL.');
    }
    if (scheme !== 'https:') {
        throw new Error(`Refusing to open a non-https authorization URL (scheme "${scheme}").`);
    }
}
