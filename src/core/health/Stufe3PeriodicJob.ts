/**
 * Stufe3PeriodicJob -- wochentlicher Background-Job mit hartem
 * Token-Budget-Cap.
 *
 * Backs FEAT-19-20 (Periodischer Lint) plus FEAT-19-21 (Hot-Cluster).
 * ADR-105: setInterval mit Cooldown-Persistenz, Hard-Cap mit
 * 80%-Notification, kalender-wochentlich Reset Montag 0:00.
 *
 * Pipeline:
 *   1. Iteration ueber Hot-Clusters (sortiert nach Freshness-Score asc).
 *   2. Pro Cluster: Semantic-Pre-Filter LLM-Call (yes/no/unsure).
 *   3. Bei yes/unsure: Light-Web-Search-Pass plus LLM-Synthese.
 *   4. Strong-Signal-Filter (min N unabhaengige Sources).
 *   5. Notification gesammelt.
 *
 * LLM-Call und Web-Search sind als Hooks injiziert (kein direktes
 * Coupling). Token-Counter pro Call.
 */

import { STUFE3_STATE_ROW_CLUSTER } from '../knowledge/ClusterMetadataStore';
import type { ClusterMetadataStore, ClusterMetadataRecord } from '../knowledge/ClusterMetadataStore';
import type { KnowledgeDB } from '../knowledge/KnowledgeDB';

export interface PreFilterResult { decision: 'yes' | 'no' | 'unsure'; tokensUsed: number; }
export interface UpdateFinding {
    cluster: string;
    title: string;
    summary: string;
    sources: string[]; // url-list
    detectedAt: string;
    strongSignal: boolean;
    /**
     * Optional per-note verdicts attached to this cluster finding.
     * Populated by the FreshnessVerifier wiring from IMP-20-06-01.
     * Existing notification sinks that only consume cluster-level
     * fields ignore this; the Knowledge-review tab reads it.
     * Additive per ADR-105 amendment 2026-06-19.
     */
    notes?: import('./types').NoteVerdict[];
}

export interface WebUpdatePassResult {
    findings: UpdateFinding[];
    tokensUsed: number;
}

export type PreFilterFn = (cluster: ClusterMetadataRecord) => Promise<PreFilterResult>;
export type WebUpdatePassFn = (cluster: ClusterMetadataRecord) => Promise<WebUpdatePassResult>;
export type NotificationSink = (findings: UpdateFinding[]) => void;
export type BudgetExceededSink = (info: { spentUsd: number; budgetUsd: number }) => void;

/**
 * FEAT-19-03-01: liefert die zu scannenden Cluster in Reihenfolge.
 *
 * Ersetzt die feste getHotClusters-Quelle. Im Produktivpfad kombiniert der
 * Aufrufer getAll + faellige Notizzahlen + selectDueClusters, sodass der
 * Lauf den GANZEN Vault alterungsgesteuert abdeckt statt einer Handauswahl.
 * Fehlt die Funktion, faellt der Job auf getHotClusters zurueck (haelt die
 * Alt-Tests und jeden Aufrufer ohne Umbau am Leben).
 */
export type ClusterSelectorFn = () => ClusterMetadataRecord[];

export interface Stufe3JobOptions {
    /**
     * Default 2.0 USD pro Woche. Statischer Fallback.
     * FEAT-19-03-01: `weeklyBudgetGetter` hat Vorrang, wenn gesetzt, damit
     * eine Settings-Aenderung sofort greift (ADR-163, kein Boot-Snapshot).
     */
    weeklyBudgetUsd: number;
    /** FEAT-19-03-01: Live-Budget aus den Settings; ueberschreibt weeklyBudgetUsd. */
    weeklyBudgetGetter?: () => number;
    /** Default 0.8: Notification ab 80%. */
    notificationThreshold: number;
    /** Wenn dryRun true: Web-Search/LLM-Calls werden simuliert (Zero-Cost). */
    dryRun?: boolean;
    /** Tokens-zu-USD-Konversion. Default: konservative Sonnet-Klasse-Schaetzung. */
    tokensPerUsd?: number;
    /**
     * FIX-19-16-04: echte Kostenschaetzung aus dem Preiskatalog des aktuell
     * konfigurierten Modells. Hat Vorrang vor tokensPerUsd; ein nicht-endlicher
     * oder negativer Rueckgabewert faellt auf die Konstante zurueck. main.ts
     * verdrahtet computeCost() mit einer input-lastigen Aufteilung, weil der
     * Verifier-Traffic (4000 Zeichen Notiz-Body plus URLs im Prompt, kurzes
     * JSON als Antwort) vom Input dominiert wird.
     */
    estimateUsd?: (tokens: number) => number;
}

export interface Stufe3JobState {
    weekStartIso: string; // ISO date of monday-week-start (UTC)
    spentUsd: number;
    notifiedAt80Percent: boolean;
}

