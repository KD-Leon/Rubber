import { setIcon, ToggleComponent } from 'obsidian';
import { PopoverDismisser, positionPopover } from './popoverShell';

/**
 * ChatOptionsPopover -- the chat "..." menu rendered as a custom popover so the
 * on/off settings show as real toggles. Obsidian's native Menu can only render
 * a checkmark, not a switch, which is why the boolean options used to be
 * inconsistent (some "(on)" text, some a check). Toggles sit on top, one-shot
 * actions below (FEAT-02-12).
 *
 * Generic on purpose: the caller supplies the toggles and actions, so the
 * sensitive state logic (e.g. the auto-accept composite) stays in the view.
 * Positioning + dismiss lifecycle live in popoverShell (IMP-02-12-03).
 */
export interface ChatOptionsToggle {
    icon: string;
    label: string;
    badge?: string;
    /** Read fresh on open so the switch reflects the current setting. */
    isOn: () => boolean;
    onToggle: (value: boolean) => void;
}

export interface ChatOptionsAction {
    icon: string;
    label: string;
    badge?: string;
    stateText?: string;
    hasChevron?: boolean;
    onClick: () => void;
    /** Optional visibility gate, e.g. "Cancel indexing" only while indexing. */
    isVisible?: () => boolean;
}

export interface ChatOptionsConfig {
    toggles: ChatOptionsToggle[];
    actions: ChatOptionsAction[];
}

export class ChatOptionsPopover {
    private containerEl: HTMLElement | null = null;
    private readonly dismisser = new PopoverDismisser();

    show(anchor: HTMLElement, parentContainerEl: HTMLElement, config: ChatOptionsConfig): void {
        // Clicking the anchor while its popover is open must CLOSE it (toggle):
        // the outside-click handler exempts the anchor, so without this branch
        // the anchor's click listener would only ever re-open (FEAT-02-12
        // review fix).
        if (this.dismisser.isOpenFor(anchor)) {
            this.hide();
            return;
        }
        this.hide();
        // Reuse the vault-file-picker shell for positioning + border/shadow.
        this.containerEl = activeDocument.body.createDiv('vault-file-picker chat-options-popover');

        const reposition = () => {
            if (this.containerEl) {
                positionPopover(this.containerEl, anchor, parentContainerEl, { cssPrefix: '--vfp', maxWidth: 300 });
            }
        };
        reposition();

        // ── Toggles ─────────────────────────────────────────────────────────
        if (config.toggles.length > 0) {
            const togGroup = this.containerEl.createDiv('cop-group');
            for (const tog of config.toggles) {
                const row = togGroup.createDiv('cop-toggle-row');
                setIcon(row.createSpan('cop-row-icon'), tog.icon);
                row.createSpan({ cls: 'cop-row-label', text: tog.label });
                if (tog.badge) {
                    row.createSpan({ cls: 'cop-row-badge', text: tog.badge });
                }
                const host = row.createDiv('cop-row-toggle');
                const comp = new ToggleComponent(host);
                comp.setValue(tog.isOn());
                comp.onChange((v) => { tog.onToggle(v); });
            }
        }

        // ── Actions ─────────────────────────────────────────────────────────
        const visible = config.actions.filter((a) => a.isVisible?.() ?? true);
        if (visible.length > 0) {
            const actGroup = this.containerEl.createDiv('cop-group cop-group-actions');
            for (const act of visible) {
                const row = actGroup.createDiv('cop-action-row');
                setIcon(row.createSpan('cop-row-icon'), act.icon);
                row.createSpan({ cls: 'cop-row-label', text: act.label });

                if (act.badge) {
                    row.createSpan({ cls: 'cop-row-badge', text: act.badge });
                }
                if (act.stateText) {
                    row.createSpan({ cls: 'cop-row-state', text: act.stateText });
                }
                if (act.hasChevron !== false) {
                    const chev = row.createSpan('cop-row-chevron');
                    setIcon(chev, 'chevron-right');
                }

                row.addEventListener('click', () => {
                    this.hide();
                    act.onClick();
                });
            }
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
