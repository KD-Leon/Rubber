/**
 * meetingNoteFromSink -- pure transcript-to-note transform.
 *
 * Ported from the plaud-meeting-delta-ingest sandbox script
 * (build_note_from_transcript.js) so the same transform can run NATIVELY, i.e.
 * without the sandbox's 10-writes-per-minute cap and 128 MB heap. A batch of
 * 20+ meetings tripped both when each note was written from the sandbox; the
 * native path (BuildMeetingNoteFromSinkTool) has neither limit and, like the
 * sink itself, never routes the transcript through the LLM context.
 *
 * This file is intentionally free of any Obsidian/plugin dependency so it is
 * unit-testable in isolation. The tool wrapper does the file I/O.
 */

/** A single Plaud get_transcript block (transaction, outline, ...). */
export interface PlaudBlock {
    data_type?: string;
    data_content?: string;
    [k: string]: unknown;
}

/** One decoded transcript segment. */
interface Segment {
    content?: string;
    speaker?: string;
    original_speaker?: string;
}

/** OKF frontmatter the caller supplies. `uid` is never set here. */
export interface MeetingFrontmatter {
    title?: string;
    description?: string;
    resource?: string;
    timestamp?: string;
    type?: string;
    tags?: string[] | string;
    moc?: string[] | string;
    related?: string[] | string;
}

export interface BuildResult {
    ok: true;
    body: string;
    transcriptChars: number;
    speakerLines: number;
    segmentCount: number;
}

/**
 * Decode the transaction block(s) into segments. get_transcript delivers the
 * segments as a DOUBLY-encoded JSON string inside data_content. Multiple
 * transaction blocks (pagination/merge) are concatenated in order.
 */
function parseSegments(blocks: PlaudBlock[]): Segment[] {
    const txBlocks = blocks.filter(
        (b) => b && b.data_type === 'transaction' && typeof b.data_content === 'string' && b.data_content.trim().length > 0,
    );
    if (txBlocks.length === 0) {
        throw new Error(
            "No 'transaction' block in the get_transcript result. Was get_transcript sinked (not get_note)? " +
            'A get_note sink carries a summary, not transcript segments, and cannot become a transcript note.',
        );
    }
    const segments: Segment[] = [];
    for (const b of txBlocks) {
        let arr: unknown;
        try {
            arr = JSON.parse(b.data_content as string);
        } catch (e) {
            throw new Error('transaction.data_content is not valid JSON: ' + String(e));
        }
        if (Array.isArray(arr)) {
            for (const s of arr) {
                if (s && typeof s === 'object') segments.push(s as Segment);
            }
        }
    }
    return segments;
}

/**
 * Plaud's `start_at` is UTC but arrives as a bare ISO string with no zone
 * marker ("2026-07-24T06:00:27"). Written raw into the note it read 2h behind
 * Plaud's own display in summer. This converts a bare-UTC timestamp to the
 * host's LOCAL wall-clock time, DST-correct (winter +1h, summer +2h in Berlin),
 * because Date resolves the offset from the system zone's rules, not a fixed
 * number.
 *
 * A value that already carries a zone (`Z` or `+hh:mm`) is left as-is: it is
 * either already localized or explicitly zoned, and re-converting would double
 * the shift. An unparseable value is returned unchanged (fail safe).
 */
export function localizePlaudTimestamp(raw: string): string {
    if (!raw) return raw;
    // Only treat a bare "YYYY-MM-DDTHH:MM:SS" (no trailing Z / +hh:mm / -hh:mm) as UTC.
    const bareUtc = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(raw);
    if (!bareUtc) return raw;

    const [, y, mo, d, h, mi, s] = bareUtc;
    // Interpret the components as UTC.
    const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    const dt = new Date(utcMs);
    if (Number.isNaN(dt.getTime())) return raw;

    // Format the LOCAL components back into the same bare-ISO shape.
    const p = (n: number): string => String(n).padStart(2, '0');
    return (
        dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) +
        'T' + p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds())
    );
}

/**
 * Extract the Plaud recording id from a `resource` frontmatter value. This is
 * the dedup key: a recording is "already imported" iff its id already appears
 * in some note's resource property. Kept pure (no Obsidian dep) so the dedup
 * rule is unit-tested; the tool wrapper feeds it metadataCache values.
 *
 * Accepts the three shapes that occur in the vault:
 *   "[plaud:c61779...](https://web.plaud.ai/file/c61779...)"  the OKF link (what we write)
 *   "plaud:c61779..."                                          a bare marker
 *   "...web.plaud.ai/file/c61779..."                           url-only fallback
 * Returns the lowercased id (case-insensitive dedup) or null when none is
 * recognizable. Non-strings return null so a stray array/number never matches.
 */
