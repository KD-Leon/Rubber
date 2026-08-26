/**
 * RefreshHub -- minimal cross-surface UI refresh channel (IMP-02-12-01).
 *
 * State that renders on more than one surface (the forced-workflow chip
 * shows in the sidebar AND the inline panel) needs one notification
 * channel instead of N point-to-point refresh calls: every write site
 * calls notify(), every surface subscribes while mounted and re-renders
 * from settings. Deliberately payload-free -- subscribers read the
 * current state themselves, so a missed detail cannot go stale.
 *
 * Wired on the plugin as `forcedWorkflowHub` (src/main.ts). Subscribe
 * returns the unsubscriber; surfaces MUST call it on unmount or they
 * leak their render closure.
 */
export class RefreshHub {
    private readonly listeners = new Set<() => void>();

    /** Register a callback; returns the idempotent unsubscriber. */
    subscribe(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /**
     * Invoke every current subscriber. Errors are isolated per subscriber:
     * one broken renderer must not starve the other surfaces.
     */
    notify(): void {
        for (const cb of [...this.listeners]) {
            try {
                cb();
            } catch (e) {
                console.warn('[RefreshHub] subscriber failed:', e);
            }
        }
    }
}
