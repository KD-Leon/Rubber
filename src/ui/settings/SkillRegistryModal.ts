/**
 * The skill registry, as a dialog you browse (FEAT-31-01).
 *
 * The registry used to be a search field wired into the Skills tab, which meant
 * you could only find a skill you already knew existed. A catalogue you cannot
 * scroll is not a catalogue. So: one button in Settings opens this window, and
 * the window opens showing everything. Typing narrows it. Browse and search are
 * the same list at two ends of one query, not two modes with a switch.
 *
 * Detail is the same window with a swapped body, not a second modal stacked on
 * the first. That keeps the query and the list behind it alive, so going back
 * lands where you left rather than at the top of a fresh list.
 *
 * Install lives on the detail page only, never on a row. One extra click, and
 * it buys the thing this whole feature is about: you pass the SKILL.md on the
 * way to the install button. A skill is instructions for an agent with access
 * to your vault, and the fastest possible install is not what that deserves.
 *
 * Nothing is fetched before the button is pressed. No catalogue on plugin load,
 * no request the user did not ask for.
 */

import { Modal, Notice, setIcon } from 'obsidian';

import type ObsidianAgentPlugin from '../../main';
import {
    RegistryError,
    isSkillInstalledOnDisk,
    licenseUrl,
    resolveSkillUpdateStatus,
    searchCatalog,
    type RegistrySkill,
    type SkillRegistryClient,
    type SkillUpdateStatus,
} from '../../core/skills/SkillRegistryClient';
import { getSelfAuthoredSkillsDir } from '../../core/utils/agentFolder';
import { t } from '../../i18n';
import { confirmModal } from '../modals/PromptModal';

export class SkillRegistryModal extends Modal {
    private query = '';
    private selected: RegistrySkill | null = null;
    private loading = false;
    private error: string | null = null;

    /** Rebuilt on every keystroke; the search field above it is not. */
    private listEl: HTMLElement | null = null;
    private countEl: HTMLElement | null = null;
    private summaryEl: HTMLElement | null = null;

    /**
     * FEAT-31-04: what each catalogue entry means for the copy in this vault.
     *
     * Empty until the disk has answered, and empty is the honest starting
     * point: a window that has not looked yet must not claim "no update" any
     * more than it may claim "update available" (ASR-02). Every reader below
     * falls back to the two old states when a slug is missing from here.
     */
    private statuses = new Map<string, SkillUpdateStatus>();
    private closed = false;

    constructor(
        private readonly plugin: ObsidianAgentPlugin,
        private readonly client: SkillRegistryClient,
        /** Lets the Skills tab redraw its installed list after an install. */
        private readonly onChanged: () => void,
        /**
         * One-shot deep link: open on this skill's detail page instead of the
         * browse list (used by the Create-skill flow to route straight to
         * skill-creator when it is not installed). Falls back to the list
         * when the catalogue does not carry the slug.
         */
        private initialDetailSlug: string | null = null,
    ) {
        super(plugin.app);
    }

    onOpen(): void {
        this.modalEl.addClass('agent-registry-modal');
        this.setTitle(t('settings.skills.registryDialogTitle'));
        // Fetch on open rather than on plugin start. The user pressed a button
        // that says "browse the registry", so the request is expected here and
        // nowhere else.
        if (this.client.catalog) {
            this.render();
            void this.refreshAndRepaint();
        } else {
            void this.load();
        }
    }

    onClose(): void {
        this.closed = true;
        this.contentEl.empty();
    }

    private async load(): Promise<void> {
        this.loading = true;
        this.error = null;
        this.render();
        try {
            await this.client.fetchCatalog();
        } catch (e) {
            this.error = e instanceof RegistryError ? e.message : String(e);
        }
        this.loading = false;
        this.render();
        // Only after a catalogue actually arrived. A failed fetch leaves the
        // status map untouched, so the window says nothing about updates
        // instead of saying there are none (SC-05).
        if (!this.error) await this.refreshAndRepaint();
    }

