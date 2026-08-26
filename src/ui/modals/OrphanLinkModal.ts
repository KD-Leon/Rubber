/**
 * OrphanLinkModal -- FIX-19-01-12.
 *
 * Ersetzt den geloeschten Orphan-"Auto-fix", der Notes nur nach
 * Inbox/Orphans verschob, ohne einen einzigen eingehenden Link zu
 * erzeugen (die Note blieb damit per Definition ein Orphan).
 *
 * Der Flow hier schlaegt pro isolierter Note die semantisch naechsten
 * Notes als Verknuepfungs-Quelle vor. Bestaetigt der Nutzer, wird der
 * Wikilink EINSEITIG in die Kandidaten-Note geschrieben -- nur diese
 * Richtung erzeugt einen eingehenden Link und beendet den Orphan-Status.
 *
 * Eine Zeile pro Orphan (nicht pro Paar): fachlich reicht genau ein
 * eingehender Link, und bei vielen Orphans bliebe eine Paar-Liste
 * unbedienbar. Die Auswahl des Kandidaten passiert im Dropdown der Zeile.
 */

import { App, Modal, Notice, setIcon } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import type { OrphanLinkProposal } from '../../core/knowledge/VaultHealthService';
import { t } from '../../i18n';
import { OKF_DEFAULTS } from '../../types/settings';

interface RowState {
    proposal: OrphanLinkProposal;
    /** Index in proposal.candidates. */
    selected: number;
    /** Checkbox: soll fuer diese Note ein Link geschrieben werden? */
    accepted: boolean;
}

export interface OrphanLinkModalOptions {
    /** Laeuft nach einem erfolgreichen Schreibvorgang (Findings neu laden). */
    onLinked: () => void;
}

export class OrphanLinkModal extends Modal {
    private rows: RowState[];
    private running = false;

    constructor(
        app: App,
        private readonly plugin: ObsidianAgentPlugin,
        proposals: OrphanLinkProposal[],
        private readonly opts: OrphanLinkModalOptions,
    ) {
        super(app);
        this.rows = proposals.map((p) => ({
            proposal: p,
            selected: 0,
            // Ohne Kandidat gibt es nichts zu bestaetigen.
            accepted: p.candidates.length > 0,
        }));
    }

    private get actionableCount(): number {
        return this.rows.filter((r) => r.accepted && r.proposal.candidates.length > 0).length;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('vault-health-orphan-link');
        contentEl.createEl('h3', { text: t('modal.vaultHealthRepair.orphanLinkTitle') });
        contentEl.createDiv({
            cls: 'setting-item-description',
            text: t('modal.vaultHealthRepair.orphanLinkIntro'),
        });

        const withCandidates = this.rows.filter((r) => r.proposal.candidates.length > 0);
        if (withCandidates.length === 0) {
            contentEl.createDiv({
                cls: 'vault-health-orphan-empty',
                text: t('modal.vaultHealthRepair.orphanNoCandidatesAtAll'),
            });
            this.renderFooter(contentEl);
            return;
        }

        const toggleBar = contentEl.createDiv({ cls: 'vault-health-orphan-togglebar' });
        const toggleAll = toggleBar.createEl('button', {
            text: t('modal.vaultHealthRepair.orphanToggleAll'),
        });
        toggleAll.addEventListener('click', () => {
            const target = this.actionableCount === 0;
            for (const r of this.rows) {
                if (r.proposal.candidates.length > 0) r.accepted = target;
            }
            this.onOpen();
        });

        const list = contentEl.createDiv({ cls: 'vault-health-orphan-list' });
        for (const row of this.rows) {
            this.renderRow(list, row);
        }
        this.renderFooter(contentEl);
    }

