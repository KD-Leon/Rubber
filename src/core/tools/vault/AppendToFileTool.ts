/**
 * AppendToFileTool - Append content to end of a file (Sprint 1.1)
 *
 * Useful for: Daily Notes, Logbuch entries, appending sections.
 * More efficient than read_file + write_file when only adding content.
 */

import { TFile, TFolder } from 'obsidian';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { refreshOpenMarkdownViewsFor } from '../../utils/refreshMarkdownView';
import { atomicAdapterWrite } from '../../utils/atomicAdapterWrite';
import { assertSafeVaultPath } from './vaultPathGuard';
import type { EditPreview } from '../editPreview';

interface AppendToFileInput {
    path: string;
    content: string;
    separator?: string;
}

export class AppendToFileTool extends BaseTool<'append_to_file'> {
    readonly name = 'append_to_file' as const;
    readonly isWriteOperation = true;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'append_to_file',
            description:
                'Append content to the end of an existing file. ' +
                'If the file does not exist, it will be created. ' +
                'Use this for adding entries to logs, daily notes, or appending sections to existing notes. ' +
                'For targeted edits within a file, use edit_file instead.',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the file relative to vault root (e.g., "Daily/2025-01-15.md")',
                    },
                    content: {
                        type: 'string',
                        description: 'The content to append to the end of the file.',
                    },
                    separator: {
                        type: 'string',
                        description:
                            'String to insert between existing content and new content (default: "\\n"). ' +
                            'Use "\\n\\n" to add a blank line before the appended content.',
                    },
                },
                required: ['path', 'content'],
            },
        };
    }

    /**
     * FEAT-44-10: what an append produces. Pure -- the diff the user approves and
     * the content that gets written both come from here, so they cannot drift.
     */
    private resolveAppend(currentContent: string, content: string, separator: string): string {
        return currentContent ? currentContent + separator + content : content;
    }

    /** FEAT-44-10: the diff the approval gate shows. Never writes. */
    async previewEdit(input: Record<string, unknown>): Promise<EditPreview | null> {
        try {
            const { path, content, separator = '\n' } = input as unknown as AppendToFileInput;
            if (!path || !content) return null;
            assertSafeVaultPath(path, { paramName: 'path' });

            const existing = this.app.vault.getAbstractFileByPath(path);
            if (existing && !(existing instanceof TFile)) return null;

            let currentContent: string;
            if (existing instanceof TFile) {
                currentContent = await this.app.vault.read(existing);
            } else {
                // FIX-44-41: dot-paths (`.vault-operator/...`) are not in the
                // Obsidian file index, so the lookup above returns null for
                // files that very much exist. Without this adapter fallback the
                // preview claimed "new file" with only the appended chunk as
                // after-content -- and a user-edited approve then wrote that
                // chunk as the FULL file, truncating it. Same fallback as
                // WriteFileTool/EditFileTool (FIX-01-07-04 class).
                const adapter = this.app.vault.adapter;
                if (!(await adapter.exists(path))) {
                    // The file will be created; the whole content is the addition.
                    return { path, before: '', after: content, isNew: true };
                }
                currentContent = await adapter.read(path);
            }

            return {
                path,
                before: currentContent,
                after: this.resolveAppend(currentContent, content, separator),
            };
        } catch {
            // A preview is a courtesy, never a gate. Fall back to the plain card.
            return null;
        }
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { path, content, separator = '\n' } = input as unknown as AppendToFileInput;
        const { callbacks } = context;

        try {
            if (!path) throw new Error('path parameter is required');
            if (!content) throw new Error('content parameter is required');
            // AUDIT-034 M-2: deny escape attempts before touching the vault.
            assertSafeVaultPath(path, { paramName: 'path' });

            const existing = this.app.vault.getAbstractFileByPath(path);
            // FIX-44-41: existing-but-unindexed dot-path files must be appended
            // to, not "created" over. Mirrors the previewEdit fallback so the
            // approved diff is exactly what lands on disk.
            const existsUnindexed = !existing && (await this.app.vault.adapter.exists(path));

            if (existing) {
                if (!(existing instanceof TFile)) {
                    throw new Error(`Path exists but is not a file: ${path}`);
                }
                const currentContent = await this.app.vault.read(existing);
                const newContent = this.resolveAppend(currentContent, content, separator);
                await this.app.vault.modify(existing, newContent);
                // FIX-01-07-03: push the new content directly into the open
                // CodeMirror buffer so the editor view shows the append
                // immediately.
                await refreshOpenMarkdownViewsFor(this.app, existing, newContent);
                const appendedLines = content.split('\n').length;
                callbacks.pushToolResult(
                    this.formatSuccess(`Appended to ${path} (+${appendedLines} lines)`) +
                    `\n<diff_stats added="${appendedLines}" removed="0"/>`
                );
            } else if (existsUnindexed) {
                const adapter = this.app.vault.adapter;
                const currentContent = await adapter.read(path);
                const newContent = this.resolveAppend(currentContent, content, separator);
                // FIX-01-07-04 parity: non-indexed writes go through the atomic
                // temp+rename path, never a raw truncate-then-write that can
                // leave a 0-byte file.
                await atomicAdapterWrite(adapter, path, newContent);
                const appendedLines = content.split('\n').length;
                callbacks.pushToolResult(
                    this.formatSuccess(`Appended to ${path} (+${appendedLines} lines)`) +
                    `\n<diff_stats added="${appendedLines}" removed="0"/>`
                );
            } else {
                // File doesn't exist — create it
                const parentPath = path.substring(0, path.lastIndexOf('/'));
                if (parentPath) {
                    await this.ensureFolderExists(parentPath);
                }
                await this.app.vault.create(path, content);
                const newLines = content.split('\n').length;
                callbacks.pushToolResult(
                    this.formatSuccess(`Created and wrote to ${path} (${newLines} lines)`) +
                    `\n<diff_stats added="${newLines}" removed="0"/>`
                );
            }

            callbacks.log(`Successfully appended to file: ${path}`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('append_to_file', error);
        }
    }

    private async ensureFolderExists(folderPath: string): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            await this.app.vault.createFolder(folderPath);
        } else if (!(folder instanceof TFolder)) {
            throw new Error(`Path exists but is not a folder: ${folderPath}`);
        }
    }
}
