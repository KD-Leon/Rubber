/**
 * ModelPricing -- USD/EUR cost calculation per model (ADR-090, Lever 5 + 10)
 *
 * Pricing is per-million tokens. Numbers are best-effort published rates,
 * may drift over time -- update when models change. Falls back to Sonnet
 * pricing for unknown models so we always show *something*.
 *
 * USD->EUR uses a static rate (configurable). The point is order-of-magnitude
 * cost awareness for the user, not financial accuracy.
 */

export interface ModelPrice {
    /** USD per 1M input tokens (uncached) */
    inputPerMillionUsd: number;
    /** USD per 1M output tokens */
    outputPerMillionUsd: number;
    /** USD per 1M tokens read from prompt cache (typically 10% of input) */
    cacheReadPerMillionUsd?: number;
    /** USD per 1M tokens written to prompt cache (typically 125% of input) */
    cacheWritePerMillionUsd?: number;
}

export interface CostBreakdown {
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheWriteCost: number;
    totalUsd: number;
    totalEur: number;
}

/** FIX-24-05-05: token usage attributed to one model. */
export interface ModelUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
}

/**
 * Per-model usage buckets keyed by model id. A task that mixes models
 * (advisor flagship, fast-tier subagents, TaskRouter escalation, helper
 * condensing) carries one bucket per model so cost can be computed per
 * model instead of pricing the total under a single id.
 */
export type UsageByModel = Record<string, ModelUsage>;

