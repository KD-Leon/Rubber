import { setIcon } from 'obsidian';
import { PopoverDismisser, positionPopover } from './popoverShell';

export interface PlusMenuItem {
    icon: string;
    label: string;
    sub?: string;
    onClick: () => void;
}

/**
 * PlusMenuPopover — Notion AI-style floating action popover for the chat '+' button.
 * Replaces raw contextual menus with a unified, modern floating card.
 */
export class PlusMenuPopover {
    private containerEl: HTMLElement | null = null;
    private readonly dismisser = new PopoverDismisser();

    show(anchor: HTMLElement, parentContainerEl: HTMLElement, items: PlusMenuItem[]): void {
        if (this.dismisser.isOpenFor(anchor)) {
            this.hide();
            return;
        }
        this.hide();

        this.containerEl = activeDocument.body.createDiv('vault-file-picker plus-menu-popover');

        const reposition = () => {
            if (this.containerEl) {
                positionPopover(this.containerEl, anchor, parentContainerEl, {
                    cssPrefix: '--vfp',
                    maxWidth: 280,
                });
            }
        };
        reposition();

        const group = this.containerEl.createDiv('cop-group');
        for (const item of items) {
            const row = group.createDiv('cop-action-row plus-menu-row');
            const iconEl = row.createSpan('cop-row-icon');
            setIcon(iconEl, item.icon);

            const labelWrap = row.createDiv('cop-row-label-wrap');
            labelWrap.createSpan({ cls: 'cop-row-label', text: item.label });
            if (item.sub) {
                labelWrap.createSpan({ cls: 'cop-row-sub', text: item.sub });
            }

            row.addEventListener('click', () => {
                this.hide();
                item.onClick();
            });
        }

        this.dismisser.attach({
            el: this.containerEl,
            anchor,
            onDismiss: () => this.hide(),
            reposition,
        });
    }

    hide(): void {
        this.dismisser.detach();
        this.containerEl?.remove();
        this.containerEl = null;
    }
}