export interface Stufe3RunResult {
    clustersProcessed: number;
    findingsCount: number;
    spentUsd: number;
    budgetExceeded: boolean;
    state: Stufe3JobState;
    /**
     * FIX-19-16-07: das Sichtfenster des Laufs. Ein Lauf, in dem der
     * Pre-Filter jeden Cluster mit "no" beantwortet, war vorher von "nie
     * gelaufen" nicht unterscheidbar (der Live-Lauf vom 19.08.: 149 Cluster,
     * 0 History-Zeilen, 0 Notices). Diese Zaehlung plus reportFindings
     * speist den Bericht und die Abschluss-Notice.
     */
    decisions: { yes: number; no: number; unsure: number };
    /** ALLE Findings des Laufs, auch ohne strongSignal (Notice filtert weiter). */
    reportFindings: UpdateFinding[];
    /** Anzahl der Note-Verdicts ueber alle Findings. */
    verdictCount: number;
}

// FIX-19-16-04: der alte Wert (660_000, eine Haiku-Input-Schaetzung) rechnete
// den realen Lauf um eine Groessenordnung schoen: der Verifier laeuft auf dem
// Haupt-Loop-Modell (im Live-Vault durchgehend Sonnet), input-lastig. 200_000
// entspricht grob einer Sonnet-Klasse-Mischung aus 85% Input und 15% Output.
// Der Katalog-Pfad (options.estimateUsd) hat Vorrang; diese Konstante ist nur
// noch der Fallback ohne Katalog.
const DEFAULT_TOKENS_PER_USD = 200_000;

/**
 * AUDIT-014 Info-1 (IMP-19-20-01): persistent state via dedicated row
 * in cluster_metadata. Reserved cluster-name guarantees no collision
 * with real clusters; custom_weights JSON-Spalte wird als state-blob
 * verwendet. Vermeidet Schema-Migration v10 -> v11.
 */
// FIX-19-02-01: Name kommt jetzt aus dem Store, der ihn auch ausfiltert.
// Zwei Literale waeren zwei Wahrheiten -- driftet eines, taucht die
// Zustandszeile als erfundener Cluster in den Settings auf.
const STATE_ROW_CLUSTER = STUFE3_STATE_ROW_CLUSTER;

export interface Stufe3StatePersistence {
    load(): Stufe3JobState | null;
    save(state: Stufe3JobState): void;
}

/** Default-Persistence ueber cluster_metadata-Row mit reserviertem Namen. */
export class ClusterMetadataStatePersistence implements Stufe3StatePersistence {
    constructor(private readonly knowledgeDB: KnowledgeDB) {}
    load(): Stufe3JobState | null {
        if (!this.knowledgeDB.isOpen()) return null;
        const db = this.knowledgeDB.getDB();
        const r = db.exec(
            `SELECT custom_weights FROM cluster_metadata WHERE cluster = ?`,
            [STATE_ROW_CLUSTER],
        );
        if (!r.length || !r[0].values.length) return null;
        const raw = r[0].values[0][0] as string | null;
        if (!raw) return null;
        try {
            return JSON.parse(raw) as Stufe3JobState;
        } catch {
            return null;
        }
    }
    save(state: Stufe3JobState): void {
        if (!this.knowledgeDB.isOpen()) return;
        const db = this.knowledgeDB.getDB();
        db.run(
            `INSERT INTO cluster_metadata (cluster, half_life_days, custom_weights) VALUES (?, ?, ?)
             ON CONFLICT(cluster) DO UPDATE SET custom_weights = excluded.custom_weights`,
            [STATE_ROW_CLUSTER, 0, JSON.stringify(state)],
        );
        this.knowledgeDB.markDirty();
    }
}

export class Stufe3PeriodicJob {
    private state: Stufe3JobState;

    constructor(
        private readonly clusterMetadataStore: ClusterMetadataStore,
        private readonly preFilter: PreFilterFn,
        private readonly webUpdatePass: WebUpdatePassFn,
        private readonly notificationSink: NotificationSink,
        private readonly options: Stufe3JobOptions,
        initialState?: Stufe3JobState,
        private readonly budgetExceededSink?: BudgetExceededSink,
        private readonly persistence?: Stufe3StatePersistence,
        /**
         * FEAT-19-03-01: vault-weite, alterungspriorisierte Kandidatenquelle.
         * Fehlt sie, bleibt es beim alten Hot-Cluster-Verhalten.
         */
        private readonly selectClusters?: ClusterSelectorFn,
    ) {
        this.state = initialState ?? this.persistence?.load() ?? this.freshState();
    }

    /** Sollte beim Plugin-Onload aufgerufen werden bevor run() laeuft. */
    rolloverIfNewWeek(): void {
        const currentWeekStart = mondayOfWeek(new Date()).toISOString();
        if (currentWeekStart !== this.state.weekStartIso) {
            this.state = { weekStartIso: currentWeekStart, spentUsd: 0, notifiedAt80Percent: false };
            this.persistence?.save(this.state);
        }
    }

    getState(): Stufe3JobState { return { ...this.state }; }

