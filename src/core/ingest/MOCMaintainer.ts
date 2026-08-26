/**
 * MOCMaintainer -- aktive Pflege von MOC-Files mit Marker-Konvention.
 *
 * Backs FEAT-19-11 (Aktive MOC-File-Pflege) und FEAT-19-26 (Dialog-
 * getriebener MOC-Page-Update). ADR-96 HTML-Comment-Marker.
 *
 * Marker-Konvention (FEAT-19-04-01 W4, schlank):
 *   <!-- vault-operator:<id> -->
 *   ... auto-generierter Inhalt ...
 *   <!-- /vault-operator:<id> sha="..." -->
 *
 * Die sha im End-Marker schuetzt vor User-Modifikation: passt der Body nicht
 * mehr zur sha, hat der Nutzer editiert -> Skip. Der Start-Marker ist bewusst
 * schlank (kein generated-at, kein sha), weil er in jeder Hub-Notiz sichtbar
 * in der Source-/Live-Preview steht.
 *
 * Rueckwaerts-Kompatibilitaet: das alte, laute Format
 *   <!-- obsilo:auto-start id="<id>" generated-at="..." sha="..." -->
 *   <!-- obsilo:auto-end -->
 * wird beim Lesen weiterhin erkannt und beim naechsten Schreiben aufs neue
 * Format migriert. "obsilo" ist deprecated und verschwindet damit aus den
 * Notizen, ohne Bestand zu verwaisen.
 */

// Neues Format: <!-- vault-operator:<id> -->  ...  <!-- /vault-operator:<id> sha="..." -->
//
// SEC H-1 (Audit 2026-07-20): die Marker sind ZEILEN-VERANKERT (^\s*...\s*$).
// Ein Marker zaehlt nur, wenn er die EINZIGE Inhalt einer Zeile ist. Sonst
// koennte eine fremde Notiz ueber ihr description-Feld (das der
// Rueckverweis-Block als Tabellenzelle rendert) einen End-Marker mitten in
// eine Block-Zeile schmuggeln; findAutoBlock haette ihn als Block-Grenze
// fehlgelesen, den Block abgeschnitten, die Fake-sha uebernommen und den
// Block dauerhaft eingefroren (Injection 2. Ordnung, CWE-74/CWE-116).
const NEW_START_RE = /^\s*<!--\s*vault-operator:([A-Za-z0-9_-]+)\s*-->\s*$/;
const NEW_END_RE = /^\s*<!--\s*\/vault-operator:([A-Za-z0-9_-]+)(?:\s+sha="([^"]*)")?\s*-->\s*$/;
// Legacy-Format (deprecated): <!-- obsilo:auto-start id="<id>" ... -->  ...  <!-- obsilo:auto-end -->
const LEGACY_START_RE = /^\s*<!--\s*obsilo:auto-start\s+(.*?)\s*-->\s*$/;
const LEGACY_END_RE = /^\s*<!--\s*obsilo:auto-end\s*-->\s*$/;
// Attribute im Legacy-Start-Marker.
const ID_ATTR_RE = /id\s*=\s*"([^"]+)"/;
const SHA_ATTR_RE = /sha\s*=\s*"([^"]+)"/;

/** Erkennt eine Start-Marker-Zeile (neu ODER legacy) und liefert die id. */
function matchStartMarker(line: string): { id: string } | null {
    const nw = line.match(NEW_START_RE);
    if (nw) return { id: nw[1] };
    const lg = line.match(LEGACY_START_RE);
    if (lg) {
        const attrs = lg[1] ?? '';
        const idMatch = attrs.match(ID_ATTR_RE);
        return { id: idMatch ? idMatch[1] : 'moc-header' };
    }
    return null;
}

/**
 * Erkennt eine End-Marker-Zeile. Beim neuen Format traegt sie die id + sha,
 * beim Legacy-Format ist sie id-los (<!-- obsilo:auto-end -->). blockId wird
 * uebergeben, damit ein id-behafteter neuer End-Marker nur den passenden Block
 * schliesst; der Legacy-End-Marker schliesst jeden.
 */
function matchEndMarker(line: string, blockId: string): { sha: string | null } | null {
    const nw = line.match(NEW_END_RE);
    if (nw) {
        if (nw[1] !== blockId) return null;
        return { sha: nw[2] ?? null };
    }
    if (LEGACY_END_RE.test(line)) return { sha: null };
    return null;
}

