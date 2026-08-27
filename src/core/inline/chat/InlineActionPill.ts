/**
 * InlineActionPill -- non-blocking selection affordance (FEAT-33-12 / user feedback 2026-06-24).
 *
 * Replaces the previous auto-open-on-selection behaviour. Instead of
 * opening the full inline chat the moment the user finishes a selection
 * (which steals focus and breaks Cmd+C / format toolbar / etc.), a small
 * lucide `sparkles` icon button appears at the top-right edge of the
 * selection. The selection stays alive, every native editor action
 * (copy, format, Cmd+B, ...) keeps working. Only when the user clicks
 * the pill does the orchestrator open the chat.
 *
 * Positioning (updated 2026-06-24):
 *   The pill sits just ABOVE the first rect of the selection (range
 *   getClientRects()[0]) at its trailing edge. That way the pill
 *   never overlaps the selected text and is consistently anchored to
 *   the top-right corner, independent of the selection's height
 *   (multi-line selections still get an unambiguous anchor).
 *
 * Lifecycle:
 *   show()  positions the pill at the top-right of the first selection
 *           rect. Idempotent -- a second show() removes the old pill
 *           first. No-op when there is no non-collapsed selection.
 *   hide()  removes the pill + all document-level listeners.
 *   dispose alias for hide(), wired into the plugin onunload chain.
 *
 * The pill self-hides on:
 *   - outside mousedown (not on the pill itself)
 *   - selection collapse (user clicks away, types, etc.)
 *   - editor / window scroll (pill is viewport-fixed, scrolling moves
 *     the selection but not the pill -- hide rather than mis-anchor)
 *   - Escape keydown
 *
 * The capture-phase outside-mousedown listener detects clicks BEFORE
 * any target handler runs, but does NOT call stopPropagation -- the
 * mousedown must still reach CodeMirror so the editor can move the
 * cursor / close menus normally. We only hide the pill.
 *
 * Bot-compliance: setIcon for the icon, classList for static styles,
 * setCssStyles only for the dynamic left/top values (same idiom as
 * InlineChatPanel).
 */

import { setIcon } from 'obsidian';

export interface InlineActionPillOptions {
    /** Container the pill mounts into. Usually plugin.app.workspace.containerEl. */
    target: HTMLElement;
    /** Called when the user clicks the pill. Pill auto-hides after the callback. */
    onClick: () => void;
    /** Optional label override for accessibility / tooltip. */
    label?: string;
    /** Lucide icon name (default: sparkles per user spec 2026-06-24). */
    icon?: string;
}

/** Estimated pill width in px, used for viewport-edge clamping. */
const PILL_WIDTH_PX = 86;
/** Estimated pill height in px, used to anchor above the selection. */
const PILL_HEIGHT_PX = 28;
/** Gap between the pill and the selection edge. */
const PILL_GAP_PX = 6;

export class InlineActionPill {
    private el: HTMLElement | null = null;
    private outsideMouseDownHandler: ((ev: MouseEvent) => void) | null = null;
    private selectionChangeHandler: (() => void) | null = null;
    private escapeHandler: ((ev: KeyboardEvent) => void) | null = null;
    private scrollHandler: (() => void) | null = null;

    private readonly target: HTMLElement;
    private readonly onClick: () => void;
    private readonly label: string;
    private readonly icon: string;

    constructor(options: InlineActionPillOptions) {
        this.target = options.target;
        this.onClick = options.onClick;
        this.label = options.label ?? 'Ask AI';
        this.icon = options.icon ?? 'sparkles';
    }

    /** True when the pill is currently mounted. Surfaced for tests. */
    get isVisible(): boolean { return this.el !== null; }

