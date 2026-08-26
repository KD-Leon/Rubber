/**
 * assembleMemoryContext -- builds the memory context block for the system
 * prompt from three independent parts: the cache-stable Soul/identity block,
 * the query embedding, and the ContextComposer render.
 *
 * FIX-03-19b-01: these three concerns used to share one try/catch in
 * AgentSidebarView.handleSendMessage. The query embedding gained a hard 8s
 * budget in f1bc6154 ("perf: stop boot work from starving the send path")
 * that THROWS on timeout, and every single-text embed routes through it. On a
 * slow first send the throw jumped out of the shared try/catch BEFORE the
 * SoulView render, so the whole block was dropped and the agent lost its
 * persona (it started addressing the user formally / "siezt").
 *
 * The fix decouples the three parts:
 *   - the Soul block is embedding-free and is rendered unconditionally;
 *   - the query embedding is best-effort -- a failure degrades recall to the
 *     recency fallback (ContextComposer.compose treats a null embedding as
 *     "keep the current topic lock"), it never removes the identity;
 *   - a failure in one part never takes the others down.
 *
 * Pure and dependency-injected so the decoupling invariant is unit-tested
 * without the AgentSidebarView harness. No obsidian, no plugin globals.
 */

export interface MemoryContextParts {
    /** Render the cache-stable Soul/identity block. Embedding-free. */
    renderSoul: () => string;
    /**
     * Compute the query embedding for topic-drift recall. Resolves to null
     * when there is nothing to embed; may reject (e.g. the 8s budget timeout).
     */
    embedQuery: () => Promise<Float32Array | null>;
    /**
     * Render the ContextComposer block for the given embedding. A null
     * embedding selects the recency fallback.
     */
    composeContext: (userEmbedding: Float32Array | null) => { markdown: string };
}

export async function assembleMemoryContext(parts: MemoryContextParts): Promise<string | undefined> {
    // Soul first and unconditionally: it must not depend on the embedding or
    // on the composer succeeding.
    const soulMarkdown = safeCall(parts.renderSoul, '', '[Memory] Soul render failed');

    // Best-effort query embedding. A rejection (timeout/error) degrades recall
    // to recency instead of dropping the identity block.
    let userEmbedding: Float32Array | null = null;
    try {
        userEmbedding = await parts.embedQuery();
    } catch (e) {
        console.debug('[Memory] query embedding failed; using recency fallback:', e);
    }

    const composedMarkdown = safeCall(
        () => parts.composeContext(userEmbedding).markdown,
        '',
        '[Memory] ContextComposer render failed',
    );

    const out: string[] = [];
    if (soulMarkdown) out.push(soulMarkdown);
    if (composedMarkdown) out.push(composedMarkdown);
    return out.length > 0 ? out.join('\n\n') : undefined;
}

function safeCall(fn: () => string, fallback: string, label: string): string {
    try {
        return fn();
    } catch (e) {
        console.debug(`${label}:`, e);
        return fallback;
    }
}
