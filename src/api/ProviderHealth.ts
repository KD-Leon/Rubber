/**
 * Provider circuit breaker (IMP-41-03-02, ADR-146).
 *
 * States per providerType: closed (normal) -> open (fail fast) ->
 * half-open (one probe) -> closed/open. Opens after 3 exhausted transient
 * failures within a 2-minute window; auth/abort never count (a bad key is
 * a configuration problem, not an outage — it gets its own UI hint at the
 * call site). While open, callers fail in microseconds with a clear
 * message instead of running a full retry cascade against a dead provider.
 *
 * The optional tier-fallback chain (opt-in setting) consumes getState()
 * at the routing layer; the breaker itself only tracks health.
 */

import type { ProviderErrorClass } from './retry';

export type BreakerState = 'closed' | 'open' | 'half-open';

const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 2 * 60_000;
const PROBE_DELAY_MS = 60_000;

interface ProviderRecord {
    failures: number[];        // timestamps within the window
    openedAt: number | null;
    probeGranted: boolean;
}

/** Failure classes that signal an outage (count toward opening). */
const OUTAGE_CLASSES = new Set<ProviderErrorClass>(['server', 'network', 'overloaded', 'rate-limit', 'unknown']);

export class ProviderHealth {
    private records = new Map<string, ProviderRecord>();

    private record(providerType: string): ProviderRecord {
        let rec = this.records.get(providerType);
        if (!rec) {
            rec = { failures: [], openedAt: null, probeGranted: false };
            this.records.set(providerType, rec);
        }
        return rec;
    }

    getState(providerType: string): BreakerState {
        const rec = this.records.get(providerType);
        if (!rec || rec.openedAt === null) return 'closed';
        return Date.now() - rec.openedAt >= PROBE_DELAY_MS ? 'half-open' : 'open';
    }

    /**
     * Whether a request may go out right now. In half-open exactly ONE
     * probe is granted until its outcome is reported.
     */
    canRequest(providerType: string): boolean {
        const state = this.getState(providerType);
        if (state === 'closed') return true;
        if (state === 'open') return false;
        const rec = this.record(providerType);
        if (rec.probeGranted) return false;
        rec.probeGranted = true;
        return true;
    }

    /** Report a request failure with its classified error class. */
    reportFailure(providerType: string, cls: ProviderErrorClass): void {
        if (!OUTAGE_CLASSES.has(cls)) return;
        const rec = this.record(providerType);
        if (rec.openedAt !== null) {
            // Probe failed (or residual failure while open): re-open fully.
            rec.openedAt = Date.now();
            rec.probeGranted = false;
            return;
        }
        const now = Date.now();
        rec.failures = rec.failures.filter((t) => now - t <= FAILURE_WINDOW_MS);
        rec.failures.push(now);
        if (rec.failures.length >= FAILURE_THRESHOLD) {
            rec.openedAt = now;
            rec.probeGranted = false;
            rec.failures = [];
            console.warn(`[ProviderHealth] circuit OPEN for ${providerType} (fail-fast for ${PROBE_DELAY_MS / 1000}s)`);
        }
    }

    /** Report a successful request (closes the breaker from half-open). */
    reportSuccess(providerType: string): void {
        const rec = this.records.get(providerType);
        if (!rec) return;
        rec.openedAt = null;
        rec.probeGranted = false;
        rec.failures = [];
    }

    /** Seconds until the next probe is allowed (for the fail-fast message). */
    secondsUntilProbe(providerType: string): number {
        const rec = this.records.get(providerType);
        if (!rec || rec.openedAt === null) return 0;
        return Math.max(0, Math.ceil((rec.openedAt + PROBE_DELAY_MS - Date.now()) / 1000));
    }
}

/** Process-wide singleton shared by all ApiHandler wrappers. */
export const providerHealth = new ProviderHealth();