    /**
     * Ask the disk where every catalogue entry stands, then repaint.
     *
     * No network: the catalogue is already in hand, so the two requests the
     * window always made are still the only two. Runs after the list is on
     * screen rather than before it, so a slow vault delays the marking and not
     * the window.
     */
    private async refreshStatuses(): Promise<void> {
        const catalog = this.client.catalog;
        const adapter = this.plugin.app?.vault?.adapter;
        if (!catalog) return;
        if (!adapter || typeof adapter.exists !== 'function' || typeof adapter.read !== 'function') {
            // No adapter to ask. Leaving the map empty keeps the window on the
            // two states it can prove rather than inventing a third.
            return;
        }

        const skillsDir = getSelfAuthoredSkillsDir(this.plugin);
        const provenance = this.plugin.skillProvenance ?? null;
        const next = new Map<string, SkillUpdateStatus>();
        for (const skill of catalog.skills) {
            next.set(skill.slug, await resolveSkillUpdateStatus({
                adapter, skillsDir, entry: skill, provenance,
            }));
        }
        if (this.closed) return;
        this.statuses = next;
    }

    private async refreshAndRepaint(): Promise<void> {
        await this.refreshStatuses();
        this.repaint();
    }

    /**
     * Redraw the parts that carry a claim.
     *
     * The browse view is patched rather than rebuilt, because rebuilding it
     * would take the search field with it and the caret with that. The detail
     * view has no field to lose and redraws whole.
     */
    private repaint(): void {
        if (this.closed) return;
        if (this.selected) {
            this.render();
            return;
        }
        this.renderSummary();
        this.renderList();
    }

    // -- Rendering ---------------------------------------------------------

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('agent-registry-modal__body');

        // Resolve the deep link once the catalogue is here; consume it either
        // way so Back from the detail page lands on the list, not in a loop.
        if (this.initialDetailSlug && !this.selected && this.client.catalog) {
            const hit = this.client.catalog.skills.find((s) => s.slug === this.initialDetailSlug);
            this.initialDetailSlug = null;
            if (hit) this.selected = hit;
        }

