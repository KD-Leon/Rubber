/* eslint-disable @typescript-eslint/no-unsafe-assignment -- File-level disable: interacts with Obsidian internals and Electron where untyped values are unavoidable. Inputs are validated at boundaries via type guards. The six other rules this used to silence are no longer triggered here. */
import { App, Menu, Notice, setIcon, setTooltip } from 'obsidian';
import JSZip from 'jszip';
import type ObsidianAgentPlugin from '../../main';
import { ContentEditorModal } from './ContentEditorModal';
import { isUserSkillSource, getSourceLabel, SOURCE_TOOLTIP } from './userSkillSource';
import { deleteSkillFolder } from './skillFolderDelete';
import { SkillVersionsModal } from '../modals/SkillVersionsModal';
import type { PluginSkillMeta } from '../../core/skills/types';
import type { SelfAuthoredSkill } from '../../core/skills/SelfAuthoredSkillLoader';
import {
    getPluginSkillsDir,
    getPluginSkillManifestPath,
    getPluginSkillFolderPath,
    getSelfAuthoredSkillsDir,
} from '../../core/utils/agentFolder';
import { importSkill, detectSourceFromFile, SkillPackageImportError, SkillFolderImportError } from '../../core/skills/SkillImportRouter';
import { confirmModal, chooseModal, promptModal } from '../modals/PromptModal';
import { t } from '../../i18n';
import { SkillRegistryModal } from './SkillRegistryModal';
import { SkillRegistryClient } from '../../core/skills/SkillRegistryClient';
import { resolveSkillFolder } from './skillFolderResolve';

