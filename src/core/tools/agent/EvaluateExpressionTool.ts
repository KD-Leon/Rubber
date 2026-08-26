/**
 * EvaluateExpressionTool
 *
 * Executes a one-off JavaScript/TypeScript expression in the sandbox.
 * Useful for data transformations, regex testing, calculations, etc.
 * No persistent tool is created — just immediate execution.
 *
 * Part of Self-Development Phase 3: Sandbox + Dynamic Modules.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import type { ISandboxExecutor } from '../../sandbox/ISandboxExecutor';
import type { EsbuildWasmManager } from '../../sandbox/EsbuildWasmManager';
import { AstValidator } from '../../sandbox/AstValidator';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface EvaluateExpressionInput {
    expression: string;
    context?: Record<string, unknown>;
    dependencies?: string[];
}

/**
 * FIX-05-02-05: cap on the formatted return value. The result is pushed
 * 1:1 into the message history; without a cap, expressions returning file
 * contents (`return ctx.vault.read(path)`) pump arbitrarily large payloads
 * into the context until the 50k per-message truncation destroys the
 * agent's own earlier tool results. read_file has the equivalent guard at
 * MAX_CONTENT_CHARS with an offset-based continuation; here the correct
 * escape hatch is writing large data to the vault inside the expression.
 */
const MAX_RESULT_CHARS = 16_000;

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class EvaluateExpressionTool extends BaseTool<'evaluate_expression'> {
    readonly name = 'evaluate_expression' as const;
    readonly isWriteOperation = false;

    constructor(
        plugin: ObsidianAgentPlugin,
        private sandboxExecutor: ISandboxExecutor,
        private esbuildManager: EsbuildWasmManager,
    ) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: this.name,
            description: 'Execute TypeScript/JavaScript in an isolated sandbox. Provides ctx.vault (read, readBinary, write, writeBinary, list) and ctx.requestUrl (HTTPS CDN-only). No Blob, Buffer, DOM, require, fetch available. Binary output: ArrayBuffer/Uint8Array (outputType:"arraybuffer"). npm packages via dependencies param (browser ESM from esm.sh). NEVER write Python. Return values are capped at 16000 chars -- NOT a file reader: to read vault files use read_file; for large computed data write to a vault file (ctx.vault.write) and return a short summary.',
            input_schema: {
                type: 'object',
                properties: {
                    expression: {
                        type: 'string',
                        description: 'The TypeScript/JavaScript expression or code to evaluate. Must return a value. Use ctx.vault for file I/O and ctx.requestUrl for HTTP.',
                    },
                    context: {
                        type: 'object',
                        description: 'Optional context variables available as "ctx" inside the expression.',
                    },
                    dependencies: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional npm package names to bundle (e.g. ["xlsx", "marked"]). When provided, packages are fetched from CDN and bundled with esbuild.',
                    },
                },
                required: ['expression'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;
        const params = input as unknown as EvaluateExpressionInput;

        try {
            if (!params.expression) {
                throw new Error('Missing "expression".');
            }

            // AST validation (supplementary)
            const validation = AstValidator.validate(params.expression);
            if (!validation.valid) {
                throw new Error(`Expression validation failed:\n${validation.errors.join('\n')}`);
            }

            // Hoist import statements to module level (imports are invalid inside function bodies)
            const lines = params.expression.split('\n');
            const imports: string[] = [];
            const bodyLines: string[] = [];
            for (const line of lines) {
                // Match static imports (import X from 'y') but NOT dynamic import()
                if (/^\s*import\s+/.test(line) && !line.includes('import(')) {
                    imports.push(line);
                } else {
                    bodyLines.push(line);
                }
            }
            const bodyCode = bodyLines.join('\n');
            const hasReturn = bodyCode.includes('return');

            const wrappedSource = `
${imports.join('\n')}

export const definition = { name: '_eval', description: 'eval' };
export async function execute(input: Record<string, unknown>, ctx: { vault: any; requestUrl: any }): Promise<unknown> {
    const context = input.context || {};
    ${hasReturn ? bodyCode : `return (${bodyCode})`};
}
`;

            const compiledJs = (params.dependencies?.length)
                ? await this.esbuildManager.build(wrappedSource, params.dependencies)
                : await this.esbuildManager.transform(wrappedSource);
            // FIX-44-04 / FIX-44-43: the task travels with the execution so
            // sandbox vault writes are checkpointed under exactly this task,
            // even when another task's script overlaps on the shared sandbox.
            const result: unknown = await this.sandboxExecutor.execute(
                compiledJs,
                { context: params.context ?? {} },
                // FIX-24-08-04: abort the running script the moment Stop fires.
                { governanceTaskId: context.taskId, abortSignal: context.abortSignal },
            );

            // Issue #75: coerce every result to a string BEFORE the length
            // cap. `JSON.stringify(undefined)` returns the JS value undefined
            // (and it also returns undefined for functions/symbols, or throws
            // on circular refs / BigInt), so the old `output.length` check
            // dereferenced undefined and threw "Cannot read properties of
            // undefined (reading 'length')". That internal TypeError was pushed
            // as the tool result, so an expression that simply did not return a
            // value looked like a ctx.vault bridge failure. Fail soft instead.
            let output = serializeResult(result);

            if (output.length > MAX_RESULT_CHARS) {
                output = output.slice(0, MAX_RESULT_CHARS)
                    + `\n[Truncated: result was ${output.length} chars, cap is ${MAX_RESULT_CHARS}. `
                    + 'Do NOT page through data via repeated evaluate_expression returns. '
                    + 'To read a vault file use read_file (offset= continues a truncated read). '
                    + 'For large computed data, write it to a vault file inside the expression '
                    + '(ctx.vault.write) and return only a short summary plus the file path.]';
            }

            callbacks.pushToolResult(this.formatSuccess(output));
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
        }
    }
}

/**
 * Issue #75: turn any sandbox result into a string for the length cap and the
 * message history. Guarantees a string in every branch so `.length` can never
 * be read off `undefined`.
 *
 * - string          -> as-is
 * - undefined       -> a clear "did not return a value" hint (the common case:
 *                      a side-effect expression, or a try/catch whose `return`
 *                      sits only in the catch branch, both of which resolve to
 *                      undefined at the top level)
 * - function/symbol -> JSON.stringify returns undefined; fall back to String()
 * - circular/BigInt -> JSON.stringify throws; fall back to String()
 */
function serializeResult(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result === undefined) {
        return 'undefined -- the expression did not return a value. '
            + 'Add a `return`, or make the final line an expression '
            + '(e.g. `return await ctx.vault.read("path")`).';
    }
    let json: string | undefined;
    try {
        json = JSON.stringify(result, null, 2);
    } catch {
        json = undefined;
    }
    if (json !== undefined) return json;
    // Only four kinds of value get this far: JSON.stringify returns undefined
    // for functions and symbols, and throws on BigInt and on circular objects.
    // The first three describe themselves usefully through String(); the
    // circular object does not, and flattening it to "[object Object]" hands
    // the agent a string it cannot act on.
    if (typeof result === 'function' || typeof result === 'symbol' || typeof result === 'bigint') {
        return String(result);
    }
    return '[unserialisable object -- most likely a circular structure]';
}
