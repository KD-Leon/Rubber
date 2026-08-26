/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/unbound-method -- File-level disable: interacts with external SDK / JSON / Obsidian internals where untyped 'any' values are unavoidable. Inputs are validated at boundaries via type guards or schema checks where security-relevant. */
/**
 * ToolRepetitionDetector — loop guard with three responsibilities:
 *
 * 1. Exact repetition detection: blocks identical tool+input calls (3+ in window)
 * 2. Fuzzy search deduplication: blocks semantically similar search queries (3+ in window)
 * 3. Tool call ledger: structured log for context condensing preservation
 *
 * Returns recoverable errors (not fatal) — the agent can try a different approach.
 * The consecutiveMistakeLimit in AgentTask is the ultimate safety net.
 *
 * Adapted from Kilo Code's loop-detection pattern (03-refactoring-plan.md §2.1).
 */

const SEARCH_TOOLS = new Set(['search_files', 'semantic_search', 'search_by_tag', 'web_search']);

/**
 * FIX-COMPACT-01: outcome flag distinguishes successful vs failed tool calls.
 * The ledger renders failed entries under a dedicated "PREVIOUSLY FAILED"
 * section so the post-condense summarizer surfaces failures explicitly to
 * the agent (closing the "X klappt nicht, vergessen, X erneut" loop hole).
 * Defaults to 'success' for callers that don't pass the flag.
 */
export type ToolCallOutcome = 'success' | 'failed';

interface ToolCallEntry {
    tool: string;
    inputKey: string;
    queryTerms: Set<string>;
    resultSummary: string;
    iteration: number;
    outcome: ToolCallOutcome;
}

/**
 * FIX-COMPACT-04: mode-switch annotations interleaved with tool calls.
 * Stored separately from `allCalls` so they don't pollute `getToolSequence()`
 * (only real tool invocations belong there), but the ledger renders them
 * inline so the summarizer can see when the agent flipped modes.
 */
interface ModeSwitchEntry {
    kind: 'mode-switch';
    newMode: string;
    after: number; // index into allCalls AT the time of the switch
}

export interface RepetitionCheck {
    blocked: boolean;
    reason?: string;
}

export class ToolRepetitionDetector {
    /** All recorded calls (for ledger). Grows unbounded but capped by maxIterations (~25). */
    private allCalls: ToolCallEntry[] = [];
    /** Sliding window for repetition detection. */
    private recentKeys: string[] = [];
    /** FIX-COMPACT-04: chronological mode-switch annotations. */
    private modeSwitches: ModeSwitchEntry[] = [];
    private readonly windowSize = 15;
    private readonly maxExactRepetitions = 3;
    private readonly maxSimilarSearches = 3;
    private readonly similarityThreshold = 0.5;

    /**
     * Check BEFORE tool execution whether this call should be blocked.
     * Does NOT record the call — call record() after successful execution.
     */
    check(toolName: string, input: Record<string, unknown>): RepetitionCheck {
        const key = `${toolName}:${JSON.stringify(input)}`;

        // 1. Exact repetition: count identical calls in the sliding window
        const exactCount = this.recentKeys.filter((k) => k === key).length;
        if (exactCount >= this.maxExactRepetitions) {
            return {
                blocked: true,
                reason: `Tool loop detected: "${toolName}" was called with identical input `
                    + `${this.maxExactRepetitions} times. Use the results you already have `
                    + `or try a completely different approach.`,
            };
        }

        // 2. Fuzzy search dedup: only for search tools
        if (SEARCH_TOOLS.has(toolName)) {
            const raw = input.query ?? input.pattern ?? '';
            const queryText = (typeof raw === 'string' ? raw : '').toLowerCase();
            const queryTerms = new Set(queryText.split(/\s+/).filter((t) => t.length > 2));

            if (queryTerms.size > 0) {
                let similarCount = 0;
                for (const prev of this.allCalls) {
                    if (!SEARCH_TOOLS.has(prev.tool)) continue;
                    if (prev.queryTerms.size === 0) continue;
                    if (this.jaccard(queryTerms, prev.queryTerms) >= this.similarityThreshold) {
                        similarCount++;
                    }
                }
                if (similarCount >= this.maxSimilarSearches) {
                    return {
                        blocked: true,
                        reason: `Repetitive search detected: you have already performed ${similarCount} `
                            + `similar searches for this topic. Use the results you have, or deliver `
                            + `your answer with current information.`,
                    };
                }
            }
        }

        return { blocked: false };
    }

