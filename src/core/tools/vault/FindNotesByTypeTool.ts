/**
 * FindNotesByTypeTool - find notes by their OKF `type` frontmatter value.
 *
 * The vault's OKF schema keys notes by `type` (topic, concept, meeting,
 * person, ...). Skills that link into the map-of-content structure need the
 * ACTUAL typed notes, not guessed names -- e.g. meeting-summary's `moc`
 * field must point at `type: topic`/`type: concept` notes. This reads the
 * MetadataCache frontmatter (no file reads) and returns matching notes with
 * their tags so the caller can pick the ones relevant to a theme.
 *
 * General vault-intelligence tool (not skill-specific): any skill linking to
 * OKF-typed notes reuses it.
 */

import { BaseTool } from '../BaseTool';
import { sanitizeDirectoryEntry } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';

interface FindNotesByTypeInput {
    types: string[];
    limit?: number;
}

/**
 * High default on purpose: typed notes are a curated set (a few hundred at
 * most) and a TRUNCATED list is worse than a longer one -- the live incident
 * 2026-07-08 showed the model re-calling with a higher limit and then
 * fishing the result out of externalized tmp files when limit=100 cut the
 * alphabetically-late notes.
 */
const DEFAULT_LIMIT = 500;
/** Tags echoed per note; enough for theme matching, keeps the result compact. */
const MAX_TAGS_PER_NOTE = 3;

/** Normalise a frontmatter `type` value (string or array) to a lowercase set. */
function typeValues(raw: unknown): string[] {
    if (typeof raw === 'string') return [raw.toLowerCase()];
    if (Array.isArray(raw)) {
        return raw.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase());
    }
    return [];
}

function tagValues(raw: unknown): string[] {
    if (typeof raw === 'string') return [raw];
    if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
    return [];
}

export class FindNotesByTypeTool extends BaseTool<'find_notes_by_type'> {
    readonly name = 'find_notes_by_type' as const;
    readonly isWriteOperation = false;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'find_notes_by_type',
            description:
                'Find notes by their OKF `type` frontmatter value (e.g. "topic", "concept", "person", "project"). ' +
                'Returns matching notes with their basename (for wikilinks) and tags (to match by theme), read from the ' +
                'metadata cache without opening files. Use this to fill map-of-content links (a meeting note\'s `moc` field ' +
                'should point at type:topic / type:concept notes) or to find typed notes to relate to.',
            input_schema: {
                type: 'object',
                properties: {
                    types: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'OKF type values to match (any-of), e.g. ["topic", "concept"].',
                    },
                    limit: {
                        type: 'number',
                        description: `Maximum notes to return (default ${DEFAULT_LIMIT}).`,
                    },
                },
                required: ['types'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { types, limit = DEFAULT_LIMIT } = input as unknown as FindNotesByTypeInput;
        const { callbacks } = context;

        try {
            if (!Array.isArray(types) || types.length === 0) {
                throw new Error('types must be a non-empty array of OKF type values, e.g. ["topic", "concept"]');
            }
            const wanted = new Set(types.map((t) => String(t).toLowerCase()));
            const ignoreService = this.plugin.ignoreService;

            const matches: { basename: string; path: string; tags: string[] }[] = [];
            for (const file of this.app.vault.getMarkdownFiles()) {
                if (matches.length >= limit) break;
                if (ignoreService.isIgnored(file.path)) continue;
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;
                if (!fm) continue;
                if (!typeValues(fm.type).some((t) => wanted.has(t))) continue;
                matches.push({ basename: file.basename, path: file.path, tags: tagValues(fm.tags) });
            }

            if (matches.length === 0) {
                // AUDIT 2026-07-26 M-6: no vault bytes here, so plain text.
                callbacks.pushToolResult(
                    `No notes found of type [${types.join(', ')}].`,
                );
                return;
            }

            // Compact on purpose: basename (the wikilink target) + a few tags.
            // No file paths, tags capped -- a bloated list crosses the
            // externalize threshold and the model never sees it inline.
            const truncated = matches.length >= limit;
            // AUDIT 2026-07-26 M-6: basenames and tag values are note bytes and
            // went into a hand-rolled wrapper raw. The count line and the
            // truncation note are tool-authored and stay outside the envelope, so
            // the model still obeys them.
            const lines = matches.map((m) => {
                const tags = m.tags.slice(0, MAX_TAGS_PER_NOTE).map((t) => sanitizeDirectoryEntry(String(t), 60));
                const name = sanitizeDirectoryEntry(m.basename, 200);
                return tags.length ? `- [[${name}]]  [${tags.join(', ')}]` : `- [[${name}]]`;
            });
            const header = `Found ${matches.length} note(s) of type [${types.join(', ')}]:`;
            const footer = truncated ? `\n(truncated at ${limit} -- raise limit to see the rest)` : '';
            callbacks.pushToolResult(
                `${header}\n\n${this.formatUntrustedContent('vault', lines.join('\n'), { region: 'notes-by-type' })}${footer}`,
            );
            callbacks.log(`find_notes_by_type: ${matches.length} notes for types [${types.join(', ')}]`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('find_notes_by_type', error);
        }
    }
}
