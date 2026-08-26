/**
 * MemoryViewerModal -- read + delete view over all Memory v2 facts.
 *
 * Built for data sovereignty: the user can see exactly what Vault Operator
 * stores and remove anything. Editing/adding lives in the chat
 * (the agent uses update_soul / mark_for_memory), not here.
 *
 * Three sections:
 *   1. User memory      profile_id != '_obsilo' (or 'default')
 *   2. Vault Operator's soul    profile_id == '_obsilo', topics contains 'soul'
 *   3. Capabilities     profile_id == '_obsilo', topics contains 'capability' (read-only)
 *
 * FEATURE-0319b follow-up: replaces the editor UI in MemoryTab with a
 * single "View memory" button + this modal.
 */

import { App, Modal, Notice, setIcon } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { FactStore, type Fact } from '../../core/memory/FactStore';
import { OBSILO_PROFILE } from '../../core/memory/SoulView';
import { confirmModal, promptModal } from './PromptModal';
import { t } from '../../i18n';

type Tab = 'all' | 'user' | 'soul' | 'capabilities';

export class MemoryViewerModal extends Modal {
    private filterText = '';
    private activeTab: Tab = 'all';

    constructor(app: App, private plugin: ObsidianAgentPlugin) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText(t('settings.memory.headingContents'));
        this.contentEl.empty();
        this.contentEl.addClass('memory-viewer-modal');
        // v2.10.4: also flag the outer modal element so CSS can size it
        // without using :has() (which the review-bot warns about as
        // having broad selector-invalidation cost).
        this.modalEl.addClass('memory-viewer-modal-container');
        this.render();
    }

    private render(): void {
        this.contentEl.empty();

        if (!this.plugin.memoryDB?.isOpen()) {
            this.contentEl.createEl('p', {
                cls: 'memory-viewer-empty',
                text: t('notice.memory.dbNotOpen'),
            });
            return;
        }

        const intro = this.contentEl.createEl('p', { cls: 'memory-viewer-intro' });
        intro.setText(t('modal.memoryViewer.intro'));

        // Compute counts per bucket
        const factStore = new FactStore(this.plugin.memoryDB);
        const all = factStore.listLatest({ limit: 5000 });
        const userFacts = all.filter(f => f.profileId !== OBSILO_PROFILE);
        const soulFacts = all.filter(f =>
            f.profileId === OBSILO_PROFILE && f.topics.includes('soul'));
        const capabilityFacts = all.filter(f =>
            f.profileId === OBSILO_PROFILE && f.topics.includes('capability'));
        let sessionCount = 0;
        try {
            const result = this.plugin.memoryDB.getDB().exec('SELECT COUNT(*) FROM sessions');
            if (result.length > 0 && result[0].values.length > 0) {
                sessionCount = Number(result[0].values[0][0]);
            }
        } catch { /* sessions table may not exist on fresh DB */ }

        const stats = this.contentEl.createEl('p', { cls: 'memory-viewer-stats' });
        stats.setText(t('modal.memoryViewer.stats', { factCount: all.length, sessionCount }));

        // Tab switcher
        const tabBar = this.contentEl.createDiv({ cls: 'memory-viewer-tabs' });
        const tabs: Array<{ key: Tab; label: string; count: number }> = [
            { key: 'all', label: t('modal.memoryViewer.tabAll'), count: all.length },
            { key: 'user', label: t('modal.memoryViewer.tabUser'), count: userFacts.length },
            { key: 'soul', label: t('modal.memoryViewer.tabSoul'), count: soulFacts.length },
            { key: 'capabilities', label: t('modal.memoryViewer.tabCapabilities'), count: capabilityFacts.length },
        ];
        for (const tab of tabs) {
            const btn = tabBar.createEl('button', {
                cls: `memory-viewer-tab${this.activeTab === tab.key ? ' memory-viewer-tab-active' : ''}`,
                text: t('modal.memoryViewer.labelWithCount', { label: tab.label, count: tab.count }),
            });
            btn.addEventListener('click', () => {
                this.activeTab = tab.key;
                this.render();
            });
        }

        // Filter input
        const filterRow = this.contentEl.createDiv({ cls: 'memory-viewer-filter' });
        const filterInput = filterRow.createEl('input', {
            type: 'text',
            placeholder: t('modal.memoryViewer.filterPlaceholder'),
        });
        filterInput.value = this.filterText;
        filterInput.addEventListener('input', () => {
            this.filterText = filterInput.value;
            this.renderLists(listsContainer);
        });

        // Lists container -- rebuilt on filter change
        const listsContainer = this.contentEl.createDiv({ cls: 'memory-viewer-lists' });
        this.renderLists(listsContainer);

        // Right-to-be-forgotten footer
        const footer = this.contentEl.createDiv({ cls: 'memory-viewer-footer' });
        const wipeBtn = footer.createEl('button', {
            cls: 'memory-viewer-wipe',
            text: t('settings.memory.deleteAll'),
        });
        wipeBtn.addEventListener('click', () => { void this.handleWipeAll(); });
        footer.createSpan({
            cls: 'memory-viewer-footer-hint',
            text: t('modal.memoryViewer.wipeHint'),
        });
    }

    private renderLists(container: HTMLElement): void {
        container.empty();
        const factStore = new FactStore(this.plugin.memoryDB!);
        const all = factStore.listLatest({ limit: 5000 });

        const userFacts = all.filter(f => f.profileId !== OBSILO_PROFILE);
        const soulFacts = all.filter(f =>
            f.profileId === OBSILO_PROFILE && f.topics.includes('soul'));
        const capabilityFacts = all.filter(f =>
            f.profileId === OBSILO_PROFILE && f.topics.includes('capability'));

        const filterFn = (facts: Fact[]) => this.filterText
            ? facts.filter(f =>
                f.text.toLowerCase().includes(this.filterText.toLowerCase())
                || f.topics.join(' ').toLowerCase().includes(this.filterText.toLowerCase()))
            : facts;

        if (this.activeTab === 'all' || this.activeTab === 'user') {
            this.renderSection(container, t('modal.memoryViewer.tabUser'), filterFn(userFacts), true,
                t('modal.memoryViewer.sectionUserDesc'));
        }
        if (this.activeTab === 'all' || this.activeTab === 'soul') {
            this.renderSection(container, t('modal.memoryViewer.tabSoul'), filterFn(soulFacts), true,
                t('modal.memoryViewer.sectionSoulDesc'));
        }
        if (this.activeTab === 'all' || this.activeTab === 'capabilities') {
            this.renderSection(container, t('modal.memoryViewer.sectionCapabilitiesReadonly'), filterFn(capabilityFacts), false,
                t('modal.memoryViewer.sectionCapabilitiesDesc'));
        }
    }

    private renderSection(
        container: HTMLElement,
        title: string,
        facts: Fact[],
        editable: boolean,
        description: string,
    ): void {
        const section = container.createDiv({ cls: 'memory-viewer-section' });
        const header = section.createDiv({ cls: 'memory-viewer-section-header' });
        header.createEl('h3', { text: t('modal.memoryViewer.labelWithCount', { label: title, count: facts.length }) });
        section.createDiv({ cls: 'memory-viewer-section-desc', text: description });

        if (facts.length === 0) {
            section.createDiv({ cls: 'memory-viewer-empty', text: t('modal.memoryViewer.noEntries') });
            return;
        }

        const list = section.createEl('ul', { cls: 'memory-viewer-list' });
        for (const fact of facts) {
            const item = list.createEl('li', { cls: 'memory-viewer-item' });
            const main = item.createDiv({ cls: 'memory-viewer-item-main' });
            main.createDiv({ cls: 'memory-viewer-item-text', text: fact.text });

            // Tag chips: primary category + secondary topics
            const tags = main.createDiv({ cls: 'memory-viewer-item-tags' });
            const primary = primaryTag(fact);
            if (primary) {
                tags.createSpan({ cls: 'memory-viewer-tag memory-viewer-tag-primary', text: primary });
            }
            for (const topic of fact.topics) {
                if (topic === primary || topic === 'soul' || topic === 'capability') continue;
                tags.createSpan({ cls: 'memory-viewer-tag', text: topic });
            }

            // Date below tags
            const meta = main.createDiv({ cls: 'memory-viewer-item-meta' });
            meta.createSpan({ text: shortDate(fact.lastConfirmedAt) });

            const actions = item.createDiv({ cls: 'memory-viewer-item-actions' });
            if (editable) {
                const editBtn = actions.createEl('button', {
                    cls: 'memory-viewer-item-edit clickable-icon',
                    attr: { 'aria-label': t('modal.memoryViewer.editAria') },
                });
                setIcon(editBtn, 'pencil');
                editBtn.addEventListener('click', () => { void this.handleEdit(fact); });

                const delBtn = actions.createEl('button', {
                    cls: 'memory-viewer-item-delete clickable-icon',
                    attr: { 'aria-label': t('modal.memoryViewer.deleteAria') },
                });
                setIcon(delBtn, 'trash-2');
                delBtn.addEventListener('click', () => { void this.handleDelete(fact); });
            }
        }
    }

    private async handleEdit(fact: Fact): Promise<void> {
        const next = await promptModal(this.app, {
            title: t('modal.memoryViewer.editTitle'),
            message: t('modal.memoryViewer.editMessage'),
            placeholder: fact.text,
            defaultValue: fact.text,
            submitLabel: t('modal.modelConfig.save'),
        });
        if (next === null) return;
        const trimmed = next.trim();
        if (!trimmed || trimmed === fact.text) return;
        const factStore = new FactStore(this.plugin.memoryDB!);
        factStore.supersede(fact.id, {
            text: trimmed,
            topics: fact.topics,
            importance: fact.importance,
            kind: fact.kind,
            sourceSessionId: fact.sourceSessionId,
            sourceThreadId: fact.sourceThreadId,
            sourceInterface: fact.sourceInterface,
            sourceUri: fact.sourceUri,
            profileId: fact.profileId,
            metadata: fact.metadata,
        });
        await this.plugin.memoryDB!.save().catch(() => undefined);
        new Notice(t('notice.memory.entryUpdated'));
        this.render();
    }

    /** Right-to-be-forgotten flow lives next to this modal in the UI layer. */
    private async handleWipeAll(): Promise<void> {
        const { confirmAndWipeAllMemory } = await import('./wipeAllMemory');
        const outcome = await confirmAndWipeAllMemory(this.app, this.plugin);
        if (outcome === 'deleted') this.close();
    }

    private async handleDelete(fact: Fact): Promise<void> {
        const ok = await confirmModal(this.app, {
            title: t('modal.memoryViewer.deleteTitle'),
            message: t('modal.memoryViewer.deleteMessage', { text: fact.text }),
            confirmLabel: t('modal.memoryViewer.deleteConfirm'),
            cancelLabel: t('modal.modelConfig.cancel'),
            destructive: true,
        });
        if (!ok) return;
        const factStore = new FactStore(this.plugin.memoryDB!);
        factStore.deprecate(fact.id, 'removed by user via memory viewer');
        await this.plugin.memoryDB!.save().catch(() => undefined);
        new Notice(t('notice.memory.entryRemoved'));
        this.render();
    }
}

/**
 * Primary "where this lives" tag. For soul facts, the L2 sub-category
 * (value/anti_pattern/identity/communication). For capabilities, the
 * area (tool/ui/setting/mode). For user facts, the kind.
 */
function primaryTag(fact: Fact): string | null {
    if (fact.profileId === OBSILO_PROFILE) {
        if (fact.topics.includes('soul')) {
            for (const c of ['identity', 'value', 'anti_pattern', 'communication']) {
                if (fact.topics.includes(c)) return c;
            }
            return 'soul';
        }
        if (fact.topics.includes('capability')) {
            for (const a of ['tool', 'ui', 'setting', 'mode', 'command']) {
                if (fact.topics.includes(a)) return a;
            }
            return 'capability';
        }
    }
    return fact.kind;
}

function shortDate(iso: string): string {
    try {
        return new Date(iso).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
        });
    } catch {
        return iso;
    }
}
