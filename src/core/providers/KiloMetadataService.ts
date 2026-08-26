/**
 * KiloMetadataService — lädt und cached Kilo Gateway Modell-Metadaten.
 *
 * Modelle werden per GET /api/gateway/models geladen und für CACHE_TTL_MS
 * im Speicher gehalten. Der Cache wird bei Disconnect oder Org-Wechsel
 * invalidiert.
 *
 * @see ADR-042 (Metadata Discovery Strategy)
 * @see FEATURE-1304 (Dynamic Model Listing)
 */

import { requestUrl } from 'obsidian';
import { KiloAuthService } from '../security/KiloAuthService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODELS_URL    = 'https://api.kilo.ai/api/gateway/models';
const CACHE_TTL_MS  = 5 * 60 * 1000; // 5 Minuten

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KiloModel {
    id: string;
    provider?: string;
    supportsChat?: boolean;
    supportsTools?: boolean;
    supportsEmbeddings?: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class KiloMetadataService {
    private static instance: KiloMetadataService | null = null;

    private cachedModels: KiloModel[] | null = null;
    private fetchedAt = 0;

    private constructor() {}

    static getInstance(): KiloMetadataService {
        if (!KiloMetadataService.instance) {
            KiloMetadataService.instance = new KiloMetadataService();
        }
        return KiloMetadataService.instance;
    }

    /**
     * Gibt die Modellliste zurück. Nutzt den Cache, wenn er jünger als CACHE_TTL_MS ist.
     * Mit forceRefresh=true wird immer neu geladen.
     */
    async getModels(forceRefresh = false): Promise<KiloModel[]> {
        const now = Date.now();
        if (!forceRefresh && this.cachedModels && (now - this.fetchedAt) < CACHE_TTL_MS) {
            return this.cachedModels;
        }

        const authService = KiloAuthService.getInstance();
        const token = authService.getToken();

        if (!token) {
            throw new Error('Not authenticated with Kilo. Sign in first.');
        }

        const res = await requestUrl({
            url: MODELS_URL,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
            },
            throw: false,
        });

        if (res.status === 401 || res.status === 403) {
            throw new Error('Kilo authentication expired. Please sign in again.');
        }
        if (res.status >= 400) {
            throw new Error(`Failed to load Kilo models (HTTP ${res.status})`);
        }

        const data = res.json as { data?: unknown[]; models?: unknown[] };
        const raw = (data.data ?? data.models ?? []) as Record<string, unknown>[];

        this.cachedModels = raw.map((m) => ({
            id: m.id as string,
            provider: m.provider as string | undefined,
            supportsChat: m.supports_chat as boolean | undefined,
            supportsTools: m.supports_tools as boolean | undefined,
            supportsEmbeddings: m.supports_embeddings as boolean | undefined,
        })).sort((a, b) => a.id.localeCompare(b.id));

        this.fetchedAt = now;
        return this.cachedModels;
    }

    /** Cache invalidieren — bei Disconnect oder Org-Wechsel aufrufen. */
    invalidateCache(): void {
        this.cachedModels = null;
        this.fetchedAt = 0;
    }
}
