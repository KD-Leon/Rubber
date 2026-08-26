/**
 * Repair-Plan des Vault-Health-Systems als Daten (IMP-19-01-03 W3).
 *
 * ADR-165: vor jedem Mass-Write entsteht eine explizite Plan-Liste
 * (Datei, Aktion), die der Nutzer approved; die Ausfuehrung ist an genau
 * diese Pfade gebunden. Dieses Modul haelt die pure Logik (Plan-Bau,
 * Checkpoint-Deckelung nach FIX-19-01-13, Outcome-Ableitung aus dem
 * Verify-Delta nach ADR-166), damit das Modal duenn und die Logik
 * testbar bleibt.
 *
 * Wayfinder: src/ARCHITECTURE.map, Zeile "vault-health repair plan".
 */

export type RepairPlanAction = 'fix_backlinks' | 'fix_categories' | 'cleanup' | 'link_weak';

export interface RepairPlanEntry {
    action: RepairPlanAction;
    path: string;
    /** Anzeige-Label der Zeile (Dateiname oder Paar-Beschreibung). */
    label: string;
    /**
     * SEC M-1 (Audit 2026-07-19): nur fuer link_weak. Die Approval war
     * pfad-, das Schreiben paarbasiert; taucht eine Note in zwei Paaren
     * auf (a-b und a-c), ueberlebte ihr Pfad das Abwaehlen der einen
     * Zeile ueber die andere und das abgewaehlte Paar wurde doch
     * verlinkt. Der Key macht die Zeile paar-identifizierbar.
     */
    pairKey?: string;
}

/**
 * Trenner im Paar-Key. NUL, weil er in keinem Vault-Pfad vorkommen kann.
 * FIX-19-02-14: als Konstante, damit Erzeuger und Zerleger nicht driften.
 */
export const PAIR_KEY_SEPARATOR = '\u0000';

/** Stabiler Paar-Key, richtungsunabhaengig. */
export function weakPairKey(a: string, b: string): string {
    return [a, b].sort().join(PAIR_KEY_SEPARATOR);
}

export interface RepairPlanDeps {
    /** Live-Seite des Praedikats (ADR-164), pro Aktion die Zielpfade. */
    planRepairTargets(action: 'fix_backlinks' | 'cleanup' | 'fix_categories'): string[];
    /**
     * FIX-19-02-15: Live-Seite fuer weak_clusters. Die Paare kamen bisher
     * roh aus dem Snapshot in den Plan, ohne je zu pruefen, ob der Write
     * ueberhaupt etwas taete.
     */
    planWeakPairTargets?(pairs: ReadonlyArray<{ a: string; b: string }>): Array<{ a: string; b: string }>;
}

/**
 * Baut die vollstaendige Plan-Liste fuer die gewaehlten Check-Typen.
 * Cleanup ist ein SICHTBARER Teil des Plans; vorher lief er als stiller
 * Vault-weiter Nachlauf, sobald missing_backlinks selektiert war.
 */
