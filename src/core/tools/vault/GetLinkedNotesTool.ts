/**
 * GetLinkedNotesTool - Get forward links and backlinks for a note
 *
 * Uses Obsidian's MetadataCache for both directions:
 * - Forward links: notes this file links to ([[wikilinks]] and [md](links))
 * - Backlinks: notes that link to this file
 */

import { TFile } from 'obsidian';
import { isDeniedPath } from './denyZoneFilter';
import { sanitizeDirectoryEntry } from '../BaseTool';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';

interface GetLinkedNotesInput {
    path: string;
    direction?: 'both' | 'forward' | 'backlinks';
}

export class GetLinkedNotesTool extends BaseTool<'get_linked_notes'> {
    readonly name = 'get_linked_notes' as const;
    readonly isWriteOperation = false;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'get_linked_notes',
            description:
                'Get the forward links (notes this note links to) and backlinks (notes that link to this note) for a given file. Useful for understanding note relationships and navigating the knowledge graph.',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the note relative to vault root.',
                    },
                    direction: {
                        type: 'string',
                        enum: ['both', 'forward', 'backlinks'],
                        description: '"both" (default) = forward links + backlinks, "forward" = only links this note makes, "backlinks" = only notes linking to this note.',
                    },
                },
                required: ['path'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { path, direction = 'both' } = input as unknown as GetLinkedNotesInput;
        const { callbacks } = context;

        try {
            if (!path) throw new Error('path parameter is required');

            const file = this.app.vault.getAbstractFileByPath(path);
            if (!file) throw new Error(`File not found: ${path}`);
            if (!(file instanceof TFile)) throw new Error(`Path is not a file: ${path}`);

            // AUDIT 2026-07-26 M-6: note paths and unresolved link TEXT are vault
            // bytes, and the hand-rolled wrapper escaped neither the attribute nor
            // the body. One list row per entry, so a newline in a link cannot
            // forge an extra row either.
            const lines: string[] = [];

            // Forward links
            if (direction === 'both' || direction === 'forward') {
                const cache = this.app.metadataCache.getFileCache(file);
                const links = cache?.links ?? [];
                const embeds = cache?.embeds ?? [];

                const forwardPaths = new Set<string>();
                for (const lc of [...links, ...embeds]) {
                    const resolved = this.app.metadataCache.getFirstLinkpathDest(lc.link, path);
                    if (resolved) {
                        // AUDIT 2026-07-26 M-7: a link that resolves INTO the deny
                        // zone names a note the user hid. Dropped before the count
                        // below, or the number reports how many are hidden.
                        if (isDeniedPath(this.plugin, resolved.path)) continue;
                        forwardPaths.add(resolved.path);
                    } else {
                        // UNRESOLVED links stay: the link TEXT is body content of a
                        // note the caller may already read, not a deny-zone path.
                        forwardPaths.add(sanitizeDirectoryEntry(`${lc.link} (unresolved)`, 200));
                    }
                }

                lines.push(`\nForward links (${forwardPaths.size}):`);
                if (forwardPaths.size > 0) {
                    forwardPaths.forEach((p) => lines.push(`  → ${sanitizeDirectoryEntry(p, 200)}`));
                } else {
                    lines.push('  (none)');
                }
            }

            // Backlinks
            if (direction === 'both' || direction === 'backlinks') {
                // FEAT-19-04-01: aus der edges-Tabelle statt aus Obsidians
                // getBacklinksForFile. Die edges kennen jede Frontmatter-
                // Property (moc/related/resource) UND Body-Links -- dieselbe
                // Menge, die der Health-Check repariert und der
                // Rueckverweis-Block anzeigt. So sieht der Agent nicht laenger
                // eine andere Backlink-Zahl als der Graph. Block-erzeugte
                // Kanten (backlink-block) sind ausgeschlossen, damit ein Hub
                // sich nicht ueber seinen eigenen Block selbst zaehlt.
                const graphStore = this.plugin.graphStore;
                let backlinkPaths: string[];
                if (graphStore) {
                    backlinkPaths = graphStore
                        .getSourcesFor(file.path, { excludeLinkTypes: ['backlink-block'] })
                        .map((s) => s.sourcePath);
                } else {
                    // Fallback, falls der Graph-Index (noch) nicht bereit ist.
                    const backlinks = this.app.metadataCache.getBacklinksForFile(file);
                    backlinkPaths = backlinks ? Object.keys(backlinks.data) : [];
                }

                // AUDIT 2026-07-26 M-7: applies to BOTH branches above, and
                // before the count -- a backlink from a hidden note is a hidden
                // note, whether the graph store or the metadata cache found it.
                backlinkPaths = backlinkPaths.filter((p) => !isDeniedPath(this.plugin, p));

                lines.push(`\nBacklinks (${backlinkPaths.length}):`);
                if (backlinkPaths.length > 0) {
                    backlinkPaths.forEach((p) => lines.push(`  ← ${sanitizeDirectoryEntry(p, 200)}`));
                } else {
                    lines.push('  (none)');
                }
            }

            callbacks.pushToolResult(
                this.formatUntrustedContent('vault', lines.join('\n').trimStart(), { path, direction }),
            );
            callbacks.log(`Linked notes for ${path}`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('get_linked_notes', error);
        }
    }
}