    private renderRow(parent: HTMLElement, row: RowState): void {
        const el = parent.createDiv({ cls: 'vault-health-orphan-row' });
        const hasCandidates = row.proposal.candidates.length > 0;

        const cb = el.createEl('input', { type: 'checkbox' });
        cb.checked = row.accepted && hasCandidates;
        cb.disabled = !hasCandidates;
        cb.addEventListener('change', () => {
            row.accepted = cb.checked;
            this.updateFooterLabel();
        });

        const main = el.createDiv({ cls: 'vault-health-orphan-main' });
        main.createDiv({
            cls: 'vault-health-orphan-path',
            text: this.basename(row.proposal.orphanPath),
        });

        if (!hasCandidates) {
            main.createDiv({
                cls: 'vault-health-orphan-nocand',
                text: t('modal.vaultHealthRepair.orphanNoCandidate'),
            });
            return;
        }

        const select = main.createEl('select', { cls: 'vault-health-orphan-select' });
        row.proposal.candidates.forEach((c, i) => {
            const opt = select.createEl('option', {
                value: String(i),
                text: t('modal.vaultHealthRepair.orphanCandidateOption', {
                    path: this.basename(c.path),
                    score: c.similarity.toFixed(2),
                }),
            });
            if (i === row.selected) opt.selected = true;
        });
        select.addEventListener('change', () => {
            row.selected = Number.parseInt(select.value, 10) || 0;
            preview.setText(this.previewText(row));
        });

        const preview = main.createDiv({ cls: 'vault-health-fix-preview' });
        preview.setText(this.previewText(row));
    }

    private previewText(row: RowState): string {
        const cand = row.proposal.candidates[row.selected];
        if (!cand) return t('modal.vaultHealthRepair.orphanNoCandidate');
        return t('modal.vaultHealthRepair.orphanLinkPreview', {
            source: this.basename(cand.path),
            target: this.basename(row.proposal.orphanPath),
        });
    }

    private footerBtn: HTMLButtonElement | null = null;

    private renderFooter(parent: HTMLElement): void {
        const footer = parent.createDiv({ cls: 'vault-health-orphan-footer' });
        const cancel = footer.createEl('button', { text: t('modal.vaultHealthRepair.orphanCancel') });
        cancel.addEventListener('click', () => this.close());

        const apply = footer.createEl('button', { cls: 'mod-cta' });
        this.footerBtn = apply;
        this.updateFooterLabel();
        apply.addEventListener('click', () => { void this.apply(); });
    }

    private updateFooterLabel(): void {
        if (!this.footerBtn) return;
        const n = this.actionableCount;
        this.footerBtn.setText(t('modal.vaultHealthRepair.orphanApply', { count: n }));
        this.footerBtn.disabled = n === 0 || this.running;
    }

