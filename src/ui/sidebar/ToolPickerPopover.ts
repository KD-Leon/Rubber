import { Notice, setIcon } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import type { ModeService } from '../../core/modes/ModeService';
import type { ToolGroup } from '../../types/settings';
import { TOOL_METADATA, GROUP_META, getToolsForGroup } from '../../core/tools/toolMetadata';
import { isMcpServerActive, setMcpServerActive, setAllMcpActive } from '../../core/mcp/mcpActivation';
import { getCatalogEntry } from '../../core/mcp/connectorCatalog';
import { t } from '../../i18n';
import { PopoverDismisser, positionPopover } from './popoverShell';

/**
 * ToolPickerPopover — manages the "pocket-knife" tool/skill/workflow picker.
 *
 * All changes are immediately persisted to settings (no session-only state).
 * Web tools are excluded — they are managed by a dedicated toggle in the toolbar.
 */
export class ToolPickerPopover {
    private popoverEl: HTMLElement | null = null;
    private readonly dismisser = new PopoverDismisser();

    constructor(
        private plugin: ObsidianAgentPlugin,
        private modeService: ModeService,
    ) {}

    show(event: MouseEvent, anchorBtn: HTMLElement, containerEl: HTMLElement): void {
        // Anchor click while open = toggle-close (IMP-02-12-03; the dismisser
        // exempts the anchor from outside-close, so this is the button's only
        // close path).
        if (this.dismisser.isOpenFor(anchorBtn)) {
            this.close();
            return;
        }
        this.close();
        try {
            this.renderPopover(anchorBtn, containerEl);
        } catch (err) {
            console.error('[ToolPicker] failed to open:', err);
            new Notice(t('ui.toolPicker.openFailed'));
            this.close();
        }
    }

