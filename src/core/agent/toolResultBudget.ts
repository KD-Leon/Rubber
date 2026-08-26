/**
 * toolResultBudget -- aggregate size budget for one turn's tool results.
 *
 * FIX-24-03-05 / ADR-157 defence line 1: per-result caps exist (pipeline
 * 60k hard cap, read-aware ceiling ~404k), but nothing bounded the SUM of
 * all results pushed as one user message. Two parallel large reads could
 * produce ~808k chars in a single message and make every subsequent
 * provider request exceed the context window (issue #61).
 *
 * Pure module, no I/O, no API calls -- the happy path (batch fits) returns
 * the same block references untouched. Read results are shrunk with a
 * continue-offset hint pointing at the ORIGINAL vault file, never a tmp
 * preview (ADR-63 regression of 2026-04-29: replacing explicitly requested
 * content with a preview sends the agent into re-read loops).
 *
 * ADR: ADR-157. Extend: add tool names to READ_OFFSET_TOOLS when a new
 * tool returns wrapped vault content with its own offset pagination.
 */

import type { ContentBlock } from '../../api/types';

/**
 * Reserve subtracted from the window before budgeting: covers the system
 * prompt + tool schemas (not part of history estimation), estimator
 * tolerance, and response headroom. Proportional on small windows so an
 * 8k local model keeps a usable budget; capped for big windows.
 */
export const AGGREGATE_RESERVE_TOKENS_CAP = 30_000;
export const AGGREGATE_RESERVE_WINDOW_FRACTION = 0.15;

/** chars-per-token heuristic, consistent with READ_BUDGET_CHARS_PER_TOKEN. */
const CHARS_PER_TOKEN = 4;

/**
 * Flat token surcharge per non-string content block (images and other
 * multimodal blocks bypass string measurement entirely -- ADR-157 counts
 * them conservatively instead of ignoring them).
 */
export const MULTIMODAL_BLOCK_TOKEN_SURCHARGE = 1_600;

/**
 * A shrunk result never drops below this many chars: enough for the
 * wrapper head plus the hint, so the model always sees what the result
 * was and how to get the rest.
 */
export const MIN_RESULT_KEEP_CHARS = 2_000;

/** Tools whose results carry vault-original content with offset pagination. */
const READ_OFFSET_TOOLS = new Set(['read_file', 'read_document']);

export interface BudgetedResult {
    block: ContentBlock;
    toolName: string;
}

export interface BudgetOutcome {
    blocks: ContentBlock[];
    truncatedCount: number;
    totalCharsBefore: number;
    totalCharsAfter: number;
}

/** Remaining char budget for this turn's tool results. Never negative. */
export function computeAggregateBudgetChars(
    contextWindowTokens: number,
    estimatedHistoryTokens: number,
): number {
    const reserve = Math.min(
        AGGREGATE_RESERVE_TOKENS_CAP,
        Math.floor(contextWindowTokens * AGGREGATE_RESERVE_WINDOW_FRACTION),
    );
    const tokens = contextWindowTokens - estimatedHistoryTokens - reserve;
    return Math.max(0, tokens * CHARS_PER_TOKEN);
}

/** Size of one tool_result block in chars (multimodal blocks via surcharge). */
export function measureResultChars(block: ContentBlock): number {
    const content = (block as { content?: unknown }).content;
    if (typeof content === 'string') return content.length;
    if (Array.isArray(content)) {
        let sum = 0;
        for (const part of content as Array<{ type?: string; text?: string }>) {
            if (part && typeof part.text === 'string') sum += part.text.length;
            else sum += MULTIMODAL_BLOCK_TOKEN_SURCHARGE * CHARS_PER_TOKEN;
        }
        return sum;
    }
    return 0;
}

/**
 * Shrink a read_file/read_document result string to roughly keepChars,
 * closing the untrusted-content wrapper and appending a continue hint
 * with the next offset into the ORIGINAL file. Prior-offset hints
 * ("showing chars A-B of N") are honoured so paging composes.
 */
export function truncateReadResultWithOffsetHint(content: string, keepChars: number): string {
    const openTagEnd = content.indexOf('>');
    const contentStart = openTagEnd >= 0 ? openTagEnd + 1 : 0;

    const pathMatch = content.match(/<untrusted-content[^>]*\bpath="([^"]+)"/);
    const path = pathMatch?.[1] ?? '';

    // AUDIT 2026-07-18 L-2: the REAL hint sits at the END of the result
    // (appended after the closing wrapper tag); the note body may contain a
    // fake hint (plain text, not a boundary tag, so defang leaves it). Take
    // the LAST match so body fakes can never override the genuine offsets.
    const hintMatches = [...content.matchAll(/\[Truncated: showing chars (\d+)-(\d+) of (\d+)\./g)];
    const priorHint = hintMatches.length > 0 ? hintMatches[hintMatches.length - 1] : undefined;
    const priorStart = priorHint ? Number(priorHint[1]) : 0;
    const originalLength = priorHint ? Number(priorHint[3]) : undefined;

    const keepEnd = Math.max(contentStart, Math.min(keepChars, content.length));
    const keptFileChars = Math.max(0, keepEnd - contentStart - 1); // -1: leading newline after tag
    const nextOffset = priorStart + keptFileChars;

    const ofClause = originalLength !== undefined ? ` of ${originalLength}` : '';
    return content.slice(0, keepEnd)
        + '\n</untrusted-content>'
        + `\n[Aggregate context budget: result shortened at char ${nextOffset}${ofClause}. `
        + `Continue with read_file path="${path}" offset=${nextOffset} for the remainder.]`;
}

