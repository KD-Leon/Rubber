/**
 * ClusterMetadataStore -- Per-Cluster Halbwertszeit + Hot-Cluster + Cooldown.
 *
 * Backs FEAT-15-12 (Halbwertszeit) und ADR-94 (statische Default-Liste,
 * pro Cluster ueberschreibbar) plus ADR-106 (last_hint_at-Cooldown).
 *
 * Reads from and writes to `cluster_metadata` (knowledge.db v10, ADR-92).
 */

import type { KnowledgeDB } from './KnowledgeDB';

export interface ClusterMetadataRecord {
    cluster: string;
    halfLifeDays: number;
    customWeights: Record<string, number> | null;
    lastExternalCheck: string | null;
    lastHintAt: string | null;
    hotCluster: boolean;
}

export type ClusterCategory = 'tech' | 'wissenschaft' | 'politik' | 'geschichte' | 'personal';

/**
 * ADR-94: statische Default-Halbwertszeit pro Cluster-Kategorie.
 * Tech 6 Monate, Wissenschaft 12 Monate, Politik 1 Monat, Geschichte
 * 24 Monate, Personal nie (statisch). User kann pro Cluster
 * ueberschreiben.
 */
export const HALF_LIFE_DEFAULTS: Record<ClusterCategory, number> = {
    tech: 180,
    wissenschaft: 365,
    politik: 30,
    geschichte: 730,
    personal: 0,
};

/** Heuristische Cluster-Name-zu-Kategorie-Erkennung (ADR-94). */
const CATEGORY_KEYWORDS: Record<ClusterCategory, string[]> = {
    tech: ['tech', 'software', 'ai', 'code', 'programming', 'dev', 'engineering'],
    wissenschaft: ['wissenschaft', 'science', 'research', 'forschung', 'paper', 'studie'],
    politik: ['politik', 'politics', 'news', 'wirtschaft', 'economy', 'aktuell'],
    geschichte: ['geschichte', 'history', 'philosophie', 'philosophy', 'antike'],
    personal: ['personal', 'self', 'reflection', 'journal', 'tagebuch', 'persoenlich'],
};

export function detectCategory(clusterName: string): { category: ClusterCategory; halfLifeDays: number } {
    const name = clusterName.toLowerCase();
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as Array<[ClusterCategory, string[]]>) {
        if (keywords.some((kw) => name.includes(kw))) {
            return { category, halfLifeDays: HALF_LIFE_DEFAULTS[category] };
        }
    }
    // Fallback: Tech-Default (180d)
    return { category: 'tech', halfLifeDays: HALF_LIFE_DEFAULTS.tech };
}

/**
 * Stufe3PeriodicJob parkt seinen Laufzeit-Zustand als Pseudo-Zeile in
 * derselben Tabelle (custom_weights traegt das JSON). Die Zeile ist kein
 * Cluster und darf in keiner Cluster-Liste auftauchen -- weder in den
 * Settings noch als Kandidat fuer den Freshness-Lauf.
 *
 * Single source of truth: Stufe3PeriodicJob importiert die Konstante von
 * hier, damit Filter und Schreiber nicht auseinanderlaufen koennen.
 */
export const STUFE3_STATE_ROW_CLUSTER = '__stufe3_job_state__';
const INTERNAL_ROWS = new Set<string>([STUFE3_STATE_ROW_CLUSTER]);

/** SQL-Fragment, das die internen Pseudo-Zeilen ausblendet. */
const NOT_INTERNAL = `cluster NOT IN ('${STUFE3_STATE_ROW_CLUSTER}')`;

export class ClusterMetadataStore {
    constructor(private readonly knowledgeDB: KnowledgeDB) {}

    /**
     * FIX-19-02-01: traegt jeden Cluster aus der Ontologie in die Registry
     * nach, sofern er dort noch fehlt.
     *
     * Ohne diese Bruecke bleibt `cluster_metadata` leer, obwohl die
     * Community-Detection laengst Cluster gefunden hat -- und der
     * Knowledge Review kann sich strukturell nie fuellen (Kette im
     * Testkopf). Bewusst konservativ: bestehende Zeilen bleiben
     * unangetastet, damit ein Boot-Sync niemals eine Nutzer-Einstellung
     * (Hot-Markierung, angepasste Halbwertszeit) ueberschreibt, und neue
     * Cluster kommen NICHT als hot herein, weil ein Lauf externe
     * API-Aufrufe kostet.
     *
     * @returns Anzahl der neu registrierten Cluster.
     */
    registerFromOntology(): number {
        if (!this.knowledgeDB.isOpen()) return 0;
        const db = this.knowledgeDB.getDB();

        const res = db.exec(
            `SELECT DISTINCT o.cluster FROM ontology o
             WHERE o.cluster IS NOT NULL AND o.cluster != ''
               AND NOT EXISTS (SELECT 1 FROM cluster_metadata m WHERE m.cluster = o.cluster)
             ORDER BY o.cluster`,
        );
        if (!res.length || !res[0].values.length) return 0;

        let added = 0;
        for (const row of res[0].values) {
            const cluster = row[0] as string | null;
            if (!cluster || INTERNAL_ROWS.has(cluster)) continue;
            db.run(
                `INSERT INTO cluster_metadata (cluster, half_life_days, hot_cluster)
                 VALUES (?, ?, 0)
                 ON CONFLICT(cluster) DO NOTHING`,
                [cluster, detectCategory(cluster).halfLifeDays],
            );
            added++;
        }
        if (added > 0) this.knowledgeDB.markDirty();
        return added;
    }

