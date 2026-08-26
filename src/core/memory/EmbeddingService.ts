/**
 * EmbeddingService -- single embedding entry point for the engine.
 *
 * Phase-1 strategy (PLAN-004 task 5): thin adapter. The class exposes
 * the canonical engine API but delegates the actual HTTP/model work to
 * a host-provided `EmbeddingProvider`. The three current callers
 * (SemanticIndexService for vault chunks, MemoryRetriever for fact
 * lookups, EpisodicExtractor for episode summaries) keep their existing
 * paths in Phase 1 -- migrating them is Phase 2 / FEATURE-0316 to keep
 * Phase 1 risk bounded.
 *
 * Why an adapter and not a re-implementation? The existing path in
 * SemanticIndexService.embedBatchViaApi has battle-tested retry,
 * backoff, batch-size handling, and provider quirks (Azure, OpenAI,
 * OpenRouter, Ollama, LMStudio). Re-deriving that is risk for no
 * Phase-1 benefit. The adapter shape we ship now is what Phase 2
 * will plug into.
 *
 * No `obsidian` import. Engine-extract-ready (ADR-080).
 *
 * FEATURE-0315 / PLAN-004 task 5.
 */

export interface ModelInfo {
    /** Model identifier, e.g. `text-embedding-3-small` or `qwen/qwen3-embedding-8b`. */
    model: string;
    /** Provider tag, e.g. `openai`, `openrouter`, `azure`, `ollama`, `lmstudio`, `mock`. */
    provider: string;
    /** Vector dimensionality, when known. */
    dimensions?: number;
}

/**
 * Adapter interface a host registers with the EmbeddingService. Hosts
 * decide how requests are issued (SDK, fetch, requestUrl) and how
 * retries / rate-limit backoff behave.
 */
export interface EmbeddingProvider {
    readonly info: ModelInfo;
    embed(texts: string[]): Promise<Float32Array[]>;
}

export class EmbeddingService {
    private provider: EmbeddingProvider | null;

    constructor(provider: EmbeddingProvider | null = null) {
        this.provider = provider;
    }

    setProvider(provider: EmbeddingProvider | null): void {
        this.provider = provider;
    }

    getProvider(): EmbeddingProvider | null {
        return this.provider;
    }

    /** Returns ModelInfo or null when no provider is configured. */
    getModelInfo(): ModelInfo | null {
        return this.provider?.info ?? null;
    }

    isReady(): boolean {
        return this.provider !== null;
    }

    /**
     * Embed an array of texts. Returns one Float32Array per input.
     * Throws when no provider is configured -- callers must check
     * isReady() or handle the error.
     *
     * FIX-PERF-34: bounded LRU cache by (provider-info, text). The
     * memory-context build embeds the user message before every send;
     * resending the same text (typing a follow-up, slash-command re-
     * issue, retry after error) hits the cache and skips a 100-400 ms
     * provider call on the host-prep critical path.
     */
    async embed(texts: string[]): Promise<Float32Array[]> {
        if (texts.length === 0) return [];
        if (!this.provider) {
            throw new Error('EmbeddingService: no provider configured. Call setProvider() first.');
        }
        const providerKey = this.providerCacheKey();
        const cached: Array<Float32Array | null> = texts.map((t) =>
            this.lruGet(providerKey, t),
        );
        const missingIdx: number[] = [];
        const missingTexts: string[] = [];
        for (let i = 0; i < texts.length; i++) {
            if (cached[i] === null) {
                missingIdx.push(i);
                missingTexts.push(texts[i]);
            }
        }
        if (missingTexts.length === 0) {
            return cached.map((v) => v as Float32Array);
        }
        const fresh = await this.provider.embed(missingTexts);
        if (!Array.isArray(fresh) || fresh.length !== missingTexts.length) {
            throw new Error(
                `EmbeddingService: provider returned ${fresh?.length ?? 'no'} vectors for ${missingTexts.length} inputs`,
            );
        }
        const out: Float32Array[] = new Array<Float32Array>(texts.length);
        for (let i = 0; i < texts.length; i++) {
            out[i] = cached[i] ?? fresh[missingIdx.indexOf(i)];
        }
        for (let i = 0; i < missingTexts.length; i++) {
            this.lruPut(providerKey, missingTexts[i], fresh[i]);
        }
        return out;
    }

    // FIX-PERF-34: bounded LRU. 200 entries covers any realistic
    // ContextComposer + Memory-Recall sequence without unbounded growth.
    private static readonly EMBED_CACHE_LIMIT = 200;
    private embedCache = new Map<string, Float32Array>();
    private providerCacheKey(): string {
        const info = this.provider?.info;
        if (!info) return 'unknown';
        return `${info.provider}|${info.model}|${info.dimensions}`;
    }
    private lruGet(providerKey: string, text: string): Float32Array | null {
        const key = `${providerKey}\u0000${text}`;
        const v = this.embedCache.get(key);
        if (v === undefined) return null;
        // Touch: re-insert moves the entry to the most-recent end.
        this.embedCache.delete(key);
        this.embedCache.set(key, v);
        return v;
    }
    private lruPut(providerKey: string, text: string, value: Float32Array): void {
        const key = `${providerKey}\u0000${text}`;
        this.embedCache.delete(key);
        this.embedCache.set(key, value);
        if (this.embedCache.size > EmbeddingService.EMBED_CACHE_LIMIT) {
            const oldest = this.embedCache.keys().next();
            if (!oldest.done) this.embedCache.delete(oldest.value);
        }
    }
}