    private async apply(): Promise<void> {
        if (this.running) return;
        const service = this.plugin.vaultHealthService;
        if (!service) return;
        const pairs = this.rows
            .filter((r) => r.accepted && r.proposal.candidates.length > 0)
            .map((r) => ({
                orphan: r.proposal.orphanPath,
                candidate: r.proposal.candidates[r.selected].path,
            }));
        if (pairs.length === 0) return;

        this.running = true;
        this.updateFooterLabel();
        const { contentEl } = this;
        contentEl.empty();
        const progress = contentEl.createEl('p', { cls: 'vault-health-progress' });
        progress.setText(t('modal.vaultHealthRepair.orphanProgressCheckpoint'));

        // Checkpoint ueber die Dateien, die WIRKLICH geschrieben werden: das
        // sind die Kandidaten-Notes, nicht die Orphans. Der Sammel-Repair
        // sammelt stattdessen finding.paths -- daran haette der Undo-Button
        // vorbeigegriffen.
        // SEC M-2: der Checkpoint fasst hoechstens CHECKPOINT_CAP Pfade. Frueher
        // wurde nur die Snapshot-Liste gekappt und trotzdem alles geschrieben,
        // womit der Ueberhang ausserhalb jeder Rueckroll-Moeglichkeit lag. Statt
        // still mehr zu schreiben als gesichert ist, wird der Batch begrenzt.
        const CHECKPOINT_CAP = 500;
        let effectivePairs = pairs;
        let deferred = 0;
        const uniqueCandidates = [...new Set(pairs.map((p) => p.candidate))];
        if (uniqueCandidates.length > CHECKPOINT_CAP) {
            const covered = new Set(uniqueCandidates.slice(0, CHECKPOINT_CAP));
            effectivePairs = pairs.filter((p) => covered.has(p.candidate));
            deferred = pairs.length - effectivePairs.length;
        }
        const writtenPaths = [...new Set(effectivePairs.map((p) => p.candidate))];
        try {
            if (this.plugin.checkpointService && writtenPaths.length > 0) {
                await this.plugin.checkpointService.snapshot(
                    `orphan-link-${Date.now()}`,
                    writtenPaths,
                    'vault_health_orphan_link',
                );
            }
        } catch (e) {
            console.warn('[OrphanLink] Checkpoint failed (non-fatal):', e);
        }

        // Denselben Listener-Suspend nutzen wie der Repair: sonst ueberschreibt
        // der globale modify-Listener die frischen Edges mit stale Cache.
        // SEC L-1: der Flag ist ein globaler Mutex, den jetzt zwei Modals setzen.
        // Ein verschachteltes Ende wuerde den Schutz vorzeitig aufheben, also
        // wird der vorherige Zustand gemerkt statt hart auf false zurueckgesetzt.
        const hadRepairFlag = this.plugin.vaultHealthRepairInProgress;
        this.plugin.vaultHealthRepairInProgress = true;
        try {
            progress.setText(t('modal.vaultHealthRepair.orphanProgressLinking'));
            const backlinksProperty = this.resolveBacklinksProperty();
            let res = { orphansLinked: 0, linksAdded: 0, failedPaths: [] as string[] };
            // ADR-166: dieselbe Sequenz wie der Sammel-Repair. Vorher lief
            // extractAll SOFORT nach dem Write gegen den stalen Cache (der
            // latente Race aus der Analyse, dort REFUTED als Vorfalls-
            // Ursache, aber real).
            progress.setText(t('modal.vaultHealthRepair.orphanProgressVerifying'));
            await service.applyAndVerify(
                writtenPaths,
                async () => {
                    res = await service.linkOrphansFromCandidates(
                        effectivePairs,
                        backlinksProperty,
                        this.plugin.settings.vaultHealth?.orphanExcludePathPrefixes ?? [],
                    );
                },
                () => [],
                { reparseTimeoutMs: 8000 },
            );
            new Notice(t('notice.vaultHealth.orphansLinked', {
                count: res.orphansLinked,
                links: res.linksAdded,
            }), 6000);
            if (deferred > 0) {
                // Kein stiller Verzicht: der Nutzer erfaehrt, dass ein Rest offen
                // blieb, und kann den Flow danach erneut aufrufen.
                new Notice(t('notice.vaultHealth.orphanLinkDeferred', { count: deferred }), 8000);
            }
            if (res.failedPaths.length > 0) {
                console.warn('[OrphanLink] failed paths:', res.failedPaths);
            }
        } catch (e) {
            console.error('[OrphanLink] linking failed:', e);
            new Notice(t('notice.vaultHealth.orphanLinkFailed', {
                error: e instanceof Error ? e.message : String(e),
            }), 8000);
        } finally {
            this.plugin.vaultHealthRepairInProgress = hadRepairFlag;
            this.running = false;
        }

        this.close();
        this.opts.onLinked();
    }

    /**
     * Exakt derselbe Aufloesungspfad wie der Sammel-Repair
     * (VaultHealthRepairModal.doRepair), damit beide Wege in dieselbe
     * Property schreiben und der Orphan-Check den Link danach sieht.
     */
    private resolveBacklinksProperty(): string {
        return this.plugin.settings.backlinksProperty ?? OKF_DEFAULTS.backlinksProperty;
    }

    private basename(p: string): string {
        const seg = p.split('/').pop() ?? p;
        return seg.replace(/\.md$/, '');
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/** Icon-Helfer fuer den Aufrufer (Findings-Zeile). */
export function setOrphanLinkIcon(el: HTMLElement): void {
    setIcon(el, 'link');
}