    /**
     * Render the pill directly ABOVE the start of the selection rect.
     */
    show(): void {
        this.hide();
        const doc = this.target.ownerDocument;
        const win = doc.defaultView ?? (this.target as unknown as { defaultView?: Window | null }).defaultView ?? null;
        const sel = win?.getSelection?.() ?? null;
        if (sel === null || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (range.collapsed === true) return;
        if (isRangeInsideMarkdownView(range) === false) return;
        const anchor = pickAnchor(range);
        if (anchor === null) return;

        const pill = createEl('button');
        pill.classList.add('agent-inline-action-pill');
        pill.setAttribute('type', 'button');
        pill.setAttribute('aria-label', this.label);
        pill.setAttribute('title', this.label);
        pill.setAttribute('tabindex', '-1');

        // Position: directly above the first line of selection
        const viewportW = win?.innerWidth ?? 1024;
        const viewportH = win?.innerHeight ?? 768;
        let desiredTop = anchor.firstLineTop - PILL_HEIGHT_PX - PILL_GAP_PX;
        if (desiredTop < 8) {
            desiredTop = anchor.bottommostBottom + PILL_GAP_PX;
        }
        const desiredLeft = anchor.startLeft;
        const left = Math.max(8, Math.min(desiredLeft, viewportW - PILL_WIDTH_PX - 8));
        const top = Math.max(8, Math.min(desiredTop, viewportH - PILL_HEIGHT_PX - 8));
        pill.setCssStyles({ left: `${left}px`, top: `${top}px` });

        const iconSpan = pill.createSpan({ cls: 'agent-inline-action-pill__icon' });
        setIcon(iconSpan, this.icon);
        if (hasRenderedIcon(iconSpan) === false) {
            setIcon(iconSpan, 'sparkles');
        }
        if (hasRenderedIcon(iconSpan) === false) {
            iconSpan.textContent = '✨';
        }

        pill.createSpan({ cls: 'agent-inline-action-pill__label', text: 'Ask AI' });

        pill.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
        });
        pill.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.onClick();
            this.hide();
        });

        this.target.appendChild(pill);
        this.el = pill;

        // Capture-phase outside listener so we hide BEFORE the target's
        // own mousedown handler runs. We DO NOT stopPropagation -- the
        // mousedown still reaches CodeMirror (cursor move, menu close).
        this.outsideMouseDownHandler = (ev: MouseEvent) => {
            if (ev.target === pill) return;
            if (pill.contains(ev.target as Node | null) === true) return;
            this.hide();
        };
        this.selectionChangeHandler = () => {
            const s = win?.getSelection?.() ?? null;
            if (s === null || s.rangeCount === 0 || s.getRangeAt(0).collapsed === true) {
                this.hide();
            }
        };
        this.escapeHandler = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') this.hide();
        };
        // Viewport-fixed positioning means the pill does not follow the
        // editor when the user scrolls. Rather than reposition on every
        // scroll frame (expensive + jittery), hide and let the next
        // selection re-trigger the watcher.
        //
        // Scroll-listener gotcha (final-verify finding): scroll events
        // do NOT bubble. A capture-phase listener on `document` only
        // catches scrolls of document/window itself, NOT scrolls of
        // nested scrollable containers like .cm-scroller. We register
        // the capture-phase listener on `target` (the workspace root)
        // so it catches every descendant scroll on the way down.
        this.scrollHandler = () => { this.hide(); };
        doc.addEventListener('mousedown', this.outsideMouseDownHandler, true);
        doc.addEventListener('selectionchange', this.selectionChangeHandler);
        doc.addEventListener('keydown', this.escapeHandler);
        this.target.addEventListener('scroll', this.scrollHandler, true);
    }

    hide(): void {
        const doc = this.target.ownerDocument;
        if (this.el !== null) {
            try { this.el.remove(); } catch { /* element already detached */ }
            this.el = null;
        }
        if (this.outsideMouseDownHandler !== null) {
            doc.removeEventListener('mousedown', this.outsideMouseDownHandler, true);
            this.outsideMouseDownHandler = null;
        }
        if (this.selectionChangeHandler !== null) {
            doc.removeEventListener('selectionchange', this.selectionChangeHandler);
            this.selectionChangeHandler = null;
        }
        if (this.escapeHandler !== null) {
            doc.removeEventListener('keydown', this.escapeHandler);
            this.escapeHandler = null;
        }
        if (this.scrollHandler !== null) {
            this.target.removeEventListener('scroll', this.scrollHandler, true);
            this.scrollHandler = null;
        }
    }

    dispose(): void { this.hide(); }
}

/**
 * setIcon does not return a status; we infer success by checking whether
 * the button now contains an SVG node. Used to drive the fallback chain
 * (preferred icon -> 'sparkles' -> unicode glyph).
 */
function hasRenderedIcon(el: HTMLElement): boolean {
    return el.querySelector('svg') !== null;
}

interface Anchor {
    startLeft: number;
    firstLineTop: number;
    bottommostBottom: number;
}

/**
 * True iff the Range's start sits inside a markdown editor or reading view.
 */
function isRangeInsideMarkdownView(range: Range): boolean {
    try {
        const node = range.endContainer;
        const el: Element | null = node.nodeType === 1
            ? node as Element
            : node.parentElement;
        if (el === null) return false;
        return el.closest('.markdown-source-view, .markdown-reading-view, .markdown-preview-view, .cm-editor') !== null;
    } catch {
        return false;
    }
}

function pickAnchor(range: Range): Anchor | null {
    try {
        const rects = range.getClientRects?.();
        if (rects !== undefined && rects.length > 0) {
            let startLeft = Number.POSITIVE_INFINITY;
            let firstLineTop = Number.POSITIVE_INFINITY;
            let bottommostBottom = Number.NEGATIVE_INFINITY;
            for (let i = 0; i < rects.length; i += 1) {
                const r = rects[i];
                if (r.width <= 0 && r.height <= 0) continue;
                if (firstLineTop === Number.POSITIVE_INFINITY) {
                    firstLineTop = r.top;
                    startLeft = r.left;
                }
                if (r.bottom > bottommostBottom) {
                    bottommostBottom = r.bottom;
                }
            }
            if (firstLineTop !== Number.POSITIVE_INFINITY && bottommostBottom !== Number.NEGATIVE_INFINITY) {
                return {
                    startLeft,
                    firstLineTop,
                    bottommostBottom,
                };
            }
        }
    } catch { /* fall through to bounding-rect path */ }
    const fallback = range.getBoundingClientRect();
    if (fallback.width === 0 && fallback.height === 0) return null;
    return {
        startLeft: fallback.left,
        firstLineTop: fallback.top,
        bottommostBottom: fallback.bottom,
    };
}