/** Add usage to the bucket for `modelId`, creating it on demand. */
export function addUsage(
    target: UsageByModel,
    modelId: string,
    input: number,
    output: number,
    cacheRead = 0,
    cacheCreation = 0,
): void {
    const key = modelId || 'unknown';
    const bucket = target[key] ?? (target[key] = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    bucket.input += input;
    bucket.output += output;
    bucket.cacheRead += cacheRead;
    bucket.cacheCreation += cacheCreation;
}

/** Merge all of `source`'s buckets into `target`. */
export function mergeUsageByModel(target: UsageByModel, source: UsageByModel | undefined): void {
    if (!source) return;
    for (const [id, u] of Object.entries(source)) {
        addUsage(target, id, u.input, u.output, u.cacheRead, u.cacheCreation);
    }
}

/** Sum of per-model costs -- the correct price for a mixed-model task. */
export function computeCostForBuckets(usageByModel: UsageByModel): CostBreakdown {
    const total: CostBreakdown = { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, totalUsd: 0, totalEur: 0 };
    for (const [id, u] of Object.entries(usageByModel)) {
        const c = computeCost(id, u.input, u.output, u.cacheRead, u.cacheCreation);
        total.inputCost += c.inputCost;
        total.outputCost += c.outputCost;
        total.cacheReadCost += c.cacheReadCost;
        total.cacheWriteCost += c.cacheWriteCost;
        total.totalUsd += c.totalUsd;
        total.totalEur += c.totalEur;
    }
    return total;
}

const USD_TO_EUR = 0.93;

/**
 * Manual pricing-table maintenance marker. Bump this string when you have
 * just verified the PRICING table below against the live Anthropic /
 * OpenAI / Google rate cards. ISO date.
 *
 * Why this is manual rather than scraped: the three vendors publish prices
 * on HTML pages with no stable machine-readable contract. A reminder is
 * pragmatic; a scraper would break with every redesign.
 */
export const PRICING_LAST_UPDATED = '2026-07-02';
const PRICING_STALE_DAYS = 90;

/**
 * Return a maintenance warning string when the pricing table has not been
 * touched for more than PRICING_STALE_DAYS, otherwise null. Called once
 * from plugin onload so the warning shows up exactly once per session.
 */
export function getPricingAgeWarning(today: Date = new Date()): string | null {
    const last = new Date(PRICING_LAST_UPDATED);
    const days = Math.floor((today.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));
    if (days <= PRICING_STALE_DAYS) return null;
    return `[ModelPricing] Pricing table is ${days} days old (last updated ${PRICING_LAST_UPDATED}). ` +
        'Verify Anthropic / OpenAI / Google rate cards and bump PRICING_LAST_UPDATED.';
}

/**
 * Pricing table. Keys are matched by:
 *   1. Exact model id (case-insensitive)
 *   2. Substring fallback (e.g. "claude-sonnet" matches any sonnet variant)
 * If nothing matches, FALLBACK is used so the UI never shows blank.
 */
const PRICING: Record<string, ModelPrice> = {
    // Anthropic Claude. Opus dropped to 5/25 with Opus 4.5 (Nov 2025);
    // only Opus 4.0/4.1 keep the legacy 15/75 rates. The bare
    // 'claude-opus-4' key stays at 15/75 so opus-4-0/4-1 substring
    // matches price correctly; newer generations have explicit entries.
    'claude-fable-5': { inputPerMillionUsd: 10, outputPerMillionUsd: 50, cacheReadPerMillionUsd: 1, cacheWritePerMillionUsd: 12.5 },
    'claude-opus-4-8': { inputPerMillionUsd: 5, outputPerMillionUsd: 25, cacheReadPerMillionUsd: 0.5, cacheWritePerMillionUsd: 6.25 },
    'claude-opus-4-7': { inputPerMillionUsd: 5, outputPerMillionUsd: 25, cacheReadPerMillionUsd: 0.5, cacheWritePerMillionUsd: 6.25 },
    'claude-opus-4-6': { inputPerMillionUsd: 5, outputPerMillionUsd: 25, cacheReadPerMillionUsd: 0.5, cacheWritePerMillionUsd: 6.25 },
    'claude-opus-4-5': { inputPerMillionUsd: 5, outputPerMillionUsd: 25, cacheReadPerMillionUsd: 0.5, cacheWritePerMillionUsd: 6.25 },
    'claude-opus-4': { inputPerMillionUsd: 15, outputPerMillionUsd: 75, cacheReadPerMillionUsd: 1.5, cacheWritePerMillionUsd: 18.75 },
    // Sonnet 5 sticker price; intro pricing (2/10 through 2026-08-31) is
    // deliberately not modeled -- sticker keeps the table stable.
    'claude-sonnet-5': { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75 },
    'claude-sonnet-4-6': { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75 },
    'claude-sonnet-4-5': { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75 },
    'claude-sonnet-4': { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75 },
    'claude-haiku-4-5': { inputPerMillionUsd: 1, outputPerMillionUsd: 5, cacheReadPerMillionUsd: 0.1, cacheWritePerMillionUsd: 1.25 },

    // OpenAI. mini/nano variants need their own entries: the substring
    // fallback would otherwise route them onto the full-size price.
    'gpt-5-mini': { inputPerMillionUsd: 0.25, outputPerMillionUsd: 2, cacheReadPerMillionUsd: 0.025 },
    'gpt-5-nano': { inputPerMillionUsd: 0.05, outputPerMillionUsd: 0.4, cacheReadPerMillionUsd: 0.005 },
    'gpt-5': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, cacheReadPerMillionUsd: 0.125 },
    'gpt-4.1': { inputPerMillionUsd: 2, outputPerMillionUsd: 8, cacheReadPerMillionUsd: 0.5 },
    'gpt-4o': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10, cacheReadPerMillionUsd: 1.25 },
    'gpt-4o-mini': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6, cacheReadPerMillionUsd: 0.075 },
    'o3-mini': { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4, cacheReadPerMillionUsd: 0.55 },
    'o3': { inputPerMillionUsd: 2, outputPerMillionUsd: 8, cacheReadPerMillionUsd: 0.5 },
    'o4-mini': { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4, cacheReadPerMillionUsd: 0.275 },

    // Google (cache read = implicit caching, 75% discount on input)
    'gemini-2.5-pro': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, cacheReadPerMillionUsd: 0.3125 },
    'gemini-2.5-flash': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5, cacheReadPerMillionUsd: 0.075 },

    // Meta (free tiers approximated)
    'llama-3': { inputPerMillionUsd: 0.2, outputPerMillionUsd: 0.6 },
};

/** Used when nothing matches -- midrange Sonnet pricing so UI never blanks. */
const FALLBACK: ModelPrice = { inputPerMillionUsd: 3, outputPerMillionUsd: 15, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75 };

