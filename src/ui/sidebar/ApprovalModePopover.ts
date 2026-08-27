import { setIcon } from 'obsidian';
import { PopoverDismisser, positionPopover } from './popoverShell';
import { t } from '../../i18n';

/**
 * ApprovalModePopover -- quick approval-mode (permission preset) selector for
 * the chat composer toolbar. Radio-style list of the three presets defined in
 * PermissionsTab (restrictive / balanced / permissive), check mark on the
 * active one, plus a footer entry that deep-links to the full permissions
 * settings for fine-tuning.
 *
 * Shell + dismiss lifecycle mirror ChatOptionsPopover (vault-file-picker
 * positioning, outside-click dismiss).
 */

export type ApprovalPresetKey = 'restrictive' | 'balanced' | 'permissive' | 'custom';

export interface ApprovalModePopoverConfig {
    active: ApprovalPresetKey;
    onSelect: (key: Exclude<ApprovalPresetKey, 'custom'>) => void;
    onOpenSettings: () => void;
}

const PRESET_ROWS: {
    key: Exclude<ApprovalPresetKey, 'custom'>;
    icon: string;
    label: string;
    desc: string;
}[] = [
    {
        key: 'restrictive',
        icon: 'shield',
        label: t('ui.approval.restrictive'),
        desc: t('ui.approval.restrictiveDesc'),
    },
    {
        key: 'balanced',
        icon: 'shield-check',
        label: t('ui.approval.balanced'),
        desc: t('ui.approval.balancedDesc'),
    },
    {
        key: 'permissive',
        icon: 'zap',
        label: t('ui.approval.permissive'),
        desc: t('ui.approval.permissiveDesc'),
    },
];

export class ApprovalModePopover {
    private containerEl: HTMLElement | null = null;
    private readonly dismisser = new PopoverDismisser();

    show(anchor: HTMLElement, parentContainerEl: HTMLElement, config: ApprovalModePopoverConfig): void {
        if (this.dismisser.isOpenFor(anchor)) {
            this.hide();
            return;
        }
        this.hide();
        this.containerEl = activeDocument.body.createDiv('vault-file-picker approval-mode-popover');

        const reposition = () => {
            if (this.containerEl) {
                positionPopover(this.containerEl, anchor, parentContainerEl, { cssPrefix: '--vfp', maxWidth: 300 });
            }
        };
        reposition();

        const header = this.containerEl.createDiv('cop-group amp-header');
        header.createSpan({ cls: 'cop-row-label', text: t('ui.approval.title') });

        const group = this.containerEl.createDiv('cop-group');
        for (const row of PRESET_ROWS) {
            const el = group.createDiv('cop-action-row amp-row' + (config.active === row.key ? ' is-active' : ''));
            setIcon(el.createSpan('cop-row-icon'), row.icon);
            const textCol = el.createDiv('amp-row-text');
            textCol.createSpan({ cls: 'cop-row-label', text: row.label });
            textCol.createSpan({ cls: 'amp-row-desc', text: row.desc });
            if (config.active === row.key) {
                const check = el.createSpan('cop-row-chevron');
                setIcon(check, 'check');
            }
            el.addEventListener('click', () => {
                this.hide();
                config.onSelect(row.key);
            });
        }

        const footer = this.containerEl.createDiv('cop-group cop-group-actions');
        const settingsRow = footer.createDiv('cop-action-row');
        setIcon(settingsRow.createSpan('cop-row-icon'), 'settings-2');
        settingsRow.createSpan({ cls: 'cop-row-label', text: t('ui.approval.fineTune') });
        const chev = settingsRow.createSpan('cop-row-chevron');
        setIcon(chev, 'chevron-right');
        settingsRow.addEventListener('click', () => {
            this.hide();
            config.onOpenSettings();
        });

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
