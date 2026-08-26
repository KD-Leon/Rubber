/**
 * sanitizeHistoryForApi - defensive history cleanup before sending to LLM
 *
 * BUG-017: Anthropic's API rejects requests where an assistant message
 * contains a `tool_use` block without a matching `tool_result` block in the
 * directly following user message. The same constraint applies to
 * Claude-via-Copilot. OpenAI is more lenient but a clean history is better.
 *
 * Orphans can enter the history through several paths:
 *   - Stream abort right after the assistant message was pushed but before
 *     tool execution finished.
 *   - Crash/reload mid-conversation, with a partially-saved transcript.
 *   - Resume of an older conversation that was already inconsistent.
 *   - Hard-limit recovery / emergency condensing edge cases.
 *
 * This helper removes orphaned tool_use / tool_result blocks immediately
 * before the history goes to the API. It is intentionally conservative: we
 * only drop blocks that would trigger a 400, never user text or assistant
 * commentary.
 *
 * Returns a NEW array. Input is not mutated.
 */

import type { MessageParam, ContentBlock } from '../../api/types';
import { truncateResultString } from '../agent/toolResultBudget';

interface SanitizeStats {
    droppedOrphanToolUses: number;
    droppedOrphanToolResults: number;
    droppedEmptyMessages: number;
    repairedEmptyMessages: number;
    /** FIX-24-03-05: oversized persisted tool_results capped at the wire. */
    truncatedOversizedResults: number;
}

/**
 * Loop-economy FIX C: a max_tokens truncation mid-reasoning can push an
 * assistant message with empty content into the history (Bedrock rejects
 * that with 400 "content field ... is empty"). Empty messages are REPAIRED
 * with a placeholder text block, never dropped — dropping would break the
 * strict role alternation Bedrock Converse requires.
 */
const EMPTY_REPAIR_TEXT =
    '[Response truncated: output-token limit reached during reasoning; no visible output was produced.]';

function isEmptyContent(content: MessageParam['content']): boolean {
    if (typeof content === 'string') return content.length === 0;
    return Array.isArray(content) && content.length === 0;
}

