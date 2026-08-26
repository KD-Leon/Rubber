/**
 * FEAT-44-15: word-level diff INSIDE a changed line.
 *
 * The approval gate shows German markdown prose, where a paragraph is one single
 * long line. A line-level diff can only say "this paragraph is gone, this
 * paragraph is new" -- which is no information at all. That is GitLab's own
 * diagnosis of why intraline highlighting matters most for markdown, where lines
 * are paragraphs. Code survives line-level diffing. Prose does not.
 *
 * Design rules, each one there to stop a specific failure:
 *
 * 1. Tokenize on WORDS, not characters. Google's diff-match-patch documents that
 *    the *optimal* character diff is unreadable to humans: "mouse" vs "sofas"
 *    becomes [-m][+s][=o][-u][+fa][=s][-e]. Word tokens give the semantic result
 *    directly, which is why no `cleanupSemantic` pass is needed here.
 *
 * 2. Markdown atoms are single tokens. Otherwise `[[Ziel|Alias]]` is shredded
 *    into brackets and fragments and the diff highlights punctuation.
 *
 * 3. Refine to characters ONLY inside a 1:1 swap of two similar tokens. That is
 *    the German inflection case (Modell -> Modelle, Konfiguration ->
 *    Konfigurationen) and in this vault it is the common one. Applying character
 *    refinement to unrelated words is exactly how you get confetti.
 *
 * 4. Suppress and fall back to marking the whole line whenever the result would
 *    be noise. A half-broken intraline diff is worse than none: it teaches the
 *    user to distrust the highlighting, and this thing is an approval gate.
 *
 * No new dependency: `diffArrays` comes from `diff`, which is already bundled.
 */

import { diffArrays } from 'diff';

export type IntralineOpType = 'equal' | 'del' | 'ins';

export interface IntralineOp {
    type: IntralineOpType;
    text: string;
}

export interface IntralineDiff {
    /** Ops for the BEFORE side: `equal` and `del` only. */
    left: IntralineOp[];
    /** Ops for the AFTER side: `equal` and `ins` only. */
    right: IntralineOp[];
}

// --- Tuning -----------------------------------------------------------------
// Thresholds are lifted from the tools that fought these battles already
// (delta's --max-line-length / --max-line-distance, VS Code's
// MINIMUM_MATCHING_CHARACTER_LENGTH) rather than invented.

/** Beyond this, tokenizing and pairing costs more than the diff is worth. */
const MAX_LINE_CHARS = 3000;
/** A line with more tokens than this is a wall of text, not an edit. */
const MAX_TOKENS = 400;
/** Below this similarity the two lines are different content, not an edit of one another. */
const MIN_SIMILARITY = 0.4;
/** More marked spans than this reads as confetti, whatever the similarity says. */
const MAX_SPANS = 40;
/** An "equal" run shorter than this between two changes is noise; absorb it. */
const MIN_EQUAL_RUN_CHARS = 3;
/** Character refinement only when the two tokens really are the same word. */
const REFINE_MIN_SHARED_RATIO = 0.5;
const REFINE_MIN_SHARED_CHARS = 3;

/**
 * Markdown-aware tokenizer. Order matters: the composite atoms must be tried
 * before the plain-word rule, or they get eaten piecemeal.
 *
 * `\p{L}` (with the `u` flag) covers ä, ö, ü, ß, so German words stay whole
 * without an ASCII-only fallback.
 */
