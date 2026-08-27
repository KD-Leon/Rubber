/**
 * EPIC-26 / FEAT-26-05 -- chat-header model picker popover.
 *
 * Replaces the Obsidian-Menu-based dropdown so the user can search
 * through provider model lists. Bedrock and OpenRouter routinely
 * surface 50+ entries; without a filter the scroll is unusable.
 *
 * Visual layout matches `ToolPickerPopover` (.tool-picker-* CSS) so
 * the two popovers feel like siblings.
 *
 * Single-select semantics:
 *  - First entry is always "Auto" (returns null override)
 *  - Following entries are the discovered models of the active provider
 *  - Click sets the override on the parent and closes the popover
 */

import { DropdownComponent, setIcon } from 'obsidian';
import type { DiscoveredModel, ProviderConfig } from '../../types/settings';
import { getTierBadgeLabel } from '../../types/settings';
import type { EffortLevel } from '../../types/model-registry';
import { t } from '../../i18n';
import { PopoverDismisser, positionPopover } from './popoverShell';
import { buildChatModelPickerRows } from './chatModelDropdown';
import type { ThinkingOverride } from './thinkingOverride';
import type { EffortOverride } from './effortOverride';
import {
    effortControlVisibility,
    effortStops,
    effortIndexForOverride,
    effortStopForIndex,
    effortFractionForIndex,
    effortIndexForFraction,
    thinkingSwitchIsOn,
} from './effortOverride';

/** One switchable provider entry in the picker's provider dropdown (issue #48.5). */
export interface ChatProviderNavItem {
    id: string;
    label: string;
}

/**
 * Provider-switcher wiring for the chat model picker (issue #48.5). When more
 * than one provider is enabled the picker shows a dropdown (IMP-26-05-01;
 * chips before that) so the user can change the active provider without
 * opening Settings.
 */
export interface ChatProviderNav {
    items: ChatProviderNavItem[];
    activeId: string | null;
    /** Switch the active provider (a global settings change; handled by the caller). */
    onSelect: (id: string) => void;
}

export interface ChatModelPickerCallbacks {
    /** Currently selected override (null = Auto). */
    getCurrent: () => string | null;
    /** Called when the user picks a new override (null = Auto). */
    onSelect: (overrideId: string | null) => void;
    /** Current per-conversation thinking override. */
    getThinking: () => ThinkingOverride;
    /** Called when the user changes the thinking override. */
    onThinkingChange: (override: ThinkingOverride) => void;
    /** Current per-conversation reasoning-effort override. */
    getEffort: () => EffortOverride;
    /** Called when the user changes the reasoning-effort override. */
    onEffortChange: (override: EffortOverride) => void;
    /**
     * Native effort levels for the model the next turn runs on (the pinned
     * model, else the default-active model). Empty means the model has no
     * native effort surface, so the effort control stays hidden.
     */
    getEffortLevels: () => EffortLevel[];
}

export class ChatModelPickerPopover {
    private popoverEl: HTMLElement | null = null;
    private readonly dismisser = new PopoverDismisser();
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;

