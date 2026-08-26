/**
 * clusterFreshnessScore -- the ONE freshness formula (FIX-19-16-05).
 *
 * BA-25 12.1 specified `w1*(1-age) + w2*(1-coverageDrift) + w3*(1-staleRefRate)`
 * with w = 0.6/0.3/0.1. ADR-163 removed the shared FreshnessScorer class and
 * left "two living inline copies", and both decayed: VaultHealthService wrote
 * `w3 * 1` (the stale-reference pipeline was never built, so the term was a
 * constant that lifted every score by up to 10 points), and
 * Stufe2ActivityTrigger had the coverage term constant too
 * (`0.6*(1-age) + 0.3 + 0.1`), flooring its score at 40 -- one reason the
 * stage-2 hint never fired on the live vault.
 *
 * This module renormalizes to the two terms that exist (0.65 age, 0.35
 * coverage). When a stale-reference pipeline lands, it re-enters HERE, with
 * its weight, in one place. No imports on purpose: knowledge/ and health/
 * both consume it without a cycle.
 */

/**
 * @param avgAgeDays     mean age of the cluster's notes in days
 * @param halfLifeDays   the cluster's half-life (caller guards <= 0)
 * @param coverageDrift  share of notes older than the half-life, in [0, 1]
 * @returns integer score 0..100; below 70 is the reporting threshold
 */
export function clusterFreshnessScore(
    avgAgeDays: number,
    halfLifeDays: number,
    coverageDrift: number,
): number {
    const W_AGE = 0.65;
    const W_COVERAGE = 0.35;
    const ageRatio = Math.min(1, Math.max(0, avgAgeDays / halfLifeDays));
    const drift = Math.min(1, Math.max(0, coverageDrift));
    return Math.round(100 * (W_AGE * (1 - ageRatio) + W_COVERAGE * (1 - drift)));
}
