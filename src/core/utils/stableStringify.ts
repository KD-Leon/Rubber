/**
 * stableStringify
 *
 * JSON.stringify that recursively sorts object keys so two structurally
 * equal objects produce identical strings regardless of property
 * insertion order. The standard JSON.stringify(value, sortedTopKeys)
 * trick only sorts the TOP level; nested objects keep their original
 * order, which leaks through cache keys and breaks deduplication.
 *
 * Arrays preserve order. Null, primitives and circular refs are
 * passed through to JSON.stringify which throws on cycles like the
 * native call does.
 */

export function stableStringify(value: unknown): string {
    return JSON.stringify(value, (_: string, v: unknown) => {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
        const obj = v as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(obj).sort()) {
            sorted[key] = obj[key];
        }
        return sorted;
    });
}