    show(
        event: MouseEvent,
        anchorBtn: HTMLElement,
        containerEl: HTMLElement,
        provider: ProviderConfig,
        callbacks: ChatModelPickerCallbacks,
        providerNav?: ChatProviderNav,
    ): void {
        // Anchor click while open = toggle-close (IMP-02-12-03).
        if (this.dismisser.isOpenFor(anchorBtn)) {
            this.close();
            return;
        }
        this.close();

        const popover = createDiv();
        popover.className = 'tool-picker-popover chat-model-picker';
        this.popoverEl = popover;

        // ── Provider switcher (issue #48.5) ──────────────────────────────
        // Only shown when more than one provider is enabled. Switching is a
        // global change (settings.activeProviderId); the caller persists it and
        // re-opens the picker on the newly active provider.
        if (providerNav && providerNav.items.length > 1) {
            const navRow = popover.createDiv('chat-model-picker-providers');
            const dropdown = new DropdownComponent(navRow);
            for (const item of providerNav.items) {
                dropdown.addOption(item.id, item.label);
            }
            if (providerNav.activeId !== null) dropdown.setValue(providerNav.activeId);
            dropdown.onChange((id) => {
                if (id === providerNav.activeId) return;
                providerNav.onSelect(id);
            });
        }

        // ── Scroll body ──────────────────────────────────────────────────
        const scrollEl = popover.createDiv('tool-picker-scroll');

        const current = callbacks.getCurrent();
        const advisorDisabled = !(provider.tierOverrides?.flagship ?? provider.tierMapping?.flagship);

        // Auto row (always first)
        const autoRow = this.makeAutoRow(scrollEl, current === null, advisorDisabled);
        autoRow.addEventListener('click', () => {
            callbacks.onSelect(null);
            this.close();
        });

        // Model rows. FIX-55-01 (issue #55): rows come from the merge helper
        // so manually typed tier-override ids (providers without a model
        // listing endpoint) are visible and pinnable like discovered models.
        const pickerRows = buildChatModelPickerRows(provider);
        for (const { model: m, manual } of pickerRows) {
            const row = this.makeModelRow(scrollEl, m, current, manual);
            row.addEventListener('click', () => {
                callbacks.onSelect(m.id);
                this.close();
            });
        }

        // Empty-state hint when the provider has no discovered models yet
        if (pickerRows.length === 0) {
            scrollEl.createDiv({
                cls: 'tp-empty-hint',
                text: t('ui.sidebar.modelPickerNoModels'),
            });
        }

        // ── Thinking switch + reasoning-effort slider (per conversation) ──
        const levels = callbacks.getEffortLevels();
        const effortCapable = levels.length > 0;

        const effortRow = effortCapable ? this.makeEffortControl(popover, callbacks, levels) : null;

        const syncEffortRowVisibility = () => {
            const visibility = effortControlVisibility(
                thinkingSwitchIsOn(callbacks.getThinking()),
                effortCapable,
                callbacks.getCurrent() !== null,
            );
            if (effortRow) {
                effortRow.wrap.classList.toggle('agent-u-hidden', visibility !== 'control');
                if (visibility === 'control') effortRow.sync();
            }
        };

        this.makeThinkingControl(popover, callbacks, syncEffortRowVisibility);
        syncEffortRowVisibility();

        // ── Keyboard: Esc closes ─────────────────────────────────────────
        this.keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        };
        popover.addEventListener('keydown', this.keyHandler);

        // ── Mount + position ────────────────────────────────────────────
        activeDocument.body.appendChild(popover);
        const reposition = () => {
            positionPopover(popover, anchorBtn, containerEl, {
                cssPrefix: '--tp', maxWidth: 320, minVisibleHeight: 200, extraWidthVars: true,
            });
        };
        reposition();

