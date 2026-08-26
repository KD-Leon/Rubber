/**
 * incomingLinksBlock -- der Inhalt des selbstbildenden Rueckverweis-Blocks
 * einer Hub-Note (FEAT-19-04-01).
 *
 * Loest das, was die Nutzerin an der .base schaetzte (sichtbar in der Note,
 * entsteht von allein), ohne deren Nachteile: der Block ist echtes Markdown
 * mit klickbaren [[Wikilinks]], also portabel (GitHub, grep, ein LLM lesen
 * ihn), agent-lesbar beim read_file ohne Extra-Call, und die Links sind
 * echte Graph-Kanten.
 *
 * Reine Funktion: bekommt die eingehende Kantenmenge (aus
 * GraphStore.getSourcesFor), gibt den Block-Body. Keine DB, kein Obsidian --
 * damit deterministisch und ohne Harness testbar, und der djb2-sha der
 * Auto-Block-Infrastruktur bleibt bei gleichem Input stabil.
 *
 * W6 (USER 2026-07-21): die Tabelle ist rein TECHNISCH -- sie sichert die
 * Graph-Reziprozitaet ueber echte [[Wikilinks]] und steht ZUGEKLAPPT in einem
 * Fold-Callout ('> [!note]- ...'). Callout statt <details>-HTML, weil Obsidian
 * Wikilinks in rohem HTML NICHT als Kanten parst (cache.links), im Markdown-
 * Callout aber schon. Nur EINE Spalte (der Note-Link); die lesbare Ansicht mit
 * description/type/timestamp liefert die separate .base (nur Hub-Typen).
 */

import { t } from '../../i18n';

export interface IncomingSource {
    sourcePath: string;
    linkType: string;
    propertyName: string | null;
    // FEAT-19-04-01 W6 (USER 2026-07-21): die frueheren Anreicherungs-Felder
    // description/type/timestamp sind entfallen. Die technische Tabelle zeigt
    // nur noch den Note-Link; die lesbare Ansicht (mit description/type/
    // timestamp) liefert die separate .base, die diese Properties LIVE aus dem
    // Frontmatter der Quell-Notizen liest -- keine vorberechneten Werte noetig.
}

/** Anzeigename (Basename ohne Ordner, ohne .md). Zugleich das Link-Ziel. */
function displayName(sourcePath: string): string {
    return (sourcePath.replace(/\.md$/, '').split('/').pop() ?? sourcePath);
}

/**
 * FIX-19-07-02: normalisiert einen rohen Frontmatter-Wert zu einem Zellentext.
 *
 * Live-Vorfall 2026-07-20: die type-Spalte blieb leer, weil `type` im Vault
 * fast immer eine YAML-LISTE ist (`type: [concept]`, [person], [meeting], ...),
 * die alte Extraktion aber nur string/number akzeptierte. Obsidian speichert
 * Multi-Value-Properties als Array; ein Skalar bleibt ein Skalar. Wir folgen
 * dem etablierten Muster (QueryBaseTool): Array -> mit ", " gejoint, Skalar ->
 * String. Leere/objekt-wertige Eintraege ergeben undefined (leere Zelle).
 */
export function frontmatterCellText(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
        const parts = value
            .map((v) => frontmatterCellText(v))
            .filter((v): v is string => v !== undefined);
        return parts.length > 0 ? parts.join(', ') : undefined;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    // Objekte (inkl. Date-artige Cache-Objekte ohne toISOString-Vertrag) sind
    // in einer einzelnen Zelle nicht sinnvoll darstellbar -> leer lassen.
    return undefined;
}

function toWikilink(path: string): string {
    // FEAT-19-04-01 W5 (USER 2026-07-20): der Link zeigt NUR den Dateinamen,
    // ohne Ordner und ohne Alias. Diese Block-Kanten sind als 'backlink-block'
    // getaggt und aus der Hub-Berechnung ausgeschlossen, verfaelschen den
    // Graphen also nicht; nur zwei exakt gleichnamige Notizen aus verschiedenen
    // Ordnern waeren im Link mehrdeutig (bewusst in Kauf genommen).
    return `[[${displayName(path)}]]`;
}

