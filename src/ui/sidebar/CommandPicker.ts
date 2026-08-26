import { setIcon } from 'obsidian';
import { PopoverDismisser, positionPopover } from './popoverShell';

/**
 * CommandPicker -- searchable single-select popover for skills, prompts,
 * and workflows.
 *
 * Anchored to a toolbar button, styled identically to VaultFilePicker so
 * the + menu stays coherent. Single-select because a chat turn only
 * activates one command at a time; multi-select is reserved for
 * VaultFilePicker where attachments are naturally plural.
 *
 * FEATURE-2209 (EPIC-022 follow-up, 2026-04-19): user feedback that
 * listing every skill inline under the + menu gets cluttered as the
 * library grows. Search + pick mirrors the VaultFilePicker UX.
 */
export interface CommandPickerItem {
    /** Display label, e.g. skill/prompt/workflow name. */
    label: string;
    /** Secondary line, usually `/slug`, `#slug`, or `§slug`. */
    sub: string;
    /** Short tag badge: 'Skill' | 'Prompt' | 'Workflow'. */
    tag: string;
    /** Optional lucide icon name for the row. */
    icon?: string;
    /** Arbitrary searchable text (e.g. description). */
    searchable?: string;
    onSelect: () => void;
    /**
     * Optional secondary "pin" control rendered on the row, separate from the
     * primary click. Clicking it toggles state WITHOUT selecting the item or
     * closing the picker. Used to force a workflow (run it on every message)
     * next to the primary click that inserts it once. `isActive` is read fresh
     * on every render so the control reflects the current state after a toggle.
     */
    pin?: {
        isActive: () => boolean;
        /** Tooltip/aria label shown while the pin is inactive. */
        labelOff: string;
        /** Tooltip/aria label shown while the pin is active. */
        labelOn: string;
        onToggle: () => void;
    };
}

export class CommandPicker {
    private containerEl: HTMLElement | null = null;
    private searchInput: HTMLInputElement | null = null;
    private listEl: HTMLElement | null = null;
    private activeIdx = 0;
    private filtered: CommandPickerItem[] = [];
    private readonly dismisser = new PopoverDismisser();

    constructor(
        private readonly items: CommandPickerItem[],
        private readonly title: string,
        private readonly emptyLabel: string,
    ) {}

    show(anchor: HTMLElement, parentContainerEl?: HTMLElement): void {
        if (this.dismisser.isOpenFor(anchor)) {
            this.hide();
            return;
        }
        this.hide();
        this.activeIdx = 0;

        this.containerEl = activeDocument.body.createDiv('vault-file-picker command-picker');

        const reposition = () => {
            if (!this.containerEl) return;
            positionPopover(this.containerEl, anchor, parentContainerEl ?? null, {
                cssPrefix: '--vfp', maxWidth: 360,
            });
        };
        reposition();

        const searchRow = this.containerEl.createDiv('vfp-search-row');
        const searchIconEl = searchRow.createSpan('vfp-search-icon');
        setIcon(searchIconEl, 'search');
        this.searchInput = searchRow.createEl('input', {
            cls: 'vfp-search-input',
            attr: { placeholder: this.title, type: 'text', spellcheck: 'false' },
        });

        this.listEl = this.containerEl.createDiv('vfp-list');

        this.searchInput.addEventListener('input', () => {
            this.activeIdx = 0;
            this.renderList();
        });

        this.searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    this.activeIdx = Math.min(this.activeIdx + 1, this.filtered.length - 1);
                    this.renderList();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this.activeIdx = Math.max(this.activeIdx - 1, 0);
                    this.renderList();
                    break;
                case 'Enter': {
                    e.preventDefault();
                    const item = this.filtered[this.activeIdx];
                    if (item) {
                        this.hide();
                        item.onSelect();
                    }
                    break;
                }
                case 'Escape':
                    e.preventDefault();
                    this.hide();
                    break;
            }
        });

        // Dismiss lifecycle: outside click, Escape, resize (IMP-02-12-03;
        // the old inline handler leaked one listener per show()).
        this.dismisser.attach({
            el: this.containerEl,
            anchor,
            onDismiss: () => this.hide(),
            reposition,
        });

        this.renderList();
        window.setTimeout(() => this.searchInput?.focus(), 0);
    }

    hide(): void {
        this.dismisser.detach();
        this.containerEl?.remove();
        this.containerEl = null;
        this.searchInput = null;
        this.listEl = null;
        this.filtered = [];
    }

    private renderList(): void {
        if (!this.listEl) return;
        const query = (this.searchInput?.value ?? '').toLowerCase();

        this.filtered = this.items.filter((item) => {
            if (!query) return true;
            return item.label.toLowerCase().includes(query)
                || item.sub.toLowerCase().includes(query)
                || (item.searchable?.toLowerCase().includes(query) ?? false);
        });

        if (this.activeIdx >= this.filtered.length) this.activeIdx = 0;

        this.listEl.empty();

        if (this.filtered.length === 0) {
            this.listEl.createDiv({ cls: 'vfp-empty', text: this.emptyLabel });
            return;
        }

        this.filtered.forEach((item, idx) => {
            const isActive = idx === this.activeIdx;
            const row = this.listEl!.createDiv({
                cls: `vfp-row${isActive ? ' vfp-row-active' : ''}`,
            });

            if (item.icon) {
                const iconEl = row.createSpan('vfp-row-icon');
                setIcon(iconEl, item.icon);
            }

            const info = row.createDiv('vfp-row-info');
            info.createSpan({ cls: 'vfp-row-name', text: item.label });
            info.createSpan({ cls: 'vfp-row-path', text: item.sub });

            row.createSpan({ cls: 'autocomplete-tag', text: item.tag });

            if (item.pin) {
                const active = item.pin.isActive();
                if (active) row.addClass('vfp-row-pinned');
                const pinBtn = row.createSpan({
                    cls: `vfp-row-pin${active ? ' vfp-row-pin-active' : ''}`,
                });
                setIcon(pinBtn, 'pin');
                const pinLabel = active ? item.pin.labelOn : item.pin.labelOff;
                pinBtn.setAttribute('aria-label', pinLabel);
                pinBtn.setAttribute('title', pinLabel);
                // Toggle only; do not select the row or close the picker.
                pinBtn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    item.pin!.onToggle();
                    this.renderList();
                });
            }

            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.hide();
                item.onSelect();
            });
        });

        const activeRow = this.listEl.querySelector<HTMLElement>('.vfp-row-active');
        activeRow?.scrollIntoView({ block: 'nearest' });
    }
}
