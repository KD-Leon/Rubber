/**
 * HistoryPanel
 *
 * Sliding overlay panel that displays conversation history grouped by date.
 * Placed inside the chat container as an absolute-positioned overlay.
 */

import { Notice, setIcon } from 'obsidian';
import type { ConversationMeta, ConversationSearchHit, ConversationStore } from '../../core/history/ConversationStore';
import { t } from '../../i18n';

// ---------------------------------------------------------------------------
// Date grouping helpers
// ---------------------------------------------------------------------------

type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'older';

const DATE_GROUP_KEYS: Record<DateGroup, string> = {
    today: 'ui.history.today',
    yesterday: 'ui.history.yesterday',
    thisWeek: 'ui.history.thisWeek',
    older: 'ui.history.older',
};

function getDateGroup(isoDate: string): DateGroup {
    const date = new Date(isoDate);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
    const weekStart = new Date(todayStart.getTime() - todayStart.getDay() * 86_400_000);

    if (date >= todayStart) return 'today';
    if (date >= yesterdayStart) return 'yesterday';
    if (date >= weekStart) return 'thisWeek';
    return 'older';
}

function formatTime(isoDate: string): string {
    const d = new Date(isoDate);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDate(isoDate: string): string {
    const d = new Date(isoDate);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// HistoryPanel
// ---------------------------------------------------------------------------

type SourceTab = 'all' | 'obsilo' | 'claude-ai' | 'claude-code' | 'chatgpt' | 'perplexity' | 'unknown';
const SOURCE_TAB_KEYS: Record<SourceTab, string> = {
    'all': 'ui.history.sourceAll',
    'obsilo': 'ui.history.sourceObsilo',
    'claude-ai': 'ui.history.sourceClaudeAi',
    'claude-code': 'ui.history.sourceClaudeCode',
    'chatgpt': 'ui.history.sourceChatgpt',
    'perplexity': 'ui.history.sourcePerplexity',
    'unknown': 'ui.history.sourceUnknown',
};

export class HistoryPanel {
    private panelEl: HTMLElement | null = null;
    private isOpen = false;
    private filterText = '';
    private memoryOnly = false;
    /** BA-26 / FEAT-23-03: active Source-Tab. 'all' shows everything. */
    private sourceTab: SourceTab = 'all';
    /** FIX-23-01-01: when set, filter list to one cross-interface thread; null = no filter. */
    private threadFilter: string | null = null;
    /** FIX-PERF-38: per-date-group lazy-render page size. */
    private groupPageSize = new Map<DateGroup, number>();
    /** Full-text matches for the current filter (null = not scanned yet). */
    private contentHits: ConversationSearchHit[] | null = null;
    /** Race guard: only the newest content search may paint results. */
    private contentSearchSeq = 0;

    constructor(
        private store: ConversationStore,
        private onLoad: (id: string) => void,
        private onDelete: (id: string) => void,
        private onStampLink: (conversationId: string, title: string) => void,
        private activeConversationId: string | null,
        private onSaveToMemory: ((id: string, title: string) => Promise<void> | void) | null = null,
        private onRemoveFromMemory: ((id: string, title: string) => Promise<void> | void) | null = null,
        private isInMemory: ((id: string) => boolean) | null = null,
        private onRename: ((id: string, currentTitle: string) => Promise<void> | void) | null = null,
        /** BA-26 / FEAT-23-04: confirm a pending external conversation (Manual-Sync). */
        private onConfirmPending: ((id: string, title: string) => Promise<void> | void) | null = null,
        /**
         * FEAT-55-01 (user request 2026-07-25): true when this conversation
         * has an interrupted-task snapshot, so History can tag it. Lets the
         * user find resumable chats in History instead of relying on a notice.
         */
        private isInterrupted: ((id: string) => boolean) | null = null,
    ) {}

    private outsideClickListener: ((e: MouseEvent) => void) | null = null;
    private isSearchOpen = false;

    /** Mount the panel inside a parent container. */
    mount(parent: HTMLElement): void {
        this.panelEl = parent.createDiv({ cls: 'history-panel' });
        this.panelEl.classList.add('agent-u-hidden');
    }

    /** Toggle open/close. */
    toggle(): void {
        if (this.isOpen) this.close();
        else this.open();
    }

    open(): void {
        if (!this.panelEl) return;
        this.isOpen = true;
        this.filterText = '';
        this.memoryOnly = false;
        this.render();
        this.panelEl.classList.remove('agent-u-hidden');
        window.requestAnimationFrame(() => this.panelEl?.addClass('history-panel-open'));

        // Close when clicking outside the history popover
        if (!this.outsideClickListener) {
            this.outsideClickListener = (e: MouseEvent) => {
                const target = e.target as HTMLElement | null;
                if (!target) return;
                if (this.panelEl && !this.panelEl.contains(target) && !target.closest('.agent-title')) {
                    this.close();
                }
            };
            window.addEventListener('mousedown', this.outsideClickListener, true);
        }
    }

    close(): void {
        if (!this.panelEl) return;
        this.isOpen = false;
        this.panelEl.removeClass('history-panel-open');
        if (this.outsideClickListener) {
            window.removeEventListener('mousedown', this.outsideClickListener, true);
            this.outsideClickListener = null;
        }
        window.setTimeout(() => {
            if (!this.isOpen && this.panelEl) this.panelEl.classList.add('agent-u-hidden');
        }, 150);
    }

    /** Update active conversation id (for highlighting). */
    setActiveId(id: string | null): void {
        this.activeConversationId = id;
        if (this.isOpen) this.render();
    }

    /** Refresh if open (e.g., after a save). */
    refresh(): void {
        if (this.isOpen) this.render();
    }

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    private render(): void {
        if (!this.panelEl) return;
        this.panelEl.empty();

        // Popover Header (Notion dropdown style: "历史对话" on left, Search icon on right)
        const header = this.panelEl.createDiv({ cls: 'history-panel-header' });
        header.createSpan({ cls: 'history-panel-title', text: '历史对话' });

        const headerActions = header.createDiv({ cls: 'history-panel-header-actions' });

        if (this.isInMemory) {
            const memToggle = headerActions.createEl('button', {
                cls: `history-panel-icon-btn${this.memoryOnly ? ' is-active' : ''}`,
                attr: { 'aria-label': t('ui.history.filterMemoryOnly') },
            });
            setIcon(memToggle, 'star');
            memToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.memoryOnly = !this.memoryOnly;
                this.render();
            });
        }

        const searchBtn = headerActions.createEl('button', {
            cls: `history-panel-icon-btn${this.isSearchOpen ? ' is-active' : ''}`,
            attr: { 'aria-label': t('ui.history.filter') },
        });
        setIcon(searchBtn, 'search');
        searchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.isSearchOpen = !this.isSearchOpen;
            this.render();
            if (this.isSearchOpen) {
                this.panelEl?.querySelector<HTMLInputElement>('.history-panel-filter-input')?.focus();
            }
        });

        // Search Input (toggled or when filter text exists)
        if (this.isSearchOpen || this.filterText) {
            const filterRow = this.panelEl.createDiv({ cls: 'history-panel-filter' });
            const filterInput = filterRow.createEl('input', {
                type: 'text',
                placeholder: t('ui.history.searchPlaceholder'),
                cls: 'history-panel-filter-input',
            });
            filterInput.value = this.filterText;
            let filterDebounce: number | null = null;
            filterInput.addEventListener('input', () => {
                this.filterText = filterInput.value;
                if (filterDebounce !== null) window.clearTimeout(filterDebounce);
                filterDebounce = window.setTimeout(() => {
                    filterDebounce = null;
                    this.renderList(listEl);
                    void this.runContentSearch(listEl);
                }, 200);
            });
        }

        // List
        const listEl = this.panelEl.createDiv({ cls: 'history-panel-list' });
        this.renderList(listEl);
    }

    private renderList(container: HTMLElement): void {
        container.empty();

        let conversations = this.store.list();
        // FIX-23-01-01: Thread-Filter ueberschreibt Source-Tab-Filter --
        // wer einen Thread anklickt, will Conversations aller Surfaces sehen.
        if (this.threadFilter) {
            conversations = conversations.filter((c) =>
                c.crossInterfaceThreadId === this.threadFilter
            );
        } else if (this.sourceTab !== 'all') {
            // BA-26 / FEAT-23-03: Source-Tab-Filter, vollstaendige Trennung pro
            // Provider. Conversations ohne Tag gelten als 'obsilo'.
            conversations = conversations.filter((c) =>
                ((c.sourceInterface ?? 'obsilo') as SourceTab) === this.sourceTab
            );
        }
        if (this.filterText) {
            const lower = this.filterText.toLowerCase();
            conversations = conversations.filter((c) => c.title.toLowerCase().includes(lower));
        }
        if (this.memoryOnly && this.isInMemory) {
            conversations = conversations.filter((c) => this.isInMemory!(c.id));
        }

        if (conversations.length === 0) {
            container.createDiv({ cls: 'history-panel-empty', text: t('ui.history.empty') });
            return;
        }

        // Group by date
        const groups = new Map<DateGroup, ConversationMeta[]>();
        const order: DateGroup[] = ['today', 'yesterday', 'thisWeek', 'older'];
        for (const c of conversations) {
            const group = getDateGroup(c.updated);
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group)!.push(c);
        }

        // FIX-PERF-38: cap initial render per group at PAGE_SIZE so a
        // 368-conversation history paints in milliseconds. The user
        // clicks "Show more" inside each group to expand on demand.
        // The per-group counter survives renders (instance state).
        const PAGE_SIZE = 50;
        for (const groupName of order) {
            const items = groups.get(groupName);
            if (!items || items.length === 0) continue;

            container.createDiv({ cls: 'history-group-label', text: t(DATE_GROUP_KEYS[groupName]) });

            const visible = this.groupPageSize.get(groupName) ?? PAGE_SIZE;
            const slice = items.slice(0, visible);
            for (const conv of slice) {
                const row = container.createDiv({
                    cls: `history-row${conv.id === this.activeConversationId ? ' history-row-active' : ''}`,
                });

                const info = row.createDiv({ cls: 'history-row-info' });
                const titleRow = info.createDiv({ cls: 'history-row-title-row' });
                titleRow.createDiv({ cls: 'history-row-title', text: conv.title });
                // BA-26 / FEAT-23-03: Source-Pill (nur fuer non-obsilo + non-default).
                const source = conv.sourceInterface ?? 'obsilo';
                if (source !== 'obsilo') {
                    const sourceKey = SOURCE_TAB_KEYS[source as SourceTab] as string | undefined;
                    titleRow.createSpan({
                        cls: `history-row-source-pill history-row-source-pill-${source}`,
                        text: sourceKey ? t(sourceKey) : source,
                    });
                }
                // BA-26 / FEAT-23-04: Pending-Marker fuer Manual-Sync Conversations.
                if (conv.syncState === 'pending') {
                    titleRow.createSpan({
                        cls: 'history-row-pending-marker',
                        text: t('ui.history.pendingMarker'),
                    });
                }
                // FEAT-55-01 (user request 2026-07-25): tag conversations with
                // an interrupted-task snapshot so the user spots resumable chats
                // directly in History.
                if (this.isInterrupted?.(conv.id)) {
                    titleRow.createSpan({
                        cls: 'history-row-interrupted-marker',
                        text: t('ui.history.interruptedMarker'),
                        attr: { 'aria-label': t('ui.history.interruptedMarker') },
                    });
                }
                // FIX-23-01-01: Thread-Pill fuer Conversations mit
                // crossInterfaceThreadId. Klick filtert auf Thread-Mitglieder
                // ueber alle Source-Tabs hinweg. Skip wenn schon im
                // Thread-Filter (kein Sinn).
                if (conv.crossInterfaceThreadId && this.threadFilter !== conv.crossInterfaceThreadId) {
                    const threadPill = titleRow.createEl('button', {
                        cls: 'history-row-thread-pill',
                        text: t('ui.history.threadPill'),
                        attr: { 'aria-label': t('ui.history.filterByThread', { threadId: conv.crossInterfaceThreadId }) },
                    });
                    threadPill.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.threadFilter = conv.crossInterfaceThreadId ?? null;
                        this.render();
                    });
                }
                const meta = info.createDiv({ cls: 'history-row-meta' });
                const timeStr = groupName === 'today' || groupName === 'yesterday'
                    ? formatTime(conv.updated)
                    : formatDate(conv.updated);
                meta.createSpan({ text: timeStr });
                meta.createSpan({ text: ` \u00B7 ${t('ui.history.messageCount', { count: conv.messageCount })}` });

                // Action buttons (visible on hover)
                const actions = row.createDiv({ cls: 'history-row-actions' });

                // BA-26 / FEAT-23-04: Confirm-Button fuer Pending-Conversations.
                if (conv.syncState === 'pending' && this.onConfirmPending) {
                    const confirmBtn = actions.createEl('button', { cls: 'history-row-action clickable-icon' });
                    setIcon(confirmBtn, 'check');
                    confirmBtn.setAttribute('aria-label', t('ui.history.confirmPending'));
                    confirmBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const action = this.onConfirmPending!(conv.id, conv.title);
                        Promise.resolve(action).then(() => this.render()).catch(() => undefined);
                    });
                }

                const copyBtn = actions.createEl('button', { cls: 'history-row-action clickable-icon' });
                setIcon(copyBtn, 'link');
                copyBtn.setAttribute('aria-label', t('ui.history.copyLink'));
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const uri = `obsidian://vault-operator-chat?id=${encodeURIComponent(conv.id)}`;
                    let linkTitle = conv.title.replace(/\n.*/s, '').trim();
                    if (linkTitle.length > 60) linkTitle = linkTitle.slice(0, 57) + '...';
                    const mdLink = `[${linkTitle}](${uri})`;
                    void navigator.clipboard.writeText(mdLink).then(() => {
                        new Notice(t('ui.history.linkCopied'));
                    });
                });

                if (this.onRename) {
                    const renameBtn = actions.createEl('button', { cls: 'history-row-action clickable-icon' });
                    setIcon(renameBtn, 'pencil');
                    renameBtn.setAttribute('aria-label', t('ui.history.rename'));
                    renameBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const action = this.onRename!(conv.id, conv.title);
                        Promise.resolve(action).then(() => this.render()).catch(() => undefined);
                    });
                }

                const stampBtn = actions.createEl('button', { cls: 'history-row-action clickable-icon' });
                setIcon(stampBtn, 'file-plus');
                stampBtn.setAttribute('aria-label', t('ui.history.addToNote'));
                stampBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    let linkTitle = conv.title.replace(/\n.*/s, '').trim();
                    if (linkTitle.length > 60) linkTitle = linkTitle.slice(0, 57) + '...';
                    this.onStampLink(conv.id, linkTitle);
                });

                if (this.onSaveToMemory) {
                    const inMem = this.isInMemory?.(conv.id) ?? false;
                    const memBtn = actions.createEl('button', {
                        cls: `history-row-action clickable-icon${inMem ? ' history-row-action-pinned' : ''}`,
                    });
                    setIcon(memBtn, 'star');
                    memBtn.setAttribute('aria-label', inMem
                        ? t('ui.history.removeFromMemory')
                        : t('ui.history.saveToMemory'));
                    memBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        let title = conv.title.replace(/\n.*/s, '').trim();
                        if (title.length > 60) title = title.slice(0, 57) + '...';
                        const action = inMem
                            ? this.onRemoveFromMemory?.(conv.id, title)
                            : this.onSaveToMemory!(conv.id, title);
                        Promise.resolve(action).then(() => this.render()).catch(() => undefined);
                    });
                }

                const delBtn = actions.createEl('button', { cls: 'history-row-action history-row-action-danger clickable-icon' });
                setIcon(delBtn, 'trash-2');
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.onDelete(conv.id);
                    this.render();
                });

                row.addEventListener('click', () => {
                    this.onLoad(conv.id);
                    this.close();
                });
            }

            // FIX-PERF-38: per-group "Show more" button. Reveals
            // PAGE_SIZE more entries from the same group, then
            // re-renders. Hidden once the group is fully expanded.
            if (items.length > visible) {
                const remaining = items.length - visible;
                const more = container.createDiv({
                    cls: 'history-row history-row-show-more',
                    text: t('ui.history.showMore', { count: Math.min(PAGE_SIZE, remaining), hidden: remaining }),
                });
                more.addEventListener('click', () => {
                    this.groupPageSize.set(groupName, visible + PAGE_SIZE);
                    this.renderList(container);
                });
            }
        }

        // Full-text matches live below the title list so instant title
        // filtering stays snappy while the disk scan runs in background.
        this.renderContentMatches(container);
    }

    /**
     * Scan conversation bodies for the current filter text (debounced by
     * the input handler). Results are race-guarded: only the newest scan
     * paints, and a stale result is discarded.
     */
    private async runContentSearch(container: HTMLElement): Promise<void> {
        const q = this.filterText.trim();
        if (q.length < 2) {
            this.contentHits = null;
            container.querySelector('.history-content-matches')?.remove();
            return;
        }
        const seq = ++this.contentSearchSeq;
        this.contentHits = null;
        container.querySelector('.history-content-matches')?.remove();
        const pending = container.createDiv({ cls: 'history-content-matches' });
        pending.createDiv({ cls: 'history-content-label', text: t('ui.history.searchingContent') });
        const hits = await this.store.searchContent(q);
        if (seq !== this.contentSearchSeq || !container.isConnected) return;
        this.contentHits = hits;
        pending.remove();
        this.renderContentMatches(container);
    }

    /** Paint (or clear) the "content matches" section under the list. */
    private renderContentMatches(container: HTMLElement): void {
        container.querySelector('.history-content-matches')?.remove();
        const q = this.filterText.trim();
        if (q.length < 2) return;
        const section = container.createDiv({ cls: 'history-content-matches' });
        section.createDiv({ cls: 'history-content-label', text: t('ui.history.contentMatches') });
        if (this.contentHits === null) return; // still scanning; placeholder painted by runContentSearch
        if (this.contentHits.length === 0) {
            section.createDiv({ cls: 'history-content-empty', text: t('ui.history.contentNoMatches') });
            return;
        }
        for (const hit of this.contentHits) {
            const row = section.createDiv({ cls: 'history-row history-row-content' });
            const info = row.createDiv({ cls: 'history-row-info' });
            info.createDiv({ cls: 'history-row-title', text: hit.conversation.title });
            info.createDiv({ cls: 'history-row-snippet', text: hit.snippet });
            const meta = info.createDiv({ cls: 'history-row-meta' });
            meta.createSpan({ text: t('ui.history.matchCount', { count: hit.matchCount }) });
            row.addEventListener('click', () => {
                this.onLoad(hit.conversation.id);
                this.close();
            });
        }
    }
}
