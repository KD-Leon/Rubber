/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/unbound-method -- File-level disable: interacts with external SDK / JSON / Obsidian internals where untyped 'any' values are unavoidable. Inputs are validated at boundaries via type guards or schema checks where security-relevant. */
/**
 * VaultHealthRepairModal -- Findings view with selective repair, discuss, and skip.
 *
 * Shows each finding with checkboxes (repairable), discuss (all), and skip (all).
 * Discuss opens a new agent chat. Skip persists the dismissal in KnowledgeDB.
 *
 * FEATURE-1901: Vault Health Check
 * FIX-15: Detailed findings + selective repair
 */

import { Modal, Notice, setIcon, setTooltip, Platform, TFile, getLanguage, Setting } from 'obsidian';
import { t } from '../../i18n';
import type ObsidianAgentPlugin from '../../main';
import { generateShortId } from '../../core/utils/generateShortId';
import type { HealthFinding, HealthCheckType } from '../../core/knowledge/VaultHealthService';
import type { CheckpointInfo } from '../../core/checkpoints/GitCheckpointService';
import { OrphanLinkModal } from './OrphanLinkModal';
import { KnowledgeReviewReader, type ReviewRow } from '../../core/health/KnowledgeReviewReader';
import type { VerdictLiteral } from '../../core/health/types';
import { OKF_DEFAULTS } from '../../types/settings';
import { BatchResolveModal } from './BatchResolveModal';
import { buildHealthCheckOptions, dismissKeyPathFor, WEAK_CLUSTER_BATCH_LIMIT } from '../../core/knowledge/VaultHealthService';
import { knowledgeReviewEmptyInfo } from '../../core/health/knowledgeReviewGates';
import {
    buildRepairPlan,
    summarizePlan,
    capPlanForCheckpoint,
    computeOutcomes,
    type RepairPlanEntry,
    type RepairOutcomeEntry,
    PAIR_KEY_SEPARATOR,
} from '../../core/knowledge/vaultHealthRepairPlan';

/**
 * Display-only labels for the verdict literals. Storage and code
 * still use the canonical English literal (matches, extends, ...);
 * this map is the user-facing surface only.
 */
const VERDICT_LABELS: Record<VerdictLiteral, string> = {
    matches: t('modal.resolveConflict.verdictMatches'),
    extends: t('modal.resolveConflict.verdictExtends'),
    contradicts: t('modal.resolveConflict.verdictContradicts'),
    outdated: t('modal.resolveConflict.verdictOutdated'),
    no_external_source: t('modal.resolveConflict.verdictNoExternalSource'),
};

/**
 * Cluster-level finding types that belong in the Knowledge review
 * tab (not Findings). Cluster freshness is the Karpathy-Lint score
 * over note groups; it is semantically the same family as the
 * note-level verifier flags.
 */
const KNOWLEDGE_REVIEW_CHECKS = new Set<HealthCheckType>(['cluster_freshness']);

/**
 * FIX-19-05-04: relative Zeitangabe ("2 minutes ago") ueber die native
 * Intl.RelativeTimeFormat -- folgt der aktiven UI-Sprache ohne eigene
 * Uebersetzungstabelle. Reine Funktion (now injiziert), damit testbar.
 */
/**
 * FIX-19-05-05: Confidence als Wort statt "0.00". Eine nackte Zahl sagt dem
 * Nutzer nichts; drei Buckets (uncertain / fairly sure / confident) sind
 * lesbar. Der interne verifierTier ("mid"/"frontier") gehoert nicht in die
 * sichtbare UI (interne ID -- Memory-Regel).
 */
export function confidenceWord(confidence: number): string {
    if (confidence < 0.34) return t('modal.vaultHealthRepair.confidenceUncertain');
    if (confidence < 0.67) return t('modal.vaultHealthRepair.confidenceFairly');
    return t('modal.vaultHealthRepair.confidenceConfident');
}

/**
 * FIX-19-05-05: zielorientierter Chat-Prompt fuer den Review-Fix. Ziel voran,
 * dann der Kontext, jargonfrei (kein "freshness verifier flagged"). Speist den
 * "Fix with agent"-Knopf jeder Zeile.
 */
export function buildReviewChatPrompt(row: { path: string; verdict: string; summary: string; sources: string[] }): string {
    const sources = row.sources.length
        ? `\n\nSources the automatic check looked at:\n${row.sources.map((s) => `- ${s}`).join('\n')}`
        : '';
    const note = row.summary ? `\n\nWhat the automatic check noted: ${row.summary}` : '';
    return t('modal.vaultHealthRepair.reviewChatPrompt', { path: row.path }) + note + sources;
}

export function formatRelativeTime(then: number, now: number): string {
    const deltaSec = Math.round((then - now) / 1000); // negativ = Vergangenheit
    const rtf = new Intl.RelativeTimeFormat(getLanguage(), { numeric: 'auto' });
    const abs = Math.abs(deltaSec);
    if (abs < 60) return rtf.format(Math.round(deltaSec), 'second');
    if (abs < 3600) return rtf.format(Math.round(deltaSec / 60), 'minute');
    if (abs < 86_400) return rtf.format(Math.round(deltaSec / 3600), 'hour');
    return rtf.format(Math.round(deltaSec / 86_400), 'day');
}

/**
 * Map the verifier's `ReviewSeverity` (critical/moderate/info/ok)
 * onto the `HealthFinding` severity scale (high/medium/low) so the
 * Knowledge review tab shares the same severity-pill UI and CSS
 * classes as the Findings tab.
 */
function reviewSeverityToFindingSeverity(
    s: import('../../core/health/KnowledgeReviewReader').ReviewSeverity,
): 'high' | 'medium' | 'low' {
    switch (s) {
        case 'critical':
            return 'high';
        case 'moderate':
            return 'medium';
        case 'info':
            return 'low';
        case 'ok':
            return 'low';
        default:
            return 'low';
    }
}

// IMP-19-01-02 + FIX-19-01-04: auto-fix scope.
// - missing_backlinks, category_mismatch, weak_clusters: deterministic fixes.
// - orphans: REMOVED from the auto-fix scope (FIX-19-01-12).
//   The former repair moved isolated orphans to Inbox/Orphans/. An orphan
//   is defined as "note without INCOMING links"; relocating the file does
//   not change a single incoming link, so the note stayed an orphan and the
//   very next check re-reported it (user-observed: the candidate count never
//   dropped, while 145 notes had silently been relocated). A no-op that
//   moves user data is worse than no fix at all. A real repair has to CREATE
//   an incoming link; that lands as the linking flow (see FEAT-19-32) and
//   re-enables this entry then.
// - inconsistent_tags: NO fixInconsistentTags method exists; the
//   finding is a manual-review hint ("consider unifying"). Removed
//   from the auto-fix scope until a real implementation lands.
// - broken_links + god_nodes: manual decisions.
const REPAIRABLE_CHECKS = new Set<HealthCheckType>([
    'missing_backlinks', 'category_mismatch',
    'weak_clusters',
]);

/**
 * FIX-19-01-04: per-finding repairable filter. Use this instead of
 * `REPAIRABLE_CHECKS.has(f.check)` whenever the auto-fix selects findings;
 * the legacy check-type set is still useful for "could this category
 * produce repairable findings" decisions.
 *
 * FIX-19-01-12: orphans are no longer repairable at all (see above), so the
 * former orphanKind === 'isolated' split is gone. The guard below keeps the
 * intent explicit and fails closed if 'orphans' is ever re-added to
 * REPAIRABLE_CHECKS without a real linking repair behind it.
 */
/**
 * FIX-19-02-11: stabile Identitaet eines Befunds ueber Renders hinweg.
 * Nutzt denselben kanonischen Pfad-Key wie Dismiss und Persistenz, damit
 * sich nicht ein dritter Begriff von "derselbe Befund" einschleicht.
 */
function findingKey(f: HealthFinding): string {
    return `${f.check}::${dismissKeyPathFor(f)}`;
}

function isRepairableFinding(f: HealthFinding): boolean {
    if (f.check === 'orphans') return false;
    return REPAIRABLE_CHECKS.has(f.check);
}

const CHECK_LABELS: Record<string, string> = {
    orphans: t('modal.vaultHealthRepair.checkOrphans'),
    missing_backlinks: t('modal.vaultHealth.checkMissingBacklinks'),
    broken_links: t('modal.vaultHealth.checkBrokenLinks'),
    weak_clusters: t('modal.vaultHealthRepair.checkWeakClusters'),
    inconsistent_tags: t('modal.vaultHealth.checkInconsistentTags'),
    category_mismatch: t('modal.vaultHealthRepair.checkCategoryMismatch'),
    god_nodes: t('modal.vaultHealth.checkGodNodes'),
    cluster_freshness: t('modal.vaultHealthRepair.checkClusterFreshness'),
    source_concentration: t('modal.vaultHealthRepair.checkSourceConcentration'),
};

type SeverityFilter = 'all' | 'high' | 'medium' | 'low';
type TopTab = 'findings' | 'review';

export class VaultHealthRepairModal extends Modal {
    private plugin: ObsidianAgentPlugin;
    private findings: HealthFinding[];
    private selectedFindings = new Set<number>();

    /**
     * FIX-19-02-11: bewusst abgewaehlte Befunde, nach Identitaet statt nach
     * Listenindex. Ueberlebt jedes Neuzeichnen (Filterwechsel, Dismiss,
     * Tab-Wechsel); der Index tut das nicht.
     */
    private deselectedFindings = new Set<string>();

    /**
     * FIX-19-02-25: die Zahl, die in der Plan-Freigabe stand. Damit der
     * Ergebnis-Screen gegen denselben Nenner berichten kann statt gegen
     * einen vierten.
     */
    private lastPlannedChangeCount = 0;
    private onDiscuss?: (prompt: string) => void;
    /** FEAT-19-18: severity filter pill (all/high/medium/low). Default 'all'. */
    private severityFilter: SeverityFilter = 'all';
    /** IMP-20-06-01 Wave 3: top-level view switch between findings and the Knowledge-review tab. */
    private topTab: TopTab = 'findings';

    constructor(
        plugin: ObsidianAgentPlugin,
        findings: HealthFinding[],
        onDiscuss?: (prompt: string) => void,
    ) {
        super(plugin.app);
        this.plugin = plugin;
        this.findings = findings;
        this.onDiscuss = onDiscuss;
    }

    onOpen(): void {
        this.modalEl.addClass('mod-vault-health-modal');
        this.render();
    }

    private render(): void {
        if (this.topTab === 'findings') this.showFindings();
        else this.showKnowledgeReview();
    }

    private renderTopTabs(parent: HTMLElement): void {
        const row = parent.createDiv('vault-health-top-tabs');
        const findingsBtn = row.createEl('button', {
            text: t('modal.vaultHealthRepair.tabFindings'),
            cls: 'vault-health-top-tab' + (this.topTab === 'findings' ? ' is-active' : ''),
        });
        const reviewBtn = row.createEl('button', {
            text: t('modal.vaultHealthRepair.tabKnowledgeReview'),
            cls: 'vault-health-top-tab' + (this.topTab === 'review' ? ' is-active' : ''),
        });
        findingsBtn.addEventListener('click', () => {
            this.topTab = 'findings';
            this.render();
        });
        reviewBtn.addEventListener('click', () => {
            this.topTab = 'review';
            this.render();
        });
    }