export interface AutoBlock {
    /** start position (line index of the start-marker). */
    startLine: number;
    /** end position (line index of the end-marker). */
    endLine: number;
    /** Block-Inhalt zwischen den Markern (ohne Marker-Zeilen). */
    body: string;
    id: string;
    /** sha-Attribut aus dem Marker (wenn vorhanden). */
    storedSha: string | null;
}

export interface MOCMarkerOptions {
    /** Default 'moc-header': Block-ID-Default. */
    blockId?: string;
    /** Default 'after-frontmatter': position fuer Inject neuer Bloecke. */
    position?: 'top' | 'after-frontmatter' | 'bottom';
    /**
     * FIX-19-07-06: den byte-exakten sha-Tamper-Guard ueberspringen. Fuer
     * maschinen-eigene Bloecke (incoming-links), deren Body von einem
     * Obsidian-Tabellen-Formatter/Linter nachtraeglich umformatiert wird
     * (Padding-Spaces) -- die byte-exakte sha kippt dann und wuerde den Block
     * faelschlich als "user-editiert" einfrieren. Der whitespace-tolerante
     * no-change-Check verhindert trotzdem unnoetige Rewrites (kein Ping-Pong
     * mit dem Formatter). Default false: der moc-header-Block behaelt seinen
     * strikten Tamper-Schutz.
     */
    skipShaGuard?: boolean;
}

/**
 * FIX-19-07-06: whitespace-toleranter Body-Vergleich. Ein Tabellen-Formatter
 * aendert nur die Ausrichtung, nicht den Inhalt:
 *  - Padding-Spaces in Zellen ("| A   | B |"),
 *  - die Laenge der Delimiter-Dashes ("| --- |" -> "| ------- |").
 * Wir kollabieren jede Whitespace-Sequenz zu einem Space, jede Dash-Sequenz
 * (>=3, Markdown-Tabellen-Delimiter) zu genau "---", und trimmen jede Zeile;
 * leere Zeilen fallen raus. So ist "| A | B |" == "| A   | B |" und
 * "| --- | --- |" == "| ----- | ------- |" -- der Formatter-Reflow zaehlt nicht
 * als Aenderung, echte inhaltliche Edits (andere Zellen/Zeilen) aber schon.
 */
function normalizeBodyForCompare(body: string): string {
    return body
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').replace(/-{3,}/g, '---').trim())
        .filter((l) => l.length > 0)
        .join('\n');
}

export interface MOCWriteResult {
    written: boolean;
    skippedReason?: 'user-modified' | 'no-change' | 'error';
    newContent?: string;
}

/**
 * Findet den Auto-Block einer bestimmten ID in einem MOC-Markdown-Content.
 * Returns null wenn nicht vorhanden.
 */
export function findAutoBlock(content: string, blockId = 'moc-header'): AutoBlock | null {
    const lines = content.split('\n');
    let startLine = -1;
    let legacySha: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        const m = matchStartMarker(lines[i]);
        if (m && m.id === blockId) {
            startLine = i;
            // Legacy-Format traegt die sha im START-Marker; neu im End-Marker.
            const shaMatch = lines[i].match(SHA_ATTR_RE);
            legacySha = shaMatch ? shaMatch[1] : null;
            break;
        }
    }
    if (startLine < 0) return null;

    let endLine = -1;
    let endSha: string | null = null;
    for (let i = startLine + 1; i < lines.length; i++) {
        const em = matchEndMarker(lines[i], blockId);
        if (em) {
            endLine = i;
            endSha = em.sha;
            break;
        }
    }
    if (endLine < 0) return null;

    const body = lines.slice(startLine + 1, endLine).join('\n');
    // sha aus dem End-Marker (neu) hat Vorrang, sonst aus dem Start (legacy).
    return { startLine, endLine, body, id: blockId, storedSha: endSha ?? legacySha };
}

/**
 * Schreibt oder ersetzt einen Auto-Block. Wenn der bestehende Block
 * eine SHA hat und der Body nicht mehr dazu passt: Skip mit
 * skippedReason='user-modified' (ADR-96 Risk-Mitigation).
 */
