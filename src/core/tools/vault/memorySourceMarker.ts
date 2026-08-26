/**
 * FIX-44-50: shared memory-source marker knowledge for the mark/unmark pair.
 *
 * The marker key list used to live privately in UnmarkNoteAsMemorySourceTool;
 * the user-edit side-effect hooks in BOTH tools now need it (mark must check
 * whether the user's edited content still carries a truthy marker before
 * registering the note), so it lives here once.
 */

import { parseYaml } from 'obsidian';
import { splitNoteFrontmatter } from '../../utils/frontmatterSplit';

/** Every spelling of the marker that has ever been written or hand-typed. */
export const MEMORY_SOURCE_MARKER_KEYS = ['memory-source', 'memory_source', 'memorySource'];

/**
 * Whether `content` carries a truthy memory-source marker in its frontmatter.
 *
 * Conservative on anything unparseable: broken YAML means the indexer will not
 * see the marker either, so treating it as "no marker" keeps registration and
 * on-disk state consistent.
 */
export function contentCarriesMemorySourceMarker(content: string): boolean {
    try {
        const { fmText } = splitNoteFrontmatter(content);
        if (fmText === null || fmText.trim() === '') return false;
        const parsed: unknown = parseYaml(fmText);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const fm = parsed as Record<string, unknown>;
        return MEMORY_SOURCE_MARKER_KEYS.some((k) => fm[k] === true || fm[k] === 'true');
    } catch {
        return false;
    }
}
