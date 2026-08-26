/**
 * InvestigateTool -- FEAT-24-10 / ADR-159.
 *
 * Dedicated delegation tool: hands a research question to a read-only
 * subagent (vault + web, mid tier) whose big reads stay in ITS context;
 * only the answer plus source anchors (path + heading + offset) flows
 * back. "Delegate work, not data" -- the main conversation stays lean
 * (complements the ADR-157 overflow guardrail, does not replace it).
 *
 * Deliberately a thin wrapper over the existing subagent machinery:
 * context.spawnSubtask with the 'investigate' profile (ADR-113 profile
 * registry). No fork. Models under-delegate through generic spawn
 * tools; a dedicated tool with prescriptive triggers AND explicit
 * contraindications in its description is the fix (ADR-159 ASR-3).
 *
 * Wayfinder: src/ARCHITECTURE.map -> "investigate-delegation-tool".
 * Extend: adjust the profile in src/core/agent/subagent-profiles.ts.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';

/** Mirrors NewTaskTool: hard fallback when the setting is unmigrated. */
const DEFAULT_SUBTASK_TOKEN_BUDGET = 8000;

export class InvestigateTool extends BaseTool<'investigate'> {
    readonly name = 'investigate' as const;
    readonly isWriteOperation = false;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'investigate',
            description:
                'Delegate a research question to a focused read-only sub-agent (vault search, '
                + 'note reading, semantic search, web search + fetch). The heavy reads happen in '
                + 'the sub-agent\'s own context; you get back the answer plus source anchors '
                + '(path + heading + offset) and can re-read exact passages on demand. '
                + 'Use when answering needs 3+ reads or searches, a broad vault sweep, or web '
                + 'research whose sources you do not need verbatim -- it keeps THIS conversation '
                + 'lean and fast. '
                + 'Do NOT use when you need the verbatim text of a file (editing, quoting, the '
                + 'user asked for full content): call read_file directly instead. '
                + 'Follow up on anchors with read_file(path, offset) when exact wording matters.',
            input_schema: {
                type: 'object',
                properties: {
                    question: {
                        type: 'string',
                        description:
                            'The research question, self-contained: the sub-agent cannot see this '
                            + 'conversation. Include what to look for, where to prefer looking '
                            + '(vault vs web), and what the answer must contain.',
                    },
                },
                required: ['question'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;

        const question = typeof input.question === 'string' ? input.question.trim() : '';
        if (!question) {
            callbacks.pushToolResult(this.formatError(new Error(
                'investigate requires a non-empty `question`.',
            )));
            return;
        }

        if (context.mode !== 'agent') {
            callbacks.pushToolResult(
                'investigate is only available in Agent mode. '
                + 'Switch to Agent mode to delegate research.',
            );
            return;
        }

        // Same per-call budget as new_task: reject an already-overfull
        // question before a subagent even starts.
        const budget = this.plugin.settings.advancedApi?.subtaskTokenBudget ?? DEFAULT_SUBTASK_TOKEN_BUDGET;
        const estimatedTokens = Math.ceil(question.length / 4);
        if (estimatedTokens > budget) {
            callbacks.pushToolResult(this.formatError(new Error(
                `investigate question exceeds the per-call token budget: ${estimatedTokens} tokens > ${budget} budget. `
                + 'Shorten the question to what the sub-agent needs. '
                + 'The budget is configurable in Settings -> Advanced API -> subtaskTokenBudget.',
            )));
            return;
        }

        if (!context.spawnSubtask) {
            callbacks.pushToolResult(
                'Maximum sub-agent nesting depth reached. '
                + 'Investigate directly with your own read and search tools.',
            );
            return;
        }

        callbacks.log(`Investigating (profile=investigate): ${question.slice(0, 80)}…`);

        try {
            const result = await context.spawnSubtask('agent', question, 'investigate');
            // SEC-20260718-I1: the completion processed untrusted vault/web
            // content -- wrap it in the trust boundary (defangs smuggled
            // boundary tags); the header stays outside as trusted framing.
            callbacks.pushToolResult(
                '[Investigation complete]\n\n'
                + this.formatUntrustedContent(
                    'subagent',
                    result || '(No response from the investigation sub-agent)',
                    { profile: 'investigate' },
                ),
            );
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('investigate', error);
        }
    }
}
