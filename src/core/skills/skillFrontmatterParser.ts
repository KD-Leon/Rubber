import { detectLineEnding } from '../utils/frontmatterSplit';

/**
 * Shared SKILL.md frontmatter parser.
 *
 * FIX-29-05-02: there used to be two independent parsers for the same file.
 * SelfAuthoredSkillLoader split every line at the first colon (no block-scalar
 * support, and indented lines became phantom top-level keys), while
 * SkillsManager.extractYamlField understood `>` and `|` but only ever pulled
 * four named fields. The two disagreed on the same SKILL.md, which is how a
 * skill could appear in Settings with its real description while the loader
 * held a junk value -- or dropped the skill entirely.
 *
 * Both readers now go through this function so a skill either parses the same
 * way everywhere or not at all.
 *
 * Deliberately NOT a general YAML parser. Supported shape:
 *
 *   key: value                    -- plain scalar, surrounding quotes stripped
 *   key: >                        -- folded: newlines collapse to a single space
 *     line 1
 *     line 2
 *   key: |                        -- literal: newlines preserved
 *     line 1
 *     line 2
 *
 * Keys are recognised at column 0 only. An indented `foo: bar` belongs to the
 * enclosing block scalar (or to a nested mapping we do not model) and never
 * becomes a top-level key -- that is what lets a description carry text like
 * "Trigger: say hello" without silently spawning a `Trigger` key.
 * Anchors, tags, flow mappings and multi-document streams are not supported.
 */

/**
 * Split a SKILL.md into its frontmatter block and body, or null when it carries
 * no YAML frontmatter.
 *
 * RE-AUDIT N-5: FIX-29-05-02 shared the key/value parser but NOT the delimiter,
 * leaving three divergent fence regexes:
 *   SelfAuthoredSkillLoader  /^---\n([\s\S]*?)\n---\n([\s\S]*)$/   (newline required after the fence)
 *   SkillsManager            /^---\n([\s\S]*?)\n---/               (anything after)
 *   WriteSkillTool           /^---\n([\s\S]*?)\n---\n?/            (newline optional)
 * A file ending exactly at its closing fence therefore parsed in SkillsManager
 * and failed in the loader: the skill was advertised in <available_skills>, in
 * MCP getContext and in the SkillsTab, while invoke_skill could not resolve it
 * and it showed up in neither the Notice nor the rejected box. That is the exact
 * split-brain FIX-29-05-03 claims to have closed.
 *
 * FIX-29-05-10 (Issue #71): the fence is now CRLF- and BOM-tolerant. The
 * invariant this function protects was never "the line ending must be LF" --
 * it is that every reader makes the SAME call about where the frontmatter
 * ends. A CRLF `---` decoy is only dangerous while one reader treats it as
 * YAML and another falls through to the HTML-comment block. Since all readers
 * share this function (and declaredSkillTier mirrors the same fence), moving
 * the boundary here moves it for all of them at once, so the invariant holds
 * on both line endings. LF-only additionally rejected every SKILL.md written
 * on Windows, imported from a Windows-packed ZIP, or cloned with
 * core.autocrlf=true, reporting it as "no YAML frontmatter" to a user looking
 * straight at their frontmatter.
 *
 * `frontmatter` comes back LF-normalized so the key parser sees clean values;
 * `body` keeps its original bytes, and `lineEnding` lets writers rebuild the
 * file in its own style (same contract as splitNoteFrontmatter, FIX-44-42).
 */
export function splitSkillFrontmatter(
    content: string,
): { frontmatter: string; body: string; lineEnding: '\n' | '\r\n' } | null {
    const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(content);
    if (!m) return null;
    return {
        frontmatter: m[1].replace(/\r\n/g, '\n'),
        body: m[2] ?? '',
        lineEnding: detectLineEnding(content),
    };
}

/**
 * Remove the common leading indentation from a block.
 *
 * AUDIT FIX-29-05 L-8: used for the HTML-comment metadata shape, whose keys are
 * usually indented inside the comment. Blank lines are ignored when measuring
 * so they cannot pin the common indent at zero.
 */
