/**
 * Persist the note-level freshness class from the per-chunk majority vote
 * (FEATURE-2006). Extracted from SemanticIndexService.storeFreshnessClass so
 * the write path is testable against a real sql.js database.
 */

type SqlRunDatabase = { run(sql: string, params?: unknown[]): unknown };

/**
 * Write the classification for a note without touching the verifier columns.
 *
 * FIX-19-16-02: the previous `INSERT OR REPLACE` deleted and recreated the
 * row, which nulled the six Stufe-3 verifier columns (last_verdict,
 * last_confidence, last_summary, last_sources_json, last_checked_at,
 * last_verifier_tier) on every re-classification. Measured on the live vault
 * 2026-08-21: 350 notes carried a paid verdict in note_freshness_history,
 * only 15 survived in note_freshness, and all 325 losses had classified_at
 * newer than their last run. The verdicts also became due again immediately
 * (NoteSelector treats last_checked_at IS NULL as due), so the same checks
 * were paid twice. ON CONFLICT updates only the classification columns.
 */
export function upsertFreshnessClass(
    db: SqlRunDatabase,
    filePath: string,
    freshnessClass: 'volatile' | 'evolving' | 'stable',
    classifiedAtIso: string,
): void {
    db.run(
        `INSERT INTO note_freshness (path, freshness_class, temporal_marker_count, classified_at)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(path) DO UPDATE SET
             freshness_class = excluded.freshness_class,
             temporal_marker_count = excluded.temporal_marker_count,
             classified_at = excluded.classified_at`,
        [filePath, freshnessClass, classifiedAtIso],
    );
}
