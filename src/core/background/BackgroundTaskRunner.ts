/**
 * Single-slot background task runner (IMP-41-03-05, ADR-145/ADR-138).
 *
 * Lets the agent (or the user) spin off ONE long-running read-only research
 * task that works alongside the foreground chat. Deliberately conservative:
 * one slot (a vault is a shared write target), read-only tool surface via
 * the research subagent profile, no persistence across reloads (the
 * foreground path owns crash recovery via the InflightStore).
 *
 * The runner owns slot state, the AbortController and change notification
 * for the UI tile. The EXECUTOR is injected: the real one (wired in
 * main.ts) builds an AgentTaskRunner with headless callbacks, collects the
 * result text, saves it as a new conversation and raises a Notice.
 */

export interface BackgroundTaskStatus {
    taskId: string;
    title: string;
    startedAt: number;
}

export interface BackgroundTaskExecutorArgs {
    taskId: string;
    message: string;
    abortSignal: AbortSignal;
}

/** Runs the actual agent work; resolves with the result text. */
export type BackgroundTaskExecutor = (args: BackgroundTaskExecutorArgs) => Promise<string>;

export type StartResult = { ok: true; taskId: string } | { ok: false; reason: string };

export class BackgroundTaskRunner {
    private active: (BackgroundTaskStatus & { controller: AbortController }) | null = null;
    private listeners = new Set<(active: boolean) => void>();
    private counter = 0;

    constructor(private executor: BackgroundTaskExecutor) {}

    isActive(): boolean {
        return this.active !== null;
    }

    getStatus(): BackgroundTaskStatus | null {
        if (!this.active) return null;
        const { taskId, title, startedAt } = this.active;
        return { taskId, title, startedAt };
    }

    /** Subscribe to slot changes (UI tile). Returns an unsubscribe fn. */
    onChange(listener: (active: boolean) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    start(message: string, title: string): StartResult {
        if (this.active) {
            return {
                ok: false,
                reason: `A background task is already running ("${this.active.title}"). `
                    + 'Wait for it to finish or stop it first — only one background task runs at a time.',
            };
        }
        const controller = new AbortController();
        const taskId = `bg-${Date.now()}-${++this.counter}`;
        this.active = { taskId, title, startedAt: Date.now(), controller };
        this.notify(true);

        void this.executor({ taskId, message, abortSignal: controller.signal })
            .catch((e) => {
                console.warn('[BackgroundTask] executor failed:', e instanceof Error ? e.message : e);
                return '';
            })
            .finally(() => {
                if (this.active?.taskId === taskId) {
                    this.active = null;
                    this.notify(false);
                }
            });

        return { ok: true, taskId };
    }

    /** Abort the running task (no-op when idle). */
    stop(): void {
        this.active?.controller.abort();
    }

    private notify(active: boolean): void {
        for (const listener of this.listeners) {
            try {
                listener(active);
            } catch (e) {
                console.warn('[BackgroundTask] change listener failed:', e);
            }
        }
    }
}