export function replaceOrInsertAutoBlock(
    content: string,
    newBody: string,
    options: MOCMarkerOptions = {},
): MOCWriteResult {
    const blockId = options.blockId ?? 'moc-header';
    const existing = findAutoBlock(content, blockId);

    if (existing) {
        // FIX-19-07-03: der sha-Tamper-Guard gilt NUR fuer das neue Format.
        // Ein Legacy-obsilo-Block trug seine sha im Start-Marker und wurde vom
        // alten Bundle mit einer anderen Hash-/Padding-Konvention geschrieben;
        // sein djb2 stimmt heute oft nicht mehr (Live-Vorfall 2026-07-20, Note
        // "Agentic AI": stored 15c486bf vs. recomputed 1329ee1d). Wuerde der
        // Guard hier greifen, blieben genau die Alt-Bloecke, die migriert werden
        // SOLLEN, fuer immer im alten Format stehen. Legacy = bedingungslos
        // migrieren; der Guard schuetzt nur user-Edits am neuen Format.
        //
        // FIX-19-07-06: skipShaGuard hebt den Tamper-Guard ganz auf (fuer den
        // maschinen-eigenen incoming-links-Block, dessen sha ein Tabellen-
        // Formatter zerstoert). Der no-change-Check unten faengt Reflow
        // whitespace-tolerant ab, sodass trotzdem nicht bei jedem Lauf
        // geschrieben wird.
        if (!options.skipShaGuard && existing.storedSha && isNewFormat(content, existing.startLine)) {
            const currentSha = sha256(existing.body);
            if (currentSha !== existing.storedSha) {
                // User hat im (neuen) Block editiert. Skip.
                return { written: false, skippedReason: 'user-modified' };
            }
        }
        // no-change: bei skipShaGuard whitespace-tolerant (Formatter-Reflow ist
        // KEINE Aenderung), sonst byte-exakt (getrimmt). Nur wenn der Block
        // ohnehin schon im neuen Format steht -- ein inhaltsgleicher LEGACY-Block
        // wird migriert (neu geschrieben).
        const isUnchanged = options.skipShaGuard
            ? normalizeBodyForCompare(existing.body) === normalizeBodyForCompare(newBody)
            : existing.body.trim() === newBody.trim();
        if (isUnchanged && isNewFormat(content, existing.startLine)) {
            return { written: false, skippedReason: 'no-change' };
        }
        const lines = content.split('\n');
        const [newStart, newEnd] = buildMarkers(blockId, newBody);
        const before = lines.slice(0, existing.startLine);
        const after = lines.slice(existing.endLine + 1);
        const newLines = [...before, newStart, ...newBody.split('\n'), newEnd, ...after];
        return { written: true, newContent: newLines.join('\n') };
    }

    // Insert new block
    const position = options.position ?? 'after-frontmatter';
    const [newStart, newEnd] = buildMarkers(blockId, newBody);
    const block = `${newStart}\n${newBody}\n${newEnd}\n`;

    if (position === 'top') {
        return { written: true, newContent: block + '\n' + content };
    }
    if (position === 'bottom') {
        return { written: true, newContent: content + '\n\n' + block };
    }
    // after-frontmatter
    const fmEnd = findFrontmatterEnd(content);
    if (fmEnd < 0) {
        // No frontmatter, fall back to top
        return { written: true, newContent: block + '\n' + content };
    }
    const lines = content.split('\n');
    const before = lines.slice(0, fmEnd + 1);
    const after = lines.slice(fmEnd + 1);
    return { written: true, newContent: [...before, '', block, ...after].join('\n') };
}

/**
 * FEAT-19-04-01: entfernt einen Auto-Block wieder aus dem Inhalt.
 *
 * Gegenstueck zu replaceOrInsertAutoBlock fuer den Fall, dass eine Notiz
 * ihren Hub-Status verliert (unter den Threshold faellt): der
 * Rueckverweis-Block soll dann verschwinden, nicht leer stehenbleiben.
 * User-editierte Bloecke (SHA passt nicht) bleiben unangetastet.
 */
