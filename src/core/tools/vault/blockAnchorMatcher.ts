/**
 * blockAnchorMatcher -- pure, Obsidian-free matcher that places
 * `^block-<id>` anchors into a transcript for the meeting-summary skill.
 *
 * IMP-01-09-01. Replaces the skill's fragile
 * `evaluate_expression(text.indexOf(find))` bulk pattern, which broke on
 * ASR word-garble ("Ledgar" for "Ledger"), double spaces and punctuation
 * drift and forced the model into a ~15-round sandbox debug loop.
 *
 * The matcher resolves each `find` string against the transcript in three
 * layers and returns a deterministic `{ set, missed, ambiguous }` signal:
 *   L1 exact    -- byte-identical `indexOf`; more than one hit is ambiguous.
 *   L2 normalized -- token match ignoring whitespace/punctuation drift.
 *   L3 fuzzy    -- token-sequence alignment with bounded per-token
 *                  Levenshtein similarity, so a single garbled word still
 *                  anchors. Candidates come from an inverted index over the
 *                  rarest needle tokens; scoring is a similarity-weighted
 *                  token-LCS over a small window.
 *
 * Load-bearing invariants (see blockAnchorMatcher.test.ts):
 *  - No transcript word is ever changed; only whitespace between blocks is
 *    normalised. Anchors are spliced by original-coordinate position.
 *  - Anchors are idempotent (an existing `^block-<id>` is respected).
 *  - Multiple `find` hits within {@link AMBIGUITY_MARGIN} are reported as
 *    ambiguous, never silently anchored to the wrong paragraph -- a
 *    mis-quote is worse than a miss.
 *  - Matches inside a code fence or the frontmatter block are skipped
 *    (block-ids do not resolve there).
 */

/** Acceptance floor for a fuzzy match. ASR garble is heavier than smart-quote drift, so this is looser than a diff matcher's 0.9. */
const ACCEPT_THRESHOLD = 0.75;
/** Two candidates whose scores sit within this margin are ambiguous. Conservative -- a mis-quote is worse than a miss. */
const AMBIGUITY_MARGIN = 0.08;
/** A needle token and a transcript token count as the "same" word at or above this similarity. */
const PER_TOKEN_THRESHOLD = 0.7;
/** Cap on candidate window starts gathered from the inverted index. */
const MAX_CANDIDATE_POSTINGS = 200;
/** Extra transcript tokens included on each side of a candidate window, to absorb ASR insertions. */
const WINDOW_SLACK = 3;
/**
 * Max chars for a single `find`. A legitimate anchor quote is a sentence
 * (tens to a few hundred chars); anything larger is garble/abuse and would
 * blow up the O(n*w) alignment DP (CWE-400, AUDIT 2026-07-08 L-1). Oversized
 * finds are reported missed without entering the matcher.
 */
export const MAX_FIND_CHARS = 2000;

/** Trailing sentence punctuation that belongs to a matched token span (so the anchor lands after the period, not before it). */
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'", '”', '’', '»']);

export interface AnchorRequest {
    find: string;
    id: string | number;
}

export type AnchorStatus =
    | 'exact'
    | 'normalized'
    | 'fuzzy'
    | 'already-anchored'
    | 'missed'
    | 'ambiguous';

export interface AnchorDetail {
    id: string | number;
    status: AnchorStatus;
    /** 1 for exact / normalized / already-anchored, best-score (<1) for fuzzy, best observed score for missed. */
    confidence: number;
}

export interface ApplyAnchorsResult {
    text: string;
    set: Array<string | number>;
    missed: Array<string | number>;
    ambiguous: Array<string | number>;
    details: AnchorDetail[];
}

interface Token {
    norm: string;
    /** Offsets in the ORIGINAL text. */
    start: number;
    end: number;
}

export interface TranscriptIndex {
    text: string;
    tokens: Token[];
    /** normalized token -> transcript token indices. */
    postings: Map<string, number[]>;
    /** [start, end) char ranges that must not receive an anchor (code fences + frontmatter). */
    fenceRanges: Array<[number, number]>;
}

type AnchorResolution =
    | { status: 'exact' | 'normalized' | 'fuzzy'; start: number; end: number; confidence: number }
    | { status: 'ambiguous'; confidence: number }
    | { status: 'missed'; confidence: number };

const WORD_RE = /[\p{L}\p{N}]+/gu;

function normToken(raw: string): string {
    return raw.normalize('NFC').toLowerCase();
}