export function plaudIdFromResource(resource: unknown): string | null {
    if (typeof resource !== 'string' || resource.length === 0) return null;
    // Primary: the plaud:<id> marker (link text or the bare marker).
    const marker = /plaud:\s*['"]?([A-Za-z0-9]{8,})/i.exec(resource);
    if (marker) return marker[1].toLowerCase();
    // Fallback: the plaud.ai url, in case the marker text is ever dropped.
    const url = /plaud\.ai\/(?:file|share)\/([A-Za-z0-9]{8,})/i.exec(resource);
    if (url) return url[1].toLowerCase();
    return null;
}

export function quoteIfNeeded(value: string): string {
    const needsQuote = /[:#[\]{}",&*!|>%@`]/.test(value) || /^\s|\s$/.test(value) || value.includes('\\');
    // AUDIT 2026-07-27 L-1 (CWE-116): escape the backslash BEFORE the quote.
    // The old code escaped only `"`, so a value like `a:b\` became `"a:b\"` --
    // the trailing backslash escaped the closing quote and left the YAML string
    // open (frontmatter corruption / limited YAML injection). Backslash first,
    // then quote, or the escaping backslash we just inserted would be doubled.
    return needsQuote ? '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : value;
}

/**
 * Build the full note markdown (frontmatter + placeholders + transcript) from
 * decoded Plaud blocks. Speaker labels stay RAW (`**Speaker N:**`); naming is a
 * later, evidence-bound step done by meeting-summary, never guessed here.
 */
export function buildMeetingNoteFromBlocks(blocks: PlaudBlock[], frontmatter: MeetingFrontmatter): BuildResult {
    if (!Array.isArray(blocks)) throw new Error('Sink JSON is not an array (unexpected get_transcript shape)');
    const segments = parseSegments(blocks);
    if (segments.length === 0) throw new Error('transaction block had no segments');

    // Segments -> speaker turns; merge consecutive same-speaker segments.
    const turns: Array<{ name: string; text: string }> = [];
    for (const s of segments) {
        const label = String(s.speaker || s.original_speaker || 'Speaker ?').trim() || 'Speaker ?';
        const text = String(s.content || '').replace(/[ \t]+/g, ' ').trim();
        if (!text) continue;
        const last = turns[turns.length - 1];
        if (last && last.name === label) last.text += ' ' + text;
        else turns.push({ name: label, text });
    }
    if (turns.length === 0) throw new Error('transcript empty after cleanup');

    const transcript = turns.map((t) => '**' + t.name + ':** ' + t.text).join('\n\n');

    // Frontmatter. Same shape as the script so the note layout is identical.
    const fmLines: string[] = ['---', 'uid:'];
    const scalar = (k: keyof MeetingFrontmatter): void => {
        const v = frontmatter[k];
        if (v === undefined || v === null || v === '') { fmLines.push(k + ':'); return; }
        fmLines.push(k + ': ' + quoteIfNeeded(String(v)));
    };
    const list = (k: keyof MeetingFrontmatter): void => {
        const v = frontmatter[k];
        if (!v || (Array.isArray(v) && v.length === 0)) { fmLines.push(k + ':'); return; }
        const arr = Array.isArray(v) ? v : [v];
        fmLines.push(k + ':');
        for (const item of arr) fmLines.push('  - ' + String(item));
    };
    scalar('title');
    scalar('description');
    scalar('resource');
    list('tags');
    fmLines.push('type: ' + (frontmatter.type || 'meeting'));
    list('moc');
    list('related');
    // Plaud start_at is bare-UTC; localize so the note matches Plaud's display.
    {
        const ts = frontmatter.timestamp;
        if (ts === undefined || ts === null || ts === '') fmLines.push('timestamp:');
        else fmLines.push('timestamp: ' + quoteIfNeeded(localizePlaudTimestamp(String(ts))));
    }
    fmLines.push('---');

    // No summary placeholders: the note carries the raw transcript only. A
    // horizontal rule (`---`) sits between the frontmatter and the transcript
    // heading so the reading view separates the metadata block from the body.
    // The `## Transkript` heading is H2 (was H3) since it is now the sole body
    // section. meeting-summary adds any summary structure later on demand.
    const body =
        fmLines.join('\n') + '\n\n' +
        '---\n\n' +
        '## Transkript\n\n' +
        transcript + '\n';

    return {
        ok: true,
        body,
        transcriptChars: transcript.length,
        speakerLines: turns.length,
        segmentCount: segments.length,
    };
}
