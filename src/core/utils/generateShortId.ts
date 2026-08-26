/**
 * FEAT-55-03 (EPIC-55, ADR-171) -- collision-safe short id generator.
 *
 * Extracted from ConversationStore.generateId so run ids, conversation
 * ids, and any other short id share one hardened implementation. Format:
 * `YYYY-MM-DD-<12 hex>` (optionally prefixed), giving a browse-friendly
 * date prefix plus 48 bits of crypto entropy per day -- collision-free
 * across concurrent same-millisecond starts, unlike the old
 * `task-${Date.now()}`. Filesystem-safe: no `/`, `\`, `..`, or null,
 * so GitCheckpointService path validators keep passing.
 *
 * crypto.randomUUID() is always available on Electron/Chromium (Web
 * Crypto API); no Math.random fallback (AUDIT-025 H-2 removed it as a
 * js/insecure-randomness finding).
 *
 * Architecture-map concept: run-identity-persistence
 * Related: ADR-171
 */
export function generateShortId(prefix?: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const core = `${date}-${uuid}`;
    return prefix ? `${prefix}-${core}` : core;
}
