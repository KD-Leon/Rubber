/**
 * EditReviewPanel -- the side-by-side view for every change an agent makes to a
 * note, and since FEAT-44-10 the APPROVAL GATE itself: it is shown BEFORE the
 * write, and rejecting it means nothing is written.
 *
 * Layout:
 *   +- Header (title) ----------------------------------------------+
 *   |  Files (N)     |  path        3 changes   [Edit] [Skip file]  |
 *   |  Notes/Idee.md | +---------------------+---------------------+|
 *   |  Notes/Plan.md | |  ## Kontext (sticky heading)              ||
 *   |                | |  Sie nutzt es [-taeglich-]|[+woechentl.+] ||
 *   |                | |  ... 14 unchanged lines ...               ||
 *   |                | +---------------------+---------------------+|
 *   +- Footer -------------------------------------------------------+
 *   |                        [ Discard ]   [ Apply ]                 |
 *   +----------------------------------------------------------------+
 *
 * The three decisions that make this readable, and what each one replaced:
 *
 * 1. ONE scroll container, ONE row element per diff line, both cells inside it.
 *    The old build used two independent scroll containers, which is the
 *    diff2html bug (#99): when a line wraps in one column, the other column
 *    cannot know about it and the two sides drift apart. With prose in a ~60
 *    character column, every second line wraps -- so they always drifted. A CSS
 *    grid row is as tall as its tallest cell, so both sides stay in lock-step
 *    with zero JavaScript.
 *
 * 2. WORD-LEVEL highlighting inside a changed line (intralineDiff). A German
 *    paragraph is one line; "this paragraph is gone, this one is new" carries no
 *    information.
 *
 * 3. The right column is NO LONGER contenteditable. It used to be both the diff
 *    and the editor, so the highlighting fell apart the moment you typed and the
 *    text had to be scraped back out of the mangled DOM. Editing is now a
 *    deliberate mode with a plain textarea. The diff stays a diff.
 *
 * Bot-compliance: no innerHTML, no style mutation beyond setProperty, no emojis,
 * no console.log.
 */

import { t } from '../../i18n';
import { diffLines, getDiffStats } from '../../core/utils/diffLines';
import { buildAlignedDiff, type AlignedLine } from './alignedDiff';
import { intralineDiff, type IntralineOp } from './intralineDiff';

export interface EditReviewEntry {
    path: string;
    before: string;
    after: string;
    /** Optional: file is newly created (no prior content). */
    isNew?: boolean;
    /** Optional: file is going to be deleted (after is empty). */
    isDeleted?: boolean;
}

export interface EditReviewDecision {
    path: string;
    /** Final content after user editing (= textarea value at apply time). */
    finalContent: string;
    /** True when user toggled "Skip this file" before applying. */
    skipped: boolean;
}

/**
 * How the user applied. FEAT-44-02: "and stop asking me for the rest of this
 * run". FEAT-44-02a: "and stop asking me until the plugin reloads".
 */
export interface EditReviewApplyMeta {
    rememberForRun: boolean;
    rememberForSession?: boolean;
}

export type EditReviewMode = 'edit' | 'checkpoint';

export type SetIconHook = (el: HTMLElement, name: string) => void;