        if (this.selected) { this.renderDetail(contentEl, this.selected); return; }
        if (this.loading) { this.renderLoading(contentEl); return; }
        if (this.error) { this.renderError(contentEl); return; }
        this.renderBrowse(contentEl);
    }

    private renderLoading(parent: HTMLElement): void {
        const box = parent.createDiv('agent-registry-modal__center');
        setIcon(box.createSpan('agent-registry-modal__spinner'), 'loader');
        box.createSpan({ text: t('settings.skills.registryLoading') });
    }

    private renderError(parent: HTMLElement): void {
        const box = parent.createDiv('agent-registry-modal__center');
        box.createEl('p', { text: this.error ?? '', cls: 'agent-registry-error' });
        const retry = box.createEl('button', { text: t('settings.skills.registryRetry') });
        retry.addEventListener('click', () => void this.load());
    }

    private renderBrowse(parent: HTMLElement): void {
        const catalog = this.client.catalog;
        if (!catalog) return;

        parent.createEl('p', {
            text: t('settings.skills.registryDialogDesc'),
            cls: 'agent-registry-modal__lede',
        });

        // Search row. Built once and left alone: rebuilding the input on every
        // keystroke would take the caret with it.
        const searchRow = parent.createDiv('agent-registry-modal__search');
        setIcon(searchRow.createSpan('agent-registry-modal__search-icon'), 'search');
        const input = searchRow.createEl('input', {
            type: 'text',
            cls: 'agent-registry-modal__input',
            attr: {
                placeholder: t('settings.skills.registrySearchPlaceholder'),
                'aria-label': t('settings.skills.registrySearchPlaceholder'),
            },
        });
        input.value = this.query;
        input.addEventListener('input', () => {
            this.query = input.value;
            this.renderList();
        });

        // Where the catalogue came from and when. A stale catalogue that says
        // so is honest; one that says nothing invites the user to assume it is
        // current.
        const meta = parent.createDiv('agent-registry-modal__meta');
        this.countEl = meta.createSpan();
        const stamp = meta.createSpan({ cls: 'agent-registry-modal__stamp' });
        const refresh = stamp.createEl('button', { cls: 'agent-registry-refresh' });
        setIcon(refresh, 'refresh-cw');
        refresh.setAttribute('aria-label', t('settings.skills.registryRefresh'));
        refresh.addEventListener('click', () => void this.load());
        if (catalog.generatedAt) {
            const date = new Date(catalog.generatedAt);
            if (!Number.isNaN(date.getTime())) {
                stamp.createSpan({
                    text: t('settings.skills.registrySnapshot', { date: date.toLocaleDateString() }),
                });
            }
        }

        // FEAT-31-04: the one line that answers "is anything waiting for me"
        // without a click. Above the list, because that is where the eye lands
        // before it starts scanning rows. The host is a bare, classless div so
        // that a window with nothing to report reserves no space and paints no
        // margin -- the line itself is created only when there is one to write.
        this.summaryEl = parent.createDiv();
        this.renderSummary();

        this.listEl = parent.createDiv('agent-registry-modal__list');
        this.renderList();
    }

    /**
     * Say how many installed skills have a newer version published, and how
     * many could not be compared at all.
     *
     * Silent while the status map is empty, which covers both "not looked yet"
     * and "the catalogue never arrived". Silent is the correct output there:
     * "everything is up to date" is a claim, and we have nothing to back it.
     *
     * The same rule decides the second line. `unknown` sits inside the
     * installed set -- an installed copy whose version is missing or unreadable
     * -- and counting it as current turns ASR-02's "no statement" into the one
     * statement it forbids: a skill with a published correction waiting would
     * be covered by the words "everything is up to date". So the up-to-date
     * line is only written when every installed entry actually compared, and
     * the unchecked ones are named rather than passed over. Named, not
     * swallowed, because silence here is indistinguishable from a window that
     * has not looked yet, while a count tells the user there is something to
     * go and check and why the window cannot check it for them.
     */
    private renderSummary(): void {
        const host = this.summaryEl;
        if (!host) return;
        host.empty();
        const installed = [...this.statuses.values()].filter((s) => s.state !== 'not-installed');
        if (installed.length === 0) return;

        const updates = installed.filter((s) => s.state === 'update-available').length;
        const unchecked = installed.filter((s) => s.state === 'unknown').length;

        if (updates > 0) {
            host.createDiv({
                cls: 'agent-registry-modal__summary agent-registry-status'
                    + ' agent-registry-modal__summary--action',
                text: updates === 1
                    ? t('settings.skills.registryUpdateSummaryOne')
                    : t('settings.skills.registryUpdateSummary', { count: updates }),
            });
        } else if (unchecked === 0) {
            host.createDiv({
                cls: 'agent-registry-modal__summary agent-registry-status',
                text: t('settings.skills.registryUpToDateSummary'),
            });
        }

        // Printed whether or not an update was found: an update line that
        // mentions two skills still leaves the reader assuming the rest are
        // fine, and one of them may be a skill nobody could compare.
        if (unchecked > 0) {
            host.createDiv({
                cls: 'agent-registry-modal__summary agent-registry-status',
                text: unchecked === 1
                    ? t('settings.skills.registryUncheckedSummaryOne')
                    : t('settings.skills.registryUncheckedSummary', { count: unchecked }),
            });
        }
    }

    private renderList(): void {
        const listEl = this.listEl;
        const catalog = this.client.catalog;
        if (!listEl || !catalog) return;
        listEl.empty();

        // An empty query means "show me everything". Inside a window whose only
        // job is the registry there is nothing else on screen to bury, so the
        // browsable full list is the right default and the search narrows from
        // there.
        const hits = searchCatalog(catalog.skills, this.query);

        if (this.countEl) {
            this.countEl.setText(hits.length === 1
                ? t('settings.skills.registryCountOne')
                : t('settings.skills.registryCount', { count: hits.length }));
        }

        if (hits.length === 0) {
            listEl.createEl('p', {
                cls: 'agent-registry-status',
                text: catalog.skills.length === 0
                    ? t('settings.skills.registryEmpty')
                    : t('settings.skills.registryNoHits'),
            });
            return;
        }

        const installed = this.installedSlugs();
        for (const skill of hits) this.renderRow(listEl, skill, installed.has(skill.slug));
    }

    /**
     * Is this slug on the disk right now? Falls back to the caller's
     * loader-based flag when there is no adapter to ask (tests, and any host
     * that hands us a stripped app object).
     */
    private async installedOnDisk(slug: string, fallback: boolean): Promise<boolean> {
        const adapter = this.plugin.app?.vault?.adapter;
        if (!adapter || typeof adapter.exists !== 'function') return fallback;
        return isSkillInstalledOnDisk(adapter, getSelfAuthoredSkillsDir(this.plugin), slug);
    }

    /**
     * The state chip for one catalogue entry, in one place so the row and the
     * detail page cannot drift apart.
     *
     * Precedence when a copy is both outdated and changed: the update is named
     * first, because it is the actionable half, and the change is named beside
     * it, because it is what the user stands to lose. Neither is dropped.
     */
    private renderChips(parent: HTMLElement, skill: RegistrySkill, installedFallback: boolean): string[] {
        const said: string[] = [];
        const chip = (text: string, mod: string): void => {
            parent.createSpan({ text, cls: `agent-registry-chip agent-registry-chip--${mod}` });
            said.push(text);
        };
        const status = this.statuses.get(skill.slug);
        if (!status) {
            // Nothing verified yet: the two states the window always had.
            chip(installedFallback
                ? t('settings.skills.registryInstalled')
                : t('settings.skills.registryNotInstalled'), installedFallback ? 'in' : 'out');
            return said;
        }
        if (status.state === 'not-installed') {
            chip(t('settings.skills.registryNotInstalled'), 'out');
            return said;
        }
        if (status.state === 'update-available') {
            chip(t('settings.skills.registryUpdateAvailable'), 'update');
        } else {
            chip(t('settings.skills.registryInstalled'), 'in');
        }
        if (status.locallyChanged === true) {
            chip(t('settings.skills.registryChangedLocally'), 'changed');
        }
        return said;
    }

    /** Slugs already in the vault, so a row can say where it stands. */
    private installedSlugs(): Set<string> {
        const loader = this.plugin.selfAuthoredSkillLoader;
        if (!loader) return new Set();
        return new Set(loader.getAllSkills().map((s) => s.name));
    }

    /**
     * One catalogue entry. The whole row is the click target and it leads to
     * the detail page -- there is deliberately no install button here.
     *
     * A div rather than a button, for two reasons that turned out to be the
     * same reason. Obsidian gives every `button` a fixed `--input-height`, so a
     * row of stacked lines overflowed its own box and printed itself across the
     * row above. And a button may only contain phrasing content anyway, which a
     * name-over-description-over-tags stack is not. Keyboard activation is
     * wired up by hand below, since leaving the element is what costs it.
     */
    private renderRow(parent: HTMLElement, skill: RegistrySkill, installed: boolean): void {
        const row = parent.createDiv('agent-registry-row');
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        const open = () => { this.selected = skill; this.render(); };
        row.addEventListener('click', open);
        row.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            ev.preventDefault();
            open();
        });

        const main = row.createDiv('agent-registry-row__main');
        const head = main.createDiv('agent-registry-row__head');
        head.createSpan({ text: skill.name, cls: 'agent-registry-row__name' });
        // The aria-label replaces the row's own text for a screen reader, so
        // the chips have to be repeated into it. A marking nobody can hear is
        // half a marking.
        const chips = this.renderChips(head, skill, installed);
        row.setAttribute(
            'aria-label',
            `${skill.name}, ${chips.join(', ')}: ${t('settings.skills.detailOpen')}`,
        );

        main.createDiv({ text: skill.description, cls: 'agent-registry-row__desc' });

        const tags = main.createDiv('agent-registry-row__tags');
        for (const c of skill.components) {
            tags.createSpan({ text: c, cls: 'agent-registry-tag' });
        }
        tags.createSpan({
            text: `${Math.max(1, Math.round(skill.bytes / 1024))} KB`,
            cls: 'agent-registry-row__size',
        });

        setIcon(row.createSpan('agent-registry-row__chevron'), 'chevron-right');
    }

    // -- Detail ------------------------------------------------------------

    private renderDetail(parent: HTMLElement, skill: RegistrySkill): void {
        const installed = this.installedSlugs().has(skill.slug);

        const back = parent.createEl('button', { cls: 'agent-registry-back' });
        setIcon(back.createSpan(), 'chevron-left');
        back.createSpan({ text: t('settings.skills.registryBack') });
        back.addEventListener('click', () => { this.selected = null; this.render(); });

        // Everything below the back link scrolls as one block. Without a
        // designated scroller here the expanded SKILL.md would push the facts,
        // the trust note and the install button off the bottom of the window,
        // where the browse view is saved by its list being the scroller.
        const body = parent.createDiv('agent-registry-detail');

        const head = body.createDiv('agent-skill-detail__head');
        head.createEl('h3', { text: skill.name });
        this.renderChips(head, skill, installed);

        body.createEl('p', { text: skill.description, cls: 'agent-skill-detail__desc' });

        const facts = body.createDiv('agent-skill-detail__facts');
        this.fact(facts, t('settings.skills.detailComponents'), skill.components.join(', '));
        this.fact(facts, t('settings.skills.detailVersion'), skill.version);
        // FEAT-31-04: the catalogue version alone says nothing. Printed next to
        // what is actually in the vault, the same number becomes a comparison
        // the user can check for themselves.
        const status = this.statuses.get(skill.slug);
        if (status && status.installedVersion !== null) {
            this.fact(facts, t('settings.skills.detailInstalledVersion'), status.installedVersion);
        }
        this.fact(facts, t('settings.skills.detailSize'),
            `${Math.max(1, Math.round(skill.bytes / 1024))} KB`);
        // The `trigger` field is bilingual keyword/regex matching data, kept on
        // RegistrySkill so searchCatalog still matches German queries. It is
        // deliberately NOT surfaced here: raw regex fragments in mixed languages
        // read as slop, and a browsing user has no use for internal match rules.
        // A link, not a label. The install dialog asks the user to accept this
        // licence, and a name they cannot open is not something anyone can
        // meaningfully accept.
        const licenceRow = facts.createDiv('agent-skill-detail__fact');
        licenceRow.createSpan({
            text: t('settings.skills.detailLicense'),
            cls: 'agent-skill-detail__fact-label',
        });
        licenceRow.createEl('a', {
            text: skill.license,
            attr: { href: licenseUrl(skill.license), target: '_blank', rel: 'noopener' },
        });

        body.createEl('p', {
            text: t('settings.skills.registryTrustNote'),
            cls: 'agent-registry-status',
        });

        const actions = body.createDiv('agent-registry-detail__actions');
        const hasUpdate = status?.state === 'update-available';
        const install = actions.createEl('button', {
            text: hasUpdate
                ? t('settings.skills.registryUpdate')
                : installed
                    ? t('settings.skills.registryReinstall')
                    : t('settings.skills.registryInstall'),
            // An update is the thing to do on this page, so it gets the accent
            // a reinstall deliberately does not.
            cls: hasUpdate || !installed ? 'mod-cta' : '',
        });
        install.addEventListener('click', () => void this.install(skill, installed));

        const sourceBox = body.createDiv('agent-skill-detail__source');
        const view = actions.createEl('button', { text: t('settings.skills.detailViewSource') });
        view.addEventListener('click', () => void this.toggleSource(skill, sourceBox, view));
    }

    private fact(parent: HTMLElement, label: string, value: string): void {
        const row = parent.createDiv('agent-skill-detail__fact');
        row.createSpan({ text: label, cls: 'agent-skill-detail__fact-label' });
        row.createSpan({ text: value });
    }

    /**
     * Fetch and show the SKILL.md, or hide it again.
     *
     * Loaded lazily, and through the same size and checksum verification an
     * install goes through -- a package we would refuse to install is one we
     * should also refuse to quote from.
     */
    private async toggleSource(
        skill: RegistrySkill,
        box: HTMLElement,
        button: HTMLButtonElement,
    ): Promise<void> {
        if (box.childElementCount > 0) {
            box.empty();
            button.setText(t('settings.skills.detailViewSource'));
            return;
        }

        const loading = box.createDiv('agent-skill-detail__loading');
        setIcon(loading.createSpan('agent-registry-modal__spinner'), 'loader');
        loading.createSpan({ text: t('settings.skills.detailLoadingSource') });

        try {
            const md = await this.client.previewSkillMd(skill);
            box.empty();
            // Read-only on purpose: this is source under inspection. A <pre>
            // keeps the frontmatter and indentation intact and renders nothing.
            box.createEl('pre', { text: md, cls: 'agent-skill-detail__pre' });
            button.setText(t('settings.skills.detailHideSource'));
        } catch (e) {
            box.empty();
            box.createEl('p', {
                text: e instanceof RegistryError ? e.message : String(e),
                cls: 'agent-registry-error',
            });
        }
    }

    /**
     * Install one skill.
     *
     * The confirmation is where the licence is accepted and the user takes on
     * what they are about to let the agent run. A reinstall asks a sharper
     * question, because it overwrites local edits and an edited skill is one
     * somebody changed on purpose.
     */
    private async install(skill: RegistrySkill, installed: boolean): Promise<void> {
        // FIX-31-01-03: the chip on the row comes from the loader in memory,
        // which is only as fresh as the last reload. What gets overwritten is
        // on the disk, so the disk is asked here, right before the write. The
        // caller's `installed` stays the label; this is the decision.
        const onDisk = await this.installedOnDisk(skill.slug, installed);
        // FEAT-31-04: and for the same reason, the state is re-read here rather
        // than taken from the last repaint. What the dialog promises about the
        // user's own edits has to be true of the file that is about to be
        // replaced, not of the one the window drew a minute ago.
        const status = await this.currentStatus(skill);
        const changed = status?.locallyChanged === true;
        const isUpdate = status?.state === 'update-available';

        const ok = await confirmModal(this.plugin.app, {
            title: isUpdate
                ? t('settings.skills.registryUpdateTitle', { name: skill.name })
                : t('settings.skills.registryConfirmTitle', { name: skill.name }),
            // Three messages for three situations. The sharpest one is for the
            // copy we cannot confirm as the published version: that is the case
            // where pressing this button destroys work (SC-04).
            message: changed
                ? t('settings.skills.registryConfirmChanged', { license: skill.license })
                : onDisk
                    ? t('settings.skills.registryConfirmOverwrite', { license: skill.license })
                    : t('settings.skills.registryConfirmBody', { license: skill.license }),
            confirmLabel: isUpdate
                ? t('settings.skills.registryUpdate')
                : t('settings.skills.registryInstall'),
            link: {
                label: t('settings.skills.registryReadLicense', { license: skill.license }),
                url: licenseUrl(skill.license),
            },
        });
        // ASR-03: nothing is downloaded, written or replaced without this.
        if (!ok) return;

        try {
            const slug = await this.client.install(skill, { overwrite: onDisk });
            new Notice(t('settings.skills.registryInstalled_notice', { name: slug }));
            // ASR-04: install() re-stamps provenance over the bytes that just
            // landed, and the loader is reloaded here. Skip either and the skill
            // counts as changed from now on while the agent keeps running the
            // version it had in memory.
            await this.plugin.selfAuthoredSkillLoader?.refresh();
            this.onChanged();
            // Stay on the detail page and redraw it, so the state chip flips to
            // "Installed" under the user's eyes instead of the window vanishing
            // and leaving them to go and check. The status is recomputed first,
            // so the marking reflects what is now on disk rather than what was.
            await this.refreshStatuses();
            this.render();
        } catch (e) {
            new Notice(e instanceof RegistryError ? e.message : String(e), 8000);
        }
    }

    /**
     * The status of one skill, read fresh when there is a disk to read.
     *
     * Falls back to the last repaint, and to nothing at all when neither exists
     * -- in which case the caller keeps the wording it used before this feature,
     * which claims nothing about versions or edits.
     */
    private async currentStatus(skill: RegistrySkill): Promise<SkillUpdateStatus | null> {
        const adapter = this.plugin.app?.vault?.adapter;
        if (!adapter || typeof adapter.exists !== 'function' || typeof adapter.read !== 'function') {
            return this.statuses.get(skill.slug) ?? null;
        }
        const status = await resolveSkillUpdateStatus({
            adapter,
            skillsDir: getSelfAuthoredSkillsDir(this.plugin),
            entry: skill,
            provenance: this.plugin.skillProvenance ?? null,
        });
        this.statuses.set(skill.slug, status);
        return status;
    }
}
