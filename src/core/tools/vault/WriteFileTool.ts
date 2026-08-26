/**
 * WriteFileTool - Write content to a file, creating it if needed
 *
 * This is a write operation, so:
 * - isWriteOperation = true
 * - Requires approval (Phase 2)
 * - Creates checkpoint (Phase 3)
 */

import { TFile, TFolder } from 'obsidian';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { getAgentFolderPath } from '../../utils/agentFolder';
import { atomicAdapterWrite } from '../../utils/atomicAdapterWrite';
import { checkFrontmatterIntegrity } from '../../utils/frontmatterGuard';
import type { EditPreview } from '../editPreview';
import { refreshOpenMarkdownViewsFor } from '../../utils/refreshMarkdownView';
import { validateVaultRelativePath } from './pathValidation';

/**
 * BUG-018 follow-up: protected file extensions that the agent must NEVER
 * write directly. These are structured / binary / dual-format files that
 * other tools or plugins own. Letting the agent hallucinate the format
 * (esp. drawio.svg, excalidraw, office formats) produces files that look
 * right but are rejected by the consuming plugin or app.
 *
 * The error message points the agent at the right tool / plugin so it can
 * retry without bouncing through write_file again.
 */
const PROTECTED_FORMATS: { pattern: RegExp; redirect: string }[] = [
    {
        pattern: /\.drawio$/i,
        redirect: 'Drawio / Diagrams.net format. Use the built-in create_drawio tool — it emits a valid '
            + 'mxfile wrapper that the drawio-obsidian and obsidian-diagrams-net plugins accept and open '
            + 'for editing. write_file cannot hand-author the format reliably.',
    },
    {
        pattern: /\.drawio\.svg$/i,
        redirect: 'Drawio-SVG dual format. Use the built-in create_drawio tool with output_path ending in '
            + '.drawio.svg — the tool emits both the SVG preview and the embedded mxfile content-attribute '
            + 'correctly. write_file would ship a broken file that the plugin rejects with "Not a diagram file".',
    },
    {
        pattern: /\.drawio\.png$/i,
        redirect: 'Drawio-PNG dual format requires raster output with embedded mxfile metadata, which the agent '
            + 'cannot author. Use create_drawio with .drawio.svg instead; the plugin exports to PNG on demand '
            + 'from its own editor.',
    },
    {
        pattern: /\.excalidraw(\.md)?$/i,
        redirect: 'Excalidraw format. Use execute_command("obsidian-excalidraw-plugin:excalidraw-autocreate-newtab") '
            + 'if the Excalidraw community plugin is installed, otherwise use the built-in create_excalidraw '
            + 'tool (basic boxes only).',
    },
    {
        pattern: /\.canvas$/i,
        redirect: 'Obsidian canvas format. Use the built-in generate_canvas tool — it knows the JSON shape.',
    },
    {
        pattern: /\.pptx$/i,
        redirect: 'PowerPoint format. Use the built-in create_pptx tool. For template-based decks, plan_presentation first.',
    },
    {
        pattern: /\.docx$/i,
        redirect: 'Word format. Use the built-in create_docx tool.',
    },
    {
        pattern: /\.xlsx$/i,
        redirect: 'Excel format. Use the built-in create_xlsx tool.',
    },
];

interface WriteFileInput {
    path: string;
    content: string;
}

