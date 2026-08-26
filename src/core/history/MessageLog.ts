/**
 * Append-only message log with commit points (IMP-41-03-04, ADR-149).
 *
 * The conversation history used to be one mutable MessageParam[] aliased by
 * the loop (push/splice in place) and the sidebar (persisted by reference) —
 * the structural root of the boot-race bug class (FIX-03-20-01,
 * AUDIT-2026-07-02 L-2) and the reason a mis-condensed session could not be
 * diagnosed. This log owns the messages: consumers only ever get
 * materialized copies, condensing rewrites keep the previous generation
 * reachable (bounded), and dumpTimeline() exposes the commit chain for
 * diagnosis. The ConversationStore file format is untouched — this is a
 * runtime construct.
 */

import type { MessageParam } from '../../api/types';

interface Generation {
    label: string;
    messages: MessageParam[];
}

const MAX_RETAINED_GENERATIONS = 3;

function deepCopy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export class MessageLog {
    /** Older generations, oldest first. Current content lives in `current`. */
    private previous: Generation[] = [];
    private current: MessageParam[] = [];
    private commits = new Map<string, { label: string; snapshot: MessageParam[] }>();
    private commitCounter = 0;

    static from(messages: readonly MessageParam[]): MessageLog {
        const log = new MessageLog();
        log.current = deepCopy([...messages]);
        return log;
    }

    get length(): number {
        return this.current.length;
    }

    append(message: MessageParam): void {
        this.current.push(deepCopy(message));
    }

    /** Materialized deep copy — never a live reference. */
    toMessages(): MessageParam[] {
        return deepCopy(this.current);
    }

    /** Snapshot the current content under a label; returns the commit id. */
    commit(label: string): string {
        const id = `c${++this.commitCounter}`;
        this.commits.set(id, { label, snapshot: deepCopy(this.current) });
        return id;
    }

    /**
     * Replace the content (condensing). The generation captured by
     * `commitId` stays reachable in the timeline, bounded to
     * MAX_RETAINED_GENERATIONS with oldest-first eviction.
     */
    rewriteFromCommit(commitId: string, messages: MessageParam[], label: string): void {
        const committed = this.commits.get(commitId);
        if (committed) {
            this.previous.push({ label: committed.label, messages: committed.snapshot });
        }
        this.previous.push({ label, messages: deepCopy(messages) });
        while (this.previous.length > MAX_RETAINED_GENERATIONS) {
            this.previous.shift();
        }
        this.current = deepCopy(messages);
    }

    /**
     * Condense forensics (IMP-41-03-04 shadow mode): record a labelled
     * snapshot of the history as it looked BEFORE a rewrite, without this
     * log owning the live array. Bounded by MAX_RETAINED_GENERATIONS with
     * oldest-first eviction; deep-copied at record time so later caller
     * mutations cannot corrupt the timeline.
     */
    recordGeneration(label: string, messages: readonly MessageParam[]): void {
        this.previous.push({ label, messages: deepCopy([...messages]) });
        while (this.previous.length > MAX_RETAINED_GENERATIONS) {
            this.previous.shift();
        }
    }

    /** Splice-equivalent for the orphan-tool_use cleanup in the error path. */
    removeTrailing(predicate: (m: MessageParam) => boolean): void {
        while (this.current.length > 0 && predicate(this.current[this.current.length - 1])) {
            this.current.pop();
        }
    }

    /** Diagnostic view of the retained generations (read_agent_logs surface). */
    dumpTimeline(): { generations: Array<{ label: string; messages: MessageParam[] }> } {
        return {
            generations: this.previous.map((g) => ({
                label: g.label,
                messages: deepCopy(g.messages),
            })),
        };
    }
}
