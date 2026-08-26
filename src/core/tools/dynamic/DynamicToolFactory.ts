/**
 * DynamicToolFactory
 *
 * Creates BaseTool subclass instances from dynamic tool definitions.
 * Each dynamic tool runs in the ISandboxExecutor (process or iframe sandbox).
 *
 * Part of Self-Development Phase 3: Sandbox + Dynamic Modules.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolName, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import type { ISandboxExecutor } from '../../sandbox/ISandboxExecutor';
import type { DynamicToolDefinition } from './types';

// ---------------------------------------------------------------------------
// DynamicTool
// ---------------------------------------------------------------------------

class DynamicTool extends BaseTool {
    readonly name: ToolName;
    readonly isWriteOperation: boolean;

    constructor(
        private definition: DynamicToolDefinition,
        private compiledJs: string,
        private sandboxExecutor: ISandboxExecutor,
        plugin: ObsidianAgentPlugin,
    ) {
        super(plugin);
        this.name = definition.name as ToolName;
        // ADR-153: this self-report from the skill's source now only drives
        // checkpoints and cache. It is irrelevant for approval: every custom_*
        // tool runs sandboxed code with a vault.write bridge and is pinned to
        // 'sandbox' in toolEffects.ts. Before, a skill dropped into the vault
        // could declare `false` here (or omit the field) and thereby get a tool
        // with no approval gate at all.
        this.isWriteOperation = definition.isWriteOperation ?? false;
    }

    getDefinition(): ToolDefinition {
        return {
            name: this.name,
            description: this.definition.description,
            input_schema: this.definition.input_schema,
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;
        try {
            // FIX-44-45: bind the governance task for this execution, exactly
            // like evaluate_expression / run_skill_script (FIX-44-04/44-43).
            // Without it, SandboxBridge.snapshotBeforeWrite no-ops and vault
            // writes from custom_* skill tools are unrecoverable via
            // restore_checkpoint.
            const result = await this.sandboxExecutor.execute(this.compiledJs, input, {
                governanceTaskId: context.taskId,
                // FIX-24-08-04: abort the running script the moment Stop fires.
                abortSignal: context.abortSignal,
            });
            const output = typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2);
            callbacks.pushToolResult(this.formatSuccess(output));
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
        }
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export class DynamicToolFactory {
    static create(
        definition: DynamicToolDefinition,
        compiledJs: string,
        sandboxExecutor: ISandboxExecutor,
        plugin: ObsidianAgentPlugin,
    ): BaseTool {
        return new DynamicTool(definition, compiledJs, sandboxExecutor, plugin);
    }
}
