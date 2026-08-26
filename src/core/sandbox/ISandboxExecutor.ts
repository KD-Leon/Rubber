/**
 * ISandboxExecutor
 *
 * Strategy interface for sandbox code execution backends.
 * Every platform: IframeSandboxExecutor (Chromium opaque-origin iframe).
 * The former desktop backend was removed by SBX-1 / AUDIT M-10.
 * Mobile:  IframeSandboxExecutor (iframe sandbox="allow-scripts")
 *
 * Part of ADR-021: Sandbox OS-Level Process Isolation.
 */

/**
 * FIX-44-43: per-execution options for {@link ISandboxExecutor.execute}.
 *
 * The predecessor mechanism (FIX-44-04's setGovernanceContext) bound the task
 * as mutable state on the shared bridge singleton -- with two overlapping
 * sandbox executions from different tasks the slot was last-writer-wins and
 * the earlier task's writes were checkpointed under the wrong taskId. The
 * taskId now travels WITH the execution: the executor remembers it per
 * execution id, the sandbox side echoes that id on every bridge operation,
 * and the bridge snapshots under exactly the task whose approval let the
 * script run.
 */
export interface SandboxExecutionOptions {
    /**
     * The task whose approval let this script run. Every sandbox vault write
     * of this execution is checkpoint-snapshotted under this task so it is
     * recoverable via restore_checkpoint. Omit only when no task is in scope
     * (module validation probe, bare unit test) -- writes are then not
     * snapshotted.
     */
    governanceTaskId?: string;
    /**
     * FIX-24-08-04: abort a running script the moment the user stops the run.
     * Without it a stopped run waited out the 30s execution timeout (Stop
     * "worked" but drained slowly). On abort the executor rejects the
     * in-flight call with an AbortError and tears the sandbox down so the
     * script cannot keep running on the background thread.
     */
    abortSignal?: AbortSignal;
}

export interface ISandboxExecutor {
    ensureReady(): Promise<void>;
    execute(
        compiledJs: string,
        input: Record<string, unknown>,
        options?: SandboxExecutionOptions,
    ): Promise<unknown>;
    destroy(): void;
}
