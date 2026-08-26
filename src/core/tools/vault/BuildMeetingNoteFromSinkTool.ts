/**
 * BuildMeetingNoteFromSinkTool -- native transcript-to-note transform.
 *
 * The plaud-meeting-delta-ingest skill sinks a Plaud get_transcript result to a
 * scratch JSON file, then turns it into a raw meeting note. Doing that from the
 * sandbox script hit two hard walls on a batch of many meetings: the sandbox
 * write-rate cap (10/min) and the 128 MB heap. This tool does the same
 * transform natively, so a batch of any size runs in one pass, and the
 * transcript never enters the LLM context (it is read from disk, transformed in
 * the plugin, and written back to disk).
 *
 * The transform itself lives in meetingNoteFromSink.ts (pure, unit-tested).
 * This wrapper is the file I/O and the tool contract.
 */

import { TFile } from 'obsidian';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { validateVaultRelativePath } from './pathValidation';
import { atomicAdapterWrite } from '../../utils/atomicAdapterWrite';
import { refreshOpenMarkdownViewsFor } from '../../utils/refreshMarkdownView';
import { buildMeetingNoteFromBlocks, plaudIdFromResource, type MeetingFrontmatter, type PlaudBlock } from './meetingNoteFromSink';

interface BuildMeetingNoteInput {
    sink_path: string;
    note_path: string;
    frontmatter?: MeetingFrontmatter;
    delete_sink?: boolean;
}

