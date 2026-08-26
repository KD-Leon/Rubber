/**
 * GraphStore -- Graph CRUD and BFS expansion on the Knowledge DB.
 *
 * Stores Wikilinks (body + frontmatter MOC-Properties) in the edges table
 * and tags in the tags table. Provides BFS-based neighbor expansion for
 * graph-augmented retrieval (ADR-051 Stufe 2).
 *
 * ADR-050: SQLite Knowledge DB (Schema v3)
 * FEATURE-1502: Graph Data Extraction & Expansion
 */

import type { KnowledgeDB, SqlJsDatabase } from './KnowledgeDB';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Edge {
    targetPath: string;
    // FEAT-19-04-01 W3: 'backlink-block' = ein [[Wikilink]] im selbstbildenden
    // Rueckverweis-Block. Zaehlt fuer Reziprozitaet, aber NICHT fuer
    // getHubTargets/getSourcesFor/checkGodNodes (sonst macht der Block seine
    // eigenen Quellen zu Hubs).
    linkType: 'body' | 'frontmatter' | 'backlink-block';
    propertyName: string | null;
    /** Connection reliability: 1.0 for user-authored links, variable for inferred. Default 1.0. */
    confidence?: number;
}

export interface GraphNeighbor {
    path: string;
    hopDistance: number;
    viaPath: string;
    linkType: string;
    propertyName: string | null;
    /** Connection reliability: 1.0 for explicit edges, cosine similarity for implicit. */
    confidence: number;
}

/**
 * FEAT-19-04-01: eine eingehende Kante ("wer verweist auf mich").
 */
export interface IncomingEdge {
    sourcePath: string;
    linkType: string;
    propertyName: string | null;
}

export interface GetSourcesOptions {
    /**
     * link_type-Werte, die NICHT als Quelle zaehlen sollen. Vor allem
     * 'backlink-block' (vom selbstbildenden Auto-Block erzeugt), damit ein
     * Hub sich nicht ueber seinen eigenen Rueckverweis-Block selbst zaehlt.
     */
    excludeLinkTypes?: string[];
}

// ---------------------------------------------------------------------------
// GraphStore
// ---------------------------------------------------------------------------

export class GraphStore {
    private knowledgeDB: KnowledgeDB;

    constructor(knowledgeDB: KnowledgeDB) {
        this.knowledgeDB = knowledgeDB;
    }

    // -----------------------------------------------------------------------
    // Write operations
    // -----------------------------------------------------------------------

    /**
     * Replace all outgoing edges for a source path.
     * Atomic: DELETE old + INSERT new.
     */
    replaceEdgesForPath(sourcePath: string, edges: Edge[]): void {
        const db = this.getDB();
        db.run('DELETE FROM edges WHERE source_path = ?', [sourcePath]);

        if (edges.length === 0) return;
        const stmt = db.prepare(
            'INSERT OR IGNORE INTO edges (source_path, target_path, link_type, property_name, confidence) VALUES (?, ?, ?, ?, ?)',
        );
        for (const e of edges) {
            stmt.run([sourcePath, e.targetPath, e.linkType, e.propertyName, e.confidence ?? 1.0]);
        }
        stmt.free();
        this.knowledgeDB.markDirty();
    }

    /** Replace all tags for a file path. */
    replaceTagsForPath(path: string, tags: string[]): void {
        const db = this.getDB();
        db.run('DELETE FROM tags WHERE path = ?', [path]);

        if (tags.length === 0) return;
        const stmt = db.prepare('INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)');
        for (const tag of tags) {
            stmt.run([path, tag]);
        }
        stmt.free();
        this.knowledgeDB.markDirty();
    }

    /** Delete all edges and tags for a file path. */
    deleteByPath(path: string): void {
        const db = this.getDB();
        db.run('DELETE FROM edges WHERE source_path = ? OR target_path = ?', [path, path]);
        db.run('DELETE FROM tags WHERE path = ?', [path]);
        this.knowledgeDB.markDirty();
    }

    // -----------------------------------------------------------------------
    // Read operations
    // -----------------------------------------------------------------------

    /**
     * BFS neighbor expansion: find all notes reachable within N hops via edges.
     * Bidirectional: follows both outgoing and incoming edges.
     *
     * @param originPath - Starting note path
     * @param hops - Max hop distance (1-3)
     * @param maxResults - Max total neighbors to return
     */
    /**
     * FEAT-19-04-01: die Notizen, die auf `targetPath` verweisen.
     *
     * Die eingehende Haelfte der Kantenmenge, ohne BFS und ohne Cap. Eine
     * Quelle erscheint genau einmal, auch wenn sie ueber mehrere Properties
     * verlinkt (dann gewinnt die erste in stabiler Sortierung). Diese eine
     * Query speist Auto-Block, Agent-Tool und Anzeige, damit sie nie
     * auseinanderlaufen.
     */
    getSourcesFor(targetPath: string, options?: GetSourcesOptions): IncomingEdge[] {
        const db = this.getDB();
        const rows = db.exec(
            `SELECT source_path, link_type, property_name FROM edges
             WHERE target_path = ?
             ORDER BY source_path, link_type, property_name`,
            [targetPath],
        );
        if (!rows.length || !rows[0].values.length) return [];

        const exclude = new Set(options?.excludeLinkTypes ?? []);
        const seen = new Set<string>();
        const out: IncomingEdge[] = [];
        for (const row of rows[0].values) {
            const linkType = row[1] as string;
            if (exclude.has(linkType)) continue;
            const sourcePath = row[0] as string;
            if (seen.has(sourcePath)) continue; // eine Quelle nur einmal
            seen.add(sourcePath);
            out.push({ sourcePath, linkType, propertyName: (row[2] as string | null) ?? null });
        }
        return out;
    }

