/**
 * unmark_note_as_memory_source -- FEAT-03-25 / ADR-109.
 *
 * Entfernt die Memory-Source-Markierung. Idempotent. Cascade-Delete
 * der abgeleiteten Facts ist Out-of-Scope dieses Tools (siehe
 * FEAT-03-22 Forget-Right). Optional: entfernt auch
 * `memory-source: true` aus dem Frontmatter.
 */

import { TFile } from 'obsidian';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { validateVaultRelativePath } from './pathValidation';
import type { EditPreview } from '../editPreview';
import { resolveFrontmatterUpdate } from './frontmatterEdit';
import { checkFrontmatterIntegrity } from '../../utils/frontmatterGuard';
import { refreshOpenMarkdownViewsFor } from '../../utils/refreshMarkdownView';
import { MEMORY_SOURCE_MARKER_KEYS as MARKER_KEYS } from './memorySourceMarker';

interface Input {
    note_path: string;
    clear_frontmatter?: boolean;
}

export class UnmarkNoteAsMemorySourceTool extends BaseTool<'unmark_note_as_memory_source'> {
    readonly name = 'unmark_note_as_memory_source' as const;
    readonly isWriteOperation = true;

    constructor(plugin: ObsidianAgentPlugin) { super(plugin); }

    getDefinition(): ToolDefinition {
        return {
            name: 'unmark_note_as_memory_source',
            description:
                'Remove the memory-source marker from a Vault note. The note stays in the vault, '
                + 'but no further re-extractions will be triggered. Already-extracted facts stay '
                + 'until you delete them via the Memory v2 forget-right tools (FEAT-03-22). '
                + 'Optionally clears the `memory-source` frontmatter property as well. Idempotent.',
            input_schema: {
                type: 'object',
                properties: {
                    note_path: { type: 'string', description: 'Vault-relative path.' },
                    clear_frontmatter: {
                        type: 'boolean',
                        description: 'Default true: also remove `memory-source` from the note frontmatter.',
                    },
                },
                required: ['note_path'],
            },
        };
    }

    /**
     * FIX-44-13a: the diff the approval gate shows. Never writes.
     *
     * Same one-resolver pattern as MarkNoteAsMemorySourceTool. Returns null
     * when no marker key is present -- writing in that case would ADD an empty
     * frontmatter block to a note that never had one.
     */
    async previewEdit(input: Record<string, unknown>): Promise<EditPreview | null> {
        try {
            const { note_path, clear_frontmatter = true } = input as unknown as Input;
            if (!clear_frontmatter) return null;   // only the DB-side marker changes
            if (!note_path || typeof note_path !== 'string') return null;
            const safe = validateVaultRelativePath(note_path);
            if (!safe) return null;
            const file = this.plugin.app.vault.getAbstractFileByPath(safe);
            if (!(file instanceof TFile) || file.extension !== 'md') return null;

            const content = await this.plugin.app.vault.read(file);
            const { newContent, changed } = resolveFrontmatterUpdate(content, {}, MARKER_KEYS);
            if (changed.length === 0 || newContent === content) return null;
            return { path: safe, before: content, after: newContent };
        } catch {
            // A preview is a courtesy, never a gate. Fall back to the plain card.
            return null;
        }
    }

    /**
     * FIX-44-50: the user edited the previewed diff and approved -- the
     * Pipeline wrote THEIR version and skipped execute(). The file was only
     * the secondary effect; the primary one (revoking the MemorySourceStore
     * registration, i.e. stopping memory extraction of this note) happens
     * here. Without it the approved unmark left the note registered forever.
     */
    applyNonFileEffects(input: Record<string, unknown>): Promise<void> {
        const { note_path } = input as unknown as Input;
        const safe = validateVaultRelativePath(note_path);
        if (!safe) return Promise.resolve();
        const store = this.plugin.memorySourceStore;
        if (!store) {
            return Promise.reject(new Error(
                'MemorySourceStore not available -- the note is STILL registered as memory-source. '
                + 'Re-run unmark_note_as_memory_source once memory.db is open.',
            ));
        }
        store.remove(safe);
        return Promise.resolve();
    }

    async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<void> {
        const { note_path, clear_frontmatter = true } = input as unknown as Input;
        if (!note_path || typeof note_path !== 'string') {
            ctx.callbacks.pushToolResult(this.formatError('note_path is required'));
            return;
        }
        // AUDIT-016 L-5: shared validateVaultRelativePath
        const safe = validateVaultRelativePath(note_path);
        if (!safe) {
            ctx.callbacks.pushToolResult(this.formatError(`Invalid note path: ${note_path}`));
            return;
        }

        const store = this.plugin.memorySourceStore;
        if (!store) {
            ctx.callbacks.pushToolResult(this.formatError('MemorySourceStore not available.'));
            return;
        }

        const removed = store.remove(safe);

        // FIX-44-53: a swallowed frontmatter failure must not turn into an
        // unconditional success line. The marker would still be in the note,
        // and the FrontmatterIndexer re-registers a marker-carrying,
        // unregistered note on its next pass -- silently undoing the unmark
        // the user just approved.
        let fmFailure: string | null = null;
        if (clear_frontmatter) {
            const file = this.plugin.app.vault.getAbstractFileByPath(safe);
            if (file instanceof TFile && file.extension === 'md') {
                try {
                    // FIX-44-13a: resolve + write through the same function whose
                    // result the approval gate previewed (was: an un-previewable
                    // fileManager.processFrontMatter).
                    const content = await this.plugin.app.vault.read(file);
                    const { newContent, changed } = resolveFrontmatterUpdate(content, {}, MARKER_KEYS);
                    // Only write when a marker actually left the block; the
                    // resolver would otherwise add an empty frontmatter block
                    // to a note that never had one.
                    if (changed.length > 0 && newContent !== content) {
                        // FIX-44-09: never leave the frontmatter broken.
                        const reason = checkFrontmatterIntegrity(content, newContent);
                        if (reason) throw new Error(reason);
                        await this.plugin.app.vault.modify(file, newContent);
                        // FIX-01-07-03: push into the open CodeMirror buffer.
                        await refreshOpenMarkdownViewsFor(this.plugin.app, file, newContent);
                    }
                } catch (e) {
                    console.warn(`[unmark_note_as_memory_source] frontmatter clear failed for ${safe}:`, e);
                    fmFailure = e instanceof Error ? e.message : String(e);
                }
            }
        }

        if (fmFailure) {
            ctx.callbacks.pushToolResult(this.formatError(new Error(
                `${removed
                    ? `DB registration for "${safe}" removed`
                    : `Note "${safe}" was not registered in the DB`}, `
                + `but clearing the 'memory-source' frontmatter property FAILED: ${fmFailure}. `
                + `The marker is still in the note, so the indexer may re-register it on its next pass. `
                + `Fix the note (or retry) to make the unmark stick.`,
            )));
            return;
        }

        ctx.callbacks.pushToolResult(this.formatSuccess(
            removed
                ? `Note "${safe}" no longer marked as memory-source. Existing facts remain.`
                : `Note "${safe}" was not registered as memory-source (no-op).`,
        ));
    }
}
