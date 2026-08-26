/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/unbound-method -- File-level disable: interacts with external SDK / JSON / Obsidian internals where untyped 'any' values are unavoidable. Inputs are validated at boundaries via type guards or schema checks where security-relevant. */
/**
 * GraphExtractor -- Extract graph data from Obsidian's metadataCache into GraphStore.
 *
 * Reads Wikilinks (body + frontmatter MOC-Properties) and tags from each vault file
 * and writes them as edges/tags into the Knowledge DB. Supports both full extraction
 * (on startup) and incremental updates (on vault events).
 *
 * ADR-050: SQLite Knowledge DB
 * FEATURE-1502: Graph Data Extraction & Expansion
 */

import type { App, TFile, Vault } from 'obsidian';
import type { GraphStore, Edge } from './GraphStore';
import { OKF_DEFAULTS } from '../../types/settings';
import { findAutoBlock } from '../ingest/MOCMaintainer';
import { INCOMING_BLOCK_ID } from './incomingLinksMaintainer';

/**
 * FIX-19-01-15: die Settings-Sicht, aus der die Extraktions-Properties
 * gebaut werden. Strukturell kompatibel zum Plugin-Settings-Objekt, damit
 * main.ts schlicht `() => this.settings` uebergeben kann.
 */
export interface ExtractionPropertySource {
    mocPropertyNames?: string[];
    backlinksProperty?: string;
    vaultHealth?: { reciprocalProperties?: Array<[string, string]> };
}

/**
 * FIX-19-01-15: Union aller Frontmatter-Properties, die zu Edges werden.
 *
 * Vorher extrahierte extractFile NUR mocPropertyNames. Die Health-Repairs
 * schreiben aber in backlinksProperty ('related'), und der Reziprozitaets-
 * Check liest Reverse-Edges unter den reciprocalProperties-Namen. Beide
 * fehlten in der Extraktion: der geschriebene Fix wurde nie zur Edge, das
 * Check-Praedikat feuerte identisch erneut (Live: 1029 moc-Edges, null
 * related-Edges bei 965 Notes mit related-Keys).
 *
 * Der backlinksProperty-Fallback ist bewusst DERSELBE wie in den
 * Schreibpfaden (OrphanLinkModal/VaultHealthRepairModal:
 * `settings.backlinksProperty ?? OKF_DEFAULTS.backlinksProperty`) --
 * wichen die beiden Aufloesungen ab, entstuende die Blindstelle erneut.
 */
export function buildExtractedFrontmatterProperties(source: ExtractionPropertySource): string[] {
    const raw = [
        ...(source.mocPropertyNames ?? []),
        source.backlinksProperty ?? OKF_DEFAULTS.backlinksProperty,
        ...(source.vaultHealth?.reciprocalProperties ?? []).flat(),
    ];
    const out: string[] = [];
    for (const p of raw) {
        const t = typeof p === 'string' ? p.trim() : '';
        if (t && !out.includes(t)) out.push(t);
    }
    return out;
}

// TODO(R3): migrate to src/core/utils/wikilinks.ts (parseWikilinks).
// Kept regex-based for now to avoid touching the graph-extraction pipeline.
// Wikilink regex — matches [[target]], [[target|alias]], [[target#heading]]
const WIKILINK_RE = /\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g;

/**
 * FIX-19-02-30: Frontmatter-Keys, die NIE Graph-Kanten sind, auch wenn ihr
 * Wert zufaellig wie ein Wikilink aussieht. Obsidian-Steuerfelder und die
 * Kategorie-Achse; alles andere mit [[..]]-Werten wird extrahiert.
 */
const NON_LINK_FRONTMATTER_KEYS = new Set<string>([
    'tags', 'aliases', 'cssclass', 'cssclasses', 'type', 'date', 'created',
    'updated', 'publish', 'permalink',
]);

// ---------------------------------------------------------------------------
// GraphExtractor
// ---------------------------------------------------------------------------

export class GraphExtractor {
    private app: App;
    private graphStore: GraphStore;
    /**
     * FIX-19-01-15: Provider statt statischer Liste. Der Extractor liest
     * die Properties bei JEDER Extraktion frisch aus den Settings; der
     * fruehere setMocProperties-Mechanismus hatte drei Merkstellen
     * (main.ts-Konstruktion + zwei EmbeddingsTab-Call-Sites), von denen
     * keine backlinksProperty nachzog.
     */
    private getPropertySource: () => ExtractionPropertySource;

