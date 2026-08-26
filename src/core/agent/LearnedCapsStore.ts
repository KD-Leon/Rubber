/**
 * Learned model output caps (ADR-148 layer 3).
 *
 * When a provider rejects a request because max_tokens exceeds the model's
 * real output limit ("output-cap" 400), the loop learns that limit here
 * instead of failing the task. Caps persist in ONE JSON file in the GlobalFS
 * data root (same placement as inflight-tasks.json / price-catalog.json,
 * outside the vault, excluded from sync) and are injected into the model
 * registry via setLearnedOutputCaps — resolveOutputBudget then clamps every
 * later request, across tasks and plugin restarts. No deploy needed for new
 * models: the optimistic default (16k/32k) either works or is corrected once.
 *
 * Caps only ever get LOWER: a learned value reflects a provider rejection,
 * and raising it again would just re-trigger the 400.
 */

import { setLearnedOutputCaps, setLearnedModelFlags, normalizeModelId, type LearnedModelFlags } from '../../types/model-registry';

export const LEARNED_CAPS_FILE = 'learned-model-caps.json';

/** Never learn a cap below this — a smaller budget breaks tool-call turns. */
const MIN_LEARNED_CAP = 4_096;
/** INP-4: upper sanity bound — no real model output budget approaches this, so
 *  a larger persisted value means the file was tampered with; reject it. */
const MAX_LEARNED_CAP = 2_000_000;
/** INP-4: cap how many entries a persisted caps file may inject. */
const MAX_LEARNED_ENTRIES = 1_000;

interface LearnedCapsFile {
    caps: Record<string, number>;
    /**
     * FIX-54-10: per-model capability restrictions learned from provider
     * 400s (currently only effortWithToolsUnsupported). Optional so files
     * written before the field existed keep loading unchanged.
     */
    flags?: Record<string, LearnedModelFlags>;
}

export interface LearnedCapsFs {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
}

/**
 * Module-level accessor so the loop can learn caps without threading the
 * store instance through the AgentTask constructor (same pattern as
 * setLivePriceCatalog). main.ts registers the instance at boot; when none is
 * registered (unit tests, early boot) learning is a silent no-op that still
 * returns the requested cap.
 */
let activeStore: LearnedCapsStore | null = null;

export function registerLearnedCapsStore(store: LearnedCapsStore | null): void {
    activeStore = store;
}

export async function learnOutputCap(modelId: string, cap: number): Promise<number> {
    if (!activeStore) return cap;
    return activeStore.learnCap(modelId, cap);
}

/**
 * FIX-54-10: record that a model rejects function tools combined with
 * reasoning_effort on chat/completions. No-op when no store is registered
 * (unit tests, early boot), same contract as learnOutputCap.
 */
export async function learnEffortToolsUnsupported(modelId: string): Promise<void> {
    if (!activeStore) return;
    await activeStore.learnEffortWithToolsUnsupported(modelId);
}

export class LearnedCapsStore {
    private caps: Record<string, number> = {};
    /** FIX-54-10: learned per-model capability restrictions. */
    private flags: Record<string, LearnedModelFlags> = {};
    private loaded = false;

    constructor(private fs: LearnedCapsFs) {}

    /** Load persisted caps and inject them into the registry. Call at boot. Idempotent. */
    async load(): Promise<void> {
        if (this.loaded) return;
        try {
            if (await this.fs.exists(LEARNED_CAPS_FILE)) {
                const parsed = JSON.parse(await this.fs.read(LEARNED_CAPS_FILE)) as LearnedCapsFile;
                if (typeof parsed?.caps === 'object' && parsed.caps !== null) {
                    let count = 0;
                    for (const [id, cap] of Object.entries(parsed.caps)) {
                        // INP-3: never let a JSON key reach the prototype chain.
                        if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
                        // INP-4: bound the entry count against an unbounded map.
                        if (++count > MAX_LEARNED_ENTRIES) break;
                        // INP-4: bound the value so a tampered file cannot inject
                        // an absurd cap (upper bound added to the existing lower).
                        if (typeof cap === 'number' && Number.isFinite(cap)
                            && cap >= MIN_LEARNED_CAP && cap <= MAX_LEARNED_CAP) {
                            this.caps[id] = Math.floor(cap);
                        }
                    }
                }
                // FIX-54-10: flags share the caps file. Same INP-3/INP-4
                // hardening: proto-chain keys are skipped, the entry count is
                // bounded, and only a literal `true` on a known flag field is
                // copied: flags can only ADD restrictions, so any other value
                // (or an unknown field) is dropped rather than trusted.
                if (typeof parsed?.flags === 'object' && parsed.flags !== null) {
                    let flagCount = 0;
                    for (const [id, entry] of Object.entries(parsed.flags)) {
                        if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
                        if (++flagCount > MAX_LEARNED_ENTRIES) break;
                        if (typeof entry === 'object' && entry !== null
                            && entry.effortWithToolsUnsupported === true) {
                            this.flags[id] = { effortWithToolsUnsupported: true };
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[LearnedCaps] load failed (non-fatal):', e instanceof Error ? e.message : e);
        }
        this.loaded = true;
        setLearnedOutputCaps({ ...this.caps });
        setLearnedModelFlags({ ...this.flags });
    }

    getCap(modelId: string): number | undefined {
        return this.caps[normalizeModelId(modelId)];
    }

    /**
     * Record a provider-confirmed output limit. Returns the effective cap.
     * Only lowers existing values; floors at MIN_LEARNED_CAP.
     */
    async learnCap(modelId: string, cap: number): Promise<number> {
        // A learn that wins the race against the boot load() would persist
        // with the other field still empty and erase it on disk. load() is
        // idempotent, so waiting here is free after boot.
        if (!this.loaded) await this.load();
        const id = normalizeModelId(modelId);
        const bounded = Math.max(MIN_LEARNED_CAP, Math.floor(cap));
        const existing = this.caps[id];
        const effective = existing !== undefined ? Math.min(existing, bounded) : bounded;
        if (effective !== existing) {
            this.caps[id] = effective;
            setLearnedOutputCaps({ ...this.caps });
            await this.persist();
        }
        return effective;
    }

    /**
     * FIX-54-10: record that this model rejects function tools combined with
     * reasoning_effort on chat/completions ("Function tools with
     * reasoning_effort are not supported ... set reasoning_effort to
     * 'none'", gpt-5.6 platform generation). Persisted and injected into the
     * registry, so the OpenAI request builder forces effort 'none' with
     * tools from now on: this task's corrective retry AND every future
     * session. Restriction-only: there is no unlearn path.
     */
    async learnEffortWithToolsUnsupported(modelId: string): Promise<void> {
        if (!this.loaded) await this.load();
        const id = normalizeModelId(modelId);
        if (this.flags[id]?.effortWithToolsUnsupported === true) return;
        this.flags[id] = { ...this.flags[id], effortWithToolsUnsupported: true };
        setLearnedModelFlags({ ...this.flags });
        await this.persist();
    }

    private async persist(): Promise<void> {
        try {
            await this.fs.write(LEARNED_CAPS_FILE, JSON.stringify({
                caps: this.caps,
                flags: this.flags,
            } satisfies LearnedCapsFile));
        } catch (e) {
            console.warn('[LearnedCaps] persist failed (non-fatal):', e instanceof Error ? e.message : e);
        }
    }
}