const TOKEN_RE = new RegExp(
    [
        /!?\[\[[^\]\n]*\]\]/.source,                    // [[wikilink]] and ![[embed]]
        /\[[^\]\n]*\]\([^)\n]*\)/.source,               // [text](url)
        /`[^`\n]*`/.source,                             // `inline code`
        /https?:\/\/[^\s)]+/.source,                    // bare URL
        /\^[\w-]+/.source,                              // ^block-anchor
        /#[\p{L}\p{N}/_-]+/.source,                     // #tag
        /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/.source,  // word, incl. hyphenated
        /\s+/.source,                                   // whitespace run
        /[^\s]/.source,                                 // any single other char
    ].join('|'),
    'gu',
);

/** Split a line into markdown-aware tokens. Lossless: the tokens re-join to the input. */
export function tokenize(line: string): string[] {
    return line.match(TOKEN_RE) ?? [];
}

const isBlank = (t: string): boolean => t.trim() === '';

/** Dice coefficient over the non-blank token multiset. */
function similarity(a: string[], b: string[]): number {
    const wordsA = a.filter((t) => !isBlank(t));
    const wordsB = b.filter((t) => !isBlank(t));
    if (wordsA.length === 0 && wordsB.length === 0) return 1;
    if (wordsA.length === 0 || wordsB.length === 0) return 0;

    const counts = new Map<string, number>();
    for (const t of wordsA) counts.set(t, (counts.get(t) ?? 0) + 1);

    let shared = 0;
    for (const t of wordsB) {
        const n = counts.get(t) ?? 0;
        if (n > 0) {
            shared += 1;
            counts.set(t, n - 1);
        }
    }
    return (2 * shared) / (wordsA.length + wordsB.length);
}

/** Longest common prefix / suffix in characters. */
function sharedAffixes(a: string, b: string): { prefix: number; suffix: number } {
    const max = Math.min(a.length, b.length);
    let prefix = 0;
    while (prefix < max && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (
        suffix < max - prefix
        && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) suffix += 1;
    return { prefix, suffix };
}

function push(ops: IntralineOp[], type: IntralineOpType, text: string): void {
    if (text === '') return;
    const last = ops[ops.length - 1];
    if (last !== undefined && last.type === type) {
        last.text += text;      // merge, so a paragraph is a few nodes, not hundreds
        return;
    }
    ops.push({ type, text });
}

/**
 * A 1:1 swap of two tokens that are mostly the same word: highlight only the
 * characters that differ. `Modell` -> `Modelle` should mark the `e`, not the
 * word. Returns false when the tokens are not similar enough, in which case the
 * caller keeps the whole-token marking (see the "mouse"/"sofas" rule).
 */
function refineTokenPair(left: IntralineOp[], right: IntralineOp[], a: string, b: string): boolean {
    const { prefix, suffix } = sharedAffixes(a, b);
    const shared = prefix + suffix;
    const shorter = Math.min(a.length, b.length);

    // The refinement must be anchored on a shared STEM, not merely on a shared
    // tail. German inflection changes the ending and keeps the front: Modell ->
    // Modelle, Konfiguration -> Konfigurationen.
    //
    // Without this, `täglich` -> `wöchentlich` looks refinable (they share the
    // suffix "lich", 4 of 7 chars) and the diff would claim only "täg" changed.
    // Two different words that happen to end alike are not an edit of one
    // another, and pretending otherwise is exactly the confetti we are avoiding.
    if (prefix < REFINE_MIN_SHARED_CHARS) return false;
    if (shared / shorter < REFINE_MIN_SHARED_RATIO) return false;

    const head = a.slice(0, prefix);
    const tailA = a.slice(a.length - suffix);
    const midA = a.slice(prefix, a.length - suffix);
    const midB = b.slice(prefix, b.length - suffix);

    push(left, 'equal', head);
    push(left, 'del', midA);
    push(left, 'equal', tailA);

    push(right, 'equal', head);
    push(right, 'ins', midB);
    push(right, 'equal', tailA);
    return true;
}

/**
 * Word-level diff of two lines.
 *
 * @returns the per-side ops, or `null` when the pair should NOT be highlighted
 *          intraline (identical, unrelated, too long, or too noisy). The caller
 *          then marks the whole line, which is honest rather than confusing.
 */
export function intralineDiff(before: string, after: string): IntralineDiff | null {
    if (before === after) return null;
    if (before.length > MAX_LINE_CHARS || after.length > MAX_LINE_CHARS) return null;

    const tokA = tokenize(before);
    const tokB = tokenize(after);
    if (tokA.length > MAX_TOKENS || tokB.length > MAX_TOKENS) return null;
    if (similarity(tokA, tokB) < MIN_SIMILARITY) return null;

    const changes = diffArrays(tokA, tokB);

    const left: IntralineOp[] = [];
    const right: IntralineOp[] = [];
    let spans = 0;

    for (let i = 0; i < changes.length; i += 1) {
        const c = changes[i];
        const text = c.value.join('');

        if (c.added === undefined && c.removed === undefined) {
            // An equal run of only a couple of characters wedged between two
            // changes reads as noise ("...a[-x-]n[+y+]d..."). Absorb it.
            const between = i > 0 && i < changes.length - 1;
            if (between && text.trim().length > 0 && text.length < MIN_EQUAL_RUN_CHARS) {
                push(left, 'del', text);
                push(right, 'ins', text);
                continue;
            }
            push(left, 'equal', text);
            push(right, 'equal', text);
            continue;
        }

        // A removal directly followed by an insertion is a SWAP -- the case worth
        // refining to characters.
        const next = changes[i + 1];
        if (
            c.removed === true
            && next !== undefined
            && next.added === true
            && c.value.length === 1
            && next.value.length === 1
        ) {
            const a = c.value[0];
            const b = next.value[0];
            if (refineTokenPair(left, right, a, b)) {
                spans += 2;
                i += 1;   // consume the insertion too
                continue;
            }
        }

        if (c.removed === true) {
            push(left, 'del', text);
            spans += 1;
        } else {
            push(right, 'ins', text);
            spans += 1;
        }
    }

    if (spans === 0) return null;
    if (spans > MAX_SPANS) return null;

    // A "diff" in which nothing survived unchanged is a rewrite, not an edit.
    // Marking every word is strictly less readable than marking the line.
    const equalChars = left
        .filter((o) => o.type === 'equal')
        .reduce((n, o) => n + o.text.trim().length, 0);
    if (equalChars === 0) return null;

    return { left, right };
}
