/**
 * RouterEscalationInterceptor (IMP-41-02-01c, contract v2).
 *
 * v2.10.0 TaskRouter as an interceptor: classify the user prompt at run
 * start and route simple tool tasks onto the helper model so trivial
 * xlsx / docx / file ops do not consume the main-model rate; escalate
 * back to the main api after >= 2 consecutive tool errors (onToolResult,
 * dispatched by the engine after mistake accounting).
 *
 * Logging is deliberately verbose: every code path that ends with "no
 * routing" emits an explanatory line so users can tell from the console
 * why routing did not happen (toggle off, no helper model, classified as
 * complex, etc). The dynamic TaskRouter / helper-api imports stay inside
 * the facade-provided ports so this module remains dependency-light.
 */

import type { LoopInterceptor, LoopInterceptorContext, RunStartContext, ToolResultEvent } from './types';

export type RouterDecision = 'simple' | 'complex' | 'unknown' | 'disabled';

export interface RouterEscalationPorts {
    /** shouldRunTaskRouter(depth, modelOverrideActive) -- top-level tasks only. */
    shouldRun(): boolean;
    /** depth === 0 with a manual model override (skip-log path). */
    manualOverrideActive(): boolean;
    /** Settings > Loop > Auto-route simple tasks. */
    isEnabled(): boolean;
    /** Display name of the configured helper model, or null when unset. */
    helperModelName(): string | null;
    /** Regex classification (dynamic TaskRouter import lives host-side). */
    classify(promptText: string): Promise<RouterDecision>;
    /** Swap the task's api handler to the helper api. */
    switchToHelper(): Promise<void>;
    /** Current model id for the staying-on-main log line. */
    mainModelId(): string;
    /** Swap back to the main api (idempotent; noop when already on main). */
    escalateToMain(): void;
}

export class RouterEscalationInterceptor implements LoopInterceptor {
    readonly name = 'router-escalation';
    private decision: RouterDecision = 'disabled';

    constructor(private readonly ports: RouterEscalationPorts) {}

    getDecision(): RouterDecision {
        return this.decision;
    }

    async onRunStart(ctx: RunStartContext): Promise<void> {
        if (!this.ports.shouldRun()) {
            if (this.ports.manualOverrideActive()) {
                console.debug('[TaskRouter] skipped -- manual model override active. Staying on the picked model.');
            }
            return;
        }
        try {
            if (!this.ports.isEnabled()) {
                console.debug('[TaskRouter] disabled (Settings > Loop > Auto-route simple tasks is off). Staying on main model.');
                return;
            }
            const helperName = this.ports.helperModelName();
            if (helperName === null) {
                console.debug('[TaskRouter] no helper model configured (Settings > Loop > Helper Model). Staying on main model.');
                return;
            }
            this.decision = await this.ports.classify(ctx.userMessageText);
            if (this.decision === 'simple') {
                await this.ports.switchToHelper();
                console.debug(
                    `[TaskRouter] classification=simple model=helper(${helperName}) ` +
                    '-- routing this task to helper model. Escalates back to main on >= 2 errors.',
                );
            } else {
                console.debug(`[TaskRouter] classification=${this.decision} model=main(${this.ports.mainModelId()}) -- staying on main model.`);
            }
        } catch (e) {
            console.warn('[TaskRouter] router failed, staying on main api:', e);
        }
    }

    onToolResult(_evt: ToolResultEvent, ctx: LoopInterceptorContext): void {
        // v2.10.0 TaskRouter: escalate to main model after 2 consecutive
        // errors. Counters are already updated (success resets to 0, so a
        // successful tool can never trip this).
        if (ctx.state.consecutiveMistakes >= 2) this.ports.escalateToMain();
    }
}
