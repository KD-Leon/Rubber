/**
 * EditReviewModal -- thin Obsidian-Modal wrapper around EditReviewPanel.
 *
 * The pure-logic UI lives in EditReviewPanel (tested in isolation). This file
 * only adapts the panel to the Obsidian Modal lifecycle: open with full-width
 * content area, close on apply/discard/restore.
 *
 * Two entry helpers keep call-sites short:
 *   - showEditReviewModal({app, entries, source}) for inline / agent post-task
 *   - showCheckpointReviewModal({app, entries, source, onRestore}) for read-only
 *
 * Bot-Compliance: no inline-style mutations beyond setProperty, no innerHTML.
 *
 * Related: EPIC-33 Diff-UX-refresh (User-Feedback 2026-06-22).
 */

import { Modal, setIcon, type App } from 'obsidian';
import { EditReviewPanel, type EditReviewEntry, type EditReviewDecision } from './EditReviewPanel';

export type { EditReviewEntry, EditReviewDecision } from './EditReviewPanel';

export interface ShowEditReviewArgs {
    app: App;
    entries: EditReviewEntry[];
    /** Source label shown in the header (e.g. "Inline-AI: Rewrite"). */
    source?: string;
    title?: string;
    /** Overrides the discard-button label (FIX-44-16). */
    discardLabel?: string;
    /** FEAT-44-02: offer "apply, and stop asking for the rest of this run". */
    allowRememberForRun?: boolean;
    /** FEAT-44-02b: read-only batch gate -- no editing surface, Skip stays. */
    readonlyContent?: boolean;
}

export interface EditReviewResult {
    /** Decisions provided by the user via Apply. null when user discarded. */
    decisions: EditReviewDecision[] | null;
    /** FEAT-44-02: the user applied AND asked not to be asked again this run. */
    rememberForRun?: boolean;
    /** FEAT-44-02a: the user applied AND asked not to be asked again this session. */
    rememberForSession?: boolean;
    /**
     * FIX-44-38: HOW the modal ended. `decisions: null` used to be overloaded:
     * the pre-write gate reads it as "reject" (correct for both exits), but the
     * post-task review read it as "revert everything" -- turning a mere Esc / X /
     * backdrop click into the destruction of the whole run's work.
     *
     *   - 'applied':   the Apply button; `decisions` carries the answer.
     *   - 'discarded': the explicit discard / revert button.
     *   - 'dismissed': closed without answering (Esc, the X, the backdrop).
     *
     * Gate callers may keep checking `decisions` (fail-closed either way);
     * callers with a DESTRUCTIVE discard path must branch on this field.
     */
    outcome: 'applied' | 'discarded' | 'dismissed';
}

/**
 * Open the edit-review modal and resolve once the user has applied or
 * discarded. Caller awaits the promise and applies the returned decisions
 * to disk.
 */
export function showEditReviewModal(args: ShowEditReviewArgs): Promise<EditReviewResult> {
    return new Promise((resolve) => {
        const modal = new EditReviewModal(args.app, {
            entries: args.entries,
            mode: 'edit',
            source: args.source,
            title: args.title,
            discardLabel: args.discardLabel,
            allowRememberForRun: args.allowRememberForRun,
            readonlyContent: args.readonlyContent,
            onApply: (decisions, meta) => resolve({
                decisions,
                rememberForRun: meta?.rememberForRun === true,
                rememberForSession: meta?.rememberForSession === true,
                outcome: 'applied',
            }),
            onDiscard: () => resolve({ decisions: null, outcome: 'discarded' }),
            // FIX-44-38: Esc / X / backdrop is NOT the discard button. Callers
            // with a destructive discard path (post-task review) must be able to
            // tell the two apart.
            onDismiss: () => resolve({ decisions: null, outcome: 'dismissed' }),
        });
        modal.open();
    });
}

export interface ShowCheckpointReviewArgs {
    app: App;
    entries: EditReviewEntry[];
    source?: string;
    title?: string;
    onRestore: () => void | Promise<void>;
}

export function showCheckpointReviewModal(args: ShowCheckpointReviewArgs): void {
    const modal = new EditReviewModal(args.app, {
        entries: args.entries,
        mode: 'checkpoint',
        source: args.source,
        title: args.title,
        onRestore: args.onRestore,
    });
    modal.open();
}

interface EditReviewModalOptions {
    entries: EditReviewEntry[];
    mode: 'edit' | 'checkpoint';
    source?: string;
    title?: string;
    discardLabel?: string;
    allowRememberForRun?: boolean;
    readonlyContent?: boolean;
    onApply?: (decisions: EditReviewDecision[], meta?: { rememberForRun: boolean; rememberForSession?: boolean }) => void;
    onDiscard?: () => void;
    /**
     * FIX-44-38: called when the modal closes WITHOUT an explicit button answer
     * (Esc, the X, the backdrop). Falls back to `onDiscard` when absent, so the
     * FIX-44-14 contract holds for every caller: a dismissable gate always
     * answers, and with no dismiss handler the answer stays "no".
     */
    onDismiss?: () => void;
    onRestore?: () => void | Promise<void>;
}

export class EditReviewModal extends Modal {
    private readonly opts: EditReviewModalOptions;
    private panel: EditReviewPanel | null = null;
    /**
     * FIX-44-14: this modal is an approval GATE. The Pipeline awaits its answer
     * inside checkApproval, before the tool runs. Obsidian can close a modal
     * without ever routing through our buttons (Esc, the X, the backdrop), and
     * `onClose` used to settle nothing -- so a dismissed gate left the promise
     * pending and deadlocked the agent loop.
     *
     * Every exit path now goes through {@link settle}, exactly once. Dismissal
     * counts as a rejection: if the user did not say yes, the answer is no.
     */
    private settled = false;

    constructor(app: App, opts: EditReviewModalOptions) {
        super(app);
        this.opts = opts;
        this.modalEl.addClass('agent-edit-review-modal');
    }

    private settle(fn?: () => void): void {
        if (this.settled) return;
        this.settled = true;
        fn?.();
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.panel = new EditReviewPanel({
            containerEl: contentEl,
            entries: this.opts.entries,
            mode: this.opts.mode,
            title: this.opts.title,
            sourceLabel: this.opts.source,
            discardLabel: this.opts.discardLabel,
            allowRememberForRun: this.opts.allowRememberForRun,
            readonlyContent: this.opts.readonlyContent,
            setIcon: (el, name) => setIcon(el, name),
            onApply: (decisions, meta) => {
                try { this.settle(() => this.opts.onApply?.(decisions, meta)); } finally { this.close(); }
            },
            onDiscard: () => {
                try { this.settle(() => this.opts.onDiscard?.()); } finally { this.close(); }
            },
            onRestore: () => {
                // Checkpoint mode has no pending approval to settle.
                const r = this.opts.onRestore?.();
                if (r instanceof Promise) void r.catch((e) => console.warn('[edit-review-modal] onRestore threw:', e));
                this.close();
            },
        });
        this.panel.open();
    }

    onClose(): void {
        // Dismissed without an explicit answer: settle, never hang (FIX-44-14).
        // FIX-44-38: route through onDismiss so callers can distinguish "closed
        // the window" from the explicit discard button -- for the post-task
        // review the latter is destructive (revert all) and must never be
        // triggered by a mere Esc. Without a dismiss handler this stays the
        // old rejection.
        this.settle(() => (this.opts.onDismiss ?? this.opts.onDiscard)?.());

        if (this.panel !== null) {
            this.panel.close();
            this.panel = null;
        }
        const { contentEl } = this;
        contentEl.empty();
    }
}
