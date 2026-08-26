/**
 * ComputePlaudDeltaTool -- native "which Plaud recordings are not yet imported?"
 *
 * Replaces the old two-step delta (search_files + the compute_delta sandbox
 * script) with a single native call. The reason: search_files is capped by
 * design (500 files / 50 hits / 1500 ms in SearchFilesTool), so on a real vault
 * it silently misses an already-imported note, marks the recording as new, and
 * a duplicate gets written. This tool scans the COMPLETE, in-memory
 * metadataCache for every note's resource id -- no cap, no file reads, current
 * even for MOVED notes -- and does the set difference against the Plaud list.
 *
 * The transcript never enters this path; only ids and light metadata do. The
 * dedup key is the same plaud id used at the write point
 * (BuildMeetingNoteFromSinkTool), so scan and write agree.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { plaudIdFromResource } from './meetingNoteFromSink';
import { computePlaudDelta, type PlaudFileMeta } from './plaudDelta';

/** Seconds -> "m:ss" for the human-readable pick line. */
function fmtDuration(seconds: number): string {
    if (!seconds || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

export class ComputePlaudDeltaTool extends BaseTool<'compute_plaud_delta'> {
    readonly name = 'compute_plaud_delta' as const;
    readonly isWriteOperation = false;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'compute_plaud_delta',
            description:
                'Given the Plaud recording list (from list_files), return which recordings are NOT yet imported into the vault. ' +
                'Dedup is by the plaud id in each note\'s resource frontmatter, scanned vault-wide over the complete metadata index ' +
                '(no search cap, no file reads, moved notes included). Deterministic, no LLM, transcript never touched. ' +
                'Use this for the delta step instead of search_files: search_files is capped at 500 files / 50 hits and misses notes, causing duplicates.',
            input_schema: {
                type: 'object',
                properties: {
                    plaud_files: {
                        type: 'array',
                        description:
                            'The recordings from plaud list_files: [{id, name, start_at, created_at, duration, serial_number}, ...]. Pass the full list; the tool does the set difference.',
                        items: { type: 'object' },
                    },
                },
                required: ['plaud_files'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;
        try {
            // Accept the array directly, or a JSON string of it (the model sometimes
            // stringifies large arrays). Anything else is an empty list.
            let plaudFiles: PlaudFileMeta[] = [];
            const raw = input.plaud_files;
            if (Array.isArray(raw)) {
                plaudFiles = raw as PlaudFileMeta[];
            } else if (typeof raw === 'string' && raw.trim().startsWith('[')) {
                try {
                    const parsed: unknown = JSON.parse(raw);
                    if (Array.isArray(parsed)) plaudFiles = parsed as PlaudFileMeta[];
                } catch { /* fall through to the empty-list guard */ }
            }

            if (plaudFiles.length === 0) {
                callbacks.pushToolResult(
                    this.formatError(new Error('plaud_files is empty. Call plaud list_files first and pass the full array as plaud_files.')),
                );
                return;
            }

            // Build the existing-id map from the complete metadata index. No cap,
            // no file reads. Ignored notes are included on purpose: a duplicate is
            // a duplicate even in an ignored folder.
            const existingIds = new Map<string, string>();
            for (const file of this.app.vault.getMarkdownFiles()) {
                const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
                if (!fm) continue;
                const id = plaudIdFromResource(fm.resource);
                if (id && !existingIds.has(id)) existingIds.set(id, file.path);
            }

            const delta = computePlaudDelta(plaudFiles, existingIds);

            if (delta.to_ingest.length === 0) {
                callbacks.pushToolResult(
                    `<plaud_delta to_ingest="0" already_imported="${delta.already_have.length}" scanned="${delta.scanned_ids}">\n` +
                    `Everything is up to date: all ${plaudFiles.length} recordings are already imported. Nothing to do.\n` +
                    `</plaud_delta>`,
                );
                callbacks.log(`Plaud delta: 0 new, ${delta.already_have.length} already imported (${delta.scanned_ids} ids scanned)`);
                return;
            }

            // Compact, one line per recording: FULL id (needed for get_transcript
            // and the resource frontmatter), name, start, duration. Kept terse so a
            // normal delta stays under the externalize threshold.
            const lines = delta.to_ingest.map((r) =>
                `- ${r.id} | ${r.name || '(unnamed)'} | ${r.start_at || '?'} | ${fmtDuration(r.duration)}`,
            );
            callbacks.pushToolResult(
                `<plaud_delta to_ingest="${delta.to_ingest.length}" already_imported="${delta.already_have.length}" scanned="${delta.scanned_ids}">\n` +
                `NOT YET IMPORTED (offer these in the ask_followup_question selection, in this order):\n` +
                `${lines.join('\n')}\n` +
                `ALREADY IMPORTED: ${delta.already_have.length} recording(s) skipped (dedup by resource plaud id, vault-wide).\n` +
                `</plaud_delta>`,
            );
            callbacks.log(`Plaud delta: ${delta.to_ingest.length} new, ${delta.already_have.length} already imported (${delta.scanned_ids} ids scanned)`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('compute_plaud_delta', error);
        }
    }
}