    private renderPopover(anchorBtn: HTMLElement, containerEl: HTMLElement): void {
        // FEAT-55-02 (ADR-170): resolve THIS view's active mode via the
        // ModeService facade (which already falls back to 'agent' for an
        // unknown slug) instead of reading/repairing the global scalar.
        let resolvedMode = this.modeService.getActiveMode();
        if (!resolvedMode) {
            console.error('[ToolPicker] default "agent" mode is missing; cannot open picker.');
            new Notice(t('ui.toolPicker.openFailed'));
            return;
        }
        // Guard against half-migrated custom modes that lost their toolGroups
        // array (would crash .filter()/.flatMap() below).
        if (!Array.isArray(resolvedMode.toolGroups)) {
            console.warn(`[ToolPicker] mode "${resolvedMode.slug}" has no toolGroups; defaulting to read+vault+agent.`);
            resolvedMode = { ...resolvedMode, toolGroups: ['read', 'vault', 'agent'] };
        }
        const mode = resolvedMode;

        const popover = createDiv();
        popover.className = 'tool-picker-popover';
        this.popoverEl = popover;

        // ── Header ───────────────────────────────────────────────────────────
        const headerEl = popover.createDiv('tool-picker-header');
        headerEl.createSpan({ cls: 'tool-picker-title', text: t('ui.toolPicker.title') });
        const countBadge = headerEl.createSpan('tool-picker-count');

        // ── Search ───────────────────────────────────────────────────────────
        const searchInput = popover.createEl('input', {
            cls: 'tool-picker-search',
            attr: { placeholder: t('ui.toolPicker.filter'), type: 'text', spellcheck: 'false' },
        });

        // ── Scroll container ─────────────────────────────────────────────────
        const scrollEl = popover.createDiv('tool-picker-scroll');

        // ── Data from central tool metadata (single source of truth) ────────
        const GROUP_TOOLS: Record<string, string[]> = {};
        for (const [group] of Object.entries(GROUP_META)) {
            GROUP_TOOLS[group] = getToolsForGroup(group as ToolGroup).map(([name]) => name);
        }

        // Excluded groups: 'web' (dedicated toggle), 'mcp' (own section)
        const EXCLUDED_GROUPS = new Set(['web', 'mcp']);

        // Current effective tools (settings → defaults)
        const effectiveTools = new Set(
            this.plugin.settings.modeToolOverrides?.[mode.slug]
            ?? this.modeService.getEffectiveToolNames(mode)
        );
        const toolChecks = new Map<string, HTMLInputElement>();
        const allItemRows: HTMLElement[] = [];   // for search filtering

        // ── Helpers ──────────────────────────────────────────────────────────

        const applyToolOverride = async () => {
            const allGroupTools = mode.toolGroups
                .filter((g) => !EXCLUDED_GROUPS.has(g))
                .flatMap((g) => GROUP_TOOLS[g] ?? []);
            const selected = allGroupTools.filter((t) => toolChecks.get(t)?.checked ?? false);
            await this.modeService.setModeToolOverride(mode.slug, selected);
        };

        const updateCount = () => {
            let n = 0;
            for (const cb of toolChecks.values()) { if (cb.checked) n++; }
            countBadge.setText(t('ui.toolPicker.selected', { count: n }));
        };

        // Create a top-level expandable category row
        const makeTopCat = (label: string, startOpen = true): { catRow: HTMLElement; catBody: HTMLElement } => {
            const catRow = scrollEl.createDiv('tp-cat-row');
            if (startOpen) catRow.addClass('is-open');
            catRow.createSpan('tp-cat-arrow').setText('▸');
            catRow.createSpan({ cls: 'tp-cat-label', text: label });
            const catBody = scrollEl.createDiv('tp-cat-body');
            catBody.classList.toggle('agent-u-hidden', !startOpen);
            catRow.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).tagName === 'INPUT') return;
                const open = catRow.classList.toggle('is-open');
                catBody.classList.toggle('agent-u-hidden', !open);
            });
            return { catRow, catBody };
        };

        // Create a sub-category row inside Built-In
        const makeSubCat = (
            parent: HTMLElement, label: string, iconName: string,
        ): { subRow: HTMLElement; subBody: HTMLElement; subGroupCb: HTMLInputElement } => {
            const subRow = parent.createDiv('tp-subcat-row');
            subRow.createSpan('tp-subcat-arrow').setText('▸');
            const subIconEl = subRow.createSpan('tp-subcat-icon');
            setIcon(subIconEl, iconName);
            subRow.createSpan({ cls: 'tp-subcat-label', text: label });
            const subGroupCb = subRow.createEl('input', { type: 'checkbox' });
            subGroupCb.className = 'tp-cat-group-cb';
            const subBody = parent.createDiv('tp-subcat-body');
            subBody.classList.add('agent-u-hidden');
            subRow.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).tagName === 'INPUT') return;
                const open = subRow.classList.toggle('is-open');
                subBody.classList.toggle('agent-u-hidden', !open);
            });
            return { subRow, subBody, subGroupCb };
        };

        // Create an item row with checkbox, name, description
        const makeItemRow = (
            parent: HTMLElement, label: string, desc: string, _iconName: string,
            checked: boolean, indentCls = 'tp-item-row',
        ): HTMLInputElement => {
            const row = parent.createDiv(indentCls);
            row.setAttribute('data-label', label.toLowerCase());
            row.setAttribute('data-desc', desc.toLowerCase());
            allItemRows.push(row);
            const cb = row.createEl('input', { type: 'checkbox' });
            cb.checked = checked;
            row.createSpan({ cls: 'tp-item-name', text: label });
            if (desc) row.createSpan({ cls: 'tp-item-desc', text: desc });
            return cb;
        };

        // ── Built-In section ─────────────────────────────────────────────────
        const { catRow: builtInCatRow, catBody: builtInCatBody } = makeTopCat(t('ui.toolPicker.builtIn'));
        const builtInGroupCb = builtInCatRow.createEl('input', { type: 'checkbox' });
        builtInGroupCb.className = 'tp-cat-group-cb';
        const allBuiltInTools = mode.toolGroups
            .filter((g) => !EXCLUDED_GROUPS.has(g))
            .flatMap((g) => GROUP_TOOLS[g] ?? []);
        const biAllEnabled = allBuiltInTools.every((t) => effectiveTools.has(t));
        const biSomeEnabled = allBuiltInTools.some((t) => effectiveTools.has(t));
        builtInGroupCb.checked = biAllEnabled;
        builtInGroupCb.indeterminate = !biAllEnabled && biSomeEnabled;

        for (const group of mode.toolGroups) {
            if (EXCLUDED_GROUPS.has(group)) continue;
            const tools = (GROUP_TOOLS[group] ?? []).filter((t) => {
                const modeTools = mode.toolGroups
                    .filter((g) => !EXCLUDED_GROUPS.has(g))
                    .flatMap((g) => GROUP_TOOLS[g] ?? []);
                return modeTools.includes(t);
            });
            if (tools.length === 0) continue;

            const { subBody, subGroupCb } = makeSubCat(
                builtInCatBody,
                GROUP_META[group]?.label ?? group,
                GROUP_META[group]?.icon ?? 'tool',
            );
            const grpAllEnabled = tools.every((t) => effectiveTools.has(t));
            const grpSomeEnabled = tools.some((t) => effectiveTools.has(t));
            subGroupCb.checked = grpAllEnabled;
            subGroupCb.indeterminate = !grpAllEnabled && grpSomeEnabled;

            for (const toolName of tools) {
                const meta = TOOL_METADATA[toolName];
                const cb = makeItemRow(
                    subBody,
                    meta?.label ?? toolName,
                    meta?.description ?? '',
                    meta?.icon ?? 'tool',
                    effectiveTools.has(toolName),
                );
                toolChecks.set(toolName, cb);
                cb.addEventListener('change', () => {
                    const allInGrp = tools.every((t) => toolChecks.get(t)?.checked);
                    const someInGrp = tools.some((t) => toolChecks.get(t)?.checked);
                    subGroupCb.checked = !!allInGrp;
                    subGroupCb.indeterminate = !allInGrp && !!someInGrp;
                    const allBI = allBuiltInTools.every((t) => toolChecks.get(t)?.checked);
                    const someBI = allBuiltInTools.some((t) => toolChecks.get(t)?.checked);
                    builtInGroupCb.checked = !!allBI;
                    builtInGroupCb.indeterminate = !allBI && !!someBI;
                    void applyToolOverride();
                    updateCount();
                });
            }
            subGroupCb.addEventListener('change', () => {
                for (const t of tools) { const cb = toolChecks.get(t); if (cb) cb.checked = subGroupCb.checked; }
                subGroupCb.indeterminate = false;
                void applyToolOverride();
                updateCount();
            });
        }
        builtInGroupCb.addEventListener('change', () => {
            for (const t of allBuiltInTools) { const cb = toolChecks.get(t); if (cb) cb.checked = builtInGroupCb.checked; }
            builtInGroupCb.indeterminate = false;
            void applyToolOverride();
            updateCount();
        });

        // ── MCP Servers section ───────────────────────────────────────────────
        if (mode.toolGroups.includes('mcp')) {
            const servers = Object.keys(this.plugin.settings.mcpServers ?? {});
            const { catRow: mcpCatRow, catBody: mcpCatBody } = makeTopCat(t('ui.toolPicker.mcpServers'), servers.length > 0);
            const mcpGroupCb = mcpCatRow.createEl('input', { type: 'checkbox' });
            mcpGroupCb.className = 'tp-cat-group-cb';
            const mcpChecks: HTMLInputElement[] = [];

            if (servers.length > 0) {
                // FEAT-04-12: the selection is PER AGENT now -- say whose it is.
                // Keyed on the RESOLVED mode slug (U5 pattern), not raw currentMode.
                mcpCatBody.createDiv({
                    cls: 'tp-section-hint',
                    text: t('ui.toolPicker.mcpServersHint', { agent: mode.name }),
                });
                for (const serverName of servers) {
                    // Show the friendly name from the catalog or the server's own
                    // displayName (e.g. "GitHub"), matching the MCP settings list,
                    // not the URL-like key. The key still drives activation below.
                    const displayName = getCatalogEntry(serverName)?.displayName
                        ?? this.plugin.settings.mcpServers?.[serverName]?.displayName
                        ?? serverName;
                    const cb = makeItemRow(
                        mcpCatBody, displayName, t('ui.toolPicker.mcpServer'), 'plug-2',
                        isMcpServerActive(this.plugin.settings, mode.slug, serverName),
                        'tp-item-row tp-item-indent-cat',
                    );
                    mcpChecks.push(cb);
                    cb.addEventListener('change', () => { void (async () => {
                        // Normalizes per agent: all -> key removed (all-active
                        // default), none -> [], partial -> explicit list.
                        // Single source of truth: mcpActivation.
                        setMcpServerActive(this.plugin.settings, mode.slug, serverName, cb.checked, servers);
                        await this.plugin.saveSettings();
                        mcpChecks.forEach((c, i) => { c.checked = isMcpServerActive(this.plugin.settings, mode.slug, servers[i]); });
                        const allCb = mcpChecks.every((c) => c.checked);
                        const someCb = mcpChecks.some((c) => c.checked);
                        mcpGroupCb.checked = allCb;
                        mcpGroupCb.indeterminate = !allCb && someCb;
                    })(); });
                }
                const allMcp = mcpChecks.every((c) => c.checked);
                const someMcp = mcpChecks.some((c) => c.checked);
                mcpGroupCb.checked = allMcp;
                mcpGroupCb.indeterminate = !allMcp && someMcp;
            } else {
                mcpCatBody.createSpan({ cls: 'tp-empty-hint', text: t('ui.toolPicker.noMcpServers') });
                mcpGroupCb.checked = false;
                mcpGroupCb.disabled = true;
            }
            mcpGroupCb.addEventListener('change', () => { void (async () => {
                for (const cb of mcpChecks) cb.checked = mcpGroupCb.checked;
                mcpGroupCb.indeterminate = false;
                // Off is representable per agent now: checked -> key removed
                // (all-active default), unchecked -> [] (none for this agent).
                setAllMcpActive(this.plugin.settings, mode.slug, mcpGroupCb.checked);
                await this.plugin.saveSettings();
            })(); });
        }

        // ── Position (clamped to container bounds) ──────────────────────────
        const reposition = () => {
            positionPopover(popover, anchorBtn, containerEl, {
                cssPrefix: '--tp', maxWidth: 400, extraWidthVars: true,
            });
        };
        activeDocument.body.appendChild(popover);
        reposition();

        updateCount();

        // ── Search filter ─────────────────────────────────────────────────────
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.toLowerCase();
            for (const row of allItemRows) {
                const matches = !q
                    || (row.getAttribute('data-label') ?? '').includes(q)
                    || (row.getAttribute('data-desc') ?? '').includes(q);
                row.classList.toggle('agent-u-hidden', !matches);
            }
            if (q) {
                builtInCatRow.addClass('is-open');
                builtInCatBody.classList.remove('agent-u-hidden');
            }
        });

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
    }

    isOpen(): boolean {
        return this.popoverEl !== null;
    }
}
