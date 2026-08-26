/**
 * Power steering as a loop interceptor (IMP-41-02-01c; reminder semantics
 * unchanged from the inline block, FIX-PERF-24 dedupe included).
 *
 * Every N iterations a mode-role reminder is appended as a user message so
 * long agentic runs do not drift out of their role. N=0 disables.
 */

import type { LoopInterceptor, LoopInterceptorContext } from './types';

export class PowerSteeringInterceptor implements LoopInterceptor {
    readonly name = 'power-steering';

    constructor(private frequency: number) {}

    onIterationStart(ctx: LoopInterceptorContext): void {
        const { state, history, activeMode } = ctx;
        if (this.frequency <= 0 || state.iteration === 0 || state.iteration % this.frequency !== 0) {
            return;
        }
        const reminder = `[Power Steering Reminder]\n\nYou are operating in **${activeMode.name}** mode.\n\n${activeMode.roleDefinition}\n\nContinue the task.`;
        // FIX-PERF-24: dedupe — skip when the previous entry already is this
        // exact reminder (nothing happened in between, e.g. empty retry).
        const last = history[history.length - 1];
        if (last && last.role === 'user' && typeof last.content === 'string' && last.content === reminder) {
            return;
        }
        history.push({ role: 'user', content: reminder });
    }
}
