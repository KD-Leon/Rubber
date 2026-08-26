/**
 * UseMcpToolTool — bridge from LLM tool calls to the MCP client.
 *
 * The LLM calls: use_mcp_tool(server_name, tool_name, arguments, sink_to_path?)
 * This tool forwards the call to the connected McpClient instance.
 *
 * sink_to_path (result sink): when set, the FULL MCP result text is written to
 * that vault path and the model receives only a compact descriptor, NOT the
 * payload. This exists because some MCP tools return very large results (a
 * verified Plaud meeting note is ~105k chars / ~30k tokens): without the sink
 * the model re-emits the whole payload verbatim into a write_file call just to
 * get it onto disk -- the single most expensive line in the run, and one that
 * needs zero intelligence. The sink lets that payload reach disk without ever
 * entering the LLM context. See ResultExternalizer (ADR-063) for the OTHER
 * disk-offload path (auto-externalization to the PROTECTED temp dir); the sink
 * deliberately writes a VISIBLE vault note instead.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import type { McpClient } from '../../mcp/McpClient';
import { isMcpServerActive } from '../../mcp/mcpActivation';
import { validateVaultRelativePath } from '../vault/pathValidation';
import { getAgentFolderPath, isAbsoluteAgentFolder } from '../../utils/agentFolder';
import { safeNoteWrite } from '../../utils/safeNoteWrite';

interface UseMcpToolInput {
    server_name: string;
    tool_name: string;
    arguments?: Record<string, unknown>;
    /**
     * Result sink (optional). Vault-relative path (e.g. "Inbox/My Meeting.md").
     * When present, the full MCP result text is written there and the model
     * gets only a compact descriptor instead of the payload.
     */
    sink_to_path?: string;
}

/**
 * Validate a `sink_to_path` for the result sink.
 *
 * The sink writes a VISIBLE vault note, so the target must be a safe
 * vault-relative path OUTSIDE the config dir (.obsidian) and OUTSIDE the
 * agent's own folder (.vault-operator by default). This is the tool-local,
 * self-contained gate; the ToolExecutionPipeline runs IgnoreService over the
 * same key first (PATH_INPUT_KEYS -> use_mcp_tool.sink_to_path), so an
 * .obsidian-agentignore / .obsidian-agentprotected rule is enforced there too.
 * Both layers point at the same deny-zones; this one also makes the tool
 * correct in isolation (unit tests, any future non-pipeline caller).
 *
 * Exported for the unit tests.
 */
export function validateMcpSinkPath(
    plugin: ObsidianAgentPlugin,
    rawPath: unknown,
): { ok: true; path: string } | { ok: false; reason: string } {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        return { ok: false, reason: 'sink_to_path must be a non-empty vault-relative path.' };
    }
    // POSIX-absolute paths are rejected outright. validateVaultRelativePath
    // would silently strip the leading slash and treat it as vault-relative;
    // the sink must be an EXPLICIT vault-relative path, so reject instead.
    if (rawPath.startsWith('/')) {
        return { ok: false, reason: `sink_to_path "${rawPath}" must be vault-relative, not absolute.` };
    }
    const safePath = validateVaultRelativePath(rawPath);
    if (!safePath) {
        return {
            ok: false,
            reason: `sink_to_path "${rawPath}" is not a safe vault-relative path `
                + '(absolute, drive-letter, UNC, ".." or NUL segments are rejected).',
        };
    }

    const lower = safePath.toLowerCase();

    // Deny the vault config dir (.obsidian): plugin data.json (credentials) and
    // main.js live there; no sink has a reason to touch it. Mirrors IgnoreService.
    const configDir = plugin.app?.vault?.configDir;
    if (configDir) {
        const cfgLower = configDir.toLowerCase();
        if (lower === cfgLower || lower.startsWith(`${cfgLower}/`)) {
            return {
                ok: false,
                reason: `sink_to_path "${rawPath}" is inside the vault config dir (${configDir}); the sink must write a visible vault note.`,
            };
        }
    }

    // Deny the agent's own folder (settings.json, DBs, cache, skills). Use the
    // configured root; when it is absolute it can never contain a vault-relative
    // path, so the check is moot and skipped.
    const agentRoot = getAgentFolderPath(plugin);
    if (agentRoot && !isAbsoluteAgentFolder(agentRoot)) {
        const rootLower = agentRoot.toLowerCase().replace(/^\/+/, '');
        if (rootLower && (lower === rootLower || lower.startsWith(`${rootLower}/`))) {
            return {
                ok: false,
                reason: `sink_to_path "${rawPath}" is inside the agent folder (${agentRoot}); the sink must write a visible vault note.`,
            };
        }
    }

    return { ok: true, path: safePath };
}

/**
 * McpClient.callTool never THROWS for MCP-side failures (unreachable server,
 * unconnected transport, a tool-call exception): it returns a sanitized error
 * STRING. In sink mode we must not write such a string into the target note and
 * report success, so detect the exact prefixes McpClient emits and treat them
 * as errors (surface to the model, write nothing). Kept narrow on purpose -- a
 * broad `startsWith('Error')` would misfire on legitimate content.
 */
function isMcpCallErrorResult(result: string): boolean {
    return result.startsWith('Error: MCP server "') || result.startsWith('Error calling ');
}

export class UseMcpToolTool extends BaseTool<'use_mcp_tool'> {
    readonly name = 'use_mcp_tool' as const;
    // H-6: MCP tools are dynamic and may perform writes, deletes, or other destructive ops.
    // Treat as write so IgnoreService path-checks apply if the tool passes a 'path' argument.
    // Approval does not hang off this flag but off the 'mcp' effect class in
    // toolEffects.ts (ADR-153).
    readonly isWriteOperation = true;

