/**
 * FEAT-55-06 (EPIC-55) -- cross-session topic awareness (read-only).
 *
 * When a chat's topic matches an earlier conversation, the sidebar can
 * surface it ("you explored this before -- pick up where you left off?").
 * This is a pure, deterministic, local ranker over conversation titles:
 * token overlap after stopword removal, ties broken by recency. No
 * embeddings, no API call, no mutation -- it only reads titles and ranks.
 * A later iteration can swap in the semantic index (ADR-170 note) behind
 * the same signature; the read-only contract stays.
 *
 * Architecture-map concept: parallel-chat-session (topic awareness)
 * Related: EPIC-07 chat-linking, FEAT-55-06
 */

export interface RelatedConversationInput {
    id: string;
    title: string;
    updated: string;
}

export interface FindRelatedOptions {
    /** Exclude this conversation id (the current chat never suggests itself). */
    currentId?: string;
    /** Max suggestions to return (default 5). */
    limit?: number;
}

// Common filler words that must not create false topic matches.
const STOPWORDS = new Set([
    'the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'for', 'with', 'at',
    'by', 'from', 'up', 'is', 'are', 'was', 'were', 'be', 'this', 'that',
    'it', 'as', 'or', 'but', 'not', 'no', 'so', 'if', 'then', 'my', 'your',
]);

function topicTokens(title: string): Set<string> {
    const tokens = title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t));
    return new Set(tokens);
}

/**
 * Rank pool conversations by shared topic words with `title`, most
 * relevant first. Zero-overlap entries are dropped; ties break by recency
 * (newer `updated` first). Pure: never mutates the pool.
 */
export function findRelatedConversations(
    title: string,
    pool: readonly RelatedConversationInput[],
    options: FindRelatedOptions,
): RelatedConversationInput[] {
    const currentTokens = topicTokens(title);
    if (currentTokens.size === 0) return [];
    const limit = options.limit ?? 5;

    const scored = pool
        .filter((c) => c.id !== options.currentId)
        .map((c) => {
            const other = topicTokens(c.title);
            let overlap = 0;
            for (const t of currentTokens) if (other.has(t)) overlap++;
            return { conv: c, overlap };
        })
        .filter((s) => s.overlap > 0)
        .sort((a, b) => {
            if (b.overlap !== a.overlap) return b.overlap - a.overlap;
            // Tie-break: more recent first (ISO strings sort lexically).
            return a.conv.updated < b.conv.updated ? 1 : -1;
        });

    return scored.slice(0, limit).map((s) => s.conv);
}
