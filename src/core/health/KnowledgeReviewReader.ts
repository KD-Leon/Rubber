/**
 * KnowledgeReviewReader -- read-side helper for the Knowledge-review UI
 * (IMP-20-06-01 Wave 3).
 *
 * Reads `note_freshness` mirror columns plus a per-path history slice
 * and maps verdict + confidence into the modal's severity buckets per
 * the ADR-106 amendment:
 *
 *   outdated                                       -> critical
 *   contradicts  with confidence >= HIGH_CONF      -> critical
 *   contradicts  with confidence <  HIGH_CONF      -> moderate
 *   extends                                        -> moderate
 *   no_external_source                             -> ok (hidden; FIX-19-05-05)
 *   matches                                        -> ok (hidden by default)
 *
 * Persistence shape comes from KnowledgeDB schema v12 (verdict literals
 * are English; v11 stored German values and the v12 migration
 * translates them in place).
 */

import type { VerdictLiteral, VerifierTier } from './types';

interface SqlDb {
    exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

export type ReviewSeverity = 'critical' | 'moderate' | 'info' | 'ok';

export interface ReviewRow {
    path: string;
    verdict: VerdictLiteral;
    confidence: number;
    summary: string;
    sources: string[];
    lastCheckedAt: string;
    verifierTier: VerifierTier;
    severity: ReviewSeverity;
}

/**
 * FIX-19-02-02: Klassifikation aus Stufe 1/2 (ohne LLM, kostenlos), die
 * unabhaengig vom Verifier-Urteil vorliegt.
 */
export type FreshnessClass = 'volatile' | 'evolving' | 'stable';

export interface ClassifiedRow {
    path: string;
    freshnessClass: FreshnessClass;
    temporalMarkerCount: number;
    classifiedAt: string;
}

export interface ReviewHistoryRow {
    runAt: string;
    verdict: VerdictLiteral;
    confidence: number;
    summary: string;
    sources: string[];
    verifierTier: VerifierTier;
    modelId: string;
}

const HIGH_CONFIDENCE_THRESHOLD = 0.7;

export class KnowledgeReviewReader {
    constructor(private readonly db: SqlDb) {}

    listAll(includeOk = false): ReviewRow[] {
        const res = this.db.exec(
            `SELECT path, last_verdict, last_confidence, last_summary,
                    last_sources_json, last_checked_at, last_verifier_tier
             FROM note_freshness
             WHERE last_verdict IS NOT NULL
             ORDER BY last_checked_at DESC`,
        );
        if (!res.length || !res[0].values.length) return [];

        const rows: ReviewRow[] = [];
        for (const r of res[0].values) {
            const verdict = ((r[1] as string | null) ?? '') as VerdictLiteral;
            const confidence = Number(r[2] ?? 0);
            const severity = mapSeverity(verdict, confidence);
            if (severity === 'ok' && !includeOk) continue;

            rows.push({
                path: (r[0] as string | null) ?? '',
                verdict,
                confidence,
                summary: (r[3] as string | null) ?? '',
                sources: parseSources(r[4] as string | null),
                lastCheckedAt: (r[5] as string | null) ?? '',
                verifierTier: ((r[6] as string | null) ?? 'mid') as VerifierTier,
                severity,
            });
        }
        return rows;
    }

    /**
     * FIX-19-02-02: die Notizen, die zwar klassifiziert sind, aber noch kein
     * Verifier-Urteil tragen.
     *
     * listAll kennt nur Stufe 3 (das bezahlte LLM-Urteil) und filtert alles
     * andere weg. Live standen dadurch 919 klassifizierte Notizen hinter
     * einem leeren Tab -- darunter 75 volatile, also genau die, deren
     * Aktualitaet am ehesten kippt. Die Klassifikation kostet nichts und
     * liegt in aller Regel laengst vor; sie zu verschweigen macht den
     * Review wertlos, solange der Verifier aus ist.
     */
    listClassified(): ClassifiedRow[] {
        const res = this.db.exec(
            `SELECT path, freshness_class, temporal_marker_count, classified_at
             FROM note_freshness
             WHERE last_verdict IS NULL
               AND freshness_class IS NOT NULL AND freshness_class != ''
             ORDER BY CASE freshness_class
                          WHEN 'volatile' THEN 0
                          WHEN 'evolving' THEN 1
                          ELSE 2
                      END,
                      classified_at DESC`,
        );
        if (!res.length || !res[0].values.length) return [];

        return res[0].values.map((r) => ({
            path: (r[0] as string | null) ?? '',
            freshnessClass: ((r[1] as string | null) ?? 'stable') as FreshnessClass,
            temporalMarkerCount: Number(r[2] ?? 0),
            classifiedAt: (r[3] as string | null) ?? '',
        }));
    }

    /** Zaehlung je Klasse, damit der Tab eine ehrliche Zahl tragen kann. */
    countClassifiedByClass(): Record<FreshnessClass, number> {
        const counts: Record<FreshnessClass, number> = { volatile: 0, evolving: 0, stable: 0 };
        for (const row of this.listClassified()) {
            if (row.freshnessClass in counts) counts[row.freshnessClass]++;
        }
        return counts;
    }

    listHistory(path: string): ReviewHistoryRow[] {
        const res = this.db.exec(
            `SELECT run_at, verdict, confidence, summary, sources_json,
                    verifier_tier, model_id
             FROM note_freshness_history
             WHERE path = ?
             ORDER BY run_at DESC`,
            [path],
        );
        if (!res.length || !res[0].values.length) return [];

        return res[0].values.map((r) => ({
            runAt: (r[0] as string | null) ?? '',
            verdict: ((r[1] as string | null) ?? '') as VerdictLiteral,
            confidence: Number(r[2] ?? 0),
            summary: (r[3] as string | null) ?? '',
            sources: parseSources(r[4] as string | null),
            verifierTier: ((r[5] as string | null) ?? 'mid') as VerifierTier,
            modelId: (r[6] as string | null) ?? '',
        }));
    }
}

export function mapSeverity(verdict: VerdictLiteral, confidence: number): ReviewSeverity {
    if (verdict === 'outdated') return 'critical';
    if (verdict === 'contradicts') {
        return confidence >= HIGH_CONFIDENCE_THRESHOLD ? 'critical' : 'moderate';
    }
    if (verdict === 'extends') return 'moderate';
    // FIX-19-05-05: no_external_source ist KEIN Handlungsbedarf, sondern die
    // Abwesenheit eines Befunds ("keine externe Evidenz gefunden"). Fuer
    // persoenliche Notizen ist das der Normalfall. Frueher -> 'info' (im Tab
    // als Low sichtbar), was den Tab mit hunderten bedeutungslosen Zeilen
    // flutete. Jetzt -> 'ok' (versteckt, wie 'matches'). Echte Fehler-Laeufe
    // (FAIL_CLOSED) werden ohnehin gar nicht mehr persistiert (verifierError).
    return 'ok';
}

function parseSources(json: string | null): string[] {
    if (!json) return [];
    try {
        const parsed: unknown = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((s): s is string => typeof s === 'string');
    } catch {
        return [];
    }
}