    private mcpClient: McpClient;

    constructor(plugin: ObsidianAgentPlugin, mcpClient: McpClient) {
        super(plugin);
        this.mcpClient = mcpClient;
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'use_mcp_tool',
            description:
                'Call a tool on a connected MCP (Model Context Protocol) server. ' +
                'Use this to access external tools and data sources configured in Settings → MCP. ' +
                'Optional sink_to_path: for LARGE results you only need on disk (e.g. a meeting ' +
                'transcript you are about to file into a note), pass a vault-relative path and the ' +
                'full result is written there instead of into your context; you get back only a ' +
                'small descriptor { ok, path, chars, server, tool }. Do NOT set sink_to_path when ' +
                'you need to read or reason about the result yourself.',
            input_schema: {
                type: 'object',
                properties: {
                    server_name: {
                        type: 'string',
                        description: 'The name of the MCP server to call (as configured in Settings).',
                    },
                    tool_name: {
                        type: 'string',
                        description: 'The name of the tool to invoke on the server.',
                    },
                    arguments: {
                        type: 'object',
                        description: 'Arguments to pass to the tool. Must match the tool\'s input schema.',
                    },
                    sink_to_path: {
                        type: 'string',
                        description:
                            'Optional. Vault-relative path (e.g. "Inbox/My Meeting.md"). When set, the ' +
                            'FULL result is written to this file (parent folders created, existing file ' +
                            'overwritten) and only a compact descriptor is returned to you -- the payload ' +
                            'does NOT enter your context. Must stay inside the vault and outside the config ' +
                            'folder and the agent folder. Use it to file large results (transcripts, exports) you ' +
                            'do not need to read; omit it otherwise.',
                    },
                },
                required: ['server_name', 'tool_name'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { server_name, tool_name, arguments: args = {}, sink_to_path } = input as unknown as UseMcpToolInput;
        const { callbacks } = context;

        if (!server_name || !tool_name) {
            callbacks.pushToolResult(
                this.formatError(new Error('server_name and tool_name are required'))
            );
            return;
        }

        // MCP activation whitelist (single source of truth: mcpActivation).
        // Empty activeMcpServers == all connected servers active (the default
        // shared with the tool picker + ReadMcpToolTool); a non-empty list is
        // a user narrowing; mcpDisabled is the explicit "MCP off" switch. This
        // is a convenience filter, NOT the security boundary: only connected
        // servers are callable and every MCP call passes the 'mcp' effect
        // approval gate.
        if (!isMcpServerActive(this.plugin.settings, context.mode, server_name)) {
            callbacks.pushToolResult(
                this.formatError(new Error(
                    `MCP server "${server_name}" is not enabled for this chat. ` +
                    `Use the tool picker (pocket-knife button) in the chat toolbar to enable it.`
                ))
            );
            return;
        }

        // Validate the sink path BEFORE the MCP call. Validation is pure, so
        // moving it earlier cannot change MCP semantics -- but it means an
        // unsafe path costs ZERO MCP calls (the model retries with a corrected
        // path and that retry is the first and only call, honouring "do not
        // call the MCP tool twice"), and no expensive payload is fetched just
        // to be dropped. When sink_to_path is absent, this whole block is
        // skipped and behaviour below is byte-for-byte the original path.
        let safeSink: string | null = null;
        if (sink_to_path !== undefined && sink_to_path !== null) {
            const check = validateMcpSinkPath(this.plugin, sink_to_path);
            if (!check.ok) {
                callbacks.pushToolResult(this.formatError(new Error(check.reason)));
                return;
            }
            safeSink = check.path;
        }

        try {
            const result = await this.mcpClient.callTool(server_name, tool_name, args);

            if (safeSink !== null) {
                // MCP error surfaced as a returned string (McpClient never
                // throws for these): report it and write NOTHING, so an error
                // message never lands in the target note under an ok:true
                // descriptor.
                if (isMcpCallErrorResult(result)) {
                    callbacks.pushToolResult(this.formatError(new Error(result)));
                    return;
                }
                // Write the FULL payload to disk via the same hardened write
                // path the vault write tools use (safeNoteWrite: sink-side path
                // re-validation, atomic temp+rename, parent-folder creation,
                // open-editor refresh). The sink is a faithful, dumb writer --
                // the raw MCP result goes to disk unchanged; any JSON->Markdown
                // extraction is a separate step on the skill side.
                const written = await safeNoteWrite(this.plugin.app, safeSink, result);
                if (!written.ok) {
                    callbacks.pushToolResult(this.formatError(new Error(
                        `MCP result could not be written to "${safeSink}": ${written.reason}`
                    )));
                    return;
                }
                // Return only the compact descriptor -- NOT the payload.
                callbacks.pushToolResult(JSON.stringify({
                    ok: true,
                    path: safeSink,
                    chars: result.length,
                    server: server_name,
                    tool: tool_name,
                }));
                callbacks.log(
                    `MCP tool ${server_name}/${tool_name} returned ${result.length} chars -> sunk to ${safeSink}`
                );
                return;
            }

            // Default path (no sink): unchanged.
            // AUDIT-034 L-15: MCP responses are externally-sourced text.
            // Wrap them so the model treats the payload as user data, mirroring
            // the wrapVaultContentForMcp pattern at McpBridge.ts:866.
            const wrapped = this.formatUntrustedContent('mcp', result, {
                server: server_name,
                tool: tool_name,
            });
            callbacks.pushToolResult(wrapped);
            callbacks.log(`MCP tool ${server_name}/${tool_name} returned ${result.length} chars`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('use_mcp_tool', error);
        }
    }
}
