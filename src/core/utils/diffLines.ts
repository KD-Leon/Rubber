/**
 * Line-level diff using the `diff` package (Myers).
 *
 * FEAT-44-15: the call used to run with default options, i.e. unbounded. Myers is
 * O(ND); on two large, largely-unrelated texts (a transcript against a rewritten
 * transcript) that is where a UI goes away and does not come back. The approval
 * gate blocks the agent loop while it renders, so "slow" here means "the agent is
 * frozen".
 *
 * We therefore cap the work and degrade honestly: if the diff cannot be computed
 * within budget, we say "the whole file changed" rather than hanging. This is the
 * same guard CodeMirror's merge view uses ("fall back to treating entire documents
 * as changed when they are too large to compute a diff in a reasonable
 * timeframe").
 */

import { diffLines as jsDiffLines } from 'diff';

export interface DiffLine {
    type: 'added' | 'removed' | 'unchanged';
    content: string;
}

export interface DiffStats {
    added: number;
    removed: number;
}

/** Myers edit-distance ceiling. Beyond this the two texts are not versions of each other. */
const MAX_EDIT_LENGTH = 20_000;
/** Hard wall-clock budget, in ms. */
const TIMEOUT_MS = 3_000;

function splitLines(text: string): string[] {
    if (text === '') return [];
    const raw = text.endsWith('\n') ? text.slice(0, -1) : text;
    return raw.split('\n');
}

/** The honest fallback: everything removed, everything added. */
function wholeFileReplaced(oldText: string, newText: string): DiffLine[] {
    const out: DiffLine[] = [];
    for (const content of splitLines(oldText)) out.push({ type: 'removed', content });
    for (const content of splitLines(newText)) out.push({ type: 'added', content });
    return out;
}

/**
 * `diff@5.2.2` honours BOTH bounds at runtime (`lib/diff/base.js:54` reads
 * `options.maxEditLength`, `:60` reads `options.timeout`), but the shipped type
 * declarations only list `maxEditLength`. Casting the options object is the
 * honest way to use a guard that exists; dropping `timeout` to satisfy the types
 * would leave the gate able to hang, which is the whole thing we are preventing.
 */
interface BoundedChange {
    value: string;
    added?: boolean;
    removed?: boolean;
}

type BoundedDiffLines = (
    oldStr: string,
    newStr: string,
    options: { maxEditLength: number; timeout: number },
) => BoundedChange[] | undefined;

export function diffLines(oldText: string, newText: string): DiffLine[] {
    const bounded = jsDiffLines as unknown as BoundedDiffLines;
    const changes = bounded(oldText, newText, {
        maxEditLength: MAX_EDIT_LENGTH,
        timeout: TIMEOUT_MS,
    });

    // jsdiff returns undefined when it gives up (either bound hit).
    if (changes === undefined) {
        console.debug('[diffLines] diff exceeded its budget; showing the file as fully replaced');
        return wholeFileReplaced(oldText, newText);
    }

    const result: DiffLine[] = [];
    for (const change of changes) {
        // The diff package keeps the trailing \n on each chunk; strip it so the
        // split does not produce a phantom empty line.
        const raw = change.value.endsWith('\n')
            ? change.value.slice(0, -1)
            : change.value;
        const lines = raw.split('\n');
        const type: DiffLine['type'] = change.added ? 'added' : change.removed ? 'removed' : 'unchanged';
        for (const content of lines) {
            result.push({ type, content });
        }
    }
    return result;
}

export function getDiffStats(lines: DiffLine[]): DiffStats {
    let added = 0;
    let removed = 0;
    for (const l of lines) {
        if (l.type === 'added') added++;
        else if (l.type === 'removed') removed++;
    }
    return { added, removed };
}