export interface EditReviewPanelOptions {
    containerEl: HTMLElement;
    entries: EditReviewEntry[];
    mode: EditReviewMode;
    /** Title shown at the top. */
    title?: string;
    /** Source label (e.g. "Inline-AI: Rewrite") for the header subtitle. */
    sourceLabel?: string;
    /** Called when the user presses "Anwenden" in edit mode. */
    onApply?: (decisions: EditReviewDecision[], meta?: EditReviewApplyMeta) => void | Promise<void>;
    /**
     * FEAT-44-02: offer "apply, and do not ask again for this run". Only the
     * pre-write GATE offers this -- a post-task review has nothing left to
     * pre-approve.
     */
    allowRememberForRun?: boolean;
    /**
     * FEAT-44-02b: the BATCH approval gate is read-only. The tool writes its
     * batch internally, so a user edit inside one entry could not be honoured
     * honestly (the Pipeline drops stray finalContent from batch approvals).
     * Hides the edit/discard-edit buttons and the textarea; per-file Skip
     * stays -- per-entry consent is the point of the gate.
     */
    readonlyContent?: boolean;
    /** Called when the user presses "Verwerfen" or closes. */
    onDiscard?: () => void;
    /**
     * FIX-44-16: the discard button means different things in the two places this
     * panel is used. As a PRE-write gate it means "do not write". As a POST-task
     * review the writes already landed, so it means "take them back". The caller
     * says which, because only the caller knows.
     */
    discardLabel?: string;
    /** Called when the user presses "Wiederherstellen" in checkpoint mode. */
    onRestore?: () => void | Promise<void>;
    /** Bridge to Obsidian's setIcon() for Lucide rendering. */
    setIcon?: SetIconHook;
}

interface FileState {
    entry: EditReviewEntry;
    workingContent: string;
    skipped: boolean;
}

export class EditReviewPanel {
    private readonly containerEl: HTMLElement;
    private readonly entries: EditReviewEntry[];
    private readonly mode: EditReviewMode;
    private readonly title: string;
    private readonly sourceLabel: string;
    private readonly onApply?: (decisions: EditReviewDecision[], meta?: EditReviewApplyMeta) => void | Promise<void>;
    private readonly allowRememberForRun: boolean;
    private readonly onDiscard?: () => void;
    private readonly onRestore?: () => void | Promise<void>;
    private readonly discardLabel: string;
    private readonly setIcon: SetIconHook;
    private readonly readonlyContent: boolean;

    private files: FileState[] = [];
    private currentIndex = 0;

    private rootEl: HTMLElement | null = null;
    private filelistEl: HTMLElement | null = null;
    private diffPathEl: HTMLElement | null = null;
    /** The ONE scroll container. Both columns live inside it, row by row. */
    private bodyEl: HTMLElement | null = null;
    private textareaEl: HTMLTextAreaElement | null = null;
    private editToggleEl: HTMLElement | null = null;
    private editDiscardEl: HTMLElement | null = null;
    private afterStatsEl: HTMLElement | null = null;
    private skipBtnEl: HTMLElement | null = null;
    /** Diff or edit. They are different jobs and no longer share a DOM node. */
    private editing = false;
    /**
     * A diff should show the CHANGE, not the file. Unchanged runs are folded away
     * -- otherwise a frontmatter edit renders the whole transcript underneath it
     * and reads as if the body were part of the change. Expanding is one click.
     */
    private expanded = false;

    constructor(options: EditReviewPanelOptions) {
        this.containerEl = options.containerEl;
        this.entries = options.entries;
        this.mode = options.mode;
        this.title = options.title ?? (options.mode === 'checkpoint' ? t('ui.editReview.titleCheckpoint') : t('ui.editReview.titleReview'));
        this.sourceLabel = options.sourceLabel ?? '';
        this.onApply = options.onApply;
        this.allowRememberForRun = options.allowRememberForRun ?? false;
        this.onDiscard = options.onDiscard;
        this.onRestore = options.onRestore;
        this.readonlyContent = options.readonlyContent ?? false;
        this.discardLabel = options.discardLabel ?? t('ui.editReview.discard');
        this.setIcon = options.setIcon ?? ((el, _name) => { el.textContent = ''; });

        this.files = options.entries.map((e) => ({
            entry: e,
            workingContent: e.after,
            skipped: false,
        }));
    }

    get isOpen(): boolean { return this.rootEl !== null; }
    get selectedIndex(): number { return this.currentIndex; }

