/**
 * FIX-03-20-01: lazy, race-free conversation-id creation.
 *
 * A message sent during plugin boot can predate ConversationStore init.
 * Historically the id was only created in handleSend (and only when the
 * store already existed) -- miss that moment and every later save
 * (onComplete, auto-save, onClose) silently skipped on the missing id,
 * so the conversation never reached history.
 *
 * This helper creates the id as soon as a store is available, memoizes
 * the in-flight create so concurrent save paths share one id, and
 * resolves immediately when an id already exists. reset() starts a
 * fresh memo for a new chat.
 */

interface ConversationCreator {
    create(mode: string, model: string): Promise<string>;
}

export class LazyConversationId {
    private pending: Promise<string> | null = null;

    /**
     * Returns a promise for the conversation id, or null when no store is
     * available yet (nothing to save against -- caller should skip).
     * `assign` runs once when a fresh id is created so the caller can
     * store it on its own state.
     */
    ensure(
        currentId: string | null,
        store: ConversationCreator | null | undefined,
        meta: () => { mode: string; model: string },
        assign: (id: string) => void,
    ): Promise<string> | null {
        if (currentId) return Promise.resolve(currentId);
        if (!store) return null;
        if (!this.pending) {
            const { mode, model } = meta();
            this.pending = store.create(mode, model).then((id) => {
                assign(id);
                return id;
            });
        }
        return this.pending;
    }

    /** Forget the memoized id -- call when a fresh chat starts. */
    reset(): void {
        this.pending = null;
    }
}
