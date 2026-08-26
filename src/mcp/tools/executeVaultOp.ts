/**
 * execute_vault_op -- General-purpose tool dispatcher for MCP.
 *
 * Delegates to any registered Agent tool, routing the call through
 * `ToolExecutionPipeline` so that all governance layers participate:
 *
 *   - IgnoreService (path-based access control)
 *   - JSON-Schema input validation
 *   - Approval flow (write tools fail-closed when no callback is wired)
 *   - Checkpoint creation for write operations
 *   - Result cache for read operations
 *   - Operation log
 *
 * Tools in `AGENT_INTERNAL_TOOLS` are denied at the boundary regardless
 * of pipeline behaviour, because they are conceptually agent-only
 * (switch_mode, new_task, update_todo_list, ...).
 *
 * FIX-44-46: this dispatcher runs HEADLESS -- no user session, no approval
 * card. Instead of a missing callback (which the pipeline used to answer
 * with a misleading "Operation denied by user"), it passes an explicit
 * HeadlessApprovalPolicy: `settings.mcpAllowWriteTools` is the user's
 * standing consent for write-class effects (note-edit, vault-change), the
 * same consent the dedicated `write_vault` surface honours (FIX-44-26).
 * config and self-modify effects stay denied always (self-escalation
 * lock), with an error that names the policy. Everything else that would
 * need a card (web, sandbox, subtask, ...) is denied with a clear
 * headless-context message.
 *
 * FIX-44-50: the bound policy is the SOLE approval authority here. The
 * pipeline consults it before agent-local autoApproval settings and
 * run-scope grants, so a convenience toggle the user enabled for their
 * in-app agent (e.g. autoApproval.noteEdits or .web) can never authorize
 * an external bearer-token caller.
 *
 * AUDIT-013 C-1 (proper fix, replaces interim deny-list).
 *
 * IMP-14-00-01: the dispatcher also hands out parameter schemas. Its own
 * schema is `{operation, params}` and says nothing about the 60+ operations
 * behind it, so a foreign model had to learn every parameter name by failing.
 * `describe_operation` returns the registry's inputSchema for one operation,
 * and a validation failure carries that schema with it.
 */

import type ObsidianAgentPlugin from '../../main';
import type { McpToolResult } from '../types';
import type { ToolDefinition, ToolName, ToolUse } from '../../core/tools/types';
import type { ToolEffect } from '../../core/tools/toolEffects';
import { AGENT_INTERNAL_TOOLS, enforceSourceIsolation } from '../toolDefinitions';
import { ToolExecutionPipeline } from '../../core/tool-execution/ToolExecutionPipeline';

/**
 * IMP-14-00-01: reserved operation name. It is answered by the dispatcher
 * itself and never reaches the registry, so it stays available even when a
 * tool of the same name is registered later.
 */
const DESCRIBE_OPERATION = 'describe_operation';