/**
 * IMP-24-05-02: live price catalog (OpenRouter /v1/models, keys normalized
 * by PriceCatalogService). Preferred over the static table when set -- it
 * carries current vendor rates including intro pricing and models newer
 * than any manual maintenance. The static table stays as offline fallback.
 */
let LIVE_CATALOG: Record<string, ModelPrice> | null = null;
let LIVE_KEYS_BY_LENGTH: string[] = [];

export function setLivePriceCatalog(catalog: Record<string, ModelPrice> | null): void {
    LIVE_CATALOG = catalog && Object.keys(catalog).length > 0 ? catalog : null;
    LIVE_KEYS_BY_LENGTH = LIVE_CATALOG
        ? Object.keys(LIVE_CATALOG).sort((a, b) => b.length - a.length)
        : [];
}

/**
 * Incoming ids use vendor-specific spellings (Bedrock
 * `eu.anthropic.claude-haiku-4-5-...`, OpenRouter
 * `anthropic/claude-opus-4.8`). Live-catalog keys use the dashed form,
 * so normalize version dots before matching.
 */
function normalizeForLiveLookup(modelId: string): string {
    return modelId.toLowerCase().replace(/(\d)\.(\d)/g, '$1-$2');
}

/** Look up pricing for a model id. Falls back gracefully. */
export function getModelPrice(modelId: string | undefined | null): ModelPrice {
    if (!modelId) return FALLBACK;
    const lower = modelId.toLowerCase();

    // IMP-24-05-02: live catalog first (exact, then longest-substring).
    if (LIVE_CATALOG) {
        const norm = normalizeForLiveLookup(modelId);
        if (LIVE_CATALOG[norm]) return LIVE_CATALOG[norm];
        for (const key of LIVE_KEYS_BY_LENGTH) {
            if (norm.includes(key)) return LIVE_CATALOG[key];
        }
    }

    // Exact match first
    if (PRICING[lower]) return PRICING[lower];

    // Substring fallback (longest key first so claude-sonnet-4-6 wins over claude-sonnet-4)
    const sortedKeys = Object.keys(PRICING).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
        if (lower.includes(key)) return PRICING[key];
    }
    return FALLBACK;
}

/**
 * Compute cost for a usage report.
 * cacheReadTokens are billed at the cache-read rate (much cheaper).
 * cacheCreationTokens are billed at the cache-write rate (slightly more than input).
 * Regular inputTokens already exclude cache hits in most providers' usage reports.
 */
export function computeCost(
    modelId: string | undefined | null,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0,
    cacheCreationTokens: number = 0,
): CostBreakdown {
    const price = getModelPrice(modelId);

    const inputCost = (inputTokens / 1_000_000) * price.inputPerMillionUsd;
    const outputCost = (outputTokens / 1_000_000) * price.outputPerMillionUsd;
    const cacheReadCost = (cacheReadTokens / 1_000_000) * (price.cacheReadPerMillionUsd ?? price.inputPerMillionUsd);
    const cacheWriteCost = (cacheCreationTokens / 1_000_000) * (price.cacheWritePerMillionUsd ?? price.inputPerMillionUsd);

    const totalUsd = inputCost + outputCost + cacheReadCost + cacheWriteCost;
    const totalEur = totalUsd * USD_TO_EUR;

    return { inputCost, outputCost, cacheReadCost, cacheWriteCost, totalUsd, totalEur };
}

/**
 * Format an EUR amount for compact display in the UI footer using the
 * locale-aware German currency format. Uses up to 4 fraction digits so
 * sub-cent values stay legible (a Haiku query is often 0,0005 EUR).
 *
 *   0.0005 -> "0,0005 €"
 *   0.02   -> "0,02 €"
 *   1.23   -> "1,23 €"
 *
 * (Plan v2.10.0 user request: replace mixed ¢/€ format with a single
 * locale-correct currency representation.)
 */
const EUR_FORMATTER = new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
});

export function formatEur(eur: number): string {
    return EUR_FORMATTER.format(eur);
}
