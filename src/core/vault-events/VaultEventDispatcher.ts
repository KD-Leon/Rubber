/**
 * VaultEventDispatcher (FIX-PERF-29)
 *
 * Centralised vault-mutation event dispatch with two critical features
 * the direct vault.on() pattern lacks:
 *
 *   1. **Self-write suppression.** The plugin's own writes via
 *      PdfMarkdownMirror, FrontmatterWriter, IngestSummary, etc.
 *      should NOT re-trigger our own listeners. Without suppression,
 *      a plugin write fires modify->indexer->maybeWrite->modify->...
 *      cascading wakeups and CPU. Callers wrap their own writes in
 *      `dispatcher.suppressSelfWrite(absolutePath, action)`.
 *
 *   2. **Idle-callback batching for low-priority listeners.** A
 *      keystroke can fire vault.on('modify') 6+ times in a second.
 *      Heavy listeners (graph-extractor, semantic indexer) should
 *      not run synchronously - they pile editor latency on the user.
 *      Subscribe with `idle: true` to drain in requestIdleCallback.
 *
 * The dispatcher does NOT replace vault.on directly. Callers continue
 * to register with vault.on; the dispatcher attaches its own listener
 * once, filters by suppression set, and re-emits via this.on(name, cb).
 */

import type { Vault, TAbstractFile } from 'obsidian';

export type VaultEventName = 'create' | 'modify' | 'delete' | 'rename';

interface ListenerEntry {
    name: VaultEventName;
    cb: (file: TAbstractFile, oldPath?: string) => void;
    idle: boolean;
}

export class VaultEventDispatcher {
    private listeners: ListenerEntry[] = [];
    private suppressed = new Set<string>();
    /** Disposers returned by vault.on so we can detach in dispose(). */
    private attached: Array<() => void> = [];
    private installed = false;
    private idleQueue: Array<() => void> = [];
    private idleScheduled = false;

    constructor(private vault: Vault) {}

    /**
     * Subscribe to a vault event with optional idle-batching.
     */
    on(
        name: VaultEventName,
        cb: (file: TAbstractFile, oldPath?: string) => void,
        opts?: { idle?: boolean },
    ): () => void {
        this.ensureInstalled();
        const entry: ListenerEntry = { name, cb, idle: opts?.idle ?? false };
        this.listeners.push(entry);
        return () => {
            const idx = this.listeners.indexOf(entry);
            if (idx >= 0) this.listeners.splice(idx, 1);
        };
    }

    /**
     * Run an action with self-write suppression for a known absolute
     * vault path. Modify/create/delete events for that path fire by
     * Obsidian during the action are dropped by the dispatcher.
     *
     * The path is unsuppressed in the finally so an error in the
     * action does not permanently silence future events for that path.
     */
    async suppressSelfWrite<T>(path: string, action: () => Promise<T> | T): Promise<T> {
        this.suppressed.add(path);
        try {
            return await action();
        } finally {
            // Defer the un-suppress to a microtask so Obsidian has a
            // chance to fire the event before we forget about it.
            queueMicrotask(() => this.suppressed.delete(path));
        }
    }

    /** Manually mark a path as self-written. Caller is responsible for un-suppressing. */
    markSelfWrite(path: string): void {
        this.suppressed.add(path);
        queueMicrotask(() => this.suppressed.delete(path));
    }

    /** Tear down. Call from plugin onunload. */
    dispose(): void {
        for (const d of this.attached) {
            try { d(); } catch { /* best-effort */ }
        }
        this.attached = [];
        this.listeners = [];
        this.suppressed.clear();
        this.idleQueue = [];
        this.installed = false;
    }

    /** Diagnostic: number of registered listeners. */
    listenerCount(): number {
        return this.listeners.length;
    }

    private ensureInstalled(): void {
        if (this.installed) return;
        this.installed = true;
        // Vault.on has per-event-name overloads with different handler
        // signatures; attach each event with its concrete signature so
        // TypeScript's overload resolution stays happy.
        const handle = (name: VaultEventName, file: TAbstractFile, oldPath?: string): void => {
            if (this.suppressed.has(file.path)) return;
            this.dispatch(name, file, oldPath);
        };
        const refCreate = this.vault.on('create', (f) => handle('create', f));
        const refModify = this.vault.on('modify', (f) => handle('modify', f));
        const refDelete = this.vault.on('delete', (f) => handle('delete', f));
        const refRename = this.vault.on('rename', (f, old) => handle('rename', f, old));
        this.attached.push(() => this.vault.offref(refCreate));
        this.attached.push(() => this.vault.offref(refModify));
        this.attached.push(() => this.vault.offref(refDelete));
        this.attached.push(() => this.vault.offref(refRename));
    }

    private dispatch(name: VaultEventName, file: TAbstractFile, oldPath?: string): void {
        for (const entry of this.listeners) {
            if (entry.name !== name) continue;
            if (entry.idle) {
                this.idleQueue.push(() => entry.cb(file, oldPath));
                this.scheduleIdleDrain();
            } else {
                try { entry.cb(file, oldPath); }
                catch (err) { console.warn('[VaultEventDispatcher] listener threw:', err); }
            }
        }
    }

    private scheduleIdleDrain(): void {
        if (this.idleScheduled) return;
        this.idleScheduled = true;
        const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number }).requestIdleCallback;
        const drain = (): void => {
            this.idleScheduled = false;
            const queue = this.idleQueue;
            this.idleQueue = [];
            for (const fn of queue) {
                try { fn(); }
                catch (err) { console.warn('[VaultEventDispatcher] idle listener threw:', err); }
            }
        };
        if (typeof idle === 'function') {
            idle(drain, { timeout: 1000 });
        } else {
            window.setTimeout(drain, 50);
        }
    }
}
