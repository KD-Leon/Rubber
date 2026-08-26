/**
 * SetBlockAnchorsTool - batch block-anchor insertion (IMP-01-09-01).
 *
 * Takes `[{find, id}]` and appends `^block-<id>` at the end of each matched
 * paragraph in one write, using the pure blockAnchorMatcher (exact ->
 * whitespace/punctuation-normalized -> fuzzy token alignment). Returns a
 * deterministic `{set, missed, ambiguous}` signal so the meeting-summary
 * skill no longer needs the fragile `evaluate_expression(text.indexOf(...))`
 * debug loop that drove ~15 sandbox round-trips on ASR-garbled transcripts.
 *
 * Write-path parity with EditFileTool: path is validated first (AUDIT-034
 * H-1), dot-path/hidden files go through atomicAdapterWrite (FIX-01-07-04),
 * indexed files go through vault.modify + editor-buffer refresh (FIX-01-07-03).
 */

import { TFile } from 'obsidian';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { refreshOpenMarkdownViewsFor } from '../../utils/refreshMarkdownView';
import { atomicAdapterWrite } from '../../utils/atomicAdapterWrite';
import { validateVaultRelativePath } from './pathValidation';
import { applyAnchors, type AnchorRequest } from './blockAnchorMatcher';
import type { EditPreview } from '../editPreview';

interface SetBlockAnchorsInput {
    path: string;
    anchors: AnchorRequest[];
    within_section?: string;
}

/** Fail-closed cap on batch size (CWE-400, AUDIT 2026-07-08 L-1). A summary has tens of anchors, not hundreds. */
const MAX_ANCHORS = 500;

