/**
 * Shared open-time helpers for the sql.js-backed knowledge databases
 * (KnowledgeDB and its MemoryDB / HistoryDB wrappers).
 *
 * Issue #32: every KnowledgeDB instance used to compile the ~740 KB sql.js
 * WASM module on its own, so a cold boot paid 2-3 separate compiles (memory.db
 * + history.db, plus knowledge.db when the semantic index is enabled).
 * getSqlModule() memoizes the compiled module so all instances share ONE
 * compile and ONE base64 decode -- the direct fix for "slow to enable even
 * without vector indexes". sql.js is designed for one Module + many Database
 * instances, so sharing is both safe and idiomatic.
 */

type InitSqlJs<T> = (config?: { wasmBinary?: ArrayBuffer }) => Promise<T>;

let sharedSqlModule: Promise<unknown> | null = null;

/**
 * Return the shared, compiled sql.js module, compiling it at most once across
 * all callers (including concurrent ones during boot). The WASM binary is
 * loaded/decoded only for that single compile. On failure the cache is cleared
 * so a later open() can retry instead of being stuck with a rejected promise.
 */
export function getSqlModule<T>(initSqlJs: InitSqlJs<T>, loadWasm: () => Promise<ArrayBuffer>): Promise<T> {
    if (sharedSqlModule) return sharedSqlModule as Promise<T>;
    const p = (async () => {
        const wasmBinary = await loadWasm();
        return initSqlJs({ wasmBinary });
    })();
    sharedSqlModule = p;
    p.catch(() => { if (sharedSqlModule === p) sharedSqlModule = null; });
    return p;
}

/** Test-only: drop the memoized module so each test starts from a clean slate. */
export function resetSqlModuleCache(): void {
    sharedSqlModule = null;
}

/** Warn threshold for a single sql.js database file (bytes). */
export const DB_SIZE_WARN_BYTES = 300 * 1024 * 1024; // 300 MB

/**
 * Issue #32: a knowledge.db that has grown very large is loaded whole into
 * memory by sql.js (no paging), which slows startup and every query. Returns a
 * user-facing warning string when the on-disk size exceeds the threshold, or
 * null when it is within budget. Pure, so it is trivially testable.
 */
export function dbSizeWarning(byteLength: number, label: string, threshold: number = DB_SIZE_WARN_BYTES): string | null {
    if (byteLength <= threshold) return null;
    const mb = Math.round(byteLength / (1024 * 1024));
    const capMb = Math.round(threshold / (1024 * 1024));
    return `[KnowledgeDB] ${label} is ${mb} MB (over ${capMb} MB). A large database slows startup and search; consider rebuilding or pruning the index.`;
}