export class WriteFileTool extends BaseTool<'write_file'> {
    readonly name = 'write_file' as const;
    readonly isWriteOperation = true; // Triggers approval + checkpoint

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'write_file',
            description:
                'Write content to a file in the vault, creating it if it does not exist. Use this to create new notes or completely replace existing content.',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Path to the file relative to vault root (e.g., "folder/note.md")',
                    },
                    content: {
                        type: 'string',
                        description: 'The complete content to write to the file',
                    },
                },
                required: ['path', 'content'],
            },
        };
    }

    /**
     * FEAT-44-10: the diff the approval gate shows. Never writes.
     *
     * write_file is the one tool where the "after" needs no computing -- the model
     * hands it over whole. The value of the diff here is the OTHER side: it makes
     * visible how much of the existing note this overwrite is about to throw away.
     */
    async previewEdit(input: Record<string, unknown>): Promise<EditPreview | null> {
        try {
            const { path, content } = input as unknown as WriteFileInput;
            if (!path || content === undefined || content === null) return null;

            const safePath = validateVaultRelativePath(path);
            if (!safePath) return null;

            const existing = this.app.vault.getAbstractFileByPath(safePath);
            if (existing instanceof TFile) {
                return { path: safePath, before: await this.app.vault.read(existing), after: content };
            }
            const adapter = this.app.vault.adapter;
            if (await adapter.exists(safePath)) {
                return { path: safePath, before: await adapter.read(safePath), after: content };
            }
            return { path: safePath, before: '', after: content, isNew: true };
        } catch {
            // A preview is a courtesy, never a gate. Fall back to the plain card.
            return null;
        }
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { path, content } = input as unknown as WriteFileInput;
        const { callbacks } = context;

        try {
            // Validate input
            if (!path) {
                throw new Error('Path parameter is required');
            }
            if (content === undefined || content === null) {
                throw new Error('Content parameter is required');
            }

            // AUDIT-034 M-1: harden write_file against path-traversal at the
            // tool boundary. Without this, the adapter fallback below would
            // accept `.obsidian/../../tmp/pwned.md`: the raw startsWith check
            // matched the configDir prefix and vault.adapter.write resolves
            // relative to the vault basePath, putting the file outside the
            // vault. Mirrors the convention used by MarkNoteAsMemorySource
            // and IngestTriageTool. The normalized return value is used for
            // every downstream lookup, write, and folder creation.
            const safePath = validateVaultRelativePath(path);
            if (!safePath) {
                throw new Error(`Invalid path: ${path}`);
            }

            // BUG-018: refuse halluzinated structured / binary formats so the
            // agent doesn't ship files that pass write_file but fail to open
            // in the consuming plugin / app (e.g. .drawio.svg without a valid
            // mxfile wrapper -> "Not a diagram file").
            for (const { pattern, redirect } of PROTECTED_FORMATS) {
                if (pattern.test(safePath)) {
                    callbacks.pushToolResult(
                        this.formatError(
                            new Error(
                                `write_file refuses ${safePath} because this is a protected format. ${redirect} `
                                    + 'Do NOT retry write_file with this extension. The file would be rejected by the consumer.',
                            ),
                        ),
                    );
                    return;
                }
            }

            // Config-dir paths are not in the vault index. Use adapter directly.
            // FEATURE-0507: also covers the configurable agent folder.
            // AUDIT-034 M-1: safePath has already been normalized and stripped
            // of traversal segments, so the prefix check can no longer be
            // bypassed by `.obsidian/../...`.
            const cfgDir = this.app.vault.configDir;
            const agentDir = getAgentFolderPath(this.plugin);
            if (safePath.startsWith(`${cfgDir}/`) || safePath === agentDir || safePath.startsWith(`${agentDir}/`)) {
                await this.writeViaAdapter(safePath, content, callbacks);
                return;
            }

            // Check if file exists
            const existingFile = this.app.vault.getAbstractFileByPath(safePath);

            if (existingFile) {
                // File exists - modify it
                if (!(existingFile instanceof TFile)) {
                    throw new Error(`Path exists but is not a file: ${safePath}`);
                }

                const existingContent = await this.app.vault.read(existingFile);
                // P0 (2026-07-05 data-loss): do not wipe a finished note when
                // the new content is empty/whitespace-only (lost/truncated arg).
                this.guardDestructiveEmptyOverwrite(safePath, content, existingContent);
                // FIX-44-09: and do not leave the YAML frontmatter unterminated.
                const fmReason = checkFrontmatterIntegrity(existingContent, content);
                if (fmReason) {
                    throw new Error(`Refusing to write "${safePath}": ${fmReason}`);
                }
                await this.app.vault.modify(existingFile, content);
                // FIX-01-07-03: push the new content directly into the open
                // CodeMirror buffer so the editor view shows the write
                // immediately and the next auto-save no longer reverts it.
                await refreshOpenMarkdownViewsFor(this.app, existingFile, content);
                const beforeLines = existingContent.split('\n').length;
                const afterLines = content.split('\n').length;
                const added = Math.max(0, afterLines - beforeLines);
                const removed = Math.max(0, beforeLines - afterLines);
                callbacks.pushToolResult(
                    this.formatSuccess(`File updated: ${safePath} (${content.length} chars)`) +
                    `\n<diff_stats added="${added}" removed="${removed}"/>`
                );
                callbacks.log(`Successfully updated file: ${safePath}`);
            } else {
                // File doesn't exist - create it
                // First ensure parent folder exists
                const parentPath = safePath.substring(0, safePath.lastIndexOf('/'));
                if (parentPath) {
                    await this.ensureFolderExists(parentPath);
                }

                await this.app.vault.create(safePath, content);
                const newLines = content.split('\n').length;
                callbacks.pushToolResult(
                    this.formatSuccess(`File created: ${safePath} (${content.length} chars)`) +
                    `\n<diff_stats added="${newLines}" removed="0"/>`
                );
                callbacks.log(`Successfully created file: ${safePath}`);
            }
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('write_file', error);
        }
    }

    /**
     * Write via vault.adapter for paths outside the vault index (.obsidian/, .obsidian-agent/).
     * These paths are not tracked by Obsidian's file index, so vault.getAbstractFileByPath()
     * and vault.createFolder() don't work reliably for them.
     *
     * AUDIT-034 M-1: defense-in-depth. The caller already normalized the path
     * via validateVaultRelativePath, but the adapter sink is the security-
     * relevant boundary. Re-validate so that any future caller (refactor,
     * new code path) cannot accidentally hand a traversal-laden string to
     * vault.adapter.write / vault.adapter.mkdir.
     */
    private async writeViaAdapter(path: string, content: string, callbacks: ToolExecutionContext['callbacks']): Promise<void> {
        const safePath = validateVaultRelativePath(path);
        if (!safePath) {
            throw new Error(`Invalid path: ${path}`);
        }

        const adapter = this.app.vault.adapter;
        const existed = await adapter.exists(safePath);

        // P0 (2026-07-05 data-loss): refuse to clobber a finished file with
        // empty/whitespace content. Reading the current content only when the
        // new content is empty keeps the common path free of an extra read.
        if (existed && content.trim() === '') {
            const current = await adapter.read(safePath);
            this.guardDestructiveEmptyOverwrite(safePath, content, current);
        }

        // Ensure parent directory exists
        const parentPath = safePath.substring(0, safePath.lastIndexOf('/'));
        if (parentPath) {
            const parentExists = await adapter.exists(parentPath);
            if (!parentExists) {
                await adapter.mkdir(parentPath);
            }
        }

        // P0 (2026-07-05 data-loss): atomic write. adapter.write is a
        // truncate-then-write (fs.writeFile, O_TRUNC) with no temp+rename, so
        // an interruption after the truncate leaves the primary file at 0
        // bytes. This was the daily-briefing 0-byte incident. Stage to a temp
        // sibling and rename over the target so an interrupted write can never
        // destroy the previous good file.
        await atomicAdapterWrite(adapter, safePath, content);

        if (existed) {
            callbacks.pushToolResult(this.formatSuccess(`File updated: ${safePath} (${content.length} chars)`));
            callbacks.log(`Successfully updated file: ${safePath}`);
        } else {
            callbacks.pushToolResult(this.formatSuccess(`File created: ${safePath} (${content.length} chars)`));
            callbacks.log(`Successfully created file: ${safePath}`);
        }
    }

    /**
     * P0 (2026-07-05 data-loss guard). Refuse to overwrite an existing
     * non-empty file with empty or whitespace-only content. The trigger was a
     * same-day daily-briefing rerun whose write_file content argument was lost
     * or truncated (model give-up), which zeroed the finished day-file. Empty
     * NEW files and empty-over-empty writes stay allowed; only destroying real
     * content is blocked, with a message that tells the agent to re-send.
     */
    private guardDestructiveEmptyOverwrite(safePath: string, content: string, existingContent: string): void {
        if (content.trim() === '' && existingContent.trim() !== '') {
            throw new Error(
                `Refusing to overwrite non-empty file ${safePath} with empty content. `
                + 'This guards against wiping a finished file when a tool argument was lost or truncated. '
                + 'Re-send write_file with the full intended content.',
            );
        }
    }

    /**
     * Ensure a folder path exists, creating it if needed
     */
    private async ensureFolderExists(folderPath: string): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);

        if (!folder) {
            // Folder doesn't exist, create it
            await this.app.vault.createFolder(folderPath);
        } else if (!(folder instanceof TFolder)) {
            throw new Error(`Path exists but is not a folder: ${folderPath}`);
        }
    }
}