    constructor(app: App, graphStore: GraphStore, getPropertySource: () => ExtractionPropertySource) {
        this.app = app;
        this.graphStore = graphStore;
        this.getPropertySource = getPropertySource;
    }

    // -----------------------------------------------------------------------
    // Full extraction
    // -----------------------------------------------------------------------

    /**
     * Extract graph data from all markdown files in the vault.
     * Fast: reads only metadataCache (no file I/O), typically <10s for 800 files.
     */
    async extractAll(vault: Vault): Promise<{ edgeCount: number; tagCount: number }> {
        const files = vault.getMarkdownFiles();
        for (const file of files) {
            await this.extractFile(file);
        }
        const edgeCount = this.graphStore.getEdgeCount();
        const tagCount = this.graphStore.getTagCount();
        console.debug(`[GraphExtractor] Extracted ${edgeCount} edges, ${tagCount} unique tags from ${files.length} files`);
        return { edgeCount, tagCount };
    }

    // -----------------------------------------------------------------------
    // Incremental extraction
    // -----------------------------------------------------------------------

    /**
     * Extract edges and tags for a single file.
     * Replaces any existing data for this path (atomic update).
     *
     * FEAT-19-04-01 W3: async, weil Body-Links im selbstbildenden
     * Rueckverweis-Block als link_type='backlink-block' klassifiziert werden
     * muessen (sonst blaehen sie via getHubTargets/checkGodNodes den Graphen
     * auf -- eine gelistete Quelle wuerde selbst zum Hub). Ob ein Link im
     * Block liegt, laesst sich NICHT aus dem metadataCache ableiten: dessen
     * SectionCache traegt zwar type='html' und die Position, aber nicht den
     * Kommentar-TEXT, also nicht die Block-ID. Deshalb wird die Datei GENAU
     * DANN gelesen, wenn ueberhaupt ein HTML-Kommentar vorkommt
     * (cache.sections type='html'), und findAutoBlock prueft die ID. Der
     * Normalfall ohne HTML-Kommentar bleibt read-frei.
     */
    async extractFile(file: TFile): Promise<void> {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) return;

        const edges: Edge[] = [];

        // FEAT-19-04-01 W3: Block-Bereich bestimmen -- nur bei vorhandenem
        // HTML-Kommentar (Fingerprint), dann ID-gepruefte Zeilen via
        // findAutoBlock gegen den echten Datei-Inhalt.
        let block: { startLine: number; endLine: number } | null = null;
        if (cache.sections?.some((s) => s.type === 'html')) {
            try {
                const content = await this.app.vault.cachedRead(file);
                block = findAutoBlock(content, INCOMING_BLOCK_ID);
            } catch (e) {
                console.warn(`[GraphExtractor] cachedRead failed for ${file.path}, treating links as body`, e);
            }
        }

        // 1. Body Wikilinks: cache.links contains all [[wikilinks]] in the note body
        // Only .md and .canvas files are valid graph edges (skip PDFs, images, Outlook/Teams links)
        if (cache.links) {
            for (const lc of cache.links) {
                const resolved = this.app.metadataCache.getFirstLinkpathDest(lc.link, file.path);
                if (!resolved) continue; // broken link — skip
                if (resolved.path === file.path) continue; // self-link — skip
                if (!resolved.path.endsWith('.md') && !resolved.path.endsWith('.canvas')) continue; // non-note — skip
                // FEAT-19-04-01 W3: liegt der Link im Rueckverweis-Block
                // (zwischen den Marker-Zeilen, beide exklusiv), zaehlt er als
                // 'backlink-block' und wird von getHubTargets/getSourcesFor
                // und checkGodNodes ausgeschlossen.
                const line = lc.position?.start?.line;
                const inBlock = block !== null && typeof line === 'number'
                    && line > block.startLine && line < block.endLine;
                edges.push({
                    targetPath: resolved.path,
                    linkType: inBlock ? 'backlink-block' : 'body',
                    propertyName: null,
                });
            }
        }

