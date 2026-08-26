/**
 * popoverShell -- the shared shell behind every chat popover (IMP-02-12-03).
 *
 * Five popovers (VaultFilePicker, CommandPicker, ChatModelPickerPopover,
 * ToolPickerPopover, ChatOptionsPopover) used to carry their own copy of the
 * same two concerns; the copies drifted (only the newest had Escape and
 * anchor-toggle, two leaked one document listener per show()). This module is
 * the single implementation:
 *
 * - positionPopover(): fixed positioning relative to an anchor, clamped to a
 *   parent container, opening toward the larger free space. Writes the CSS
 *   custom properties (--vfp-* or --tp-*) that styles.css consumes.
 * - PopoverDismisser: the close-lifecycle bundle -- outside-mousedown
 *   (anchor-exempt via contains, the anchor's own click handler owns the
 *   toggle), Escape, window-resize repositioning, and idempotent teardown.
 *
 * Listeners attach to anchor.ownerDocument and its defaultView, not to the
 * global document/window, so a popover opened in a popout window listens in
 * that window and dies with it.
 */

export interface PopoverPositionOptions {
    /** CSS custom-property family the popover's stylesheet consumes. */
    cssPrefix: '--vfp' | '--tp';
    /** Preferred width; clamped to the parent container minus padding. */
    maxWidth: number;
    /** Floor for --*-max-h so tiny leftover space stays usable. Default 200. */
    minVisibleHeight?: number;
    /** Also write --*-min-w / --*-max-w (the --tp stylesheet reads them). */
    extraWidthVars?: boolean;
}

const PAD = 8;

/**
 * Position `el` fixed, anchored to `anchor`, clamped inside `parentEl`
 * (or the anchor's window when no parent is given).
 */
export function positionPopover(
    el: HTMLElement,
    anchor: HTMLElement,
    parentEl: HTMLElement | null,
    opts: PopoverPositionOptions,
): void {
    const win = anchor.ownerDocument.defaultView ?? window;
    const br = anchor.getBoundingClientRect();
    const cr = parentEl
        ? parentEl.getBoundingClientRect()
        : { top: 0, bottom: win.innerHeight, left: 0, right: win.innerWidth, width: win.innerWidth };
    const p = opts.cssPrefix;
    const minH = opts.minVisibleHeight ?? 200;

    el.setCssProps({ [`${p}-pos`]: 'fixed' });

    const popWidth = Math.min(opts.maxWidth, cr.width - PAD * 2);
    el.setCssProps({ [`${p}-w`]: `${popWidth}px` });
    if (opts.extraWidthVars) {
        el.setCssProps({
            [`${p}-min-w`]: `${Math.min(320, popWidth)}px`,
            [`${p}-max-w`]: `${popWidth}px`,
        });
    }

    // Open toward the larger free space; above wins ties.
    const spaceAbove = br.top - cr.top - PAD;
    const spaceBelow = cr.bottom - br.bottom - PAD;
    if (spaceAbove >= spaceBelow) {
        el.setCssProps({
            [`${p}-bottom`]: (win.innerHeight - br.top + 4) + 'px',
            [`${p}-top`]: '',
            [`${p}-max-h`]: `${Math.max(spaceAbove, minH)}px`,
        });
    } else {
        el.setCssProps({
            [`${p}-top`]: (br.bottom + 4) + 'px',
            [`${p}-bottom`]: '',
            [`${p}-max-h`]: `${Math.max(spaceBelow, minH)}px`,
        });
    }

    let left = Math.max(br.left, cr.left + PAD);
    if (left + popWidth > cr.right - PAD) left = cr.right - PAD - popWidth;
    left = Math.max(left, cr.left + PAD);
    el.setCssProps({ [`${p}-left`]: `${left}px` });
}

export interface PopoverDismissOptions {
    /** The popover element (mousedowns inside it never dismiss). */
    el: HTMLElement;
    /** The button that opened the popover (also exempt from outside-close). */
    anchor: HTMLElement;
    /** Called once on outside mousedown or Escape. Callers hide() here. */
    onDismiss: () => void;
    /** Re-run positioning; registered on the anchor window's resize. */
    reposition?: () => void;
}

export class PopoverDismisser {
    private anchor: HTMLElement | null = null;
    private doc: Document | null = null;
    private win: Window | null = null;
    private mousedownHandler: ((e: MouseEvent) => void) | null = null;
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;
    private resizeHandler: (() => void) | null = null;
    private armTimer: number | null = null;

    /**
     * Arm the dismiss listeners for an open popover. Detaches any previous
     * attachment first, so callers can attach on every show(). The
     * outside-mousedown arms on the next tick so the click that opened the
     * popover does not immediately close it.
     */
    attach(opts: PopoverDismissOptions): void {
        this.detach();
        const doc = opts.anchor.ownerDocument;
        const win = doc.defaultView ?? window;
        this.anchor = opts.anchor;
        this.doc = doc;
        this.win = win;

        if (opts.reposition) {
            this.resizeHandler = opts.reposition;
            win.addEventListener('resize', this.resizeHandler);
        }

        this.keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') opts.onDismiss();
        };
        doc.addEventListener('keydown', this.keyHandler);

        this.armTimer = win.setTimeout(() => {
            this.armTimer = null;
            this.mousedownHandler = (e: MouseEvent) => {
                const target = e.target as Node;
                if (!opts.el.contains(target) && !opts.anchor.contains(target)) {
                    opts.onDismiss();
                }
            };
            doc.addEventListener('mousedown', this.mousedownHandler);
        }, 0);
    }

    /** Remove every listener and pending arm timer. Idempotent. */
    detach(): void {
        if (this.armTimer !== null) {
            this.win?.clearTimeout(this.armTimer);
            this.armTimer = null;
        }
        if (this.mousedownHandler) {
            this.doc?.removeEventListener('mousedown', this.mousedownHandler);
            this.mousedownHandler = null;
        }
        if (this.keyHandler) {
            this.doc?.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        if (this.resizeHandler) {
            this.win?.removeEventListener('resize', this.resizeHandler);
            this.resizeHandler = null;
        }
        this.anchor = null;
        this.doc = null;
        this.win = null;
    }

    /**
     * True while attached for exactly this anchor. Callers use it for the
     * toggle: `if (dismisser.isOpenFor(anchor)) { hide(); return; }`.
     */
    isOpenFor(anchor: HTMLElement): boolean {
        return this.anchor === anchor;
    }
}