/** Bounded two-row Levenshtein similarity in [0,1]. Dependency-free; words are short so the DP is trivial. */
function similarity(a: string, b: string): number {
    if (a === b) return 1;
    const la = a.length;
    const lb = b.length;
    if (la === 0 || lb === 0) return 0;
    const maxLen = Math.max(la, lb);
    let prev = new Array<number>(lb + 1);
    let curr = new Array<number>(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
        curr[0] = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= lb; j++) {
            const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    const dist = prev[lb];
    return 1 - dist / maxLen;
}

function tokenizeNorms(s: string): string[] {
    const out: string[] = [];
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(s)) !== null) out.push(normToken(m[0]));
    return out;
}

function computeFenceRanges(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const fm = text.match(/^---\n[\s\S]*?\n---/);
    if (fm && fm.index === 0) ranges.push([0, fm[0].length]);
    const fenceRe = /^```[\s\S]*?^```/gm;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(text)) !== null) {
        ranges.push([m.index, m.index + m[0].length]);
    }
    return ranges;
}

export function buildTranscriptIndex(text: string): TranscriptIndex {
    const tokens: Token[] = [];
    const postings = new Map<string, number[]>();
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(text)) !== null) {
        const norm = normToken(m[0]);
        const idx = tokens.length;
        tokens.push({ norm, start: m.index, end: m.index + m[0].length });
        const list = postings.get(norm);
        if (list) list.push(idx);
        else postings.set(norm, [idx]);
    }
    return { text, tokens, postings, fenceRanges: computeFenceRanges(text) };
}

function inFence(idx: TranscriptIndex, pos: number): boolean {
    return idx.fenceRanges.some(([a, b]) => pos >= a && pos < b);
}

function countExact(text: string, find: string): { count: number; first: number } {
    let count = 0;
    let first = -1;
    let pos = 0;
    for (;;) {
        const at = text.indexOf(find, pos);
        if (at === -1) break;
        if (first === -1) first = at;
        count++;
        pos = at + find.length;
    }
    return { count, first };
}

/** Extend a token-span end forward over trailing sentence punctuation so the anchor lands after the period. */
function extendEnd(text: string, end: number): number {
    let e = end;
    while (e < text.length && TRAILING_PUNCT.has(text[e])) e++;
    return e;
}

interface AlignResult {
    score: number;      // confidence in [0,1]
    firstTok: number;   // window-relative index of first matched transcript token
    lastTok: number;    // window-relative index of last matched transcript token
    allExact: boolean;  // every needle token matched with similarity 1
}

/** Similarity-weighted token-LCS of the needle against a window of transcript tokens. */
function alignWindow(needle: string[], win: Token[]): AlignResult | null {
    const n = needle.length;
    const w = win.length;
    if (n === 0 || w === 0) return null;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(w + 1).fill(0));
    const bt: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(w + 1).fill(0)); // 0 diag, 1 skip-needle, 2 skip-window
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= w; j++) {
            const sim = similarity(needle[i - 1], win[j - 1].norm);
            const diag = sim >= PER_TOKEN_THRESHOLD ? dp[i - 1][j - 1] + sim : -Infinity;
            const up = dp[i - 1][j];
            const left = dp[i][j - 1];
            let best = diag;
            let dir = 0;
            if (up > best) { best = up; dir = 1; }
            if (left > best) { best = left; dir = 2; }
            dp[i][j] = best;
            bt[i][j] = dir;
        }
    }
    let i = n;
    let j = w;
    let first = -1;
    let last = -1;
    let matched = 0;
    let allExact = true;
    while (i > 0 && j > 0) {
        const dir = bt[i][j];
        if (dir === 0) {
            if (last === -1) last = j - 1;
            first = j - 1;
            if (similarity(needle[i - 1], win[j - 1].norm) < 1) allExact = false;
            matched++;
            i--; j--;
        } else if (dir === 1) {
            i--;
        } else {
            j--;
        }
    }
    if (matched === 0) return null;
    return { score: dp[n][w] / n, firstTok: first, lastTok: last, allExact: allExact && matched === n };
}