        // Dismiss lifecycle: outside click, Escape, resize (IMP-02-12-03).
        this.dismisser.attach({
            el: popover,
            anchor: anchorBtn,
            onDismiss: () => this.close(),
            reposition,
        });
    }

    close(): void {
        this.dismisser.detach();
        this.popoverEl?.remove();
        this.popoverEl = null;
        this.keyHandler = null;
    }

    isOpen(): boolean {
        return this.popoverEl !== null;
    }

    // ── Internals ──────────────────────────────────────────────────────

    private makeAutoRow(scrollEl: HTMLElement, isCurrent: boolean, advisorDisabled: boolean): HTMLElement {
        const row = scrollEl.createDiv({
            cls: `tp-item-row chat-model-picker-row ${isCurrent ? 'is-selected' : ''}`,
        });
        const labelWrap = row.createDiv('tp-item-label-wrap');
        const labelLine = labelWrap.createDiv('tp-item-label');
        labelLine.createSpan({ cls: 'tp-model-name', text: t('ui.sidebar.modelAuto') });
        if (isCurrent) {
            const check = row.createSpan('chat-model-picker-check');
            setIcon(check, 'check');
        }
        return row;
    }

    private makeModelRow(
        scrollEl: HTMLElement,
        m: DiscoveredModel,
        currentOverride: string | null,
        manual = false,
    ): HTMLElement {
        const isSelected = currentOverride === m.id;
        const row = scrollEl.createDiv({
            cls: `tp-item-row chat-model-picker-row ${isSelected ? 'is-selected' : ''}`,
        });

        const labelWrap = row.createDiv('tp-item-label-wrap');
        const labelLine = labelWrap.createDiv('tp-item-label');
        labelLine.createSpan({ cls: 'tp-model-name', text: m.displayName ?? m.id });
        if (m.autoTier) {
            const tier = labelLine.createSpan({
                cls: `chat-model-picker-tier chat-model-picker-tier-${m.autoTier}`,
                text: getTierBadgeLabel(m.autoTier),
            });
            tier.setAttr('aria-label', `tier: ${getTierBadgeLabel(m.autoTier)}`);
        }
        if (manual) {
            // FIX-55-01: a manually typed tier-override id that discovery does
            // not know. The badge tells the user why the entry has no tier or
            // display-name metadata.
            const badge = labelLine.createSpan({
                cls: 'chat-model-picker-tier chat-model-picker-manual-badge',
                text: t('ui.sidebar.modelPickerManual'),
            });
            badge.setAttr('aria-label', t('ui.sidebar.modelPickerManual'));
        }
        if (m.displayName && m.displayName !== m.id) {
            labelWrap.createDiv({ cls: 'tp-item-desc', text: m.id });
        }
        if (isSelected) {
            const check = row.createSpan('chat-model-picker-check');
            setIcon(check, 'check');
        }
        return row;
    }

    /**
     * Per-conversation thinking switch: a binary On/Off pill switch (a track
     * with a sliding knob, accent when on). The picker keeps the tri-state
     * ThinkingOverride internally for default preservation: On reads as
     * override !== 'off' (so the byte-identical 'follow' default shows On), Off
     * reads as override === 'off'. Clicking sets an explicit 'on' or 'off'.
     *
     * Models without thinking ignore an 'on' override (the providers already
     * no-op it), so the switch stays a simple binary toggle.
     */
    private makeThinkingControl(
        popover: HTMLElement,
        callbacks: ChatModelPickerCallbacks,
        onToggle: () => void,
    ): void {
        const row = popover.createDiv('chat-model-picker-thinking');
        row.createDiv({
            cls: 'chat-model-picker-thinking-label',
            text: t('ui.sidebar.thinkingOverrideLabel'),
        });

        const switchBtn = row.createEl('button', {
            cls: 'chat-model-picker-thinking-switch',
            attr: { type: 'button', role: 'switch' },
        });
        switchBtn.createSpan('chat-model-picker-thinking-knob');
        const stateText = row.createSpan('chat-model-picker-thinking-state');

        const sync = () => {
            const on = thinkingSwitchIsOn(callbacks.getThinking());
            switchBtn.classList.toggle('is-on', on);
            switchBtn.setAttr('aria-checked', on ? 'true' : 'false');
            stateText.setText(on ? t('ui.sidebar.thinkingOn') : t('ui.sidebar.thinkingOff'));
        };

        switchBtn.addEventListener('click', () => {
            // currently-on -> off, currently-off -> on. Always an explicit value.
            const next: ThinkingOverride = thinkingSwitchIsOn(callbacks.getThinking()) ? 'off' : 'on';
            callbacks.onThinkingChange(next);
            sync();
            onToggle();
        });
        sync();
    }

    /**
     * Per-conversation reasoning-effort slider: a Claude-Code-style pill slider
     * (a pill track with one dot marker per stop and a round knob, accent-filled
     * up to the knob). Stops are ['auto', ...model-native levels]. 'auto' (the
     * leftmost default) sends no effort field, so an untouched picker changes
     * nothing. Returns the row wrap plus a sync() so the caller can re-sync when
     * it un-hides the row.
     */
    private makeEffortControl(
        popover: HTMLElement,
        callbacks: ChatModelPickerCallbacks,
        levels: EffortLevel[],
    ): { wrap: HTMLElement; sync: () => void } {
        const stops = effortStops(levels);
        const labelFor = (level: EffortOverride): string => {
            switch (level) {
                case 'minimal': return t('ui.sidebar.effortMinimal');
                case 'low': return t('ui.sidebar.effortLow');
                case 'medium': return t('ui.sidebar.effortMedium');
                case 'high': return t('ui.sidebar.effortHigh');
                case 'xhigh': return t('ui.sidebar.effortXhigh');
                case 'max': return t('ui.sidebar.effortMax');
                case 'auto':
                default: return t('ui.sidebar.effortAuto');
            }
        };

        const row = popover.createDiv('chat-model-picker-effort');
        const labelWrap = row.createDiv('chat-model-picker-effort-labelwrap');
        labelWrap.createSpan({
            cls: 'chat-model-picker-effort-label',
            text: t('ui.sidebar.effortLabel'),
        });
        const valueEl = labelWrap.createSpan('chat-model-picker-effort-value');

        // Custom div slider (not a native <input type=range>): the native thumb
        // is inset by half its width at each end, so it can never sit flush-left
        // at 'auto' or flush-right at 'max', and its fill never lines up with the
        // thumb. Here the knob is positioned by a fraction var so it lands exactly
        // on each dot, flush at both extremes, and the fill ends under the knob.
        // The pill itself is the slider widget (role=slider, focusable).
        const pill = row.createDiv('chat-model-picker-effort-pill');
        pill.setAttrs({
            role: 'slider',
            tabindex: '0',
            'aria-label': t('ui.sidebar.effortLabel'),
            'aria-valuemin': '0',
            'aria-valuemax': String(stops.length - 1),
        });
        pill.createDiv('chat-model-picker-effort-fill');
        const dots = pill.createDiv('chat-model-picker-effort-dots');
        for (let i = 0; i < stops.length; i++) {
            dots.createSpan('chat-model-picker-effort-dot');
        }
        const knob = pill.createDiv('chat-model-picker-effort-knob');
        knob.setAttr('aria-hidden', 'true');

        const sync = () => {
            const idx = effortIndexForOverride(stops, callbacks.getEffort());
            const frac = effortFractionForIndex(idx, stops.length);
            // One fraction var drives both the knob position and the fill width
            // via CSS calc, so no inline geometry is assigned directly.
            pill.setCssProps({ '--effort-frac': String(frac) });
            const label = labelFor(stops[idx] ?? 'auto');
            valueEl.setText(label);
            pill.setAttr('aria-valuenow', String(idx));
            pill.setAttr('aria-valuetext', label);
        };

        const commitIndex = (idx: number) => {
            const level = effortStopForIndex(stops, idx);
            if (level !== callbacks.getEffort()) callbacks.onEffortChange(level);
            sync();
        };

        // Map a pointer x to the nearest stop. The knob is KNOB_PX wide and its
        // centre travels from KNOB_PX/2 to width-KNOB_PX/2, matching the CSS
        // calc(var(--effort-frac) * (100% - KNOB_PX)).
        const KNOB_PX = 18;
        const indexFromClientX = (clientX: number): number => {
            const rect = pill.getBoundingClientRect();
            const travel = rect.width - KNOB_PX;
            const x = clientX - rect.left - KNOB_PX / 2;
            const frac = travel > 0 ? x / travel : 0;
            return effortIndexForFraction(frac, stops.length);
        };

        let dragging = false;
        pill.addEventListener('pointerdown', (e: PointerEvent) => {
            dragging = true;
            pill.setPointerCapture(e.pointerId);
            // preventDefault stops text selection but also cancels the default
            // focus move, so focus the pill explicitly: otherwise the keyboard
            // (Arrow/Home/End) handler below stays unreachable after a click.
            pill.focus();
            commitIndex(indexFromClientX(e.clientX));
            e.preventDefault();
        });
        pill.addEventListener('pointermove', (e: PointerEvent) => {
            if (!dragging) return;
            commitIndex(indexFromClientX(e.clientX));
        });
        const endDrag = (e: PointerEvent) => {
            if (!dragging) return;
            dragging = false;
            if (pill.hasPointerCapture(e.pointerId)) pill.releasePointerCapture(e.pointerId);
        };
        pill.addEventListener('pointerup', endDrag);
        pill.addEventListener('pointercancel', endDrag);

        pill.addEventListener('keydown', (e: KeyboardEvent) => {
            const cur = effortIndexForOverride(stops, callbacks.getEffort());
            let next = cur;
            switch (e.key) {
                case 'ArrowLeft':
                case 'ArrowDown': next = cur - 1; break;
                case 'ArrowRight':
                case 'ArrowUp': next = cur + 1; break;
                case 'Home': next = 0; break;
                case 'End': next = stops.length - 1; break;
                default: return;
            }
            e.preventDefault();
            commitIndex(Math.min(Math.max(next, 0), stops.length - 1));
        });

        sync();

        return { wrap: row, sync };
    }

}