    /** Single Pass. setInterval-Wrapper liegt im Plugin. */
    async run(): Promise<Stufe3RunResult> {
        this.rolloverIfNewWeek();
        const result: Stufe3RunResult = {
            clustersProcessed: 0,
            findingsCount: 0,
            spentUsd: 0,
            budgetExceeded: false,
            state: this.state,
            decisions: { yes: 0, no: 0, unsure: 0 },
            reportFindings: [],
            verdictCount: 0,
        };

        // FEAT-19-03-01: die Kandidaten kommen aus der injizierten Quelle
        // (vault-weit, alterungspriorisiert). Ohne sie das alte Verhalten:
        // nur hot markierte Cluster, oldest-first.
        let candidates: ClusterMetadataRecord[];
        if (this.selectClusters) {
            candidates = this.selectClusters();
        } else {
            candidates = this.clusterMetadataStore.getHotClusters();
            candidates.sort((a, b) => {
                const ta = a.lastExternalCheck ? new Date(a.lastExternalCheck).getTime() : 0;
                const tb = b.lastExternalCheck ? new Date(b.lastExternalCheck).getTime() : 0;
                return ta - tb;
            });
        }

        const allFindings: UpdateFinding[] = [];

        for (const cluster of candidates) {
            if (this.budgetReached()) {
                result.budgetExceeded = true;
                break;
            }

            // Step 1: Pre-Filter
            const pre = await this.preFilter(cluster);
            this.spendTokens(pre.tokensUsed);
            result.decisions[pre.decision]++;
            if (this.budgetReached()) { result.budgetExceeded = true; break; }
            if (pre.decision === 'no') {
                result.clustersProcessed++;
                continue;
            }

            // Step 2: Web-Update-Pass
            const webResult = await this.webUpdatePass(cluster);
            this.spendTokens(webResult.tokensUsed);
            this.clusterMetadataStore.setLastExternalCheck(cluster.cluster, new Date().toISOString());

            // Step 3: Strong-Signal-Filter (Notice); der Bericht sieht alles.
            for (const finding of webResult.findings) {
                result.reportFindings.push(finding);
                result.verdictCount += finding.notes?.length ?? 0;
                if (finding.strongSignal) allFindings.push(finding);
            }
            result.clustersProcessed++;

            if (this.budgetReached()) { result.budgetExceeded = true; break; }
        }

        if (allFindings.length > 0) {
            this.notificationSink(allFindings);
        }

        result.findingsCount = allFindings.length;
        result.spentUsd = this.state.spentUsd;
        result.state = { ...this.state };
        return result;
    }

    private spendTokens(tokens: number): void {
        // FIX-19-16-04: Katalogpreis des echten Modells zuerst; die Konstante
        // ist der Fallback. Ein kaputter Estimator (NaN, negativ) faellt
        // sicher zurueck statt das Budget einzufrieren oder zu sprengen.
        let cost: number | null = null;
        if (this.options.estimateUsd) {
            const est = this.options.estimateUsd(tokens);
            if (typeof est === 'number' && Number.isFinite(est) && est >= 0) cost = est;
        }
        if (cost === null) {
            const tokensPerUsd = this.options.tokensPerUsd ?? DEFAULT_TOKENS_PER_USD;
            cost = tokens / tokensPerUsd;
        }
        this.state.spentUsd += cost;
        const budget = this.weeklyBudget();
        const ratio = this.state.spentUsd / budget;
        if (!this.state.notifiedAt80Percent && ratio >= this.options.notificationThreshold) {
            this.state.notifiedAt80Percent = true;
            this.budgetExceededSink?.({ spentUsd: this.state.spentUsd, budgetUsd: budget });
        }
        // AUDIT-014 IMP-19-20-01: persist state nach jeder Spending-Operation
        // damit Plugin-Reload mid-week das Budget korrekt fortfuehrt.
        this.persistence?.save(this.state);
    }

    /**
     * FEAT-19-03-01: das aktuell geltende Wochenbudget. Live-Getter hat
     * Vorrang, sonst der statische Options-Wert. Ein nicht-endlicher oder
     * nicht-positiver Getter-Wert faellt sicher auf den Options-Wert zurueck.
     */
    private weeklyBudget(): number {
        const live = this.options.weeklyBudgetGetter?.();
        if (typeof live === 'number' && Number.isFinite(live) && live > 0) return live;
        return this.options.weeklyBudgetUsd;
    }

    private budgetReached(): boolean {
        return this.state.spentUsd >= this.weeklyBudget();
    }

    private freshState(): Stufe3JobState {
        return {
            weekStartIso: mondayOfWeek(new Date()).toISOString(),
            spentUsd: 0,
            notifiedAt80Percent: false,
        };
    }
}

/** Berechnet Montag 0:00 UTC der Wochenwoche fuer ein gegebenes Datum. */
export function mondayOfWeek(d: Date): Date {
    const date = new Date(d.getTime());
    const day = date.getUTCDay(); // 0=So, 1=Mo, ..., 6=Sa
    const diff = day === 0 ? -6 : 1 - day; // shift to Monday
    date.setUTCDate(date.getUTCDate() + diff);
    date.setUTCHours(0, 0, 0, 0);
    return date;
}
