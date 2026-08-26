/**
 * FEAT-44-10: the one hardened write used when the USER supplies the content.
 *
 * Two call sites need this: the pre-write approval gate (the user edited the
 * diff before approving) and the post-task review (the user edited afterwards).
 * Both used to be the UI's business, which meant the Pipeline could not reuse
 * them. The guards below are the scar tissue of three separate data-loss
 * incidents, so there is exactly one copy of them.
 */

import { TFile, type App } from 'obsidian';
import { atomicAdapterWrite } from './atomicAdapterWrite';
import { validateVaultRelativePath } from '../tools/vault/pathValidation';
import { checkFrontmatterIntegrity } from './frontmatterGuard';

export type SafeWriteOutcome =
    | { ok: true }
    | {
        ok: false;
        reason: string;
        /**
         * FIX-44-40/49: machine-readable discriminator so callers can triage a
         * guard rejection ("guarded", surfaced to the user as such) from an
         * invalid path or an IO failure ("failed").
         */
        guard?: 'invalid-path' | 'empty-overwrite' | 'frontmatter-integrity';
    };

export interface SafeNoteWriteOptions {
    /**
     * FIX-44-40: direction of the write.
     *
     * 'forward' (default) is a NEW proposal landing on the note -- the empty-
     * overwrite guard (P0 2026-07-05) and the frontmatter-integrity guard
     * (FIX-44-09) judge the incoming content against the current state and
     * refuse anything a past incident taught us to refuse.
     *
     * 'revert' restores a KNOWN-GENUINE earlier state (the post-task review's
     * pre-task checkpoint snapshot). In that direction the two content guards
     * are wrong: a file that was empty before the task, or whose frontmatter
     * was already broken before the task, must be restorable to exactly that
     * state -- the target is historical truth, not a proposal to vet. Only
     * those two guards are skipped; path validation at the sink (AUDIT-034
     * M-1), the TFile-vs-adapter resolution (FIX-44-19), parent-folder
     * creation and the editor-buffer refresh (FIX-01-07-03) stay active.
     */
    mode?: 'forward' | 'revert';
}

/**
 * Write user-approved content to a vault note, refusing anything that a past
 * incident taught us to refuse.
 */
export async function safeNoteWrite(
    app: App,
    path: string,
    content: string,
    options?: SafeNoteWriteOptions,
): Promise<SafeWriteOutcome> {
    const mode = options?.mode ?? 'forward';
    // AUDIT-034 M-1: revalidate at the sink. A traversal-laden path must never
    // reach adapter IO, no matter who assembled it. Active in BOTH modes.
    const safePath = validateVaultRelativePath(path);
    if (!safePath) return { ok: false, reason: `invalid path: ${path}`, guard: 'invalid-path' };

    // FIX-44-19: resolve the file the way every write TOOL resolves it --
    // getAbstractFileByPath + instanceof TFile.
    //
    // This used to call `getFileByPath` alone. When that came back null the write
    // silently fell through to the raw adapter, which does NOT push into the open
    // CodeMirror buffer. The user's hand-edited version landed on disk while the
    // editor kept showing the old content, so their edit looked lost -- until a
    // later tool write refreshed the view and it reappeared out of nowhere.
    const abstract = app.vault.getAbstractFileByPath(safePath);
    const file = abstract instanceof TFile ? abstract : null;

    const current = file !== null
        ? await app.vault.read(file)
        : (await app.vault.adapter.exists(safePath))
            ? await app.vault.adapter.read(safePath)
            : '';

    // FIX-44-40: the two content guards below only apply to FORWARD writes; a
    // revert restores the pre-task snapshot verbatim (see SafeNoteWriteOptions).
    if (mode === 'forward') {
        // P0 (2026-07-05): never wipe a finished note with an empty payload.
        if (content.trim() === '' && current.trim() !== '') {
            return { ok: false, reason: 'refusing to overwrite a non-empty file with empty content', guard: 'empty-overwrite' };
        }

        // FIX-44-09: never leave the YAML frontmatter unterminated.
        const fmReason = checkFrontmatterIntegrity(current, content);
        if (fmReason) return { ok: false, reason: fmReason, guard: 'frontmatter-integrity' };
    }

    if (file !== null) {
        await app.vault.modify(file, content);
    } else {
        // A brand-new file the user approved (and possibly edited) in the diff. The
        // tool would have created the parent folders; we are writing instead of it,
        // so we have to.
        await ensureParentFolder(app, safePath);
        await atomicAdapterWrite(app.vault.adapter, safePath, content);
    }

    // FIX-01-07-03: push into the open CodeMirror buffer, on BOTH paths. Without
    // it the stale buffer saves itself back over the write, and the user watches
    // their own edit disappear.
    const refreshTarget = file ?? (app.vault.getAbstractFileByPath(safePath));
    if (refreshTarget instanceof TFile) {
        const { refreshOpenMarkdownViewsFor } = await import('./refreshMarkdownView');
        await refreshOpenMarkdownViewsFor(app, refreshTarget, content);
    }

    return { ok: true };
}

async function ensureParentFolder(app: App, safePath: string): Promise<void> {
    const parent = safePath.substring(0, safePath.lastIndexOf('/'));
    if (!parent) return;
    if (await app.vault.adapter.exists(parent)) return;
    try {
        await app.vault.createFolder(parent);
    } catch {
        // Racy or already there under a different index state -- the write below
        // is the real test.
    }
}
