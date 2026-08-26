/**
 * alignedDiff -- row-aligned side-by-side diff for the EditReviewPanel.
 *
 * `diffLines` returns a flat sequence of unchanged/removed/added lines. Rendering
 * each column on its own leaves the two sides out of vertical sync the moment a
 * hunk has a different number of removed and added lines, so removals and
 * insertions are grouped into hunks and the shorter side is padded. Left row N
 * then corresponds to right row N.
 *
 * Three things this does beyond padding, each one load-bearing:
 *
 * 1. PAIRING BY SIMILARITY, not by ordinal position. The old code zipped
 *    removed[j] with added[j]. When a hunk rewrites the second of five
 *    paragraphs, that pairs unrelated paragraphs with each other and the
 *    word-level diff then runs between them and produces confetti. This is git's
 *    own documented failure mode in diff-highlight ("pairs by position ... can
 *    be misleading"). `pairedWith` is only set when the two lines really are a
 *    rewrite of one another.
 *
 * 2. COLLAPSING unchanged runs. Two changed paragraphs in a 700-line transcript
 *    should not render 700 rows. This is data reduction, not a rendering trick.
 *
 * 3. HEADING context per row, so the panel can show a sticky "## Abschnitt"
 *    header. In a note, that is what orients you -- not a line number.
 *
 * Pure logic, no DOM. The renderer walks the two arrays in lock-step.
 */

import { diffLines, type DiffLine } from '../../core/utils/diffLines';

export type AlignedLineType = 'unchanged' | 'removed' | 'added' | 'padding' | 'collapsed';

export interface AlignedLine {
    type: AlignedLineType;
    content: string;
    /**
     * 1-based line number in the corresponding source. Null for padding and
     * collapsed rows, which do not exist in that source.
     */
    lineNumber: number | null;
    /**
     * The counterpart's text when this line and its opposite are a rewrite of the
     * same line. Null when the line was purely added or removed, in which case
     * there is nothing to diff it against and the whole line is marked.
     */
    pairedWith: string | null;
    /** Only on `collapsed`: how many unchanged lines are hidden behind this row. */
    hiddenCount?: number;
    /** Nearest preceding markdown heading, for the sticky hunk header. */
    heading: string | null;
}

export interface AlignedDiff {
    left: AlignedLine[];
    right: AlignedLine[];
}

export interface AlignedDiffOptions {
    /** Unchanged lines kept around each change. */
    context?: number;
    /** Do not collapse a run shorter than this -- more collapse bars than content. */
    minCollapse?: number;
    /**
     * Collapse unchanged runs at all. On by default.
     *
     * This used to only kick in above 500 rows, on the theory that folding a short
     * note costs orientation. That was wrong for the case that actually matters:
     * when the agent changes only the frontmatter, the gate showed the entire
     * transcript underneath as unchanged context, and a user reasonably read that
     * as "the body is part of this change too". A diff should show the change, not
     * the file.
     */
    collapse?: boolean;
}

/** Beyond this many lines per side, a hunk is a rewrite; pairing it is meaningless. */
const MAX_HUNK_FOR_PAIRING = 20;
/** How far away a partner may sit when the two sides have different lengths. */
const PAIR_WINDOW = 2;
/** Below this, the two lines are different content, not an edit of one another. */
const MIN_PAIR_SIMILARITY = 0.5;

const DEFAULTS: Required<AlignedDiffOptions> = {
    context: 3,
    // Prose collapses badly below this: you get more "N lines hidden" bars than text.
    minCollapse: 6,
    collapse: true,
};

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/** Dice coefficient over word multisets. Cheap, and good enough to pair paragraphs. */
function similarity(a: string, b: string): number {
    const wa = a.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const wb = b.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (wa.length === 0 && wb.length === 0) return a === b ? 1 : 0;
    if (wa.length === 0 || wb.length === 0) return 0;

    const counts = new Map<string, number>();
    for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
    let shared = 0;
    for (const w of wb) {
        const n = counts.get(w) ?? 0;
        if (n > 0) { shared += 1; counts.set(w, n - 1); }
    }
    return (2 * shared) / (wa.length + wb.length);
}

/**
 * Decide which removed line is a rewrite of which added line.
 *
 * Equal counts: pair by position. That is what git's diff-highlight does and it
 * is right ~80 % of the time, because an edit usually keeps the line count.
 * Unequal counts: greedy best match inside a small window, and only above a
 * similarity floor. Everything unmatched stays unpaired and gets marked whole.
 */
