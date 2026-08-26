/**
 * InlineToSidebarTransferService -- live hand-off of an inline conversation
 * into the Sidebar chat (FEAT-33-12 / US-33-12-05).
 *
 * The button "Send to sidebar chat" in the InlineChatPanel composer calls
 * transfer() once `canTransfer()` returns ok. The service opens the
 * Sidebar leaf, asks AgentSidebarView.importConversation() to take over
 * the live MessageParam[] + UiMessage[], and tells the caller to close
 * the inline panel.
 *
 * Sidebar-busy fallback (FEAT-33-13 placeholder):
 *   - If the Sidebar already has a streaming conversation, the service
 *     refuses with reason 'sidebar-busy'. The caller surfaces an
 *     Obsidian Notice. FEAT-33-13 will replace this fallback by opening
 *     a parallel chat session so the running stream is never interrupted.
 *
 * The inline-chat-controller's isRunning probe MUST be checked by the
 * UI layer BEFORE calling transfer() (the send button is gated on this).
 * transfer() itself does not abort an in-flight inline turn.
 */

import { Notice } from 'obsidian';
import type ObsidianAgentPlugin from '../../../main';
import type { MessageParam } from '../../../api/types';
import type { UiMessage } from '../../history/ConversationStore';

// IMP-19-01-03 Testing-Phase: das fruehere bewusste Duplikat entfaellt.
// viewTypes.ts existiert genau dafuer, die Konstante ohne den schweren
// View-Import zu liefern; damit ist der Grund des Duplikats weg.
import { VIEW_TYPE_AGENT_SIDEBAR } from '../../../ui/viewTypes';

/**
 * Structural type for the sidebar handshake. We use a tiny shape instead
 * of importing AgentSidebarView so the runtime view module stays out of
 * this file's import graph.
 */
interface SidebarHandshake {
    readonly isBusy: boolean;
    /** Resolves false when the sidebar refused the import (GUARD-I1). */
    importConversation(state: TransferState): Promise<boolean>;
}

export interface TransferState {
    conversationId: string | null;
    history: MessageParam[];
    uiMessages: UiMessage[];
}

export type CanTransferOutcome =
    | { ok: true }
    | { ok: false; reason: 'inline-busy' | 'sidebar-busy' | 'no-sidebar' };

export interface InlineToSidebarTransferServiceOptions {
    plugin: ObsidianAgentPlugin;
    /** Called when the transfer succeeded and the panel should close. */
    onTransferred?: () => void;
    /** Pluggable Notice factory so tests can capture the message. */
    notify?: (msg: string) => void;
}

export class InlineToSidebarTransferService {
    private readonly plugin: ObsidianAgentPlugin;
    private readonly onTransferred?: () => void;
    private readonly notify: (msg: string) => void;

    constructor(options: InlineToSidebarTransferServiceOptions) {
        this.plugin = options.plugin;
        this.onTransferred = options.onTransferred;
        this.notify = options.notify ?? ((m) => { new Notice(m); });
    }

    /**
     * canTransfer is called BOTH by the inline composer (every render
     * tick, to update the button disabled-state) AND by transfer()
     * before it starts. The probe is fast and pure: just checks the
     * inline-running flag and the sidebar's isBusy getter.
     */
    canTransfer(args: { inlineRunning: boolean }): CanTransferOutcome {
        if (args.inlineRunning === true) return { ok: false, reason: 'inline-busy' };
        // FEAT-55-01 (ADR-169): a busy sidebar is no longer a blocker -- the
        // transfer opens a new parallel chat leaf and imports there. Only the
        // inline-running case still gates. (transfer() handles the busy case
        // by opening a fresh leaf; if none can be opened it falls back to a
        // sidebar-busy refusal at that point.)
        return { ok: true };
    }

