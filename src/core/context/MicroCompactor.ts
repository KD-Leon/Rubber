/**
 * MicroCompactor — ADR-12 Amendment (EPIC-24 / FEAT-24-02): Microcompaction
 *
 * Prunes the *contents* of old `tool_result` blocks down to a skeleton
 * (a short teaser + a re-read pointer), leaving the `tool_use` / `tool_result`
 * skeleton (IDs, tool name, pairing) intact. Runs at turn boundaries — additive
 * to the Keep-First-Last full condensing in AgentTask (ADR-12), which stays as
 * the ~70%-context-window safety net.
 *
 * Why: `read_file` is capped at 50000 chars/file, but four reads in one turn are
 * ~31k tokens; without pruning they ride along in every following turn and the
 * history grows monotonically (RESEARCH-36 Befund C). The full condensing
 * triggers far too late. Microcompaction keeps the verbatim result in the turn
 * that uses it and eats it down to a skeleton afterwards.
 *
 * What is NEVER touched:
 * - the first user message (the original task)
 * - assistant text and `tool_use` blocks (only `tool_result` *content* is pruned)
 * - the most recent `keepRecentMessages` messages (the active working set)
 * - `tool_result` blocks whose content is already small or already a skeleton
 *
 * KV-cache note (revised, FIX-COMPACT-09): pruning rewrites history BEFORE the
 * stable rolling cache breakpoint and invalidates the provider prompt-cache
 * prefix from the first changed message onward. The original ADR-12 amendment
 * accepted this on the assumption that the saved re-send cost far exceeds the
 * cache re-build; live traces showed the opposite for small frees (~260 tokens
 * freed vs 30k+ tokens cache re-write per turn). Callers must therefore gate
 * pruning through `shouldDeferMicrocompact` (probe with `dryRun` first): only
 * prune when the free is large or the context is under real pressure.
 */

import type { ContentBlock, MessageParam, ToolResultContentBlock } from '../../api/types';
import type { FileDossier } from './FileDossier';

/** Marker that identifies an already-pruned `tool_result` content string. */
export const PRUNED_MARKER = '[context-pruned]';

/** Tools whose pruned results represent a WRITE to the path (dossier marker). */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_to_file', 'create_base', 'update_base']);

export interface MicrocompactOptions {
    /**
     * Messages at the tail of the history that are never pruned (the active
     * working set). Default 6 — roughly the last two or three turns.
     */
    keepRecentMessages?: number;
    /**
     * Only prune a `tool_result` whose content exceeds this many characters.
     * Smaller results are cheap to keep and pruning them adds churn. Default 1500.
     */
    minPruneChars?: number;
    /**
     * Keep a short verbatim teaser of this many characters at the head of the
     * skeleton so the agent still has a hint of what was there. Default 240.
     */
    teaserChars?: number;
    /**
     * IMP-41-03-06: when set, every pruned path-bearing tool_result feeds a
     * dossier entry (path + teaser + read/write kind). Pruning is exactly
     * the moment verbatim content leaves the context, so the dossier is the
     * durable per-file memory the flat condense summary lacks.
     */
    dossier?: FileDossier;
    /**
     * FIX-COMPACT-09: count what a real run would prune without mutating the
     * history or feeding the dossier. Used to probe the freed volume before
     * deciding whether the prune is worth a prompt-cache rebuild.
     */
    dryRun?: boolean;
}

export interface MicrocompactResult {
    /** Number of `tool_result` blocks whose content was replaced with a skeleton. */
    prunedBlocks: number;
    /** Approximate characters removed from the history (sum of original lengths minus skeletons). */
    freedCharsApprox: number;
}

/** Length in characters of a `tool_result` block's content (string or multimodal array). */
function toolResultContentLength(content: string | ToolResultContentBlock[]): number {
    if (typeof content === 'string') return content.length;
    let n = 0;
    for (const b of content) {
        if (b.type === 'text') n += b.text.length;
        else if (b.type === 'image') n += 2000; // images aren't pruned; count them so we don't churn over them
    }
    return n;
}

