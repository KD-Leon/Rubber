/**
 * TaskTelemetry -- Per-task token, cost, and tool-sequence logger (ADR-090, Lever 10)
 *
 * Records what the agent did for each task: prompt, iterations, tools used,
 * tokens consumed, EUR cost, outcome. Persists to a single JSON-lines file
 * so we can compare before/after when iterating on prompt heuristics.
 *
 * Storage: <agent data dir>/telemetry/{tasks,condense,requests}.jsonl
 * (FEAT-24-11). The caller passes the directory; without one the legacy
 * <vault>/.obsidian-agent/telemetry location is used so old readers and the
 * existing tests keep working. readRecent() merges the legacy file once so
 * the move loses no history.
 * Append-only. tasks.jsonl and condense.jsonl truncate to the last N entries
 * on each write; requests.jsonl is appended per request (cheap) and trimmed
 * once per task by the caller.
 */

import { computeCost, computeCostForBuckets, formatEur, type UsageByModel } from '../pricing/ModelPricing';
import type { FileAdapter } from '../storage/types';

/** Pre-FEAT-24-11 location, kept as the default and read once on the move. */
export const LEGACY_TELEMETRY_DIR = '.obsidian-agent/telemetry';
const TASKS_FILE = 'tasks.jsonl';
const CONDENSE_FILE = 'condense.jsonl';
const REQUESTS_FILE = 'requests.jsonl';
const MAX_ENTRIES = 1000;
const MAX_CONDENSE_ENTRIES = 2000;
/**
 * ~100 requests per long task, a handful of tasks a day: 20k lines is about a
 * month of history at ~300 bytes a line (6 MB). Trimmed once per task end.
 */
export const MAX_REQUEST_ENTRIES = 20_000;

export interface TaskTelemetryOptions {
    /** Directory (adapter-relative) holding the three JSONL files. */
    dir?: string;
}

/**
 * FIX-COMPACT-07: persistable shape of a single condense pass.
 * Mirrors AgentTask.CondenseTelemetryEvent. Kept in this module to
 * avoid a dependency loop with AgentTask.
 */
export interface CondenseTelemetryEntry {
    startedAt: string;
    durationMs: number;
    success: boolean;
    prevTokens: number;
    newTokens: number;
    savedTokens: number;
    helperModelUsed: boolean;
    modelId: string;
    maxTailTokens: number;
    errorMessage?: string;
}

/**
 * FEAT-24-11: one API request of the agent loop. The cache numbers are this
 * request's own (not cumulative), and the context columns say what could have
 * moved the cached prefix in that turn: the hashes of the stable and volatile
 * system-prompt parts, how many tool_result blocks were pruned, whether a
 * condense ran, whether steering text was injected. Together they let a
 * report attribute cache writes to a cause instead of guessing.
 */
export interface RequestTelemetryEntry {
    /** ISO timestamp when the request was issued */
    at: string;
    taskId: string;
    /** 0-based main-loop iteration */
    iteration: number;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** Messages in the history sent with this request */
    historyMessages: number;
    /** Tool schemas sent with this request */
    toolsSent: number;
    /** tool_result blocks microcompaction pruned since the previous request */
    prunedBlocksThisTurn: number;
    /** A condense (rolling summary or full) ran since the previous request */
    condensedThisTurn: boolean;
    /** The preamble appended messages (steering text or the soft-limit nudge) before this request */
    steeringInjected: boolean;
    /** Hash of the system prompt above the cache breakpoint */
    stableSystemHash: string;
    /** Hash of the system prompt below the cache breakpoint */
    volatileTailHash: string;
}

/**
 * Cheap, stable 32-bit FNV-1a hash as 8 hex chars. Not cryptographic; it only
 * has to say "this text is the same as last turn" in a log line.
 */
