/**
 * Advisor-reminder cache trigger as a loop interceptor (IMP-41-02-01c;
 * EPIC-26 / FEAT-26-01 / ADR-120 for the reminder semantics).
 *
 * The consult_flagship hint renders below the cache marker when the
 * mistake counter crosses the threshold; the PROMPT text itself is built
 * in rebuildPromptCache from `consecutiveMistakes >= 2`. This interceptor
 * only detects the transition (off->on or on->off) and invalidates the
 * prompt cache so the re-render actually happens — previously an inline
 * block with a closure flag.
 */

import type { LoopInterceptor, LoopInterceptorContext } from './types';

export class AdvisorReminderInterceptor implements LoopInterceptor {
    readonly name = 'advisor-reminder';
    private lastReminderState = false;

    onIterationStart(ctx: LoopInterceptorContext): void {
        const shouldBeActive = ctx.state.consecutiveMistakes >= 2;
        if (shouldBeActive !== this.lastReminderState) {
            ctx.state.cacheInvalidated = true;
            this.lastReminderState = shouldBeActive;
        }
    }
}