/** Gather candidate window start indices (transcript token space) from the rarest needle tokens. */
function candidateStarts(idx: TranscriptIndex, needle: string[]): number[] {
    const ranked = needle
        .map((norm, j) => ({ norm, j, freq: idx.postings.get(norm)?.length ?? 0 }))
        .sort((a, b) => a.freq - b.freq);
    const starts = new Set<number>();
    let used = 0;
    for (const { norm, j } of ranked) {
        if (starts.size >= MAX_CANDIDATE_POSTINGS || used >= 3) break;
        for (const t of idx.postings.get(norm) ?? []) {
            starts.add(Math.max(0, t - j));
            if (starts.size >= MAX_CANDIDATE_POSTINGS) break;
        }
        // Fuzzy postings only for the two rarest tokens (bounds the vocab scan).
        if (used < 2) {
            for (const [key, positions] of idx.postings) {
                if (key === norm) continue;
                const allowedDist = Math.floor((1 - PER_TOKEN_THRESHOLD) * Math.max(key.length, norm.length));
                if (Math.abs(key.length - norm.length) > allowedDist) continue;
                if (similarity(key, norm) >= PER_TOKEN_THRESHOLD) {
                    for (const t of positions) {
                        starts.add(Math.max(0, t - j));
                        if (starts.size >= MAX_CANDIDATE_POSTINGS) break;
                    }
                }
                if (starts.size >= MAX_CANDIDATE_POSTINGS) break;
            }
        }
        used++;
    }
    return [...starts];
}

interface Candidate { score: number; start: number; end: number; allExact: boolean; startTok: number }

function bestMatches(idx: TranscriptIndex, needle: string[]): { best: Candidate | null; second: Candidate | null } {
    const n = needle.length;
    let best: Candidate | null = null;
    let second: Candidate | null = null;
    for (const s of candidateStarts(idx, needle)) {
        const winStart = Math.max(0, s - 2);
        const winEnd = Math.min(idx.tokens.length, s + n + WINDOW_SLACK);
        const win = idx.tokens.slice(winStart, winEnd);
        const a = alignWindow(needle, win);
        if (!a) continue;
        const firstTokenAbs = winStart + a.firstTok;
        const lastTokenAbs = winStart + a.lastTok;
        const cand: Candidate = {
            score: a.score,
            start: idx.tokens[firstTokenAbs].start,
            end: extendEnd(idx.text, idx.tokens[lastTokenAbs].end),
            allExact: a.allExact,
            startTok: firstTokenAbs,
        };
        if (!best || cand.score > best.score) {
            // Keep the previous best as second only if it maps to a different location.
            if (best && best.startTok !== cand.startTok) second = best;
            best = cand;
        } else if (cand.startTok !== best.startTok && (!second || cand.score > second.score)) {
            second = cand;
        }
    }
    return { best, second };
}

function resolveAnchor(idx: TranscriptIndex, find: string): AnchorResolution {
    if (!find.trim()) return { status: 'missed', confidence: 0 };

    const ex = countExact(idx.text, find);
    if (ex.count > 1) return { status: 'ambiguous', confidence: 1 };
    if (ex.count === 1) {
        if (inFence(idx, ex.first)) return { status: 'missed', confidence: 0 };
        // Extend over trailing punctuation so a find that stops mid-sentence
        // ("...Modus setzen" before "...setzen.") anchors after the period, not
        // between the word and the mark. Parity with the fuzzy path's extendEnd.
        return { status: 'exact', start: ex.first, end: extendEnd(idx.text, ex.first + find.length), confidence: 1 };
    }

    const needle = tokenizeNorms(find);
    if (needle.length === 0) return { status: 'missed', confidence: 0 };
    const { best, second } = bestMatches(idx, needle);
    if (!best || best.score < ACCEPT_THRESHOLD) {
        return { status: 'missed', confidence: best?.score ?? 0 };
    }
    if (second && second.score >= ACCEPT_THRESHOLD && best.score - second.score <= AMBIGUITY_MARGIN) {
        return { status: 'ambiguous', confidence: best.score };
    }
    if (inFence(idx, best.start)) return { status: 'missed', confidence: best.score };
    return {
        status: best.allExact ? 'normalized' : 'fuzzy',
        start: best.start,
        end: best.end,
        confidence: best.allExact ? 1 : best.score,
    };
}

function isValidId(id: string | number): boolean {
    return /^[\w-]+$/.test(String(id));
}