export function buildRepairPlan(
    deps: RepairPlanDeps,
    selectedTypes: ReadonlySet<string>,
    weakPairs: ReadonlyArray<{ a: string; b: string }>,
    opts: {
        includeCleanup: boolean;
        /**
         * FIX-19-01-17 + FIX-19-01-19: die Pfade der angehakten Findings,
         * PRO CHECK-TYP.
         *
         * Live-Vorfall 2026-07-19: der Plan ignorierte die Auswahl ganz
         * (die Checkboxen waren ein Placebo). Der erste Fix band ihn an
         * ein flaches Pfad-Set, was typ-blind war: eine Notiz, die als
         * Quelle in einem missing_backlinks-Finding stand, autorisierte
         * damit auch cleanup- und category-Schreibvorgaenge an derselben
         * Datei. Getrennt nach Check-Typ autorisiert jeder Befund nur noch
         * die Aktion, zu der er gehoert.
         *
         * Fehlt die Map (Tool-Pfad, Tests), bleibt das Verhalten offen.
         */
        selectedByCheck?: ReadonlyMap<string, ReadonlySet<string>>;
    },
): RepairPlanEntry[] {
    const entries: RepairPlanEntry[] = [];
    const basename = (p: string) => p.split('/').pop() ?? p;
    /**
     * SEC L-5 (Audit 2026-07-19): der reine Dateiname macht gleichnamige
     * Notizen aus verschiedenen Ordnern in der Approval-Liste
     * ununterscheidbar -- genau die Information, die der Nutzer dort
     * braucht. Der Elternordner kommt als Kontext dazu; der volle Pfad
     * waere in der Zeile zu lang.
     */
    const labelWithFolder = (p: string) => {
        const parts = p.replace(/\.md$/, '').split('/');
        const name = parts.pop() ?? p;
        const folder = parts.pop();
        return folder ? `${name}  (${folder})` : name;
    };

    // FIX-19-01-19: Filter pro Check-Typ. Die Zuordnung Aktion -> Check ist
    // fest: backlinks und cleanup haengen an missing_backlinks, categories
    // an category_mismatch. Ohne Map (Tool-Pfad, Tests) bleibt alles offen.
    const sel = opts.selectedByCheck;
    const chosen = (check: string, path: string) => {
        if (!sel) return true;
        const set = sel.get(check);
        return !set || set.has(path);
    };

    if (selectedTypes.has('missing_backlinks')) {
        for (const path of deps.planRepairTargets('fix_backlinks')) {
            // Der .base-Geschwisterpfad haengt am Ziel und wird mit ihm
            // uebernommen (er steht nie selbst in einem Finding).
            const owner = path.endsWith('.base')
                ? path.replace(/-Backlinks\.base$/, '.md')
                : path;
            if (!chosen('missing_backlinks', owner)) continue;
            entries.push({ action: 'fix_backlinks', path, label: labelWithFolder(path) });
        }
        if (opts.includeCleanup) {
            for (const path of deps.planRepairTargets('cleanup')) {
                // Der Aufraeumschritt haengt am selben Befund wie die
                // Backlinks; eine eigene Befundklasse hat er nicht.
                if (!chosen('missing_backlinks', path)) continue;
                entries.push({ action: 'cleanup', path, label: labelWithFolder(path) });
            }
        }
    }
    if (selectedTypes.has('category_mismatch')) {
        for (const path of deps.planRepairTargets('fix_categories')) {
            // Achsenwechsel: das Finding haengt am TARGET, geschrieben wird
            // die QUELLE. Deshalb zaehlt hier die Quelle als gewaehlt, wenn
            // sie in irgendeinem angehakten Finding vorkommt.
            if (!chosen('category_mismatch', path)) continue;
            entries.push({ action: 'fix_categories', path, label: labelWithFolder(path) });
        }
    }
    if (selectedTypes.has('weak_clusters')) {
        // FIX-19-02-15: nur Paare, an denen der Write wirklich etwas aendert.
        const livePairs = deps.planWeakPairTargets?.(weakPairs) ?? weakPairs;
        for (const { a, b } of livePairs) {
            // Eine Zeile pro PAAR (vorher zwei pro Paar, je Pfad): das Paar
            // ist die Einheit, die geschrieben wird, also auch die Einheit,
            // die der Nutzer approved oder abwaehlt.
            entries.push({
                action: 'link_weak',
                path: a,
                label: `${basename(a)} <-> ${basename(b)}`,
                pairKey: weakPairKey(a, b),
            });
        }
    }
    return entries;
}

/**
 * FIX-19-01-13: geschrieben wird nur, was der Checkpoint abdeckt. Vorher
 * kappte nur die Snapshot-Liste bei 500 Pfaden, waehrend der Repair
 * unbegrenzt weiterschrieb; der Ueberhang lag ausserhalb jeder
 * Undo-Moeglichkeit. Gezaehlt werden eindeutige Pfade, nicht Eintraege.
 */
export function capPlanForCheckpoint(
    entries: RepairPlanEntry[],
    cap: number,
): { covered: RepairPlanEntry[]; deferred: number } {
    const allowed = new Set<string>();
    const covered: RepairPlanEntry[] = [];
    let deferred = 0;
    for (const e of entries) {
        // FIX-19-02-14: eine weak-Paar-Zeile fasst ZWEI Dateien an, nicht
        // eine. Der Cap schuetzt den Checkpoint, also muss er zaehlen, was
        // wirklich geschrieben wird -- sonst deckelt er auf N und sichert
        // bis zu 2N Dateien.
        const paths = e.pairKey ? e.pairKey.split(PAIR_KEY_SEPARATOR).filter(Boolean) : [e.path];
        const fresh = paths.filter((p) => !allowed.has(p));
        if (fresh.length === 0) {
            covered.push(e);
            continue;
        }
        if (allowed.size + fresh.length <= cap) {
            for (const p of fresh) allowed.add(p);
            covered.push(e);
        } else {
            deferred++;
        }
    }
    return { covered, deferred };
}

