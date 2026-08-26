/**
 * ReadFileTool - Read the complete content of a file from the vault
 *
 * This is a read-only tool, so:
 * - isWriteOperation = false
 * - No approval needed
 * - No checkpoint needed
 */

import { TFile } from 'obsidian';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { getInternalAgentFolderPath } from '../../utils/agentFolder';
import { validateVaultRelativePath } from './pathValidation';
import { computeReadBudgetChars } from '../../../types/model-registry';

/**
 * BUG-020: Agents sometimes call `read_file("tmp/task-<id>/result.md")`
 * without the `<agent-folder>/` prefix that the externaliser actually
 * writes. When that happens the vault adapter misses and the tool reports
 * "not found". Detect the shortened form and retry against the full path.
 * Strict prefix check prevents unrelated `tmp.md` files from being
 * redirected, and `..` is rejected to stay on the safe side.
 *
 * Exported for unit tests; keep it pure so it doesn't need the plugin.
 */
export function looksLikeExternalisedTmpPath(path: string): boolean {
    if (!path.startsWith('tmp/task-')) return false;
    const segments = path.split('/');
    if (segments.some((s) => s === '..' || s.includes('\0'))) return false;
    // Must have at least tmp/task-<id>/<filename>
    return segments.length >= 3;
}

interface ReadFileInput {
    path: string;
    offset?: number;
}

export class ReadFileTool extends BaseTool<'read_file'> {
    readonly name = 'read_file' as const;
    readonly isWriteOperation = false;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'read_file',
            description:
                'Read the complete content of a file from the vault. Use this to view notes, check existing content before editing, or gather information. ' +
                'Very large files are chunk-sized to the model context window; if the result is truncated it names the offset to continue with.',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Path to the file relative to vault root (e.g., "folder/note.md")',
                    },
                    offset: {
                        type: 'integer',
                        description:
                            'Character offset to start reading from (default 0). Use the offset value ' +
                            'from a previous truncated read to continue with the next chunk.',
                    },
                },
                required: ['path'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { path, offset } = input as unknown as ReadFileInput;
        const { callbacks } = context;

        try {
            // Validate input
            if (!path) {
                throw new Error('Path parameter is required');
            }

            // AUDIT-034 M-2: validate at the entry of execute. The adapter
            // fallback below uses FileSystemAdapter, which resolves
            // relative segments via Node and would collapse `..` into a
            // read outside the vault root. Same guard as MarkNoteAsMemorySourceTool
            // and WriteFileTool.
            const safePath = validateVaultRelativePath(path);
            if (!safePath) {
                callbacks.pushToolResult(this.formatError(`Invalid path: ${path}`));
                return;
            }

            // Get the file from vault (indexed files)
            const file = this.app.vault.getAbstractFileByPath(safePath);

            let content: string;
            let filePath: string;
            let basename: string;
            let extension: string;

            if (file && file instanceof TFile) {
                // Standard path: file is in Obsidian's vault index
                content = await this.app.vault.read(file);
                filePath = file.path;
                basename = file.basename;
                extension = file.extension;
            } else {
                // Fallback 1: file might be in a hidden/dot folder (e.g. .obsidian-agent/)
                // that Obsidian doesn't index. Use the adapter for direct filesystem access.
                let resolvedPath = safePath;
                let exists = await this.app.vault.adapter.exists(resolvedPath);

                // Fallback 2 (BUG-020): LLMs occasionally call
                // read_file("tmp/task-<id>/result.md") without the
                // agent-folder prefix that the externaliser actually wrote
                // (`<agent-folder>/tmp/task-<id>/result.md`). Retry against
                // the prefixed path when the short form matches the
                // externalisation pattern.
                if (!exists && looksLikeExternalisedTmpPath(safePath)) {
                    const prefixed = `${getInternalAgentFolderPath(this.plugin)}/${safePath}`;
                    if (await this.app.vault.adapter.exists(prefixed)) {
                        resolvedPath = prefixed;
                        exists = true;
                    }
                }

                if (!exists) {
                    callbacks.pushToolResult(
                        this.formatError(new Error(`File not found: ${safePath}`)),
                    );
                    return;
                }
                content = await this.app.vault.adapter.read(resolvedPath);
                filePath = resolvedPath;
                const parts = resolvedPath.split('/');
                const filename = parts[parts.length - 1] ?? resolvedPath;
                const dotIdx = filename.lastIndexOf('.');
                basename = dotIdx > 0 ? filename.substring(0, dotIdx) : filename;
                extension = dotIdx > 0 ? filename.substring(dotIdx + 1) : '';
            }

            // Truncate very large files to prevent context explosion.
            // FIX-PERF-45: the optional offset parameter continues a
            // truncated read at the given character position, so a long
            // transcript is readable in sequential chunks without a
            // search_files/externaliser detour.
            const originalLength = content.length;
            // AUDIT-2026-07-07 L-1: reject non-numeric offsets instead of
            // silently returning an empty slice (NaN propagates through
            // Math.max/slice without erroring).
            const rawOffset = offset === undefined ? 0 : Number(offset);
            if (!Number.isFinite(rawOffset) || rawOffset < 0) {
                callbacks.pushToolResult(this.formatError(
                    `Invalid offset: ${String(offset)}. Expected a non-negative integer.`,
                ));
                return;
            }
            const start = Math.floor(rawOffset);
            if (start > 0 && start >= originalLength) {
                callbacks.pushToolResult(this.formatError(
                    `Offset ${start} is beyond the end of the file (${originalLength} chars).`,
                ));
                return;
            }
            // IMP-01-04-03: budget scales with the serving model's context
            // window (a 1M model reads a 117k transcript in one call; a 128k
            // model keeps a safe cap). Falls back to the 50k floor when no
            // model info is on the context.
            const budget = computeReadBudgetChars(context.apiHandler?.getModel()?.info?.contextWindow);
            const end = Math.min(start + budget, originalLength);
            content = content.slice(start, end);

            // Return formatted content. AUDIT-034 L-15: vault file content is
            // externally-sourced data, so wrap it in the untrusted-content
            // boundary tag that the system prompt's SECURITY BOUNDARY section
            // tells the model to treat as user data, not instructions.
            const result = this.formatUntrustedContent('vault', content, {
                path: filePath,
                basename,
                extension,
            });

            if (end < originalLength) {
                callbacks.pushToolResult(
                    result + `\n[Truncated: showing chars ${start}-${end} of ${originalLength}. ` +
                    `Continue with offset=${end}, or use search_files for specific content.]`,
                );
            } else if (start > 0) {
                callbacks.pushToolResult(
                    result + `\n[Final chunk: chars ${start}-${end} of ${originalLength}.]`,
                );
            } else {
                callbacks.pushToolResult(result);
            }
            callbacks.log(`Successfully read file: ${safePath} (${content.length} chars${start > 0 ? ` from offset ${start}` : ''})`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('read_file', error);
        }
    }
}
