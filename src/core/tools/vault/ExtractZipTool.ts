/**
 * ExtractZipTool — extracts a ZIP archive from the vault into a target
 * folder. Built so the skill-translator (and any other workflow) can
 * unpack ZIPs without juggling jszip inside the sandbox, where dynamic
 * imports are blocked and `vault.readBinary` does not survive the
 * structured-clone bridge.
 *
 * Safety: rejects path-traversal entries and enforces a cumulative
 * uncompressed-size cap (zip-bomb guard). Existing files are skipped
 * by default and the caller has to opt in via `overwrite=true`.
 */

import { BaseTool } from '../BaseTool';
import { sanitizeDirectoryEntry } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import { extractZip, ExtractZipError, type ExtractZipAdapter } from '../../utils/extractZip';
import type { BatchEditPreview } from '../editPreview';
import { t } from '../../../i18n';

interface ExtractZipInput {
    zip_path: string;
    target_folder: string;
    overwrite?: boolean;
    strip_root_folder?: boolean;
    max_uncompressed_bytes?: number;
}

export class ExtractZipTool extends BaseTool<'extract_zip'> {
    readonly name = 'extract_zip' as const;
    readonly isWriteOperation = true;

    private zipAdapter(): ExtractZipAdapter {
        const adapter = this.app.vault.adapter;
        return {
            exists: (p) => adapter.exists(p),
            mkdir: (p) => adapter.mkdir(p),
            writeBinary: (p, data) => adapter.writeBinary(p, data),
            readBinary: (p) => adapter.readBinary(p),
        };
    }