    /**
     * FEAT-19-04-01: alle Ziele, auf die mindestens `minIncoming` DISTINKTE
     * Quellen verweisen -- die Hub-Notizen fuer den Rueckverweis-Block.
     * Zaehlt Quellen, nicht Kanten (eine Quelle ueber zwei Properties zaehlt
     * einmal), und kann Block-Kanten ausschliessen, damit der Block nicht
     * selbst Notizen zu Hubs macht.
     */
    getHubTargets(minIncoming: number, options?: GetSourcesOptions): string[] {
        const db = this.getDB();
        const exclude = options?.excludeLinkTypes ?? [];
        const notIn = exclude.length
            ? ` AND link_type NOT IN (${exclude.map(() => '?').join(',')})`
            : '';
        const rows = db.exec(
            `SELECT target_path FROM edges
             WHERE 1=1${notIn}
             GROUP BY target_path
             HAVING COUNT(DISTINCT source_path) >= ?
             ORDER BY target_path`,
            [...exclude, minIncoming],
        );
        if (!rows.length || !rows[0].values.length) return [];
        return rows[0].values.map((r) => r[0] as string);
    }

    getNeighbors(originPath: string, hops = 1, maxResults = 10): GraphNeighbor[] {
        const db = this.getDB();
        const visited = new Set<string>([originPath]);
        const result: GraphNeighbor[] = [];
        // M-1: Hard limit on visited set to prevent memory exhaustion in highly connected graphs
        const MAX_VISITED = 1000;

        // BFS frontier: paths to expand in current hop level
        let frontier = [originPath];

        for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
            const nextFrontier: string[] = [];

            for (const current of frontier) {
                if (result.length >= maxResults || visited.size >= MAX_VISITED) break;

                // Bidirectional: outgoing + incoming edges
                const rows = db.exec(
                    `SELECT target_path AS path, link_type, property_name, confidence FROM edges WHERE source_path = ?
                     UNION
                     SELECT source_path AS path, link_type, property_name, confidence FROM edges WHERE target_path = ?`,
                    [current, current],
                );

                if (rows.length === 0) continue;
                for (const row of rows[0].values) {
                    const neighborPath = row[0] as string;
                    if (visited.has(neighborPath)) continue;
                    visited.add(neighborPath);

                    result.push({
                        path: neighborPath,
                        hopDistance: hop,
                        viaPath: current,
                        linkType: row[1] as string,
                        propertyName: row[2] as string | null,
                        confidence: row[3] as number,
                    });
                    nextFrontier.push(neighborPath);

                    if (result.length >= maxResults) break;
                }
            }

            frontier = nextFrontier;
        }

        return result;
    }

    /**
     * BFS neighbor expansion including implicit edges (cosine similarity).
     * Same logic as getNeighbors but unions explicit edges (confidence from DB)
     * with implicit edges (similarity as confidence). FEATURE-2001, ADR-069.
     */
    getNeighborsWithImplicit(originPath: string, hops = 1, maxResults = 10): GraphNeighbor[] {
        const db = this.getDB();
        const visited = new Set<string>([originPath]);
        const result: GraphNeighbor[] = [];
        const MAX_VISITED = 1000;

        let frontier = [originPath];

        for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
            const nextFrontier: string[] = [];

            for (const current of frontier) {
                if (result.length >= maxResults || visited.size >= MAX_VISITED) break;

                const rows = db.exec(
                    `SELECT target_path AS path, link_type, property_name, confidence FROM edges WHERE source_path = ?
                     UNION
                     SELECT source_path AS path, link_type, property_name, confidence FROM edges WHERE target_path = ?
                     UNION
                     SELECT target_path AS path, 'implicit' AS link_type, NULL AS property_name, similarity AS confidence FROM implicit_edges WHERE source_path = ?
                     UNION
                     SELECT source_path AS path, 'implicit' AS link_type, NULL AS property_name, similarity AS confidence FROM implicit_edges WHERE target_path = ?`,
                    [current, current, current, current],
                );

                if (rows.length === 0) continue;
                for (const row of rows[0].values) {
                    const neighborPath = row[0] as string;
                    if (visited.has(neighborPath)) continue;
                    visited.add(neighborPath);

                    result.push({
                        path: neighborPath,
                        hopDistance: hop,
                        viaPath: current,
                        linkType: row[1] as string,
                        propertyName: row[2] as string | null,
                        confidence: row[3] as number,
                    });
                    nextFrontier.push(neighborPath);

                    if (result.length >= maxResults) break;
                }
            }

            frontier = nextFrontier;
        }

        return result;
    }

    /** Get all file paths that have a specific tag. */
    getFilesByTag(tag: string): string[] {
        const db = this.getDB();
        const normalized = tag.startsWith('#') ? tag.slice(1).toLowerCase() : tag.toLowerCase();
        const result = db.exec('SELECT path FROM tags WHERE tag = ?', [normalized]);
        if (result.length === 0) return [];
        return result[0].values.map(row => row[0] as string);
    }

    /** Total number of edges in the graph. */
    getEdgeCount(): number {
        const db = this.getDB();
        const result = db.exec('SELECT COUNT(*) FROM edges');
        if (result.length === 0 || result[0].values.length === 0) return 0;
        return result[0].values[0][0] as number;
    }

    /** Total number of unique tags. */
    getTagCount(): number {
        const db = this.getDB();
        const result = db.exec('SELECT COUNT(DISTINCT tag) FROM tags');
        if (result.length === 0 || result[0].values.length === 0) return 0;
        return result[0].values[0][0] as number;
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private getDB(): SqlJsDatabase {
        return this.knowledgeDB.getDB();
    }
}
