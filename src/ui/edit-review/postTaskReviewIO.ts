import { TFile, type App } from 'obsidian';
import { validateVaultRelativePath } from '../../core/tools/vault/pathValidation';
import { safeNoteWrite } from '../../core/utils/safeNoteWrite';

/**
 * FIX-01-07-04: index-independent read/write helpers for the post-task
 * review. The review previously read the after-state via vault.getFileByPath,
 * which returns null for dot-paths outside the vault index (.obsidian/, agent
 * folder). The modal then showed after='' and Apply wrote the empty string
 * back through a raw adapter.write -- zeroing a file the agent had just
 * written correctly (daily-briefing 0-byte incident #2, 2026-07-05).
 */

/**
 * Current on-disk content of a vault-relative path. Falls back to the
 * adapter for paths the vault index does not track. Returns null only when
 * the file does not exist at all.
 */
export async function readCurrentContent(app: App, filePath: string): Promise<string | null> {
    // AUDIT 2026-07-07 PTR-1: the adapter sink is the security-relevant
    // boundary (AUDIT-034 M-1 convention) -- revalidate here so no caller
    // can hand a traversal-laden string to adapter IO.
    const safePath = validateVaultRelativePath(filePath);
    if (!safePath) return null;
    const file = app.vault.getFileByPath(safePath);
    if (file) {
        return app.vault.read(file);
    }
    const adapter = app.vault.adapter;
    if (await adapter.exists(safePath)) {
        return adapter.read(safePath);
    }
    return null;
}

export interface ReviewDecisionInput {
    path: string;
    finalContent: string;
    skipped: boolean;
}

export interface ReviewApplyOutcome {
    /** Paths actually rewritten because the user changed the content. */
    written: string[];
    /** Decisions identical to the reviewed after-state; nothing to write. */
    skippedUnchanged: string[];
    /** Empty/whitespace overwrite of a non-empty file, refused. */
    guarded: string[];
    /** Paths whose write failed; error already logged. */
    failed: string[];
}

/**
 * Apply the user's review decisions. Only decisions that differ from the
 * reviewed after-state are written: an unchanged Apply must be a no-op, not
 * a rewrite (the rewrite is what turned a misread after-state into data
 * loss).
 *
 * FIX-44-49: the write itself is `safeNoteWrite` (forward mode, guards
 * active). This used to be a second hand-rolled copy of the hardened write
 * stack, complete with the getFileByPath-null -> raw adapter fallthrough
 * that FIX-44-19 had already removed from safeNoteWrite, and without
 * ensureParentFolder. One copy of the guards, one place to harden.
 */
export async function applyReviewDecisions(
    app: App,
    decisions: ReviewDecisionInput[],
    reviewedAfter: Map<string, string>,
): Promise<ReviewApplyOutcome> {
    const outcome: ReviewApplyOutcome = { written: [], skippedUnchanged: [], guarded: [], failed: [] };

    for (const d of decisions) {
        if (d.skipped === true) continue;
        if (reviewedAfter.get(d.path) === d.finalContent) {
            outcome.skippedUnchanged.push(d.path);
            continue;
        }
        try {
            // Sink revalidation (AUDIT 2026-07-07 PTR-1 / AUDIT-034 M-1),
            // empty-overwrite guard, frontmatter integrity (FIX-44-09),
            // TFile-vs-adapter resolution + editor refresh (FIX-44-19 /
            // FIX-01-07-03) all live inside safeNoteWrite.
            const written = await safeNoteWrite(app, d.path, d.finalContent);
            if (!written.ok) {
                console.warn(`[PostTaskReview] Refusing to write ${d.path}: ${written.reason}`);
                if (written.guard === 'empty-overwrite' || written.guard === 'frontmatter-integrity') {
                    outcome.guarded.push(d.path);
                } else {
                    outcome.failed.push(d.path);
                }
                continue;
            }
            outcome.written.push(d.path);
        } catch (e) {
            console.error(`[PostTaskReview] Failed to apply decision for ${d.path}:`, e);
            outcome.failed.push(d.path);
        }
    }

    return outcome;
}

/** What a discard actually did. */
export interface RevertOutcome {
    reverted: string[];
    /** Already at their pre-task state; nothing to do. */
    unchanged: string[];
    failed: string[];
}

export interface RevertEntry {
    path: string;
    /** The pre-task content. '' together with isNew means the file did not exist. */
    before: string;
    after: string;
    isNew?: boolean;
}

/**
 * FIX-44-16: undo the agent's changes.
 *
 * The post-task review used to treat "discard" as `return;` -- it only ever had a
 * write path (`applyReviewDecisions`) and no way back. So the button that says
 * the changes go away left them exactly where they were. The user pressed it and
 * the note stayed rewritten.
 *
 * The pre-task content is already in hand (it comes from the task's earliest
 * checkpoint), so a real undo is just writing it back. A file the agent CREATED
 * has no pre-task content -- undoing that means trashing it, not writing an empty
 * file over it.
 */
export async function revertReviewedFiles(app: App, entries: RevertEntry[]): Promise<RevertOutcome> {
    const outcome: RevertOutcome = { reverted: [], unchanged: [], failed: [] };

    for (const e of entries) {
        // AUDIT-034 M-1: revalidate at the sink. A traversal path must never
        // reach adapter IO, no matter who assembled it.
        const safePath = validateVaultRelativePath(e.path);
        if (!safePath) {
            console.error(`[PostTaskReview] Refusing to revert an invalid path: ${e.path}`);
            outcome.failed.push(e.path);
            continue;
        }

        try {
            if (e.isNew === true) {
                // Undoing a creation is a deletion. Trash, never hard-delete, so
                // the undo is itself undoable.
                const file = app.vault.getAbstractFileByPath(safePath);
                if (file instanceof TFile) {
                    await app.fileManager.trashFile(file);
                    outcome.reverted.push(e.path);
                } else {
                    outcome.unchanged.push(e.path);
                }
                continue;
            }

            const current = await readCurrentContent(app, safePath);
            if (current === e.before) {
                outcome.unchanged.push(e.path);
                continue;
            }

            // FIX-44-40: mode 'revert' -- the target is the known-genuine
            // pre-task snapshot, so the forward-edit content guards (empty
            // overwrite, frontmatter integrity) must not veto it. Path
            // validation and editor-refresh stay active inside.
            const written = await safeNoteWrite(app, safePath, e.before, { mode: 'revert' });
            if (!written.ok) {
                console.warn(`[PostTaskReview] Could not revert ${safePath}: ${written.reason}`);
                outcome.failed.push(e.path);
                continue;
            }
            outcome.reverted.push(e.path);
        } catch (err) {
            console.warn(`[PostTaskReview] Revert of ${safePath} threw:`, err);
            outcome.failed.push(e.path);
        }
    }

    return outcome;
}
