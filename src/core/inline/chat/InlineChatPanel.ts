/**
 * InlineChatPanel -- floating chat that mirrors the Sidebar-Chat composer (EPIC-33).
 *
 * UX per user feedback 2026-06-22:
 * - Trigger only via hotkey (Cmd+Shift+I) or editor-menu, NO auto-open
 * - Layout identical to sidebar-chat composer so users get the same
 *   muscle memory: model button, "+" menu, magnifier (Lookup quick-
 *   action, the inline-specific addition), "..." menu, send button
 * - Selected text shown above the message body as a collapsible
 *   preview (first 3 lines visible, "more" toggle reveals the rest)
 *
 * Uses the existing Sidebar CSS classes (.chat-input-container,
 * .chat-input-wrapper, .chat-textarea, .chat-toolbar, .toolbar-button,
 * etc.) so the look is identical without copy-pasting styles. The
 * panel adds a wrapper class (.agent-inline-panel) for positioning
 * + an anchor section class (.agent-inline-panel__anchor) for the
 * collapsible selection preview.
 *
 * Lucide icons are loaded via Obsidian's setIcon helper which is
 * supplied via an optional setIconHook (so unit-tests run without
 * Obsidian). The icons match the sidebar: 'plus', 'search', 'ellipsis',
 * 'send-horizontal'.
 *
 * Bot-Compliance: vanilla DOM only, no innerHTML, no inline style
 * mutation beyond position/size, all event listeners detached in close().
 */

import { t } from '../../../i18n';
import type { InlineTriggerContext } from '../InlineTriggerContext';
import { shouldSendOnEnter } from '../../../ui/sidebar/composerKeymap';

export type InlinePanelActionId =
    | 'free-chat'
    | 'lookup'
    | 'rewrite'
    | 'translate'
    | 'summarize'
    | 'find-action-items'
    | 'send-to-main';

export interface InlinePanelMessage {
    role: 'user' | 'assistant' | 'system';
    text: string;
}

export interface InlinePanelDispatchArgs {
    actionId: InlinePanelActionId;
    userInput: string;
    ctx: InlineTriggerContext;
}

export interface InlineCheckpointMarker {
    label: string;
    /** Short detail line (e.g. "Notes/Idee.md, 12:34"). */
    detail?: string;
    /** "Show diff" button (file-diff icon). */
    onShowDiff?: () => void;
    /** "Undo this" button (undo-2 icon). Restores just this checkpoint. */
    onRestore?: () => void;
    /**
     * "Undo from here" button (rotate-ccw icon). Restores this
     * checkpoint AND every later checkpoint in the same task -- mirrors
     * AgentSidebarView.restoreCheckpointsForward.
     */
    onRestoreFromHere?: () => void;
    /**
     * "More" overflow menu (more-vertical icon). The host owns the
     * menu surface (Obsidian `Menu` in production, a no-op in unit
     * tests) and decides which items to render. The panel only opens
     * the anchor and forwards the click.
     */
    onMoreMenu?: (anchor: HTMLElement) => void;
}

export interface InlineResultActions {
    onReplace: () => void | Promise<void>;
    onInsertBelow: () => void | Promise<void>;
    onCopy: () => void | Promise<void>;
    onClose: () => void;
}

export interface InlinePanelHandle {
    appendMessage(message: InlinePanelMessage): string;
    appendStreamChunk(bubbleId: string, chunk: string): void;
    /**
     * Insert text into the composer at the caret. Prefixed-command
     * inserts (skill /slug, prompt #slug, workflow §slug) call this
     * with their full surface form so the user sees the prefix the
     * AgentTask resolver expects.
     */
    insertIntoComposer(text: string, mode?: 'replace' | 'prepend' | 'append'): void;
    /** Replace the model-button label (after model picker selection). */
    setModelLabel(label: string, tooltip?: string): void;
    /**
     * Flip the composer between Send (idle) and Stop (running). When
     * `running` is true the Send button hides and the Stop button
     * shows; vice versa on false.
     */
    setRunning(running: boolean): void;
    /**
     * Replace the bubble's plain-text streaming content with rendered
     * markdown (via the panel's renderMarkdown hook). Called once the
     * stream + appendix have completed. No-op when no renderMarkdown
     * hook is configured -- the bubble stays as plain text.
     */
    finalizeBubble(bubbleId: string): Promise<void>;
    /**
     * Render a checkpoint marker bubble below the chat history. The
     * marker shows the action label, a timestamp detail and two
     * buttons ("Diff anzeigen" + "Zurück"). Returns the bubble id so
     * the caller can later remove it if needed.
     */
    appendCheckpointMarker(marker: InlineCheckpointMarker): string;
    setStatus(text: string, level?: 'info' | 'error'): void;
    /** Re-render the forced-workflow status chip in the composer (FEAT-02-12). */
    refreshForcedWorkflow(): void;
    startResultStream(): void;
    updateStreamingResult(chunk: string): void;
    showResult(markdown: string, actions: InlineResultActions): Promise<void>;
    close(): void;
}

/**
 * Optional hook so Obsidian's setIcon() can render Lucide icons.
 * Unit-tests pass undefined and fall back to a plain text glyph.
 */
export type SetIconHook = (el: HTMLElement, name: string) => void;

/**
 * Optional hook so Obsidian's MarkdownRenderer.render() can render
 * the assistant bubble with full Obsidian markdown (wikilinks,
 * embeds, code fences, callouts, etc.) and the panel can wire
 * internal-link click handlers afterwards. Unit-tests pass
 * undefined and the bubble keeps the plain textContent.
 */
export type RenderMarkdownHook = (containerEl: HTMLElement, markdown: string) => Promise<void> | void;

/** Minimal interface shared with the sidebar's AutocompleteHandler. */
export interface AutocompleteLike {
    handleInput(): Promise<void> | void;
    handleKeyDown(ev: KeyboardEvent): boolean;
    hide(): void;
}