export function removeAutoBlock(
    content: string,
    blockId: string,
    options: { force?: boolean } = {},
): MOCWriteResult {
    const existing = findAutoBlock(content, blockId);
    if (!existing) return { written: false, skippedReason: 'no-change' };
    // FIX-19-07-03: sha-Guard nur fuers neue Format (siehe replaceOrInsertAutoBlock).
    // Ein Legacy-Block, dessen alte sha nicht mehr passt, soll trotzdem entfernt
    // werden koennen, wenn die Notiz unter den Hub-Threshold faellt.
    // FIX-19-07-06: force ueberspringt den Guard ganz (maschinen-eigener Block).
    if (!options.force && existing.storedSha && isNewFormat(content, existing.startLine)
        && sha256(existing.body) !== existing.storedSha) {
        return { written: false, skippedReason: 'user-modified' };
    }
    const lines = content.split('\n');
    const before = lines.slice(0, existing.startLine);
    const after = lines.slice(existing.endLine + 1);
    // eine etwaige Leerzeile direkt vor dem Block mitnehmen, damit kein
    // doppelter Absatz zurueckbleibt.
    if (before.length > 0 && before[before.length - 1].trim() === '') before.pop();
    return { written: true, newContent: [...before, ...after].join('\n') };
}

/**
 * FEAT-19-04-01 W3: entfernt JEDEN Auto-Block (jede id, neues UND legacy
 * Marker-Format), UNBEDINGT -- ohne sha-Guard, anders als removeAutoBlock.
 *
 * Einsatz vor dem Embedding (SemanticIndexService.splitIntoChunks): der
 * selbstbildende Rueckverweis-Block schreibt Titel/Description/Tags aller
 * Linker in den Hub-Body. Landet dieser Text im Note-Vektor, driftet der Hub
 * zu seinen Nachbarn und erzeugt beim Reindex neue weak_clusters-Paare (die
 * Ausgabe des Features speist die Rechnung, die den Befund erzeugt). Der Block
 * bleibt in der Note fuer Mensch und Agent sichtbar, wird aber aus dem
 * Embedding ausgeschnitten. Der sha-Guard von removeAutoBlock ist hier bewusst
 * NICHT gewuenscht: auch ein user-editierter Block-Text gehoert nicht in den
 * Vektor.
 *
 * Reine Funktion, kein I/O. Entfernt auch eine Leerzeile direkt vor jedem
 * Block, damit kein doppelter Absatz zurueckbleibt.
 */
export function stripAllAutoBlocks(content: string): string {
    // Schnell-Ausstieg: kein Marker (neu ODER legacy) vorhanden.
    if (!content.includes('vault-operator:') && !content.includes('obsilo:auto-start')) {
        return content;
    }
    const lines = content.split('\n');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const start = matchStartMarker(lines[i]);
        if (start) {
            // Ende-Marker suchen (fuer diese id ODER Legacy-End).
            let end = -1;
            for (let j = i + 1; j < lines.length; j++) {
                if (matchEndMarker(lines[j], start.id)) { end = j; break; }
            }
            // Leerzeile direkt vor dem Block mitnehmen.
            if (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
            if (end < 0) break; // unterminierter Block: Rest verwerfen
            i = end + 1;
            continue;
        }
        out.push(lines[i]);
        i++;
    }
    return out.join('\n');
}

function findFrontmatterEnd(content: string): number {
    const lines = content.split('\n');
    if (lines[0]?.trim() !== '---') return -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') return i;
    }
    return -1;
}

/**
 * FEAT-19-04-01 W4: baut das schlanke Marker-Paar. Start ohne sha/Zeitstempel
 * (steht sichtbar in der Notiz), sha im End-Marker (Tamper-Schutz).
 */
function buildMarkers(blockId: string, body: string): [string, string] {
    const sha = sha256(body);
    return [
        `<!-- vault-operator:${blockId} -->`,
        `<!-- /vault-operator:${blockId} sha="${sha}" -->`,
    ];
}

/** True, wenn die Start-Zeile am gegebenen Index bereits das neue Format ist. */
function isNewFormat(content: string, startLine: number): boolean {
    const line = content.split('\n')[startLine] ?? '';
    return NEW_START_RE.test(line);
}

/** Simple djb2-style "hash" for sha-attribute. Stable, deterministic, kollisions-beschraenkt. */
function sha256(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h) + s.charCodeAt(i);
        h = h & h; // 32-bit
    }
    return Math.abs(h).toString(16);
}
