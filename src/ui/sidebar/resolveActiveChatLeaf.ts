/**
 * FEAT-55-01 (EPIC-55, ADR-169) -- pure active chat-leaf resolver.
 *
 * With parallel chat sessions (N sidebar/tab leaves of the same view
 * type), vault-wide actions must target the chat the user last worked
 * in, not the first leaf. This is the single resolver every migrated
 * call site in main.ts routes through.
 *
 * Deliberately generic over the leaf type (`T`) and leaf-count agnostic:
 * while only one chat exists it returns that one, so the call-site
 * migration ships and stays behaviour-identical BEFORE the multi-leaf
 * detach loop is removed (the last slice of PLAN-53). Identity is by
 * reference, so it needs no Obsidian types and is unit-testable without
 * a running workspace.
 *
 * Resolution order (ADR-169 fallback chain):
 *   1. last-focused leaf, if it is still among `leaves` (still attached)
 *   2. most-recent chat leaf, if it is still among `leaves`
 *   3. the first leaf
 *   4. null (caller must ensure-at-least-one before acting)
 *
 * Architecture-map concept: parallel-chat-session
 * Related: ADR-169 (multi-leaf session model), ADR-170
 */
export function resolveActiveChatLeaf<T>(
    leaves: readonly T[],
    lastFocused: T | null,
    mostRecent: T | null,
): T | null {
    if (leaves.length === 0) return null;
    if (lastFocused !== null && leaves.includes(lastFocused)) return lastFocused;
    if (mostRecent !== null && leaves.includes(mostRecent)) return mostRecent;
    return leaves[0];
}