export interface InlineChatPanelOptions {
    containerEl: HTMLElement;
    ctx: InlineTriggerContext;
    position: { x: number; y: number };
    /**
     * FEAT-33-12: how the panel attaches to the editor surface.
     * - 'popover' (default): absolute-positioned floating panel; the
     *   panel manages its own size via setCssStyles + drag/resize gestures.
     * - 'inline-block': the panel renders inside a CodeMirror block widget
     *   container; size is governed by the CM6 layout, drag/resize are
     *   disabled, and absolute positioning is dropped via CSS modifier.
     */
    displayMode?: 'popover' | 'inline-block';
    onDispatch: (args: InlinePanelDispatchArgs, handle: InlinePanelHandle) => void;
    /** Called by the "..." menu to surface secondary actions. */
    onShowMoreMenu?: (anchor: HTMLElement, ctx: InlineTriggerContext, handle: InlinePanelHandle) => void;
    /** Called by the "+" menu to surface attach/context options. */
    onShowPlusMenu?: (anchor: HTMLElement, ctx: InlineTriggerContext, handle: InlinePanelHandle) => void;
    /** Called by the model button to open the model picker. */
    onShowModelMenu?: (anchor: HTMLElement, ctx: InlineTriggerContext, handle: InlinePanelHandle) => void;
    /** Initial label for the model button (e.g. "Auto" or model id). */
    initialModelLabel?: string;
    initialModelTooltip?: string;
    /** Called when the Stop button is clicked (during a running turn). */
    onStop?: () => void;
    /**
     * FEAT-33-12: handle the "Send to sidebar chat" composer button click.
     * The orchestrator decides whether to surface a notice (busy reason)
     * or call the InlineToSidebarTransferService. This panel only renders
     * the button + tooltip and forwards the click.
     */
    onSendToSidebar?: () => void;
    /**
     * Factory that builds an AutocompleteHandler-like object on
     * panel-open. Called once with the textarea + input-area refs.
     * The handler must expose handleInput() + handleKeyDown(ev) +
     * hide(). When undefined the panel skips autocomplete entirely.
     */
    autocompleteFactory?: (textarea: HTMLTextAreaElement, inputArea: HTMLElement) => AutocompleteLike;
    onClose?: () => void;
    /** Bridge to Obsidian's setIcon() for Lucide rendering. */
    setIcon?: SetIconHook;
    /**
     * Bridge to Obsidian's MarkdownRenderer.render() + link-wiring.
     * When set, finalizeBubble() runs the hook on the bubble element
     * with the accumulated markdown text so wikilinks, code fences,
     * and embeds render natively. When unset the bubble keeps the
     * plain textContent from streaming -- unit-tests run that way.
     */
    renderMarkdown?: RenderMarkdownHook;
    /**
     * Returns the slug of the forced workflow for the current agent, or '' when
     * none. The panel reads it to render a non-interactive status chip in the
     * composer (FEAT-02-12). A callback keeps the panel generic and testable.
     */
    getForcedWorkflowSlug?: () => string;
    /**
     * Subscribe the panel's forced-workflow chip to the cross-surface
     * refresh hub (IMP-02-12-01). Called once per open() with the chip
     * renderer; must return the unsubscriber, which close() invokes.
     */
    subscribeForcedWorkflowRefresh?: (cb: () => void) => () => void;
}

const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 520;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const PREVIEW_VISIBLE_LINES = 3;

export class InlineChatPanel {
    private readonly containerEl: HTMLElement;
    private readonly ctx: InlineTriggerContext;
    private readonly position: { x: number; y: number };
    private readonly displayMode: 'popover' | 'inline-block';
    private readonly onDispatch: (args: InlinePanelDispatchArgs, handle: InlinePanelHandle) => void;
    private readonly onShowMoreMenu?: (anchor: HTMLElement, ctx: InlineTriggerContext, handle: InlinePanelHandle) => void;
    private readonly onShowPlusMenu?: (anchor: HTMLElement, ctx: InlineTriggerContext, handle: InlinePanelHandle) => void;
    private readonly onShowModelMenu?: (anchor: HTMLElement, ctx: InlineTriggerContext, handle: InlinePanelHandle) => void;
    private readonly initialModelLabel: string;
    private readonly initialModelTooltip: string;
    private readonly onStop?: () => void;
    private readonly onSendToSidebar?: () => void;
    private sendToSidebarButtonEl: HTMLElement | null = null;
    private readonly autocompleteFactory?: (textarea: HTMLTextAreaElement, inputArea: HTMLElement) => AutocompleteLike;
    private modelButtonEl: HTMLElement | null = null;
    private sendButtonEl: HTMLElement | null = null;
    private stopButtonEl: HTMLElement | null = null;
    private chipBarEl: HTMLElement | null = null;
    private forcedChipEl: HTMLElement | null = null;
    private autocomplete: AutocompleteLike | null = null;
    private readonly onClose?: () => void;
    private readonly getForcedWorkflowSlug?: () => string;
    private readonly subscribeForcedWorkflowRefresh?: (cb: () => void) => () => void;
    private forcedWorkflowRefreshUnsub: (() => void) | null = null;
    private readonly setIcon: SetIconHook;

    private rootEl: HTMLElement | null = null;
    private bodyEl: HTMLElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private statusEl: HTMLElement | null = null;
    private previewEl: HTMLElement | null = null;
    private previewToggleEl: HTMLElement | null = null;
    private previewExpanded = false;
    private bubbleCounter = 0;
    private bubbleNodes = new Map<string, HTMLElement>();
    /** Raw markdown accumulator per bubble id (for finalizeBubble). */
    private bubbleMarkdown = new Map<string, string>();
    private readonly renderMarkdownHook?: RenderMarkdownHook;

