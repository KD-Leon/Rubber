/**
 * Loop interceptor contract (IMP-41-02-01c, ADR-145) -- v2.
 *
 * Cross-cutting concerns hook into the loop through this interface instead
 * of growing inline in AgentTask.run(). Registration order = execution
 * order; interceptors read/write ONLY the serializable state and their own
 * constructor ports (never closure variables of run()).
 *
 * Dispatch points:
 *   - onRunStart          facade, at the concern's pre-loop position (the
 *                         inline blocks ran at distinct points with other
 *                         setup between them -- order is preserved by
 *                         dispatching each interceptor where its block was)
 *   - onIterationStart    engine, top of every iteration (preamble)
 *   - transformRequestHistory  engine, on the sanitized per-request history
 *   - onToolResult        engine, after each EXECUTED tool's mistake
 *                         accounting. Parity note: stream-side tool_error
 *                         chunks never fire this (they bypass execution).
 *   - onRunEnd            facade, in run()'s finally after the outcome
 *                         fields (turnOutcome, cleanNaturalExit) are
 *                         final.
 *
 * Migration status:
 *   - TodoAnchorInterceptor      migrated
 *   - PowerSteeringInterceptor   migrated
 *   - AdvisorReminderInterceptor migrated
 *   - RouterEscalationInterceptor migrated (contract v2)
 *   - FastPathInterceptor        follows on the same contract.
 */

import type { MessageParam } from '../../../api/types';
import type { AgentLoopState } from '../LoopState';

export interface LoopInterceptorContext {
    state: AgentLoopState;
    /** Live conversation history. Appending at iteration start is allowed. */
    history: MessageParam[];
    activeMode: { name: string; slug: string; roleDefinition: string };
}

/** Context for the once-per-run pre-loop hook. */
export interface RunStartContext {
    /**
     * Live history BEFORE the loop opens. Read-only by contract: pre-loop
     * contributions go through interceptor-specific accessors so the facade
     * keeps the cross-interceptor precedence resolution.
     */
    history: readonly MessageParam[];
    /** Plain-text view of the triggering user message (blocks joined). */
    userMessageText: string;
    abortSignal?: AbortSignal;
}

/** One executed tool's outcome, fired after mistake accounting. */
export interface ToolResultEvent {
    toolName: string;
    isError: boolean;
}

export interface LoopInterceptor {
    readonly name: string;
    /** Once, pre-loop, at the concern's original inline position. */
    onRunStart?(ctx: RunStartContext): Promise<void>;
    /** Runs at the top of every iteration, before prompt assembly. */
    onIterationStart?(ctx: LoopInterceptorContext): void;
    /**
     * Transform the sanitized per-request history (recency anchors etc.).
     * Must not mutate the input array; return it unchanged or a copy.
     */
    transformRequestHistory?(safeHistory: MessageParam[], ctx: LoopInterceptorContext): MessageParam[];
    /**
     * After each EXECUTED tool's result bookkeeping (counters updated,
     * before the circuit-breaker check). Never fired for stream-side
     * tool_error chunks.
     */
    onToolResult?(evt: ToolResultEvent, ctx: LoopInterceptorContext): void;
    /** Once, in run()'s finally, after outcome fields are final. */
    onRunEnd?(ctx: LoopInterceptorContext): Promise<void>;
}
