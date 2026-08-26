/**
 * FIX-44-42: ONE frontmatter fence rule for the whole codebase.
 *
 * Before this module, three places decided independently what counts as a
 * frontmatter fence, and two of them (`frontmatterEdit.splitFrontmatter`,
 * `frontmatterGuard.extractFrontmatter`) compared lines against the exact
 * string '---' after `split('\n')`. On a note with Windows line endings the
 * line is '---\r', on a note with a UTF-8 BOM the first line is '\uFEFF---':
 * both made the existing block invisible, so `update_frontmatter` prepended a
 * SECOND block on top of the first, and the integrity guard (FIX-44-09) that
 * exists to catch exactly this class of corruption was blind for the same
 * reason. A regression against the old `fileManager.processFrontMatter` write
 * path, which tolerates CRLF.
 *
 * The splitter here tolerates '\r\n' line endings and a leading BOM, and it
 * reports the file's own line-ending style so callers can reassemble the note
 * WITHOUT silently converting a CRLF file to LF.
 *
 * Line-based on purpose: the regex form (`/^---\n[\s\S]*?\n---/`) silently
 * fails on an EMPTY frontmatter block (`---\n---`), which is exactly the shape
 * the OKF scaffolds use.
 *
 * Deliberately NOT unified here: `OutputModeGenerator.splitFrontmatter`
 * (src/core/ingest/OutputModeGenerator.ts). Its trim-based fence rule is
 * already CRLF-tolerant, and its contract is different -- it returns the raw
 * block INCLUDING the fences plus the absorbed blank line, for ingest
 * reassembly. Adopting this splitter there would change that blank-line
 * semantic without fixing anything.
 */

const BOM = '\uFEFF';

export interface NoteFrontmatterSplit {
    /** '\uFEFF' when the note starts with a BOM, else ''. */
    bom: string;
    /** Dominant line-ending style of the note; used for reassembly. */
    lineEnding: '\n' | '\r\n';
    /** True when the first line (BOM aside) is a frontmatter fence. */
    opensWithFence: boolean;
    /**
     * YAML between the fences, LF-normalized for parsing. '' for an empty
     * block, null when the note has no well-formed block (either it never
     * opens with a fence, or the opening fence is never closed -- callers
     * that care distinguish the two via {@link opensWithFence}).
     */
    fmText: string | null;
    /**
     * Everything after the closing fence, with its ORIGINAL line endings
     * untouched. The whole note (minus BOM) when there is no block.
     */
    body: string;
}

/** A fence line, with or without the CR of a CRLF line ending. */
function isFence(line: string): boolean {
    return line === '---' || line === '---\r';
}

function stripCr(line: string): string {
    return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Dominant line-ending style; mixed files go with the majority. */
export function detectLineEnding(text: string): '\n' | '\r\n' {
    const crlf = (text.match(/\r\n/g) ?? []).length;
    if (crlf === 0) return '\n';
    const loneLf = (text.match(/\n/g) ?? []).length - crlf;
    return crlf >= loneLf ? '\r\n' : '\n';
}

/**
 * Split a note into frontmatter and body, tolerating CRLF and a leading BOM.
 */
export function splitNoteFrontmatter(content: string): NoteFrontmatterSplit {
    const bom = content.startsWith(BOM) ? BOM : '';
    const text = bom ? content.slice(BOM.length) : content;
    const lineEnding = detectLineEnding(text);
    const lines = text.split('\n');

    if (!isFence(lines[0] ?? '')) {
        return { bom, lineEnding, opensWithFence: false, fmText: null, body: text };
    }
    for (let i = 1; i < lines.length; i++) {
        if (isFence(lines[i])) {
            return {
                bom,
                lineEnding,
                opensWithFence: true,
                fmText: lines.slice(1, i).map(stripCr).join('\n'),
                // Joining with '\n' restores the original bytes: each line
                // still carries its own trailing '\r' when the file is CRLF.
                body: lines.slice(i + 1).join('\n'),
            };
        }
    }
    // Opening fence with no closing fence: the note is already broken. Report
    // it as fence-open-but-blockless rather than swallowing the whole file.
    return { bom, lineEnding, opensWithFence: true, fmText: null, body: text };
}

/**
 * Render a frontmatter block (fences included, no trailing newline after the
 * closing fence) in the note's own line-ending style.
 *
 * @param yamlLf LF-normalized YAML text ending in '\n', or '' for a bare
 *               empty block.
 */
export function renderFrontmatterBlock(yamlLf: string, lineEnding: '\n' | '\r\n'): string {
    const yaml = lineEnding === '\n' ? yamlLf : yamlLf.replace(/\n/g, lineEnding);
    return `---${lineEnding}${yaml}---`;
}
