/**
 * clusterDueCounts -- zaehlt je Cluster die faelligen Notizen nach Klasse
 * (FEAT-19-03-01).
 *
 * Speist ClusterFreshnessPriority.selectDueClusters mit dem verlaesslichen
 * Alterungssignal. Wendet denselben Klassen-Cooldown an wie
 * NoteSelector.isDue (volatile 7d / evolving 30d / stable 90d), nur
 * aggregiert je Cluster statt pro Notiz, damit der vault-weite Lauf ohne
 * Handauswahl weiss, welche Cluster ueberhaupt Arbeit haben.
 *
 * Dieselben Ausschluesse wie NoteSelector: Pfad-Praefixe und die
 * dismissed_freshness-Verdikte des Nutzers.
 */

interface SqlDb {
    exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

export interface DueCountSettings {
    volatileRecheckDays: number;
    evolvingRecheckDays: number;
    stableRecheckDays: number;
    excludePaths: string[];
}

export interface ClusterDueCounts {
    dueVolatile: number;
    dueEvolving: number;
    dueStable: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function recheckDaysFor(cls: string, s: DueCountSettings): number {
    switch (cls) {
        case 'volatile': return s.volatileRecheckDays;
        case 'evolving': return s.evolvingRecheckDays;
        case 'stable': return s.stableRecheckDays;
        default: return s.stableRecheckDays;
    }
}

/**
 * @returns Map cluster -> faellige Zahlen. Cluster ohne faellige Notiz
 *          fehlen in der Map (kein Nulleintrag), damit der Aufrufer sie
 *          direkt als "nichts zu tun" behandeln kann.
 */
export function countDueNotesByCluster(
    db: SqlDb,
    settings: DueCountSettings,
    now: Date,
): Map<string, ClusterDueCounts> {
    const rows = db.exec(
        `SELECT o.cluster, n.freshness_class, n.last_checked_at, n.path
         FROM note_freshness n
         INNER JOIN ontology o ON o.entity_path = n.path
         WHERE n.freshness_class IS NOT NULL AND n.freshness_class != ''
           AND NOT EXISTS (
               SELECT 1 FROM dismissed_freshness d
               WHERE d.note_path = n.path AND d.hint_type = 'verdict'
           )`,
    );

    const out = new Map<string, ClusterDueCounts>();
    if (!rows.length || !rows[0].values.length) return out;

    const nowMs = now.getTime();
    for (const row of rows[0].values) {
        const cluster = String(row[0]);
        const cls = String(row[1]);
        const lastChecked = row[2] as string | null;
        const path = String(row[3]);

        if (settings.excludePaths.some((prefix) => path.startsWith(prefix))) continue;

        // Faellig: nie geprueft, oder Cooldown der Klasse ueberschritten.
        let due: boolean;
        if (!lastChecked) {
            due = true;
        } else {
            const ageDays = (nowMs - new Date(lastChecked).getTime()) / MS_PER_DAY;
            due = ageDays >= recheckDaysFor(cls, settings);
        }
        if (!due) continue;

        const entry = out.get(cluster) ?? { dueVolatile: 0, dueEvolving: 0, dueStable: 0 };
        if (cls === 'volatile') entry.dueVolatile++;
        else if (cls === 'evolving') entry.dueEvolving++;
        else entry.dueStable++;
        out.set(cluster, entry);
    }
    return out;
}
