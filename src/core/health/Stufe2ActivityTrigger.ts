/**
 * Stufe2ActivityTrigger (FEAT-19-19)
 *
 * Vault-Event-Listener fuer Stufe-2 des 3-Stufen-Lint-Stacks (BA-25
 * Section 12.2). Bei Note-Open/Modify in einem reifen Cluster: dezenter
 * Hint im UI mit Klick-Trigger fuer Light-Web-Search-Update-Pass.
 *
 * Reife = Cluster-Freshness-Score < hintThreshold (default 70).
 * Cooldown: pro Cluster max 1 Hint pro 7 Tage, plus globaler Daily-Cap.
 *
 * Web-Search-Action wird vom UI-Callback uebernommen (nicht direkt
 * im Trigger), damit User-Decision explizit bleibt.
 */

import { TFile, type App } from 'obsidian';
import type { ClusterMetadataStore } from '../knowledge/ClusterMetadataStore';
import type { KnowledgeDB } from '../knowledge/KnowledgeDB';
import { clusterFreshnessScore } from './clusterFreshnessScore';

export type StufeHintCallback = (info: {
    cluster: string;
    file: TFile;
    score: number;
    daysSinceLastCheck: number | null;
}) => void;

export interface Stufe2Options {
    enabled: boolean;
    /** Default 70: Score-Schwelle ab der Hint feuert. */
    hintThresholdScore?: number;
    /** Default 30 Tage: kein Hint wenn letzter externer Check juenger. */
    minDaysSinceCheck?: number;
    /** Default 7 Tage: pro-Cluster Cooldown. */
    perClusterCooldownDays?: number;
    /** Default 5: max Hints pro Tag (global). */
    maxHintsPerDay?: number;
}

export class Stufe2ActivityTrigger {
    private listeners: Array<() => void> = [];
    private dailyHintCount = 0;
    private dailyHintDay = ''; // YYYY-MM-DD reset marker
    private opts: Required<Stufe2Options>;

    constructor(
        private readonly app: App,
        private readonly knowledgeDB: KnowledgeDB,
        private readonly clusterMetadataStore: ClusterMetadataStore,
        private readonly onHint: StufeHintCallback,
        options: Stufe2Options,
    ) {
        this.opts = {
            enabled: options.enabled,
            hintThresholdScore: options.hintThresholdScore ?? 70,
            minDaysSinceCheck: options.minDaysSinceCheck ?? 30,
            perClusterCooldownDays: options.perClusterCooldownDays ?? 7,
            maxHintsPerDay: options.maxHintsPerDay ?? 5,
        };
    }