function pairLines(removed: DiffLine[], added: DiffLine[]): Map<number, number> {
    const pairs = new Map<number, number>();   // removed index -> added index
    if (removed.length === 0 || added.length === 0) return pairs;
    if (removed.length > MAX_HUNK_FOR_PAIRING || added.length > MAX_HUNK_FOR_PAIRING) return pairs;

    if (removed.length === added.length) {
        for (let i = 0; i < removed.length; i += 1) {
            if (similarity(removed[i].content, added[i].content) >= MIN_PAIR_SIMILARITY) {
                pairs.set(i, i);
            }
        }
        return pairs;
    }

    const takenAdded = new Set<number>();
    for (let i = 0; i < removed.length; i += 1) {
        let bestJ = -1;
        let bestSim = MIN_PAIR_SIMILARITY;
        const lo = Math.max(0, i - PAIR_WINDOW);
        const hi = Math.min(added.length - 1, i + PAIR_WINDOW);
        for (let j = lo; j <= hi; j += 1) {
            if (takenAdded.has(j)) continue;
            const sim = similarity(removed[i].content, added[j].content);
            if (sim > bestSim) { bestSim = sim; bestJ = j; }
        }
        if (bestJ >= 0) {
            pairs.set(i, bestJ);
            takenAdded.add(bestJ);
        }
    }
    return pairs;
}

export function buildAlignedDiff(
    before: string,
    after: string,
    options: AlignedDiffOptions = {},
): AlignedDiff {
    const opts = { ...DEFAULTS, ...options };
    const lines = diffLines(before, after);

    const left: AlignedLine[] = [];
    const right: AlignedLine[] = [];
    let leftNo = 1;
    let rightNo = 1;
    let heading: string | null = null;

    const trackHeading = (content: string): void => {
        const m = HEADING_RE.exec(content);
        if (m !== null) heading = m[2].trim();
    };

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        if (line.type === 'unchanged') {
            trackHeading(line.content);
            left.push({ type: 'unchanged', content: line.content, lineNumber: leftNo, pairedWith: null, heading });
            right.push({ type: 'unchanged', content: line.content, lineNumber: rightNo, pairedWith: null, heading });
            leftNo += 1;
            rightNo += 1;
            i += 1;
            continue;
        }

        const removed: DiffLine[] = [];
        const added: DiffLine[] = [];
        while (i < lines.length && lines[i].type !== 'unchanged') {
            if (lines[i].type === 'removed') removed.push(lines[i]);
            else added.push(lines[i]);
            i += 1;
        }

        const pairs = pairLines(removed, added);
        const partnerOf = new Map<number, number>();   // added index -> removed index
        for (const [r, a] of pairs) partnerOf.set(a, r);

        const max = Math.max(removed.length, added.length);
        for (let j = 0; j < max; j += 1) {
            const r = removed[j];
            const a = added[j];

            if (r !== undefined) {
                const partner = pairs.get(j);
                left.push({
                    type: 'removed',
                    content: r.content,
                    lineNumber: leftNo,
                    pairedWith: partner === undefined ? null : added[partner].content,
                    heading,
                });
                leftNo += 1;
            } else {
                left.push({ type: 'padding', content: '', lineNumber: null, pairedWith: null, heading });
            }

            if (a !== undefined) {
                trackHeading(a.content);
                const partner = partnerOf.get(j);
                right.push({
                    type: 'added',
                    content: a.content,
                    lineNumber: rightNo,
                    pairedWith: partner === undefined ? null : removed[partner].content,
                    heading,
                });
                rightNo += 1;
            } else {
                right.push({ type: 'padding', content: '', lineNumber: null, pairedWith: null, heading });
            }
        }
    }

    if (!opts.collapse) return { left, right };
    return collapseUnchanged(left, right, opts.context, opts.minCollapse);
}

/**
 * Replace long runs of unchanged rows with a single `collapsed` row, keeping
 * `context` rows on each side of every change. Both columns collapse at the same
 * indices, so the rows stay in lock-step.
 */
function collapseUnchanged(
    left: AlignedLine[],
    right: AlignedLine[],
    context: number,
    minCollapse: number,
): AlignedDiff {
    const keep = new Array<boolean>(left.length).fill(false);

    for (let i = 0; i < left.length; i += 1) {
        const changed = left[i].type !== 'unchanged' || right[i].type !== 'unchanged';
        if (!changed) continue;
        for (let k = Math.max(0, i - context); k <= Math.min(left.length - 1, i + context); k += 1) {
            keep[k] = true;
        }
    }

    const outL: AlignedLine[] = [];
    const outR: AlignedLine[] = [];
    let i = 0;
    while (i < left.length) {
        if (keep[i]) {
            outL.push(left[i]);
            outR.push(right[i]);
            i += 1;
            continue;
        }
        const start = i;
        while (i < left.length && !keep[i]) i += 1;
        const hidden = i - start;

        if (hidden < minCollapse) {
            for (let k = start; k < i; k += 1) {
                outL.push(left[k]);
                outR.push(right[k]);
            }
            continue;
        }
        const row = (side: AlignedLine[]): AlignedLine => ({
            type: 'collapsed',
            content: '',
            lineNumber: null,
            pairedWith: null,
            hiddenCount: hidden,
            heading: side[start].heading,
        });
        outL.push(row(left));
        outR.push(row(right));
    }

    return { left: outL, right: outR };
}
