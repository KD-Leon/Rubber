/**
 * read_notes -- Read one or more vault files with frontmatter, tags, and linked notes.
 */

import { TFile } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import type { McpToolResult } from '../types';
import { validateMcpVaultPath } from './mcpPathValidation';
import { wrapVaultContentForMcp } from '../McpBridge';

/** Upper bound on files read per call, mirrored as maxItems in the schema. */
const MAX_PATHS_PER_CALL = 20;

export async function handleReadNotes(
    plugin: ObsidianAgentPlugin,
    args: Record<string, unknown>,
): Promise<McpToolResult> {
    const paths = args.paths as string[] | undefined;
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
        return { content: [{ type: 'text', text: 'Error: paths parameter is required (array of file paths)' }], isError: true };
    }

    const results: string[] = [];
    const selected = paths.slice(0, MAX_PATHS_PER_CALL);

    for (const path of selected) {
        // AUDIT-006 H-2: Governance check (path traversal, IgnoreService)
        const validation = validateMcpVaultPath(plugin, path, false);
        if (!validation.allowed) {
            results.push(`--- ${path} ---\nError: ${validation.reason}`);
            continue;
        }

        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            results.push(`--- ${path} ---\nError: File not found`);
            continue;
        }

        try {
            const content = await plugin.app.vault.cachedRead(file);
            const cache = plugin.app.metadataCache.getFileCache(file);

            // Frontmatter
            const fm = cache?.frontmatter;
            const fmStr = fm ? Object.entries(fm)
                .filter(([k]) => k !== 'position')
                .map(([k, v]) => `${k}: ${String(v)}`)
                .join('\n') : '';

            // Tags
            const tags: string[] = [];
            if (fm?.tags) {
                const arr = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
                arr.forEach((t: unknown) => tags.push(String(t)));
            }
            if (cache?.tags) {
                cache.tags.forEach(tc => {
                    if (!tags.includes(tc.tag)) tags.push(tc.tag);
                });
            }

            // Linked notes
            const links = cache?.links?.map(l => l.link) ?? [];

            // AUDIT-013 H-4: wrap user-controlled vault content in a
            // trust-boundary tag so the downstream agent treats note bodies
            // and frontmatter as data, not as instructions. Mitigates
            // indirect prompt injection through note content.
            const inner = [
                fmStr ? `Frontmatter:\n${fmStr}` : '',
                tags.length > 0 ? `Tags: ${tags.join(', ')}` : '',
                links.length > 0 ? `Links: ${links.join(', ')}` : '',
                '',
                content,
            ].filter(Boolean).join('\n');
            results.push(`--- ${path} ---\n${wrapVaultContentForMcp(path, inner)}`);
        } catch (e) {
            results.push(`--- ${path} ---\nError: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // FIX-14-00-02: the cap used to drop the surplus without a word, so a
    // caller reading 25 paths took the five missing blocks for empty notes.
    // Naming both numbers makes the omission visible in the answer itself,
    // which the schema limit alone cannot guarantee against a client that
    // ignores it.
    const dropped = paths.length - selected.length;
    if (dropped > 0) {
        results.push(
            `Note: read ${selected.length} of ${paths.length} requested paths. ` +
            `read_notes reads at most ${MAX_PATHS_PER_CALL} paths per call. ` +
            `Request the remaining ${dropped} in a follow-up call.`,
        );
    }

    return { content: [{ type: 'text', text: results.join('\n\n') }] };
}