    private showKnowledgeReview(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('vault-health-modal');
        this.renderTopTabs(contentEl);

        // IMP-20-06-01 W3-T4: mobile guard.
        if (Platform.isMobile) {
            contentEl.createEl('h3', { text: t('modal.vaultHealthRepair.tabKnowledgeReview') });
            contentEl.createEl('p', {
                text: t('modal.vaultHealthRepair.knowledgeReviewMobileHint'),
            });
            return;
        }

        // Source 1: cluster_freshness HealthFindings live in this.findings.
        const clusterFindings = this.findings.filter((f) =>
            KNOWLEDGE_REVIEW_CHECKS.has(f.check),
        );

        // Source 2: per-note verdicts persisted by the verifier.
        const db = this.plugin.knowledgeDB?.getDB();
        const noteRows: ReviewRow[] = db
            ? new KnowledgeReviewReader(db).listAll(false)
            : [];

        // Mapped severity (critical/moderate/info -> high/medium/low) drives
        // the same severity-pill UI the Findings tab uses; the underlying
        // ReviewSeverity stays untouched in storage and data layer.
        const noteRowsWithSev = noteRows.map((r) => ({
            row: r,
            severity: reviewSeverityToFindingSeverity(r.severity),
        }));
        const clusterFindingsWithSev = clusterFindings.map((f) => ({
            finding: f,
            severity: f.severity,
        }));

        const totalCount = clusterFindings.length + noteRows.length;
        const counts: Record<SeverityFilter, number> = {
            all: totalCount,
            high:
                clusterFindingsWithSev.filter((c) => c.severity === 'high').length +
                noteRowsWithSev.filter((n) => n.severity === 'high').length,
            medium:
                clusterFindingsWithSev.filter((c) => c.severity === 'medium').length +
                noteRowsWithSev.filter((n) => n.severity === 'medium').length,
            low:
                clusterFindingsWithSev.filter((c) => c.severity === 'low').length +
                noteRowsWithSev.filter((n) => n.severity === 'low').length,
        };

        contentEl.createEl('h3', { text: t('modal.vaultHealthRepair.knowledgeReviewTitle', { count: totalCount }) });

        const filterRow = contentEl.createDiv('vault-health-filter-row');
        const tabs: Array<{ key: SeverityFilter; label: string }> = [
            { key: 'all', label: t('modal.vaultHealthRepair.filterAll', { count: counts.all }) },
            { key: 'high', label: t('modal.vaultHealthRepair.filterHigh', { count: counts.high }) },
            { key: 'medium', label: t('modal.vaultHealthRepair.filterMedium', { count: counts.medium }) },
            { key: 'low', label: t('modal.vaultHealthRepair.filterLow', { count: counts.low }) },
        ];
        for (const tab of tabs) {
            const btn = filterRow.createEl('button', {
                text: tab.label,
                cls: 'vault-health-filter-tab' + (this.severityFilter === tab.key ? ' is-active' : ''),
            });
            btn.addEventListener('click', () => {
                this.severityFilter = tab.key;
                this.render();
            });
        }

        // FIX-19-05-04: manueller Freshness-Scan direkt aus dem Tab. Loest
        // zugleich die Beobachtbarkeit: der Nutzer kann den Stufe-3-Lauf
        // selbst ausloesen und sieht am Notice-Ergebnis (ran / nothing due /
        // budget / external-off), ob und was passiert -- statt einen leeren
        // Tab ohne erkennbaren Grund.
        this.renderFreshnessScanToolbar(contentEl);

        // W4: der Tab sagt, DASS die Feeder aus sind und wo man sie
        // einschaltet, statt einen generischen Empty-State zu zeigen (beide
        // Quellen sind Opt-in; live war genau das der Fall).
        //
        // FIX-19-02-16: Der Hinweis haengt an den VERDICTS, nicht am
        // Gesamtzaehler. Vorher genuegte ein einziges cluster_freshness-
        // Finding, damit totalCount > 0 wurde und der Hinweis verschwand --
        // der Nutzer sah eine gefuellte Liste, in der die Per-Notiz-Urteile
        // komplett fehlten, und erfuhr nie warum.
        // FEAT-19-03-01: nur noch EIN Gate. Das "no hot clusters"-Gate ist
        // weg, weil der Scan den ganzen Vault automatisch abdeckt -- es gibt
        // nichts mehr manuell anzukreuzen.
        const gates = knowledgeReviewEmptyInfo({
            freshness: this.plugin.settings.freshness,
            stufe3PeriodicJob: this.plugin.settings.vaultIngest?.stufe3PeriodicJob,
        });
        if (noteRows.length === 0 && gates.verdictFeederOff) {
            contentEl.createDiv({
                cls: 'vault-health-kr-gates',
                text: t('modal.vaultHealthRepair.knowledgeReviewGatesOff'),
            });
        }

        if (totalCount === 0) {
            contentEl.createEl('p', {
                text: t('modal.vaultHealthRepair.knowledgeReviewEmpty'),
            });
            // FIX-19-02-29: "leer" heisst hier zweierlei, und der Nutzer
            // konnte die Faelle nicht unterscheiden.
            //
            // Cluster-Aktualitaet meldet erst ab einem Score unter 70. Sind
            // Cluster registriert und liegt trotzdem nichts vor, ist das
            // eine ANTWORT ("geprueft, nichts veraltet"), keine Leerstelle.
            // Live gemessen: 141 Cluster, niedrigster Score 76, Durchschnitts-
            // alter 4 bis 19 Tage gegen Halbwertszeiten von 30 bis 180 Tagen.
            // Der Vault ist schlicht frisch. Ohne diesen Satz sieht das
            // genauso aus wie ein kaputter Check.
            const clusterCount = this.plugin.clusterMetadataStore?.getAll().length ?? 0;
            if (clusterCount > 0) {
                contentEl.createDiv({
                    cls: 'vault-health-kr-gates',
                    text: t('modal.vaultHealthRepair.knowledgeReviewNothingStale', { count: clusterCount }),
                });
            }
            // FIX-19-02-17: die Klassifikations-Sektion ist wieder raus.
            //
            // Sie war als Beleg gedacht ("das Plugin weiss etwas ueber
            // deinen Vault"), aber sie beantwortete keine Frage, die der
            // Nutzer hat. "Classified, not yet verified" ist ein
            // Implementierungsdetail: es benennt einen internen
            // Verarbeitungsstand, aus dem keine Handlung folgt. In diesen
            // Tab gehoeren nur Befunde mit einer Empfehlung, was zu tun
            // ist. Der Zaehler bleibt als Beleg erhalten, siehe unten.
            return;
        }

        // Top toolbar: Batch resolve action over the per-note verdicts.
        if (noteRows.length) {
            const batchRow = contentEl.createDiv('vault-health-knowledge-review-toolbar');
            const batchBtn = batchRow.createEl('button', { text: t('modal.vaultHealthRepair.batchResolveBtn') });
            batchBtn.addEventListener('click', () => {
                new BatchResolveModal(this.plugin, noteRows, { onChange: () => this.render() }).open();
            });
        }

        const visibleCluster = this.severityFilter === 'all'
            ? clusterFindingsWithSev
            : clusterFindingsWithSev.filter((c) => c.severity === this.severityFilter);
        const visibleNotes = this.severityFilter === 'all'
            ? noteRowsWithSev
            : noteRowsWithSev.filter((n) => n.severity === this.severityFilter);

        // FIX-19-02-16: ein Filter ohne Treffer ist kein Grund fuer eine
        // komplett leere Flaeche. Die Empty-Bedingung oben prueft die
        // GESAMTmenge; steht der Filter auf "high" und alles ist medium,
        // rendert der Tab sonst nichts und sieht kaputt aus.
        if (visibleCluster.length === 0 && visibleNotes.length === 0) {
            contentEl.createEl('p', {
                cls: 'agent-settings-desc',
                text: t('modal.vaultHealthRepair.noFindingsForFilter'),
            });
            return;
        }

        // Cluster freshness section (single bucket, same shape as a
        // Findings section).
        if (visibleCluster.length) {
            this.renderClusterFreshnessSection(contentEl, visibleCluster);
        }

        // Per-verdict sections. The order is the natural severity
        // gradient so the most urgent verdict bucket sits at the top.
        const verdictOrder: VerdictLiteral[] = [
            'contradicts',
            'outdated',
            'extends',
            'no_external_source',
        ];
        const groupedByVerdict = new Map<VerdictLiteral, Array<{ row: ReviewRow; severity: 'high' | 'medium' | 'low' }>>();
        for (const v of visibleNotes) {
            const entry = groupedByVerdict.get(v.row.verdict) ?? [];
            entry.push(v);
            groupedByVerdict.set(v.row.verdict, entry);
        }
        for (const verdict of verdictOrder) {
            const rows = groupedByVerdict.get(verdict);
            if (!rows?.length) continue;
            this.renderVerdictSection(contentEl, verdict, rows);
        }

        // The `matches` bucket only appears if some row carried it
        // (the reader hides matches by default; defensive render).
        const matchesRows = groupedByVerdict.get('matches');
        if (matchesRows?.length) {
            this.renderVerdictSection(contentEl, 'matches', matchesRows);
        }
    }


    private renderClusterFreshnessSection(
        parent: HTMLElement,
        entries: Array<{ finding: HealthFinding; severity: 'high' | 'medium' | 'low' }>,
    ): void {
        const sectionSeverity = entries[0].severity;
        const details = parent.createEl('details', { cls: 'vault-health-section' });
        details.setAttribute('open', '');

        const summary = details.createEl('summary', { cls: 'vault-health-section-header' });
        summary.createSpan({ cls: `vault-health-severity severity-${sectionSeverity}`, text: sectionSeverity });
        summary.createSpan({
            cls: 'vault-health-section-count',
            text: ' ' + t('modal.vaultHealthRepair.clusterFreshnessSection', { count: entries.length }),
        });
        summary.createSpan({ cls: 'vault-health-tag-info', text: ' ' + t('modal.vaultHealthRepair.reviewRecommendedTag') });

        const content = details.createDiv('vault-health-section-content');
        for (const { finding, severity } of entries) {
            const row = content.createDiv('vault-health-finding-row');

            const label = row.createSpan({ cls: 'vault-health-note-link' });
            label.setText(finding.cluster ?? t('modal.vaultHealthRepair.clusterFallback'));

            const actions = row.createDiv('vault-health-finding-actions');
            const discussBtn = actions.createEl('button', {
                cls: 'vault-health-icon-btn',
                attr: { 'aria-label': t('modal.vaultHealthRepair.discussFreshnessAria') },
            });
            setIcon(discussBtn, 'refresh-cw');
            discussBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const prompt = `Cluster "${finding.cluster ?? ''}" is past its half-life. Suggest a web-search update pass and the source notes that should go through deep-ingest. ${finding.description ?? ''}`.trim();
                this.close();
                this.onDiscuss?.(prompt);
            });

