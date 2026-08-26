/**
 * ReadAgentLogsTool
 *
 * Allows the agent to read its own console output (debug/warn/error)
 * from the ConsoleRingBuffer. Supports filtering by level, time, and pattern.
 *
 * Part of Self-Development Phase 1: Foundation.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import type { ConsoleRingBuffer, LogLevel, LogQueryFilter } from '../../observability/ConsoleRingBuffer';
import { sanitizeErrorMessage } from '../../memory/MemoryV2Telemetry';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface ReadAgentLogsInput {
    level?: LogLevel;
    since?: string;
    pattern?: string;
    limit?: number;
    action?: 'query' | 'clear';
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class ReadAgentLogsTool extends BaseTool<'read_agent_logs'> {
    readonly name = 'read_agent_logs' as const;
    readonly isWriteOperation = false;

    private ringBuffer: ConsoleRingBuffer;

    constructor(plugin: ObsidianAgentPlugin, ringBuffer: ConsoleRingBuffer) {
        super(plugin);
        this.ringBuffer = ringBuffer;
    }

    getDefinition(): ToolDefinition {
        return {
            name: this.name,
            description: 'Read the agent\'s own console logs (debug, warn, error) from the ring buffer. Useful for diagnosing issues, understanding errors, and self-debugging. Supports filtering by level, time, and pattern.',
            input_schema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        description: 'Action to perform. "query" (default) reads logs, "clear" empties the buffer.',
                        enum: ['query', 'clear'],
                    },
                    level: {
                        type: 'string',
                        description: 'Filter by log level.',
                        enum: ['debug', 'warn', 'error'],
                    },
                    since: {
                        type: 'string',
                        description: 'Show logs since this time. Supports relative ("5m", "1h", "30s") or ISO timestamp.',
                    },
                    pattern: {
                        type: 'string',
                        description: 'Regex pattern to filter log messages.',
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum number of entries to return (default: 50).',
                    },
                },
            },
        };
    }

    execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;
        const params = input as unknown as ReadAgentLogsInput;

        try {
            if (params.action === 'clear') {
                this.ringBuffer.clear();
                callbacks.pushToolResult(this.formatSuccess('Log buffer cleared.'));
                return Promise.resolve();
            }

            const filter: LogQueryFilter = {
                level: params.level,
                limit: params.limit ?? 50,
            };

            if (params.since) {
                filter.since = this.parseSince(params.since);
            }
            if (params.pattern) {
                filter.pattern = params.pattern;
            }

            const entries = this.ringBuffer.query(filter);

            if (entries.length === 0) {
                callbacks.pushToolResult(this.formatSuccess('No log entries match the filter.'));
                return Promise.resolve();
            }

            // AUDIT 2026-07-14 L-3: the ring buffer captures every console.* call
            // process-wide, so a message may carry a secret or untrusted vault
            // content that was logged verbatim. Redact known secret shapes and
            // wrap the whole block in the untrusted-content boundary so the model
            // does not treat a logged line as an instruction.
            const lines = entries.map(e => {
                const time = new Date(e.timestamp).toISOString().slice(11, 23);
                const tool = e.correlatedTool ? ` [${e.correlatedTool}]` : '';
                return `[${time}] ${e.level.toUpperCase()}${tool}: ${sanitizeErrorMessage(e.message)}`;
            });

            const header = `${entries.length} log entries (buffer: ${this.ringBuffer.size} total):`;
            callbacks.pushToolResult(
                this.formatUntrustedContent('agent-logs', `${header}\n\n${lines.join('\n')}`),
            );
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
        }
        return Promise.resolve();
    }

    /**
     * Parse a `since` value: relative ("5m", "1h", "30s") or ISO timestamp.
     */
    private parseSince(since: string): number {
        const relativeMatch = since.match(/^(\d+)(s|m|h)$/);
        if (relativeMatch) {
            const value = parseInt(relativeMatch[1], 10);
            const unit = relativeMatch[2];
            const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
            return Date.now() - value * multiplier;
        }
        // Try ISO timestamp
        const ts = Date.parse(since);
        if (!isNaN(ts)) return ts;
        // Fallback: return 0 (all entries)
        return 0;
    }
}