        // 2. Frontmatter link properties: MOC names + backlinksProperty +
        //    reciprocalProperties (FIX-19-01-15). Alles, worin ein Repair
        //    schreibt oder ein Check Reverse-Edges erwartet, MUSS hier
        //    extrahiert werden, sonst ist der Fix fuer den Check unsichtbar.
        if (cache.frontmatter) {
            // FIX-19-02-30: JEDE Frontmatter-Property mit Wikilinks wird zur
            // Kante, nicht nur die konfigurierten. Sonst sieht der
            // Reziprozitaets-Check einen resource:- oder Autor:-Rueckverweis
            // nie und meldet die Notiz faelschlich als einseitig. Der
            // Repair schreibt weiterhin NUR in backlinksProperty -- die
            // breitere Extraktion aendert daran nichts, sie macht den
            // Graphen nur vollstaendig.
            const configured = new Set(buildExtractedFrontmatterProperties(this.getPropertySource()));
            for (const propName of Object.keys(cache.frontmatter)) {
                if (NON_LINK_FRONTMATTER_KEYS.has(propName)) continue;
                const value = cache.frontmatter[propName];
                if (!value) continue;
                const links = this.parseWikilinksFromFrontmatter(value, file.path);
                if (links.length === 0) continue;
                // Konfigurierte Properties behalten ihren Namen (die Checks
                // und der Repair filtern darauf); alle anderen bekommen ihn
                // ebenfalls, damit ein spaeterer Wechsel der Schreib-Property
                // die Herkunft nicht verliert.
                void configured;
                for (const targetPath of links) {
                    if (targetPath === file.path) continue; // self-link — skip
                    if (!targetPath.endsWith('.md') && !targetPath.endsWith('.canvas')) continue; // non-note — skip
                    edges.push({
                        targetPath,
                        linkType: 'frontmatter',
                        propertyName: propName,
                    });
                }
            }
        }

        // 3. Tags: frontmatter tags + inline #tags
        const tags: string[] = [];
        if (cache.frontmatter?.tags) {
            const fmTags = cache.frontmatter.tags;
            const arr = Array.isArray(fmTags) ? fmTags : [fmTags];
            for (const t of arr) {
                if (typeof t === 'string') {
                    tags.push(t.startsWith('#') ? t.slice(1).toLowerCase() : t.toLowerCase());
                }
            }
        }
        if (cache.tags) {
            for (const tc of cache.tags) {
                const normalized = tc.tag.startsWith('#') ? tc.tag.slice(1).toLowerCase() : tc.tag.toLowerCase();
                if (!tags.includes(normalized)) tags.push(normalized);
            }
        }

        // Write to DB (atomic: DELETE old + INSERT new)
        this.graphStore.replaceEdgesForPath(file.path, edges);
        this.graphStore.replaceTagsForPath(file.path, tags);
    }

    /** Remove all graph data for a deleted/renamed file. */
    removeFile(path: string): void {
        this.graphStore.deleteByPath(path);
    }

    // -----------------------------------------------------------------------
    // Frontmatter Wikilink parsing
    // -----------------------------------------------------------------------

    /**
     * Parse Wikilinks from a frontmatter property value.
     * Handles multiple formats:
     *   - String: "[[KI]]" or "[[KI]], [[ML]]"
     *   - Array: [[[KI]], [[ML]]] or ["[[KI]]", "[[ML]]"]
     *   - Plain string (no brackets): "KI" → resolve as link
     *
     * Returns resolved file paths (broken links are skipped).
     */
    private parseWikilinksFromFrontmatter(value: unknown, sourcePath: string): string[] {
        const paths: string[] = [];
        const texts: string[] = [];

        if (typeof value === 'string') {
            texts.push(value);
        } else if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === 'string') texts.push(item);
            }
        }

        for (const text of texts) {
            // Try to extract [[wikilinks]]
            WIKILINK_RE.lastIndex = 0;
            let match: RegExpExecArray | null;
            let foundWikilink = false;
            while ((match = WIKILINK_RE.exec(text)) !== null) {
                foundWikilink = true;
                const linktext = match[1].trim();
                const resolved = this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
                if (resolved) paths.push(resolved.path);
            }

            // If no [[wikilinks]] found, try resolving the plain text as a link
            if (!foundWikilink && text.trim()) {
                const resolved = this.app.metadataCache.getFirstLinkpathDest(text.trim(), sourcePath);
                if (resolved) paths.push(resolved.path);
            }
        }

        return paths;
    }
}

/* eslint-enable -- end of file-level disable for boundary code (SDK/JSON/Obsidian internals) */