    open(): HTMLElement {
        this.close();
        const doc = this.containerEl.ownerDocument;
        const root = createDiv();
        root.classList.add('agent-edit-review');
        if (this.mode === 'checkpoint') root.classList.add('is-checkpoint');

        this.buildHeader(root, doc);

        if (this.entries.length === 0) {
            const empty = createDiv();
            empty.classList.add('agent-edit-review__empty');
            empty.textContent = t('ui.editReview.noChanges');
            root.appendChild(empty);
            this.buildFooter(root, doc);
            this.containerEl.appendChild(root);
            this.rootEl = root;
            return root;
        }

        const main = createDiv();
        main.classList.add('agent-edit-review__main');
        root.appendChild(main);

        if (this.entries.length > 1) {
            this.buildFileList(main, doc);
        }
        this.buildDiff(main, doc);
        this.buildFooter(root, doc);

        this.containerEl.appendChild(root);
        this.rootEl = root;
        this.renderSelectedFile();
        return root;
    }

    close(): void {
        if (this.rootEl !== null) {
            this.rootEl.remove();
            this.rootEl = null;
        }
        this.filelistEl = null;
        this.diffPathEl = null;
        this.bodyEl = null;
        this.textareaEl = null;
        this.editToggleEl = null;
        this.editDiscardEl = null;
        this.afterStatsEl = null;
        this.skipBtnEl = null;
        this.editing = false;
    }

    selectFile(index: number): void {
        if (index < 0 || index >= this.files.length) return;
        this.syncFromTextarea();
        this.currentIndex = index;
        this.editing = false;
        this.expanded = false;
        this.renderSelectedFile();
    }

    /** The textarea is the only editing surface, so this is the only way text flows back. */
    private syncFromTextarea(): void {
        if (this.textareaEl === null) return;
        this.files[this.currentIndex].workingContent = this.textareaEl.value;
    }

    private buildHeader(root: HTMLElement, doc: Document): void {
        const header = createDiv();
        header.classList.add('agent-edit-review__header');

        const titleWrap = createDiv();
        titleWrap.classList.add('agent-edit-review__title-wrap');

        const title = createDiv();
        title.classList.add('agent-edit-review__title');
        title.textContent = this.title;
        titleWrap.appendChild(title);

        if (this.sourceLabel.length > 0) {
            const sub = createDiv();
            sub.classList.add('agent-edit-review__subtitle');
            sub.textContent = this.sourceLabel;
            titleWrap.appendChild(sub);
        }
        header.appendChild(titleWrap);
        root.appendChild(header);
    }

    private buildFileList(main: HTMLElement, doc: Document): void {
        const list = createDiv();
        list.classList.add('agent-edit-review__filelist');
        const heading = createDiv();
        heading.classList.add('agent-edit-review__filelist-heading');
        heading.textContent = t('ui.editReview.filesHeading', { count: this.entries.length });
        list.appendChild(heading);

        this.entries.forEach((entry, index) => {
            const row = createEl('button');
            row.classList.add('agent-edit-review__file');
            row.setAttribute('type', 'button');

            const statusEl = createSpan();
            statusEl.classList.add('agent-edit-review__file-status');
            statusEl.textContent = entry.isNew === true ? '+'
                : entry.isDeleted === true ? '−'
                : '●';
            row.appendChild(statusEl);

            const labelEl = createSpan();
            labelEl.classList.add('agent-edit-review__file-label');
            labelEl.textContent = entry.path;
            row.appendChild(labelEl);

            row.addEventListener('click', (ev) => {
                ev.preventDefault();
                this.selectFile(index);
            });

            list.appendChild(row);
        });

        main.appendChild(list);
        this.filelistEl = list;
    }