export function dedent(text: string): string {
    const lines = text.split('\n');
    const indents: string[] = [];
    for (const line of lines) {
        if (line.trim() === '') continue;
        indents.push(/^[ \t]*/.exec(line)?.[0] ?? '');
    }
    if (indents.length === 0) return text;

    // RE-AUDIT N-8: counting indent CHARACTERS breaks on mixed tabs and spaces.
    // A `\tname:` next to a `    description:` shares a length-1 minimum, so
    // slicing one character left `description` with three spaces still on it,
    // `isTopLevelLine` dropped the key, and the user saw "missing required field:
    // description" against a file where it is plainly there -- a regression
    // against this helper's own compatibility goal.
    //
    // Only dedent when every indent is a prefix of the longest one, i.e. the
    // block genuinely shares one indentation style. Otherwise leave the text
    // alone: a wrong dedent loses data, an absent one merely fails to help.
    const longest = indents.reduce((a, b) => (b.length > a.length ? b : a));
    if (!indents.every(i => longest.startsWith(i))) return text;

    const common = indents.reduce((a, b) => (b.length < a.length ? b : a));
    if (common.length === 0) return text;

    return lines
        .map(l => (l.trim() === '' ? l : l.startsWith(common) ? l.slice(common.length) : l))
        .join('\n');
}

/** True when the line starts a new top-level key (column 0, no leading space). */
function isTopLevelLine(line: string): boolean {
    return line.length > 0 && !/^\s/.test(line);
}

export function parseSkillFrontmatterBlock(text: string): Record<string, string> {
    // Null-prototype: keys come straight from an untrusted file. Assigning
    // `__proto__` to a plain object literal is silently dropped rather than
    // polluting Object.prototype, but `constructor` and `toString` DO become
    // own string properties and shadow the built-ins on this object. No current
    // consumer calls those on the frontmatter map, so this is prevention rather
    // than a fix -- it costs one line and removes the whole class.
    // Callers only ever do property reads and Object.keys, both of which work
    // unchanged here, and validateSkillFrontmatter's shape guard is
    // typeof + Array.isArray, which a null-prototype object passes.
    const result = Object.create(null) as Record<string, string>;
    // LF-only split, matching splitFrontmatter. A CRLF file leaves a trailing
    // \r on every line, which the per-value trim() below removes.
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!isTopLevelLine(line)) continue;

        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const key = line.slice(0, colonIdx).trim();
        if (key.length === 0) continue;

        let value = line.slice(colonIdx + 1).trim();

        // AUDIT FIX-29-05 L-5: match the YAML block-scalar header properly
        // instead of comparing against a handful of exact tokens. The header is
        // an indicator (`>` folded or `|` literal), an optional chomping flag
        // (`-` strip, `+` keep), an optional explicit indent digit, and an
        // optional trailing comment. Testing only for '>', '|', '>-', '|-' sent
        // '>+', '|2' and '> # note' down the plain-scalar branch, where the
        // description silently became the header token itself.
        // RE-AUDIT N-11: YAML allows the chomping indicator and the explicit
        // indent in either order (`|2-` as well as `|-2`).
        const blockHeader = /^([>|])(?:[+-]\d*|\d*[+-]?)\s*(?:#.*)?$/.exec(value);
        if (blockHeader) {
            const literal = blockHeader[1] === '|';
            const collected: string[] = [];
            let j = i + 1;
            for (; j < lines.length; j++) {
                const follow = lines[j];
                if (follow.trim() === '') {
                    // A blank line does not end the block. It is a paragraph
                    // break for `|` and folds away for `>`.
                    if (literal) collected.push('');
                    continue;
                }
                if (isTopLevelLine(follow)) break;
                collected.push(follow.replace(/^\s+/, '').replace(/\r$/, ''));
            }
            // Resume the outer scan at the line that ended the block so that
            // line still gets a chance to be read as a key.
            i = j - 1;
            result[key] = (literal ? collected.join('\n') : collected.join(' ')).trim();
            continue;
        }

        // Strip one layer of matching surrounding quotes. The length guard
        // keeps a lone quote character from collapsing to an empty string.
        if (
            value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'")))
        ) {
            value = value.slice(1, -1);
        }

        result[key] = value;
    }

    return result;
}