interface ElectronDialog {
    showOpenDialog(options: {
        title?: string;
        defaultPath?: string;
        properties?: string[];
        filters?: { name: string; extensions: string[] }[];
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

function resolveElectronDialog(): ElectronDialog | null {
    let electronModule: { remote?: { dialog?: ElectronDialog }; dialog?: ElectronDialog } | null = null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron only reachable via dynamic require in the renderer
        electronModule = require('electron');
    } catch { return null; }
    const direct = electronModule?.dialog;
    if (direct?.showOpenDialog) return direct;
    const legacy = electronModule?.remote?.dialog;
    if (legacy?.showOpenDialog) return legacy;
    return null;
}


/**
 * Unified skill entry for the merged skill list.
 * Combines data from SkillsManager (global) and SelfAuthoredSkillLoader (plugin-local).
 */
interface UnifiedSkill {
    name: string;
    description: string;
    /**
     * Origin discriminator. Known values: `bundled` (legacy), `builtin`,
     * `learned`, `user`. Anything else is treated as a plugin-id
     * (VaultDNAScanner-managed) and routed via the plugin-skill code path.
     */
    source: string;
    /** Path in global storage (SkillsManager) -- used for toggles */
    globalPath?: string;
    /** SelfAuthoredSkill reference (plugin-local) */
    selfAuthored?: SelfAuthoredSkill;
    /** Has code modules */
    hasCodeModules: boolean;
    codeToolNames: string[];
}



export class SkillsTab {
    /** FEATURE-0507: resolved on demand so the configurable agent folder takes effect immediately. */
    private get skillsDir(): string {
        return getPluginSkillsDir(this.plugin);
    }

    /**
     * Filter text for everything this tab lists. The registry has its own
     * window; this covers what the vault already holds, on both sides of the
     * separator. A skill is a skill to the person looking for one, and having
     * to know in advance which of the two lists it lives in defeats the search.
     */
    private query = '';

    /** Set by the two sections so the shared filter can redraw both. */
    private refreshInstalled: (() => Promise<void>) | null = null;
    private refreshPlugins: (() => void) | null = null;

    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {
        // The client lives on the plugin, not on this tab: the settings tab is
        // rebuilt on every rerender, and a catalogue held in a tab-scoped
        // instance would be thrown away the moment loading finished.
        this.plugin.skillRegistryClient ??= new SkillRegistryClient(plugin);
    }

    build(containerEl: HTMLElement): void {
        // -- Introduction: What are Skills? --
        this.buildIntroSection(containerEl);

        // -- Controls first: the four ways to get a skill on one line, the
        //    filter over everything below them (FEAT-31-01).
        this.buildControlsRow(containerEl);

        // -- Installed skills --
        this.buildUnifiedSkillsSection(containerEl);

        // -- Separator --
        containerEl.createEl('hr');

        // -- Obsidian Plugin Skills (PAS-1) --
        this.buildPluginSkillsSection(containerEl);
    }

    /**
     * The action row and the filter, above both lists.
     *
     * Buttons on their own line, filter on the next. Sharing one line meant the
     * input shrank whenever a language wrote longer labels, and the filter
     * belongs with what it filters rather than with the things that add to it.
     *
     * Both sections register a redraw with this class, so the handlers here can
     * be written before either list exists.
     */
    private buildControlsRow(containerEl: HTMLElement): void {
        const actions = containerEl.createDiv({ cls: 'agent-skill-actions-row' });

        const browseBtn = actions.createEl('button', { cls: 'mod-cta agent-registry-open-btn' });
        setIcon(browseBtn.createSpan('agent-registry-open-btn__icon'), 'library-big');
        browseBtn.createSpan({ text: t('settings.skills.registryBrowse') });
        browseBtn.addEventListener('click', () => {
            const client = this.plugin.skillRegistryClient;
            if (!client) return;
            new SkillRegistryModal(this.plugin, client, () => this.rerender()).open();
        });

        const createBtn = actions.createEl('button', { text: t('settings.skills.create') });
        createBtn.addEventListener('click', () => { void this.runCreateSkill(); });

        // FEATURE-2202: universal import. Accepts a single .md, a .skill/.zip
        // or a folder via the native picker; the router detects which.
        const importBtn = actions.createEl('button', { text: t('settings.skills.import') });
        importBtn.addEventListener('click', () => {
            void this.runUniversalImport(() => this.refreshInstalled?.() ?? Promise.resolve());
        });

        // FEATURE-2207: needed when a SKILL.md was edited outside Obsidian
        // (iCloud lag, external editor) and the watcher missed it.
        const reloadBtn = actions.createEl('button', {
            text: t('settings.skills.reload'),
            attr: { 'aria-label': t('settings.skills.reloadAriaLabel') },
        });
        reloadBtn.addEventListener('click', () => { void this.runReloadSkills(reloadBtn); });

        const filterRow = containerEl.createDiv({ cls: 'agent-skill-filter-row' });
        const filterInput = filterRow.createEl('input', {
            type: 'text',
            cls: 'agent-skill-filter-input',
            attr: {
                placeholder: t('settings.skills.filterPlaceholder'),
                'aria-label': t('settings.skills.filterPlaceholder'),
            },
        });
        filterInput.addEventListener('input', () => {
            this.query = filterInput.value;
            void this.refreshInstalled?.();
            this.refreshPlugins?.();
        });
    }

    /** Reload from disk. Feedback on the button, because the rescan is slow. */
    private async runReloadSkills(button: HTMLButtonElement): Promise<void> {
        const loader = this.plugin.selfAuthoredSkillLoader;
        if (!loader) { new Notice(t('settings.skills.loaderNotReady')); return; }
        const original = button.textContent ?? t('settings.skills.reload');
        button.disabled = true;
        button.setText(t('settings.skills.scanning'));
        try {
            await loader.refresh();
            await this.refreshInstalled?.();
            new Notice(t('settings.skills.rescanned', { count: loader.getAllSkills().length }));
        } catch (e) {
            console.error('[SkillsTab] Reload skills failed:', e);
            new Notice(t('settings.skills.loaderNotReady'));
        } finally {
            button.disabled = false;
            button.setText(original);
        }
    }

    // -- Introduction --

    private buildIntroSection(containerEl: HTMLElement): void {
        const intro = containerEl.createDiv('vault-op-box vault-op-box--intro');
        const infoIcon = intro.createSpan({ cls: 'vault-op-box__icon' });
        setIcon(infoIcon, 'lightbulb');
        const infoText = intro.createDiv({ cls: 'vault-op-box__text' });
        infoText.createEl('strong', { text: t('settings.skills.introTitle') });
        infoText.createEl('p', { text: t('settings.skills.introDesc') });
    }

    /**
     * Filter the installed list by the query typed above it.
     *
     * Matches name and description. An empty query shows everything, which is
     * the right default for a list of things you already have.
     */
    private filterByQuery<T extends { name: string; description?: string }>(skills: T[]): T[] {
        const q = this.query.trim().toLowerCase();
        if (!q) return skills;
        const terms = q.split(/\s+/);
        return skills.filter((s) => {
            const hay = `${s.name} ${s.description ?? ''}`.toLowerCase();
            return terms.every((t) => hay.includes(t));
        });
    }

    // -- Unified Skills Section --

    private buildUnifiedSkillsSection(containerEl: HTMLElement): void {
        containerEl.createEl('h3', {
            text: t('settings.skills.headingInstalled'),
            cls: 'agent-skill-heading',
        });
        const listEl = containerEl.createDiv({ cls: 'agent-rules-list' });

        const refreshList = async () => {
            listEl.empty();

            // Collect and merge skills from both sources
            const all = await this.collectUnifiedSkills();
            const unified = this.filterByQuery(all);

            if (all.length > 0 && unified.length === 0) {
                listEl.createEl('p', {
                    cls: 'agent-empty-state',
                    text: t('settings.skills.searchNoHits', { query: this.query }),
                });
                return;
            }

            if (unified.length === 0) {
                listEl.createEl('p', { cls: 'agent-empty-state', text: t('settings.skills.empty') });
                // FIX-29-05-01: still show rejections here. "No skills" plus a
                // rejected list is exactly the case where the user most needs
                // to know the skills exist but failed to parse.
                this.renderRejectedSkills(listEl);
                return;
            }

            const table = listEl.createDiv('agent-table-box').createEl('table', { cls: 'agent-skill-table' });
            const thead = table.createEl('thead');
            const hr = thead.createEl('tr');
            hr.createEl('th', { text: '', cls: 'agent-skill-th-status' });
            hr.createEl('th', { text: t('settings.skills.headerSkill') });
            const sourceTh = hr.createEl('th', { text: t('settings.skills.headerSource'), cls: 'agent-skill-th-cmds' });
            setTooltip(sourceTh, SOURCE_TOOLTIP);
            hr.createEl('th', { text: '', cls: 'agent-skill-th-actions' });
            hr.createEl('th', { text: t('settings.skills.headerAgent'), cls: 'agent-skill-th-toggle' });

            const tbody = table.createEl('tbody');

            for (const skill of unified) {
                this.plugin.settings.manualSkillToggles ??= {};
                const toggleKey = skill.globalPath ?? skill.selfAuthored?.filePath ?? skill.name;
                const isActive = this.plugin.settings.manualSkillToggles[toggleKey] !== false;

                const tr = tbody.createEl('tr', {
                    cls: isActive ? '' : 'agent-skill-disabled',
                });

                // Status dot
                const statusTd = tr.createEl('td', { cls: 'agent-skill-status-cell' });
                const dot = statusTd.createSpan({ cls: 'agent-skill-dot' });
                dot.addClass(isActive ? 'agent-skill-dot-on' : 'agent-skill-dot-off');

                // Name + description
                const nameTd = tr.createEl('td', { cls: 'agent-skill-name-cell' });
                nameTd.createDiv({ text: skill.name, cls: 'agent-skill-name' });
                if (skill.description) {
                    nameTd.createDiv({ text: skill.description, cls: 'agent-skill-desc agent-skill-desc-clamped' });
                }

                // Source label
                const sourceLabel = getSourceLabel(skill.source);
                const sourceTd = tr.createEl('td', { cls: 'agent-skill-cmd-cell' });
                const badge = sourceTd.createSpan({ text: sourceLabel, cls: 'agent-skill-source-badge' });
                badge.addClass(`agent-skill-source-${skill.source}`);

                // Actions menu (FEAT-29-09 follow-up: collapsed to a
                // single more-horizontal button to free up space next to
                // the on/off toggle. Menu items: open folder, versions,
                // export, (optional) delete.
                const actionsTd = tr.createEl('td', { cls: 'agent-skill-actions-cell' });
                const menuBtn = actionsTd.createEl('button', {
                    cls: 'agent-skill-action-btn agent-skill-action-menu',
                    attr: { 'aria-label': t('settings.skills.actionsAriaLabel') },
                });
                setIcon(menuBtn, 'more-horizontal');
                menuBtn.addEventListener('click', (evt) => {
                    const menu = new Menu();
                    menu.addItem((item) =>
                        item.setTitle(t('settings.skills.edit') || 'Open folder')
                            .setIcon('folder-open')
                            .onClick(() => { void this.openSkillFolder(skill); }),
                    );
                    menu.addItem((item) =>
                        item.setTitle(t('settings.skills.showVersions'))
                            .setIcon('history')
                            .onClick(() => { this.openSkillVersionsModal(skill); }),
                    );
                    menu.addItem((item) =>
                        item.setTitle(t('settings.skills.export') || 'Export as zip')
                            .setIcon('download')
                            .onClick(() => { void this.exportSkill(skill); }),
                    );
                    if (skill.source !== 'bundled' && skill.source !== 'builtin') {
                        menu.addSeparator();
                        menu.addItem((item) =>
                            item.setTitle(t('settings.skills.delete') || 'Delete')
                                .setIcon('trash-2')
                                .setWarning(true)
                                .onClick(() => { void (async () => {
                                    await this.deleteSkill(skill);
                                    await refreshList();
                                })(); }),
                        );
                    }
                    menu.showAtMouseEvent(evt);
                });

                // Toggle
                const toggleTd = tr.createEl('td', { cls: 'agent-skill-toggle-cell' });
                const toggleContainer = toggleTd.createDiv({
                    cls: `checkbox-container agent-skill-toggle${isActive ? ' is-enabled' : ''}`,
                });
                toggleContainer.addEventListener('click', () => {
                    this.plugin.settings.manualSkillToggles ??= {};
                    const current = this.plugin.settings.manualSkillToggles[toggleKey] !== false;
                    this.plugin.settings.manualSkillToggles[toggleKey] = !current;
                    void this.plugin.saveSettings();
                    toggleContainer.toggleClass('is-enabled', !current);
                    dot.removeClass(current ? 'agent-skill-dot-on' : 'agent-skill-dot-off');
                    dot.addClass(current ? 'agent-skill-dot-off' : 'agent-skill-dot-on');
                    tr.toggleClass('agent-skill-disabled', current);
                });
            }

            this.renderRejectedSkills(listEl);
        };

        this.refreshInstalled = refreshList;
        void refreshList();
    }


    /**
     * Create a skill: write it yourself, or have the agent build it.
     *
     * The choice belongs to the user, so the button asks instead of picking.
     */
    private async runCreateSkill(): Promise<void> {
        const skillsManager = this.plugin.skillsManager;
        if (!skillsManager) { new Notice(t('settings.skills.createFailed')); return; }

        // Two ways to get a skill, and the choice belongs to the user:
        // write it yourself, or have the agent interview you and build it.
        const route = await chooseModal(this.app, {
            title: t('settings.skills.createChooseTitle'),
            options: [
                {
                    id: 'scratch',
                    label: t('settings.skills.createFromScratch'),
                    description: t('settings.skills.createFromScratchDesc'),
                },
                {
                    id: 'creator',
                    label: t('settings.skills.createWithCreator'),
                    description: t('settings.skills.createWithCreatorDesc'),
                },
            ],
        });
        if (!route) return;

        if (route === 'creator') {
            // skill-creator is a registry skill since 2026-08-14, not bundled,
            // so it may be absent. Sending /skill-creator blind would put a
            // literal slash token in front of the model with no notice, so
            // check first and route the user to the registry detail page
            // where one click installs it.
            const installed = this.plugin.selfAuthoredSkillLoader
                ?.getAllSkills().some((s) => s.name === 'skill-creator') ?? false;
            if (!installed) {
                const client = this.plugin.skillRegistryClient;
                if (client) {
                    new Notice(t('settings.skills.creatorNotInstalled'));
                    new SkillRegistryModal(this.plugin, client, () => this.rerender(), 'skill-creator').open();
                } else {
                    new Notice(t('settings.skills.createFailed'));
                }
                return;
            }
            // Hand off to the chat: close settings, start the skill-creator
            // skill, and let the dialogue take it from there.
            this.app.setting?.close();
            await this.plugin.sendMessageToAgent('/skill-creator');
            return;
        }

        // Always ask. The box above is a filter now, and borrowing whatever
        // sits in it as the new skill's name would be a guess the user
        // never made.
        const name = ((await promptModal(this.app, {
            title: t('settings.skills.createNameTitle'),
            placeholder: t('settings.skills.placeholder'),
        })) ?? '').trim();
        if (!name) return;
        const safeName = name.replace(/[^a-zA-Z0-9_ -]/g, '').trim();
        if (!safeName) { new Notice(t('settings.skills.createFailed')); return; }
        const dir = `${skillsManager.skillsDir}/${safeName}`;
        const skillPath = `${dir}/SKILL.md`;
        const template = `---\nname: ${safeName}\ndescription: Describe when this skill applies\nkeywords: []\n---\n\n# ${safeName}\n\n<!-- Describe what this skill does and when to use it. The agent reads this file when the skill is relevant. -->\n\n`;
        try {
            await skillsManager.createSkill(dir, template);
            await this.refreshInstalled?.();
            new ContentEditorModal(this.app, t('settings.skills.editSkill', { name: safeName }), template, (content) => {
                return skillsManager.writeFile(skillPath, content);
            }).open();
        } catch {
            new Notice(t('settings.skills.createFailed'));
        }
    }

    // -- Helpers for unified skills --

    /**
     * FIX-29-05-01: list SKILL.md files that failed hard validation, with the
     * reason. Before this, a rejected skill left no user-visible trace at all
     * (console.warn only), so a typo in the frontmatter presented as "the chat
     * does not know my skill" and sent the user hunting in the wrong place.
     */
    private renderRejectedSkills(listEl: HTMLElement): void {
        const rejected = this.plugin.selfAuthoredSkillLoader?.getRejectedSkills() ?? [];
        if (rejected.length === 0) return;

        const box = listEl.createDiv({ cls: 'agent-skill-rejected-box' });
        box.createEl('h4', { text: t('settings.skills.rejectedHeading') });
        box.createEl('p', {
            cls: 'agent-skill-rejected-desc',
            text: t('settings.skills.rejectedDesc'),
        });

        const list = box.createEl('ul', { cls: 'agent-skill-rejected-list' });
        for (const entry of rejected) {
            const li = list.createEl('li');
            li.createSpan({ text: entry.folder, cls: 'agent-skill-rejected-name' });
            li.createDiv({
                cls: 'agent-skill-rejected-reason',
                text: t('settings.skills.rejectedReason', { reason: entry.reason }),
            });
            li.createDiv({ cls: 'agent-skill-rejected-path', text: entry.filePath });
        }
    }

    /**
     * Collect skills from both SkillsManager (global) and SelfAuthoredSkillLoader (plugin-local),
     * deduplicate by name, and return a unified list sorted by source priority.
     */
    private async collectUnifiedSkills(): Promise<UnifiedSkill[]> {
        const byName = new Map<string, UnifiedSkill>();

        // 1. SelfAuthoredSkillLoader (plugin-local: bundled + agent + template).
        //
        // FEAT-29-11 follow-up: post-Layout-Konsolidierung leben plugin-managed
        // Skills im selben `data/skills/{name}/` Ordner wie User-/Builtin-Skills,
        // also picks der Loader sie ebenfalls auf. Sie haben aber
        // `source: <plugin-id>` und gehoeren in die Plugin-Section weiter unten,
        // nicht in die User-Skills-Liste. Filter sie hier raus.
        const loader = this.plugin.selfAuthoredSkillLoader;
        if (loader) {
            for (const skill of loader.getAllSkills()) {
                if (!isUserSkillSource(skill.source)) continue;
                byName.set(skill.name, {
                    name: skill.name,
                    description: skill.description,
                    source: skill.source,
                    selfAuthored: skill,
                    hasCodeModules: skill.codeModules.length > 0,
                    codeToolNames: skill.codeModuleInfos.map(m => m.name),
                });
            }
        }

        // 2. SkillsManager (global storage: user-created, synced).
        //
        // FEAT-29-11 follow-up: GlobalFileService.useVaultLocalRoot points the
        // SkillsManager root at `.vault-operator/data/`, so `discoverSkills`
        // ends up reading from the same `data/skills/` folder as the
        // SelfAuthoredSkillLoader above. We MUST apply the same source-filter
        // here, otherwise plugin-managed entries (source: <plugin-id>) that
        // were filtered out in step 1 slip back in via this path and end up
        // double-listed under both "User Skills" and "Plugin Skills".
        const skillsManager = this.plugin.skillsManager;
        if (skillsManager) {
            const globalSkills = await skillsManager.discoverSkills();
            for (const skill of globalSkills) {
                const source = skill.source ?? 'user';
                if (!isUserSkillSource(source)) continue;
                // AUDIT FIX-29-05 L-6: a rejected skill is listed below by
                // renderRejectedSkills with its reason. Showing it HERE too,
                // with an active status dot and a working toggle, gave the user
                // two contradictory signals about the same skill.
                if (skill.invalidReason !== undefined) continue;
                if (!byName.has(skill.name)) {
                    // Only add if not already present from SelfAuthoredSkillLoader
                    byName.set(skill.name, {
                        name: skill.name,
                        description: skill.description ?? '',
                        source,
                        globalPath: skill.path,
                        hasCodeModules: false,
                        codeToolNames: [],
                    });
                } else {
                    // Merge: add global path reference for toggle compatibility
                    const existing = byName.get(skill.name);
                    if (existing) {
                        existing.globalPath = skill.path;
                    }
                }
            }
        }

        // Sort: built-in first, then purchased Pro skills, then
        // agent-created (skill-creator + legacy learned), then
        // user-authored. Unknown sources land in the agent bucket so they
        // stay near the bottom but above user entries.
        const order: Record<string, number> = {
            bundled: 0,
            builtin: 0,
            pro: 1,
            agent: 2,
            learned: 2,
            user: 3,
        };
        return [...byName.values()].sort((a, b) => {
            const oa = order[a.source] ?? 1;
            const ob = order[b.source] ?? 1;
            if (oa !== ob) return oa - ob;
            return a.name.localeCompare(b.name);
        });
    }

    /**
     * FEAT-29-11: open the skill's folder in the OS file manager.
     * Replaces the old `editSkill` modal flow. Works uniformly across
     * user, learned, and bundled skills -- builtin folders live under
     * `data/skills/{name}/` after the materialisation step.
     */
    private async openSkillFolder(skill: UnifiedSkill): Promise<void> {
        try {
            // FIX-29-11-01 (Issue #67): ask the owner instead of rebuilding.
            // This used to take the slug out of `globalPath` and glue it onto
            // getPluginSkillsDir(), which is only the right root once the
            // storage consolidation has run. Before it has, the SkillsManager
            // reads from {vault-parent}/vault-operator-shared/ while the
            // rebuilt path pointed inside the vault, so Electron got a path
            // that does not exist and answered "Failed to open path". The
            // export path a few dozen lines below never had this problem
            // because it reads through the owner.
            const location = resolveSkillFolder(
                {
                    selfAuthoredFilePath: skill.selfAuthored?.filePath,
                    globalPath: skill.globalPath,
                },
                this.plugin.globalFs,
            );

            if (location.kind === 'unresolved') {
                new Notice(t('settings.skills.cannotResolveFolder'));
                return;
            }

            let absPath: string | null = null;
            if (location.kind === 'absolute') {
                absPath = location.absolutePath;
            } else {
                // Vault-relative: turn absolute through the FileSystemAdapter.
                const adapter = this.plugin.app.vault.adapter as unknown as {
                    getFullPath?: (relative: string) => string;
                    getBasePath?: () => string;
                };
                absPath = adapter.getFullPath
                    ? adapter.getFullPath(location.relativePath)
                    : (adapter.getBasePath ? `${adapter.getBasePath()}/${location.relativePath}` : null);
            }
            if (!absPath) {
                new Notice(t('settings.skills.cannotResolvePath'));
                return;
            }

            // eslint-disable-next-line @typescript-eslint/no-require-imports -- electron is the standard Obsidian-desktop dep, no runtime install needed
            const electron = require('electron') as { shell?: { openPath?: (p: string) => Promise<string> } };
            const result = electron.shell?.openPath
                ? await electron.shell.openPath(absPath)
                : 'electron.shell.openPath unavailable';
            if (result) {
                // FIX-29-11-01 (Issue #67): Electron's message is just "Failed
                // to open path", which tells the user nothing about WHICH path
                // failed. Carry the resolved path in the existing {{reason}}
                // placeholder so a report is diagnosable without a debug build.
                console.debug('[SkillsTab] openPath failed for', absPath, '->', result);
                new Notice(t('settings.skills.openFolderFailed', { reason: `${result} (${absPath})` }));
            }
        } catch (e) {
            new Notice(t('settings.skills.openSkillFolderFailed'));
            console.error('[SkillsTab] openSkillFolder failed:', e);
        }
    }

    /**
     * FEAT-29-11: open a plugin-skill's folder. Plugin-skills now live in
     * the unified `data/skills/{plugin-id}/` layout, identical to user
     * and builtin skills.
     */
    private async openPluginSkillFolder(skill: PluginSkillMeta): Promise<void> {
        try {
            const folder = getPluginSkillFolderPath(this.plugin, skill.id);
            if (!folder) {
                new Notice(t('settings.skills.pluginFolderUnavailable'));
                return;
            }
            const adapter = this.plugin.app.vault.adapter as unknown as {
                getFullPath?: (relative: string) => string;
                getBasePath?: () => string;
            };
            const absPath = adapter.getFullPath
                ? adapter.getFullPath(folder)
                : (adapter.getBasePath ? `${adapter.getBasePath()}/${folder}` : null);
            if (!absPath) {
                new Notice(t('settings.skills.cannotResolvePath'));
                return;
            }
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- electron is the standard Obsidian-desktop dep, no runtime install needed
            const electron = require('electron') as { shell?: { openPath?: (p: string) => Promise<string> } };
            const result = electron.shell?.openPath
                ? await electron.shell.openPath(absPath)
                : 'electron.shell.openPath unavailable';
            if (result) {
                // FIX-29-11-01 (Issue #67): Electron's message is just "Failed
                // to open path", which tells the user nothing about WHICH path
                // failed. Carry the resolved path in the existing {{reason}}
                // placeholder so a report is diagnosable without a debug build.
                console.debug('[SkillsTab] openPath failed for', absPath, '->', result);
                new Notice(t('settings.skills.openFolderFailed', { reason: `${result} (${absPath})` }));
            }
        } catch (e) {
            new Notice(t('settings.skills.openPluginFolderFailed'));
            console.error('[SkillsTab] openPluginSkillFolder failed:', e);
        }
    }

    /**
     * FEAT-29-09: open the per-skill version history. Restore + tag
     * actions live in the modal.
     */
    private openSkillVersionsModal(skill: UnifiedSkill): void {
        const service = this.plugin.skillSnapshotService;
        if (!service) {
            new Notice(t('settings.skills.versioningUnavailable'));
            return;
        }
        new SkillVersionsModal(this.app, skill.name, service).open();
    }

    /**
     * FEAT-29-11 Step D: export the entire skill folder as a ZIP archive.
     * Replaces the old single-file SKILL.md export. The archive carries the
     * SKILL.md plus all sidecars (scripts/, references/, assets/, sub-roles)
     * so a user can transfer a complete Anthropic-conformant skill bundle
     * to another vault or share it.
     */
    private async exportSkill(skill: UnifiedSkill): Promise<void> {
        try {
            const adapter = this.plugin.app.vault.adapter;

            // Resolve the skill folder via the same logic openSkillFolder uses.
            let skillDir: string | null = null;
            if (skill.selfAuthored?.filePath?.endsWith('/SKILL.md')) {
                skillDir = skill.selfAuthored.filePath.replace(/\/SKILL\.md$/, '');
            } else if (skill.globalPath && this.plugin.skillsManager) {
                // SkillsManager-only skill: single SKILL.md in global storage.
                // Wrap it in a 1-file ZIP so the export format stays uniform.
                const content = await this.plugin.skillsManager.readFile(skill.globalPath);
                const zip = new JSZip();
                zip.file('SKILL.md', content);
                const blob = await zip.generateAsync({ type: 'blob' });
                this.triggerDownload(blob, `${skill.name}.zip`);
                return;
            }

            if (!skillDir || !(await adapter.exists(skillDir))) {
                new Notice(t('settings.skills.folderNotFound'));
                return;
            }

            const zip = new JSZip();
            await this.addFolderToZip(adapter, skillDir, '', zip);
            const blob = await zip.generateAsync({ type: 'blob' });
            this.triggerDownload(blob, `${skill.name}.zip`);
        } catch (e) {
            new Notice(t('settings.skills.exportFailed'));
            console.error('[SkillsTab] Export failed:', e);
        }
    }

    /**
     * Recursively add every file under `dir` to the zip, preserving the
     * folder structure relative to the skill root. Binary files use
     * `readBinary` so PNG/PDF assets survive the round-trip.
     */
    private async addFolderToZip(
        adapter: App['vault']['adapter'],
        dir: string,
        relPrefix: string,
        zip: JSZip,
    ): Promise<void> {
        const { files, folders } = await adapter.list(dir);
        const dirPrefix = `${dir}/`;
        for (const filePath of files) {
            // FEAT-29-11 AUDIT L-2 defense-in-depth: defend the user against
            // zip-slip if a future Obsidian adapter returns a path outside
            // the listed folder. The current adapter does not, but the cost
            // of the containment check is negligible.
            if (!filePath.startsWith(dirPrefix)) {
                console.warn('[SkillsTab] Skipping out-of-range file during export:', filePath);
                continue;
            }
            const name = filePath.slice(dir.length + 1);
            if (name.includes('..') || name.startsWith('/')) {
                console.warn('[SkillsTab] Skipping unsafe zip path:', name);
                continue;
            }
            const zipPath = relPrefix ? `${relPrefix}/${name}` : name;
            if (this.isLikelyBinaryFile(name)) {
                const buf = await adapter.readBinary(filePath);
                zip.file(zipPath, buf);
            } else {
                const text = await adapter.read(filePath);
                zip.file(zipPath, text);
            }
        }
        for (const subPath of folders) {
            if (!subPath.startsWith(dirPrefix)) {
                console.warn('[SkillsTab] Skipping out-of-range folder during export:', subPath);
                continue;
            }
            const subName = subPath.slice(dir.length + 1);
            if (subName.includes('..') || subName.startsWith('/')) {
                console.warn('[SkillsTab] Skipping unsafe zip subfolder:', subName);
                continue;
            }
            const subRel = relPrefix ? `${relPrefix}/${subName}` : subName;
            await this.addFolderToZip(adapter, subPath, subRel, zip);
        }
    }

    private isLikelyBinaryFile(name: string): boolean {
        const lower = name.toLowerCase();
        const textExt = new Set([
            '.md', '.txt', '.json', '.js', '.ts', '.mjs', '.cjs',
            '.yaml', '.yml', '.html', '.css', '.xml', '.csv',
        ]);
        const dot = lower.lastIndexOf('.');
        if (dot < 0) return false;
        return !textExt.has(lower.slice(dot));
    }

    private triggerDownload(blob: Blob, filename: string): void {
        const url = URL.createObjectURL(blob);
        const a = createEl('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    private async deleteSkill(skill: UnifiedSkill): Promise<void> {
        // Never delete builtin skills -- they get rewritten on next plugin reload
        // anyway, and the materializer treats them as read-only.
        if (skill.source === 'bundled' || skill.source === 'builtin') return;

        const adapter = this.plugin.app.vault.adapter;
        const loader = this.plugin.selfAuthoredSkillLoader;
        let fsError: unknown = null;

        // 1. Physische Loeschung. FIX-19-08-01: EIN rekursives rmdir statt des
        // fragilen 2-Ebenen-Walks -- der liess `.versions/{ts}/references/...`
        // liegen und warf dann ENOTEMPTY, was den ganzen Handler abbrach und den
        // Skill in der Liste zuruecklies. Ein etwaiger FS-Fehler wird gemerkt,
        // aber der In-Memory-/Toggle-Cleanup unten laeuft trotzdem, damit die UI
        // konsistent bleibt.
        try {
            if (skill.selfAuthored && loader) {
                loader.unregisterCodeTools(skill.selfAuthored);
                const skillDir = skill.selfAuthored.filePath.replace(/\/SKILL\.md$/, '');
                await deleteSkillFolder(adapter, skillDir);
            }

            // Delete from global storage (SkillsManager). Eigenes try/catch:
            // "schon geloescht" ist hier kein Fehler und soll die Erfolgsmeldung
            // nicht kippen.
            try {
                if (skill.globalPath && this.plugin.skillsManager) {
                    await this.plugin.skillsManager.deleteSkill(skill.globalPath);
                } else if (this.plugin.skillsManager && skill.selfAuthored) {
                    const skillDir = skill.selfAuthored.filePath.replace(/\/SKILL\.md$/, '');
                    const skillFolderName = skillDir.split('/').pop();
                    if (skillFolderName) {
                        await this.plugin.skillsManager.deleteSkill(`skills/${skillFolderName}/SKILL.md`);
                    }
                }
            } catch (e) {
                console.debug('[SkillsTab] global-storage delete non-fatal:', e);
            }
        } catch (e) {
            fsError = e;
            console.error('[SkillsTab] Delete (filesystem) failed:', e);
        }

        // 2. In-Memory- + Settings-Cleanup IMMER, auch bei partiellem FS-Fehler,
        // sonst zeigt die Liste den Skill weiter (stale). loadAll() baut die
        // Loader-Sicht ohnehin frisch von der Platte auf.
        try {
            if (skill.selfAuthored && loader) loader.removeSkill(skill.name);
            const toggleKey = skill.globalPath ?? skill.selfAuthored?.filePath ?? skill.name;
            this.plugin.settings.manualSkillToggles ??= {};
            delete this.plugin.settings.manualSkillToggles[toggleKey];
            await this.plugin.saveSettings();
            if (loader) await loader.loadAll();
        } catch (e) {
            console.error('[SkillsTab] Delete (cache cleanup) failed:', e);
        }

        if (fsError) {
            new Notice(t('settings.skills.deleteFailed'));
        } else {
            new Notice(t('settings.skills.deleted', { name: skill.name }));
        }
    }

    // -- Obsidian Plugin Skills (PAS-1) --

    private buildPluginSkillsSection(containerEl: HTMLElement): void {
        const scanner = this.plugin.vaultDNAScanner;
        const registry = this.plugin.skillRegistry;

        if (!scanner || !registry) {
            containerEl.createEl('h3', {
                text: t('settings.skills.headingPlugin'),
                cls: 'agent-skill-heading',
            });
            containerEl.createEl('p', {
                cls: 'agent-settings-desc',
                text: t('settings.skills.pluginDisabled'),
            });
            return;
        }

        const activeSkills = registry.getActivePluginSkills();
        const disabledSkills = registry.getDisabledPluginSkills();
        const allSkills = scanner.getAllPluginSkills();

        // Header with stats
        containerEl.createEl('h3', {
            text: t('settings.skills.headingPlugin'),
            cls: 'agent-skill-heading',
        });
        const statsEl = containerEl.createEl('p', { cls: 'agent-settings-desc' });
        statsEl.setText(
            t('settings.skills.pluginStats', { active: activeSkills.length, disabled: disabledSkills.length, total: allSkills.length }),
        );

        // FEAT-29-11 follow-up: auto-rescan when the section opens with zero
        // plugin skills loaded. Two causes for the empty state:
        //   - Settings was opened before workspace.onLayoutReady fired the
        //     initial scanner.initialize() (race on plugin reload).
        //   - User upgraded across the Welle-2 -> FEAT-29-11 layout boundary
        //     and the previous scan results need a rewrite.
        // Guarded by scanner.hasScanned so a rerender does not kick off a
        // second scan, and so users with zero installed plugins do not
        // scan in a loop (the scanner sets hasScanned=true on completion
        // even when the result is empty). Manual Rescan still works.
        if (allSkills.length === 0 && !scanner.hasScanned) {
            void (async () => {
                try {
                    await scanner.fullScan();
                    registry.updateToggles(this.plugin.settings.vaultDNA.skillToggles);
                    this.rerender();
                } catch (e) {
                    console.warn('[VaultDNA] Auto rescan failed (non-fatal):', e);
                }
            })();
        }

        // Controls row
        const controlsRow = containerEl.createDiv({ cls: 'agent-skill-controls' });
        const rescanBtn = controlsRow.createEl('button', { text: t('settings.skills.rescan'), cls: 'mod-cta' });
        rescanBtn.addEventListener('click', () => { void (async () => {
            rescanBtn.disabled = true;
            rescanBtn.setText(t('settings.skills.scanning'));
            try {
                await scanner.fullScan();
                registry.updateToggles(this.plugin.settings.vaultDNA.skillToggles);
                new Notice(t('settings.skills.scanComplete', { count: scanner.getAllPluginSkills().length }));
                this.rerender();
            } catch (e) {
                new Notice(t('settings.skills.scanFailed'));
                console.error('[VaultDNA] Rescan failed:', e);
            } finally {
                rescanBtn.disabled = false;
                rescanBtn.setText(t('settings.skills.rescan'));
            }
        })(); });

        // The groups redraw on every keystroke in the filter above, so they
        // live in their own container. The stats line does not: it describes
        // the vault, not the query, and a total that moved while typing would
        // stop being a total.
        const groupsEl = containerEl.createDiv({ cls: 'agent-skill-groups' });

        const renderGroups = () => {
            groupsEl.empty();
            const core = this.filterByQuery(allSkills.filter((s) => s.source === 'core'));
            const community = this.filterByQuery(allSkills.filter((s) => s.source !== 'core'));

            if (core.length === 0 && community.length === 0) {
                groupsEl.createEl('p', {
                    cls: 'agent-empty-state',
                    text: allSkills.length === 0
                        ? t('settings.skills.pluginNone')
                        : t('settings.skills.searchNoHits', { query: this.query }),
                });
                return;
            }
            if (core.length > 0) {
                this.buildCollapsibleSkillGroup(
                    groupsEl, t('settings.skills.corePlugins', { count: core.length }), core);
            }
            if (community.length > 0) {
                this.buildCollapsibleSkillGroup(
                    groupsEl, t('settings.skills.communityPlugins', { count: community.length }), community);
            }
        };

        this.refreshPlugins = renderGroups;
        renderGroups();
    }

    private buildCollapsibleSkillGroup(containerEl: HTMLElement, title: string, skills: PluginSkillMeta[]): void {
        const header = containerEl.createDiv({ cls: 'agent-skill-group-header' });
        const chevron = header.createSpan({ cls: 'agent-skill-group-chevron' });
        setIcon(chevron, 'chevron-down');
        header.createSpan({ text: title, cls: 'agent-skill-group-title' });

        const content = containerEl.createDiv({ cls: 'agent-skill-group-content' });
        this.buildCompactSkillList(content, skills);

        header.addEventListener('click', () => {
            const collapsed = content.classList.toggle('agent-skill-group-collapsed');
            chevron.empty();
            setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');
        });
    }

    private buildCompactSkillList(containerEl: HTMLElement, skills: PluginSkillMeta[]): void {
        const table = containerEl.createDiv('agent-table-box').createEl('table', { cls: 'agent-skill-table' });

        // Header
        const thead = table.createEl('thead');
        const hr = thead.createEl('tr');
        hr.createEl('th', { text: '', cls: 'agent-skill-th-status' }); // installed dot
        hr.createEl('th', { text: t('settings.skills.headerPlugin') });
        hr.createEl('th', { text: t('settings.skills.headerCommands'), cls: 'agent-skill-th-cmds' });
        hr.createEl('th', { text: '', cls: 'agent-skill-th-actions' }); // view buttons
        hr.createEl('th', { text: t('settings.skills.headerAgent'), cls: 'agent-skill-th-toggle' }); // agent toggle

        const tbody = table.createEl('tbody');

        // Sort: enabled first, then alphabetical
        const sorted = [...skills].sort((a, b) => {
            if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        for (const skill of sorted) {
            const tr = tbody.createEl('tr', {
                cls: skill.enabled ? '' : 'agent-skill-disabled',
            });

            // Status dot (installed in Obsidian?)
            const statusTd = tr.createEl('td', { cls: 'agent-skill-status-cell' });
            const dot = statusTd.createSpan({ cls: 'agent-skill-dot' });
            dot.addClass(skill.enabled ? 'agent-skill-dot-on' : 'agent-skill-dot-off');
            dot.setAttribute('aria-label', skill.enabled ? t('settings.skills.installed') : t('settings.skills.disabled'));

            // Name + description
            const nameTd = tr.createEl('td', { cls: 'agent-skill-name-cell' });
            nameTd.createDiv({ text: skill.name, cls: 'agent-skill-name' });
            if (skill.description) {
                nameTd.createDiv({ text: skill.description, cls: 'agent-skill-desc' });
            }

            // Command count
            tr.createEl('td', { text: String(skill.commands.length), cls: 'agent-skill-cmd-cell' });

            // Actions (view buttons)
            const actionsTd = tr.createEl('td', { cls: 'agent-skill-actions-cell' });

            // Open skill folder (FEAT-29-11: opens the plugin-skill's folder
            // in the OS file manager instead of the legacy edit-modal.)
            const editSkillBtn = actionsTd.createEl('button', {
                cls: 'agent-skill-action-btn', attr: { 'aria-label': t('settings.skills.editFile') },
            });
            setIcon(editSkillBtn, 'folder-open');
            editSkillBtn.addEventListener('click', () => void this.openPluginSkillFolder(skill));

            // FEAT-29-11: README button removed. Plugin-skill readmes no
            // longer exist as separate files -- their content lives in the
            // SKILL.md body. The folder-open button above is the unified
            // editing path.

            // Toggle -- for ALL plugins (controls whether agent may use this skill)
            const toggleTd = tr.createEl('td', { cls: 'agent-skill-toggle-cell' });
            const isActive = this.plugin.settings.vaultDNA.skillToggles[skill.id] !== false;
            const toggleContainer = toggleTd.createDiv({
                cls: `checkbox-container agent-skill-toggle${isActive ? ' is-enabled' : ''}`,
            });
            toggleContainer.addEventListener('click', () => {
                const current = this.plugin.settings.vaultDNA.skillToggles[skill.id] !== false;
                this.plugin.settings.vaultDNA.skillToggles[skill.id] = !current;
                this.plugin.skillRegistry?.updateToggles(this.plugin.settings.vaultDNA.skillToggles);
                void this.plugin.saveSettings();
                toggleContainer.toggleClass('is-enabled', !current);
            });
        }
    }

    private async openSkillFile(skill: PluginSkillMeta): Promise<void> {
        // FEAT-29-02: layout-aware -- folder/SKILL.md post-Welle-1, .skill.md legacy.
        const path = getPluginSkillManifestPath(this.plugin, skill.id);
        try {
            const content = await this.app.vault.adapter.read(path);
            new ContentEditorModal(this.app, t('settings.skills.skillDetail', { name: skill.name }), content, (updated) => {
                return this.app.vault.adapter.write(path, updated);
            }).open();
        } catch {
            new Notice(t('settings.skills.fileNotFound', { id: skill.id }));
        }
    }

    // FEAT-29-11: openReadmeFile + checkReadmeExists removed. Plugin
    // readmes no longer exist as separate files (consolidated into the
    // SKILL.md body by VaultDNAScanner.writeFolderFormat).

    /**
     * FEATURE-2202: universal skill import. Opens the native picker if
     * available (lets the user pick either a file or a directory), falls
     * back to an HTML file input otherwise. The router detects the type and
     * dispatches to the right sub-importer.
     */
    private async runUniversalImport(refreshList: () => Promise<void>): Promise<void> {
        const targetSkillsDir = getSelfAuthoredSkillsDir(this.plugin);
        const adapter = this.app.vault.adapter;
        const dialog = resolveElectronDialog();

        if (dialog) {
            await this.runElectronImport(dialog, targetSkillsDir, adapter, refreshList);
            return;
        }

        this.runHtmlFileImport(targetSkillsDir, adapter, refreshList);
    }

    private async runElectronImport(
        dialog: ElectronDialog,
        targetSkillsDir: string,
        adapter: import('obsidian').DataAdapter,
        refreshList: () => Promise<void>,
    ): Promise<void> {
        const pick = await dialog.showOpenDialog({
            title: t('settings.skills.importDialogTitle'),
            properties: ['openFile', 'openDirectory'],
            filters: [
                { name: t('settings.skills.importFilterSkillFiles'), extensions: ['md', 'zip', 'skill'] },
                { name: t('settings.skills.importFilterAllFiles'), extensions: ['*'] },
            ],
        });
        if (pick.canceled || pick.filePaths.length === 0) return;

        const chosen = pick.filePaths[0];
        try {
            const result = await this.runImportForPath(chosen, targetSkillsDir, adapter, false);
            await this.finishImport(result, refreshList);
        } catch (e) {
            if (this.isDuplicate(e)) {
                const replace = await confirmModal(this.app, {
                    title: t('settings.skills.duplicateTitle'),
                    message: t('settings.skills.duplicateMessage'),
                    confirmLabel: t('settings.skills.replaceButton'),
                    destructive: true,
                });
                if (!replace) {
                    new Notice(t('settings.skills.importCancelled'));
                    return;
                }
                try {
                    const result = await this.runImportForPath(chosen, targetSkillsDir, adapter, true);
                    await this.finishImport(result, refreshList);
                } catch (inner) {
                    new Notice(t('settings.skills.importFailedReason', { reason: this.errorMessage(inner) }), 8000);
                }
                return;
            }
            new Notice(t('settings.skills.importFailedReason', { reason: this.errorMessage(e) }), 8000);
        }
    }

    private async runImportForPath(
        absolutePath: string,
        targetSkillsDir: string,
        adapter: import('obsidian').DataAdapter,
        overwrite: boolean,
    ): Promise<Awaited<ReturnType<typeof importSkill>>> {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node fs only reachable via dynamic require
        const fs: typeof import('fs/promises') = require('fs/promises');
        const stat = await fs.stat(absolutePath);

        if (stat.isDirectory()) {
            return await importSkill({
                adapter,
                targetSkillsDir,
                source: { kind: 'directory', absolutePath },
                overwrite,
            });
        }

        // File on disk -- load it as a Web File so the router can reuse the
        // existing .md/.zip handlers.
        const buffer = await fs.readFile(absolutePath);
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node path only reachable via dynamic require
        const nodePath: typeof import('path') = require('path');
        const filename = nodePath.basename(absolutePath);
        const fileLike = new File([new Uint8Array(buffer)], filename);
        return await importSkill({
            adapter,
            targetSkillsDir,
            source: detectSourceFromFile(fileLike),
            overwrite,
        });
    }

    private isDuplicate(e: unknown): boolean {
        return e instanceof SkillPackageImportError && e.code === 'DESTINATION_EXISTS'
            || e instanceof SkillFolderImportError && e.code === 'DESTINATION_EXISTS';
    }

    private runHtmlFileImport(
        targetSkillsDir: string,
        adapter: import('obsidian').DataAdapter,
        refreshList: () => Promise<void>,
    ): void {
        const fileInput = createEl('input');
        fileInput.type = 'file';
        fileInput.accept = '.md,.txt,.zip,.skill';
        fileInput.addEventListener('change', () => { void (async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            const doImport = async (overwrite: boolean) => importSkill({
                adapter,
                targetSkillsDir,
                source: detectSourceFromFile(file),
                overwrite,
            });
            try {
                const result = await doImport(false);
                await this.finishImport(result, refreshList);
            } catch (e) {
                if (this.isDuplicate(e)) {
                    const replace = await confirmModal(this.app, {
                        title: t('settings.skills.duplicateTitle'),
                        message: t('settings.skills.duplicateMessageShort'),
                        confirmLabel: t('settings.skills.replaceButton'),
                        destructive: true,
                    });
                    if (!replace) { new Notice(t('settings.skills.importCancelled')); return; }
                    try {
                        const result = await doImport(true);
                        await this.finishImport(result, refreshList);
                    } catch (inner) {
                        new Notice(t('settings.skills.importFailedReason', { reason: this.errorMessage(inner) }), 8000);
                    }
                    return;
                }
                new Notice(t('settings.skills.importFailedReason', { reason: this.errorMessage(e) }), 8000);
            }
        })(); });
        fileInput.click();
    }

    private async finishImport(
        result: Awaited<ReturnType<typeof importSkill>>,
        refreshList: () => Promise<void>,
    ): Promise<void> {
        const loader = this.plugin.selfAuthoredSkillLoader;
        if (loader) await loader.refresh();
        await refreshList();
        const written = result.writtenFiles.length;
        const kindLabel = result.kind === 'zip'
            ? t('settings.skills.importKindZip')
            : result.kind === 'folder'
                ? t('settings.skills.importKindFolder')
                : t('settings.skills.importKindSingleFile');
        new Notice(t('settings.skills.imported', { kind: kindLabel, slug: result.slug, count: written }));
    }

    private errorMessage(e: unknown): string {
        const raw = (e as { message?: unknown })?.message;
        if (typeof raw === 'string') return raw;
        if (typeof e === 'string') return e;
        return t('settings.skills.unknownError');
    }
}

/* eslint-enable -- end of file-level disable for boundary code (SDK/JSON/Obsidian internals) */