export function hashForTelemetry(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

export async function readRecentCondense(
    fs: FileAdapter,
    n: number = 200,
    dir: string = LEGACY_TELEMETRY_DIR,
): Promise<CondenseTelemetryEntry[]> {
    return readJsonLines<CondenseTelemetryEntry>(fs, `${dir}/${CONDENSE_FILE}`, n);
}

export interface TaskTelemetryEntry {
    /** ISO timestamp when the task started */
    startedAt: string;
    /** Wall-clock duration in milliseconds */
    durationMs: number;
    /** First 200 chars of the user message (privacy: full message stays in the chat) */
    promptPreview: string;
    /** Model id used */
    modelId: string;
    /** Mode the task ran in (ask, agent, ...) */
    mode: string;
    /** Iterations of the main ReAct loop */
    iterations: number;
    /** Ordered list of tool names called (with sub-agent calls flattened) */
    toolSequence: string[];
    /** Number of sub-agents spawned */
    subAgentCount: number;
    /** Token usage (totals across all iterations + sub-agents) */
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /**
     * FIX-24-05-05: per-model breakdown of the totals. Present when the
     * task reported one; cost is then the sum of per-model costs.
     */
    usageByModel?: UsageByModel;
    /** Cost in USD and EUR */
    costUsd: number;
    costEur: number;
    /** "completed" | "aborted" | "error" */
    outcome: 'completed' | 'aborted' | 'error';
    /** Optional error message if outcome=error */
    errorMessage?: string;
}

async function readJsonLines<T>(fs: FileAdapter, file: string, n: number): Promise<T[]> {
    if (!(await fs.exists(file))) return [];
    const raw = await fs.read(file);
    const lines = raw.split('\n').filter(Boolean).slice(-n);
    const entries: T[] = [];
    for (const line of lines) {
        try { entries.push(JSON.parse(line) as T); } catch { /* skip corrupt line */ }
    }
    return entries;
}

export class TaskTelemetry {
    private fs: FileAdapter;
    private readonly dir: string;
    private startedAt = Date.now();
    private toolSequence: string[] = [];
    private subAgentCount = 0;
    private iterations = 0;

    constructor(fs: FileAdapter, opts: TaskTelemetryOptions = {}) {
        this.fs = fs;
        this.dir = opts.dir ?? LEGACY_TELEMETRY_DIR;
    }

    /** Call once per main-loop iteration (after the LLM responds). */
    bumpIteration(): void { this.iterations++; }

    /** Record a tool call. Sub-agent calls log "new_task[:childTool1,childTool2]". */
    recordTool(toolName: string): void {
        this.toolSequence.push(toolName);
        if (toolName === 'new_task') this.subAgentCount++;
    }

    /**
     * Record a complete task at end of run. Best-effort persistence.
     *
     * FEAT-24-11: the caller may pass iterations/toolSequence/startedAt.
     * TaskMonitor constructs this object at persist time, so the instance
     * fields (bumpIteration/recordTool) are empty there and every record
     * read "iterations 0, toolSequence [], 0 ms" -- the caller's numbers win
     * whenever they are given.
     */
    async record(args: {
        promptPreview: string;
        modelId: string;
        mode: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        outcome: 'completed' | 'aborted' | 'error';
        errorMessage?: string;
        usageByModel?: UsageByModel;
        iterations?: number;
        toolSequence?: string[];
        /** Epoch ms when the task started; defaults to construction time. */
        startedAt?: number;
    }): Promise<TaskTelemetryEntry> {
        // FIX-24-05-05: mixed-model tasks are priced as the sum of
        // per-model costs; without a breakdown fall back to single-id.
        const cost = (args.usageByModel && Object.keys(args.usageByModel).length > 0)
            ? computeCostForBuckets(args.usageByModel)
            : computeCost(args.modelId, args.inputTokens, args.outputTokens, args.cacheReadTokens, args.cacheCreationTokens);
        const startedAt = args.startedAt ?? this.startedAt;
        const toolSequence = args.toolSequence ?? this.toolSequence;
        const subAgentCount = args.toolSequence
            ? args.toolSequence.filter((t) => t === 'new_task').length
            : this.subAgentCount;
        const entry: TaskTelemetryEntry = {
            startedAt: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            promptPreview: args.promptPreview.slice(0, 200),
            modelId: args.modelId,
            mode: args.mode,
            iterations: args.iterations ?? this.iterations,
            toolSequence,
            subAgentCount,
            inputTokens: args.inputTokens,
            outputTokens: args.outputTokens,
            cacheReadTokens: args.cacheReadTokens,
            cacheCreationTokens: args.cacheCreationTokens,
            usageByModel: args.usageByModel,
            costUsd: cost.totalUsd,
            costEur: cost.totalEur,
            outcome: args.outcome,
            errorMessage: args.errorMessage,
        };

        try {
            await this.appendBounded(TASKS_FILE, entry, MAX_ENTRIES);
        } catch (e) {
            console.warn('[TaskTelemetry] persist failed (non-fatal):', e);
        }
        return entry;
    }

    /**
     * FIX-COMPACT-07: persist a per-condense event. Bounded JSONL at
     * <dir>/condense.jsonl. Best-effort, never throws. Datapoints for tuning
     * the threshold and helper-model selection over time.
     */
    async recordCondense(event: CondenseTelemetryEntry): Promise<void> {
        try {
            await this.appendBounded(CONDENSE_FILE, event, MAX_CONDENSE_ENTRIES);
        } catch (e) {
            console.warn('[TaskTelemetry] condense persist failed (non-fatal):', e);
        }
    }

    /**
     * FEAT-24-11: persist one API request. Plain append -- a long task issues
     * a hundred of these and must not re-read the file each time. Trimming
     * happens once per task via trimRequestLog(). Best-effort, never throws.
     */
    async recordRequest(entry: RequestTelemetryEntry): Promise<void> {
        try {
            await this.ensureDir();
            await this.fs.append(`${this.dir}/${REQUESTS_FILE}`, JSON.stringify(entry) + '\n');
        } catch (e) {
            console.warn('[TaskTelemetry] request persist failed (non-fatal):', e);
        }
    }

    /** FEAT-24-11: keep requests.jsonl bounded. Called once per task end. */
    async trimRequestLog(max: number = MAX_REQUEST_ENTRIES): Promise<void> {
        try {
            const file = `${this.dir}/${REQUESTS_FILE}`;
            if (!(await this.fs.exists(file))) return;
            const lines = (await this.fs.read(file)).split('\n').filter(Boolean);
            if (lines.length <= max) return;
            await this.fs.write(file, lines.slice(-max).join('\n') + '\n');
        } catch (e) {
            console.warn('[TaskTelemetry] request trim failed (non-fatal):', e);
        }
    }

    private async ensureDir(): Promise<void> {
        if (!(await this.fs.exists(this.dir))) {
            await this.fs.mkdir(this.dir);
        }
    }

    /** Read-modify-write with a line cap; fine for the once-per-task files. */
    private async appendBounded(name: string, entry: unknown, max: number): Promise<void> {
        await this.ensureDir();
        const file = `${this.dir}/${name}`;
        const line = JSON.stringify(entry) + '\n';
        let existing = '';
        if (await this.fs.exists(file)) {
            existing = await this.fs.read(file);
            // Truncate to last max-1 lines so we stay bounded
            const lines = existing.split('\n').filter(Boolean);
            if (lines.length >= max) {
                existing = lines.slice(-(max - 1)).join('\n') + '\n';
            }
        }
        await this.fs.write(file, existing + line);
    }

    /**
     * Read recent task entries for the analytics view. FEAT-24-11: when a
     * non-legacy dir is given, the legacy file is merged in (read-only) so
     * the history written before the move stays visible. Sorted by startedAt.
     */
    static async readRecent(
        fs: FileAdapter,
        n: number = 100,
        dir: string = LEGACY_TELEMETRY_DIR,
    ): Promise<TaskTelemetryEntry[]> {
        const current = await readJsonLines<TaskTelemetryEntry>(fs, `${dir}/${TASKS_FILE}`, n);
        if (dir === LEGACY_TELEMETRY_DIR) return current;
        const legacy = await readJsonLines<TaskTelemetryEntry>(fs, `${LEGACY_TELEMETRY_DIR}/${TASKS_FILE}`, n);
        if (legacy.length === 0) return current;
        return [...legacy, ...current]
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
            .slice(-n);
    }

    /** FEAT-24-11: read recent per-request entries, oldest first. */
    static async readRecentRequests(
        fs: FileAdapter,
        n: number = 1000,
        dir: string = LEGACY_TELEMETRY_DIR,
    ): Promise<RequestTelemetryEntry[]> {
        return readJsonLines<RequestTelemetryEntry>(fs, `${dir}/${REQUESTS_FILE}`, n);
    }
}

/**
 * Prompt-cache hit rate: served-from-cache tokens over the total input-side
 * tokens (non-cached input + cache reads + cache writes). Mirrors the
 * computation in `src/api/logCacheStat.ts` so the sidebar number matches the
 * `[CacheStat:<provider>]` console line. Returns null when there is no cache
 * activity at all (so callers can omit the segment).
 */
export function cacheHitRate(inputTokens: number, cacheReadTokens: number, cacheCreationTokens = 0): number | null {
    const total = inputTokens + cacheReadTokens + cacheCreationTokens;
    if (total <= 0 || (cacheReadTokens <= 0 && cacheCreationTokens <= 0)) return null;
    return Math.round((cacheReadTokens / total) * 100);
}

/** UI helper: build a one-line cost summary for the footer (FEAT-24-05). */
export function formatTelemetryFooter(args: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens?: number;
    costEur: number;
    /** When true, append "(sub)" -- the user pays a flat subscription, this is the would-be API cost. */
    isSubscription?: boolean;
}): string {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let s = `${t}  ·  ${args.inputTokens.toLocaleString()} in · ${args.outputTokens.toLocaleString()} out`;
    if (args.cacheReadTokens > 0) s += ` · ${args.cacheReadTokens.toLocaleString()} cached`;
    const hit = cacheHitRate(args.inputTokens, args.cacheReadTokens, args.cacheCreationTokens ?? 0);
    if (hit !== null) s += ` · ${hit}% hit`;
    // v2.10.2: always show the EUR cost, even on subscription providers.
    // User asked for visibility into "what would this cost normally" so
    // they can spot expensive calls regardless of where they're billed.
    // The "(~ via Sub)" suffix flags that the displayed cost is the
    // would-be API spend, not what the user actually pays.
    s += ` · ${formatEur(args.costEur)}`;
    if (args.isSubscription) s += ' (~ via Sub)';
    return s;
}
