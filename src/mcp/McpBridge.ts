/**
 * McpBridge -- Hosts an MCP Server as a local HTTP endpoint.
 *
 * Runs an HTTP server on localhost (default port 27182) that speaks
 * MCP Streamable HTTP protocol. Claude Desktop connects via URL.
 * All tool calls are dispatched directly to Vault Operator services (no IPC needed).
 *
 * Requires Obsidian to be running (the services live in the Renderer process).
 *
 * ADR-053: MCP Server Prozess-Architektur (revised: HTTP instead of stdio+IPC)
 * FEATURE-1400: MCP Server Core
 */

import type ObsidianAgentPlugin from '../main';
import { keepVisible } from '../core/tools/vault/denyZoneFilter';
import { handleToolCall } from './tools/index';
import { TOOLS, AGENT_INTERNAL_TOOLS, MCP_WRITE_TOOLS } from './toolDefinitions';
import { RelayClient } from './RelayClient';
import { buildPrompts } from './prompts/systemContext';
import { validateMcpVaultPath } from './tools/mcpPathValidation';
import { defangBoundaryTags } from '../core/tools/BaseTool';
import * as safeFs from '../core/security/safeFs';
import { spawnAllowed, spawnAllowedSync } from '../core/security/spawnAllowlist';

/** Loopback port the local MCP HTTP server binds to. Exported so the
 *  settings UI can show the exact connect URL without duplicating the literal. */
export const MCP_LOCAL_PORT = 27182;
const DEFAULT_PORT = MCP_LOCAL_PORT;

/** Callback for tunnel URL changes (displayed in Settings UI). */
type TunnelUrlCallback = (url: string | null) => void;

// FIX-44-47: tool definitions and the derived write gate live in
// toolDefinitions.ts (leaf module, no import cycle with the dispatcher).
// Re-exported here for existing importers.
export { TOOLS, AGENT_INTERNAL_TOOLS };


// ---------------------------------------------------------------------------
// McpBridge -- HTTP-based MCP Server
// ---------------------------------------------------------------------------

export class McpBridge {
    private server: import('http').Server | null = null;
    private tunnelProcess: import('child_process').ChildProcess | null = null;
    private relayClient: RelayClient | null = null;
    private _running = false;
    private _tunnelUrl: string | null = null;
    private port = DEFAULT_PORT;
    private onTunnelUrl: TunnelUrlCallback | null = null;

    constructor(private plugin: ObsidianAgentPlugin) {}

    get tunnelUrl(): string | null { return this._tunnelUrl; }
    get remoteConnected(): boolean { return this.relayClient?.connected ?? false; }
    get remoteConnecting(): boolean { return this.relayClient?.connecting ?? false; }
    /** IMP-14-03-01: worker version seen on the last /poll, or null until one completed. */
    get deployedWorkerVersion(): string | null { return this.relayClient?.lastSeenWorkerVersion ?? null; }

    get running(): boolean { return this._running; }