    /**
     * Record a completed tool call. Called AFTER successful execution.
     * Feeds both the sliding window (for detection) and the ledger (for condensing).
     */
    record(
        toolName: string,
        input: Record<string, unknown>,
        resultSummary: string,
        iteration: number,
        outcome: ToolCallOutcome = 'success',
    ): void {
        const key = `${toolName}:${JSON.stringify(input)}`;
        const rawQ = input.query ?? input.pattern ?? '';
        const queryText = SEARCH_TOOLS.has(toolName)
            ? (typeof rawQ === 'string' ? rawQ : '').toLowerCase()
            : '';
        const queryTerms = new Set(queryText.split(/\s+/).filter((t) => t.length > 2));

        this.allCalls.push({ tool: toolName, inputKey: key, queryTerms, resultSummary, iteration, outcome });

        // Sliding window for exact-match detection. Failed calls also feed
        // the window so an agent that keeps retrying the same broken call
        // gets blocked the same way as a redundant successful one.
        this.recentKeys.push(key);
        if (this.recentKeys.length > this.windowSize) {
            this.recentKeys.shift();
        }
    }

    /**
     * Record a FastPath / planner-driven tool dispatch for episodic memory
     * ONLY (FEAT-32-02 PR 2.2 / ADR-133). Appends to `allCalls` so the call
     * shows up in `getToolSequence()` and `getLedger()`, but does NOT push to
     * `recentKeys` -- FastPath batches are deterministic and must not trip
     * the exact-repetition sliding window for subsequent loop calls. Pairs
     * with `FastPathExecutor.onToolRecorded`.
     */
    recordForEpisodeOnly(
        toolName: string,
        input: Record<string, unknown>,
        resultSummary: string,
        iteration: number,
    ): void {
        const key = `${toolName}:${JSON.stringify(input)}`;
        const rawQ = input.query ?? input.pattern ?? '';
        const queryText = SEARCH_TOOLS.has(toolName)
            ? (typeof rawQ === 'string' ? rawQ : '').toLowerCase()
            : '';
        const queryTerms = new Set(queryText.split(/\s+/).filter((t) => t.length > 2));
        this.allCalls.push({ tool: toolName, inputKey: key, queryTerms, resultSummary, iteration, outcome: 'success' });
        // Deliberately skip `recentKeys.push(key)` -- FastPath batches must
        // not feed the exact-repetition sliding window (ADR-133 rationale).
    }

    /**
     * FIX-COMPACT-04: annotate a mode switch in the ledger without
     * wiping the recorded calls or the sliding window. AgentTask used to
     * call reset() on every switch, which let Code -> Architect -> Code
     * loops bypass the exact-repetition block and the "already failed"
     * surface in the summarizer prompt.
     */
    markModeSwitch(newMode: string): void {
        this.modeSwitches.push({
            kind: 'mode-switch',
            newMode,
            after: this.allCalls.length,
        });
    }

    /**
     * Structured tool-call ledger for injection into condensing prompt.
     * Returns empty string if no calls AND no mode switches recorded.
     *
     * FIX-COMPACT-01: failed calls are rendered in a dedicated section so
     * the post-condense agent surfaces them explicitly instead of letting
     * the summarizer paraphrase them away.
     * FIX-COMPACT-04: mode switches are rendered as their own section.
     */
    getLedger(): string {
        if (this.allCalls.length === 0 && this.modeSwitches.length === 0) return '';
        const render = (entry: ToolCallEntry, idx: number): string => {
            let parsed: Record<string, unknown>;
            try { parsed = JSON.parse(entry.inputKey.slice(entry.tool.length + 1)); } catch { parsed = {}; }
            const params = Object.entries(parsed)
                .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
                .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                .join(', ');
            return `${idx + 1}. [iter ${entry.iteration}] ${entry.tool}(${params}) => ${entry.resultSummary}`;
        };
        const successes = this.allCalls.filter((c) => c.outcome === 'success');
        const failures = this.allCalls.filter((c) => c.outcome === 'failed');
        const sections: string[] = [];
        if (successes.length > 0) {
            sections.push(
                'Tool calls executed so far (DO NOT repeat these):\n'
                + successes.map(render).join('\n'),
            );
        }
        if (failures.length > 0) {
            sections.push(
                'PREVIOUSLY FAILED TOOL CALLS (do not retry with same args; change approach instead):\n'
                + failures.map(render).join('\n'),
            );
        }
        if (this.modeSwitches.length > 0) {
            const lines = this.modeSwitches.map((m, i) =>
                `${i + 1}. mode switch -> ${m.newMode} (after ${m.after} tool call(s))`,
            );
            sections.push('MODE SWITCHES during this run:\n' + lines.join('\n'));
        }
        return sections.join('\n\n');
    }

    /** Jaccard similarity coefficient on two word sets. */
    private jaccard(a: Set<string>, b: Set<string>): number {
        let intersection = 0;
        for (const term of a) {
            if (b.has(term)) intersection++;
        }
        const union = a.size + b.size - intersection;
        return union === 0 ? 0 : intersection / union;
    }

    /**
     * Ordered list of tool names called so far (for episodic memory).
     */
    getToolSequence(): string[] {
        return this.allCalls.map((c) => c.tool);
    }

    reset(): void {
        this.allCalls = [];
        this.recentKeys = [];
        this.modeSwitches = [];
    }
}

/* eslint-enable -- end of file-level disable for boundary code (SDK/JSON/Obsidian internals) */