function anchorExists(text: string, id: string | number): boolean {
    const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\^block-${escaped}(?![\\w-])`).test(text);
}

/**
 * Splice ` ^block-<id>` in at `end` (original coordinates), terminating the
 * block with a blank line. Any whitespace between the matched sentence and
 * the following content is normalised to a single paragraph break, which is
 * what splits a single-paragraph transcript at the anchor. No word is
 * changed. Callers apply insertions right-to-left so earlier offsets stay
 * valid.
 */
function insertAnchor(text: string, end: number, id: string | number): string {
    const before = text.slice(0, end);
    const after = text.slice(end);
    const leadingWs = (after.match(/^\s*/) ?? [''])[0];
    const rest = after.slice(leadingWs.length);
    const anchor = ` ^block-${id}`;
    if (rest.length === 0) return `${before}${anchor}\n`;
    return `${before}${anchor}\n\n${rest}`;
}

export interface ApplyAnchorsOptions {
    /**
     * Restrict matching to one section of the note. The value is matched
     * (trimmed, case-insensitive) against heading texts; anchors are placed
     * only inside that section's body -- from its heading line to the next
     * heading of the same or higher level, or EOF. Everything outside stays
     * byte-identical.
     *
     * The meeting-summary skill writes a summary above the transcript before
     * placing anchors. Without this scope a `find` whose wording is closer to
     * the model's own summary paraphrase than to the raw transcript resolves
     * INTO the summary (or ambiguously across both), leaving the summary link
     * pointing at an anchor nobody can click. Scoping to "Transkript" keeps
     * every anchor in the transcript regardless of what order the skill wrote
     * things in. If the section is not found, nothing is anchored
     * (fail-closed): every id is reported missed.
     */
    restrictToSection?: string;
}

/**
 * Locate a section body by heading text. Returns [start, end) offsets in the
 * ORIGINAL text (start = just after the heading line, end = the next
 * same-or-higher heading or EOF), or null if no heading matches.
 */
export function findSectionBody(text: string, heading: string): { start: number; end: number } | null {
    const want = heading.trim().toLowerCase();
    if (!want) return null;
    const headingRe = /^(#{1,6})[ \t]+(.*?)[ \t]*$/gm;
    let m: RegExpExecArray | null;
    let level = -1;
    let bodyStart = -1;
    while ((m = headingRe.exec(text)) !== null) {
        if (bodyStart === -1) {
            const title = m[2].trim().toLowerCase();
            if (title === want || title.startsWith(want)) {
                level = m[1].length;
                bodyStart = m.index + m[0].length;
            }
        } else if (m[1].length <= level) {
            return { start: bodyStart, end: m.index };
        }
    }
    return bodyStart === -1 ? null : { start: bodyStart, end: text.length };
}

/**
 * Place `^block-<id>` anchors. With `options.restrictToSection`, matching and
 * insertion happen only inside that section; the rest of the note is spliced
 * back untouched. See {@link ApplyAnchorsOptions.restrictToSection}.
 */
export function applyAnchors(text: string, anchors: AnchorRequest[], options?: ApplyAnchorsOptions): ApplyAnchorsResult {
    const section = options?.restrictToSection?.trim();
    if (!section) return applyAnchorsCore(text, anchors);

    const body = findSectionBody(text, section);
    if (!body) {
        // Fail-closed: an unknown section anchors nothing, rather than falling
        // back to matching the whole note (which is the bug this guards).
        const missed = anchors.map((a) => a.id);
        const details: AnchorDetail[] = anchors.map((a) => ({ id: a.id, status: 'missed' as const, confidence: 0 }));
        return { text, set: [], missed, ambiguous: [], details };
    }

    const inner = applyAnchorsCore(text.slice(body.start, body.end), anchors);
    return { ...inner, text: text.slice(0, body.start) + inner.text + text.slice(body.end) };
}

function applyAnchorsCore(text: string, anchors: AnchorRequest[]): ApplyAnchorsResult {
    const idx = buildTranscriptIndex(text);
    const set: Array<string | number> = [];
    const missed: Array<string | number> = [];
    const ambiguous: Array<string | number> = [];
    const details: AnchorDetail[] = [];
    const insertions: Array<{ end: number; id: string | number }> = [];

    for (const { find, id } of anchors) {
        if (!isValidId(id)) {
            missed.push(id);
            details.push({ id, status: 'missed', confidence: 0 });
            continue;
        }
        if (anchorExists(text, id)) {
            set.push(id);
            details.push({ id, status: 'already-anchored', confidence: 1 });
            continue;
        }
        // CWE-400 guard: skip the fuzzy DP for an oversized find.
        if (typeof find !== 'string' || find.length > MAX_FIND_CHARS) {
            missed.push(id);
            details.push({ id, status: 'missed', confidence: 0 });
            continue;
        }
        const res = resolveAnchor(idx, find);
        if (res.status === 'missed') {
            missed.push(id);
            details.push({ id, status: 'missed', confidence: res.confidence });
        } else if (res.status === 'ambiguous') {
            ambiguous.push(id);
            details.push({ id, status: 'ambiguous', confidence: res.confidence });
        } else {
            set.push(id);
            details.push({ id, status: res.status, confidence: res.confidence });
            insertions.push({ end: res.end, id });
        }
    }

    let out = text;
    for (const ins of insertions.sort((a, b) => b.end - a.end)) {
        out = insertAnchor(out, ins.end, ins.id);
    }

    return { text: out, set, missed, ambiguous, details };
}
