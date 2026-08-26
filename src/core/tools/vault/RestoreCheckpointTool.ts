/**
 * RestoreCheckpointTool - roll a file (or full task) back to a snapshot
 *
 * Write operation:
 * - isWriteOperation = true
 * - Triggers the approval pipeline like every other write tool
 * - Pre-restore snapshot taken explicitly inside the tool so the user
 *   can undo the restore itself (the pipeline's auto-snapshot only
 *   covers toolCall.input.path, which is undefined in mode='task')
 *
 * Behaviour:
 * - mode='file' (default when `path` is set): write the snapshot content
 *   of `path` back into the vault. Does NOT touch other files in the
 *   checkpoint.
 * - mode='task' (default when `path` is omitted): full task rollback --
 *   restore every file in cp.filesChanged and trash every file in
 *   cp.newFiles. Equivalent to the sidebar's "Undo all" button.
 *
 * Part of IMP-01-07-01.
 */

import { TFile } from 'obsidian';
import { refreshOpenMarkdownViewsFor } from '../../utils/refreshMarkdownView';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import type { BatchEditPreview, EditPreview } from '../editPreview';
import { t } from '../../../i18n';

interface RestoreCheckpointInput {
    commitOid: string;
    path?: string;
    mode?: 'file' | 'task';
}

function isVaultRelative(p: string): boolean {
    if (typeof p !== 'string' || p.length === 0) return false;
    if (p.includes('..')) return false;
    if (p.includes('\0')) return false;
    if (p.startsWith('/')) return false;
    return true;
}

export class RestoreCheckpointTool extends BaseTool<'restore_checkpoint'> {
    readonly name = 'restore_checkpoint' as const;
    readonly isWriteOperation = true;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    /**
     * FIX-44-13b: above this many affected files the preview stops reading
     * snapshot blobs and degrades to an honest scope list. Keeps the gate
     * from loading hundreds of file contents for one card (E2 perf).
     */
    private static readonly MAX_DIFF_PREVIEW_FILES = 50;