export type RepairOutcome = 'fixed' | 'still_firing' | 'unconfirmed' | 'failed' | 'skipped_yaml';

export interface RepairOutcomeEntry {
    path: string;
    outcome: RepairOutcome;
}

/**
 * ADR-166 / Phase 6: das Ergebnis pro geplantem Ziel kommt aus dem
 * Verify-Delta, nie aus Iterationszaehlern. Prioritaet bei Mehrfach-
 * Zugehoerigkeit: failed > skipped_yaml > still_firing > fixed, damit
 * ein Schreibfehler nicht als "noch offen" verharmlost wird.
 */
export function computeOutcomes(
    plannedPaths: readonly string[],
    stillFiring: readonly string[],
    timedOutPaths: readonly string[],
    yamlErrorPaths: readonly string[],
): RepairOutcomeEntry[] {
    const firing = new Set(stillFiring);
    const timedOut = new Set(timedOutPaths);
    const yaml = new Set(yamlErrorPaths);
    return plannedPaths.map((path) => {
        // FIX-19-01-17: ein Cache-Timeout ist KEIN Fehlschlag. Vorher ging
        // timedOutPaths als failedPaths herein und failed hatte oberste
        // Prioritaet -- ein Pfad, dessen Reparatur nachweislich griff, wurde
        // als "failed" gemeldet, nur weil das Reparse-Event ausblieb. Jetzt
        // entscheidet das PRAEDIKAT: feuert es nicht mehr, ist der Pfad
        // gefixt, egal wie langsam der Cache war. Nur wenn beides zutrifft
        // (Timeout UND weiterhin feuernd), ist der Zustand unbestaetigt.
        if (yaml.has(path)) return { path, outcome: 'skipped_yaml' as const };
        if (firing.has(path)) {
            return timedOut.has(path)
                ? { path, outcome: 'unconfirmed' as const }
                : { path, outcome: 'still_firing' as const };
        }
        return { path, outcome: 'fixed' as const };
    });
}

/**
 * FIX-19-01-18: die drei Groessen, die der Nutzer auseinanderhalten muss.
 *
 * Der Button zeigte BEFUNDE, die Freigabe-Liste SCHREIBVORGAENGE, und
 * niemand nannte den Unterschied: 24 gegen 204. Beide Zahlen waren
 * richtig. Was fehlte, war die Herkunft der Differenz -- vor allem der
 * Cleanup-Anteil, hinter dem gar kein Befund steht.
 */
export interface RepairPlanSummary {
    /** Befunde, die der Nutzer in der Liste angehakt hat. */
    findings: number;
    /** Schreibvorgaenge = Plan-Zeilen. */
    writes: number;
    /** Betroffene Dateien (eine Datei kann mehrfach vorkommen). */
    files: number;
    /** Zeilen aus dem Aufraeumschritt, zu denen es keinen Befund gibt. */
    cleanupWithoutFinding: number;
    byAction: Record<RepairPlanAction, number>;
}

export function summarizePlan(
    entries: readonly RepairPlanEntry[],
    findings: number,
): RepairPlanSummary {
    const byAction: Record<RepairPlanAction, number> = {
        fix_backlinks: 0, fix_categories: 0, cleanup: 0, link_weak: 0,
    };
    const files = new Set<string>();
    for (const e of entries) {
        byAction[e.action]++;
        files.add(e.path);
        // Ein weak-Paar schreibt BEIDE Seiten; die zweite steht nicht als
        // eigene Zeile im Plan, gehoert aber in die Dateizahl.
        if (e.action === 'link_weak' && e.pairKey) {
            // FIX-19-02-23: NUR am NUL trennen.
            //
            // Die Zeichenklasse trennte auch am Leerzeichen, also zerfiel
            // "Notes/Agentic AI Lab.md" in drei Bruchstuecke, die alle als
            // eigene Datei zaehlten. Live wurden aus hoechstens 86 Dateien
            // so 158. NUL ist der Trenner genau deshalb, weil er in keinem
            // Pfad vorkommen kann -- das Leerzeichen daneben hat diese
            // Zusicherung wieder aufgehoben.
            for (const p of e.pairKey.split(PAIR_KEY_SEPARATOR).filter(Boolean)) files.add(p);
        }
    }
    return {
        findings,
        writes: entries.length,
        files: files.size,
        cleanupWithoutFinding: byAction.cleanup,
        byAction,
    };
}