function truncateGeneric(content: string, keepChars: number, toolName: string): string {
    return content.slice(0, Math.max(0, keepChars))
        + `\n[Aggregate context budget: ${toolName} result shortened to fit the model's context window. `
        + 'Re-run the tool with a narrower scope if more is needed.]';
}

/**
 * Content-based truncation for a tool_result string whose tool name is
 * unknown (history/wire paths): vault-read results (recognised by their
 * untrusted-content wrapper) get the offset continue-hint into the
 * original file, everything else the generic notice.
 */
export function truncateResultString(content: string, keepChars: number): string {
    const isVaultRead = /<untrusted-content[^>]*\bsource="vault"/.test(content);
    return isVaultRead
        ? truncateReadResultWithOffsetHint(content, keepChars)
        : truncateGeneric(content, keepChars, 'tool');
}

function isShrinkable(entry: BudgetedResult): boolean {
    const block = entry.block as { content?: unknown; is_error?: boolean };
    return block.is_error !== true && typeof block.content === 'string';
}

/**
 * Enforce the aggregate budget over one batch. Within budget: the exact
 * same references come back (fast path, provably byte-identical). Over
 * budget: largest shrinkable blocks shrink first, never below
 * MIN_RESULT_KEEP_CHARS; error blocks and non-string content are never
 * touched. If everything is at the floor and the sum still exceeds the
 * budget, the pre-request gate (defence line 2) takes over downstream.
 */
/**
 * Defence line 2 last resort (pre-request gate): shrink the single
 * largest string tool_result anywhere in the history by roughly
 * excessChars, in place. Read-tool results (recognised by their vault
 * untrusted-content wrapper) get the offset continue-hint; everything
 * else the generic notice. Returns the chars actually freed (0 when
 * nothing shrinkable is large enough to matter).
 */
export function shrinkLargestHistoryToolResult(
    history: Array<{ role: string; content: unknown }>,
    excessChars: number,
): number {
    let bestMsg = -1;
    let bestIdx = -1;
    let bestSize = MIN_RESULT_KEEP_CHARS;
    for (let m = 0; m < history.length; m++) {
        const content = history[m].content;
        if (!Array.isArray(content)) continue;
        for (let i = 0; i < content.length; i++) {
            const block = content[i] as { type?: string; content?: unknown; is_error?: boolean };
            if (block.type !== 'tool_result' || block.is_error === true) continue;
            if (typeof block.content !== 'string') continue;
            if (block.content.length > bestSize) {
                bestSize = block.content.length;
                bestMsg = m;
                bestIdx = i;
            }
        }
    }
    if (bestMsg === -1) return 0;

    const blocks = history[bestMsg].content as Array<{ content?: unknown }>;
    const original = blocks[bestIdx].content as string;
    const keep = Math.max(MIN_RESULT_KEEP_CHARS, original.length - excessChars);
    if (keep >= original.length) return 0;
    const shrunk = truncateResultString(original, keep);
    blocks[bestIdx] = { ...(blocks[bestIdx] as object), content: shrunk };
    return original.length - shrunk.length;
}

export function applyAggregateBudget(results: BudgetedResult[], budgetChars: number): BudgetOutcome {
    const sizes = results.map((r) => measureResultChars(r.block));
    const totalBefore = sizes.reduce((a, b) => a + b, 0);
    if (totalBefore <= budgetChars) {
        return {
            blocks: results.map((r) => r.block),
            truncatedCount: 0,
            totalCharsBefore: totalBefore,
            totalCharsAfter: totalBefore,
        };
    }

    const out = results.map((r) => r.block);
    let total = totalBefore;
    let truncated = 0;

    // Deterministic AND provably terminating: each block shrinks at most
    // once (largest first). The appended hint text makes a re-shrink of a
    // floor-sized block a no-op that never reduces the total -- exactly the
    // infinite loop the first RED run of this module hung in. Bounded by
    // one pass over the candidates; if the sum still exceeds the budget
    // afterwards, the pre-request gate (defence line 2) takes over.
    const alreadyShrunk = new Set<number>();
    while (total > budgetChars) {
        let largestIdx = -1;
        let largestSize = MIN_RESULT_KEEP_CHARS;
        for (let i = 0; i < out.length; i++) {
            if (alreadyShrunk.has(i)) continue;
            if (!isShrinkable({ block: out[i], toolName: results[i].toolName })) continue;
            const size = measureResultChars(out[i]);
            if (size > largestSize) { largestSize = size; largestIdx = i; }
        }
        if (largestIdx === -1) break; // every candidate handled -- gate takes over

        const overshoot = total - budgetChars;
        const keep = Math.max(MIN_RESULT_KEEP_CHARS, largestSize - overshoot);
        const entry = results[largestIdx];
        const content = (out[largestIdx] as { content?: unknown }).content as string;
        const shrunk = READ_OFFSET_TOOLS.has(entry.toolName)
            ? truncateReadResultWithOffsetHint(content, keep)
            : truncateGeneric(content, keep, entry.toolName || 'tool');
        out[largestIdx] = { ...out[largestIdx], content: shrunk } as ContentBlock;
        alreadyShrunk.add(largestIdx);
        const newTotal = total - largestSize + measureResultChars(out[largestIdx]);
        if (newTotal >= total) break; // progress guard (belt and braces)
        total = newTotal;
        truncated++;
    }

    return {
        blocks: out,
        truncatedCount: truncated,
        totalCharsBefore: totalBefore,
        totalCharsAfter: total,
    };
}
