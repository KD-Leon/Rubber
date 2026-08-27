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

import { App, Modal, Notice, setIcon, setTooltip } from 'obsidian';
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
        this.titleEl.setText('智能记忆库');
        this.contentEl.empty();
        this.contentEl.addClass('memory-viewer-modal');
        this.modalEl.addClass('memory-viewer-modal-container');
        this.render();
    }

    private render(): void {
        this.contentEl.empty();

        if (!this.plugin.memoryDB?.isOpen()) {
            const emptyWrap = this.contentEl.createDiv('memory-empty-state');
            const iconEl = emptyWrap.createSpan('memory-empty-icon');
            setIcon(iconEl, 'database');
            emptyWrap.createEl('div', { cls: 'memory-empty-title', text: t('notice.memory.dbNotOpen') });
            return;
        }

        // Header Top Row (Subtitle + Stats pill)
        const headerRow = this.contentEl.createDiv('memory-viewer-header-row');
        headerRow.createEl('p', {
            cls: 'memory-viewer-intro',
            text: 'AI 在多次对话中提炼的个人偏好、背景知识与习惯，用于在后续交流中提供个性化回答。',
        });

        // Compute counts per bucket
        const factStore = new FactStore(this.plugin.memoryDB);
        const all = factStore.listLatest({ limit: 5000 });
        const userFacts = all.filter(f => f.profileId !== OBSILO_PROFILE);
        const soulFacts = all.filter(f =>
            f.profileId === OBSILO_PROFILE && f.topics.includes('soul'));
        const capabilityFacts = all.filter(f =>
            f.profileId === OBSILO_PROFILE && f.topics.includes('capability'));

        // Segmented Tabs & Search Row
        const controlsRow = this.contentEl.createDiv('memory-viewer-controls-row');

        const tabBar = controlsRow.createDiv({ cls: 'memory-viewer-segmented-tabs' });
        const tabs: Array<{ key: Tab; label: string; count: number }> = [
            { key: 'all', label: '全部', count: all.length },
            { key: 'user', label: '用户偏好', count: userFacts.length },
            { key: 'soul', label: '设定与习惯', count: soulFacts.length },
            { key: 'capabilities', label: '系统能力', count: capabilityFacts.length },
        ];
        for (const tab of tabs) {
            const btn = tabBar.createEl('button', {
                cls: `memory-viewer-tab-btn${this.activeTab === tab.key ? ' is-active' : ''}`,
                text: `${tab.label} ${tab.count}`,
            });
            btn.addEventListener('click', () => {
                this.activeTab = tab.key;
                this.render();
            });
        }

        // Search Input
        const searchWrap = controlsRow.createDiv('memory-viewer-search-wrap');
        const searchIcon = searchWrap.createSpan('memory-viewer-search-icon');
        setIcon(searchIcon, 'search');
        const filterInput = searchWrap.createEl('input', {
            cls: 'memory-viewer-search-input',
            type: 'text',
            placeholder: '搜索记忆与关键词...',
        });
        filterInput.value = this.filterText;
        filterInput.addEventListener('input', () => {
            this.filterText = filterInput.value;
            this.renderLists(listsContainer);
        });

        // Lists container -- rebuilt on filter change
        const listsContainer = this.contentEl.createDiv({ cls: 'memory-viewer-cards-container' });
        this.renderLists(listsContainer);

        // Footer Action Bar
        const footer = this.contentEl.createDiv({ cls: 'memory-viewer-footer' });
        const wipeBtn = footer.createEl('button', {
            cls: 'memory-viewer-wipe-btn',
            text: '清空所有记忆',
        });
        setTooltip(wipeBtn, '永久删除所有已存储的用户记忆与偏好', { delay: 50 });
        wipeBtn.addEventListener('click', () => { void this.handleWipeAll(); });

        const footerRight = footer.createDiv('memory-viewer-footer-right');
        const countText = footerRight.createSpan({
            cls: 'memory-viewer-stats-pill',
            text: `共 ${all.length} 条记忆`,
        });
        const closeBtn = footerRight.createEl('button', {
            cls: 'mod-cta',
            text: '完成',
        });
        closeBtn.addEventListener('click', () => this.close());
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

        let renderedCount = 0;

        if (this.activeTab === 'all' || this.activeTab === 'user') {
            const list = filterFn(userFacts);
            if (this.activeTab === 'user' || list.length > 0) {
                this.renderSection(container, '用户偏好与习惯', list, true, '通过日常对话学习到的关于你的事实与偏好');
                renderedCount += list.length;
            }
        }
        if (this.activeTab === 'all' || this.activeTab === 'soul') {
            const list = filterFn(soulFacts);
            if (this.activeTab === 'soul' || list.length > 0) {
                this.renderSection(container, '智能体设定与风格', list, true, 'AI 的角色设定、回复风格与特定约定');
                renderedCount += list.length;
            }
        }
        if (this.activeTab === 'all' || this.activeTab === 'capabilities') {
            const list = filterFn(capabilityFacts);
            if (this.activeTab === 'capabilities' || list.length > 0) {
                this.renderSection(container, '内置系统能力', list, false, '由插件功能自动注册的能力与工具配置（只读）');
                renderedCount += list.length;
            }
        }

        if (renderedCount === 0) {
            const emptyWrap = container.createDiv('memory-empty-state');
            const iconEl = emptyWrap.createSpan('memory-empty-icon');
            setIcon(iconEl, 'brain');
            emptyWrap.createEl('div', {
                cls: 'memory-empty-title',
                text: this.filterText ? '未找到匹配的记忆' : '暂无此类记忆',
            });
            emptyWrap.createEl('div', {
                cls: 'memory-empty-desc',
                text: this.filterText ? '尝试使用其他关键词搜索。' : '随着日常对话的进行，AI 会自动从对话中提炼并记录在此处。',
            });
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
        const titleEl = header.createDiv('memory-section-title-wrap');
        titleEl.createSpan({ cls: 'memory-section-title', text: title });
        titleEl.createSpan({ cls: 'memory-section-count-badge', text: String(facts.length) });
        section.createDiv({ cls: 'memory-viewer-section-desc', text: description });

        if (facts.length === 0) {
            const emptyEl = section.createDiv({ cls: 'memory-section-empty' });
            emptyEl.createSpan({ text: '暂无记录' });
            return;
        }

        const cardsWrap = section.createDiv({ cls: 'memory-cards-grid' });
        for (const fact of facts) {
            const card = cardsWrap.createDiv({ cls: 'memory-card' });
            
            // Card Content & Top Action Row
            const topRow = card.createDiv({ cls: 'memory-card-top' });
            topRow.createDiv({ cls: 'memory-card-text', text: fact.text });

            if (editable) {
                const actions = topRow.createDiv({ cls: 'memory-card-actions' });
                
                const editBtn = actions.createEl('button', {
                    cls: 'memory-card-btn',
                });
                setIcon(editBtn, 'pencil');
                setTooltip(editBtn, '编辑此条记忆', { delay: 50 });
                editBtn.addEventListener('click', () => { void this.handleEdit(fact); });

                const delBtn = actions.createEl('button', {
                    cls: 'memory-card-btn memory-card-btn--danger',
                });
                setIcon(delBtn, 'trash-2');
                setTooltip(delBtn, '删除此条记忆', { delay: 50 });
                delBtn.addEventListener('click', () => { void this.handleDelete(fact); });
            }

            // Card Footer (Tags + Date)
            const footerRow = card.createDiv({ cls: 'memory-card-footer' });
            const tags = footerRow.createDiv({ cls: 'memory-card-tags' });
            
            const primary = primaryTag(fact);
            if (primary) {
                tags.createSpan({ cls: 'memory-tag memory-tag-primary', text: primary });
            }
            for (const topic of fact.topics) {
                if (topic === primary || topic === 'soul' || topic === 'capability') continue;
                tags.createSpan({ cls: 'memory-tag', text: `#${topic}` });
            }

            footerRow.createSpan({ cls: 'memory-card-date', text: shortDate(fact.lastConfirmedAt) });
        }
    }

    private async handleEdit(fact: Fact): Promise<void> {
        const next = await promptModal(this.app, {
            title: '编辑记忆条目',
            message: '修改后将更新此记忆事实，旧版本将归档保留。',
            placeholder: fact.text,
            defaultValue: fact.text,
            submitLabel: '保存修改',
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
        new Notice('记忆条目已更新');
        this.render();
    }

    private async handleWipeAll(): Promise<void> {
        const { confirmAndWipeAllMemory } = await import('./wipeAllMemory');
        const outcome = await confirmAndWipeAllMemory(this.app, this.plugin);
        if (outcome === 'deleted') this.close();
    }

    private async handleDelete(fact: Fact): Promise<void> {
        const ok = await confirmModal(this.app, {
            title: '删除记忆条目',
            message: `确定要删除以下记忆条目吗？\n\n"${fact.text}"`,
            confirmLabel: '确认删除',
            cancelLabel: '取消',
            destructive: true,
        });
        if (!ok) return;
        const factStore = new FactStore(this.plugin.memoryDB!);
        factStore.deprecate(fact.id, 'removed by user via memory viewer');
        await this.plugin.memoryDB!.save().catch(() => undefined);
        new Notice('记忆条目已删除');
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