    /**
     * FIX-44-13b: the target file list of an archive is fully computable up
     * front, so the gate shows the exact paths instead of a blind name card.
     * Runs the SAME code path as execute (extractZip with dryRun), so the
     * plan cannot diverge from the extraction. scopeOnly: the archive holds
     * binary and text alike, there is no meaningful per-file text diff.
     *
     * A failed plan (corrupt archive, zip bomb, bad target) returns null --
     * the plain card asks, and execute reports the real error to the model.
     */
    async previewBatch(input: Record<string, unknown>): Promise<BatchEditPreview | null> {
        const params = input as unknown as ExtractZipInput;
        if (typeof params.zip_path !== 'string' || params.zip_path.length === 0) return null;
        if (typeof params.target_folder !== 'string' || params.target_folder.length === 0) return null;
        try {
            // AUDIT 2026-07-26 H-1: the same governance filter execute() uses, so
            // the approval card lists exactly what will be written. Without it the
            // card would advertise entries that are then silently skipped, and a
            // deny-zone path would appear in the preview as if it were allowed.
            const ignore = this.plugin.ignoreService;
            const plan = await extractZip({
                adapter: this.zipAdapter(),
                zipPath: params.zip_path,
                targetFolder: params.target_folder,
                overwrite: params.overwrite,
                stripRootFolder: params.strip_root_folder,
                maxUncompressedBytes: params.max_uncompressed_bytes,
                dryRun: true,
                entryFilter: (absPath) => !ignore.isIgnored(absPath) && !ignore.isProtected(absPath),
            });
            if (plan.writtenFiles.length === 0) return null;
            const overwrittenSet = new Set(plan.overwrittenFiles);
            const entries = plan.writtenFiles.map((rel) => ({
                path: plan.targetRoot ? `${plan.targetRoot}/${rel}` : rel,
                before: '',
                after: '',
                isNew: !overwrittenSet.has(rel),
            }));
            let summary = t('ui.approval.scope.extractZip', {
                count: String(plan.writtenFiles.length),
                zip: params.zip_path,
                folder: plan.targetRoot,
            });
            if (plan.skippedEntries.length > 0) {
                summary += ' ' + t('ui.approval.scope.extractZipSkipped', {
                    count: String(plan.skippedEntries.length),
                });
            }
            return { entries, summary, scopeOnly: true };
        } catch {
            return null;
        }
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'extract_zip',
            description:
                'Extract a .zip / .skill archive from the vault into a target folder. ' +
                'Use this when you need to unpack a ZIP (e.g. a downloaded Anthropic skill, ' +
                'an export bundle, an asset pack). Path-traversal entries are rejected and ' +
                'the cumulative uncompressed size is capped (default 100 MB). Existing files ' +
                'are skipped unless overwrite=true. ' +
                'NEVER try to unpack ZIPs via evaluate_expression — the sandbox cannot bundle ' +
                'jszip and the binary roundtrip is lossy.',
            input_schema: {
                type: 'object',
                properties: {
                    zip_path: {
                        type: 'string',
                        description: 'Vault-relative path to the .zip / .skill file (e.g., "Inbox/skill.zip").',
                    },
                    target_folder: {
                        type: 'string',
                        description: 'Vault-relative destination folder. Will be created if missing. Must not start with "/" or contain "..".',
                    },
                    overwrite: {
                        type: 'boolean',
                        description: 'Overwrite existing files in the target folder. Default: false (existing files are reported as skipped).',
                    },
                    strip_root_folder: {
                        type: 'boolean',
                        description: 'If true and the archive has exactly one top-level folder, strip it so the children land directly in target_folder. Useful for Anthropic-style skill archives (my-skill/SKILL.md → SKILL.md). Default: false.',
                    },
                    max_uncompressed_bytes: {
                        type: 'number',
                        description: 'Cap on cumulative uncompressed bytes (zip-bomb guard). Default: 104857600 (100 MB).',
                    },
                },
                required: ['zip_path', 'target_folder'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;
        const params = input as unknown as ExtractZipInput;

        try {
            if (!params.zip_path) throw new Error('zip_path parameter is required');
            if (!params.target_folder) throw new Error('target_folder parameter is required');

            // FEAT-44-02b: the user may have skipped entries in the batch
            // gate. Only extract the approved subset; the rest is reported
            // as skipped in the result below.
            const approved = context.approvedBatchPaths;

            // AUDIT 2026-07-26 H-1, defense in depth: the COMPOSED entry paths
            // are not tool inputs, so ToolExecutionPipeline.validatePaths never
            // sees them -- it only ever governs zip_path and target_folder. The
            // primary fix is normaliseTarget rejecting "." segments, but a
            // single future normalisation slip would otherwise re-open the whole
            // deny zone. Run every composed path through IgnoreService here too:
            // a governed entry is reported as skipped, never written.
            const ignore = this.plugin.ignoreService;
            const governed = (absPath: string): boolean =>
                !ignore.isIgnored(absPath) && !ignore.isProtected(absPath);

            const result = await extractZip({
                adapter: this.zipAdapter(),
                zipPath: params.zip_path,
                targetFolder: params.target_folder,
                overwrite: params.overwrite,
                stripRootFolder: params.strip_root_folder,
                maxUncompressedBytes: params.max_uncompressed_bytes,
                entryFilter: approved !== undefined
                    ? (absPath) => approved.has(absPath) && governed(absPath)
                    : governed,
            });

            // AUDIT 2026-07-26 M-6: entry names come out of the archive, so they
            // are the most attacker-controlled bytes any tool emits. Counts and
            // the caller's own arguments are trusted and stay in the header.
            const clean = (v: string): string => sanitizeDirectoryEntry(v, 300);
            const stripNote = result.strippedRoot
                ? ` (stripped root folder "${clean(result.strippedRoot)}")`
                : '';
            const header =
                `Extracted ${result.writtenFiles.length} file(s) `
                + `from ${params.zip_path} into ${params.target_folder}${stripNote}.`;
            const body = [
                `Files: ${result.writtenFiles.map(clean).join(', ')}`,
                ...(result.skippedEntries.length > 0
                    ? [`Skipped (existing, use overwrite=true to replace): ${result.skippedEntries.map(clean).join(', ')}`]
                    : []),
            ].join('\n');

            callbacks.pushToolResult(
                `${header}\n${this.formatUntrustedContent('archive', body, { region: 'extracted-entries' })}`,
            );
            callbacks.log(`extract_zip: ${params.zip_path} → ${params.target_folder} (${result.writtenFiles.length} written, ${result.skippedEntries.length} skipped)`);
        } catch (error) {
            if (error instanceof ExtractZipError) {
                callbacks.pushToolResult(this.formatError(`${error.code}: ${error.message}`));
            } else {
                callbacks.pushToolResult(this.formatError(error));
            }
            await callbacks.handleError('extract_zip', error);
        }
    }
}