    async start(): Promise<void> {
        if (this.server) return;

        // AUDIT-006 H-1: Ensure MCP server token exists (auto-generate on first run)
        if (!this.plugin.settings.mcpServerToken) {
            this.plugin.settings.mcpServerToken = crypto.randomUUID();
            await this.plugin.saveSettings();
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports -- http only via dynamic require in Electron
        const http = require('http') as typeof import('http');

        const server = http.createServer((req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
            void this.handleRequest(req, res);
        });
        this.server = server;

        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (e: Error) => {
                    console.warn(`[McpBridge] Failed to start HTTP server:`, e);
                    reject(e);
                };
                server.once('error', onError);
                server.listen(this.port, '127.0.0.1', () => {
                    server.off('error', onError);
                    this._running = true;
                    console.debug(`[McpBridge] MCP Server listening on http://127.0.0.1:${this.port}`);
                    resolve();
                });
            });
        } catch (e) {
            // FIX-14-04-05: a server that never bound must not stay parked in
            // this.server -- the early return at the top of start() would then
            // report a running bridge forever and no retry could ever bind.
            this._running = false;
            this.server = null;
            try { server.close(); } catch { /* never bound */ }
            throw e;
        }

        // FIX-14-04-05: the token file is user-wide, one file for every vault.
        // Writing it before listen() meant a second vault that lost the port to
        // EADDRINUSE still overwrote the token of the vault that owns the port,
        // and every stdio client got a permanent 401 with nothing to see. Only
        // a bound port may claim the file.
        this.writeMcpTokenFile();
    }

    /**
     * Write MCP server token to well-known file for mcp-server-worker (AUDIT-006 H-1).
     * The worker reads this file to authenticate HTTP requests to the local server.
     */
    private writeMcpTokenFile(): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- path/os are pure helpers; fs surface is via safeFs
            const nodePath = require('path') as typeof import('path');
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- path/os are pure helpers
            const os = require('os') as typeof import('os');
            const tokenDir = nodePath.join(os.homedir(), '.obsidian-agent');
            if (!safeFs.existsSync(tokenDir)) safeFs.mkdirSync(tokenDir, { recursive: true });
            // mode 0o600: owner-only read/write on Unix; silently ignored on Windows
            // (Windows relies on user-profile directory ACLs for protection)
            safeFs.writeFileSync(
                nodePath.join(tokenDir, 'mcp-token'),
                this.plugin.settings.mcpServerToken,
                { mode: 0o600 },
            );
        } catch (e) {
            console.warn('[McpBridge] Failed to write MCP token file:', e);
        }
    }

    /** Connect to remote relay (if configured). */
    connectRelay(): void {
        // Stop any existing polling loop first
        this.disconnectRelay();

        const url = this.plugin.settings.relayUrl;
        const token = this.plugin.settings.relayToken;
        if (!url || !token) return;

        this.relayClient = new RelayClient(this.plugin);
        this.relayClient.connect(url, token);
    }

    /** Disconnect from remote relay. */
    disconnectRelay(): void {
        this.relayClient?.disconnect();
        this.relayClient = null;
    }

    stop(): void {
        this.disconnectRelay();
        this.stopTunnel();
        if (this.server) {
            this.server.close();
            this.server = null;
            this._running = false;
            console.debug('[McpBridge] MCP Server stopped');
        }
    }

    /**
     * Start a Cloudflare Tunnel to make the MCP server publicly accessible.
     * The tunnel URL (e.g. https://xxx.trycloudflare.com) is available via tunnelUrl getter.
     */
    startTunnel(onUrl?: TunnelUrlCallback): void {
        if (this.tunnelProcess) return;
        this.onTunnelUrl = onUrl ?? null;

        // Check if cloudflared is available. All child_process access goes through
        // spawnAllowlist (FEAT-28-02), which enforces shell: false and rejects
        // any binary outside the seven-entry allowlist.
        const which = process.platform === 'win32' ? 'where' : 'which';
        const probe = spawnAllowedSync(which, ['cloudflared'], { encoding: 'utf-8', timeout: 3000 });
        if (probe.status !== 0) {
            console.warn('[McpBridge] cloudflared not found. Install via: brew install cloudflared');
            return;
        }

        console.debug('[McpBridge] Starting Cloudflare Tunnel...');
        this.tunnelProcess = spawnAllowed('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${this.port}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Parse tunnel URL from cloudflared stderr output
        this.tunnelProcess.stderr?.on('data', (data: Buffer) => {
            const line = data.toString();
            const urlMatch = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
            if (urlMatch && !this._tunnelUrl) {
                this._tunnelUrl = urlMatch[0];
                console.debug(`[McpBridge] Tunnel URL: ${this._tunnelUrl}`);
                this.onTunnelUrl?.(this._tunnelUrl);
            }
        });

        this.tunnelProcess.on('exit', (code: number | null) => {
            console.debug(`[McpBridge] Tunnel exited with code ${code ?? 'null'}`);
            this.tunnelProcess = null;
            this._tunnelUrl = null;
            this.onTunnelUrl?.(null);
        });
    }

    stopTunnel(): void {
        if (this.tunnelProcess) {
            try { this.tunnelProcess.kill('SIGTERM'); } catch { /* already dead */ }
            this.tunnelProcess = null;
            this._tunnelUrl = null;
            console.debug('[McpBridge] Tunnel stopped');
        }
    }

    // -----------------------------------------------------------------------
    // HTTP Request Handler (Streamable HTTP MCP)
    // -----------------------------------------------------------------------

    private async handleRequest(req: import('http').IncomingMessage, res: import('http').ServerResponse): Promise<void> {
        // AUDIT-006 H-1: Restrict CORS (block browser cross-origin requests)
        res.setHeader('Access-Control-Allow-Origin', 'app://obsidian.md');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // AUDIT 2026-07-27 L-2 (CWE-346): Host-header allowlist, defense-in-depth
        // against DNS rebinding. A rebound browser request is same-origin (CORS
        // does not stop it) but carries the attacker's Host header; reject any
        // Host that is not a loopback host or the active tunnel host. Fail closed.
        if (!isAllowedMcpHost(req.headers['host'] ?? '', this._tunnelUrl)) {
            // FIX-14-04-04: a rejected setup used to leave no trace at all, so
            // "it does not connect" was indistinguishable from "nothing ever
            // arrived". The warning lands in the ConsoleRingBuffer and is
            // readable via read_agent_logs.
            console.warn(`[McpBridge] Rejected request: host not allowed (host=${JSON.stringify(String(req.headers['host'] ?? '').slice(0, 120))})`);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Forbidden: host not allowed' } }));
            return;
        }

        // AUDIT-006 H-1 + AUDIT-013 H-5: Bearer token authentication with
        // timing-safe comparison. The previous `!==` comparison short-
        // circuited on first mismatch, leaking the token byte-by-byte over
        // many requests. Token is high-entropy (UUID v4) so the practical
        // attack window is small, but the standard fix is one stdlib call.
        const expectedToken = this.plugin.settings.mcpServerToken;
        // MCP-4: fail closed. If the token is somehow empty (corrupted data.json,
        // downgrade/migration, manual edit) we must reject every request, not
        // skip the check and accept everything on 127.0.0.1:27182.
        if (!expectedToken) {
            console.warn('[McpBridge] Rejected request: server token not configured');
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unauthorized: server token not configured' } }));
            return;
        }
        {
            // FIX-14-04-02 / -03: the scheme is matched case-insensitively per
            // RFC 7235 section 2.1, the value stays byte-exact and timing-safe,
            // and the three ways to fail are told apart (see classifyMcpAuth).
            const outcome = classifyMcpAuth(req.headers['authorization'] ?? '', expectedToken);
            if (!outcome.ok) {
                // FIX-14-04-04: reason only, never a token or a fragment of one.
                console.warn(`[McpBridge] Rejected request: authentication failed (${outcome.reason})`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: outcome.message } }));
                return;
            }
        }

        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        // AUDIT-006 M-4: Read body with size limit (matches relay worker 1 MB limit)
        const MAX_BODY = 1_048_576;
        const body = await new Promise<string>((resolve, reject) => {
            let data = '';
            req.on('data', (chunk: Buffer) => {
                data += chunk.toString();
                if (data.length > MAX_BODY) {
                    // FIX-14-04-04: size rejections were as silent as auth ones.
                    console.warn(`[McpBridge] Rejected request: payload exceeds the ${MAX_BODY} byte limit`);
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Payload too large' } }));
                    req.destroy();
                    reject(new Error('Payload too large'));
                }
            });
            req.on('end', () => resolve(data));
        });

        try {
            const request = JSON.parse(body) as { jsonrpc: string; method: string; id?: number | string; params?: Record<string, unknown> };

            // JSON-RPC Notifications have no 'id' -- they don't expect a response
            if (request.id === undefined || request.id === null) {
                // Still process it (side effects like notifications/initialized) but don't respond
                void this.handleJsonRpc(request).catch(() => { /* notification errors are silent */ });
                res.writeHead(204);
                res.end();
                return;
            }

            const result = await this.handleJsonRpc(request);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result,
            }));
        } catch (e) {
            // CodeQL #63: Sanitize error -- do not expose stack traces or internal paths
            const safeMessage = e instanceof Error ? e.message.split('\n')[0] : 'Internal server error';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: 0,
                error: { code: -32603, message: safeMessage },
            }));
        }
    }

    // -----------------------------------------------------------------------
    // JSON-RPC Method Dispatch
    // -----------------------------------------------------------------------

    private async handleJsonRpc(request: { method: string; params?: Record<string, unknown> }): Promise<unknown> {
        switch (request.method) {
            case 'initialize': {
                const requested = typeof request.params?.protocolVersion === 'string'
                    ? request.params.protocolVersion
                    : undefined;
                return this.buildInitializeResponse(requested);
            }

            case 'tools/list':
                return {
                    tools: this.getToolsWithContext(),
                };

            case 'tools/call': {
                const params = request.params as { name: string; arguments?: Record<string, unknown> } | undefined;
                if (!params?.name) throw new Error('Missing tool name');
                const result = await handleToolCall(this.plugin, params.name, params.arguments ?? {});
                return { content: result.content, isError: result.isError };
            }

            case 'prompts/list':
                return this.listPrompts();

            case 'prompts/get': {
                const promptName = (request.params as { name?: string })?.name;
                return this.getPrompt(promptName);
            }

            case 'resources/list':
                return { resources: this.buildResourceList() };

            case 'resources/read': {
                const uri = (request.params as { uri?: string })?.uri;
                return { contents: await this.readResource(uri ?? '') };
            }

            case 'resources/templates/list':
                return {
                    resourceTemplates: [{
                        uriTemplate: 'vault://{path}',
                        name: 'Vault note',
                        description: 'Read any note from your Obsidian vault by path',
                        mimeType: 'text/markdown',
                    }],
                };

            case 'notifications/initialized':
            case 'ping':
                return {};

            default:
                throw new Error(`Unknown method: ${request.method}`);
        }
    }

    // -----------------------------------------------------------------------
    // Dynamic Tool Definitions (with vault context)
    // -----------------------------------------------------------------------

    getToolsWithContext() {
        const vault = this.plugin.app.vault;

        // Get top-level folders for write_vault description
        // AUDIT 2026-07-26 M-7: these folder PATHS are baked into the advertised
        // write_vault description, so a denied folder was disclosed to every
        // connected MCP client before any tool ran. Filtered before the .slice,
        // so a denied folder cannot consume one of the 30 slots either.
        const folders = keepVisible(this.plugin, vault.getAllFolders(), (f) => f.path)
            .map(f => f.path)
            .filter(p => !p.startsWith('.') && p.split('/').length <= 2)
            .sort()
            .slice(0, 30);

        const folderList = folders.length > 0
            ? `\n\nExisting vault folders: ${folders.join(', ')}. Prefer existing folders when creating files.`
            : '';

        // Rules hint
        const rulesHint = '\n\nCall get_context to see user rules and preferences before writing.';

        // Get default new note folder from Obsidian settings
        let defaultFolder = '';
        try {
            const obsidianConfig = (this.plugin.app.vault as unknown as { config?: { newFileFolderPath?: string } }).config;
            if (obsidianConfig?.newFileFolderPath) {
                defaultFolder = `\n\nObsidian default folder for new notes: "${obsidianConfig.newFileFolderPath}". Use this when no specific folder is requested.`;
            }
        } catch { /* non-fatal */ }

        // MCP-2 / FIX-44-26: hide EVERY write tool from the advertised tool list
        // unless the user opted in -- not just write_vault. handleToolCall also
        // fails them closed, so this is the visible half of the same default-off
        // gate, kept consistent via the shared MCP_WRITE_TOOLS set.
        const allowWrite = this.plugin.settings.mcpAllowWriteTools;
        return TOOLS.filter(t => allowWrite || !MCP_WRITE_TOOLS.has(t.name)).map(t => {
            let description = t.description;
            if (t.name === 'write_vault') {
                description += folderList + defaultFolder + rulesHint;
            }
            if (t.name === 'execute_vault_op') {
                // IMP-14-00-01: this used to ASSIGN, and the assignment was the
                // only description a client ever saw -- the definition's hint
                // about describe_operation never reached the wire. The bridge
                // adds only what the definition cannot know, the operation
                // names the registry holds at runtime, and appends it like the
                // write_vault context above.
                const available = this.plugin.toolRegistry.getAllTools()
                    .map(tool => tool.name)
                    .filter(name => !AGENT_INTERNAL_TOOLS.has(name))
                    .sort()
                    .join(', ');
                description += `\n\nAvailable operations: ${available}.`;
            }
            if (t.name === 'search_vault') {
                description += `\n\nVault has ${keepVisible(this.plugin, vault.getMarkdownFiles(), (f) => f.path).length} notes. Semantic index: ${this.plugin.semanticIndex?.isIndexed ? 'built' : 'not built'}.`;
            }
            return {
                name: t.name,
                description,
                inputSchema: t.inputSchema,
            };
        });
    }

    // -----------------------------------------------------------------------
    // Initialize -- protocol-version negotiation + serverInfo
    // -----------------------------------------------------------------------

    /**
     * FIX-23-09-03: exposed as a public method so RelayClient delegates to
     * the same negotiation logic the local HTTP path uses. Echoes the
     * client's requested protocol version when we recognise it
     * (Perplexity strict-checks this); otherwise returns our highest
     * stable version.
     */
    buildInitializeResponse(requestedProtocolVersion?: string): {
        protocolVersion: string;
        capabilities: { tools: Record<string, never>; prompts: Record<string, never>; resources: Record<string, never> };
        serverInfo: { name: string; version: string };
        instructions: string;
    } {
        const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
        const negotiated = requestedProtocolVersion && SUPPORTED_VERSIONS.includes(requestedProtocolVersion)
            ? requestedProtocolVersion
            : '2025-03-26';
        return {
            protocolVersion: negotiated,
            capabilities: { tools: {}, prompts: {}, resources: {} },
            serverInfo: { name: 'Vault Operator', version: '1.0.0' },
            instructions: 'Vault Operator is an Obsidian plugin that exposes vault search, read, write, and memory tools over MCP. '
                + 'A descriptive context prompt is available via prompts/list as "vault-operator-context" and can be selected by the user. '
                + 'Typical flow: call get_context for vault stats, use search_vault / read_notes / write_vault as needed, '
                + 'and call sync_session at the end of a session to save the transcript to Obsidian.',
        };
    }

    // -----------------------------------------------------------------------
    // Prompts -- selectable system-context for MCP clients
    // -----------------------------------------------------------------------

    /**
     * FIX-23-09-03: exposed as a public method so RelayClient (the remote
     * connector path) can delegate prompts/list to the same implementation
     * the local HTTP path uses, instead of re-implementing it.
     */
    listPrompts(): { prompts: Array<{ name: string; description: string }> } {
        return {
            prompts: [{
                name: 'vault-operator-context',
                description: 'Recommended tool use, user rules, and available skills for this vault. Select to pin as conversation context.',
            }, {
                name: 'vault-operator-skills',
                description: 'Skill-based workflows for complex tasks (presentations, research, document creation).',
            }],
        };
    }

    /**
     * FIX-23-09-03: exposed for the relay path. Mirrors the prompts/get
     * dispatch from handleJsonRpc.
     */
    async getPrompt(promptName: string | undefined): Promise<{ messages: unknown[] }> {
        const allPrompts = await buildPrompts(this.plugin);
        if (promptName === 'vault-operator-skills') {
            const skillsText = allPrompts.find(p =>
                typeof p.content === 'object' && p.content.text?.includes('Available Skills')
            );
            return { messages: skillsText ? [skillsText] : allPrompts };
        }
        return { messages: allPrompts };
    }

    // -----------------------------------------------------------------------
    // Resources -- Vault notes as attachable context
    // -----------------------------------------------------------------------

    buildResourceList() {
        // AUDIT-013 H-3: never expose ignored notes via the MCP resource list.
        // Without this filter, the user's ignored notes show up in Claude
        // Desktop's "Add from Vault Operator" picker.
        const vault = this.plugin.app.vault;
        const ignoreService = this.plugin.ignoreService;
        const files = vault.getMarkdownFiles();
        return files
            .filter((f) => !ignoreService.isIgnored(f.path))
            .map((f) => {
                const name = f.path.split('/').pop()?.replace(/\.md$/, '') ?? f.path;
                return {
                    uri: `vault://${f.path}`,
                    name,
                    description: f.path,
                    mimeType: 'text/markdown',
                };
            });
    }

    private async readResource(uri: string) {
        // AUDIT-013 H-3 + H-4: validate path through the standard MCP gate
        // (traversal, ignore, protected) and wrap the returned content in a
        // trust-boundary tag so a downstream agent treats it as data, not as
        // instructions.
        const MAX_URI_LEN = 2048;
        if (uri.length > MAX_URI_LEN) return [];
        const rawPath = decodeURIComponent(uri.replace(/^vault:\/\//, ''));
        const validation = validateMcpVaultPath(this.plugin, rawPath, false);
        if (!validation.allowed) return [];

        const vault = this.plugin.app.vault;
        const file = vault.getFileByPath(rawPath);
        if (!file) return [];
        // Restrict to markdown files; binary or sidecar files are out of
        // scope for the resource picker.
        if (!('extension' in file) || (file as { extension?: string }).extension !== 'md') return [];

        try {
            const content = await vault.cachedRead(file);
            return [{
                uri,
                mimeType: 'text/markdown',
                text: wrapVaultContentForMcp(rawPath, content),
            }];
        } catch {
            return [];
        }
    }
}

/**
 * AUDIT-013 H-5: timing-safe string comparison for Bearer tokens.
 * Wraps Node's `crypto.timingSafeEqual` with the length-equality guard it
 * requires. Returns false for any length mismatch in constant-ish time
 * (length comparison itself is fast and non-secret).
 *
 * Exported for testability.
 */
export function timingSafeStringEqual(presented: string, expected: string): boolean {
    if (presented.length !== expected.length) return false;
    if (expected.length === 0) return false; // empty expected = misconfig, deny
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- node:crypto in plugin runtime
    const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/**
 * FIX-14-04-03: why an Authorization header was refused.
 *
 * `missing-header` and `wrong-scheme` only restate what the caller itself sent,
 * so naming them helps whoever is wiring a connector and tells an attacker
 * nothing he did not already know. `bad-token` keeps the naked "Unauthorized":
 * a more precise message would confirm that the header was formally correct,
 * which is exactly the bit worth guessing at. That line is deliberate.
 *
 * These are wire texts, read by MCP clients and by whoever debugs a connector.
 * They carry no i18n.
 */
export type McpAuthOutcome =
    | { ok: true }
    | { ok: false; reason: 'missing-header' | 'wrong-scheme' | 'bad-token'; message: string };

/**
 * FIX-14-04-02: RFC 7235 section 2.1 makes the auth-scheme token
 * case-insensitive, so a client sending "bearer" is compliant and used to get a
 * 401 for it. Only the scheme comparison is relaxed; the credential itself
 * stays a byte-exact, timing-safe comparison (AUDIT-013 H-5). Whitespace around
 * the credential is stripped, since no header can carry it into the value.
 *
 * Exported for testability.
 */
export function classifyMcpAuth(authHeader: string, expectedToken: string): McpAuthOutcome {
    const header = (authHeader ?? '').trim();
    if (header.length === 0) {
        return { ok: false, reason: 'missing-header', message: 'Unauthorized: no Authorization header' };
    }

    const separator = header.search(/\s/);
    const scheme = separator === -1 ? header : header.slice(0, separator);
    if (scheme.toLowerCase() !== 'bearer') {
        return { ok: false, reason: 'wrong-scheme', message: 'Unauthorized: Authorization header must use the Bearer scheme' };
    }

    const presented = separator === -1 ? '' : header.slice(separator + 1).trim();
    if (!timingSafeStringEqual(presented, expectedToken)) {
        return { ok: false, reason: 'bad-token', message: 'Unauthorized' };
    }
    return { ok: true };
}

/**
 * AUDIT 2026-07-27 L-2 (CWE-346): Host-header allowlist against DNS rebinding.
 *
 * The loopback server binds 127.0.0.1, but a browser page that rebinds a
 * hostname to 127.0.0.1 sends a same-origin request whose Host header is the
 * attacker's domain. CORS does not stop that (a rebound request is same-origin).
 * The Bearer token is the primary auth and already blocks this; this is a
 * redundant second layer that fails closed on an unexpected Host.
 *
 * Accepts: the loopback hosts (direct-local clients and cloudflared's origin
 * host) and, when a tunnel is active, the public tunnel hostname (cloudflared
 * may forward either shape). Exported for testability.
 */
export function isAllowedMcpHost(hostHeader: string, tunnelUrl: string | null): boolean {
    if (typeof hostHeader !== 'string' || hostHeader.trim().length === 0) return false;
    let host = hostHeader.trim().toLowerCase();
    // IPv6 literal must be bracketed per RFC 3986: [::1] or [::1]:port.
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        if (end === -1) return false;
        host = host.slice(1, end);
    } else {
        // Strip a trailing :port (IPv4 / hostname form).
        const colon = host.lastIndexOf(':');
        if (colon !== -1) host = host.slice(0, colon);
    }
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true;
    if (tunnelUrl) {
        try {
            const tunnelHost = new URL(tunnelUrl).hostname.toLowerCase();
            if (tunnelHost && host === tunnelHost) return true;
        } catch { /* malformed tunnel url -> not a valid host source */ }
    }
    return false;
}

/**
 * AUDIT-013 H-4: wrap untrusted vault content in a boundary tag the
 * downstream agent recognises as user data rather than as instructions.
 * Mitigates indirect prompt injection through note bodies or frontmatter
 * (e.g. "Ignore previous instructions" planted in a markdown file).
 *
 * Path is XML-escaped to prevent attribute injection.
 */
export function wrapVaultContentForMcp(path: string, content: string): string {
    const safePath = path
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    // AUDIT 2026-07-14 M-1: strip literal boundary tags from the body so it
    // cannot pre-close the <vault-content> wrapper.
    return `<vault-content path="${safePath}" trust="user-data">\n${defangBoundaryTags(content)}\n</vault-content>`;
}