    private boundKeyDown: ((ev: KeyboardEvent) => void) | null = null;
    private boundPointerDown: ((ev: MouseEvent | PointerEvent) => void) | null = null;

    private resultContainerEl: HTMLElement | null = null;
    private resultContentEl: HTMLElement | null = null;
    private resultActionsEl: HTMLElement | null = null;
    private rawResultText = '';
    private activeResultActions: InlineResultActions | null = null;
    /**
     * Cleanup handles for drag + resize listeners. The panel
     * registers document-scoped pointermove/pointerup pairs only
     * while a gesture is active, then unbinds them on pointerup.
     * Stored here so close()/dispose() can also unbind a gesture
     * that's still in-flight (panel closed mid-drag).
     */
    private dragCleanup: (() => void) | null = null;
    private resizeCleanup: (() => void) | null = null;

    constructor(options: InlineChatPanelOptions) {
        this.containerEl = options.containerEl;
        this.ctx = options.ctx;
        this.position = options.position;
        this.displayMode = options.displayMode ?? 'popover';
        this.onDispatch = options.onDispatch;
        this.onShowMoreMenu = options.onShowMoreMenu;
        this.onShowPlusMenu = options.onShowPlusMenu;
        this.onShowModelMenu = options.onShowModelMenu;
        this.initialModelLabel = options.initialModelLabel ?? 'Auto';
        this.initialModelTooltip = options.initialModelTooltip ?? 'Model (inherited from main chat)';
        this.onStop = options.onStop;
        this.onSendToSidebar = options.onSendToSidebar;
        this.autocompleteFactory = options.autocompleteFactory;
        this.onClose = options.onClose;
        this.setIcon = options.setIcon ?? ((el, name) => { el.textContent = iconFallback(name); });
        this.renderMarkdownHook = options.renderMarkdown;
        this.getForcedWorkflowSlug = options.getForcedWorkflowSlug;
        this.subscribeForcedWorkflowRefresh = options.subscribeForcedWorkflowRefresh;
    }

    get isOpen(): boolean { return this.rootEl !== null; }
    /** Root container (used by callers to anchor popovers). */
    get root(): HTMLElement | null { return this.rootEl; }
    /** Attachment chip bar element (caller passes to AttachmentHandler). */
    get chipBar(): HTMLElement | null { return this.chipBarEl; }