    /**
     * Execute the hand-off:
     *   1. Open the Sidebar leaf (or activate it if hidden).
     *   2. Resolve the AgentSidebarView instance.
     *   3. Re-check inlineRunning + sidebar.isBusy LIVE via snapshotProvider
     *      because activateView() is async; a steering message could have
     *      started a new inline turn between click and resume here.
     *   4. Call importConversation with the FRESH snapshot.
     *   5. Tell the caller to close the inline panel.
     *
     * The initial `args.inlineRunning` is the click-time probe used for
     * the gate notification; snapshotProvider is the LIVE re-check that
     * also returns a fresh state. Without the live re-check a user who
     * clicked while idle and immediately typed a new message would send
     * the OLD snapshot to the sidebar -- a real race observed in the
     * adversarial review.
     */
    async transfer(args: {
        inlineRunning: boolean;
        snapshotProvider: () => { state: TransferState; isRunning: boolean };
    }): Promise<CanTransferOutcome> {
        const initial = this.canTransfer({ inlineRunning: args.inlineRunning });
        if (initial.ok !== true) {
            this.notifyForReason(initial.reason);
            return initial;
        }
        try {
            await this.plugin.activateView();
        } catch (e) {
            console.warn('[InlineToSidebarTransferService] activateView failed:', e);
            return { ok: false, reason: 'no-sidebar' };
        }
        let sidebar = this.findSidebarView();
        if (sidebar === null) {
            this.notify('Sidebar chat is not available.');
            return { ok: false, reason: 'no-sidebar' };
        }
        // Race-fix (AUDIT-FEAT-33-12 #1): re-evaluate AFTER the async
        // activateView resolves. A steering message or a new chat turn
        // started in the gap window MUST cancel the transfer.
        const fresh = args.snapshotProvider();
        if (fresh.isRunning === true) {
            this.notifyForReason('inline-busy');
            return { ok: false, reason: 'inline-busy' };
        }
        // FEAT-55-01: parallel sessions replace the old busy-refusal. If the
        // active chat is running, open a NEW in-view chat tab and import
        // there so the running stream is never interrupted (FEAT-33-13 TODO).
        // openNewChatTab switches the sidebar's active session to a fresh
        // (idle) tab, which findNonBusySidebarView then resolves.
        if (sidebar.isBusy === true) {
            try {
                await this.plugin.openNewChatTab();
            } catch (e) {
                console.warn('[InlineToSidebarTransferService] openNewChatTab failed:', e);
            }
            const fresher = this.findNonBusySidebarView();
            if (fresher === null) {
                // No idle tab available; fall back to the old refusal.
                this.notifyForReason('sidebar-busy');
                return { ok: false, reason: 'sidebar-busy' };
            }
            sidebar = fresher;
        }
        try {
            // AUDIT 2026-07-07 GUARD-I1: a refusal (FIX-01-01-02 guard fired
            // inside the sidebar) must not read as success -- the panel would
            // close while the conversation never arrived.
            const imported = await sidebar.importConversation(fresh.state);
            if (imported === false) {
                this.notifyForReason('sidebar-busy');
                return { ok: false, reason: 'sidebar-busy' };
            }
        } catch (e) {
            console.warn('[InlineToSidebarTransferService] importConversation failed:', e);
            this.notify('Could not move the conversation to the sidebar. See console for details.');
            return { ok: false, reason: 'no-sidebar' };
        }
        try { this.onTransferred?.(); } catch (e) {
            console.debug('[InlineToSidebarTransferService] onTransferred hook threw:', e);
        }
        return { ok: true };
    }

    private notifyForReason(reason: 'inline-busy' | 'sidebar-busy' | 'no-sidebar'): void {
        if (reason === 'inline-busy') {
            this.notify('Waiting for the current response to finish.');
        } else if (reason === 'sidebar-busy') {
            // FEAT-33-13 placeholder: once parallel sessions exist this
            // case opens a fresh session instead of warning.
            this.notify('Sidebar chat is busy. Wait for it to finish or cancel it to receive the inline chat.');
        } else {
            this.notify('Sidebar chat is not available.');
        }
    }

    private findSidebarView(): SidebarHandshake | null {
        const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_SIDEBAR);
        for (const leaf of leaves) {
            const candidate = leaf.view as unknown as Partial<SidebarHandshake> | undefined;
            if (candidate !== undefined && typeof candidate.importConversation === 'function') {
                return candidate as SidebarHandshake;
            }
        }
        return null;
    }

    /**
     * FEAT-55-01 (ADR-169): find a chat leaf that is NOT busy, so a transfer
     * into a freshly opened parallel session lands on an idle chat rather
     * than one with a running stream.
     */
    private findNonBusySidebarView(): SidebarHandshake | null {
        const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_SIDEBAR);
        for (const leaf of leaves) {
            const candidate = leaf.view as unknown as Partial<SidebarHandshake> | undefined;
            if (candidate !== undefined
                && typeof candidate.importConversation === 'function'
                && candidate.isBusy !== true) {
                return candidate as SidebarHandshake;
            }
        }
        return null;
    }
}
