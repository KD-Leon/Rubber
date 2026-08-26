/**
 * FIX-COMPACT-03: single source of truth for condensing defaults.
 *
 * Three call sites previously held independent literals:
 *   - DEFAULT_SETTINGS.advancedApi   (settings.ts)
 *   - AgentTaskRunner option fallbacks
 *   - AgentSidebarView spawn-time `??` fallbacks
 *
 * The values drifted (Runner used 70, Sidebar fell back to false), so
 * subagents inherited different compacting behaviour depending on the
 * spawn path. Exporting one constant per setting forces every caller
 * through the same default and a future tuning change updates them all
 * atomically.
 */

export const DEFAULT_CONDENSING_ENABLED = true;
export const DEFAULT_CONDENSING_THRESHOLD = 80;
export const DEFAULT_MICROCOMPACTION_ENABLED = true;
export const DEFAULT_ROLLING_SUMMARY_THRESHOLD = 50;

/**
 * FIX-COMPACT-09 (extended 2026-07-05): microcompact economy guard. A prune
 * rewrites history before the stable cache breakpoint and forces a full
 * prompt-cache prefix re-write (observed: ~260 tokens freed vs 30k+ tokens
 * cacheCreate). The guard therefore defers small frees. It applies at ALL
 * pressures BELOW the ceiling -- the original gate only fired below a 0.60
 * floor, which left pruning unconditional in the 0.60..ceiling band, exactly
 * the high-pressure turns where the cache rebuild is most expensive (the
 * 0.80 EUR daily-briefing driver). At/above the ceiling the context is under
 * real pressure and a prune runs regardless of cache cost, to make room before
 * full condensing (DEFAULT_CONDENSING_THRESHOLD = 80%) kicks in.
 */
export const MICROCOMPACT_MIN_FREED_TOKENS = 3000;
export const MICROCOMPACT_PRESSURE_CEILING = 0.75;

/**
 * IMP-01-04-03: below this much free headroom the microcompactor does NOT
 * prune, no matter how large the free. The absolute 3000-token floor above was
 * window-blind: on a 1M-context model with ~920k free tokens it still pruned a
 * just-read 12k-token transcript, which the model then re-read -- the dominant
 * turn multiplier for /meeting-summary. Pruning only earns its prompt-cache
 * rebuild once the context is genuinely filling up (headroom <= this fraction),
 * at which point the FIX-COMPACT-09 economy floor and the 80% condense catch
 * take over. Tunable single knob; do not push above ~0.85 or the high-headroom
 * re-read protection stops firing.
 */
export const MICROCOMPACT_MIN_HEADROOM_FRACTION = 0.5;
