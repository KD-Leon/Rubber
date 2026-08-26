/**
 * Knowledge-Review-Feeder-Zustand als Daten (IMP-19-01-03 W4).
 *
 * Der Empty-State des Knowledge-Review-Tabs verschwieg, dass beide
 * Quellen Opt-in-Gates hinter Settings sind: der Nutzer sah "keine
 * Eintraege" und konnte nicht wissen, dass die Feeder schlicht aus
 * sind. Diese pure Funktion liefert den Gate-Zustand; das Modal
 * rendert ihn.
 */

export interface KnowledgeReviewGateSource {
    freshness?: {
        externalSources?: { enabled?: boolean };
    };
    stufe3PeriodicJob?: { enabled?: boolean };
}

export interface KnowledgeReviewEmptyInfo {
    /** true = der Verdict-Feeder (Stufe 3 / Web-Verifier) ist aus. */
    verdictFeederOff: boolean;
    /** true = der periodische Lauf ist aus (on-demand waere moeglich). */
    periodicJobOff: boolean;
}

export function knowledgeReviewEmptyInfo(source: KnowledgeReviewGateSource): KnowledgeReviewEmptyInfo {
    // FEAT-19-03-01: das noHotClusters-Gate ist weg. Der Scan deckt den
    // ganzen Vault automatisch ab; es gibt kein manuelles Ankreuzen mehr,
    // gegen dessen Fehlen der Empty-State warnen muesste.
    return {
        verdictFeederOff: source.freshness?.externalSources?.enabled !== true,
        periodicJobOff: source.stufe3PeriodicJob?.enabled !== true,
    };
}

/**
 * W4: uebersetzt historische deutsche Verdict-Literale im
 * frontierSeverityFilter auf die englischen Werte, die der Verifier
 * vergleicht. Die v12-Migration uebersetzte nur die DB-Seite; eine
 * data.json mit 'widerspricht' haette den Filter nach Aktivierung
 * still nie matchen lassen. Unbekannte Werte bleiben unveraendert.
 */
// SEC Info-4 (Audit 2026-07-19): Lookup nur auf eigene Schluessel. Ein
// Filter-Wert wie 'toString' oder 'constructor' lieferte sonst die
// geerbte Function, die im Truthy-Zweig als "migriert" durchging.
const GERMAN_VERDICT_LITERALS: Record<string, string> = {
    'widerspricht': 'contradicts',
    'veraltet': 'outdated',
    'passt': 'matches',
    'erweitert': 'extends',
    'keine_externe_quelle': 'no_external_source',
};

export function migrateVerdictLiterals(filter: readonly string[]): { migrated: string[]; changed: boolean } {
    let changed = false;
    const migrated = filter.map((v) => {
        const en = (Object.prototype.hasOwnProperty.call(GERMAN_VERDICT_LITERALS, v) ? GERMAN_VERDICT_LITERALS[v] : undefined);
        if (en) { changed = true; return en; }
        return v;
    });
    return { migrated, changed };
}