    open(): InlinePanelHandle {
        this.close();
        // IMP-02-12-01: chip re-renders when any surface changes the pin.
        this.forcedWorkflowRefreshUnsub =
            this.subscribeForcedWorkflowRefresh?.(() => this.renderForcedWorkflowChip()) ?? null;
        const doc = this.containerEl.ownerDocument;
        const root = createDiv();
        root.classList.add('agent-inline-panel');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-label', t('ui.inline.panelAriaLabel'));
        // FEAT-33-12: inline-block mounts as part of the CM6 layout, so
        // skip the absolute size + drag handle. The CSS modifier
        // `.agent-inline-panel--inline-block` resets position/width and
        // hides the drag handle so the panel flows with the editor.
        if (this.displayMode === 'inline-block') {
            root.classList.add('agent-inline-panel--inline-block');
        }

        // User feedback 2026-06-24 (round 3): copying multiple paragraphs
        // out of a response bubble failed. Cause: when the panel mounts
        // as a CM6 block widget, copy/cut events bubble up to the
        // surrounding EditorView and CodeMirror's own clipboard handler
        // wins -- it serialises the EDITOR'S selection (often empty)
        // instead of the DOM selection inside the widget. Stop propagation
        // at the panel root so the browser's default copy (which DOES
        // see the DOM selection) is what reaches the clipboard. We do
        // NOT preventDefault -- the browser copy must still run.
        root.addEventListener('copy', (ev) => { ev.stopPropagation(); });
        root.addEventListener('cut', (ev) => { ev.stopPropagation(); });

        if (this.displayMode !== 'inline-block') {
            // Bot-compliance: static rules (position/z-index) live in styles.css
            // under `.agent-inline-panel`. Per-instance width + height via
            // setCssStyles. The fixed height makes the body's flex:1 scroll
            // container have a defined extent so vertical resize works.
            root.setCssStyles({ width: `${DEFAULT_WIDTH}px`, height: `${DEFAULT_HEIGHT}px` });
        }

        // Drag handle: a slim strip at the top of the panel. Pointer
        // drag on this region moves the whole panel. Stays visible as
        // a tiny grip indicator (CSS only). null in inline-block mode -
        // the panel is part of the CM6 layout and must not float around.
        let dragHandle: HTMLElement | null = null;
        if (this.displayMode === 'popover') {
            dragHandle = createDiv();
            dragHandle.classList.add('agent-inline-panel__drag-handle');
            dragHandle.setAttribute('aria-hidden', 'true');
            root.appendChild(dragHandle);
        }

        // Selection preview (collapsible, 3 lines visible by default).
        // FEAT-33-12 (user feedback 2026-06-24): in inline-block mode the
        // real editor selection stays visible DIRECTLY above the block
        // widget, so a preview duplicate inside the panel just wastes
        // vertical space. Skip it. Popover mode still renders it because
        // the overlay covers the selection.
        // Selection preview (collapsible, 3 lines visible by default).
        if (this.displayMode === 'popover') {
            this.buildSelectionPreview(root, doc);
        }

        // Body: chat messages (hidden when empty).
        const body = createDiv();
        body.classList.add('agent-inline-panel__body');
        root.appendChild(body);
        this.bodyEl = body;

        // Status pill.
        const status = createDiv();
        status.classList.add('agent-inline-panel__status');
        status.classList.add('agent-u-hidden');
        root.appendChild(status);
        this.statusEl = status;

        // Context / forced workflow row (hidden when empty)
        const forcedChip = createDiv();
        forcedChip.classList.add('chat-context-chips', 'agent-inline-forced-row');
        root.appendChild(forcedChip);
        this.forcedChipEl = forcedChip;

        // Attachment chip bar (hidden when empty)
        const chipBar = createDiv();
        chipBar.classList.add('chat-attachment-chips');
        root.appendChild(chipBar);
        this.chipBarEl = chipBar;

        // Single-row sleek Command Bar
        const bar = createDiv('agent-inline-bar');

        const prefixIcon = bar.createSpan('agent-inline-bar__icon');
        this.setIcon(prefixIcon, 'sparkles');

        const textarea = bar.createEl('textarea', { cls: 'agent-inline-bar__input' });
        textarea.setAttribute('rows', '1');
        textarea.setAttribute('placeholder', '询问 AI 或输入指令... (Enter 发送, Esc 关闭)');
        textarea.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                this.close();
                return;
            }
            // Autocomplete first: lets the dropdown handle Up/Down/Enter/Esc.
            if (this.autocomplete !== null && this.autocomplete.handleKeyDown(ev) === true) return;
            if (shouldSendOnEnter(ev, true)) {
                ev.preventDefault();
                this.sendFromInput();
            }
        });
        textarea.addEventListener('input', () => {
            if (this.autocomplete !== null) {
                void this.autocomplete.handleInput();
            }
        });
        this.inputEl = textarea;

        // Build the autocomplete handler
        if (this.autocompleteFactory !== undefined) {
            try {
                this.autocomplete = this.autocompleteFactory(textarea, bar);
            } catch (e) {
                console.debug('[InlineChatPanel] autocompleteFactory failed:', e);
            }
        }

        const actions = bar.createDiv('agent-inline-bar__actions');

        // Model button: compact pill
        const modelBtn = this.makeToolbarButton(doc, this.initialModelLabel);
        modelBtn.classList.add('agent-inline-bar__model-btn');
        modelBtn.setAttribute('title', this.initialModelTooltip);
        modelBtn.setAttribute('type', 'button');
        modelBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            if (this.onShowModelMenu !== undefined && this.rootEl !== null) {
                this.onShowModelMenu(modelBtn, this.ctx, this.makeHandle());
            }
        });
        actions.appendChild(modelBtn);
        this.modelButtonEl = modelBtn;

        // Stop button (shown only while generating)
        const stopBtn = this.makeIconButton(doc, 'square', '停止');
        stopBtn.classList.add('agent-inline-bar__send-btn', 'agent-inline-bar__stop-btn', 'agent-u-hidden');
        stopBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            if (this.onStop !== undefined) this.onStop();
        });
        actions.appendChild(stopBtn);
        this.stopButtonEl = stopBtn;

        // Send button
        const sendBtn = this.makeIconButton(doc, 'send-horizontal', '发送');
        sendBtn.classList.add('agent-inline-bar__send-btn');
        sendBtn.addEventListener('click', (ev) => { ev.preventDefault(); this.sendFromInput(); });
        actions.appendChild(sendBtn);
        this.sendButtonEl = sendBtn;

        root.appendChild(bar);

        // Resize handle: small grip in the bottom-right corner.
        // Pointer drag adjusts width + height. Owned by the root so
        // it floats above the body even when the body scrolls.
        // Resize handle: same treatment as drag -- null in inline-block.
        let resizeHandle: HTMLElement | null = null;
        if (this.displayMode === 'popover') {
            resizeHandle = createDiv();
            resizeHandle.classList.add('agent-inline-panel__resize-handle');
            resizeHandle.setAttribute('aria-hidden', 'true');
            root.appendChild(resizeHandle);
        }

        this.containerEl.appendChild(root);
        this.rootEl = root;

        // Position + clamp to viewport -- popover only. In inline-block
        // mode the CM6 layout owns the size and position.
        if (this.displayMode === 'popover') {
            const clamped = this.clampToViewport(this.position, root);
            root.setCssStyles({ left: `${clamped.x}px`, top: `${clamped.y}px` });
            // Wire drag + resize gestures (no-ops in unit-test stubs that
            // don't supply pointer events on the document).
            if (dragHandle !== null) this.attachDragHandle(dragHandle, root);
            if (resizeHandle !== null) this.attachResizeHandle(resizeHandle, root);
        }

        // Esc and clicking outside close the panel; Enter confirms replace when result is ready
        this.boundKeyDown = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                if (this.activeResultActions !== null) {
                    this.activeResultActions.onClose();
                } else {
                    this.close();
                }
                return;
            }
            if (ev.key === 'Enter' && this.activeResultActions !== null && !ev.shiftKey) {
                ev.preventDefault();
                void this.activeResultActions.onReplace();
                return;
            }
        };
        doc.addEventListener('keydown', this.boundKeyDown);

        this.boundPointerDown = (ev: MouseEvent | PointerEvent) => {
            if (this.rootEl === null) return;
            const target = ev.target as HTMLElement | null;
            if (target === null) return;
            // Don't close if clicked inside the inline panel
            if (this.rootEl.contains(target)) return;
            // Don't close if clicked on Obsidian context menus, suggestion dropdowns, popovers
            if (target.closest('.menu, .suggestion-container, .suggestion-item, .popover, .agent-inline-panel, .agent-inline-action-pill') !== null) {
                return;
            }
            this.close();
        };
        doc.addEventListener('pointerdown', this.boundPointerDown, true);

        try { textarea.focus(); } catch { /* test stub */ }

        this.renderForcedWorkflowChip();
        return this.makeHandle();
    }

    close(): void {
        const wasOpen = this.rootEl !== null;
        this.forcedWorkflowRefreshUnsub?.();
        this.forcedWorkflowRefreshUnsub = null;
        if (this.resultContainerEl !== null) {
            this.resultContainerEl.remove();
            this.resultContainerEl = null;
        }
        this.resultContentEl = null;
        this.resultActionsEl = null;
        this.rawResultText = '';
        this.activeResultActions = null;
        if (this.rootEl !== null) {
            this.rootEl.remove();
            this.rootEl = null;
        }
        this.bodyEl = null;
        this.forcedChipEl = null;
        this.inputEl = null;
        this.statusEl = null;
        this.previewEl = null;
        this.previewToggleEl = null;
        this.previewExpanded = false;
        this.bubbleNodes.clear();
        this.bubbleMarkdown.clear();
        this.bubbleCounter = 0;
        if (this.autocomplete !== null) {
            try { this.autocomplete.hide(); } catch { /* swallow */ }
            this.autocomplete = null;
        }
        if (this.boundKeyDown !== null) {
            this.containerEl.ownerDocument.removeEventListener('keydown', this.boundKeyDown);
            this.boundKeyDown = null;
        }
        if (this.boundPointerDown !== null) {
            this.containerEl.ownerDocument.removeEventListener('pointerdown', this.boundPointerDown, true);
            this.boundPointerDown = null;
        }
        if (this.dragCleanup !== null) {
            try { this.dragCleanup(); } catch { /* swallow */ }
            this.dragCleanup = null;
        }
        if (this.resizeCleanup !== null) {
            try { this.resizeCleanup(); } catch { /* swallow */ }
            this.resizeCleanup = null;
        }
        if (wasOpen && this.onClose !== undefined) {
            try { this.onClose(); } catch { /* swallow */ }
        }
    }

    dispose(): void { this.close(); }

    private buildSelectionPreview(root: HTMLElement, doc: Document): void {
        const sel = this.ctx.selectionText;
        if (sel.length === 0) return;

        const section = createDiv();
        section.classList.add('agent-inline-panel__anchor');

        const label = createDiv();
        label.classList.add('agent-inline-panel__anchor-label');
        label.textContent = 'Selection';

        const preview = createDiv();
        preview.classList.add('agent-inline-panel__anchor-text');
        preview.textContent = this.truncateToLines(sel, PREVIEW_VISIBLE_LINES);
        this.previewEl = preview;

        section.appendChild(label);
        section.appendChild(preview);

        // Show a tiny chevron toggle only if the selection has more
        // than PREVIEW_VISIBLE_LINES lines or exceeds a soft char cap.
        const lineCount = sel.split('\n').length;
        const needsToggle = lineCount > PREVIEW_VISIBLE_LINES || sel.length > 240;
        if (needsToggle) {
            const toggle = createEl('button');
            toggle.classList.add('agent-inline-panel__anchor-toggle');
            toggle.setAttribute('type', 'button');
            toggle.setAttribute('aria-label', t('ui.inline.expandSelectionPreview'));
            toggle.setAttribute('title', t('ui.inline.expandTooltip'));
            const iconSpan = createSpan();
            iconSpan.classList.add('agent-inline-panel__anchor-toggle-icon');
            this.setIcon(iconSpan, 'chevron-down');
            toggle.appendChild(iconSpan);
            toggle.addEventListener('click', (ev) => {
                ev.preventDefault();
                this.togglePreview();
            });
            section.appendChild(toggle);
            this.previewToggleEl = toggle;
        }

        root.appendChild(section);
    }

    private togglePreview(): void {
        if (this.previewEl === null || this.previewToggleEl === null) return;
        this.previewExpanded = !this.previewExpanded;
        // Replace the chevron icon inside the toggle button.
        this.previewToggleEl.empty?.();
        while (this.previewToggleEl.firstChild !== null) {
            this.previewToggleEl.removeChild(this.previewToggleEl.firstChild);
        }
        const iconSpan = createSpan();
        iconSpan.classList.add('agent-inline-panel__anchor-toggle-icon');
        if (this.previewExpanded === true) {
            this.previewEl.textContent = this.ctx.selectionText;
            this.previewEl.classList.add('agent-inline-panel__anchor-text--expanded');
            this.setIcon(iconSpan, 'chevron-up');
            this.previewToggleEl.setAttribute('title', t('ui.inline.collapseTooltip'));
            this.previewToggleEl.setAttribute('aria-label', t('ui.inline.collapseSelectionPreview'));
        } else {
            this.previewEl.textContent = this.truncateToLines(this.ctx.selectionText, PREVIEW_VISIBLE_LINES);
            this.previewEl.classList.remove('agent-inline-panel__anchor-text--expanded');
            this.setIcon(iconSpan, 'chevron-down');
            this.previewToggleEl.setAttribute('title', t('ui.inline.expandTooltip'));
            this.previewToggleEl.setAttribute('aria-label', t('ui.inline.expandSelectionPreview'));
        }
        this.previewToggleEl.appendChild(iconSpan);
    }

    private truncateToLines(text: string, maxLines: number): string {
        const lines = text.split('\n');
        if (lines.length <= maxLines) return text;
        return lines.slice(0, maxLines).join('\n') + '…';
    }

    private makeToolbarButton(doc: Document, label: string): HTMLButtonElement {
        const btn = createEl('button');
        btn.classList.add('toolbar-button');
        btn.setAttribute('type', 'button');
        btn.textContent = label;
        return btn;
    }

    private makeIconButton(doc: Document, iconName: string, tooltip: string): HTMLButtonElement {
        const btn = createEl('button');
        btn.classList.add('toolbar-button');
        btn.classList.add('toolbar-ghost');
        btn.setAttribute('type', 'button');
        btn.setAttribute('aria-label', tooltip);
        btn.setAttribute('title', tooltip);
        const iconSpan = createSpan();
        iconSpan.classList.add('toolbar-icon');
        this.setIcon(iconSpan, iconName);
        btn.appendChild(iconSpan);
        return btn;
    }

    private dispatch(actionId: InlinePanelActionId, userInput: string): void {
        if (this.rootEl === null) return;
        const handle = this.makeHandle();
        try {
            this.onDispatch({ actionId, userInput, ctx: this.ctx }, handle);
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            handle.setStatus(`Error: ${err.message}`, 'error');
        }
    }

    private sendFromInput(): void {
        if (this.inputEl === null) return;
        const value = this.inputEl.value.trim();
        if (value.length === 0) return;
        this.inputEl.value = '';
        this.inputEl.disabled = true;
        this.inputEl.setAttribute('placeholder', 'AI 正在思考并生成...');
        this.setRunning(true);
        this.dispatch('free-chat', value);
    }

    /** Public accessor so callers (e.g. orchestrator hydrate-on-open)
     *  can append messages without going through onDispatch. */
    getHandle(): InlinePanelHandle { return this.makeHandle(); }

    private makeHandle(): InlinePanelHandle {
        return {
            appendMessage: (m) => this.appendMessage(m),
            appendStreamChunk: (id, c) => this.appendStreamChunk(id, c),
            finalizeBubble: (id) => this.finalizeBubble(id),
            appendCheckpointMarker: (m) => this.appendCheckpointMarker(m),
            insertIntoComposer: (text, mode) => this.insertIntoComposer(text, mode),
            setModelLabel: (label, tooltip) => this.setModelLabel(label, tooltip),
            setRunning: (running) => this.setRunning(running),
            setStatus: (t, l) => this.setStatus(t, l),
            refreshForcedWorkflow: () => this.renderForcedWorkflowChip(),
            startResultStream: () => this.startResultStream(),
            updateStreamingResult: (chunk) => this.updateStreamingResult(chunk),
            showResult: (markdown, actions) => this.showResult(markdown, actions),
            close: () => this.close(),
        };
    }

    private startResultStream(): void {
        if (this.resultContainerEl !== null) {
            this.resultContainerEl.remove();
            this.resultContainerEl = null;
        }
        if (this.rootEl === null) return;
        const container = createDiv('agent-inline-result');
        const content = container.createDiv('agent-inline-result__content');
        this.resultContainerEl = container;
        this.resultContentEl = content;
        this.rawResultText = '';
        this.activeResultActions = null;
        this.rootEl.appendChild(container);
    }

    private updateStreamingResult(chunk: string): void {
        if (this.resultContentEl === null) return;
        this.rawResultText += chunk;
        this.resultContentEl.textContent = this.rawResultText;
    }

    private async showResult(markdown: string, actions: InlineResultActions): Promise<void> {
        this.activeResultActions = actions;
        if (this.resultContainerEl === null || this.resultContentEl === null) {
            this.startResultStream();
        }
        if (this.resultContentEl === null || this.resultContainerEl === null) return;

        while (this.resultContentEl.firstChild !== null) {
            this.resultContentEl.removeChild(this.resultContentEl.firstChild);
        }

        if (this.renderMarkdownHook !== undefined) {
            try {
                await this.renderMarkdownHook(this.resultContentEl, markdown);
            } catch (e) {
                console.debug('[InlineChatPanel] renderMarkdown failed:', e);
                this.resultContentEl.textContent = markdown;
            }
        } else {
            this.resultContentEl.textContent = markdown;
        }

        if (this.resultActionsEl !== null) {
            this.resultActionsEl.remove();
        }

        const actionsBar = this.resultContainerEl.createDiv('agent-inline-result__actions');
        this.resultActionsEl = actionsBar;

        // Button 1: Replace
        const replaceBtn = actionsBar.createEl('button', {
            cls: 'agent-inline-result__btn agent-inline-result__btn--primary',
            attr: { type: 'button', title: '替换选中文本 (Enter)' },
        });
        replaceBtn.createSpan({ text: '替换原文字' });
        replaceBtn.createSpan({ cls: 'agent-inline-result__kbd', text: 'Enter' });
        replaceBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            void actions.onReplace();
        });

        // Button 2: Insert below
        const insertBtn = actionsBar.createEl('button', {
            cls: 'agent-inline-result__btn',
            attr: { type: 'button', title: '在选区下方换行插入' },
        });
        insertBtn.createSpan({ text: '插入到下方' });
        insertBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            void actions.onInsertBelow();
        });

        // Button 3: Copy
        const copyBtn = actionsBar.createEl('button', {
            cls: 'agent-inline-result__btn',
            attr: { type: 'button', title: '复制到剪贴板' },
        });
        copyBtn.createSpan({ text: '复制' });
        copyBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            void actions.onCopy();
        });

        // Button 4: Close
        const closeBtn = actionsBar.createEl('button', {
            cls: 'agent-inline-result__btn agent-inline-result__btn--ghost',
            attr: { type: 'button', title: '关闭 (Esc)' },
        });
        closeBtn.createSpan({ text: '关闭' });
        closeBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            actions.onClose();
        });
    }

    /**
     * FEAT-02-12: render (or clear) the forced-workflow status chip in the
     * composer. Non-interactive; turning the workflow off happens on its pin in
     * the "+" menu. Reads the slug via the injected callback so the panel stays
     * generic and unit-testable.
     */
    private renderForcedWorkflowChip(): void {
        if (this.forcedChipEl === null) return;
        while (this.forcedChipEl.firstChild !== null) {
            this.forcedChipEl.removeChild(this.forcedChipEl.firstChild);
        }
        const slug = this.getForcedWorkflowSlug?.() ?? '';
        if (slug === '') return;
        const chip = createDiv();
        chip.classList.add('chat-context-chip', 'chat-forced-workflow-chip');
        chip.setAttribute('title', t('ui.sidebar.forcedWorkflowChipTooltip', { slug }));
        const icon = createSpan();
        icon.classList.add('context-chip-icon');
        this.setIcon(icon, 'git-branch');
        chip.appendChild(icon);
        const label = createSpan();
        label.classList.add('context-chip-label');
        label.textContent = t('ui.sidebar.forcedWorkflowChipLabel', { slug });
        chip.appendChild(label);
        this.forcedChipEl.appendChild(chip);
    }

    private setRunning(running: boolean): void {
        if (this.sendButtonEl !== null) {
            this.sendButtonEl.classList.toggle('agent-u-hidden', running === true);
        }
        if (this.stopButtonEl !== null) {
            this.stopButtonEl.classList.toggle('agent-u-hidden', running !== true);
        }
        if (this.inputEl !== null && running === false) {
            this.inputEl.disabled = false;
            this.inputEl.setAttribute('placeholder', '询问 AI 或输入指令... (Enter 发送, Esc 关闭)');
            try { this.inputEl.focus(); } catch { /* test stub */ }
        }
    }

    private insertIntoComposer(text: string, mode: 'replace' | 'prepend' | 'append' = 'prepend'): void {
        if (this.inputEl === null) return;
        const cur = this.inputEl.value;
        let next: string;
        if (mode === 'replace') {
            next = text;
        } else if (mode === 'append') {
            next = cur.length > 0 ? `${cur}${cur.endsWith(' ') ? '' : ' '}${text}` : text;
        } else {
            const trimmed = text.trimEnd();
            next = cur.length > 0 ? `${trimmed} ${cur.trimStart()}` : `${trimmed} `;
        }
        this.inputEl.value = next;
        try { this.inputEl.focus(); } catch { /* test stub */ }
        const pos = this.inputEl.value.length;
        try { this.inputEl.setSelectionRange(pos, pos); } catch { /* test stub */ }
    }

    private setModelLabel(label: string, tooltip?: string): void {
        if (this.modelButtonEl === null) return;
        this.modelButtonEl.textContent = label;
        if (tooltip !== undefined) this.modelButtonEl.setAttribute('title', tooltip);
    }

    private appendCheckpointMarker(marker: InlineCheckpointMarker): string {
        if (this.bodyEl === null) return '';
        // Sidebar-parity DOM: the same `.checkpoint-marker`/`.checkpoint-*`
        // CSS hierarchy AgentSidebarView.renderCheckpointMarker uses, so
        // the inline panel inherits the divider-line + ghost-icon-button
        // look without a parallel stylesheet.
        const wrap = createDiv();
        wrap.classList.add('checkpoint-marker');
        wrap.classList.add('agent-inline-panel__bubble');
        wrap.classList.add('agent-inline-panel__bubble--checkpoint');

        const iconEl = createSpan();
        iconEl.classList.add('checkpoint-icon');
        this.setIcon(iconEl, 'git-commit-vertical');
        wrap.appendChild(iconEl);

        const labelEl = createSpan();
        labelEl.classList.add('checkpoint-label');
        const labelText = marker.detail !== undefined && marker.detail.length > 0
            ? `${marker.label} -- ${marker.detail}`
            : marker.label;
        labelEl.textContent = labelText;
        wrap.appendChild(labelEl);

        const actions = createDiv();
        actions.classList.add('checkpoint-actions');

        const makeBtn = (icon: string, tooltip: string, handler: () => void): HTMLButtonElement => {
            const btn = createEl('button');
            btn.classList.add('checkpoint-action-btn');
            btn.setAttribute('type', 'button');
            btn.setAttribute('aria-label', tooltip);
            this.setIcon(btn, icon);
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                try { handler(); } catch (e) { console.warn('[inline-checkpoint] action threw:', e); }
            });
            return btn;
        };

        if (marker.onShowDiff !== undefined) {
            actions.appendChild(makeBtn('file-diff', t('ui.inline.showDiff'), () => marker.onShowDiff?.()));
        }
        if (marker.onRestore !== undefined) {
            actions.appendChild(makeBtn('undo-2', t('ui.inline.undoThis'), () => marker.onRestore?.()));
        }
        if (marker.onRestoreFromHere !== undefined) {
            actions.appendChild(makeBtn('rotate-ccw', t('ui.inline.undoFromHere'), () => marker.onRestoreFromHere?.()));
        }
        if (marker.onMoreMenu !== undefined) {
            const moreBtn = makeBtn('more-vertical', t('ui.inline.moreOptions'), () => {
                marker.onMoreMenu?.(moreBtn);
            });
            actions.appendChild(moreBtn);
        }
        wrap.appendChild(actions);

        this.bodyEl.appendChild(wrap);
        this.bubbleCounter += 1;
        const id = `c${this.bubbleCounter}`;
        this.bubbleNodes.set(id, wrap);
        this.scrollToBottom();
        return id;
    }

    private appendMessage(message: InlinePanelMessage): string {
        if (this.bodyEl === null) return '';
        const bubble = createDiv();
        bubble.classList.add('agent-inline-panel__bubble');
        bubble.classList.add(`agent-inline-panel__bubble--${message.role}`);
        bubble.textContent = message.text;
        this.bodyEl.appendChild(bubble);
        this.bubbleCounter += 1;
        const id = `b${this.bubbleCounter}`;
        this.bubbleNodes.set(id, bubble);
        this.bubbleMarkdown.set(id, message.text);
        this.scrollToBottom();
        return id;
    }

    private appendStreamChunk(bubbleId: string, chunk: string): void {
        const bubble = this.bubbleNodes.get(bubbleId);
        if (bubble === undefined) return;
        // Plain-text accumulation during streaming (cheap, no layout
        // thrash). The raw markdown buffer is what finalizeBubble later
        // feeds into the MarkdownRenderer.
        bubble.textContent = (bubble.textContent ?? '') + chunk;
        this.bubbleMarkdown.set(bubbleId, (this.bubbleMarkdown.get(bubbleId) ?? '') + chunk);
        this.scrollToBottom();
    }

    /**
     * Replace the bubble's plain-text streaming content with rendered
     * markdown via the renderMarkdown hook. Idempotent: subsequent
     * calls with the same id re-render (useful if the appendix arrives
     * after the LLM stream and the action calls finalize twice).
     */
    private async finalizeBubble(bubbleId: string): Promise<void> {
        if (this.renderMarkdownHook === undefined) return;
        const bubble = this.bubbleNodes.get(bubbleId);
        const markdown = this.bubbleMarkdown.get(bubbleId);
        if (bubble === undefined || markdown === undefined || markdown.length === 0) return;
        // Clear plain-text content; the hook will populate it.
        while (bubble.firstChild !== null) {
            bubble.removeChild(bubble.firstChild);
        }
        try {
            await this.renderMarkdownHook(bubble, markdown);
        } catch (e) {
            // Fallback: restore plain text so the user still sees the answer.
            bubble.textContent = markdown;
            console.debug('[InlineChatPanel] renderMarkdown failed (fallback to plain text):', e);
        }
        this.scrollToBottom();
    }

    private setStatus(text: string, level: 'info' | 'error' = 'info'): void {
        if (this.statusEl === null) return;
        this.statusEl.classList.remove('agent-u-hidden');
        this.statusEl.classList.toggle('agent-inline-panel__status--error', level === 'error');
        this.statusEl.textContent = text;
    }

    private scrollToBottom(): void {
        if (this.bodyEl === null) return;
        try { this.bodyEl.scrollTop = this.bodyEl.scrollHeight; } catch { /* jsdom stub */ }
    }

    private clampToViewport(pos: { x: number; y: number }, root: HTMLElement): { x: number; y: number } {
        const win = this.containerEl.ownerDocument.defaultView;
        if (win === null) return pos;
        const rect = root.getBoundingClientRect();
        const width = rect.width > 0 ? rect.width : DEFAULT_WIDTH;
        const height = rect.height > 0 ? rect.height : 320;
        const maxX = Math.max(0, win.innerWidth - width - 8);
        const maxY = Math.max(0, win.innerHeight - height - 8);
        return {
            x: Math.max(8, Math.min(pos.x, maxX)),
            y: Math.max(8, Math.min(pos.y, maxY)),
        };
    }

    /**
     * Wire pointer drag on the slim header grip so the user can move
     * the panel anywhere on screen. Listeners are scoped to the
     * document so the gesture survives the cursor leaving the grip
     * element, and unbound on pointerup or panel close.
     */
    private attachDragHandle(handle: HTMLElement, root: HTMLElement): void {
        const doc = this.containerEl.ownerDocument;
        if (typeof handle.addEventListener !== 'function') return;
        handle.addEventListener('pointerdown', (ev: PointerEvent) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            const startX = ev.clientX;
            const startY = ev.clientY;
            const rect = root.getBoundingClientRect();
            const originX = rect.left;
            const originY = rect.top;
            const onMove = (mv: PointerEvent): void => {
                const nextX = originX + (mv.clientX - startX);
                const nextY = originY + (mv.clientY - startY);
                const clamped = this.clampToViewport({ x: nextX, y: nextY }, root);
                root.setCssStyles({ left: `${clamped.x}px`, top: `${clamped.y}px` });
            };
            const onUp = (): void => {
                doc.removeEventListener('pointermove', onMove);
                doc.removeEventListener('pointerup', onUp);
                doc.removeEventListener('pointercancel', onUp);
                this.dragCleanup = null;
            };
            doc.addEventListener('pointermove', onMove);
            doc.addEventListener('pointerup', onUp);
            doc.addEventListener('pointercancel', onUp);
            this.dragCleanup = onUp;
        });
    }

    /**
     * Wire pointer drag on the bottom-right corner so the user can
     * scale the panel. Width + height clamp to MIN_WIDTH/MIN_HEIGHT
     * and the viewport bounds; the chat body keeps its inner scroll.
     */
    private attachResizeHandle(handle: HTMLElement, root: HTMLElement): void {
        const doc = this.containerEl.ownerDocument;
        if (typeof handle.addEventListener !== 'function') return;
        handle.addEventListener('pointerdown', (ev: PointerEvent) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            ev.stopPropagation();
            const startX = ev.clientX;
            const startY = ev.clientY;
            const rect = root.getBoundingClientRect();
            const startW = rect.width;
            const startH = rect.height;
            const win = doc.defaultView;
            const maxW = win !== null ? Math.max(MIN_WIDTH, win.innerWidth - rect.left - 8) : 4096;
            const maxH = win !== null ? Math.max(MIN_HEIGHT, win.innerHeight - rect.top - 8) : 4096;
            const onMove = (mv: PointerEvent): void => {
                const nextW = Math.min(maxW, Math.max(MIN_WIDTH, startW + (mv.clientX - startX)));
                const nextH = Math.min(maxH, Math.max(MIN_HEIGHT, startH + (mv.clientY - startY)));
                root.setCssStyles({ width: `${nextW}px`, height: `${nextH}px` });
            };
            const onUp = (): void => {
                doc.removeEventListener('pointermove', onMove);
                doc.removeEventListener('pointerup', onUp);
                doc.removeEventListener('pointercancel', onUp);
                this.resizeCleanup = null;
            };
            doc.addEventListener('pointermove', onMove);
            doc.addEventListener('pointerup', onUp);
            doc.addEventListener('pointercancel', onUp);
            this.resizeCleanup = onUp;
        });
    }
}

function iconFallback(name: string): string {
    switch (name) {
        case 'plus': return '+';
        case 'search': return '🔍';
        case 'ellipsis': return '⋯';
        case 'send-horizontal': return '↵';
        default: return '◇';
    }
}