    private buildDiff(main: HTMLElement, doc: Document): void {
        const diff = createDiv();
        diff.classList.add('agent-edit-review__diff');

        // --- toolbar ---------------------------------------------------------
        const bar = createDiv();
        bar.classList.add('agent-edit-review__diff-header');

        const pathEl = createDiv();
        pathEl.classList.add('agent-edit-review__diff-path');
        bar.appendChild(pathEl);
        this.diffPathEl = pathEl;

        const stats = createSpan();
        stats.classList.add('agent-edit-review__stats');
        bar.appendChild(stats);
        this.afterStatsEl = stats;

        if (this.mode === 'edit' && !this.readonlyContent) {
            // Two buttons, not one toggle. "Back to diff" said nothing about what
            // happens to what you just typed -- it kept it, but you had to guess.
            // Now the two outcomes are named: keep the edit, or throw it away.
            const editBtn = createEl('button');
            editBtn.classList.add('agent-edit-review__edit-btn');
            editBtn.setAttribute('type', 'button');
            editBtn.textContent = t('ui.editReview.editToggle');
            editBtn.addEventListener('click', (ev) => {
                ev.preventDefault();
                if (this.editing) this.keepEdit();
                else this.startEditing();
            });
            bar.appendChild(editBtn);
            this.editToggleEl = editBtn;

            const dropBtn = createEl('button');
            dropBtn.classList.add('agent-edit-review__edit-discard-btn');
            dropBtn.setAttribute('type', 'button');
            dropBtn.textContent = t('ui.editReview.discardEdit');
            dropBtn.addEventListener('click', (ev) => {
                ev.preventDefault();
                this.discardEdit();
            });
            bar.appendChild(dropBtn);
            this.editDiscardEl = dropBtn;
        }
        if (this.mode === 'edit') {
            const skip = createEl('button');
            skip.classList.add('agent-edit-review__skip-btn');
            skip.setAttribute('type', 'button');
            skip.textContent = t('ui.editReview.skipFile');
            skip.addEventListener('click', (ev) => {
                ev.preventDefault();
                this.toggleSkipCurrent();
            });
            bar.appendChild(skip);
            this.skipBtnEl = skip;
        }
        diff.appendChild(bar);

        // --- column headings -------------------------------------------------
        const heads = createDiv();
        heads.classList.add('agent-edit-review__colheads');
        const hOld = createSpan();
        hOld.classList.add('agent-edit-review__colhead');
        hOld.textContent = t('ui.editReview.original');
        heads.appendChild(hOld);
        const hNew = createSpan();
        hNew.classList.add('agent-edit-review__colhead');
        hNew.textContent = this.mode === 'checkpoint'
            ? t('ui.editReview.snapshot')
            : t('ui.editReview.proposed');
        heads.appendChild(hNew);
        diff.appendChild(heads);

        // --- the ONE scroll container ---------------------------------------
        // Both columns are rendered INSIDE this, one row element per diff line.
        // That is what keeps the two sides aligned when a line wraps.
        const body = createDiv();
        body.classList.add('agent-edit-review__body');
        diff.appendChild(body);
        this.bodyEl = body;

        // --- the editing surface (hidden until the user asks for it) ---------
        if (this.mode === 'edit' && !this.readonlyContent) {
            const ta = createEl('textarea');
            ta.classList.add('agent-edit-review__textarea');
            ta.setAttribute('spellcheck', 'true');
            ta.addEventListener('input', () => {
                const file = this.files[this.currentIndex];
                file.workingContent = ta.value;
                this.scheduleStats(file.entry.before, ta.value);
            });
            diff.appendChild(ta);
            this.textareaEl = ta;
        }

        main.appendChild(diff);
    }

    private startEditing(): void {
        if (this.mode !== 'edit') return;
        this.editing = true;
        this.renderSelectedFile();
    }

    /** Keep what the user typed and go back to the diff, which now shows it. */
    private keepEdit(): void {
        if (this.mode !== 'edit') return;
        this.syncFromTextarea();
        this.editing = false;
        this.renderSelectedFile();
    }

    /** Throw the manual edit away and go back to the agent's proposal. */
    private discardEdit(): void {
        if (this.mode !== 'edit') return;
        const file = this.files[this.currentIndex];
        file.workingContent = file.entry.after;
        this.editing = false;
        this.renderSelectedFile();
    }

    /**
     * refreshStats runs a full diff. Doing that on every keystroke of a 40k
     * transcript is how you make a textarea feel broken.
     */
    private statsTimer: number | null = null;
    private scheduleStats(before: string, current: string): void {
        if (this.statsTimer !== null) window.clearTimeout(this.statsTimer);
        this.statsTimer = window.setTimeout(() => {
            this.statsTimer = null;
            this.refreshStats(before, current);
        }, 300);
    }

