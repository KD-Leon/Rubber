/**
 * FEAT-44-10 (Nachzug): resolve a frontmatter update WITHOUT writing.
 *
 * `update_frontmatter` used to go straight through Obsidian's
 * `fileManager.processFrontMatter`, which reads, mutates and writes in one
 * atomic step. Convenient, but it cannot show you what it is about to do -- and
 * a gate that cannot show the change is not a gate.
 *
 * Simulating processFrontMatter for the preview while still writing through it
 * would be worse than nothing: the diff would come from one code path and the
 * write from another, and the moment they disagree the approval is a lie. So the
 * tool now resolves the new content HERE, shows exactly that, and writes exactly
 * that. One resolver, no divergence.
 *
 * We serialize with Obsidian's own `stringifyYaml`, which is what
 * processFrontMatter uses internally, so the on-disk shape is unchanged
 * (quoting of `[[wikilinks]]`, list style, key order).
 */

import { parseYaml, stringifyYaml } from 'obsidian';
import { splitNoteFrontmatter, renderFrontmatterBlock } from '../../utils/frontmatterSplit';

export interface FrontmatterUpdateResult {
    newContent: string;
    /** Human-readable list of what changed, for the tool result. */
    changed: string[];
    /** The resulting frontmatter block including its fences. */
    block: string;
}

interface SplitNote {
    /** YAML text between the fences, or null when the note has no frontmatter. */
    fmText: string | null;
    /** Everything after the closing fence (or the whole note when there is none). */
    body: string;
}

/**
 * Split a note into frontmatter and body.
 *
 * FIX-44-42: delegates to the shared, CRLF/BOM-tolerant splitter in
 * `src/core/utils/frontmatterSplit.ts`. The line-based approach (instead of the
 * regex form `/^---\n[\s\S]*?\n---/`, which silently fails on the EMPTY block
 * `---\n---` of the OKF scaffolds) lives there now.
 */
export function splitFrontmatter(content: string): SplitNote {
    const { fmText, body } = splitNoteFrontmatter(content);
    return { fmText, body };
}

/**
 * Apply `updates` and `remove` to a note's frontmatter and return the resulting
 * full content. Pure: no vault access, no writes.
 *
 * Throws when the existing frontmatter is not parseable -- we refuse to "repair"
 * a broken YAML block by silently overwriting it.
 */
export function resolveFrontmatterUpdate(
    content: string,
    updates: Record<string, unknown>,
    remove: string[] = [],
): FrontmatterUpdateResult {
    const split = splitNoteFrontmatter(content);
    const { fmText, body } = split;

    let fm: Record<string, unknown> = {};
    if (fmText !== null && fmText.trim() !== '') {
        let parsed: unknown;
        try {
            parsed = parseYaml(fmText);
        } catch (e) {
            throw new Error(
                `Existing frontmatter is not valid YAML (${e instanceof Error ? e.message.split('\n')[0] : String(e)}). ` +
                `Fix the block first; update_frontmatter will not overwrite a broken one.`,
            );
        }
        if (parsed !== null && parsed !== undefined) {
            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('Existing frontmatter is not a key/value block; refusing to overwrite it.');
            }
            fm = { ...(parsed as Record<string, unknown>) };
        }
    }

    const changed: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
        fm[key] = value;
        changed.push(`${key}: ${JSON.stringify(value)}`);
    }
    for (const key of remove) {
        if (key in fm) {
            delete fm[key];
            changed.push(`removed: ${key}`);
        }
    }

    // stringifyYaml({}) yields "{}\n", which is not what an empty frontmatter
    // block looks like on disk. Emit the bare fences instead.
    const yaml = Object.keys(fm).length === 0 ? '' : stripNullValues(stringifyYaml(fm));
    // FIX-44-42: reassemble in the note's OWN line-ending style and keep a
    // leading BOM where there was one -- a frontmatter update must not silently
    // convert a CRLF file to LF or strip its BOM.
    const block = renderFrontmatterBlock(yaml, split.lineEnding);
    const newContent = `${split.bom}${block}${split.lineEnding}${body}`;

    return { newContent, changed, block };
}

/**
 * An empty frontmatter key is written as `resource:` in a note, not as
 * `resource: null`. stringifyYaml spells the null out, which turns every empty
 * key the user never touched into a spurious line in the approval diff -- the
 * gate would be asking them to confirm changes that are not changes.
 */
function stripNullValues(yaml: string): string {
    return yaml
        .split('\n')
        .map((line) => line.replace(/^([A-Za-z0-9_.$-]+):\s+null\s*$/, '$1:'))
        .join('\n');
}
