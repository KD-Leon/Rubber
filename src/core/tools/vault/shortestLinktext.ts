import { TFile } from 'obsidian';
import type { App } from 'obsidian';

/**
 * Render a vault path as a wikilink target that respects the user's
 * "New link format" setting (Settings -> Files and Links). Obsidian's
 * `MetadataCache.fileToLinktext` is the canonical source: it returns the
 * shortest unique path when the setting allows, and the full path only
 * when disambiguation is required (e.g. duplicate basenames).
 *
 * Wrap the return value in `[[...]]` at the call site.
 *
 * Fallback: when the file does not exist in the vault (stale edge in
 * a memory record, ghost link, attachment without TFile), strip the
 * .md extension so the bracket wrap still produces a usable wikilink.
 */
export function toShortestLinktext(app: App, path: string): string {
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
        return app.metadataCache.fileToLinktext(file, '', true);
    }
    return path.replace(/\.md$/, '');
}