/** Best-effort extraction of a path-like argument from a tool_use input, for the re-read pointer. */
function pathHint(input: Record<string, unknown> | undefined): string | undefined {
    if (!input) return undefined;
    for (const key of ['path', 'file_path', 'filepath', 'notePath', 'file']) {
        const v = input[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
}

/** Short, single-line rendering of a tool_use input for the skeleton header. */
function shortInput(input: Record<string, unknown> | undefined): string {
    if (!input) return '';
    try {
        const s = JSON.stringify(input);
        return s.length > 120 ? s.slice(0, 117) + '...' : s;
    } catch {
        return '';
    }
}

/** First `n` characters of a tool_result content, collapsed to one line. */
function teaser(content: string | ToolResultContentBlock[], n: number): string {
    let text: string;
    if (typeof content === 'string') text = content;
    else text = content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join(' ');
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
}

/** True when this content is already a skeleton produced by a previous run (idempotency). */
function isAlreadyPruned(content: string | ToolResultContentBlock[]): boolean {
    if (typeof content === 'string') return content.startsWith(PRUNED_MARKER);
    return content.length === 1 && content[0].type === 'text' && content[0].text.startsWith(PRUNED_MARKER);
}

/** Input for the FIX-COMPACT-09 economy decision. */
export interface MicrocompactGuardInput {
    /** Estimated history tokens divided by the model context window (0..1). */
    pressure: number;
    /** Tokens a prune would free, measured via a `dryRun` probe. */
    wouldFreeTokens: number;
    /**
     * At/above this pressure the context is under real pressure and a prune runs
     * regardless of cache cost (make room before full condensing). Below it, the
     * economy guard applies at ANY pressure (fraction of the window).
     */
    pressureCeiling: number;
    /** Frees below this token count never justify a prompt-cache rebuild. */
    minFreedTokens: number;
    /**
     * IMP-01-04-03: while free headroom (1 - pressure) exceeds this fraction,
     * never prune -- there is no context-pressure reason to, and pruning a
     * just-read result only forces a re-read. Above `pressureCeiling` this is
     * irrelevant (real pressure prunes); between the two the economy floor
     * applies.
     */
    minHeadroomFraction: number;
}

/**
 * FIX-COMPACT-09 (extended 2026-07-05): a prune rewrites history before the
 * stable cache breakpoint, so it costs one full prompt-cache prefix re-write.
 *
 * - At/above `pressureCeiling`: never defer. The context is close to the full
 *   condense threshold; pruning frees room and is worth the cache cost.
 * - Below the ceiling (at ANY pressure): defer while the freed volume is too
 *   small to amortize the cache rebuild. The original guard only evaluated this
 *   below a 0.60 floor, so the 0.60..ceiling band pruned every turn and busted
 *   the cache exactly where the rebuild is most expensive. Deferred candidates
 *   accumulate until one batch prune clears the min-freed bar or pressure rises.
 */
export function shouldDeferMicrocompact(g: MicrocompactGuardInput): boolean {
    // Band 3: real pressure -> prune to make room before full condensing.
    if (g.pressure >= g.pressureCeiling) return false;
    // Band 1: plenty of free headroom -> never prune (IMP-01-04-03). Pruning a
    // just-read result here only forces a re-read; there is no pressure reason.
    if (1 - g.pressure > g.minHeadroomFraction) return true;
    // Band 2: filling up but below the ceiling -> FIX-COMPACT-09 economy floor.
    return g.wouldFreeTokens < g.minFreedTokens;
}

/**
 * Prune old `tool_result` contents in-place. Returns counts for logging.
 * Safe to call repeatedly — already-pruned blocks are skipped (idempotent).
 */
export function microcompactToolResults(history: MessageParam[], opts: MicrocompactOptions = {}): MicrocompactResult {
    const keepRecent = Math.max(2, opts.keepRecentMessages ?? 6);
    const minPruneChars = Math.max(200, opts.minPruneChars ?? 1500);
    const teaserChars = Math.max(0, opts.teaserChars ?? 240);

    const result: MicrocompactResult = { prunedBlocks: 0, freedCharsApprox: 0 };
    if (history.length <= keepRecent + 1) return result;

    // Map tool_use_id -> { name, input } so a tool_result skeleton can name its tool.
    const toolUseById = new Map<string, { name: string; input?: Record<string, unknown> }>();
    for (const msg of history) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
            if (block.type === 'tool_use') {
                toolUseById.set(block.id, { name: block.name, input: block.input });
            }
        }
    }

    // Prune everything before the protected tail, but never index 0 (the original task).
    const protectFrom = history.length - keepRecent;
    for (let i = 1; i < protectFrom; i++) {
        const msg = history[i];
        if (!Array.isArray(msg.content)) continue;
        let changed = false;
        const newContent: ContentBlock[] = msg.content.map((block) => {
            if (block.type !== 'tool_result') return block;
            if (block.is_error) return block; // keep error results — they're short and informative
            if (isAlreadyPruned(block.content)) return block;
            const len = toolResultContentLength(block.content);
            if (len <= minPruneChars) return block;

            const meta = toolUseById.get(block.tool_use_id);
            const toolName = meta?.name ?? 'tool';
            const hint = pathHint(meta?.input);
            const inputStr = shortInput(meta?.input);
            const head = teaserChars > 0 ? ` Starts: "${teaser(block.content, teaserChars)}"` : '';

            const pointer = hint
                ? ` Re-read with read_file path=${hint} (or re-run ${toolName}) if you need it again.`
                : ` Re-run ${toolName}${inputStr ? ` with input ${inputStr}` : ''} if you need it again.`;
            const skeleton = `${PRUNED_MARKER} ${toolName} result (${len} chars) was used in an earlier turn and dropped from context to save space.${head}${pointer}`;

            result.prunedBlocks++;
            result.freedCharsApprox += len - skeleton.length;

            // FIX-COMPACT-09: probe mode — count, but leave everything untouched
            // (no mutation, no dossier feed).
            if (opts.dryRun) return block;

            // IMP-41-03-06: dossier entry BEFORE the verbatim content is gone.
            if (opts.dossier && hint) {
                opts.dossier.record(hint, {
                    detail: teaser(block.content, 180),
                    kind: WRITE_TOOLS.has(toolName) ? 'write' : 'read',
                });
            }
            changed = true;
            return { type: 'tool_result', tool_use_id: block.tool_use_id, content: skeleton, is_error: block.is_error };
        });
        if (changed) msg.content = newContent;
    }

    return result;
}