            const dismissBtn = actions.createEl('button', {
                cls: 'vault-health-icon-btn',
                attr: { 'aria-label': t('modal.vaultHealthRepair.dismissClusterAria') },
            });
            setIcon(dismissBtn, 'eye-off');
            dismissBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                this.dismissClusterFreshness(finding, row, content, details, entries.length);
            });

            // severity passed through `cls` matches the row-side variation
            // the Findings tab uses; no extra info text needed since the
            // description already lives below.
            void severity;

            const preview = content.createDiv('vault-health-fix-preview');
            preview.setText(finding.description ?? t('modal.vaultHealthRepair.clusterPreviewFallback', { cluster: finding.cluster ?? '' }));
        }
    }

    private renderVerdictSection(
        parent: HTMLElement,
        verdict: VerdictLiteral,
        entries: Array<{ row: ReviewRow; severity: 'high' | 'medium' | 'low' }>,
    ): void {
        // Section severity = worst-wins over the rows in the bucket.
        const sectionSeverity: 'high' | 'medium' | 'low' = entries.some((e) => e.severity === 'high')
            ? 'high'
            : entries.some((e) => e.severity === 'medium')
                ? 'medium'
                : 'low';
        const label = VERDICT_LABELS[verdict] ?? verdict;

        const details = parent.createEl('details', { cls: 'vault-health-section' });
        details.setAttribute('open', '');

        const summary = details.createEl('summary', { cls: 'vault-health-section-header' });
        summary.createSpan({ cls: `vault-health-severity severity-${sectionSeverity}`, text: sectionSeverity });
        summary.createSpan({
            cls: 'vault-health-section-count',
            text: ' ' + t('modal.vaultHealthRepair.sectionCount', { label, count: entries.length }),
        });

        const content = details.createDiv('vault-health-section-content');
        for (const { row } of entries) {
            const noteRow = content.createDiv('vault-health-finding-row');

            const noteLink = noteRow.createSpan({ cls: 'vault-health-note-link' });
            noteLink.setText(this.formatPath(row.path));
            noteLink.addEventListener('click', () => {
                this.close();
                void this.app.workspace.openLinkText(row.path, '');
            });

            // FIX-19-05-05: Confidence als Wort, kein interner Tier mehr.
            const meta = noteRow.createSpan({ cls: 'vault-health-path-count' });
            meta.setText(' ' + confidenceWord(row.confidence));
            meta.setAttr('title', `confidence ${row.confidence.toFixed(2)} · ${row.verifierTier} tier`);

            const actions = noteRow.createDiv('vault-health-finding-actions');

            // FIX-19-05-06: EINE Primaeraktion pro Zeile -- der Agenten-Flow,
            // der nachweislich gut funktioniert (recherchiert + schlaegt Edits
            // vor). Der frueher danebenstehende "Resolve dialog" (check-circle)
            // duplizierte grossteils genau diesen Flow und ist entfernt.
            const fixBtn = actions.createEl('button', {
                cls: 'mod-cta vault-health-fix-with-agent-btn',
                text: t('modal.vaultHealthRepair.fixWithAgent'),
            });
            fixBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const prompt = this.buildVerdictPrompt(row);
                this.close();
                this.onDiscuss?.(prompt);
            });

            // Sekundaer: ausblenden bis zum naechsten Scan-Aenderung.
            const dismissBtn = actions.createEl('button', {
                cls: 'vault-health-icon-btn',
                attr: { 'aria-label': t('modal.vaultHealthRepair.dismissVerdictAria') },
            });
            setIcon(dismissBtn, 'eye-off');
            dismissBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                this.dismissVerdict(row, noteRow, content, details, entries.length);
            });

            const preview = content.createDiv('vault-health-fix-preview');
            preview.setText(row.summary || t('modal.vaultHealthRepair.noSummaryFallback'));
        }
    }

    private buildVerdictPrompt(row: ReviewRow): string {
        // FIX-19-05-05: geteilter, zielorientierter Prompt (kein tool-Jargon).
        return buildReviewChatPrompt(row);
    }

    private dismissVerdict(
        row: ReviewRow,
        rowEl: HTMLElement,
        content: HTMLElement,
        details: HTMLDetailsElement,
        sectionCount: number,
    ): void {
        const db = this.plugin.knowledgeDB?.getDB();
        if (db) {
            db.run(
                `INSERT OR REPLACE INTO dismissed_freshness (note_path, hint_type, dismissed_at)
                 VALUES (?, 'verdict', ?)`,
                [row.path, new Date().toISOString()],
            );
            this.plugin.knowledgeDB?.markDirty();
        }
        new Notice(t('notice.vaultHealth.dismissedNote', { path: row.path }));
        rowEl.remove();
        // Strip the matching preview block that lives as the next sibling.
        const nextPreview = rowEl.nextElementSibling;
        if (nextPreview?.classList.contains('vault-health-fix-preview')) {
            nextPreview.remove();
        }
        if (sectionCount === 1) {
            details.remove();
        } else {
            const header = details.querySelector<HTMLElement>('.vault-health-section-count');
            if (header) {
                header.setText(header.getText().replace(/\((\d+)\)/, (_m, n: string) => `(${Math.max(0, parseInt(n, 10) - 1)})`));
            }
        }
        void content;
    }

    private dismissClusterFreshness(
        finding: HealthFinding,
        rowEl: HTMLElement,
        content: HTMLElement,
        details: HTMLDetailsElement,
        sectionCount: number,
    ): void {
        const db = this.plugin.knowledgeDB?.getDB();
        if (db && finding.cluster) {
            db.run(
                `INSERT OR REPLACE INTO dismissed_health_findings (check_type, path, dismissed_at)
                 VALUES (?, ?, ?)`,
                ['cluster_freshness', finding.cluster, new Date().toISOString()],
            );
            this.plugin.knowledgeDB?.markDirty();
        }
        new Notice(t('notice.vaultHealth.dismissedCluster', { cluster: finding.cluster ?? '' }));
        rowEl.remove();
        const nextPreview = rowEl.nextElementSibling;
        if (nextPreview?.classList.contains('vault-health-fix-preview')) {
            nextPreview.remove();
        }
        if (sectionCount === 1) {
            details.remove();
        } else {
            const header = details.querySelector<HTMLElement>('.vault-health-section-count');
            if (header) {
                header.setText(header.getText().replace(/\((\d+)\)/, (_m, n: string) => `(${Math.max(0, parseInt(n, 10) - 1)})`));
            }
        }
        void content;
    }

    onClose(): void {
        this.contentEl.empty();
    }

    // -----------------------------------------------------------------------
    // Phase 1: Detailed findings view
    // -----------------------------------------------------------------------

    /**
     * FIX-19-02-06: sagt in der Landeansicht, woraus die Zahl besteht und
     * was sie verschweigt.
     *
     * Zwei Dinge, die der Nutzer bisher nicht sehen konnte:
     *  - welche Befundklassen die Gesamtzahl ausmachen und welche davon
     *    ueberhaupt automatisch reparierbar sind,
     *  - dass weak_clusters auf 20 gedeckelt ist. Live liegen dort 1217
     *    offene Paare: repariert man die 20, ruecken die naechsten 20 nach
     *    und die Anzeige steht scheinbar still. Genau daran ist das
     *    Vertrauen zerbrochen.
     */
    /**
     * FIX-19-05-04: eine Zeile mit "zuletzt geprueft <relativ>" und einem
     * Re-Check-Knopf. Der Knopf laeuft ueber refreshAndShowFindings (derselbe
     * Pfad wie nach einem Repair: runChecks + Block-Regen + Re-Render).
     */
    private renderRescanToolbar(container: HTMLElement): void {
        // FIX-19-05-07: als native Setting (Name + "zuletzt geprueft"-Desc +
        // Re-Check-Knopf mit Icon), gleiches Register wie die Settings.
        const lastAt = this.plugin.vaultHealthService?.getLastRunAt() ?? null;
        const setting = new Setting(container)
            .setName(t('modal.vaultHealthRepair.rescanName'))
            .setDesc(lastAt === null
                ? t('modal.vaultHealthRepair.lastCheckedNever')
                : t('modal.vaultHealthRepair.lastCheckedAt', { when: formatRelativeTime(lastAt, Date.now()) }));
        setting.settingEl.addClass('vault-health-inline-setting');
        setting.addButton((btn) => {
            btn.setButtonText(t('modal.vaultHealthRepair.rescanBtn')).setIcon('refresh-cw');
            btn.onClick(() => {
                btn.setDisabled(true);
                btn.setButtonText(t('modal.vaultHealthRepair.rescanRunning'));
                void this.refreshAndShowFindings();
            });
        });
    }

    /**
     * FIX-19-05-04: Freshness-Scan-Knopf im Knowledge-review-Tab. Laeuft ueber
     * denselben On-demand-Pfad wie der Settings-Button (runFreshnessCheckNow:
     * Privacy-Gate, Budget-Cap, "nichts faellig"-Notice). Nach dem Lauf wird
     * der Tab neu gerendert, damit frisch geschriebene Verdicts erscheinen.
     */
    private renderFreshnessScanToolbar(container: HTMLElement): void {
        // FIX-19-05-07: gleiches Muster wie die Settings (native Setting:
        // Name + Beschreibung + Primaerknopf mit Icon, vgl. VaultTab
        // "Run freshness now"). Kein Ad-hoc-div mehr.
        const setting = new Setting(container)
            .setName(t('modal.vaultHealthRepair.freshnessScanName'))
            .setDesc(t('modal.vaultHealthRepair.freshnessScanHint'));
        setting.settingEl.addClass('vault-health-inline-setting');
        setting.addButton((btn) => {
            btn.setButtonText(t('modal.vaultHealthRepair.freshnessScanBtn'))
                .setIcon('radar')
                .setCta();
            btn.onClick(() => {
                btn.setDisabled(true);
                btn.setButtonText(t('modal.vaultHealthRepair.freshnessScanRunning'));
                void (async () => {
                    try {
                        await this.plugin.runFreshnessCheckNow();
                        // Nach dem Lauf koennen neue Verdicts in note_freshness
                        // stehen -- Tab neu aufbauen, damit sie erscheinen.
                        this.render();
                    } catch (e) {
                        console.warn('[VaultHealthRepair] freshness scan failed', e);
                        btn.setDisabled(false);
                        btn.setButtonText(t('modal.vaultHealthRepair.freshnessScanBtn'));
                    }
                })();
            });
        });
    }

    private renderFindingsBreakdown(container: HTMLElement, findings: HealthFinding[]): void {
        if (findings.length === 0) return;

        const byCheck = new Map<string, { total: number; repairable: number }>();
        for (const f of findings) {
            const entry = byCheck.get(f.check) ?? { total: 0, repairable: 0 };
            entry.total++;
            if (isRepairableFinding(f)) entry.repairable++;
            byCheck.set(f.check, entry);
        }

        const box = container.createDiv('vault-health-breakdown');
        const parts: string[] = [];
        for (const [check, { total, repairable }] of [...byCheck.entries()].sort((a, b) => b[1].total - a[1].total)) {
            parts.push(t('modal.vaultHealthRepair.breakdownEntry', {
                label: CHECK_LABELS[check] ?? check,
                count: total,
                repairable,
            }));
        }
        box.createDiv({ text: parts.join('  |  ') });

        // FIX-19-02-20: der Ueberhang-Hinweis gilt nur, solange auch
        // wirklich Paare in der Liste stehen.
        //
        // Nach einem Lauf blieb "Showing the 20 strongest of 1217" stehen,
        // obwohl die Liste nur noch eine Notiz zeigte -- die Zahl stammte
        // aus dem letzten Check und bezog sich auf nichts Sichtbares mehr.
        // Ein Hinweis auf etwas, das man nicht sieht, ist Rauschen.
        const totals = this.plugin.vaultHealthService?.getCheckTotals();
        const weak = totals?.weakClusters;
        const weakShownNow = byCheck.get('weak_clusters')?.total ?? 0;
        if (weak && weakShownNow > 0 && weak.total > weak.shown) {
            box.createDiv({
                cls: 'vault-health-breakdown-overflow',
                text: t('modal.vaultHealthRepair.breakdownOverflow', {
                    shown: weak.shown,
                    total: weak.total,
                }),
            });
        }
    }

    private renderHeader(
        container: HTMLElement,
        findings: HealthFinding[],
        repairableCount: number,
    ): void {
        const header = container.createDiv('vault-health-header');

        const titleRow = header.createDiv('vault-health-title-row');
        titleRow.createEl('h3', { text: t('modal.vaultHealthRepair.findingsTitle', { count: findings.length }) });

        const rightGroup = titleRow.createDiv('vault-health-header-right');
        const lastAt = this.plugin.vaultHealthService?.getLastRunAt() ?? null;
        if (lastAt !== null) {
            rightGroup.createSpan({
                cls: 'vault-health-header-time',
                text: formatRelativeTime(lastAt, Date.now()),
            });
        }

        const rescanBtn = rightGroup.createEl('button', {
            cls: 'vault-health-rescan-btn',
            text: t('modal.vaultHealthRepair.rescanBtn'),
        });
        setIcon(rescanBtn, 'refresh-cw');
        setTooltip(rescanBtn, t('modal.vaultHealthRepair.rescanBtn'), { delay: 50, placement: 'top' });
        rescanBtn.addEventListener('click', () => {
            rescanBtn.setAttr('disabled', 'true');
            void this.refreshAndShowFindings();
        });

        const summaryText = repairableCount > 0
            ? `共 ${findings.length} 个发现项，其中 ${repairableCount} 项可自动修复（执行前将自动创建快照）。`
            : `共 ${findings.length} 个发现项，暂无自动修复项。`;
        header.createEl('p', {
            cls: 'vault-health-subtitle',
            text: summaryText,
        });
    }

    private showFindings(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('vault-health-modal');
        this.renderTopTabs(contentEl);

        const findingsForView = this.findings.filter((f) => !KNOWLEDGE_REVIEW_CHECKS.has(f.check));
        const repairableCount = findingsForView.filter(isRepairableFinding).length;
        const totalCount = findingsForView.length;

        // Render clean minimalist header
        this.renderHeader(contentEl, findingsForView, repairableCount);

        // Severity filter chips
        const counts = {
            high: findingsForView.filter(f => f.severity === 'high').length,
            medium: findingsForView.filter(f => f.severity === 'medium').length,
            low: findingsForView.filter(f => f.severity === 'low').length,
        };
        const filterRow = contentEl.createDiv('vault-health-filter-row');
        const tabs: Array<{ key: SeverityFilter; label: string; count: number }> = [
            { key: 'all', label: '全部', count: totalCount },
            { key: 'high', label: '高', count: counts.high },
            { key: 'medium', label: '中', count: counts.medium },
            { key: 'low', label: '低', count: counts.low },
        ];
        for (const tab of tabs) {
            const btn = filterRow.createEl('button', {
                cls: 'vault-health-filter-tab' + (this.severityFilter === tab.key ? ' is-active' : ''),
                text: `${tab.label} ${tab.count}`,
            });
            btn.addEventListener('click', () => {
                this.severityFilter = tab.key;
                this.selectedFindings.clear();
                this.showFindings();
            });
        }

        // Apply filter
        const visibleFindings = this.severityFilter === 'all'
            ? findingsForView
            : findingsForView.filter(f => f.severity === this.severityFilter);

        // Group findings by check type
        const grouped = new Map<HealthCheckType, { findings: HealthFinding[]; indices: number[] }>();
        visibleFindings.forEach((f) => {
            const idx = this.findings.indexOf(f);
            const entry = grouped.get(f.check) ?? { findings: [], indices: [] };
            entry.findings.push(f);
            entry.indices.push(idx);
            grouped.set(f.check, entry);
        });

        const listContainer = contentEl.createDiv('vault-health-list-container');

        // Render each check type as a collapsible section
        for (const [check, { findings: checkFindings, indices }] of grouped) {
            const isRepairable = REPAIRABLE_CHECKS.has(check);
            const label = CHECK_LABELS[check] ?? check;
            const severity = checkFindings[0].severity;

            const details = listContainer.createEl('details', { cls: 'vault-health-section' });
            if (isRepairable) details.setAttribute('open', '');

            const summary = details.createEl('summary', { cls: 'vault-health-section-header' });
            summary.createSpan({ cls: `vault-health-severity severity-${severity}`, text: severity });
            summary.createSpan({ cls: 'section-header-title', text: `${label} (${checkFindings.length})` });
            if (!isRepairable) {
                summary.createSpan({ cls: 'vault-health-tag-info', text: ' ' + t('modal.vaultHealthRepair.reviewRecommendedTag') });
            }

            const content = details.createDiv('vault-health-section-content');

            for (let i = 0; i < checkFindings.length; i++) {
                const finding = checkFindings[i];
                const globalIdx = indices[i];

                const item = content.createDiv('vault-health-item');
                const row = item.createDiv('vault-health-item-main');

                // Checkbox
                if (isRepairableFinding(finding)) {
                    const key = findingKey(finding);
                    const isDeselected = this.deselectedFindings.has(key);
                    const checkbox = row.createEl('input', { type: 'checkbox', cls: 'vault-health-checkbox' });
                    checkbox.checked = !isDeselected;
                    if (isDeselected) {
                        this.selectedFindings.delete(globalIdx);
                    } else {
                        this.selectedFindings.add(globalIdx);
                    }
                    checkbox.addEventListener('change', () => {
                        if (checkbox.checked) {
                            this.selectedFindings.add(globalIdx);
                            this.deselectedFindings.delete(key);
                        } else {
                            this.selectedFindings.delete(globalIdx);
                            this.deselectedFindings.add(key);
                        }
                        this.updateRepairButton();
                    });
                }

                // Note link
                const primaryPath = finding.paths[0];
                if (primaryPath) {
                    const noteLink = row.createSpan({ cls: 'vault-health-note-link' });
                    noteLink.setText(this.formatPath(primaryPath));
                    noteLink.addEventListener('click', () => {
                        this.close();
                        void this.app.workspace.openLinkText(primaryPath, '');
                    });
                }

                if (finding.paths.length > 1) {
                    row.createSpan({
                        cls: 'vault-health-path-count',
                        text: `(另有 ${finding.paths.length - 1} 篇相关)`,
                    });
                }

                // Action buttons (right side of row)
                const actions = row.createDiv('vault-health-item-actions');

                // Discuss with agent
                const discussBtn = actions.createEl('button', {
                    cls: 'vault-health-icon-btn',
                });
                setIcon(discussBtn, 'message-square');
                setTooltip(discussBtn, '在对话中讨论', { delay: 50, placement: 'top' });
                discussBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const prompt = this.buildFindingPrompt(finding);
                    this.close();
                    if (this.onDiscuss) {
                        this.onDiscuss(prompt);
                    }
                });

                if (finding.check === 'orphans') {
                    const linkBtn = actions.createEl('button', {
                        cls: 'vault-health-icon-btn',
                    });
                    setIcon(linkBtn, 'link');
                    setTooltip(linkBtn, '推荐反向链接', { delay: 50, placement: 'top' });
                    linkBtn.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        const service = this.plugin.vaultHealthService;
                        if (!service) return;
                        const paths = finding.paths.filter((p) => p.endsWith('.md'));
                        const proposals = service.proposeOrphanLinks(paths, {
                            excludePathPrefixes:
                                this.plugin.settings.vaultHealth?.orphanExcludePathPrefixes ?? [],
                        });
                        new OrphanLinkModal(this.app, this.plugin, proposals, {
                            onLinked: () => { void this.refreshAndShowFindings(); },
                        }).open();
                    });
                }

                // Skip/dismiss
                const skipBtn = actions.createEl('button', {
                    cls: 'vault-health-icon-btn',
                });
                setIcon(skipBtn, 'x');
                setTooltip(skipBtn, '忽略', { delay: 50, placement: 'top' });
                skipBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    this.dismissFinding(finding, globalIdx, item, content, details, check, checkFindings.length);
                });

                // Detail preview text
                const preview = item.createDiv('vault-health-fix-preview');
                preview.setText(
                    isRepairable ? this.getFixPreview(finding) : this.getInfoText(finding)
                );
            }
        }

        // Bottom Unified Footer
        const btnRow = contentEl.createDiv('vault-health-footer');

        const leftGroup = btnRow.createDiv('vault-health-footer-left');
        const repairable = this.findings.filter(isRepairableFinding);
        if (repairable.length > 0) {
            const allOff = repairable.every((f) => this.deselectedFindings.has(findingKey(f)));
            const toggleBtn = leftGroup.createEl('button', {
                cls: 'vault-health-toggle-btn',
                text: allOff ? '全选' : '取消全选',
            });
            toggleBtn.addEventListener('click', () => {
                if (allOff) {
                    this.deselectedFindings.clear();
                } else {
                    for (const f of repairable) this.deselectedFindings.add(findingKey(f));
                }
                this.selectedFindings.clear();
                this.showFindings();
            });
            leftGroup.createSpan('vault-health-footer-count').setText(`已选 ${this.selectedFindings.size} / ${repairable.length}`);
        }

        const rightGroup = btnRow.createDiv('vault-health-footer-right');

        // Show dismissed findings button
        const dismissedCount = this.plugin.vaultHealthService?.getDismissedCount() ?? 0;
        if (dismissedCount > 0) {
            const dismissedBtn = rightGroup.createEl('button', {
                text: `已忽略 (${dismissedCount})`,
                cls: 'vault-health-reset-btn',
            });
            dismissedBtn.addEventListener('click', () => {
                this.showDismissedList(contentEl);
            });
        }

        const closeBtn = rightGroup.createEl('button', { text: t('modal.vaultHealth.closeBtn') });
        closeBtn.addEventListener('click', () => this.close());

        if (repairableCount > 0) {
            const repairBtn = rightGroup.createEl('button', {
                cls: 'mod-cta vault-health-repair-btn',
                text: `应用修复 (${this.selectedFindings.size})`,
            });
            repairBtn.addEventListener('click', () => {
                if (this.selectedFindings.size === 0) {
                    new Notice(t('notice.vaultHealth.noRepairSelection'));
                    return;
                }
                repairBtn.disabled = true;
                repairBtn.setText(t('modal.vaultHealth.repairing'));
                this.runRepair();
            });
        }

        this.updateRepairButton();
    }

    private updateRepairButton(): void {
        const btn = this.contentEl.querySelector('.vault-health-repair-btn');
        if (btn instanceof HTMLButtonElement) {
            btn.setText(`应用修复 (${this.selectedFindings.size})`);
        }
        const countSpan = this.contentEl.querySelector('.vault-health-footer-count');
        if (countSpan instanceof HTMLElement) {
            const repairable = this.findings.filter(isRepairableFinding);
            countSpan.setText(`已选 ${this.selectedFindings.size} / ${repairable.length}`);
        }
    }

    /**
     * IMP-19-01-01 AC-01..03: render the prominent Auto-fix CTA at
     * the top of the Findings tab. The button selects every
     * REPAIRABLE finding (across severity filters) and immediately
     * invokes `runRepair()`. The existing "Repair selected (N)"
     * button at the bottom of the list stays untouched for selective
     * repairs.
     */
    /**
     * IMP-19-01-02: sticky apply-bar at the top of the Findings tab.
     * Mirrors the bottom "Repair selected (N)" button so the user
     * never has to scroll to the end of a long list to apply the
     * selected fixes. Live-updates via .vault-health-apply-sticky-btn
     * lookup in updateRepairButton.
     */
    private renderStickyApplyBar(parent: HTMLElement): void {
        const bar = parent.createDiv('vault-health-apply-sticky');
        const btn = bar.createEl('button', {
            cls: 'mod-cta vault-health-apply-sticky-btn',
            text: t('modal.vaultHealthRepair.applySelectedFixes', { count: this.selectedFindings.size }),
        });

        // FEAT-19-02-01: Weg zurueck auf null.
        //
        // Alle reparierbaren Befunde sind vorangehakt, weil der Sammel-Fall
        // der haeufige ist. Wer aber nur drei von siebzig will, musste 67
        // Haken einzeln entfernen. Der Umschalter arbeitet ueber dasselbe
        // deselectedFindings-Set wie die Einzel-Abwahl, damit es nicht zwei
        // Wahrheiten darueber gibt, was ausgewaehlt ist.
        const repairable = this.findings.filter(isRepairableFinding);
        if (repairable.length > 0) {
            const allOff = repairable.every((f) => this.deselectedFindings.has(findingKey(f)));
            const toggleBtn = bar.createEl('button', {
                cls: 'vault-health-select-toggle',
                text: allOff
                    ? t('modal.vaultHealthRepair.selectAll')
                    : t('modal.vaultHealthRepair.deselectAll'),
            });
            toggleBtn.addEventListener('click', () => {
                if (allOff) {
                    this.deselectedFindings.clear();
                } else {
                    for (const f of repairable) this.deselectedFindings.add(findingKey(f));
                }
                this.selectedFindings.clear();
                this.showFindings();
            });
        }
        btn.addEventListener('click', () => {
            if (this.selectedFindings.size === 0) {
                new Notice(t('notice.vaultHealth.noRepairSelection'));
                return;
            }
            btn.disabled = true;
            btn.setText(t('modal.vaultHealth.repairing'));
            this.runRepair();
        });
    }

    /**
     * FIX-19-02-18: EIN Handlungsknopf statt zwei.
     *
     * Vorher standen "Auto-fix N issue(s)" und "Apply selected fixes (M)"
     * uebereinander und taten dasselbe -- der erste hakte alles an und lief
     * los, der zweite lief mit der Auswahl los. Da alle Befunde ohnehin
     * vorangehakt sind, war der Unterschied fuer den Nutzer nicht sichtbar,
     * die Zahlen widersprachen sich aber (70 gegen 0).
     *
     * Jetzt: ein Knopf, der zeigt, was die aktuelle Auswahl bewirkt, und
     * eine Zeile darueber, die erklaert was passiert. Beide Zahlen kommen
     * aus derselben Quelle.
     */
    private renderAutoFixBanner(parent: HTMLElement, repairableCount: number): void {
        const banner = parent.createDiv('vault-health-autofix-banner');
        const desc = banner.createDiv('vault-health-autofix-desc');
        desc.setText(t('modal.vaultHealthRepair.autoFixDesc', { count: repairableCount }));
    }

    /**
     * IMP-19-01-01 AC-03: select every REPAIRABLE finding regardless
     * of the active severity filter. Used by the Auto-fix banner and
     * by the pre-modal auto-apply path in AgentSidebarView.
     */
    selectAllRepairable(): void {
        this.selectedFindings.clear();
        this.findings.forEach((f, idx) => {
            if (isRepairableFinding(f)) {
                this.selectedFindings.add(idx);
            }
        });
    }

    // -----------------------------------------------------------------------
    // Dismiss a finding
    // -----------------------------------------------------------------------

    private dismissFinding(
        finding: HealthFinding,
        globalIdx: number,
        row: HTMLElement,
        content: HTMLElement,
        details: HTMLElement,
        check: HealthCheckType,
        originalCount: number,
    ): void {
        // Persist dismissal
        // W4: kanonischer Key aus derselben Quelle wie der Service-Filter.
        const path = dismissKeyPathFor(finding);
        this.plugin.vaultHealthService?.dismissFinding(finding.check, path);

        // FIX-19-02-08: neu zeichnen statt am DOM operieren.
        //
        // Die Chirurgie zog genau eine Zeile und die Sektions-Ueberschrift
        // nach. Kopfzeile ("Vault health (247 findings)"), die vier
        // Severity-Pillen und die Aufschluesselung behielten ihre alten
        // Zahlen -- der Nutzer blendete fuenf Befunde aus und die
        // Ueberschrift behauptete weiter 247. Das ist die "UI zeigt falsch
        // an"-Beschwerde in Reinform.
        void row; void content; void details; void check; void originalCount; void globalIdx;

        // Die Auswahl haengt an Listen-INDIZES. Nach dem Entfernen eines
        // Eintrags zeigen die alten Indizes auf andere Befunde, also wird
        // die Auswahl verworfen statt still verschoben. Eine geleerte
        // Auswahl kostet einen Klick, eine falsche kostet Vertrauen.
        this.selectedFindings.clear();
        this.findings = this.plugin.vaultHealthService?.getFindings() ?? this.findings;
        this.showFindings();
    }

    /** Re-run health checks and refresh the findings view. */
    private async refreshAndShowFindings(): Promise<void> {
        const healthService = this.plugin.vaultHealthService;
        if (healthService) {
            // FEAT-19-05-01: im Batch-Modus mit erhoehtem Deckel neu pruefen,
            // damit der naechste Batch wieder bis zu 250 Paare sieht.
            await healthService.runChecks(undefined, buildHealthCheckOptions(
                this.plugin.settings, this.batchMode ? WEAK_CLUSTER_BATCH_LIMIT : undefined));
            this.findings = healthService.getFindings();
            this.selectedFindings.clear();
            this.updateBadge(this.findings);
            // FEAT-19-04-01: nach dem Re-Check die Hub-Rueckverweis-Bloecke
            // gebuendelt aktualisieren (Setting-gated, reines Script, no-op
            // wenn nichts geaendert). Der Graph ist hier frisch extrahiert.
            await this.plugin.regenerateIncomingLinksBlocks();
        }
        this.showFindings();
    }

    // -----------------------------------------------------------------------
    // Dismissed findings list
    // -----------------------------------------------------------------------

    private showDismissedList(containerEl: HTMLElement): void {
        containerEl.empty();
        containerEl.createEl('h3', { text: t('modal.vaultHealthRepair.dismissedTitle') });

        const dismissed = this.plugin.vaultHealthService?.getDismissedFindings() ?? [];
        if (dismissed.length === 0) {
            containerEl.createEl('p', { text: t('modal.vaultHealthRepair.noDismissed') });
            const backBtn = containerEl.createEl('button', { text: t('modal.vaultHealthRepair.backBtn'), cls: 'mod-cta' });
            backBtn.addEventListener('click', () => this.showFindings());
            return;
        }

        // Search input
        const searchRow = containerEl.createDiv('vault-health-search-row');
        const searchInput = searchRow.createEl('input', {
            type: 'text',
            placeholder: t('ui.history.filter'),
            cls: 'vault-health-search-input',
        });

        const listEl = containerEl.createDiv('vault-health-dismissed-list');

        const renderList = (filter: string) => {
            listEl.empty();
            const lowerFilter = filter.toLowerCase();
            const filtered = filter
                ? dismissed.filter(d => d.path.toLowerCase().includes(lowerFilter) || d.checkType.toLowerCase().includes(lowerFilter))
                : dismissed;

            for (const d of filtered) {
                const row = listEl.createDiv('vault-health-finding-row');

                const label = CHECK_LABELS[d.checkType] ?? d.checkType;
                row.createSpan({ cls: `vault-health-severity severity-medium`, text: label });
                row.createSpan({ cls: 'vault-health-note-link', text: ` ${this.formatPath(d.path)}` });

                const restoreBtn = row.createEl('button', {
                    cls: 'vault-health-icon-btn',
                    attr: { 'aria-label': t('modal.vaultHealthRepair.restoreAria') },
                });
                setIcon(restoreBtn, 'eye');
                restoreBtn.addClass('vault-health-icon-btn-visible');
                restoreBtn.addEventListener('click', () => {
                    this.plugin.vaultHealthService?.restoreDismissedFinding(d.checkType, d.path);
                    row.remove();
                    const remaining = listEl.querySelectorAll('.vault-health-finding-row').length;
                    if (remaining === 0) {
                        void this.refreshAndShowFindings();
                    }
                });
            }

            if (filtered.length === 0) {
                listEl.createEl('p', { cls: 'vault-health-empty', text: t('modal.vaultHealthRepair.noMatches') });
            }
        };

        renderList('');
        searchInput.addEventListener('input', () => renderList(searchInput.value));

        // Bottom buttons
        const btnRow = containerEl.createDiv('vault-health-btn-row');

        const restoreAllBtn = btnRow.createEl('button', {
            text: t('modal.vaultHealthRepair.restoreAllBtn'),
        });
        restoreAllBtn.addEventListener('click', () => {
            this.plugin.vaultHealthService?.restoreDismissed();
            void this.refreshAndShowFindings();
        });

        const backBtn = btnRow.createEl('button', { text: t('modal.vaultHealthRepair.backBtn'), cls: 'mod-cta' });
        backBtn.addEventListener('click', () => {
            void this.refreshAndShowFindings();
        });
    }

    // -----------------------------------------------------------------------
    // Prompt builder for discuss
    // -----------------------------------------------------------------------

    private buildFindingPrompt(finding: HealthFinding): string {
        const label = CHECK_LABELS[finding.check] ?? finding.check;
        const paths = finding.paths.map(p => `[[${this.formatPath(p)}]]`).join(', ');

        // If finding has multiple paths (e.g. orphans with many notes), guide interactive walkthrough
        if (finding.paths.length > 3) {
            return (
                `Vault health: ${label}\n` +
                `${finding.description}\n\n` +
                `Affected: ${paths}\n\n` +
                `Walk me through these one by one. For each item:\n` +
                `1. Explain what it is and where it lives (vault note, database entry, or system artifact)\n` +
                `2. Show me the item and suggest what to do with it\n` +
                `3. Give me concrete options as followup suggestions (e.g. "delete", "link to X", "keep as is", "skip")\n` +
                `4. Wait for my choice before moving to the next item\n\n` +
                `Also offer "apply same action to all remaining" as a batch option.\n` +
                `No emojis. Be specific about file locations and what each item actually is.`
            );
        }

        return (
            `Vault health: ${label}\n` +
            `${finding.description}\n\n` +
            `Affected: ${paths}\n\n` +
            `Explain what this is (vault note, database entry, or system artifact), ` +
            `where it lives, and suggest a concrete fix with options as followup suggestions. ` +
            `After I pick one, implement it. No emojis.`
        );
    }

    // -----------------------------------------------------------------------
    // Fix preview text generators
    // -----------------------------------------------------------------------

    private getFixPreview(finding: HealthFinding): string {
        switch (finding.check) {
            case 'missing_backlinks': {
                const target = finding.paths[0];
                const sources = finding.paths.slice(1);
                if (sources.length > 10) {
                    return t('modal.vaultHealthRepair.fixPreviewBacklinksBase', { target: this.formatPath(target), count: sources.length });
                }
                const sourceList = sources.slice(0, 3).map(s => this.formatPath(s)).join(', ');
                const moreSuffix = sources.length > 3 ? ' ' + t('modal.vaultHealthRepair.fixPreviewMoreSuffix', { count: sources.length - 3 }) : '';
                return t('modal.vaultHealthRepair.fixPreviewAddBacklinks', { target: this.formatPath(target), sources: sourceList }) + moreSuffix;
            }
            case 'category_mismatch':
                return t('modal.vaultHealthRepair.fixPreviewCategory', { path: this.formatPath(finding.paths[0]) });
            case 'inconsistent_tags':
                return t('modal.vaultHealthRepair.fixPreviewTags');
            // FIX-19-01-12: orphans have no automatic repair any more. Both
            // kinds need the same manual decision (create an incoming link),
            // so both render the manual hint instead of a move preview.
            case 'orphans':
                return t('modal.vaultHealthRepair.fixPreviewOrphanManual');
            case 'weak_clusters':
                if (finding.paths.length >= 2) {
                    return t('modal.vaultHealthRepair.fixPreviewLinkPair', { a: this.formatPath(finding.paths[0]), b: this.formatPath(finding.paths[1]) });
                }
                return t('modal.vaultHealthRepair.fixPreviewLinkPairFallback');
            default:
                return finding.description.slice(0, 120);
        }
    }

    private getInfoText(finding: HealthFinding): string {
        switch (finding.check) {
            case 'orphans':
                return finding.description.split('\n')[0];
            case 'weak_clusters':
                return finding.description;
            case 'god_nodes':
                return finding.description;
            case 'broken_links':
                return t('modal.vaultHealthRepair.brokenLinkInfo', { path: this.formatPath(finding.paths[0]) });
            default:
                return finding.description.slice(0, 150);
        }
    }

    private formatPath(path: string): string {
        return path.replace(/\.md$/, '').split('/').pop() ?? path;
    }

    // -----------------------------------------------------------------------
    // Phase 2: Run repair (selected findings only)
    // -----------------------------------------------------------------------

    /** FIX-19-01-19: Ergebnis der Index-Bereinigung, die vor dem Plan laeuft. */
    private pendingEdgesResult: { edgesRemoved: number } | null = null;

    /**
     * FEAT-19-05-01: Batch-Modus. Prueft mit erhoehtem weak_clusters-Deckel
     * (250 statt 20) neu, waehlt alle reparierbaren Befunde und schickt sie
     * durch den GANZ NORMALEN Freigabe-Zyklus (runRepair -> renderPlanApproval
     * -> doRepair). ADR-165 bleibt buchstabengetreu: der Nutzer sieht die
     * volle Schreibmenge und gibt sie frei, nur eben 250 auf einmal statt 20.
     * Der Checkpoint-Cap 500 deckelt weiterhin hart.
     *
     * `batchMode` bleibt gesetzt, damit der Re-Check am Ende von doRepair
     * denselben erhoehten Deckel nutzt und der "Naechster Batch"-Knopf die
     * echte Restzahl sieht.
     */
    private batchMode = false;

    private async runBatchRepair(): Promise<void> {
        const healthService = this.plugin.vaultHealthService;
        if (!healthService) return;
        this.batchMode = true;
        // Mit erhoehtem Deckel neu pruefen, damit bis zu 250 weak-Paare in
        // EINEN Plan kommen.
        await healthService.runChecks(undefined,
            buildHealthCheckOptions(this.plugin.settings, WEAK_CLUSTER_BATCH_LIMIT));
        this.findings = healthService.getFindings();
        this.selectAllRepairable();
        if (this.selectedFindings.size === 0) {
            this.batchMode = false;
            new Notice(t('notice.vaultHealth.noRepairSelection'));
            return;
        }
        this.runRepair();
    }

    // Baut nur die Freigabe-Liste und rendert sie; das eigentliche Schreiben
    // haengt an doRepair hinter der Freigabe. Das urspruengliche `async` kam
    // aus der Erstfassung, die hier noch selbst geschrieben hat, und blieb
    // nach dem Umbau auf den Freigabe-Zyklus ohne await zurueck.
    private runRepair(): void {
        const healthService = this.plugin.vaultHealthService;
        if (!healthService) return;

        // ADR-165: kein Schreiben ohne approvte Plan-Liste. Der Plan kommt
        // aus der Live-Seite des Praedikats (ADR-164) und macht auch den
        // frueher stillen Cleanup-Nachlauf sichtbar.
        const backlinksProperty = this.plugin.settings.backlinksProperty ?? OKF_DEFAULTS.backlinksProperty;
        const categoryProperty = this.plugin.settings.categoryProperty ?? OKF_DEFAULTS.categoryProperty;
        const reciprocal = this.plugin.settings.vaultHealth?.reciprocalProperties ?? [];

        const selectedTypes = new Set<string>();
        const weakPairs: Array<{ a: string; b: string }> = [];
        // FIX-19-01-17 + FIX-19-01-19: die Auswahl bindet den Plan, und
        // zwar PRO CHECK-TYP. Ein flaches Set war typ-blind: eine Notiz,
        // die als Quelle in einem angehakten missing_backlinks-Finding
        // vorkam, autorisierte damit auch cleanup- und
        // category-Schreibvorgaenge an derselben Datei, obwohl deren
        // eigene Befunde abgewaehlt waren. In einem MOC-Vault ist das der
        // Normalfall, weil jede Hub-Note mal Ziel und mal Quelle ist.
        const selectedByCheck = new Map<string, Set<string>>();
        for (const idx of this.selectedFindings) {
            const f = this.findings[idx];
            selectedTypes.add(f.check);
            let set = selectedByCheck.get(f.check);
            if (!set) { set = new Set<string>(); selectedByCheck.set(f.check, set); }
            for (const p of f.paths) set.add(p);
            if (f.check === 'weak_clusters' && f.paths.length >= 2) {
                weakPairs.push({ a: f.paths[0], b: f.paths[1] });
            }
        }

        // FIX-19-01-19: erst den Graph-Index bereinigen, DANN planen. So
        // sieht der Plan schon die bereinigte Kantenmenge und verspricht
        // keine Ziele, die beim Schreiben nicht mehr existieren.
        this.pendingEdgesResult = (selectedTypes.has('missing_backlinks') || selectedTypes.has('category_mismatch'))
            ? healthService.cleanupOrphanedEdges()
            : { edgesRemoved: 0 };

        const entries = buildRepairPlan(
            {
                planRepairTargets: (a) => healthService.planRepairTargets(a, backlinksProperty, categoryProperty, reciprocal),
                // FIX-19-02-15: weak-Paare gegen das Live-Frontmatter pruefen,
                // statt sie roh aus dem Snapshot zu uebernehmen.
                planWeakPairTargets: (pairs) => healthService.planWeakPairTargets(pairs, backlinksProperty),
            },
            selectedTypes, weakPairs, { includeCleanup: true, selectedByCheck },
        );
        if (entries.length === 0) {
            new Notice(t('notice.vaultHealth.noRepairSelection'));
            return;
        }
        // FIX-19-01-13: geschrieben wird nur, was der Checkpoint abdeckt.
        const { covered, deferred } = capPlanForCheckpoint(entries, 500);
        this.renderPlanApproval(covered, deferred);
    }

    /**
     * ADR-165: die Plan-Ansicht. Alle Eintraege vorbefuellt (Approve-all
     * als Default-Weg), jede Zeile einzeln abwaehlbar; erst der Klick auf
     * Anwenden startet die Ausfuehrung, gebunden an exakt die approvten
     * Pfade.
     */
    private renderPlanApproval(entries: RepairPlanEntry[], deferred: number): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('modal.vaultHealthRepair.planTitle') });
        contentEl.createDiv({
            cls: 'setting-item-description',
            text: t('modal.vaultHealthRepair.planIntro'),
        });
        if (deferred > 0) {
            contentEl.createDiv({
                cls: 'vault-health-plan-deferred',
                text: t('modal.vaultHealthRepair.planDeferred', { count: deferred }),
            });
        }

        // FIX-19-01-18: der ehrliche Zaehler. Vorher stand hier nur die
        // Zeilenzahl, und der Nutzer kam von einem Button, der Befunde
        // gezaehlt hatte (24 gegen 204). Die Aufschluesselung benennt beide
        // Groessen und die Herkunft der Differenz.
        const summary = summarizePlan(entries, this.selectedFindings.size);
        contentEl.createDiv({
            cls: 'vault-health-plan-summary',
            text: t('modal.vaultHealthRepair.planSummary', {
                findings: summary.findings,
                writes: summary.writes,
                files: summary.files,
            }),
        });
        const parts: string[] = [];
        if (summary.byAction.fix_backlinks > 0) parts.push(t('modal.vaultHealthRepair.planShareBacklinks', { count: summary.byAction.fix_backlinks }));
        if (summary.byAction.fix_categories > 0) parts.push(t('modal.vaultHealthRepair.planShareCategories', { count: summary.byAction.fix_categories }));
        if (summary.byAction.link_weak > 0) parts.push(t('modal.vaultHealthRepair.planShareWeak', { count: summary.byAction.link_weak }));
        if (summary.byAction.cleanup > 0) parts.push(t('modal.vaultHealthRepair.planShareCleanup', { count: summary.byAction.cleanup }));
        if (parts.length > 0) {
            contentEl.createDiv({ cls: 'vault-health-plan-breakdown', text: parts.join(' | ') });
        }

        // FIX-19-02-22: die Luecke zwischen ausgewaehlten Befunden und
        // geplanten Aenderungen benennen.
        //
        // Der Nutzer sah "70 finding(s) selected" und "Apply 66 change(s)"
        // und fragte zu Recht, wo die vier geblieben sind. Sie fallen
        // heraus, weil das Live-Praedikat sagt: an dieser Datei ist nichts
        // zu tun (schon korrekt, ausgenommen per .agentignore, oder das
        // Ziel existiert nicht mehr). Das ist genau die Relevanzpruefung,
        // die der Repair leisten soll -- aber lautlos ist sie nur
        // verwirrend.
        const noChange = summary.findings - summary.writes;
        if (noChange > 0) {
            contentEl.createDiv({
                cls: 'vault-health-plan-nochange',
                text: t('modal.vaultHealthRepair.planNoChangeNeeded', { count: noChange }),
            });
        }
        if (summary.cleanupWithoutFinding > 0) {
            // Der Anteil, der den Sprung erklaert: kein Befund steht dahinter.
            contentEl.createDiv({
                cls: 'vault-health-plan-note',
                text: t('modal.vaultHealthRepair.planCleanupNote', { count: summary.cleanupWithoutFinding }),
            });
        }

        const approved = new Set<number>(entries.map((_, i) => i));
        const list = contentEl.createDiv({ cls: 'vault-health-plan-list' });
        const actionLabel = (a: RepairPlanEntry['action']): string => {
            switch (a) {
                case 'fix_backlinks': return t('modal.vaultHealthRepair.planActionBacklink');
                case 'fix_categories': return t('modal.vaultHealthRepair.planActionCategory');
                case 'cleanup': return t('modal.vaultHealthRepair.planActionCleanup');
                case 'link_weak': return t('modal.vaultHealthRepair.planActionWeak');
            }
        };
        entries.forEach((e, i) => {
            const row = list.createDiv({ cls: 'vault-health-plan-row' });
            const cb = row.createEl('input', { type: 'checkbox' });
            cb.checked = true;
            cb.addEventListener('change', () => {
                if (cb.checked) approved.add(i); else approved.delete(i);
                applyBtn.setText(t('modal.vaultHealthRepair.planApply', { count: approved.size }));
                applyBtn.disabled = approved.size === 0;
            });
            row.createSpan({ cls: 'vault-health-plan-action', text: actionLabel(e.action) });
            row.createSpan({ cls: 'vault-health-plan-path', text: e.label });
        });

        const footer = contentEl.createDiv({ cls: 'vault-health-plan-footer' });
        const backBtn = footer.createEl('button', { text: t('modal.vaultHealthRepair.planBack') });
        backBtn.addEventListener('click', () => { void this.refreshAndShowFindings(); });
        const applyBtn = footer.createEl('button', {
            cls: 'mod-cta',
            text: t('modal.vaultHealthRepair.planApply', { count: approved.size }),
        });
        applyBtn.addEventListener('click', () => {
            const chosen = entries.filter((_, i) => approved.has(i));
            void this.runApprovedRepair(chosen);
        });
    }

    private async runApprovedRepair(approvedEntries: RepairPlanEntry[]): Promise<void> {
        // FIX-19-02-25: der Nenner, gegen den der Ergebnis-Screen berichtet.
        this.lastPlannedChangeCount = approvedEntries.length;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('modal.vaultHealth.repairRunning') });
        const progress = contentEl.createEl('p', { cls: 'vault-health-progress' });

        // FEAT-19-05-01: Abbruch. Setzt healthService.cancelled, das die
        // Fix-Schleifen zwischen den Dateien pruefen (VaultHealthService
        // :1659/:1859/:1919/:2232). Der laufende Datei-Write wird noch
        // fertig, danach stoppt die Schleife -- kein halber Write.
        const cancelBtn = contentEl.createEl('button', {
            cls: 'vault-health-cancel-btn',
            text: t('modal.vaultHealthRepair.cancelRepair'),
        });
        cancelBtn.addEventListener('click', () => {
            this.plugin.vaultHealthService?.cancel();
            this.batchMode = false; // kein Auto-Weiter nach Abbruch
            cancelBtn.disabled = true;
            cancelBtn.setText(t('modal.vaultHealthRepair.cancelling'));
        });

        // FIX-19-01-03: suspend the global vault.on('modify')
        // extractFile call for the duration of the repair. Every
        // processFrontMatter the repair runs fires that listener,
        // which then reads STALE metadataCache and overwrites the
        // fresh reverse edges we are about to insert. The repair
        // owns its own settle + extractAll sequence at the end.
        // SEC L-2 (Audit 2026-07-19): Save/Restore statt Hart-Reset. Der
        // Flag ist ein geteilter Mutex; endet der Sammel-Repair, waehrend
        // ein Orphan-Link-Lauf noch schreibt, hob das harte false dessen
        // Schutz auf. OrphanLinkModal machte es seit SEC L-1 richtig.
        const hadRepairFlag = this.plugin.vaultHealthRepairInProgress;
        this.plugin.vaultHealthRepairInProgress = true;
        try {
            await this.doRepair(progress, approvedEntries);
        } finally {
            this.plugin.vaultHealthRepairInProgress = hadRepairFlag;
        }
    }

    private async doRepair(progress: HTMLElement, approvedEntries: RepairPlanEntry[]): Promise<void> {
        const healthService = this.plugin.vaultHealthService;
        if (!healthService) return;

        // FIX-19-01-06: defensive reset of the cancelled flag. The
        // service shares this flag across all runChecks calls; if a
        // prior runChecks early-returned before the reset at line 92
        // (e.g. the running-guard fired), the flag could be stuck at
        // true and every fix loop would short-circuit on iteration 0.
        healthService.cancelled = false;

        // Checkpoint
        progress.setText(t('modal.vaultHealth.creatingCheckpoint'));
        // FEAT-55-03 (ADR-171): collision-free id keying the checkpoint list.
        const taskId = generateShortId('health-repair');
        // ADR-165: Checkpoint == approvte Schreibmenge (FIX-19-01-13:
        // die Deckelung passierte schon vor der Plan-Ansicht).
        const approvedByAction = {
            backlinks: new Set(approvedEntries.filter((e) => e.action === 'fix_backlinks').map((e) => e.path)),
            cleanup: new Set(approvedEntries.filter((e) => e.action === 'cleanup').map((e) => e.path)),
            categories: new Set(approvedEntries.filter((e) => e.action === 'fix_categories').map((e) => e.path)),
        };
        // SEC M-1: paarweise statt pfadweise. Der Plan traegt den Paar-Key.
        const approvedWeakPairKeys = new Set(
            approvedEntries.filter((e) => e.action === 'link_weak' && e.pairKey).map((e) => e.pairKey!),
        );
        const approvedWeakPaths = new Set(
            [...approvedWeakPairKeys].flatMap((k) => k.split(PAIR_KEY_SEPARATOR)).filter(Boolean),
        );

        // FIX-19-02-14: die ZWEITE Seite jedes weak-Paars gehoert dazu.
        //
        // Eine Plan-Zeile traegt nur einen der beiden Pfade (SEC M-1 machte
        // aus zwei Zeilen eine), geschrieben wird aber in BEIDE Notizen.
        // affectedPaths las nur e.path, also fehlte die Gegenseite im
        // Checkpoint (Undo liess genau eine Seite verlinkt stehen), in der
        // Re-Extraktion, im Drain-Wait und im Ergebnis-Screen. Alle vier
        // lesen aus dieser einen Variablen, deshalb heilt sie alle vier.
        const affectedPaths = [...new Set([
            ...approvedEntries.map((e) => e.path),
            ...approvedWeakPaths,
        ])];

        let checkpoint: CheckpointInfo | undefined;
        if (this.plugin.checkpointService && affectedPaths.length > 0) {
            try {
                const cp = await this.plugin.checkpointService.snapshot(
                    taskId, affectedPaths, 'vault_health_repair',
                );
                if (cp && cp.commitOid !== 'empty') checkpoint = cp;
            } catch (e) {
                console.warn('[VaultHealthRepair] Checkpoint failed (non-fatal):', e);
            }
        }

        // ADR-165: die Typen kommen aus dem approvten Plan.
        const selectedTypes = new Set<string>();
        if (approvedByAction.backlinks.size > 0) selectedTypes.add('missing_backlinks');
        if (approvedByAction.categories.size > 0) selectedTypes.add('category_mismatch');
        if (approvedWeakPairKeys.size > 0) selectedTypes.add('weak_clusters');

        let edgesResult = { edgesRemoved: 0 };
        let backlinksResult = { entitiesFixed: 0, linksAdded: 0, yamlErrorPaths: [] as string[] };
        let categoriesResult = { notesFixed: 0, valuesMovied: 0 };
        let cleanupResult = { notesProcessed: 0, linksRemoved: 0 };
        let weakLinkResult: { pairsLinked: number; linksAdded: number; failedPairs: Array<{ a: string; b: string }> } =
            { pairsLinked: 0, linksAdded: 0, failedPairs: [] };

        // FIX-19-01-19: cleanupOrphanedEdges lief HIER, also ZWISCHEN
        // Plan-Bau und Schreiben -- und loeschte dabei Kanten aus genau der
        // Tabelle, aus der beide Seiten ihre Zielmenge ableiten. Jedes Ziel,
        // dessen Kante dabei verschwand, stand im Plan, war beim Schreiben
        // aber nicht mehr in der frisch berechneten Menge. Das ist die
        // Erklaerung fuer "1 entities iterated, 0 frontmatter links
        // written" im Log. Der Aufruf ist jetzt in runRepair vorgezogen,
        // VOR buildRepairPlan; das Ergebnis wird durchgereicht.
        edgesResult = this.pendingEdgesResult ?? { edgesRemoved: 0 };

        // FIX-19-01-01: backlinksProperty came from settings, not
        // hardcoded 'Notizen'. The original hardcoded value caused
        // repairs to land on a different property than the user's
        // existing edges, so the reverse-edge predicate kept firing.
        const backlinksProperty = this.plugin.settings.backlinksProperty ?? OKF_DEFAULTS.backlinksProperty;
        const categoryProperty = this.plugin.settings.categoryProperty ?? OKF_DEFAULTS.categoryProperty;
        const reciprocal = this.plugin.settings.vaultHealth?.reciprocalProperties ?? [];
        const approvedPairs: Array<{ a: string; b: string }> = [];

        // SEC M-4/M-6 (Audit 2026-07-19): die Writes gehoeren IN den
        // write-Callback von applyAndVerify. Vorher liefen sie davor und
        // der 'changed'-Listener wurde erst danach registriert -- ein
        // klassischer lost wakeup: die Events waren durch, das pending-Set
        // leerte sich nie, jeder Repair brannte die vollen 8s (plus 8s
        // Stufe B, plus 2s Drain) und meldete danach JEDEN erfolgreich
        // appariierten Pfad als 'failed'. OrphanLinkModal machte es schon
        // richtig; hier zieht der Sammel-Repair nach.
        const stageAWritten = [...approvedByAction.backlinks, ...approvedByAction.categories, ...approvedWeakPaths];
        const timedOutPaths: string[] = [];

        progress.setText(t('modal.vaultHealthRepair.progressWaitingIndex'));
        {
            const res = await healthService.applyAndVerify(stageAWritten, async () => {
                if (selectedTypes.has('missing_backlinks')) {
                    progress.setText(t('modal.vaultHealth.progressBacklinks'));
                    backlinksResult = await healthService.fixMissingBacklinks(
                        backlinksProperty,
                        categoryProperty,
                        reciprocal,
                        approvedByAction.backlinks,
                    );
                }

                if (selectedTypes.has('category_mismatch')) {
                    progress.setText(t('modal.vaultHealth.progressCategories'));
                    categoriesResult = await healthService.fixCategoryMismatches(categoryProperty, approvedByAction.categories);
                }

                // FIX-19-01-12: der Orphan-Move ist ersatzlos weg (ein Move
                // erzeugt keine eingehende Kante). isRepairableFinding laesst
                // orphans gar nicht erst in die Auswahl.

                if (selectedTypes.has('weak_clusters')) {
                    progress.setText(t('modal.vaultHealthRepair.progressLinkingClusters'));
                    // SEC M-1: paarweise Approval. Frueher stand hier ein
                    // Pfad-Set; taucht eine Note in zwei Paaren auf (a-b und
                    // a-c), ueberlebte ihr Pfad das Abwaehlen der einen Zeile
                    // ueber die andere, und das abgewaehlte Paar wurde doch
                    // verlinkt. Der Plan traegt den Paar-Key jetzt selbst.
                    for (const key of approvedWeakPairKeys) {
                        const [a, b] = key.split('\u0000');
                        if (a && b) approvedPairs.push({ a, b });
                    }
                    weakLinkResult = await healthService.linkWeakClusters(approvedPairs, backlinksProperty);
                }
            }, () => [], { reparseTimeoutMs: 8000 });
            timedOutPaths.push(...res.timedOutPaths);
        }

        // Stufe B (ADR-166): Cleanup NACH dem Reparse, damit er nie auf dem
        // stalen Cache entscheidet und frisch geschriebene Links revertiert.
        if (approvedByAction.cleanup.size > 0) {
            progress.setText(t('modal.vaultHealth.progressInvalidLinks'));
            const resB = await healthService.applyAndVerify([...approvedByAction.cleanup], async () => {
                cleanupResult = await healthService.cleanupInvalidBacklinks(
                    backlinksProperty,
                    categoryProperty,
                    approvedByAction.cleanup,
                );
            }, () => [], { reparseTimeoutMs: 8000 });
            timedOutPaths.push(...resB.timedOutPaths);
        }

        // Re-extract graph data before re-checking (FIX-13)
        progress.setText(t('modal.vaultHealthRepair.progressVerifying'));
        if (this.plugin.graphExtractor) {
            const extractor = this.plugin.graphExtractor;
            // FIX-19-01-03: per-file extraction was meant to be cheap
            // (touched files only), BUT fixMissingBacklinks and
            // cleanupInvalidBacklinks mutate a SUPERSET of the
            // selectedFindings paths (their SQL iterates every
            // one-sided edge in the DB, not just selected ones).
            // Files outside affectedPaths never got refreshed,
            // leaving stale edges in the DB and re-detection on the
            // next runChecks. Always run extractAll to catch every
            // mutated file regardless of which paths the selection
            // tracked; per-file pass stays as a fast first pass.
            let perFileSucceeded = 0;
            for (const path of affectedPaths) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    try {
                        // FEAT-19-04-01 W3: extractFile ist async (Block-Kanten-
                        // Klassifikation). awaiten -- die Kanten muessen vor dem
                        // verifizierenden runChecks stehen.
                        await extractor.extractFile(file);
                        perFileSucceeded++;
                    } catch (e) {
                        console.warn('[VaultHealthRepair] extractFile failed for', path, e);
                    }
                }
            }
            void perFileSucceeded;
            await extractor.extractAll(this.app.vault);

            // FIX-19-01-04: drain Obsidian's vault.on('modify') queue
            // before runChecks AND before the flag clears in the
            // finally block. Otherwise late modify events fire on
            // the touched files after the flag is false; the global
            // extractFile listener then reads STALE metadataCache
            // (which may still lag the disk write) and overwrites
            // the just-extracted edges.
            await this.waitForVaultModifyDrain(affectedPaths);
            // One more extractAll after the drain catches any edges
            // a late modify-listener call might have clobbered while
            // the queue was unwinding.
            await extractor.extractAll(this.app.vault);
            if (this.plugin.ontologyStore) {
                const categoryMap = new Map<string, string>();
                for (const file of this.app.vault.getMarkdownFiles()) {
                    const cache = this.app.metadataCache.getFileCache(file);
                    if (cache?.frontmatter?.[categoryProperty]) {
                        const cat = Array.isArray(cache.frontmatter[categoryProperty])
                            ? (cache.frontmatter[categoryProperty][0] ?? '').toString().trim()
                            : cache.frontmatter[categoryProperty].toString().trim();
                        if (cat) categoryMap.set(file.path, cat);
                    }
                }
                this.plugin.ontologyStore.bootstrapFromEdges(
                    this.plugin.settings.mocPropertyNames ?? [],
                    categoryProperty,
                    categoryMap,
                );
            }
        }

        // ADR-166 / Phase 6: das Ergebnis kommt aus dem Verify-Delta des
        // Praedikats, nicht aus Iterationszaehlern.
        const verifyOpts = { backlinksProperty, categoryProperty, reciprocalProperties: reciprocal };
        const stillFiring = [
            ...healthService.verifyRepairTargets('fix_backlinks', [...approvedByAction.backlinks], verifyOpts),
            ...healthService.verifyRepairTargets('fix_categories', [...approvedByAction.categories], verifyOpts),
            ...healthService.verifyRepairTargets('cleanup', [...approvedByAction.cleanup], verifyOpts),
            ...healthService.verifyWeakClusterPairs(approvedPairs).flatMap((pr) => [pr.a, pr.b]),
        ];
        const outcomes = computeOutcomes(affectedPaths, stillFiring, timedOutPaths, backlinksResult.yamlErrorPaths);

        // FEAT-19-05-01: im Batch-Modus mit erhoehtem Deckel, damit
        // getCheckTotals die echte Restmenge fuer den "Naechster Batch"-Knopf
        // liefert.
        const newFindings = await healthService.runChecks(undefined, buildHealthCheckOptions(
            this.plugin.settings, this.batchMode ? WEAK_CLUSTER_BATCH_LIMIT : undefined));
        // FIX-19-01-06: refresh the modal's internal copy of findings
        // so any subsequent render in the same lifecycle sees the
        // post-repair set (not the constructor-time snapshot).
        this.findings = newFindings;
        // FIX-19-01-19: die Auswahl zeigte per INDEX in das alte Array.
        // Nach dem Austausch (andere Laenge, andere Sortierung) haetten
        // dieselben Indizes auf fremde Befunde gezeigt.
        this.selectedFindings.clear();
        this.showResult(edgesResult, backlinksResult, categoriesResult, cleanupResult, weakLinkResult, newFindings, checkpoint, outcomes, timedOutPaths);
    }

    /**
     * FIX-19-01-04: drain Obsidian's `vault.on('modify')` event
     * queue for every touched file. processFrontMatter resolves on
     * disk write, but Obsidian dispatches the modify event on its
     * own microtask tick; the queue can leak modify events AFTER
     * we have already finished extractAll. If the
     * `vaultHealthRepairInProgress` flag is cleared before that
     * queue is empty, the global modify listener in main.ts runs
     * `graphExtractor.extractFile(file)` with STALE metadataCache
     * and overwrites the freshly-correct edges.
     *
     * We register a one-shot modify listener for the affected
     * paths and resolve when every path has fired at least once,
     * OR a 2-second hard timeout passes. The flag stays true for
     * the whole drain window.
     */
    private async waitForVaultModifyDrain(paths: string[]): Promise<void> {
        if (!paths.length) return;
        const pending = new Set(paths);
        const TIMEOUT_MS = 2000;
        await new Promise<void>((resolve) => {
            const cleanup = () => {
                this.app.vault.off('modify', onModify);
                window.clearTimeout(timer);
            };
            const onModify = (file: TFile) => {
                if (pending.delete(file.path) && pending.size === 0) {
                    cleanup();
                    resolve();
                }
            };
            this.app.vault.on('modify', onModify);
            const timer = window.setTimeout(() => {
                cleanup();
                resolve();
            }, TIMEOUT_MS);
        });
    }

    private showResult(
        edges: { edgesRemoved: number },
        backlinks: { entitiesFixed: number; linksAdded: number; yamlErrorPaths: string[] },
        categories: { notesFixed: number; valuesMovied: number },
        cleanup: { notesProcessed: number; linksRemoved: number },
        weakLinks: { pairsLinked: number; linksAdded: number; failedPairs?: Array<{ a: string; b: string }> },
        newFindings: HealthFinding[],
        checkpoint: CheckpointInfo | undefined,
        outcomes: RepairOutcomeEntry[],
        timedOutPaths: string[],
    ): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h3', { text: t('modal.vaultHealth.repairDone') });

        // ADR-166 / Phase 6: verifizierter Post-Zustand pro geplantem Ziel.
        // "fixed" heisst: das Praedikat feuert nach der Extraktion nicht
        // mehr. Zaehler weiter unten sind nur noch Detail-Info.
        if (outcomes.length > 0) {
            const fixed = outcomes.filter((o) => o.outcome === 'fixed').length;
            const still = outcomes.filter((o) => o.outcome === 'still_firing');
            const failed = outcomes.filter((o) => o.outcome === 'failed');
            const yaml = outcomes.filter((o) => o.outcome === 'skipped_yaml');

            const box = contentEl.createDiv({ cls: 'vault-health-outcomes' });
            box.createDiv({
                cls: 'vault-health-outcome-line',
                text: t('modal.vaultHealthRepair.outcomeSummary', {
                    fixed, total: outcomes.length,
                }),
            });
            const listProblems = (items: RepairOutcomeEntry[], key: string) => {
                if (items.length === 0) return;
                const grp = box.createDiv({ cls: 'vault-health-outcome-group' });
                grp.createDiv({ cls: 'vault-health-outcome-head', text: t(key, { count: items.length }) });
                for (const o of items.slice(0, 20)) {
                    grp.createDiv({ cls: 'vault-health-outcome-path', text: o.path });
                }
                if (items.length > 20) {
                    grp.createDiv({ cls: 'vault-health-outcome-path', text: t('modal.vaultHealthRepair.outcomeMore', { count: items.length - 20 }) });
                }
            };
            listProblems(still, 'modal.vaultHealthRepair.outcomeStillFiring');
            listProblems(failed, 'modal.vaultHealthRepair.outcomeFailed');
            // FIX-19-01-17: unbestaetigt heisst "Praedikat feuert noch UND
            // der Cache hat sich nicht gemeldet" -- nicht fehlgeschlagen.
            listProblems(
                outcomes.filter((o) => o.outcome === 'unconfirmed'),
                'modal.vaultHealthRepair.outcomeUnconfirmed',
            );
            listProblems(yaml, 'modal.vaultHealthRepair.outcomeYaml');
        }

        const results = contentEl.createEl('ul', { cls: 'vault-health-results' });

        if (edges.edgesRemoved > 0) {
            results.createEl('li', { text: t('modal.vaultHealth.resultEdges', { count: edges.edgesRemoved }) });
        }
        if (backlinks.linksAdded > 0) {
            results.createEl('li', {
                text: t('modal.vaultHealth.resultBacklinks', { entities: backlinks.entitiesFixed, links: backlinks.linksAdded }),
            });
        }
        // FIX-19-01-06: explicit transparency. The "0 links added" case
        // typically means the entity's YAML is broken. Show the YAML-error
        // list below so the user knows WHY a finding does not disappear.
        // FEAT-19-04-01 W2c: der "Base existierte bereits"-Zweig entfaellt --
        // die .base-Automatik ist abgeschaltet.
        if (backlinks.yamlErrorPaths.length > 0) {
            const li = results.createEl('li');
            li.appendText(t('modal.vaultHealthRepair.resultYamlErrors', { count: backlinks.yamlErrorPaths.length }));
            const sub = li.createEl('ul', { cls: 'vault-health-yaml-errors' });
            for (const p of backlinks.yamlErrorPaths.slice(0, 20)) {
                const item = sub.createEl('li');
                const link = item.createSpan({ cls: 'vault-health-note-link', text: this.formatPath(p) });
                link.addEventListener('click', () => {
                    this.close();
                    void this.app.workspace.openLinkText(p, '');
                });
            }
            if (backlinks.yamlErrorPaths.length > 20) {
                sub.createEl('li', { text: t('modal.vaultHealthRepair.resultYamlMore', { count: backlinks.yamlErrorPaths.length - 20 }) });
            }
            li.createEl('p', {
                text: t('modal.vaultHealthRepair.resultYamlNote'),
                cls: 'vault-health-result-note',
            });
        }
        if (categories.notesFixed > 0) {
            results.createEl('li', { text: t('modal.vaultHealth.resultCategories', { count: categories.notesFixed }) });
        }
        if (cleanup.linksRemoved > 0) {
            results.createEl('li', { text: t('modal.vaultHealth.resultInvalidLinks', { count: cleanup.linksRemoved }) });
        }
        if (weakLinks.pairsLinked > 0) {
            results.createEl('li', { text: t('modal.vaultHealthRepair.resultWeakLinks', { pairs: weakLinks.pairsLinked, links: weakLinks.linksAdded }) });
        }
        // FIX-19-02-26: gescheiterte Paare benennen, statt sie als "nichts
        // passiert" zu verbuchen. Die A-Seite ist zurueckgenommen, die
        // Notizen sind also unveraendert -- aber der Nutzer soll wissen,
        // dass hier etwas NICHT erledigt wurde.
        if ((weakLinks.failedPairs?.length ?? 0) > 0) {
            results.createEl('li', {
                cls: 'vault-health-run-failed',
                text: t('modal.vaultHealthRepair.resultWeakFailed', { count: weakLinks.failedPairs?.length ?? 0 }),
            });
        }

        const totalFixes = edges.edgesRemoved + backlinks.linksAdded +
            categories.valuesMovied + cleanup.linksRemoved + weakLinks.linksAdded;

        // FIX-19-02-25: Plan und Ergebnis an EINEN Nenner haengen.
        //
        // Der Plan sprach von 66 Aenderungen, das Ergebnis von "41
        // entities" und "8 pairs" -- drei Zahlen ohne erkennbaren Bezug.
        // Der Nutzer musste raten, ob 41 gut oder schlecht ist. Diese Zeile
        // sagt, wie viele der GEPLANTEN Aenderungen wirklich geschrieben
        // haben, und dass der Rest kein Fehlschlag ist: ob eine Datei
        // wirklich etwas zu tun hat, weiss der Check erst, wenn er sie
        // aufmacht.
        const appliedChanges = backlinks.entitiesFixed
            + categories.notesFixed + cleanup.notesProcessed + weakLinks.pairsLinked;
        if (this.lastPlannedChangeCount > 0) {
            contentEl.createEl('p', {
                cls: 'vault-health-result-vs-plan',
                text: t('modal.vaultHealthRepair.resultVsPlan', {
                    planned: this.lastPlannedChangeCount,
                    applied: appliedChanges,
                }),
            });
        }

        // Remaining findings
        const remainingRepairable = newFindings.filter(isRepairableFinding).length;
        const totalRemaining = newFindings.length;

        if (totalFixes === 0) {
            // FIX-19-01-14: "All clean" war unabhaengig davon, ob noch etwas
            // Reparierbares uebrig ist. Der Nutzer las "No repairs needed. All
            // clean." und direkt darunter "20 repairable" -- die Meldung
            // widersprach der Zeile unter ihr. Null Fixes heisst nicht sauber,
            // es heisst nur, dass dieser Durchlauf nichts geaendert hat.
            const recheckFailed = this.plugin.vaultHealthService?.getLastRunStatus() === 'failed';
            contentEl.createEl('p', {
                text: recheckFailed
                    // FIX-19-02-21: "All clean" nach einem abgestuerzten
                    // Nachlauf ist die gefaehrlichste Meldung im ganzen
                    // Ablauf -- sie beendet das Nachsehen.
                    ? t('modal.vaultHealthRepair.recheckFailed')
                    : remainingRepairable > 0
                        ? t('modal.vaultHealthRepair.noChangesButRepairable', { count: remainingRepairable })
                        : t('modal.vaultHealth.noRepairsNeeded'),
            });
        }
        // FIX-19-02-21: keine Entwarnung ohne gueltigen Nachlauf.
        //
        // Bricht der Re-Check ab, liefert er ein leeres Array, und dieselbe
        // Zeile behauptete daraufhin "Remaining: 0 finding(s)" -- direkt
        // unter der Liste der Ziele, die den Befund noch melden. Der Nutzer
        // sah einen Widerspruch und hatte recht damit.
        if (this.plugin.vaultHealthService?.getLastRunStatus() === 'failed') {
            contentEl.createEl('p', {
                cls: 'vault-health-remaining vault-health-run-failed',
                text: t('modal.vaultHealthRepair.recheckFailed'),
            });
        } else {
            contentEl.createEl('p', {
                cls: 'vault-health-remaining',
                text: t('modal.vaultHealthRepair.remainingSummary', { total: totalRemaining, repairable: remainingRepairable }),
            });
        }

        // FIX-19-02-31: den Deckel-Nachrueck AUCH hier benennen.
        //
        // Live-Log: der Nutzer reparierte 20 von 1067 offenen weak-Paaren,
        // die Writes waren real (fixed 40/40), aber die Gesamtzahl stand
        // still, weil der 20er-Deckel sofort 20 nachfuellt. Der
        // Overflow-Hinweis existierte nur in der Findings-Landeansicht --
        // also einen Screen zu spaet. Der Ergebnis-Screen ist das ERSTE
        // nach dem Repair; ohne diese Zeile liest sich die stehende Zahl als
        // "rueckgaengig gemacht", obwohl daneben "fixed" steht.
        const weakTotals = this.plugin.vaultHealthService?.getCheckTotals()?.weakClusters;
        if (weakTotals && weakTotals.total > weakTotals.shown) {
            contentEl.createEl('p', {
                cls: 'vault-health-remaining vault-health-outcome-overflow',
                text: t('modal.vaultHealthRepair.outcomeOverflow', {
                    linked: weakLinks.pairsLinked,
                    shown: weakTotals.shown,
                    total: weakTotals.total,
                }),
            });
        }

        // Buttons
        const btnRow = contentEl.createDiv('vault-health-btn-row');

        // FIX-19-01-19: der Ergebnis-Screen war eine Sackgasse (nur Undo
        // und Done, und Done schliesst das Modal). Die Zusage "die Liste
        // aktualisiert sich" war damit nicht einloesbar, ohne das Modal
        // neu zu oeffnen.
        const backBtn = btnRow.createEl('button', { text: t('modal.vaultHealthRepair.resultBackToFindings') });
        backBtn.addEventListener('click', () => {
            this.batchMode = false; // manueller Ausstieg aus dem Batch
            void this.refreshAndShowFindings();
        });

        // FEAT-19-05-01: "Naechsten Batch reparieren (N)". Nur wenn noch
        // weak-Paare hinter dem Deckel warten. Ein Klick pro Batch -- jeder
        // laeuft durch die volle Plan-Freigabe, jeder ist einzeln undo-bar.
        if (weakTotals && weakTotals.total > weakTotals.shown) {
            const nextBtn = btnRow.createEl('button', {
                cls: 'mod-cta vault-health-next-batch-btn',
                text: t('modal.vaultHealthRepair.nextBatch', { total: weakTotals.total }),
            });
            nextBtn.addEventListener('click', () => {
                nextBtn.disabled = true;
                nextBtn.setText(t('modal.vaultHealth.repairing'));
                void this.runBatchRepair();
            });
        }

        if (checkpoint && totalFixes > 0) {
            const undoBtn = btnRow.createEl('button', {
                text: t('modal.vaultHealth.undoBtn'),
                cls: 'mod-warning',
            });
            undoBtn.addEventListener('click', () => {
                void this.runUndo(checkpoint);
            });
        }

        const doneBtn = btnRow.createEl('button', { text: t('modal.vaultHealth.doneBtn'), cls: 'mod-cta' });
        doneBtn.addEventListener('click', () => {
            this.updateBadge(newFindings);
            this.close();
        });
    }

    // -----------------------------------------------------------------------
    // Undo
    // -----------------------------------------------------------------------

    private async runUndo(checkpoint: CheckpointInfo): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: t('modal.vaultHealth.restoring') });

        try {
            const result = await this.plugin.checkpointService.restore(checkpoint);

            contentEl.empty();
            contentEl.createEl('h3', { text: t('modal.vaultHealth.restored') });
            contentEl.createEl('p', {
                text: t('modal.vaultHealth.restoredCount', { count: result.restored.length }),
            });

            if (result.errors.length > 0) {
                contentEl.createEl('p', {
                    cls: 'vault-health-error',
                    text: t('modal.vaultHealth.errors', { count: result.errors.length, errors: result.errors.join(', ') }),
                });
            }

            // Re-extract graph after restore. FEAT-19-04-01 W3: awaiten --
            // bootstrapFromEdges und runChecks lesen die Kanten danach.
            if (this.plugin.graphExtractor) {
                await this.plugin.graphExtractor.extractAll(this.app.vault);
            }
            if (this.plugin.ontologyStore) {
                const catProp = this.plugin.settings.categoryProperty ?? OKF_DEFAULTS.categoryProperty;
                const categoryMap = new Map<string, string>();
                for (const file of this.app.vault.getMarkdownFiles()) {
                    const cache = this.app.metadataCache.getFileCache(file);
                    if (cache?.frontmatter?.[catProp]) {
                        const cat = Array.isArray(cache.frontmatter[catProp])
                            ? (cache.frontmatter[catProp][0] ?? '').toString().trim()
                            : cache.frontmatter[catProp].toString().trim();
                        if (cat) categoryMap.set(file.path, cat);
                    }
                }
                this.plugin.ontologyStore.bootstrapFromEdges(
                    this.plugin.settings.mocPropertyNames ?? [],
                    catProp,
                    categoryMap,
                );
            }

            const findings = await this.plugin.vaultHealthService?.runChecks(undefined, buildHealthCheckOptions(this.plugin.settings)) ?? [];
            this.updateBadge(findings);

            const doneBtn = contentEl.createEl('button', { text: t('modal.vaultHealth.doneBtn'), cls: 'mod-cta' });
            doneBtn.addEventListener('click', () => this.close());
        } catch (e) {
            contentEl.empty();
            contentEl.createEl('h3', { text: t('modal.vaultHealth.restoreFailed') });
            contentEl.createEl('p', {
                cls: 'vault-health-error',
                text: e instanceof Error ? e.message : String(e),
            });
            const closeBtn = contentEl.createEl('button', { text: t('modal.vaultHealth.closeBtn') });
            closeBtn.addEventListener('click', () => this.close());
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * FIX-19-01-19: zwei konkurrierende Badge-Schreiber mit
     * unterschiedlicher Severity-Regel und unterschiedlicher
     * Leaf-Abdeckung (hier nur leaves[0], im Push aus main.ts alle).
     * Wer zuletzt schrieb, gewann -- der Badge zeigte je nach Reihenfolge
     * etwas anderes als die Liste. Der Push aus main.ts
     * (onFindingsUpdated) feuert bei jedem runChecks ohnehin und ist
     * jetzt der einzige Schreiber; diese Methode bleibt als No-op-Huelle
     * fuer die drei Aufrufstellen.
     */
    private updateBadge(findings: HealthFinding[]): void {
        void findings; // Badge kommt aus onFindingsUpdated (main.ts).
    }
}

/* eslint-enable -- end of file-level disable for boundary code (SDK/JSON/Obsidian internals) */
