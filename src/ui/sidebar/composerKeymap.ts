/**
 * Composer keymap -- Issue #54.1.
 *
 * Pure send-decision for the chat input, shared by the sidebar composer
 * (src/ui/AgentSidebarView.ts) and the inline chat panel
 * (src/core/inline/chat/InlineChatPanel.ts) so both surfaces behave
 * identically and the rule stays unit-testable.
 */

/** Minimal shape of a keydown event needed to decide sending. */
export interface ComposerKeyState {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
}

/**
 * Returns true when this keydown should send the message.
 *
 * - Ctrl/Cmd+Enter is a universal send accelerator: it sends regardless of
 *   the sendWithEnter setting (fixes the Windows report where Ctrl+Enter did
 *   nothing when send-with-enter was off).
 * - Plain Enter sends only when sendWithEnter is on.
 * - Shift+Enter always inserts a newline (never sends).
 * - IME composition (isComposing) never sends.
 */
export function shouldSendOnEnter(e: ComposerKeyState, sendWithEnter: boolean): boolean {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return false;
    if (e.ctrlKey || e.metaKey) return true;
    return sendWithEnter;
}