    start(): void {
        if (!this.opts.enabled || this.listeners.length > 0) return;
        const onOpen = this.app.workspace.on('file-open', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                void this.maybeHint(file);
            }
        });
        const onModify = this.app.vault.on('modify', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                void this.maybeHint(file);
            }
        });
        this.listeners.push(
            () => this.app.workspace.offref(onOpen),
            () => this.app.vault.offref(onModify),
        );
    }

    stop(): void {
        for (const off of this.listeners) {
            try { off(); } catch { /* noop */ }
        }
        this.listeners = [];
    }

    /** Public fuer Tests. Returns true wenn Hint gefeuert. */
    // eslint-disable-next-line @typescript-eslint/require-await -- async kept for future LLM-backed hint resolution
    async maybeHint(file: TFile): Promise<boolean> {
        if (!this.opts.enabled) return false;
        if (!this.knowledgeDB.isOpen()) return false;

        try {
            // Daily-Cap-Reset
            const today = new Date().toISOString().slice(0, 10);
            if (today !== this.dailyHintDay) {
                this.dailyHintCount = 0;
                this.dailyHintDay = today;
            }
            if (this.dailyHintCount >= this.opts.maxHintsPerDay) return false;

            // Cluster-Lookup via Ontologie
            const db = this.knowledgeDB.getDB();
            const r = db.exec(`SELECT cluster FROM ontology WHERE entity_path = ? ORDER BY confidence DESC LIMIT 1`,
                [file.path]);
            if (!r.length || !r[0].values.length) return false;
            const cluster = r[0].values[0][0] as string;

            const meta = this.clusterMetadataStore.get(cluster);
            if (!meta) return false;

            // Per-Cluster Cooldown
            if (meta.lastHintAt) {
                const ageMs = Date.now() - new Date(meta.lastHintAt).getTime();
                const cooldownMs = this.opts.perClusterCooldownDays * 86_400_000;
                if (ageMs < cooldownMs) return false;
            }

            // Min-Tage seit lastExternalCheck
            let daysSinceCheck: number | null = null;
            if (meta.lastExternalCheck) {
                daysSinceCheck = (Date.now() - new Date(meta.lastExternalCheck).getTime()) / 86_400_000;
                if (daysSinceCheck < this.opts.minDaysSinceCheck) return false;
            }

            // FIX-19-16-05: geteilte Formel statt der dritten Inline-Kopie.
            // Die alte hier (`0.6*(1-ratio) + 0.3 + 0.1`) hatte zwei konstante
            // Terme und konnte nie unter 40 fallen -- die Schwelle 70 war erst
            // ab halber Halbwertszeit erreichbar, und der Hint feuerte auf dem
            // Live-Vault kein einziges Mal (last_hint_at ueberall NULL).
            const halfLife = meta.halfLifeDays;
            if (halfLife <= 0) return false; // Personal-Cluster, statisch
            const memberPaths = this.fetchClusterMembers(cluster);
            const { avgAge, coverageDrift } = this.computeAgeStats(memberPaths, halfLife);
            const score = clusterFreshnessScore(avgAge, halfLife, coverageDrift);

            if (score >= this.opts.hintThresholdScore) return false;

            // Fire hint
            this.dailyHintCount++;
            this.clusterMetadataStore.setLastHintAt(cluster, new Date().toISOString());
            this.onHint({ cluster, file, score, daysSinceLastCheck: daysSinceCheck });
            return true;
        } catch (err) {
            // FIX-19-19-01: any DB error inside the hint pipeline used to leak
            // as an unhandled rejection through `void this.maybeHint(file)` in
            // the vault-event hooks. Log once, swallow, never block the editor.
            console.warn('[Stufe2ActivityTrigger] maybeHint failed:', err);
            return false;
        }
    }

    private fetchClusterMembers(cluster: string): string[] {
        const db = this.knowledgeDB.getDB();
        const r = db.exec(`SELECT entity_path FROM ontology WHERE cluster = ?`, [cluster]);
        if (!r.length) return [];
        return r[0].values.map((row) => row[0] as string);
    }

    private computeAvgAge(paths: string[]): number {
        return this.computeAgeStats(paths, Number.POSITIVE_INFINITY).avgAge;
    }

    /**
     * FIX-19-16-05: liefert neben dem Durchschnittsalter auch den
     * Coverage-Drift (Anteil der Notizen ueber der Halbwertszeit), den die
     * geteilte Score-Formel als zweiten Term braucht. Eine Query, Zaehlung
     * in JS -- die per-Pfad-Maxima sind dieselbe Datenmenge, die die alte
     * AVG-Query intern schon bildete.
     */
    private computeAgeStats(paths: string[], halfLifeDays: number): { avgAge: number; coverageDrift: number } {
        if (paths.length === 0) return { avgAge: 0, coverageDrift: 0 };
        const db = this.knowledgeDB.getDB();
        const placeholders = paths.map(() => '?').join(',');
        // FIX-19-19-01: MAX(mtime) pro Pfad via GROUP BY (kein verschachteltes
        // Aggregat, sql.js lehnt AVG(MAX(...)) ab).
        // eslint-disable-next-line no-restricted-syntax -- reason: ADR-137 exception, per-path MAX(mtime) needs raw SQL, refactor tracked separately
        const r = db.exec(`SELECT path, MAX(mtime) AS mtime FROM vectors WHERE path IN (${placeholders}) GROUP BY path`,
            paths);
        const rows = r[0]?.values ?? [];
        const now = Date.now();
        let totalAge = 0;
        let stale = 0;
        let counted = 0;
        for (const row of rows) {
            const mtime = row[1] as number | null;
            if (!mtime) continue;
            const ageDays = (now - mtime) / 86_400_000;
            totalAge += ageDays;
            if (ageDays > halfLifeDays) stale++;
            counted++;
        }
        if (counted === 0) return { avgAge: 0, coverageDrift: 0 };
        return { avgAge: totalAge / counted, coverageDrift: stale / counted };
    }
}
