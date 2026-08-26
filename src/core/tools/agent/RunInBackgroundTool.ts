/**
 * RunInBackgroundTool (IMP-41-03-05).
 *
 * Spins off ONE read-only research task that runs alongside the foreground
 * chat instead of blocking it for minutes. The task uses the research
 * subagent profile (searches + reads only, no writes, no further
 * subagents); its report lands as a new conversation in the history and a
 * Notice announces completion. Approval-gated like new_task (subtask
 * group). Root tasks only — a background task cannot fork another one.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';

export class RunInBackgroundTool extends BaseTool<'run_in_background'> {
    readonly name = 'run_in_background' as const;
    readonly isWriteOperation = false;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'run_in_background',
            description:
                'Delegate a self-contained RESEARCH sub-question to a background task that runs '
                + 'alongside this conversation (read-only: vault search/read + web, no writes). '
                + 'Use for broad research that would block the chat for minutes. The result is '
                + 'saved as a separate conversation in the history. Only one background task can '
                + 'run at a time. Do NOT use for anything that must write files or that this '
                + 'conversation needs before its next step.',
            input_schema: {
                type: 'object',
                properties: {
                    message: {
                        type: 'string',
                        description: 'Complete, self-contained research instruction. The background task cannot ask follow-up questions.',
                    },
                    title: {
                        type: 'string',
                        description: 'Short human-readable title shown in the status tile and history (max 60 chars).',
                    },
                },
                required: ['message'],
            },
        };
    }

    // Body is fully synchronous (runner.start is sync); non-async with an
    // explicit resolved Promise satisfies the abstract signature without
    // tripping require-await.
    execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;
        const message = typeof input.message === 'string' ? input.message.trim() : '';
        if (!message) {
            callbacks.pushToolResult(this.formatError(new Error('message is required')));
            return Promise.resolve();
        }
        const title = (typeof input.title === 'string' && input.title.trim())
            ? input.title.trim().slice(0, 60)
            : message.slice(0, 60);

        const runner = this.plugin.backgroundTaskRunner;
        if (!runner) {
            callbacks.pushToolResult(this.formatError(
                new Error('Background tasks are not available (runner not initialized).'),
            ));
            return Promise.resolve();
        }

        const result = runner.start(message, title);
        if (!result.ok) {
            callbacks.pushToolResult(this.formatError(new Error(result.reason)));
            return Promise.resolve();
        }

        callbacks.pushToolResult(
            `Background research task started: "${title}" (${result.taskId}). `
            + 'It runs read-only alongside this conversation; the report will appear as a new '
            + 'conversation in the history when done. Continue with the parts of the task that '
            + 'do not depend on it.',
        );
        return Promise.resolve();
    }
}