    /** Current on-disk content, or null when the file does not exist. */
    private async readCurrentContent(path: string): Promise<string | null> {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            return await this.app.vault.read(existing);
        }
        if (await this.app.vault.adapter.exists(path)) {
            return await this.app.vault.adapter.read(path);
        }
        return null;
    }

    /**
     * FIX-44-13b: a restore's target set is fully computable from the
     * checkpoint, so the gate shows REAL diffs: current content vs snapshot
     * content for every restored file, and a deletion entry for every file
     * the task created (task-restore trashes those). Per-entry Skip in the
     * gate is honoured via context.approvedBatchPaths -> restore pathFilter.
     *
     * Degrades to a scope-only path list when a snapshot blob is unreadable
     * (a diff batch that silently omitted the file would understate the
     * blast radius) or when the checkpoint exceeds MAX_DIFF_PREVIEW_FILES.
     * Returns null (plain card) when the plan cannot be computed at all.
     */
    async previewBatch(input: Record<string, unknown>): Promise<BatchEditPreview | null> {
        const { commitOid, path, mode } = input as unknown as RestoreCheckpointInput;
        if (!commitOid || typeof commitOid !== 'string') return null;
        const service = this.plugin.checkpointService;
        if (!service) return null;
        try {
            const cp = await service.getCheckpointByOid(commitOid);
            if (!cp) return null;
            const oidShort = commitOid.slice(0, 8);
            const effectiveMode: 'file' | 'task' = mode ?? (path ? 'file' : 'task');

            if (effectiveMode === 'file') {
                if (!path || !isVaultRelative(path)) return null;
                if (!cp.filesChanged.includes(path) && !(cp.newFiles?.includes(path) ?? false)) return null;
                const after = await service.getSnapshotContent(cp, path);
                if (after === null) return null;
                const before = await this.readCurrentContent(path);
                return {
                    entries: [{ path, before: before ?? '', after, isNew: before === null }],
                    summary: t('ui.approval.scope.restoreCheckpoint', { count: '1', oid: oidShort }),
                };
            }

            const restoredPaths = cp.filesChanged.filter(isVaultRelative);
            const trashedPaths = (cp.newFiles ?? []).filter(isVaultRelative);
            const total = restoredPaths.length + trashedPaths.length;
            if (total === 0) return null;
            const summary = t('ui.approval.scope.restoreCheckpoint', { count: String(total), oid: oidShort });

            const scopeList = (): BatchEditPreview => ({
                entries: [
                    ...restoredPaths.map((p): EditPreview => ({ path: p, before: '', after: '' })),
                    ...trashedPaths.map((p): EditPreview => ({ path: p, before: '', after: '', isDeleted: true })),
                ],
                summary,
                scopeOnly: true,
            });

            if (total > RestoreCheckpointTool.MAX_DIFF_PREVIEW_FILES) {
                return scopeList();
            }

            const entries: EditPreview[] = [];
            for (const p of restoredPaths) {
                const after = await service.getSnapshotContent(cp, p);
                if (after === null) return scopeList();
                const before = await this.readCurrentContent(p);
                entries.push({ path: p, before: before ?? '', after, isNew: before === null });
            }
            for (const p of trashedPaths) {
                const before = await this.readCurrentContent(p);
                entries.push({ path: p, before: before ?? '', after: '', isDeleted: true });
            }
            return { entries, summary };
        } catch (err) {
            console.warn('[Checkpoints] restore_checkpoint previewBatch failed (card fallback):', err);
            return null;
        }
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'restore_checkpoint',
            description:
                'Roll a vault file (or every file a task touched) back to a checkpoint snapshot. '
                + 'Use this after list_checkpoints + diff_checkpoint to recover an earlier version. '
                + 'Mode "file" restores just the path argument; mode "task" restores every file in '
                + 'the checkpoint AND trashes any files the task newly created. The tool takes its '
                + 'own pre-restore snapshot first so the restore can itself be undone via the next '
                + 'list_checkpoints entry.',
            input_schema: {
                type: 'object',
                properties: {
                    commitOid: {
                        type: 'string',
                        description: 'Checkpoint commit oid (40-char lowercase hex), from list_checkpoints.',
                    },
                    path: {
                        type: 'string',
                        description:
                            'Vault-relative file path to restore. Required when mode is "file" (the '
                            + 'default if path is given). Ignored when mode is "task".',
                    },
                    mode: {
                        type: 'string',
                        enum: ['file', 'task'],
                        description:
                            'Optional. "file" restores only `path`. "task" restores every file in the '
                            + 'checkpoint AND trashes newFiles. Default is inferred: "file" when path '
                            + 'is set, "task" when it is not.',
                    },
                },
                required: ['commitOid'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { commitOid, path, mode } = input as unknown as RestoreCheckpointInput;
        const { callbacks } = context;

        try {
            if (!commitOid) throw new Error('commitOid is required');
            const effectiveMode: 'file' | 'task' = mode ?? (path ? 'file' : 'task');
            if (effectiveMode === 'file') {
                if (!path) throw new Error('path is required when mode is "file"');
                if (!isVaultRelative(path)) {
                    throw new Error(`Refused path: ${JSON.stringify(path)} (must be vault-relative)`);
                }
            }

            const service = this.plugin.checkpointService;
            if (!service) throw new Error('Checkpoint service is not initialised.');

            const cp = await service.getCheckpointByOid(commitOid);
            if (!cp) {
                callbacks.pushToolResult(this.formatError(new Error(`Unknown checkpoint oid: ${commitOid}`)));
                return;
            }

            // FEAT-44-02b: the user may have skipped files in the batch gate;
            // the restore (and the pre-restore snapshot) then covers only the
            // approved subset.
            const approved = context.approvedBatchPaths;
            const pathFilter = approved !== undefined ? (p: string) => approved.has(p) : undefined;

            // Pre-restore snapshot: lets the user undo the restore itself. The
            // pipeline auto-snapshot only fires for toolCall.input.path, which
            // is undefined in mode='task' -- so we always run our own snapshot
            // here, covering the union of files we are about to touch.
            const affected = (effectiveMode === 'task'
                ? Array.from(new Set([...cp.filesChanged, ...(cp.newFiles ?? [])]))
                : [path as string]
            ).filter((p) => pathFilter === undefined || pathFilter(p));
            const restoreTaskId = `restore-${Date.now()}`;
            try {
                await service.snapshot(restoreTaskId, affected, 'restore_checkpoint');
            } catch (e) {
                console.warn('[Checkpoints] Pre-restore snapshot failed (non-fatal):', e);
            }

            if (effectiveMode === 'task') {
                const result = await service.restore(cp, pathFilter);
                const ok = result.restored.length;
                const errs = result.errors.length;
                const summary = `Restored ${ok} file(s) from checkpoint ${commitOid.slice(0, 8)}`
                    + (errs > 0 ? `; ${errs} error(s):\n${result.errors.join('\n')}` : '');
                callbacks.pushToolResult(this.formatSuccess(summary));
                callbacks.log(`restore_checkpoint (task): ${ok} restored, ${errs} errors`);
                return;
            }

            // mode === 'file'
            if (!cp.filesChanged.includes(path as string)
                && !(cp.newFiles?.includes(path as string) ?? false)) {
                callbacks.pushToolResult(this.formatError(new Error(
                    `Path ${JSON.stringify(path)} is not part of checkpoint ${commitOid.slice(0, 8)}.`,
                )));
                return;
            }

            const content = await service.getSnapshotContent(cp, path as string);
            if (content === null) {
                callbacks.pushToolResult(this.formatError(new Error(
                    `Snapshot has no content for ${JSON.stringify(path)} -- file may have been new in the task; use mode="task" to trash it.`,
                )));
                return;
            }

            const existing = this.app.vault.getAbstractFileByPath(path as string);
            if (existing instanceof TFile) {
                await this.app.vault.modify(existing, content);
                // FIX-44-11 (FIX-01-07-03 parity): the note is very likely OPEN --
                // skills call open_note right after writing. Without this push the
                // stale CodeMirror buffer saves itself back over the restore on the
                // next sync: the disk is correct, the user sees the old content, and
                // the tool has just reported success. A restore that does not survive
                // an open editor is not a restore.
                await refreshOpenMarkdownViewsFor(this.app, existing, content);
            } else {
                await this.app.vault.adapter.write(path as string, content);
            }

            callbacks.pushToolResult(this.formatSuccess(
                `Restored ${path} (${content.length} chars) from checkpoint ${commitOid.slice(0, 8)}.`,
            ));
            callbacks.log(`restore_checkpoint (file): ${path} from ${commitOid.slice(0, 8)}`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('restore_checkpoint', error);
        }
    }
}