export class BuildMeetingNoteFromSinkTool extends BaseTool<'build_meeting_note_from_sink'> {
    readonly name = 'build_meeting_note_from_sink' as const;
    readonly isWriteOperation = true;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'build_meeting_note_from_sink',
            description:
                'Turn a sinked Plaud get_transcript JSON file into a raw meeting note, natively (no sandbox write-rate or heap limit, transcript never enters the LLM). ' +
                'Decodes the transaction segments, merges consecutive same-speaker turns, and writes a note with OKF frontmatter, a horizontal rule, and the transcript as "**Speaker N:** Text" under a "## Transkript" heading. No summary placeholders. ' +
                'Speaker labels stay raw; naming and any summary happen later via the meeting-summary skill. Used by the plaud-meeting-delta-ingest skill; safe to call once per recording in a batch.',
            input_schema: {
                type: 'object',
                properties: {
                    sink_path: {
                        type: 'string',
                        description: 'Vault path of the sinked get_transcript JSON file (e.g. "Inbox/.plaud-sink-{id}.json").',
                    },
                    note_path: {
                        type: 'string',
                        description: 'Target note path (e.g. "Inbox/{title}.md").',
                    },
                    frontmatter: {
                        type: 'object',
                        description:
                            'OKF frontmatter fields: title, resource, timestamp, type ("meeting"). Leave description/tags/moc/related empty; the meeting-summary skill fills them. uid is never set.',
                    },
                    delete_sink: {
                        type: 'boolean',
                        description: 'Delete the scratch sink file after writing the note (default true).',
                    },
                },
                required: ['sink_path', 'note_path'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { sink_path, note_path, frontmatter, delete_sink } = input as unknown as BuildMeetingNoteInput;
        const { callbacks } = context;

        try {
            if (!sink_path) throw new Error('sink_path parameter is required');
            if (!note_path) throw new Error('note_path parameter is required');

            const safeSink = validateVaultRelativePath(sink_path);
            const safeNote = validateVaultRelativePath(note_path);
            if (!safeSink) throw new Error(`Invalid sink_path: ${sink_path}`);
            if (!safeNote) throw new Error(`Invalid note_path: ${note_path}`);

            // Read the sink. The scratch file name starts with a dot
            // (.plaud-sink-...), so it is not in the Obsidian index -- read via
            // the adapter, which handles hidden paths.
            const adapter = this.app.vault.adapter;
            if (!(await adapter.exists(safeSink))) {
                throw new Error(`sink not found: ${safeSink}`);
            }
            const raw = await adapter.read(safeSink);

            let blocks: PlaudBlock[];
            try {
                blocks = JSON.parse(raw) as PlaudBlock[];
            } catch (e) {
                throw new Error('sink is not valid JSON: ' + String(e));
            }

            // Pure transform (throws with a clear message on the wrong shape,
            // e.g. a get_note summary sinked by mistake).
            //
            // SEC 2026-07-25: this runs BEFORE the dedup branch on purpose. The
            // dedup path deletes the sink, and until this reorder the only thing
            // standing between an arbitrary caller-named file and `adapter.remove`
            // was JSON.parse succeeding. Any parseable JSON file could be pointed
            // at via sink_path and destroyed by claiming an already-imported
            // recording id. Validating the Plaud block shape first means a file
            // that is not a transcript sink can never reach the delete.
            const result = buildMeetingNoteFromBlocks(blocks, frontmatter ?? {});

            // Hard dedup guarantee at the write point. The upstream delta scan
            // (search_files) is capped BY DESIGN -- 500 files, 50 hits, 1500 ms
            // (SearchFilesTool) -- so on a real vault it may miss an already
            // imported note and mark the recording as new -> duplicate. This
            // check is the last line of defence: it walks metadataCache
            // (complete, in-memory, kept current even for MOVED notes, no cap)
            // and refuses to write when the plaud id already lives in some other
            // note's resource frontmatter. Independent of the scan, a recording
            // with a known id is never written twice.
            const incomingId = plaudIdFromResource(frontmatter?.resource);
            if (incomingId) {
                const existingPath = this.findNoteWithPlaudId(incomingId, safeNote);
                if (existingPath) {
                    // Clean up the scratch sink so it does not linger, then skip.
                    if (delete_sink !== false) {
                        try { await adapter.remove(safeSink); } catch { /* best effort */ }
                    }
                    callbacks.pushToolResult(
                        this.formatSuccess(
                            `Skipped: recording ${incomingId} is already imported at "${existingPath}". ` +
                            `No duplicate created. Dedup is by the plaud id in the resource frontmatter, ` +
                            `vault-wide (moved notes included).`,
                        ),
                    );
                    callbacks.log(`Skipped duplicate plaud recording ${incomingId} (exists at ${existingPath})`);
                    return;
                }
            }

            // Write the note natively. No write-rate limit on this path.
            const existing = this.app.vault.getAbstractFileByPath(safeNote);
            if (existing instanceof TFile) {
                await this.app.vault.modify(existing, result.body);
                await refreshOpenMarkdownViewsFor(this.app, existing, result.body);
            } else if (existing) {
                throw new Error(`note_path exists but is not a file: ${safeNote}`);
            } else if (await adapter.exists(safeNote)) {
                // Exists but unindexed (rare for a visible folder; be safe).
                await atomicAdapterWrite(adapter, safeNote, result.body);
            } else {
                const parent = safeNote.substring(0, safeNote.lastIndexOf('/'));
                if (parent && !(await adapter.exists(parent))) {
                    await this.app.vault.createFolder(parent).catch(() => { /* concurrent create */ });
                }
                await this.app.vault.create(safeNote, result.body);
            }

            // Delete the scratch sink (default true), best effort.
            if (delete_sink !== false) {
                try {
                    await adapter.remove(safeSink);
                } catch {
                    /* best effort; the hidden scratch file is harmless if it lingers */
                }
            }

            callbacks.pushToolResult(
                this.formatSuccess(
                    `Built meeting note ${safeNote} from ${result.segmentCount} segments ` +
                    `(${result.speakerLines} speaker turns, ${result.transcriptChars} transcript chars). ` +
                    `Raw Speaker N labels kept; run meeting-summary for naming and interpretation.`,
                ),
            );
            callbacks.log(`Built meeting note ${safeNote} from sink ${safeSink}`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('build_meeting_note_from_sink', error);
        }
    }

    /**
     * Vault-wide, uncapped scan over metadataCache for a note that already
     * carries this Plaud id in its resource frontmatter. Returns the first
     * matching path (excluding the target itself) or null. Uses the in-memory
     * frontmatter index -- no file reads, no 500/50/1500ms search cap, and it
     * reflects moves the moment Obsidian re-indexes. Ignored notes are included
     * on purpose: a duplicate is a duplicate even in an ignored folder.
     */
    private findNoteWithPlaudId(plaudId: string, selfPath: string): string | null {
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (file.path === selfPath) continue;
            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (!fm) continue;
            if (plaudIdFromResource(fm.resource) === plaudId) return file.path;
        }
        return null;
    }
}