    private buildFooter(root: HTMLElement, doc: Document): void {
        const footer = createDiv();
        footer.classList.add('agent-edit-review__footer');

        const discardBtn = createEl('button');
        discardBtn.classList.add('agent-edit-review__discard-btn');
        discardBtn.setAttribute('type', 'button');
        discardBtn.textContent = this.discardLabel;
        discardBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            this.handleDiscard();
        });
        footer.appendChild(discardBtn);

        if (this.mode === 'checkpoint') {
            const restoreBtn = createEl('button');
            restoreBtn.classList.add('agent-edit-review__restore-btn');
            restoreBtn.classList.add('mod-cta');
            restoreBtn.setAttribute('type', 'button');
            restoreBtn.textContent = t('ui.editReview.restore');
            restoreBtn.addEventListener('click', (ev) => {
                ev.preventDefault();
                this.handleRestore();
            });
            footer.appendChild(restoreBtn);
        } else {
            if (this.allowRememberForRun) {
                // FEAT-44-02: the user cannot be shown one diff for the whole run --
                // the agent only decides its next tool call after seeing this one's
                // result. What they can do is say yes once and mean it for the run.
                const applyAllBtn = createEl('button');
                applyAllBtn.classList.add('agent-edit-review__apply-run-btn');
                applyAllBtn.setAttribute('type', 'button');
                applyAllBtn.textContent = t('ui.editReview.applyForRun');
                applyAllBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    this.handleApply('run');
                });
                footer.appendChild(applyAllBtn);

                // FEAT-44-02a: one level up -- until the plugin reloads.
                const applySessionBtn = createEl('button');
                applySessionBtn.classList.add('agent-edit-review__apply-session-btn');
                applySessionBtn.setAttribute('type', 'button');
                applySessionBtn.textContent = t('ui.editReview.applyForSession');
                applySessionBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    this.handleApply('session');
                });
                footer.appendChild(applySessionBtn);
            }

            const applyBtn = createEl('button');
            applyBtn.classList.add('agent-edit-review__apply-btn');
            applyBtn.classList.add('mod-cta');
            applyBtn.setAttribute('type', 'button');
            applyBtn.textContent = t('ui.editReview.apply');
            applyBtn.addEventListener('click', (ev) => {
                ev.preventDefault();
                this.handleApply('once');
            });
            footer.appendChild(applyBtn);
        }

        root.appendChild(footer);
    }

    private renderSelectedFile(): void {
        if (this.entries.length === 0) return;
        const file = this.files[this.currentIndex];

        if (this.filelistEl !== null) {
            const rows = this.filelistEl.children;
            for (let i = 0; i < rows.length; i += 1) {
                const child = rows[i] as HTMLElement;
                if (child.classList.contains('agent-edit-review__file') === false) continue;
                child.classList.toggle('is-selected', this.indexOfFileChild(child) === this.currentIndex);
                child.classList.toggle('is-skipped', this.files[this.indexOfFileChild(child)]?.skipped === true);
            }
        }

        if (this.diffPathEl !== null) {
            this.diffPathEl.textContent = file.entry.path;
        }

        if (this.rootEl !== null) {
            this.rootEl.classList.toggle('is-editing', this.editing);
            this.rootEl.classList.toggle('is-deleting', file.entry.isDeleted === true);
        }

        if (this.textareaEl !== null) {
            this.textareaEl.value = file.workingContent;
        }
        if (this.editToggleEl !== null) {
            this.editToggleEl.classList.toggle('is-active', this.editing);
            this.editToggleEl.textContent = this.editing
                ? t('ui.editReview.keepEdit')
                : t('ui.editReview.editToggle');
        }
        if (this.editDiscardEl !== null) {
            // Only meaningful while editing, or once an edit exists to throw away.
            const edited = file.workingContent !== file.entry.after;
            this.editDiscardEl.classList.toggle('is-hidden', !this.editing && !edited);
        }

        if (this.bodyEl !== null && !this.editing) {
            this.renderDiffBody(this.bodyEl, file.entry, file.workingContent);
        }

        this.refreshStats(file.entry.before, file.workingContent);

        if (this.skipBtnEl !== null) {
            this.skipBtnEl.classList.toggle('is-active', file.skipped);
            this.skipBtnEl.textContent = file.skipped ? t('ui.editReview.unskipFile') : t('ui.editReview.skipFile');
        }
    }

    private indexOfFileChild(child: HTMLElement): number {
        if (this.filelistEl === null) return -1;
        const items = Array.from(this.filelistEl.children).filter(
            (c) => (c as HTMLElement).classList.contains('agent-edit-review__file'),
        );
        return items.indexOf(child);
    }

    /**
     * Render the diff into the single scroll container: one row per aligned line,
     * both cells inside it. The row is a CSS grid, so its height is the height of
     * its tallest cell -- which is how the two sides stay aligned even when only
     * one of them wraps.
     */
    private renderDiffBody(host: HTMLElement, entry: EditReviewEntry, currentContent: string): void {
        const doc = this.containerEl.ownerDocument;
        while (host.firstChild !== null) host.removeChild(host.firstChild);

        const aligned = buildAlignedDiff(entry.before, currentContent, { collapse: !this.expanded });

        if (aligned.left.length === 0) {
            const empty = createDiv();
            empty.classList.add('agent-edit-review__empty-diff');
            empty.textContent = t('ui.editReview.emptyFile');
            host.appendChild(empty);
            return;
        }

        let lastHeading: string | null = null;
        for (let i = 0; i < aligned.left.length; i += 1) {
            const l = aligned.left[i];
            const r = aligned.right[i];

            // A sticky "## Abschnitt" is what orients you in a note. A line
            // number is not -- nobody references line 47 of a transcript.
            const changed = l.type !== 'unchanged' || r.type !== 'unchanged';
            if (changed && l.heading !== null && l.heading !== lastHeading) {
                host.appendChild(this.makeHeadingRow(doc, l.heading));
                lastHeading = l.heading;
            }

            host.appendChild(this.makeRow(doc, l, r));
        }
    }

    private makeHeadingRow(doc: Document, heading: string): HTMLElement {
        const el = createDiv();
        el.classList.add('agent-edit-review__hunk-head');
        el.textContent = heading;
        return el;
    }

    private makeRow(doc: Document, left: AlignedLine, right: AlignedLine): HTMLElement {
        const row = createDiv();
        row.classList.add('agent-edit-review__row');

        if (left.type === 'collapsed') {
            row.classList.add('agent-edit-review__row--collapsed');
            const bar = createEl('button');
            bar.classList.add('agent-edit-review__collapsed');
            bar.setAttribute('type', 'button');
            bar.textContent = t('ui.editReview.hiddenLines', { count: left.hiddenCount ?? 0 });
            bar.addEventListener('click', (ev) => {
                ev.preventDefault();
                this.expanded = true;
                this.renderSelectedFile();
            });
            row.appendChild(bar);
            return row;
        }

        if (left.type !== 'unchanged' || right.type !== 'unchanged') {
            row.classList.add('is-change');
        }
        row.appendChild(this.makeCell(doc, left, 'old'));
        row.appendChild(this.makeCell(doc, right, 'new'));
        return row;
    }

    private makeCell(doc: Document, line: AlignedLine, side: 'old' | 'new'): HTMLElement {
        const cell = createDiv();
        cell.classList.add('agent-edit-review__cell');
        cell.classList.add(`agent-edit-review__cell--${side}`);

        if (line.type === 'removed') cell.classList.add('is-del');
        else if (line.type === 'added') cell.classList.add('is-add');
        else if (line.type === 'padding') cell.classList.add('is-pad');

        // Redundant, non-colour cue (WCAG 1.4.1: never carry meaning by colour
        // alone). Rendered in its own grid slot so it cannot disturb the prose.
        const marker = createSpan();
        marker.classList.add('agent-edit-review__marker');
        marker.setAttribute('aria-hidden', 'true');
        marker.textContent = line.type === 'added' ? '+' : line.type === 'removed' ? '\u2212' : '';
        cell.appendChild(marker);

        const text = createSpan();
        text.classList.add('agent-edit-review__text');
        if (isMonospaceLine(line.content)) text.classList.add('is-mono');
        this.renderLineText(doc, text, line, side);
        cell.appendChild(text);

        return cell;
    }

    /**
     * Word-level highlighting, but only where it is honest: the line must have a
     * partner it is genuinely a rewrite of (alignedDiff decides that), and the
     * word diff must not degenerate into confetti (intralineDiff decides that).
     * Otherwise the whole line carries the mark, which is the truthful fallback.
     */
    private renderLineText(doc: Document, host: HTMLElement, line: AlignedLine, side: 'old' | 'new'): void {
        if (line.type === 'padding') {
            // Keeps the row height without putting anything in the note.
            host.textContent = '';
            return;
        }
        if (line.pairedWith === null || line.type === 'unchanged') {
            host.textContent = line.content;
            return;
        }

        const oldText = side === 'old' ? line.content : line.pairedWith;
        const newText = side === 'old' ? line.pairedWith : line.content;
        const d = intralineDiff(oldText, newText);
        if (d === null) {
            host.textContent = line.content;
            return;
        }

        const ops: IntralineOp[] = side === 'old' ? d.left : d.right;
        for (const op of ops) {
            if (op.type === 'equal') {
                host.appendChild(doc.createTextNode(op.text));
                continue;
            }
            const mark = createSpan();
            mark.classList.add('agent-edit-review__word');
            mark.classList.add(op.type === 'del' ? 'is-del-word' : 'is-add-word');
            mark.textContent = op.text;
            host.appendChild(mark);
        }
    }

    private refreshStats(before: string, current: string): void {
        if (this.afterStatsEl === null) return;
        const { added, removed } = getDiffStats(diffLines(before, current));
        if (added === 0 && removed === 0) {
            this.afterStatsEl.textContent = t('ui.editReview.unchanged');
            this.afterStatsEl.classList.remove('is-changed');
        } else {
            const parts: string[] = [];
            if (added > 0) parts.push(`+${added}`);
            if (removed > 0) parts.push(`−${removed}`);
            this.afterStatsEl.textContent = parts.join(' ');
            this.afterStatsEl.classList.add('is-changed');
        }
    }

    private toggleSkipCurrent(): void {
        const file = this.files[this.currentIndex];
        file.skipped = !file.skipped;
        this.renderSelectedFile();
    }

    private handleApply(scope: 'once' | 'run' | 'session' = 'once'): void {
        this.syncFromTextarea();
        const decisions: EditReviewDecision[] = this.files.map((f) => ({
            path: f.entry.path,
            finalContent: f.workingContent,
            skipped: f.skipped,
        }));
        try {
            const result = this.onApply?.(decisions, {
                rememberForRun: scope === 'run',
                rememberForSession: scope === 'session',
            });
            if (result instanceof Promise) {
                void result.catch((e) => console.warn('[edit-review] onApply threw:', e));
            }
        } catch (e) {
            console.warn('[edit-review] onApply threw:', e);
        }
        this.close();
    }

    private handleDiscard(): void {
        try {
            this.onDiscard?.();
        } catch (e) {
            console.warn('[edit-review] onDiscard threw:', e);
        }
        this.close();
    }

    private handleRestore(): void {
        try {
            const result = this.onRestore?.();
            if (result instanceof Promise) {
                void result.catch((e) => console.warn('[edit-review] onRestore threw:', e));
            }
        } catch (e) {
            console.warn('[edit-review] onRestore threw:', e);
        }
        this.close();
    }
}

/**
 * Prose gets a proportional font; code does not. Deliberately conservative: only
 * fences and indented blocks. Guessing at YAML by looking for "key:" would catch
 * every German sentence with a colon in it.
 */
function isMonospaceLine(content: string): boolean {
    return content.startsWith('```') || /^ {4}\S/.test(content) || content.startsWith('\t');
}
