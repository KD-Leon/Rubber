/**
 * FastPathInterceptor (IMP-41-02-01c, contract v2).
 *
 * ADR-061 Fast Path as an interceptor: when a learned recipe matches the
 * user prompt with high confidence, execute its tool steps as a batch
 * BEFORE the normal loop opens; the loop then handles presentation and
 * completion in 1-2 iterations.
 *
 * The interceptor owns the POLICY (gates, match selection, entry
 * collection); the executor mechanics (planner prompt, tool definitions,
 * FastPathExecutor construction with the aux-usage sink, episodic
 * recording) stay host-side behind the executeRecipe port. Results are
 * NOT pushed to history here: the facade's precedence resolver (ADR-131)
 * pushes them AFTER the user message via getHistoryEntries(), so the
 * agent never sees the recipesSection + guidance.text double-hint.
 *
 * Gates preserved verbatim from the inline block:
 *  - recipesSection present and depth === 0 (enabled port),
 *  - chat-source queries skip FastPath (FEATURE-0320 follow-up: the
 *    vault-centric recipe never calls search_history),
 *  - score >= 0.5 (FIX-F: 0.33 matched the wrong workflow), source
 *    'learned', successCount >= 3.
 * Every failure path is fail-open: the normal loop runs.
 */

import type { MessageParam } from '../../../api/types';
import type { RecipeMatchResult } from '../../mastery/RecipeMatchingService';
import type { FastPathResult } from '../../FastPathExecutor';
import type { LoopInterceptor, RunStartContext } from './types';

export interface FastPathPorts {
    /** ADR-061 gate: recipesSection present and top-level task (depth 0). */
    enabled(): boolean;
    /**
     * String user message, or '' for block messages -- parity with the
     * inline block, which never matched recipes against block content.
     */
    getUserText(): string;
    /** Sidebar pre-computed matches, else inline match (subagent paths). */
    getRecipeMatches(): RecipeMatchResult[] | undefined;
    /**
     * Dynamic-imports FastPathExecutor, builds the planner prompt and tool
     * definitions and runs the recipe. Planner usage lands in the task's
     * aux sink host-side (FIX-24-05-04/-05).
     */
    executeRecipe(
        match: RecipeMatchResult,
        userText: string,
        abortSignal?: AbortSignal,
    ): Promise<FastPathResult>;
}

export class FastPathInterceptor implements LoopInterceptor {
    readonly name = 'fast-path';
    private firedFlag = false;
    private recipeWinnerId: string | null = null;
    private historyEntries: MessageParam[] = [];

    constructor(private readonly ports: FastPathPorts) {}

    /** True when a recipe pre-ran successfully. */
    fired(): boolean {
        return this.firedFlag;
    }

    /**
     * Winning recipe id, or null. Feeds the recipe-win gate in
     * RecipePromotionService via the onEpisodeData payload: a win bumps
     * the recipe's success count instead of promoting a duplicate.
     */
    getRecipeWinnerId(): string | null {
        return this.recipeWinnerId;
    }

    /** Collected entries (assistant + tool_results + completion hint). */
    getHistoryEntries(): MessageParam[] {
        return this.historyEntries;
    }

    async onRunStart(ctx: RunStartContext): Promise<void> {
        if (!this.ports.enabled()) return;
        try {
            // FEAT-32-01 PR 1.3: prefer pre-computed matches from the
            // Sidebar; fall back to inline match for subagent paths.
            const bestMatch = this.ports.getRecipeMatches()?.[0];

            // FEATURE-0320 follow-up: when the user explicitly references
            // chats/conversations as the search source, the vault-centric
            // "Knowledge Search & Synthesis" recipe is the wrong answer --
            // it scans Notes and never calls search_history. Skip FastPath
            // so the agent picks search_history itself.
            const fpUserText = this.ports.getUserText();
            const chatSourceRegex = /\b(chat|chats|gespr(ä|ae)ch|gespr(ä|ae)che|konversation|konversationen|unterhaltung|unterhaltungen|dialog|dialoge|history)\b/i;
            const targetsChatHistory = chatSourceRegex.test(fpUserText);

            if (bestMatch && targetsChatHistory) {
                console.debug(`[FastPath] Skipped (chat-source query): "${fpUserText.slice(0, 80)}"`);
            }

            // FIX-F (ADR-090 follow-up, 2026-04-29): Recipe-Threshold von 0.3 auf 0.5 angehoben.
            // Bei score=0.33 matched "Metadata Tags Generation" auf eine reine Synthese-Aufgabe
            // und triggerte FastPath in den falschen Workflow. Niedriger Score = unsicheres Match
            // = lieber normalen Loop laufen lassen, der die Aufgabe sauber zerlegt.
            if (bestMatch && !targetsChatHistory && bestMatch.score >= 0.5 && bestMatch.recipe.source === 'learned' && bestMatch.recipe.successCount >= 3) {
                console.debug(`[FastPath] Recipe match: ${bestMatch.recipe.name} (score=${bestMatch.score.toFixed(2)}, successes=${bestMatch.recipe.successCount})`);

                const result = await this.ports.executeRecipe(bestMatch, fpUserText, ctx.abortSignal);

                if (result.success && result.toolCallsExecuted > 0) {
                    console.debug(`[FastPath] Success: ${result.toolCallsExecuted} tools executed, collecting ${result.historyEntries.length} history entries for post-precedence push`);
                    // FEAT-32-01 PR 1.3 / ADR-131: do NOT push history yet.
                    // The facade's precedence resolver pushes these AFTER the
                    // user message (whose guidance.text gets suppressed when
                    // FastPath fired). guidance.path Pre-Activation is
                    // unaffected.
                    this.historyEntries = [
                        ...result.historyEntries,
                        {
                            role: 'user',
                            content: `[Fast Path completed] The recipe "${bestMatch.recipe.name}" has been executed. `
                                + `${result.toolCallsExecuted} tool calls completed successfully. `
                                + `The search and read results are above. `
                                + `Now: analyze the results and complete the task (write summary, present findings). `
                                + `Do NOT re-search or re-read the same content -- use the results already in context.`,
                        },
                    ];
                    this.firedFlag = true;
                    this.recipeWinnerId = bestMatch.recipe.id;
                } else {
                    console.debug('[FastPath] No success, continuing with normal loop');
                }
            }
        } catch (e) {
            console.warn('[FastPath] Pre-loop check failed (non-fatal), continuing with normal loop:', e);
        }
    }
}