    /**
     * Upsert mit Default-Halbwertszeit aus detectCategory wenn nicht
     * uebergeben. hotCluster default false.
     */
    upsert(cluster: string, halfLifeDays?: number, hotCluster?: boolean): void {
        if (!this.knowledgeDB.isOpen()) return;
        const db = this.knowledgeDB.getDB();
        const effectiveHalfLife = halfLifeDays ?? detectCategory(cluster).halfLifeDays;
        const effectiveHot = hotCluster ? 1 : 0;
        db.run(
            `INSERT INTO cluster_metadata (cluster, half_life_days, hot_cluster)
             VALUES (?, ?, ?)
             ON CONFLICT(cluster) DO UPDATE SET
                half_life_days = excluded.half_life_days,
                hot_cluster = excluded.hot_cluster`,
            [cluster, effectiveHalfLife, effectiveHot],
        );
        this.knowledgeDB.markDirty();
    }

    get(cluster: string): ClusterMetadataRecord | null {
        if (!this.knowledgeDB.isOpen()) return null;
        const db = this.knowledgeDB.getDB();
        const result = db.exec(
            `SELECT cluster, half_life_days, custom_weights, last_external_check, last_hint_at, hot_cluster
             FROM cluster_metadata WHERE cluster = ?`,
            [cluster],
        );
        if (!result.length || !result[0].values.length) return null;
        return rowToRecord(result[0].values[0]);
    }

    getAll(): ClusterMetadataRecord[] {
        if (!this.knowledgeDB.isOpen()) return [];
        const db = this.knowledgeDB.getDB();
        const result = db.exec(
            `SELECT cluster, half_life_days, custom_weights, last_external_check, last_hint_at, hot_cluster
             FROM cluster_metadata WHERE ${NOT_INTERNAL} ORDER BY cluster`,
        );
        if (!result.length) return [];
        return result[0].values.map(rowToRecord);
    }

    getHotClusters(): ClusterMetadataRecord[] {
        if (!this.knowledgeDB.isOpen()) return [];
        const db = this.knowledgeDB.getDB();
        const result = db.exec(
            `SELECT cluster, half_life_days, custom_weights, last_external_check, last_hint_at, hot_cluster
             FROM cluster_metadata WHERE hot_cluster = 1 AND ${NOT_INTERNAL} ORDER BY cluster`,
        );
        if (!result.length) return [];
        return result[0].values.map(rowToRecord);
    }

    setLastExternalCheck(cluster: string, timestamp: string): void {
        if (!this.knowledgeDB.isOpen()) return;
        const db = this.knowledgeDB.getDB();
        db.run(
            `UPDATE cluster_metadata SET last_external_check = ? WHERE cluster = ?`,
            [timestamp, cluster],
        );
        this.knowledgeDB.markDirty();
    }

    setLastHintAt(cluster: string, timestamp: string): void {
        if (!this.knowledgeDB.isOpen()) return;
        const db = this.knowledgeDB.getDB();
        db.run(
            `UPDATE cluster_metadata SET last_hint_at = ? WHERE cluster = ?`,
            [timestamp, cluster],
        );
        this.knowledgeDB.markDirty();
    }

    setHotCluster(cluster: string, hot: boolean): void {
        if (!this.knowledgeDB.isOpen()) return;
        const db = this.knowledgeDB.getDB();
        db.run(
            `UPDATE cluster_metadata SET hot_cluster = ? WHERE cluster = ?`,
            [hot ? 1 : 0, cluster],
        );
        this.knowledgeDB.markDirty();
    }
}

function rowToRecord(row: unknown[]): ClusterMetadataRecord {
    let customWeights: Record<string, number> | null = null;
    const rawWeights = row[2] as string | null;
    if (rawWeights) {
        try {
            customWeights = JSON.parse(rawWeights) as Record<string, number>;
        } catch {
            customWeights = null;
        }
    }
    return {
        cluster: row[0] as string,
        halfLifeDays: row[1] as number,
        customWeights,
        lastExternalCheck: (row[3] as string | null) ?? null,
        lastHintAt: (row[4] as string | null) ?? null,
        hotCluster: (row[5] as number) === 1,
    };
}