export function sanitizeHistoryForApi(
    history: readonly MessageParam[],
    opts?: {
        /**
         * FIX-24-03-05 / ADR-157 defence line 3: cap for a single persisted
         * tool_result string at the wire. A conversation poisoned by an
         * oversized result (persisted before the aggregate budget existed)
         * becomes sendable again on reload; the STORED history keeps full
         * fidelity -- this is wire-level only.
         */
        maxResultChars?: number;
    },
): { history: MessageParam[]; stats: SanitizeStats } {
    const stats: SanitizeStats = {
        droppedOrphanToolUses: 0,
        droppedOrphanToolResults: 0,
        droppedEmptyMessages: 0,
        repairedEmptyMessages: 0,
        truncatedOversizedResults: 0,
    };
    const maxResultChars = opts?.maxResultChars;

    // FIX-PERF-18: single forward pass collects both sides plus an
    // orphan-detection flag. Previously this ran three full walks
    // (resolved-ids, emitted-ids, rebuild). On clean histories the
    // rebuild was wasted work because nothing was orphan; the bail
    // below returns the input untouched when both sides line up.
    const resolvedToolUseIds = new Set<string>();
    const emittedToolUseIds = new Set<string>();
    let anyToolUse = false;
    let anyEmptyMessage = false;
    let anyOversized = false;
    for (const msg of history) {
        if (isEmptyContent(msg.content)) anyEmptyMessage = true;
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (msg.role === 'user' && block.type === 'tool_result'
                && typeof block.tool_use_id === 'string') {
                resolvedToolUseIds.add(block.tool_use_id);
                if (maxResultChars !== undefined
                    && typeof (block as { content?: unknown }).content === 'string'
                    && ((block as { content: string }).content).length > maxResultChars) {
                    anyOversized = true;
                }
            } else if (msg.role === 'assistant' && block.type === 'tool_use'
                && typeof block.id === 'string') {
                emittedToolUseIds.add(block.id);
                anyToolUse = true;
            }
        }
    }

    // Fast path: if no tool_use AND no tool_result ever appeared,
    // the history is trivially clean and we skip the rebuild. If
    // either side appeared we must verify pairing before bailing.
    // An empty message anywhere disables both bails — it must be
    // repaired in the rebuild pass regardless of tool pairing.
    if (!anyEmptyMessage && !anyOversized && !anyToolUse && resolvedToolUseIds.size === 0) {
        return { history: history.slice(), stats };
    }
    // Both sides exist - check if every emitted tool_use has a result
    // and every tool_result has an emitted tool_use. If so, bail.
    // An oversized result disables the bail: it must be capped in the
    // rebuild even when the pairing is perfectly clean.
    let isClean = !anyEmptyMessage && !anyOversized;
    for (const id of emittedToolUseIds) {
        if (!isClean) break;
        if (!resolvedToolUseIds.has(id)) { isClean = false; break; }
    }
    if (isClean) {
        for (const id of resolvedToolUseIds) {
            if (!emittedToolUseIds.has(id)) { isClean = false; break; }
        }
    }
    if (isClean) {
        return { history: history.slice(), stats };
    }

    // Pass 3: rebuild history, dropping orphan blocks.
    const out: MessageParam[] = [];
    for (const msg of history) {
        // Messages that ARRIVED empty are repaired, not dropped (dropping
        // would break Bedrock's strict role alternation).
        if (isEmptyContent(msg.content)) {
            stats.repairedEmptyMessages++;
            out.push({ ...msg, content: [{ type: 'text', text: EMPTY_REPAIR_TEXT }] });
            continue;
        }
        if (!Array.isArray(msg.content)) {
            // Plain string content — nothing to sanitize, keep as is.
            out.push(msg);
            continue;
        }

        const cleaned: ContentBlock[] = [];
        for (const block of msg.content) {
            if (msg.role === 'assistant' && block.type === 'tool_use') {
                if (typeof block.id !== 'string' || !resolvedToolUseIds.has(block.id)) {
                    stats.droppedOrphanToolUses++;
                    continue;
                }
            }
            if (msg.role === 'user' && block.type === 'tool_result') {
                if (typeof block.tool_use_id !== 'string' || !emittedToolUseIds.has(block.tool_use_id)) {
                    stats.droppedOrphanToolResults++;
                    continue;
                }
                const content = (block as { content?: unknown }).content;
                if (maxResultChars !== undefined && typeof content === 'string'
                    && content.length > maxResultChars) {
                    stats.truncatedOversizedResults++;
                    cleaned.push({
                        ...block,
                        content: truncateResultString(content, maxResultChars),
                    });
                    continue;
                }
            }
            cleaned.push(block);
        }

        // Drop messages that became empty after cleaning. An empty assistant
        // or user message would itself be a 400 ("content must be non-empty").
        if (cleaned.length === 0) {
            stats.droppedEmptyMessages++;
            continue;
        }
        out.push({ ...msg, content: cleaned });
    }

    return { history: out, stats };
}

/**
 * Convenience wrapper: sanitize and log if anything was dropped.
 * Use this at every API send-site in AgentTask.
 */
export function sanitizeAndLog(
    history: readonly MessageParam[],
    callsite: string,
    maxResultChars?: number,
): MessageParam[] {
    const { history: cleaned, stats } = sanitizeHistoryForApi(history, { maxResultChars });
    if (stats.droppedOrphanToolUses + stats.droppedOrphanToolResults
        + stats.droppedEmptyMessages + stats.repairedEmptyMessages
        + stats.truncatedOversizedResults > 0) {
        console.warn(
            `[AgentTask:${callsite}] Sanitized history: ` +
                `${stats.droppedOrphanToolUses} orphan tool_use, ` +
                `${stats.droppedOrphanToolResults} orphan tool_result, ` +
                `${stats.droppedEmptyMessages} empty messages dropped, ` +
                `${stats.repairedEmptyMessages} empty messages repaired, ` +
                `${stats.truncatedOversizedResults} oversized results capped`,
        );
    }
    return cleaned;
}
