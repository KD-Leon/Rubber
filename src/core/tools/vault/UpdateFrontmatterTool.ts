/**
 * UpdateFrontmatterTool - Set or update YAML frontmatter fields in a note
 *
 * - Creates the frontmatter block when the note has none
 * - Preserves existing fields not mentioned in updates
 * - Handles list/array values correctly
 *
 * FEAT-44-10: this used to write through Obsidian's
 * `fileManager.processFrontMatter`, which reads, mutates and writes atomically.
 * That is a fine API but it cannot say what it is ABOUT to write, so the
 * approval could only ever be a card with a tool name on it -- never the change
 * itself.
 *
 * The result is now resolved up front by {@link resolveFrontmatterUpdate}, and
 * both `previewEdit` (the diff the user approves) and `execute` (the write) go
 * through that one function. Serialization still uses Obsidian's own
 * `stringifyYaml`, which is what processFrontMatter used internally, so the
 * on-disk shape is unchanged.
 */

import { TFile } from 'obsidian';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import type { EditPreview } from '../editPreview';
import { resolveFrontmatterUpdate } from './frontmatterEdit';
import { checkFrontmatterIntegrity } from '../../utils/frontmatterGuard';
import { refreshOpenMarkdownViewsFor } from '../../utils/refreshMarkdownView';

interface UpdateFrontmatterInput {
    path: string;
    updates: Record<string, unknown>;
    remove?: string[];
}

export class UpdateFrontmatterTool extends BaseTool<'update_frontmatter'> {
    readonly name = 'update_frontmatter' as const;
    readonly isWriteOperation = true;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'update_frontmatter',
            description:
                'Set or update YAML frontmatter fields in a note. Existing fields not mentioned in updates are preserved. Creates the frontmatter block if the note has none. Use this to set tags, status, dates, aliases, or any custom metadata.',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the note relative to vault root.',
                    },
                    updates: {
                        type: 'object',
                        description:
                            'Key-value pairs to set. Values can be strings, numbers, booleans, or arrays. Example: {"status": "done", "tags": ["project", "active"], "priority": 1}',
                    },
                    remove: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional list of frontmatter keys to delete.',
                    },
                },
                required: ['path', 'updates'],
            },
        };
    }

    /**
     * Resolve path + current content, or throw with the same messages `execute`
     * has always produced. Shared by execute and previewEdit.
     */
    private async load(input: Record<string, unknown>): Promise<{ file: TFile; content: string }> {
        const { path, updates } = input as unknown as UpdateFrontmatterInput;
        if (!path) throw new Error('path parameter is required');
        if (!updates || typeof updates !== 'object') throw new Error('updates must be an object');

        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) throw new Error(`File not found: ${path}`);
        if (!(file instanceof TFile)) throw new Error(`Path is not a file: ${path}`);

        return { file, content: await this.app.vault.read(file) };
    }

    /**
     * FEAT-44-10: the diff the approval gate shows. Never writes.
     *
     * Returns null when the update cannot be resolved (missing file, broken
     * existing YAML). The Pipeline then falls back to the plain approval card --
     * never to no approval.
     */
    async previewEdit(input: Record<string, unknown>): Promise<EditPreview | null> {
        try {
            const { path, updates, remove = [] } = input as unknown as UpdateFrontmatterInput;
            const { content } = await this.load(input);
            const { newContent } = resolveFrontmatterUpdate(content, updates, remove);
            return { path, before: content, after: newContent };
        } catch {
            return null;
        }
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { path, updates, remove = [] } = input as unknown as UpdateFrontmatterInput;
        const { callbacks } = context;

        try {
            const { file, content } = await this.load(input);

            const { newContent, changed, block } = resolveFrontmatterUpdate(content, updates, remove);

            // FIX-44-09: a frontmatter tool that leaves the frontmatter broken is
            // the one thing this tool must never do.
            const reason = checkFrontmatterIntegrity(content, newContent);
            if (reason) {
                throw new Error(`Refusing to write "${path}": ${reason}`);
            }

            await this.app.vault.modify(file, newContent);
            // FIX-01-07-03: push into the open CodeMirror buffer, otherwise the
            // stale buffer saves itself back over the write.
            await refreshOpenMarkdownViewsFor(this.app, file, newContent);

            const summary = changed.join(', ');
            // IMP-01-04-03 (Lever C): echo the authoritative post-write frontmatter
            // block so the model has the file's top structure without re-reading
            // the whole file. It now comes from the resolved content directly,
            // which is by construction what landed on disk.
            const echo = '\n' + this.formatUntrustedContent('vault', block, { path, region: 'frontmatter' });

            callbacks.pushToolResult(
                this.formatSuccess(
                    `Updated frontmatter in ${path} — ${summary}. Frontmatter now (no need to re-read the file):`,
                ) + echo,
            );
            callbacks.log(`Updated frontmatter in ${path}`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('update_frontmatter', error);
        }
    }
}
