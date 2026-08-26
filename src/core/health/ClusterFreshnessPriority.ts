/**
 * ClusterFreshnessPriority -- welche Cluster ein vault-weiter Freshness-Lauf
 * anfasst und in welcher Reihenfolge (FEAT-19-03-01).
 *
 * Ersetzt die manuelle Hot-Cluster-Auswahl: statt anzukreuzen, was geprueft
 * wird, leitet diese reine Funktion die Reihenfolge aus der Alterung ab.
 *
 * Signal-Gewichtung folgt der Entwurfs-Analyse:
 *   - freshness_class ist verlaesslich (jede Notiz echt klassifiziert) und
 *     bekommt daher das Hauptgewicht: ein Cluster mit faelligen volatilen
 *     Notizen ist dringender als einer mit nur stabilen.
 *   - Die Halbwertszeit pro Cluster ist schwach (Keyword-Heuristik auf dem
 *     Namen, viel 180d-Fallback) und dient nur als Tiebreak innerhalb
 *     gleicher Dringlichkeit: ein schneller alterndes Thema zuerst.
 *   - Bei Gleichstand entscheidet, wer am laengsten nicht extern geprueft
 *     wurde (lastExternalCheck), zuletzt der Clustername (Determinismus).
 *
 * Reine Funktion, keine DB. Die faelligen Notizzahlen kommen vom Aufrufer
 * (der NoteSelector-Cooldown pro Klasse bleibt dort, wo er ist).
 */

export interface ClusterFreshnessInput {
    cluster: string;
    /** Halbwertszeit der Cluster-Kategorie in Tagen (0 = statisch/personal). */
    halfLifeDays: number;
    /** ISO-Zeitstempel des letzten externen Checks, oder null (nie geprueft). */
    lastExternalCheck: string | null;
    /** Anzahl faelliger Notizen je Klasse (Cooldown ueberschritten). */
    dueVolatile: number;
    dueEvolving: number;
    dueStable: number;
    /** Nutzer-Ausschluss: dieser Cluster wird nie extern geprueft. */
    excluded: boolean;
}

export interface RankedCluster extends ClusterFreshnessInput {
    /** Hoeher = dringender. Nur fuer Diagnose/Anzeige. */
    urgency: number;
}

// Klassengewichte: eine faellige volatile Notiz wiegt schwerer als viele
// stabile. Die absoluten Werte sind nur relativ zueinander bedeutsam.
const WEIGHT_VOLATILE = 100;
const WEIGHT_EVOLVING = 10;
const WEIGHT_STABLE = 1;

function urgencyOf(c: ClusterFreshnessInput): number {
    return c.dueVolatile * WEIGHT_VOLATILE
        + c.dueEvolving * WEIGHT_EVOLVING
        + c.dueStable * WEIGHT_STABLE;
}

/**
 * Waehlt die faelligen Cluster aus ALLEN und sortiert sie nach
 * Alterungs-Dringlichkeit. `now` ist Parameter, damit die Funktion
 * deterministisch und ohne Date.now testbar bleibt.
 */
export function selectDueClusters(
    clusters: readonly ClusterFreshnessInput[],
    now: Date,
): RankedCluster[] {
    const nowMs = now.getTime();
    const eligible: RankedCluster[] = [];

    for (const c of clusters) {
        if (c.excluded) continue;
        // Faellig ist ein Cluster genau dann, wenn er mindestens eine
        // faellige Notiz hat. half_life allein macht keinen Cluster faellig
        // (das haelt personal/half_life=0 draussen, solange nichts due ist),
        // und die Notiz-Faelligkeit traegt bereits den Klassen-Cooldown.
        const urgency = urgencyOf(c);
        if (urgency <= 0) continue;
        eligible.push({ ...c, urgency });
    }

    eligible.sort((a, b) => {
        // 1. Dringlichkeit (volatile-dominiert), hoeher zuerst.
        if (a.urgency !== b.urgency) return b.urgency - a.urgency;
        // 2. Schneller alterndes Thema zuerst (kuerzere Halbwertszeit).
        //    half_life=0 (statisch) ans Ende, nicht an den Anfang.
        const ha = a.halfLifeDays > 0 ? a.halfLifeDays : Number.POSITIVE_INFINITY;
        const hb = b.halfLifeDays > 0 ? b.halfLifeDays : Number.POSITIVE_INFINITY;
        if (ha !== hb) return ha - hb;
        // 3. Am laengsten nicht geprueft zuerst (null = nie = am dringendsten).
        const ta = a.lastExternalCheck ? new Date(a.lastExternalCheck).getTime() : 0;
        const tb = b.lastExternalCheck ? new Date(b.lastExternalCheck).getTime() : 0;
        if (ta !== tb) return ta - tb;
        // 4. Determinismus.
        return a.cluster.localeCompare(b.cluster);
    });

    void nowMs; // reserviert fuer kuenftige Alters-Berechnung, haelt Signatur stabil
    return eligible;
}