export class SetBlockAnchorsTool extends BaseTool<'set_block_anchors'> {
    readonly name = 'set_block_anchors' as const;
    readonly isWriteOperation = true;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'set_block_anchors',
            description:
                'Insert block-reference anchors (^block-<id>) at the end of matched passages in a note, in a single call. ' +
                'Pass an array of {find, id}: for each, find is a quoted passage from the note and id is a short slug or number. ' +
                'Matching is robust to whitespace, punctuation and minor transcription differences (fuzzy), so find does not have to be byte-exact. ' +
                'Returns which ids were set, which were not found (missed) and which were ambiguous (matched more than one place) -- use that to fix or drop the corresponding links. ' +
                'Idempotent: an id already present in the note is left as-is. Use this instead of many edit_file calls or evaluate_expression when placing block anchors for a summary. ' +
                'Pass within_section to confine anchoring to one section (e.g. the transcript) so a summary written above it never captures the anchors.',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the note relative to vault root (e.g., "Inbox/Meeting.md").',
                    },
                    within_section: {
                        type: 'string',
                        description:
                            'Optional heading text (e.g. "Transkript"). When set, anchors are placed ONLY inside that section ' +
                            '(from its heading to the next heading of equal or higher level), so a find whose wording matches ' +
                            'a summary written above the transcript can never anchor into that summary. If the section is not ' +
                            'found, nothing is anchored (every id reported missed).',
                    },
                    anchors: {
                        type: 'array',
                        description: 'Anchors to place. Each item is {find, id}.',
                        items: {
                            type: 'object',
                            properties: {
                                find: {
                                    type: 'string',
                                    description: 'A passage from the note that identifies where the anchor goes. Need not be byte-exact.',
                                },
                                id: {
                                    type: 'string',
                                    description: 'Anchor id (letters, digits, hyphen, underscore). Becomes ^block-<id>.',
                                },
                            },
                            required: ['find', 'id'],
                        },
                    },
                },
                required: ['path', 'anchors'],
            },
        };
    }

    /**
     * FEAT-44-10: the diff the approval gate shows. Never writes.
     *
     * This tool sprays anchor ids through a note's body -- a live run put 41 of
     * them into a user's interview transcript. That is precisely the kind of
     * change nobody should have to approve blind.
     *
     * `applyAnchors` is already pure, so preview and execute share it by
     * construction and cannot drift.
     */
    async previewEdit(input: Record<string, unknown>): Promise<EditPreview | null> {
        try {
            const { path, anchors, within_section } = input as unknown as SetBlockAnchorsInput;
            if (!path || !Array.isArray(anchors) || anchors.length === 0) return null;

            const cleanPath = validateVaultRelativePath(path);
            if (!cleanPath) return null;

            const isHidden = cleanPath.split('/').some((seg) => seg.startsWith('.'));
            let content: string;
            if (isHidden) {
                const adapter = this.app.vault.adapter;
                if (!(await adapter.exists(cleanPath))) return null;
                content = await adapter.read(cleanPath);
            } else {
                const found = this.app.vault.getAbstractFileByPath(cleanPath);
                if (!(found instanceof TFile)) return null;
                content = await this.app.vault.read(found);
            }

            const result = applyAnchors(content, anchors, { restrictToSection: within_section });
            // Nothing matched: no change to show, and execute would not write
            // either. Fall back to the plain card.
            if (result.text === content) return null;

            return { path: cleanPath, before: content, after: result.text };
        } catch {
            return null;
        }
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { path, anchors, within_section } = input as unknown as SetBlockAnchorsInput;
        const { callbacks } = context;

        try {
            if (!path) throw new Error('path parameter is required');
            if (!Array.isArray(anchors) || anchors.length === 0) {
                throw new Error('anchors parameter is required and must be a non-empty array of {find, id}');
            }
            if (anchors.length > MAX_ANCHORS) {
                throw new Error(
                    `Too many anchors (${anchors.length}); the limit is ${MAX_ANCHORS}. ` +
                    'A meeting summary needs tens of anchors, not hundreds -- split the work or set fewer.',
                );
            }

            // AUDIT-034 H-1: normalise + reject traversal BEFORE any adapter/vault call.
            const cleanPath = validateVaultRelativePath(path);
            if (!cleanPath) throw new Error(`Invalid file path: ${path}`);

            const isHidden = cleanPath.split('/').some((seg) => seg.startsWith('.'));
            let content: string;
            let file: TFile | null = null;
            if (isHidden) {
                const adapter = this.app.vault.adapter;
                if (!(await adapter.exists(cleanPath))) throw new Error(`File not found: ${cleanPath}`);
                content = await adapter.read(cleanPath);
            } else {
                const found = this.app.vault.getAbstractFileByPath(cleanPath);
                if (!found) throw new Error(`File not found: ${cleanPath}`);
                if (!(found instanceof TFile)) throw new Error(`Path is not a file: ${cleanPath}`);
                file = found;
                content = await this.app.vault.read(file);
            }

            const result = applyAnchors(content, anchors, { restrictToSection: within_section });

            // Only write when the matcher actually changed something.
            if (result.text !== content) {
                if (file) {
                    await this.app.vault.modify(file, result.text);
                    await refreshOpenMarkdownViewsFor(this.app, file, result.text);
                } else {
                    await atomicAdapterWrite(this.app.vault.adapter, cleanPath, result.text);
                }
            }

            const fmt = (ids: Array<string | number>): string => (ids.length ? `[${ids.join(', ')}]` : '[]');
            const parts = [
                `Set ${result.set.length} block anchor(s) in ${cleanPath}.`,
                `set=${fmt(result.set)}`,
                `missed=${fmt(result.missed)}`,
                `ambiguous=${fmt(result.ambiguous)}`,
            ];
            if (result.missed.length || result.ambiguous.length) {
                parts.push(
                    'For missed ids, quote the passage more closely; for ambiguous ids, add surrounding context. ' +
                    'Do not leave a summary link on an id that is not in set.',
                );
            }
            callbacks.pushToolResult(this.formatSuccess(parts.join(' ')));
            callbacks.log(`set_block_anchors: ${cleanPath} set=${result.set.length} missed=${result.missed.length} ambiguous=${result.ambiguous.length}`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('set_block_anchors', error);
        }
    }
}