/**
 * FEAT-19-04-01: eine Notiz ist ein Hub, wenn mindestens `threshold` andere
 * Notizen auf sie verweisen. Rein datengetrieben (USER-Entscheidung, keine
 * Kategorie-Heuristik).
 */
export function isHubNote(incomingCount: number, threshold: number): boolean {
    return incomingCount >= threshold;
}

/**
 * FEAT-19-04-01: entscheidet, OB ein Rueckverweis-Block gebaut wird, und
 * liefert dann den Body -- oder null, wenn die Notiz kein Hub ist (dann
 * bleibt die Note schlank, kein Block).
 *
 * Ein etwaiger Selbstlink wird VOR der Schwellenpruefung entfernt, damit
 * eine Notiz nicht ueber sich selbst zum Hub wird.
 */
export function assembleIncomingBlock(
    sources: readonly IncomingSource[],
    threshold: number,
    selfPath?: string,
): string | null {
    const filtered = selfPath
        ? sources.filter((s) => s.sourcePath !== selfPath)
        : sources.slice();
    if (!isHubNote(filtered.length, threshold)) return null;
    return buildIncomingLinksBody(filtered);
}

export function buildIncomingLinksBody(sources: readonly IncomingSource[]): string {
    if (sources.length === 0) {
        return `_${t('block.incomingLinks.none')}_`;
    }

    const total = sources.length;

    // FEAT-19-04-01 W6 (USER 2026-07-21): die Tabelle ist rein TECHNISCH -- sie
    // sichert die Graph-Reziprozitaet ueber echte [[Wikilinks]] und wird
    // zugeklappt versteckt. Ein Obsidian-Fold-Callout ('> [!note]- Titel', das
    // '-' klappt ihn ein) bleibt echtes Markdown, also erkennt Obsidian die
    // Wikilinks weiter als Kanten (cache.links) -- anders als bei rohem
    // <details>-HTML, wo die Links NICHT geparst und damit KEINE Kanten waeren.
    //
    // Nur EINE Spalte (der Note-Link). description/type/timestamp sind raus --
    // die lesbare Ansicht liefert die separate .base (nur Hub-Typen). Sortierung
    // deterministisch nach Anzeigename (kein timestamp-Sort mehr, da die Spalte
    // entfaellt). ALLE Quellen, kein Cap.
    const sorted = [...sources].sort((a, b) =>
        displayName(a.sourcePath).localeCompare(displayName(b.sourcePath), undefined, { sensitivity: 'base' }));

    // Jede Zeile traegt das '> '-Callout-Prefix, damit der eingeklappte Block
    // zusammenhaengt. Der Callout-Inhalt bleibt Markdown -> Wikilinks = Kanten.
    const inner: string[] = [];
    inner.push(`| ${t('block.incomingLinks.colNote')} |`);
    inner.push('| --- |');
    for (const s of sorted) {
        // toWikilink liefert einen ordnerlosen Basename-Link; ein blosser
        // Basename traegt kein |, das Escaping haelt die Spalte in jedem Fall dicht.
        // Backslash ZUERST escapen, dann die Pipe (CWE-116: ein roher Backslash
        // wuerde sonst das nachfolgende Escape schlucken).
        const noteCell = toWikilink(s.sourcePath).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
        inner.push(`| ${noteCell} |`);
    }

    // FEAT-19-04-01 W6: Callout-Typ 'relation-in' (eingehende Verweise). Das
    // mitgelieferte Plugin-CSS (styles.css) stylt data-callout="relation-in"
    // mit dem log-in-Icon und einem dezenten Grau -- der technische Block soll
    // ruhig aussehen. Das '-' nach dem Typ klappt den Callout ein.
    const lines: string[] = [];
    lines.push('');
    lines.push(`> [!relation-in]- ${t('block.incomingLinks.heading', { total })}`);
    for (const line of inner) lines.push(`> ${line}`);
    return lines.join('\n');
}