export async function handleExecuteVaultOp(
    plugin: ObsidianAgentPlugin,
    args: Record<string, unknown>,
): Promise<McpToolResult> {
    const operation = args.operation as string | undefined;
    const params = (args.params as Record<string, unknown>) ?? {};

    if (!operation) {
        return {
            content: [{ type: 'text', text: 'Error: operation parameter is required' }],
            isError: true,
        };
    }

    // IMP-14-00-01: schema lookup is answered here, before any dispatch. It has
    // no side effect, so a model can ask for the shape of a write operation
    // without tripping the consent gate first.
    if (operation === DESCRIBE_OPERATION) {
        return describeOperation(plugin, params);
    }

    // Defense in depth: agent-internal tools are not part of the MCP
    // surface. The pipeline would auto-approve some of them (group=agent
    // is auto-approved by checkApproval), so we filter here before the
    // pipeline runs.
    if (AGENT_INTERNAL_TOOLS.has(operation)) {
        return {
            content: [{ type: 'text', text: `Operation "${operation}" is agent-internal and not callable via MCP.` }],
            isError: true,
        };
    }

    // FIX-23-09-08: strictSourceIsolation is checked BEFORE the dispatch, with
    // the same function the recall_memory and search_history wrappers use. The
    // guard used to sit in the wrappers alone, so the identical request was
    // refused there and answered with memory content here. The dispatcher hands
    // the call to the core tool, which knows no source_interface, so it cannot
    // honour a filter -- scopesBySource is false and the answer is a refusal.
    const isolation = enforceSourceIsolation({
        operation,
        args: params,
        strictSourceIsolation: plugin.settings?.memory?.crossSurface?.strictSourceIsolation === true,
        scopesBySource: false,
    });
    if (isolation.blocked) {
        return {
            content: [{ type: 'text', text: `Error: ${isolation.message}` }],
            isError: true,
        };
    }

    // Look up the tool in the registry (early signal for unknown ops)
    const tool = plugin.toolRegistry.getTool(operation as ToolName);
    if (!tool) {
        const available = plugin.toolRegistry
            .getAllTools()
            .map((t) => t.name)
            .filter((n) => !AGENT_INTERNAL_TOOLS.has(n))
            .sort()
            .join(', ');
        return {
            content: [{
                type: 'text',
                // IMP-14-00-01: the list of names alone is what made callers guess.
                text: `Unknown operation: "${operation}". Available operations: ${available}. `
                    + `For the parameters of one, call ${DESCRIBE_OPERATION} with `
                    + `params.operation set to its name.`,
            }],
            isError: true,
        };
    }

    // Per-call pipeline. No apiHandler is wired so tools that need an LLM
    // (e.g. plan_presentation) are unavailable from MCP context.
    const taskId = `mcp-vault-op-${Date.now()}`;
    const pipeline = new ToolExecutionPipeline(
        plugin,
        plugin.toolRegistry,
        taskId,
        'agent',
        // apiHandler intentionally omitted
    );

    // FIX-44-46: explicit headless approval policy instead of a missing
    // callback. Write-class effects follow the user's standing consent
    // ("Allow write tools over MCP", default off); config/self-modify are
    // rejected before the consent set is consulted, so this cannot widen
    // the self-escalation lock. The label and path are wire-facing and must
    // match the dispatcher gate in tools/index.ts and the McpTab toggle.
    pipeline.setHeadlessApprovalPolicy({
        consentedEffects: new Set<ToolEffect>(['note-edit', 'vault-change']),
        consentGranted: plugin.settings.mcpAllowWriteTools === true,
        consentSettingLabel: 'Allow write tools over MCP',
        consentSettingPath: 'Settings > Vault Operator > Customize > Connectors',
    });

    const toolCall: ToolUse = {
        type: 'tool_use',
        id: taskId,
        name: operation as ToolName,
        input: params,
    };

    // FIX-14-00-01: the callback is the ERROR channel only. The pipeline
    // forwards every pushToolResult here AND returns the same text in
    // result.content, so collecting both and joining them shipped every
    // dispatcher answer twice (get_vault_stats: 2545 chars, first half
    // identical to the second). The return value is the authoritative
    // channel -- it is also the one that carries the externalized or capped
    // form of a large result. handleError stays, because tools like
    // recall_memory report a failure through it and push nothing: there the
    // callback is the only carrier the message has.
    const errorParts: string[] = [];
    const logParts: string[] = [];

    let result;
    try {
        result = await pipeline.executeTool(
            toolCall,
            {
                pushToolResult(): void {
                    // Intentionally empty, see FIX-14-00-01 above.
                },
                handleError(_toolName: string, error: unknown): Promise<void> {
                    const msg = error instanceof Error ? error.message : String(error);
                    errorParts.push(`Error: ${msg}`);
                    return Promise.resolve();
                },
                log(message: string): void {
                    logParts.push(message);
                },
            },
            // No extensions: no onApprovalRequired (the headless policy above
            // decides instead), no spawnSubtask, no askQuestion, no readFiles
            // tracking.
            undefined,
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            content: [{ type: 'text', text: `Operation "${operation}" failed: ${msg}` }],
            isError: true,
        };
    }

    // Pipeline returns content as a string OR a content-block array. Extract
    // text. For multimodal content blocks (rare here) only text is forwarded.
    const pipelineText = extractPipelineText(result.content);
    // The error channel only speaks when the pipeline returned nothing, so an
    // error the pipeline already reports in its own result is not repeated.
    const errorFallback = pipelineText.length === 0 && errorParts.length > 0;
    let text = pipelineText
        || errorParts.join('\n')
        || `Operation "${operation}" completed (no output).`;
    // IMP-14-00-01: a caller that guessed a parameter name gets the real schema
    // in the same answer instead of a second round of guessing. The marker is
    // the validation stage's own wording in ToolExecutionPipeline; the contract
    // test in __tests__/executeVaultOp.test.ts fails if it ever moves.
    if (result.is_error === true && pipelineText.includes('Input validation failed:')) {
        text += `\n\n${JSON.stringify(schemaPayload(operation, tool.getDefinition()), null, 2)}`;
    }
    if (logParts.length > 0) {
        console.debug(`[MCP:execute_vault_op] ${operation}: ${logParts.join('; ')}`);
    }
    return {
        content: [{ type: 'text', text }],
        // A tool that only calls handleError leaves is_error unset, and an
        // error text must not travel as a success.
        isError: result.is_error === true || errorFallback,
    };
}

function extractPipelineText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((b) => typeof b === 'object' && b !== null && 'text' in b)
            .map((b) => (b as { text: string }).text)
            .join('\n');
    }
    return '';
}

/**
 * IMP-14-00-01: the registry knows an inputSchema for every tool; this is the
 * shape in which the MCP surface passes it on. `usage` exists because the
 * envelope is the second thing callers get wrong after the field names: the
 * object is called params, not args.
 */
function schemaPayload(
    operation: string,
    definition: ToolDefinition,
): Record<string, unknown> {
    return {
        operation,
        description: definition.description,
        params: definition.input_schema ?? { type: 'object', properties: {}, required: [] },
        usage: `execute_vault_op takes operation="${operation}" and passes these fields `
            + 'inside its "params" object.',
    };
}

function describeOperation(
    plugin: ObsidianAgentPlugin,
    params: Record<string, unknown>,
): McpToolResult {
    const target = typeof params.operation === 'string' ? params.operation.trim() : '';
    const available = (): string => plugin.toolRegistry
        .getAllTools()
        .map((t) => t.name)
        .filter((n) => !AGENT_INTERNAL_TOOLS.has(n))
        .sort()
        .join(', ');

    if (!target) {
        return errorResult(
            `${DESCRIBE_OPERATION} needs the operation to describe in params.operation. `
            + `Available operations: ${available()}`,
        );
    }
    if (AGENT_INTERNAL_TOOLS.has(target)) {
        return errorResult(`Operation "${target}" is agent-internal and not callable via MCP.`);
    }
    const tool = plugin.toolRegistry.getTool(target as ToolName);
    if (!tool) {
        return errorResult(`Unknown operation: "${target}". Available operations: ${available()}`);
    }
    return {
        content: [{
            type: 'text',
            text: JSON.stringify(schemaPayload(target, tool.getDefinition()), null, 2),
        }],
        isError: false,
    };
}

function errorResult(text: string): McpToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}
