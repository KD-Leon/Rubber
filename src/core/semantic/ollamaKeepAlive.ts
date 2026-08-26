/**
 * Ollama keep_alive helpers (issue #62).
 *
 * Ollama keeps an embedding model resident in VRAM for its own default of
 * 5 minutes after each request unless a `keep_alive` value is sent. The
 * OpenAI-compatible `/v1/embeddings` endpoint that the SDK path uses does NOT
 * carry `keep_alive` (it is not an OpenAI parameter), so the value is only
 * honoured on Ollama's native `/api/embed` endpoint. These pure helpers turn a
 * user setting into a wire value and parse the native response, kept separate
 * from SemanticIndexService so they are unit-testable without the sandbox/DB.
 */

/**
 * Normalise the user's keep_alive setting into an Ollama wire value.
 *
 * - empty / whitespace   -> undefined  (leave Ollama's own default, unchanged path)
 * - pure integer string  -> number of seconds ("0" unloads right after the call,
 *                           a negative value keeps it resident indefinitely)
 * - anything else        -> passed through as a duration string ("30s", "5m", "2h")
 */
export function normalizeKeepAlive(value: string | undefined): string | number | undefined {
    const trimmed = (value ?? '').trim();
    if (trimmed === '') return undefined;
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    return trimmed;
}

/**
 * Parse Ollama's native `/api/embed` response into embedding vectors.
 *
 * The native endpoint returns `{ embeddings: number[][] }` in input order
 * (unlike the OpenAI shape `{ data: [{ index, embedding }] }`). Throws a
 * descriptive error rather than returning a short/undefined array, so a
 * malformed response fails the build loudly instead of poisoning the index.
 */
export function parseOllamaNativeEmbeddings(body: unknown, expected: number): Float32Array[] {
    if (!body || typeof body !== 'object') {
        throw new Error('Ollama /api/embed: response was not a JSON object');
    }
    const embeddings = (body as { embeddings?: unknown }).embeddings;
    if (!Array.isArray(embeddings)) {
        throw new Error('Ollama /api/embed: response has no embeddings array');
    }
    if (embeddings.length !== expected) {
        throw new Error(
            `Ollama /api/embed: expected ${expected} embeddings, got ${embeddings.length}`,
        );
    }
    return embeddings.map((vec, i) => {
        if (!Array.isArray(vec)) {
            throw new Error(`Ollama /api/embed: embedding ${i} is not an array`);
        }
        return new Float32Array(vec as number[]);
    });
}
