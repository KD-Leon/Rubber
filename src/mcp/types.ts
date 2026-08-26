/**
 * IPC Message Types for MCP Server ↔ Plugin communication.
 *
 * The MCP Server runs as a separate Node.js process (child_process.spawn).
 * It handles stdio (MCP JSON-RPC) externally and IPC internally.
 *
 * ADR-053: MCP Server Prozess-Architektur
 * FEATURE-1400: MCP Server Core
 */

// ---------------------------------------------------------------------------
// Worker → Plugin (requests)
// ---------------------------------------------------------------------------

export type WorkerToPluginMessage =
    | { type: 'server-ready' }
    | { type: 'tool-call'; id: string; tool: string; args: Record<string, unknown> }
    | { type: 'get-prompts'; id: string }
    | { type: 'get-resources'; id: string }
    | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Plugin → Worker (responses)
// ---------------------------------------------------------------------------

export type PluginToWorkerMessage =
    | { type: 'tool-result'; id: string; content: McpContent[]; isError?: boolean }
    | { type: 'prompt-result'; id: string; messages: McpPromptMessage[] }
    | { type: 'resource-result'; id: string; resources: McpResource[] }
    | { type: 'shutdown' };

// ---------------------------------------------------------------------------
// MCP Content Types
// ---------------------------------------------------------------------------

export interface McpContent {
    type: 'text';
    text: string;
}

export interface McpPromptMessage {
    role: 'user' | 'assistant';
    content: McpContent;
}

export interface McpResource {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
    text: string;
}

// ---------------------------------------------------------------------------
// Tool Definitions (registered in the worker, dispatched via IPC)
// ---------------------------------------------------------------------------

/**
 * FIX-44-47: effect class of an MCP tool on the external bearer-token
 * surface. Mandatory on every definition so the write gate is DERIVED from
 * the registration instead of hand-maintained next to it (the fail-open
 * allowlist pattern ADR-153 eliminated agent-side).
 *
 * - `read`:     no persistent mutation. Ungated.
 * - `session`:  persists only the caller's own conversation-history /
 *               session bookkeeping (the dispatcher writes the same class of
 *               history rows itself as auto-tracking). Ungated by design.
 * - `dispatch`: routes to the ToolExecutionPipeline, which enforces
 *               per-operation effect governance (TOOL_EFFECTS + the headless
 *               MCP approval policy, FIX-44-46). No wholesale dispatcher gate.
 * - `write`:    mutates vault content or long-term memory. Gated behind
 *               settings.mcpAllowWriteTools (default off, fail-closed).
 *
 * Anything that is not explicitly declared resolves to `write` at runtime
 * (see resolveMcpToolEffect), so a forgotten declaration gates a tool
 * instead of exposing it.
 */
export type McpToolEffect = 'read' | 'session' | 'dispatch' | 'write';

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /** FIX-44-47: mandatory effect declaration; the write gate derives from it. */
    effect: McpToolEffect;
}

// ---------------------------------------------------------------------------
// Tool Handler (plugin-side, processes tool calls)
// ---------------------------------------------------------------------------

export interface McpToolResult {
    content: McpContent[];
    isError?: boolean;
}

// ---------------------------------------------------------------------------
// Type-safe string coercion for unknown args (Review-Bot: restrict-template-expressions)
// ---------------------------------------------------------------------------

/** Safely convert an unknown value to string. Avoids [object Object] for non-primitives. */
export function str(value: unknown, fallback = ''): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null || value === undefined) return fallback;
    return JSON.stringify(value);
}
