/**
 * FEAT-44-10: the approval card for a note edit shows the real diff, BEFORE the
 * write.
 *
 * Until now the only diff the user ever saw was the post-task review, which
 * opens after every write has already landed. Its "reject" merely means "do not
 * apply my manual edits" -- the agent's version stays on disk. A UI that looks
 * like a gate but is not one is worse than no UI at all: it manufactures exactly
 * the false sense of control the approval system exists to provide for real.
 *
 * A tool that can say what it WOULD write, without writing, implements
 * {@link EditPreviewProvider}. The Pipeline hands that preview to the approval
 * callback, the sidebar renders it as a diff, and the write happens only if the
 * user says yes.
 */

/** What a tool would do, if approved. */
export interface EditPreview {
    /** Vault-relative path the tool would touch. */
    path: string;
    /** Current content on disk ('' when the file does not exist yet). */
    before: string;
    /** Content the tool would write ('' for a deletion). */
    after: string;
    /** True when the file does not exist yet. */
    isNew?: boolean;
    /**
     * True when the file is about to be trashed. `after` is '' and the gate
     * renders the whole of `before` as the loss the user is being asked to
     * accept. A deletion has no meaningful edited after-state, so the gate does
     * not honour one.
     */
    isDeleted?: boolean;
}

/**
 * Implemented by note-edit tools that can compute their result without writing.
 *
 * The contract is strict: `previewEdit` MUST return the exact content that
 * `execute` would write for the same input. A preview that differs from the
 * write turns the gate into a lie, which is the whole thing we are fixing.
 * `EditFileTool.previewMatchesExecute.test.ts` pins this.
 *
 * Return `null` when no preview can be produced (bad input, missing file). The
 * Pipeline then falls back to the plain approval card, never to no approval.
 */
export interface EditPreviewProvider {
    previewEdit(input: Record<string, unknown>): Promise<EditPreview | null>;

    /**
     * FIX-44-50: deliver the tool's NON-FILE effects after a user-edited
     * approval.
     *
     * When the user rewrites the previewed diff and approves, the Pipeline
     * writes their version via safeNoteWrite and skips `execute()` entirely --
     * re-running it would overwrite the user's content. For most preview tools
     * the file IS the whole effect and this hook is not needed. Tools whose
     * primary effect lives elsewhere (the memory-source pair: the
     * MemorySourceStore registration) MUST implement it, otherwise the edited
     * branch silently drops that effect: the approved unmark diff lands in the
     * note while the registration keeps extracting it into memory forever.
     *
     * `finalContent` is the user's version exactly as written, so the tool can
     * respect edits that change the effect itself (e.g. the user stripped the
     * marker line from a mark diff). Throwing is allowed: the Pipeline reports
     * the failure in the tool result instead of pretending success.
     */
    applyNonFileEffects?(input: Record<string, unknown>, finalContent: string): Promise<void>;
}

/**
 * FEAT-44-02b / FIX-44-13b: one approval for a whole multi-file operation.
 *
 * The single-file contract above covers tools that write ONE note through the
 * Pipeline. Tools that write MANY files internally (vault_health_check loops
 * over hundreds of notes, extract_zip unpacks an archive, restore_checkpoint
 * rolls a whole task back) used to show a blind name card: the user approved
 * "vault_health_check" without seeing which files it was about to touch.
 *
 * A tool that can enumerate its planned writes WITHOUT writing returns a
 * BatchEditPreview. The Pipeline leads ONE approval over the whole scope; the
 * UI renders it either as a multi-entry diff review (entries carry real
 * before/after) or as a scope list (paths plus an operation summary, when the
 * per-file result depends on processing the tool has not done yet).
 */
export interface BatchEditPreview {
    /**
     * The planned writes, one entry per file. For `scopeOnly` batches the
     * before/after fields are '' and only `path` (plus isNew/isDeleted)
     * carries information.
     */
    entries: EditPreview[];
    /**
     * One-line operation summary shown on the gate ("Extract 12 file(s) from
     * skill.zip into Skills/"). Localised by the tool via t().
     */
    summary: string;
    /**
     * True when per-file diffs are NOT computable up front (the result
     * depends on processing). The UI then renders an honest file-list card
     * instead of a diff review, and the approval does NOT count as
     * diff-reviewed for FIX-44-44 (the post-task review stays the diff
     * surface for those writes).
     */
    scopeOnly?: boolean;
}

/**
 * Ceiling for a reviewable diff batch, shared between the Pipeline and the
 * UI. Above it a multi-entry diff review stops being a review (a four-digit
 * file list is scrolled past, not read), so the Pipeline downgrades the
 * batch to `scopeOnly` BEFORE handing it to the approval callback: the UI
 * then renders the honest scope card and, critically, the approval does NOT
 * count as diff-reviewed (FIX-44-44). Keeping the cap here, in the contract
 * module, is deliberate -- when it lived only in the UI, the Pipeline
 * stamped `diffReviewed` on batches the UI had silently degraded to the
 * scope card, suppressing the post-task review for writes nobody saw.
 */
export const MAX_BATCH_DIFF_ENTRIES = 100;

/**
 * Implemented by multi-file tools that can enumerate their planned writes.
 *
 * Contract:
 * - `previewBatch` MUST NOT write anything. Return null when no preview can
 *   be produced (bad input, nothing to do, dependencies missing); the
 *   Pipeline then falls back to `previewEdit` or the plain card -- never to
 *   no approval.
 * - The entry set MUST cover every file `execute` would touch for the same
 *   input. An entry the preview omits is a write the user never approved.
 * - After an approved batch gate the Pipeline passes the approved paths as
 *   `context.approvedBatchPaths`: the user's remaining subset when entries
 *   were skipped, otherwise (FIX-44-56) the FULL planned entry set. A tool
 *   implementing this interface MUST honour that set: planned writes whose
 *   path is not in it are skipped. That pins the repair to the plan the
 *   user saw even when the vault state drifted while the card was open.
 *   Tools whose internals cannot honour a subset must be rendered
 *   all-or-nothing by the UI (scopeOnly batches are) and may ignore the
 *   full-set pass-through, accepting the drift as a documented limitation.
 */
export interface BatchEditPreviewProvider {
    previewBatch(input: Record<string, unknown>): Promise<BatchEditPreview | null>;
}

export function hasEditPreview(tool: unknown): tool is EditPreviewProvider {
    return typeof (tool as EditPreviewProvider)?.previewEdit === 'function';
}

export function hasBatchEditPreview(tool: unknown): tool is BatchEditPreviewProvider {
    return typeof (tool as BatchEditPreviewProvider)?.previewBatch === 'function';
}

export function hasNonFileEffects(tool: unknown): tool is EditPreviewProvider & {
    applyNonFileEffects: (input: Record<string, unknown>, finalContent: string) => Promise<void>;
} {
    return typeof (tool as EditPreviewProvider)?.applyNonFileEffects === 'function';
}
