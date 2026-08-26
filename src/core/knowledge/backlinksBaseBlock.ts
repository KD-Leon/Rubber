/**
 * backlinksBaseBlock -- erzeugt einen inline ```base-Codeblock (Obsidian Bases)
 * fuer strukturelle Hub-Notes (FEAT-19-04-01 W6, USER 2026-07-21).
 *
 * Die LESBARE Backlink-Ansicht (Gegenstueck zur technischen, zugeklappten
 * Wikilink-Tabelle): eine Bases-Tabelle aller Notizen, die auf die aktuelle
 * Note verlinken, mit den Spalten Dateiname / Description / Type / Timestamp,
 * sortiert nach timestamp absteigend.
 *
 * Der Filter nutzt die eingebaute Bases-Funktion `file.hasLink(this.file)` --
 * generisch ueber ALLE Link-Properties (related, moc, Fliesstext), nicht an ein
 * Property-Vokabular gebunden. `this.file` ist der Kontext der einbettenden
 * Note (nur in inline ```base-Bloecken verfuegbar, nicht in separaten .base-
 * Dateien). Format nach dem echten Vault-Vorbild (Database.base,
 * relationships.base): YAML mit views/type:table/filters/order/sort.
 *
 * Reine Funktion, kein I/O -- deterministisch und ohne Harness testbar.
 */

/**
 * SEC L-1 (Audit 2026-07-22, CWE-1236): Property-Namen werden ununquotet in den
 * YAML-.base-Block interpoliert. Sie stammen zwar aus den eigenen Settings des
 * Vault-Besitzers (kein externer Angreifer), aber ein Name mit Zeilenumbruch
 * oder YAML-Metazeichen koennte die Block-Struktur verbiegen. Property-Namen
 * sind einfache Frontmatter-Identifier -- wir lassen nur ein sicheres Muster zu
 * und fallen sonst auf den OKF-Default zurueck (Defense-in-Depth).
 */
const SAFE_PROPERTY_NAME = /^[A-Za-z0-9_-]+$/;

function safeProperty(name: string, fallback: string): string {
    return SAFE_PROPERTY_NAME.test(name) ? name : fallback;
}

/**
 * @param summaryProperty  OKF-description-Property (Default 'description')
 * @param categoryProperty OKF-type-Property (Default 'type')
 */
export function buildBacklinksBaseBlock(summaryPropertyRaw: string, categoryPropertyRaw: string): string {
    // SEC L-1: gegen YAML-Injection absichern, sonst OKF-Default.
    const summaryProperty = safeProperty(summaryPropertyRaw, 'description');
    const categoryProperty = safeProperty(categoryPropertyRaw, 'type');
    // file.name (Dateiname/Link) immer zuerst, dann die konfigurierten
    // OKF-Properties. timestamp ist ein festes OKF-Feld.
    //
    // FIX-19-09-06 (USER 2026-07-21): eine ---Trennlinie VOR dem ```base-Block
    // (mit Leerzeile Abstand), KEINE Trennlinie danach. Setzt die lesbare .base
    // optisch vom uebrigen Body ab; der Callout folgt direkt darunter. Steht IM
    // Base-Block-Body (zwischen den Markern), bleibt also beim Neuschreiben
    // erhalten und verwaist nicht.
    // FIX-19-09-07/08/09 (USER 2026-07-21): Titel "Links", rowHeight medium,
    // feste Spaltenbreiten (columnSize). Der columnSize-Schluessel ist
    // 'file.name' fuer den Dateinamen, sonst 'note.<property>' (Vorbild: das
    // echte Database.base im Vault). Breiten nach USER-Vorgabe (file.name/
    // description je 200, type 120, timestamp 160). Sortierung NUR nach
    // timestamp DESC (neueste oben).
    const lines = [
        '',
        '---',
        '',
        '```base',
        'views:',
        '  - type: table',
        '    name: Links',
        '    filters:',
        '      and:',
        '        - file.hasLink(this.file)',
        '    order:',
        '      - file.name',
        `      - ${summaryProperty}`,
        `      - ${categoryProperty}`,
        '      - timestamp',
        '    sort:',
        '      - property: timestamp',
        '        direction: DESC',
        '    rowHeight: medium',
        '    columnSize:',
        '      file.name: 200',
        `      note.${summaryProperty}: 200`,
        `      note.${categoryProperty}: 120`,
        '      note.timestamp: 160',
        '```',
    ];
    return lines.join('\n');
}
