/**
 * EditFileTool - Diff-based file editing (Sprint 1.1)
 *
 * Replaces a specific string in a file with a new string.
 * Uses configurable fuzzy matching precision to tolerate minor formatting differences.
 * This is the primary edit mechanism - more precise than write_file (full overwrite).
 *
 * Inspired by Kilo Code's EditFileTool / search_replace approach.
 */

import { TFile } from 'obsidian';
import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import { refreshOpenMarkdownViewsFor } from '../../utils/refreshMarkdownView';
import { atomicAdapterWrite } from '../../utils/atomicAdapterWrite';
import { validateVaultRelativePath } from './pathValidation';
import { checkFrontmatterIntegrity } from '../../utils/frontmatterGuard';
import type { EditPreview } from '../editPreview';

interface EditFileInput {
    path: string;
    old_str: string;
    new_str: string;
    expected_replacements?: number;
}

export class EditFileTool extends BaseTool<'edit_file'> {
    readonly name = 'edit_file' as const;
    readonly isWriteOperation = true;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'edit_file',
            description:
                'Edit a file by replacing a specific string with a new string. ' +
                'Use this to make targeted edits to existing notes without replacing the entire content. ' +
                'The old_str must exactly match the content in the file (including whitespace and newlines). ' +
                'For multi-line replacements, include enough surrounding context in old_str to make it unique. ' +
                'If you need to append content, use append_to_file instead. ' +
                'If you need to create a new file or replace all content, use write_file instead.',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the file relative to vault root (e.g., "folder/note.md")',
                    },
                    old_str: {
                        type: 'string',
                        description:
                            'The exact string to find in the file. Must be unique within the file. ' +
                            'Include surrounding context if the string might appear multiple times.',
                    },
                    new_str: {
                        type: 'string',
                        description:
                            'The string to replace old_str with. Can be empty string to delete old_str.',
                    },
                    expected_replacements: {
                        type: 'number',
                        description:
                            'Number of replacements expected (default: 1). ' +
                            'Set to a higher number only if old_str intentionally appears multiple times.',
                    },
                },
                required: ['path', 'old_str', 'new_str'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { path, old_str, new_str, expected_replacements = 1 } = input as unknown as EditFileInput;
        const { callbacks } = context;

        try {
            if (!path) throw new Error('path parameter is required');
            if (old_str === undefined || old_str === null) throw new Error('old_str parameter is required');
            if (new_str === undefined || new_str === null) throw new Error('new_str parameter is required');

            // AUDIT-034 H-1 / SAST-1-02: normalise the path through the
            // shared vault-relative validator BEFORE any adapter or Vault
            // call. The previous "isHidden = startsWith(.)" gate accepted
            // `.foo/../../etc/passwd` because the first segment starts
            // with a dot, then handed the raw string to adapter.read /
            // adapter.write -- arbitrary filesystem read+write outside
            // the vault. validateVaultRelativePath rejects `..`, `.`,
            // NUL bytes and url-encoded traversal, mirroring the pattern
            // already used by MarkNoteAsMemorySourceTool,
            // UnmarkNoteAsMemorySourceTool and IngestTriageTool.
            const cleanPath = validateVaultRelativePath(path);
            if (!cleanPath) {
                throw new Error(`Invalid file path: ${path}`);
            }

            // FEAT-29-05 follow-up: hidden folders (`.vault-operator/`,
            // `.obsidian/`, ...) live outside Obsidian's TFile index, so the
            // Vault API returns null. Fall back to the adapter -- it handles
            // raw filesystem paths regardless of whether Obsidian indexes
            // them. WriteFileTool and ReadFileTool already do this. Note:
            // we use the validator-normalised cleanPath, not the raw input.
            const isHidden = cleanPath.split('/').some((seg) => seg.startsWith('.'));
            let content: string;
            let file: TFile | null = null;
            if (isHidden) {
                const adapter = this.app.vault.adapter;
                if (!(await adapter.exists(cleanPath))) {
                    throw new Error(`File not found: ${cleanPath}`);
                }
                content = await adapter.read(cleanPath);
            } else {
                const found = this.app.vault.getAbstractFileByPath(cleanPath);
                if (!found) throw new Error(`File not found: ${cleanPath}`);
                if (!(found instanceof TFile)) throw new Error(`Path is not a file: ${cleanPath}`);
                file = found;
                content = await this.app.vault.read(file);
            }

            // FEAT-44-10: one resolver, used by execute AND previewEdit. The diff
            // the user approves is computed by the same code that then writes.
            const { newContent, fuzzy } = this.resolveEdit(
                content, old_str, new_str, expected_replacements, cleanPath,
            );
            this.assertFrontmatterIntact(content, newContent, cleanPath);

            if (file) {
                await this.app.vault.modify(file, newContent);
                // FIX-01-07-03: push the new content directly into the open
                // CodeMirror buffer so the editor view shows the edit
                // immediately. Without this the disk is correct but the user
                // still sees the pre-edit buffer.
                await refreshOpenMarkdownViewsFor(this.app, file, newContent);
            } else {
                // FIX-01-07-04 parity: non-indexed (dot-path) writes go through
                // the atomic temp+rename path, never a raw truncate-then-write
                // that can leave a 0-byte file.
                await atomicAdapterWrite(this.app.vault.adapter, cleanPath, newContent);
            }

            const stats = this.diffStats(content, newContent);
            const { added, removed } = this.diffNums(content, newContent);
            const replWord = expected_replacements === 1 ? 'replacement' : 'replacements';
            const how = fuzzy ? 'fuzzy match applied' : `${expected_replacements} ${replWord}`;
            callbacks.pushToolResult(
                this.formatSuccess(`Edited ${cleanPath} (${how}): ${stats}`) +
                `\n<diff_stats added="${added}" removed="${removed}"/>`
            );
            callbacks.log(`Successfully edited file: ${cleanPath}`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('edit_file', error);
        }
    }

    /**
     * Count how many times needle appears in haystack (non-overlapping)
     */
    private countOccurrences(haystack: string, needle: string): number {
        if (!needle) return 0;
        let count = 0;
        let pos = 0;
        while ((pos = haystack.indexOf(needle, pos)) !== -1) {
            count++;
            pos += needle.length;
        }
        return count;
    }

    /**
     * Replace the first N occurrences of old_str with new_str
     */
    /**
     * FEAT-44-10: what would this edit produce? Pure with respect to the vault:
     * it decides, it does not write.
     *
     * This is THE resolver. `execute` writes what it returns, and `previewEdit`
     * shows what it returns. Any divergence between the two would make the
     * approval diff a lie, so there is exactly one implementation.
     *
     * Throws the same guidance errors the model relied on before (not found,
     * ambiguous fuzzy match, too many occurrences).
     */
    private resolveEdit(
        content: string,
        old_str: string,
        new_str: string,
        expected_replacements: number,
        cleanPath: string,
    ): { newContent: string; fuzzy: boolean } {
        const occurrences = this.countOccurrences(content, old_str);

        if (occurrences === 0) {
            // Fall back to a whitespace-normalized match.
            const fuzzy = this.tryNormalizedMatch(content, old_str, new_str);
            if (fuzzy.kind === 'ambiguous') {
                // FIX-01-05-02: refuse to guess which occurrence was meant. The
                // old behaviour silently rewrote the first hit.
                throw new Error(
                    `old_str matches ${fuzzy.matches} times in "${cleanPath}" after whitespace normalization. ` +
                    `Add more surrounding context to old_str so it identifies a single location.`
                );
            }
            if (fuzzy.kind === 'match') {
                return { newContent: fuzzy.result, fuzzy: true };
            }
            // BUG-032 / FIX-01-05-01: a large new_str means edit_file is the
            // wrong tool -- the diff payload is brittle and JSON-streaming can
            // truncate the call. Imperative wording, threshold 1000 chars.
            const newStrSize = (new_str ?? '').length;
            const sizeHint = newStrSize >= 1000
                ? ` Note: new_str is ${newStrSize} chars. Use write_file instead to replace the whole file, or append_to_file to add at the end. edit_file is for targeted small edits, not large rewrites -- retrying with the same large new_str will keep failing.`
                : '';
            throw new Error(
                `old_str not found in file "${cleanPath}". ` +
                `Read the file first to get the exact bytes (whitespace, blank lines, trailing newlines all count) and retry with a shorter, more unique old_str.${sizeHint}`
            );
        }

        if (occurrences > expected_replacements) {
            throw new Error(
                `old_str appears ${occurrences} times in "${cleanPath}" but expected_replacements is ${expected_replacements}. ` +
                `Add more surrounding context to old_str to make it unique, or increase expected_replacements.`
            );
        }

        return {
            newContent: this.replaceFirst(content, old_str, new_str, expected_replacements),
            fuzzy: false,
        };
    }

    /**
     * FEAT-44-10: the diff the approval card shows. Never writes.
     *
     * Returns null when the edit cannot be resolved (file missing, old_str not
     * found). The Pipeline then falls back to the plain approval card -- never
     * to no approval at all.
     */
    async previewEdit(input: Record<string, unknown>): Promise<EditPreview | null> {
        try {
            const path = typeof input['path'] === 'string' ? input['path'] : '';
            const old_str = typeof input['old_str'] === 'string' ? input['old_str'] : '';
            const new_str = typeof input['new_str'] === 'string' ? input['new_str'] : '';
            const rawExpected = input['expected_replacements'];
            const expected = typeof rawExpected === 'number' ? rawExpected : 1;
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

            const { newContent } = this.resolveEdit(content, old_str, new_str, expected, cleanPath);
            return { path: cleanPath, before: content, after: newContent };
        } catch {
            // A preview is a courtesy, never a gate. If it fails, the caller
            // still asks for approval -- just without the diff.
            return null;
        }
    }

    /**
     * FIX-44-09: refuse to write a result that would leave the YAML frontmatter
     * broken.
     *
     * An old_str is allowed to span the closing "---" of the frontmatter, and a
     * note whose body contains a horizontal rule right after that fence makes
     * this depressingly easy to hit: the model picks `"---\n---\n..."`, the match
     * is genuine, the replacement eats the fence, and the whole body ends up
     * inside the YAML block. The edit was performed exactly as requested, which
     * is precisely why the tool has to check the result rather than the request.
     */
    private assertFrontmatterIntact(before: string, after: string, path: string): void {
        const reason = checkFrontmatterIntegrity(before, after);
        if (reason) {
            throw new Error(`Refusing to write "${path}": ${reason}`);
        }
    }

    private replaceFirst(content: string, oldStr: string, newStr: string, count: number): string {
        let result = content;
        let replaced = 0;
        let searchFrom = 0;
        while (replaced < count) {
            const idx = result.indexOf(oldStr, searchFrom);
            if (idx === -1) break;
            result = result.substring(0, idx) + newStr + result.substring(idx + oldStr.length);
            searchFrom = idx + newStr.length;
            replaced++;
        }
        return result;
    }

    /**
     * Fallback: locate `oldStr` in `content` under whitespace-lenient
     * normalisation and replace ONLY the matched region of the ORIGINAL
     * content -- not the whole file.
     *
     * FIX-01-05-02: the previous implementation normalised the whole file
     * (`[ \t]+` -> ` `, CRLF -> LF, `.trim()`) and persisted the normalised
     * blob, silently collapsing tab-indented code fences, aligned tables,
     * YAML frontmatter and CRLF line endings anywhere in the file. The
     * blast radius spanned the entire content while the agent had only
     * asked for a punctual edit. The new behaviour normalises only for the
     * SEARCH step, maps the normalised hit back to an original-content
     * range via the dedicated index mapper, and splices `newStr` into
     * exactly that range so untouched lines remain byte-identical.
     *
     * Multi-match ambiguity is escalated to the caller as `ambiguous`
     * instead of silently picking the first hit -- the caller turns it
     * into an actionable tool error so the agent adds context.
     */
    private tryNormalizedMatch(
        content: string,
        oldStr: string,
        newStr: string,
    ): { kind: 'match'; result: string } | { kind: 'ambiguous'; matches: number } | { kind: 'none' } {
        // No .trim() on body normalisation so positions stay mappable back
        // to the original. We only trim the search needle.
        const normalizeBody = (s: string): string => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
        const normContent = normalizeBody(content);
        const normOld = normalizeBody(oldStr).trim();
        if (!normOld) return { kind: 'none' };

        const firstIdx = normContent.indexOf(normOld);
        if (firstIdx === -1) return { kind: 'none' };
        const lastIdx = normContent.lastIndexOf(normOld);
        if (lastIdx !== firstIdx) {
            // Multi-match ambiguity: count occurrences for the error message.
            let matches = 0;
            let pos = 0;
            while ((pos = normContent.indexOf(normOld, pos)) !== -1) {
                matches++;
                pos += normOld.length;
            }
            return { kind: 'ambiguous', matches };
        }

        const origStart = this.mapNormToOrigIndex(content, firstIdx);
        const origEnd = this.mapNormToOrigIndex(content, firstIdx + normOld.length);
        if (origStart < 0 || origEnd < 0 || origEnd < origStart) {
            return { kind: 'none' };
        }

        return {
            kind: 'match',
            result: content.slice(0, origStart) + newStr + content.slice(origEnd),
        };
    }

    /**
     * Walk the original content and the (CRLF->LF, [\t ]+->' ') normalised
     * projection in lockstep so a normalised character index maps back to
     * the matching index in the original string. Whitespace runs and CRLF
     * pairs both collapse to a single normalised character; we treat them
     * as atomic when stepping the original cursor.
     *
     * Returns -1 if the target index can't be reached (defensive; the
     * caller should fall back to no-match).
     */
    private mapNormToOrigIndex(orig: string, targetNormIdx: number): number {
        if (targetNormIdx === 0) return 0;
        let origIdx = 0;
        let normIdx = 0;
        while (origIdx < orig.length && normIdx < targetNormIdx) {
            const c = orig[origIdx];
            if (c === '\r' && orig[origIdx + 1] === '\n') {
                origIdx += 2;
                normIdx += 1;
            } else if (c === ' ' || c === '\t') {
                let runEnd = origIdx;
                while (runEnd < orig.length && (orig[runEnd] === ' ' || orig[runEnd] === '\t')) runEnd++;
                origIdx = runEnd;
                normIdx += 1;
            } else {
                origIdx += 1;
                normIdx += 1;
            }
        }
        return normIdx === targetNormIdx ? origIdx : -1;
    }

    /**
     * Generate +N/-N diff stats string
     */
    private diffStats(before: string, after: string): string {
        const beforeLines = before.split('\n').length;
        const afterLines = after.split('\n').length;
        const diff = afterLines - beforeLines;
        if (diff > 0) return `+${diff} lines`;
        if (diff < 0) return `${diff} lines`;
        return 'same line count';
    }

    /**
     * Return numeric added/removed line counts for diff badge
     */
    private diffNums(before: string, after: string): { added: number; removed: number } {
        const beforeLines = before.split('\n').length;
        const afterLines = after.split('\n').length;
        return {
            added: Math.max(0, afterLines - beforeLines),
            removed: Math.max(0, beforeLines - afterLines),
        };
    }
}
