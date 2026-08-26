/**
 * ChatSession -- one in-view chat tab's state (EPIC-55 in-view tabs, Phase A).
 *
 * Vault Operator shows several chat tabs INSIDE one sidebar view (user
 * decision 2026-07-25), not one Obsidian leaf per chat. Each tab is a
 * ChatSession: its own conversation, run, abort controller, and DOM root.
 * The view holds `sessions: ChatSession[]` + an active index and renders a
 * tab strip that switches between them.
 *
 * Why an instance, not view-level getters: a run started in session A keeps
 * closures over A's state. If the view switched `this.conversationHistory`
 * to point at session B when the user changes tabs, A's still-running loop
 * would write into B's history -- the FIX-01-01-02 data-loss class. Binding
 * the run to a ChatSession INSTANCE lets a background run in tab A keep
 * writing into A while tab B is active (the "runs keep running on tab
 * switch" behaviour the user chose 2026-07-25).
 *
 * Phase A extracts the per-chat fields here without changing behaviour (the
 * view still drives exactly one session). Phases B-D add the tab strip,
 * parallel background runs, and per-session persistence.
 *
 * Architecture-map concept: parallel-chat-session (in-view tabs)
 * Related: REQ-REVIEW-2026-07-25-in-view-tabs, FIX-24-08-03, FIX-01-01-02
 */
import type { MessageParam } from '../../api/types';
import type { UiMessage } from '../../core/history/ConversationStore';
import type { InflightSnapshot } from '../../core/agent/InflightStore';
import { LazyConversationId } from '../../core/history/LazyConversationId';
import type { ThinkingOverride } from './thinkingOverride';
import type { EffortOverride } from './effortOverride';
import { DEFAULT_THINKING_OVERRIDE } from './thinkingOverride';
import { DEFAULT_EFFORT_OVERRIDE } from './effortOverride';
import { generateShortId } from '../../core/utils/generateShortId';

export class ChatSession {
    /** Stable id for this tab (tab identity, distinct from the conversation id). */
    readonly sessionId: string = generateShortId('tab');

    // ---- Conversation state (persisted) -----------------------------------
    /** Persistent conversation history sent to the API (survives across sends). */
    conversationHistory: MessageParam[] = [];
    /** UI-side message list mirrored to the ConversationStore. */
    uiMessages: UiMessage[] = [];
    /** Active conversation id, or null for a fresh unsaved chat. */
    activeConversationId: string | null = null;
    /** Race-free lazy conversation-id creation when the store inits late (FIX-03-20-01). */
    readonly lazyConversationId = new LazyConversationId();
    /**
     * USER 2026-07-26: the tab label, derived from the first message.
     *
     * Kept on the SESSION, not read back out of the conversation store. A fresh
     * tab has no conversation id yet -- it is minted lazily during the send --
     * so a store-only title left the tab reading "New chat" for the whole first
     * exchange, which is exactly when several open tabs are hardest to tell
     * apart. Null until the user says something.
     *
     * The semantic (LLM) title still replaces this later; see sessionTabTitle
     * for the precedence.
     */
    tabTitle: string | null = null;

    /**
     * History hardening phase C (FIX-03-20-02): set by the deliberate
     * truncation paths (pencil edit+resend, delete-from-checkpoint). The next
     * saveCurrentConversation passes it to the store as allowShrink and
     * clears it once the shrink was written -- without it the store's shrink
     * guard would refuse to persist the intentionally shortened conversation.
     */
    historyTruncated = false;

    /**
     * History hardening phase D (FIX-03-20-07): true from the moment a send
     * passed the early-return branches until its run controller exists (or
     * the send failed). Closes the async window in which a second send could
     * slip past the busy gate and start a parallel run on the same session.
     */
    sendInFlight = false;

    /**
     * Review F2 (2026-07-29): the token of the send invocation that armed
     * sendInFlight. The handleSendMessage wrapper clears the flag only when
     * this matches its own token -- otherwise a second send that early-returns
     * (empty, steering, or refused while preparing) would clear the flag an
     * in-flight first send had set, reopening the parallel-run window.
     */
    sendInFlightOwner: object | null = null;

    // ---- Run state (one in-flight agent run per session) ------------------
    /** AbortController of the current run; null when idle. */
    currentAbortController: AbortController | null = null;
    /**
     * Signal of the most recently started run. NOT nulled by handleStop, so
     * approval cards from a draining task bind an already-aborted signal
     * instead of undefined (FIX-24-08-03).
     */
    lastRunAbortSignal: AbortSignal | null = null;
    /** Swaps the Working spinner for a "Stopping" row on Stop (IMP-24-08-04). */
    currentStopFeedback: (() => void) | null = null;
    /** True between Stop and the aborted loop's onComplete/onError (GUARD-L1). */
    taskDraining = false;
    taskDrainingTimer = 0;
    /**
     * Teardown-ownership token for a stopped, still-draining run (Issue 3
     * Wave B). Distinguishes "Stop then wait -> Resume" from "Stop then send"
     * and prevents a late onComplete writing into a newer conversation.
     */
    drainingController: AbortController | null = null;
    /**
     * Set while an ask_followup_question card is open: routes the next typed
     * text to the question resolver instead of queuing a steering message.
     */
    pendingQuestionResolve: ((answer: string) => void) | null = null;
    /** Mid-run user messages queued for the next loop iteration (FEAT-24-08). */
    steeringQueue: Array<{ text: string; bubbleEl: HTMLElement }> = [];
    /** Inflight snapshot armed for the next send by the Resume card (IMP-41-03-01). */
    pendingResume: InflightSnapshot | null = null;

    // ---- Per-conversation overrides (EPIC-26 / issue #44) -----------------
    /** null -> Auto (advisor); string -> explicit model id for this chat. */
    chatModelOverride: string | null = null;
    /** Per-conversation extended-thinking override. */
    chatThinkingOverride: ThinkingOverride = DEFAULT_THINKING_OVERRIDE;
    /** Per-conversation reasoning-effort override. */
    chatEffortOverride: EffortOverride = DEFAULT_EFFORT_OVERRIDE;

    // ---- Composer / navigation state --------------------------------------
    /** Last user message text -- used by the Regenerate action. */
    lastUserMessage = '';
    /** Hidden-message flag: skip the user bubble but still send to the LLM. */
    nextMessageHidden = false;
    /** Browser-style back/forward stack of visited conversation ids. */
    navStack: Array<string | null> = [];
    navIndex = -1;

    // ---- Per-session DOM roots (set when the tab is built/activated) -------
    /** The scrollable messages container for this tab; null before first build. */
    chatContainer: HTMLElement | null = null;

    /** True when this session has an in-flight run (drives the tab indicator). */
    get isBusy(): boolean {
        return this.currentAbortController !== null;
    }
}
