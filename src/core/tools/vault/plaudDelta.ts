/**
 * plaudDelta -- pure set difference for the plaud-meeting-delta-ingest skill.
 *
 * "Which Plaud recordings are not yet imported?" used to lean on search_files,
 * which is capped by design (500 files / 50 hits / 1500 ms in SearchFilesTool):
 * on a real vault it silently misses already-imported notes and re-suggests
 * them, producing duplicates. The native ComputePlaudDeltaTool instead scans the
 * complete, in-memory metadataCache for every note's resource id and calls this
 * pure function. Kept free of any Obsidian dependency so the delta rule is
 * unit-tested in isolation; the tool builds `existingIds` from metadataCache.
 */

/** A recording as it arrives from the Plaud list_files MCP call. */
export interface PlaudFileMeta {
    id?: string;
    name?: string;
    start_at?: string;
    created_at?: string;
    duration?: number;
    serial_number?: string;
}

/** A recording that still needs importing, with the fields the ingest step uses. */
export interface PlaudDeltaEntry {
    id: string;
    name: string;
    start_at: string;
    created_at: string;
    duration: number;
    serial_number: string;
}

export interface PlaudDeltaResult {
    to_ingest: PlaudDeltaEntry[];
    already_have: Array<{ id: string; name: string; path: string }>;
    to_ingest_ids: string[];
    scanned_ids: number;
}

/**
 * Partition the Plaud recordings into "not yet in the vault" (to_ingest) and
 * "already imported" (already_have), keyed by the lowercased recording id.
 * `existingIds` maps an id already present in the vault to the note path that
 * carries it (best effort; first note wins). Recordings without an id are
 * dropped. Order of to_ingest follows the input order so the caller's
 * selection UI stays stable.
 */
export function computePlaudDelta(
    plaudFiles: PlaudFileMeta[],
    existingIds: Map<string, string>,
): PlaudDeltaResult {
    const toIngest: PlaudDeltaEntry[] = [];
    const alreadyHave: Array<{ id: string; name: string; path: string }> = [];
    const seenInput = new Set<string>();

    for (const f of Array.isArray(plaudFiles) ? plaudFiles : []) {
        const id = String((f && f.id) || '').toLowerCase();
        if (!id) continue;
        // A recording listed twice by Plaud must not be ingested twice.
        if (seenInput.has(id)) continue;
        seenInput.add(id);

        if (existingIds.has(id)) {
            alreadyHave.push({ id, name: (f && f.name) || '', path: existingIds.get(id) || '' });
        } else {
            toIngest.push({
                id,
                name: (f && f.name) || '',
                start_at: (f && f.start_at) || (f && f.created_at) || '',
                created_at: (f && f.created_at) || '',
                duration: (f && typeof f.duration === 'number') ? f.duration : 0,
                serial_number: (f && f.serial_number) || '',
            });
        }
    }

    return {
        to_ingest: toIngest,
        already_have: alreadyHave,
        to_ingest_ids: toIngest.map((t) => t.id),
        scanned_ids: existingIds.size,
    };
}
