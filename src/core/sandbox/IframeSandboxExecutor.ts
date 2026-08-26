/**
 * IframeSandboxExecutor
 *
 * Plugin-side manager for the sandboxed iframe. Creates the iframe lazily,
 * sends code for execution via postMessage, and routes bridge requests
 * (vault access, URL requests) through SandboxBridge.
 *
 * The iframe uses sandbox="allow-scripts" which provides V8 origin
 * isolation (logical boundary, not OS-level in Electron's renderer).
 * The SandboxBridge validates all cross-boundary operations and is
 * the primary security boundary. See also: CSP meta tag in sandboxHtml.
 *
 * The only backend on every platform since SBX-1.
 * See ADR-021: Sandbox OS-Level Process Isolation.
 */

import type ObsidianAgentPlugin from '../../main';
import type { ISandboxExecutor, SandboxExecutionOptions } from './ISandboxExecutor';
import { SandboxBridge } from './SandboxBridge';
import { SANDBOX_HTML } from './sandboxHtml';
import { isFromOwnSandboxFrame } from './iframeSandboxSourceCheck';
import { scheduleRecurring, type RecurringHandle } from '../../util/scheduleRecurring';

/** FIX-24-08-04: AbortError for a sandbox execution stopped by the user. */
function sandboxAbortError(): Error {
    const err = new Error('Sandbox execution aborted');
    err.name = 'AbortError';
    return err;
}

// ---------------------------------------------------------------------------
// Types — Typed bridge message protocol
// ---------------------------------------------------------------------------

interface PendingExecution {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: number;
}

/** Messages FROM the sandbox iframe TO the plugin */
// FIX-44-43: bridge requests carry the execution id (`execId`) of the script
// run that issued them, so writes can be checkpoint-attributed to the task
// whose approval let THAT execution run (per-execution, not last-writer-wins).
type SandboxToPluginMessage =
    | { type: 'sandbox-ready' }
    | { type: 'result'; id: string; value: unknown }
    | { type: 'error'; id: string; message: string }
    | { type: 'vault-read'; callId: string; path: string; execId?: string }
    | { type: 'vault-read-binary'; callId: string; path: string; execId?: string }
    | { type: 'vault-list'; callId: string; path: string; execId?: string }
    // FIX-29-99-03: mkdir was missing from the iframe bridge but the
    // SandboxBridge implementation existed since the desktop sandbox.
    | { type: 'vault-mkdir'; callId: string; path: string; execId?: string }
    | { type: 'vault-write'; callId: string; path: string; content: string; execId?: string }
    | { type: 'vault-write-binary'; callId: string; path: string; content: ArrayBuffer; execId?: string }
    | { type: 'request-url'; callId: string; url: string; options?: { method?: string; body?: string }; execId?: string };

/** Messages FROM the plugin TO the sandbox iframe */
type PluginToSandboxMessage =
    | { type: 'execute'; id: string; code: string; input: Record<string, unknown> }
    | { callId: string; result: unknown }
    | { callId: string; error: string };

// ---------------------------------------------------------------------------
// IframeSandboxExecutor
// ---------------------------------------------------------------------------

export class IframeSandboxExecutor implements ISandboxExecutor {
    private iframe: HTMLIFrameElement | null = null;
    private ready = false;
    private readyPromise: Promise<void> | null = null;
    private pending = new Map<string, PendingExecution>();
    private bridge: SandboxBridge;
    private messageHandler: ((event: MessageEvent) => void) | null = null;

    constructor(private plugin: ObsidianAgentPlugin) {
        this.bridge = new SandboxBridge(plugin);
    }

    // FIX-44-43: governance task per execution id. The iframe echoes the
    // execId on every bridge request; a write resolves back to the taskId
    // that was passed to execute() for exactly that run, so overlapping
    // executions from different tasks keep their own checkpoint attribution.
    private execGovernance = new Map<string, string>();

    /**
     * AUDIT 2026-07-14 (Codex) M-5: a bridge request is only served while its
     * issuing execution is still live. Fail closed on a missing or unknown
     * execId (untrusted sandbox code can post to the parent channel directly
     * and omit/forge the field). Exported for tests via a cast.
     */
    private isLiveBridgeRequest(execId: string | undefined): boolean {
        return execId !== undefined && this.pending.has(execId);
    }

    /**
     * Lazy initialization — iframe is created only when first needed (~50ms).
     */
    async ensureReady(): Promise<void> {
        if (this.ready) return;
        if (!this.readyPromise) {
            this.readyPromise = this.initialize();
        }
        return this.readyPromise;
    }

    /**
     * Execute compiled JavaScript in the sandbox.
     * Returns the result from the module's execute() function.
     */
    async execute(
        compiledJs: string,
        input: Record<string, unknown>,
        options?: SandboxExecutionOptions,
    ): Promise<unknown> {
        // FIX-24-08-04: fail fast if the run was already stopped before we
        // even reached the sandbox.
        if (options?.abortSignal?.aborted) {
            throw sandboxAbortError();
        }
        await this.ensureReady();
        // AUDIT 2026-07-26 (P3): ensureReady can take a while during boot (it
        // creates the iframe and waits for the handshake). A Stop pressed inside
        // that window was not noticed, so the execution started anyway. Re-check
        // after every await that can span the boot window.
        if (options?.abortSignal?.aborted) {
            throw sandboxAbortError();
        }
        const id = this.generateId();
        // FIX-44-43: remember which task this execution runs for, keyed by the
        // execution id the iframe echoes on every bridge request.
        if (options?.governanceTaskId) {
            this.execGovernance.set(id, options.governanceTaskId);
        }

        const signal = options?.abortSignal;
        let onAbort: (() => void) | undefined;
        try {
            return await new Promise<unknown>((resolve, reject) => {
                const timeout = window.setTimeout(() => {
                    this.stopHeapSampler();
                    this.pending.delete(id);
                    this.execGovernance.delete(id);
                    reject(new Error('Sandbox execution timeout (30s)'));
                }, 30000);

                this.pending.set(id, { resolve, reject, timeout });

                // FIX-24-08-04: on Stop, reject this call immediately and tear
                // the iframe down so the running script cannot keep executing
                // on the background thread (it had no abort path before, so a
                // stopped run waited out the 30s timeout).
                if (signal) {
                    onAbort = () => {
                        window.clearTimeout(timeout);
                        this.pending.delete(id);
                        this.execGovernance.delete(id);
                        this.destroy();
                        reject(sandboxAbortError());
                    };
                    signal.addEventListener('abort', onAbort, { once: true });
                }

                // AUDIT-037 L-2: the former desktop backend capped the worker
                // heap at 128 MB via --max-old-space-size. The iframe path has no
                // equivalent V8 lever, so we sample performance.memory every 500 ms
                // and tear the iframe down once usedJSHeapSize crosses
                // HEAP_LIMIT_BYTES. performance.memory is Chromium-only (which
                // Obsidian uses on every platform that has the iframe path), so
                // the sampler is gated on its presence.
                this.startHeapSampler();

                const execMsg: PluginToSandboxMessage = { type: 'execute', id, code: compiledJs, input };
                // L-2 Known Limitation: targetOrigin '*' required for srcdoc iframes (no own origin).
                // Security: event.source check in handleMessage() prevents spoofing in receive direction.
                this.iframe?.contentWindow?.postMessage(execMsg, '*');
            });
        } finally {
            // FIX-24-08-04: detach the abort listener so a later abort of the
            // same signal cannot fire against a settled execution.
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
            // FIX (heap accumulation): once this execution settled, recycle the
            // iframe if nothing else is in flight, so the next run_skill_script
            // starts on a fresh V8 heap instead of accumulating parsed strings
            // across a sequential batch. No-op while other executions are live;
            // the SandboxBridge (and its write-rate counter) survives the recycle.
            // ensureReady() lazily rebuilds the iframe on the next execute().
            this.recycleIfIdle();
        }
    }

    /**
     * AUDIT-037 L-2: heap sampling for the iframe sandbox. Stops itself when
     * pending is empty (every execution finished). On limit breach destroys
     * the iframe and rejects all pending executions so a memory bomb cannot
     * starve the host renderer indefinitely.
     *
     * FIX-PERF-44: uses scheduleRecurring, NOT window.setInterval -- the
     * post-build rename in esbuild.config.mjs turns every setInterval
     * identifier into __si_polyfill, which made this sampler throw
     * "window.__si_polyfill is not a function" on every sandbox execute().
     */
    private heapSampler: RecurringHandle | null = null;
    private static readonly HEAP_SAMPLE_INTERVAL_MS = 500;
    private static readonly HEAP_LIMIT_BYTES = 128 * 1024 * 1024;
    private stopHeapSampler(): void {
        this.heapSampler?.stop();
        this.heapSampler = null;
    }
    private startHeapSampler(): void {
        if (this.heapSampler !== null) return;
        const perf = (window as unknown as { performance?: { memory?: { usedJSHeapSize?: number } } }).performance;
        if (!perf?.memory || typeof perf.memory.usedJSHeapSize !== 'number') return;
        this.heapSampler = scheduleRecurring(() => {
            if (this.pending.size === 0) {
                this.stopHeapSampler();
                return;
            }
            const used = perf.memory?.usedJSHeapSize ?? 0;
            if (used > IframeSandboxExecutor.HEAP_LIMIT_BYTES) {
                console.warn(`[IframeSandbox] heap cap exceeded (${used} > ${IframeSandboxExecutor.HEAP_LIMIT_BYTES}); terminating sandbox`);
                for (const [, p] of this.pending) {
                    window.clearTimeout(p.timeout);
                    p.reject(new Error('Sandbox terminated: heap limit exceeded (128 MB)'));
                }
                this.pending.clear();
                this.destroy();
            }
        }, IframeSandboxExecutor.HEAP_SAMPLE_INTERVAL_MS);
    }

    /**
     * FIX (heap accumulation): tear down the iframe when idle so the next
     * execution starts on a fresh V8 heap.
     *
     * The iframe is reused across executions and its GC does not reclaim large
     * parsed strings (e.g. sinked transcripts) between run_skill_script calls.
     * A batch that ran many script calls in sequence accumulated until the
     * 128 MB cap tripped, even with no single large input. Recycling between
     * calls bounds the heap to one execution's working set.
     *
     * Two invariants:
     *   - Recycle ONLY when idle. Recycling while another task's execution is
     *     live would reject that in-flight call (destroy() rejects pending).
     *   - Recycle keeps `this.bridge`. The write-rate counter (10/min) lives on
     *     the bridge, not the iframe; a fresh iframe must NOT reset it, or a
     *     batch could bypass the write limit that guards the vault.
     *
     * ensureReady() lazily rebuilds the iframe on the next execute(), so this
     * is a teardown, not a synchronous re-init.
     */
    recycleIfIdle(): void {
        if (this.pending.size > 0) return;
        this.teardownIframe();
    }

    /**
     * Tear down just the iframe + its listeners, leaving the bridge and any
     * governance state intact. Shared by recycleIfIdle() and destroy().
     */
    private teardownIframe(): void {
        if (this.messageHandler) {
            window.removeEventListener('message', this.messageHandler);
            this.messageHandler = null;
        }
        this.iframe?.remove();
        this.iframe = null;
        this.ready = false;
        this.readyPromise = null;
        this.stopHeapSampler();
    }

    /**
     * Clean up the iframe and pending executions. Unlike recycleIfIdle(), this
     * also rejects any in-flight executions -- it is a hard teardown for host
     * shutdown or a heap-cap breach, not an idle recycle.
     */
    destroy(): void {
        this.teardownIframe();

        for (const p of this.pending.values()) {
            window.clearTimeout(p.timeout);
            p.reject(new Error('Sandbox destroyed'));
        }
        this.pending.clear();
        this.execGovernance.clear();
    }

    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------

    private async initialize(): Promise<void> {
        this.iframe = createEl('iframe');
        this.iframe.sandbox.add('allow-scripts');
        // Review-Bot: CSS class instead of inline style
        this.iframe.addClass('agent-sandbox-iframe');
        this.iframe.srcdoc = SANDBOX_HTML;
        activeDocument.body.appendChild(this.iframe);

        // Wait for 'sandbox-ready' message with timeout (10s)
        await new Promise<void>((resolve, reject) => {
            const INIT_TIMEOUT_MS = 10000;
            const timeout = window.setTimeout(() => {
                window.removeEventListener('message', handler);
                reject(new Error(`Sandbox initialization timeout (${INIT_TIMEOUT_MS}ms). The iframe did not signal readiness.`));
            }, INIT_TIMEOUT_MS);

            const handler = (e: MessageEvent) => {
                // AUDIT-038 ISSUE-005: gate the init handshake on
                // event.source the same way handleMessage() gates
                // steady-state traffic. A forged `sandbox-ready` from
                // another renderer context (e.g. a sibling plugin) must
                // not complete our initialization.
                if (!isFromOwnSandboxFrame(e, this.iframe?.contentWindow ?? null)) return;
                const data = e.data as { type?: string } | undefined;
                if (data?.type === 'sandbox-ready') {
                    window.clearTimeout(timeout);
                    window.removeEventListener('message', handler);
                    this.ready = true;
                    resolve();
                }
            };
            window.addEventListener('message', handler);
        });

        // Global message handler for all sandbox communication
        this.messageHandler = (e: MessageEvent) => {
            void this.handleMessage(e);
        };
        window.addEventListener('message', this.messageHandler);
    }

    private async handleMessage(event: MessageEvent): Promise<void> {
        // H-2/M-10: Only accept messages from our sandbox iframe — prevents
        // other plugins in the same Electron renderer from spoofing messages.
        // AUDIT-038 ISSUE-005 made this the same helper the init handler uses
        // so the two cannot drift.
        if (!isFromOwnSandboxFrame(event, this.iframe?.contentWindow ?? null)) return;

        const msg = event.data as SandboxToPluginMessage | undefined;
        if (!msg || !('type' in msg)) return;

        // Execution result/error
        if (msg.type === 'result' || msg.type === 'error') {
            const id = msg.type === 'result' ? msg.id : msg.id;
            this.execGovernance.delete(id);
            const p = this.pending.get(id);
            if (!p) return;
            window.clearTimeout(p.timeout);
            this.pending.delete(id);
            if (msg.type === 'error') {
                p.reject(new Error(msg.message));
            } else {
                p.resolve(msg.value);
            }
            return;
        }

        // Lifecycle message (no bridge action needed)
        if (msg.type === 'sandbox-ready') return;

        // Bridge requests from the iframe — all have callId
        const bridgeMsg = msg;

        // AUDIT 2026-07-14 (Codex) M-5 + review: the iframe is a warm singleton
        // that keeps running delayed code (setTimeout/Promise) after execute()
        // resolved. Serving a bridge request from a finished execution would let
        // post-completion code read/write/fetch and lose checkpoint attribution.
        // Every LEGITIMATE bridge request is stamped with an execId by the
        // sandbox proxies (sandboxHtml makeVaultProxy/makeRequestUrlProxy), and
        // result/error/sandbox-ready are handled above. So a request that is
        // missing an execId, or whose execId is no longer active, is either a
        // hand-crafted parent.postMessage from untrusted code or a stale delayed
        // call. Fail closed: reject unless the issuing execution is still live.
        if (!this.isLiveBridgeRequest(bridgeMsg.execId)) {
            const stale: PluginToSandboxMessage = {
                callId: bridgeMsg.callId,
                error: 'Sandbox execution is no longer active; bridge request rejected.',
            };
            this.iframe?.contentWindow?.postMessage(stale, '*');
            return;
        }

        // FIX-44-43: resolve the issuing execution back to its governance task.
        const governanceTaskId = bridgeMsg.execId !== undefined
            ? this.execGovernance.get(bridgeMsg.execId)
            : undefined;

        try {
            let result: unknown;
            if (bridgeMsg.type === 'vault-read') {
                result = await this.bridge.vaultRead(bridgeMsg.path);
            } else if (bridgeMsg.type === 'vault-read-binary') {
                result = await this.bridge.vaultReadBinary(bridgeMsg.path);
            } else if (bridgeMsg.type === 'vault-list') {
                // FIX-29-99-03: pre-fix `result = this.bridge.vaultList(...)`
                // left the un-resolved Promise as the message payload, which
                // postMessage cannot structured-clone -- the iframe sandbox
                // silently got an empty result back. SandboxBridge.vaultList
                // is async (returns Promise<string[]>); awaiting it here
                // mirrors the other bridge calls in this switch.
                result = await this.bridge.vaultList(bridgeMsg.path);
            } else if (bridgeMsg.type === 'vault-mkdir') {
                // FIX-29-99-03: skill-creator on mobile needs to create
                // folders. SandboxBridge.vaultMkdir was implemented but the
                // iframe message router never reached it -- new branch here
                // plus the corresponding `vault.mkdir(...)` proxy in
                // sandboxHtml.ts.
                await this.bridge.vaultMkdir(bridgeMsg.path);
                result = true;
            } else if (bridgeMsg.type === 'vault-write') {
                await this.bridge.vaultWrite(bridgeMsg.path, bridgeMsg.content, governanceTaskId);
                result = true;
            } else if (bridgeMsg.type === 'vault-write-binary') {
                await this.bridge.vaultWriteBinary(bridgeMsg.path, bridgeMsg.content, governanceTaskId);
                result = true;
            } else if (bridgeMsg.type === 'request-url') {
                result = await this.bridge.requestUrlBridge(bridgeMsg.url, bridgeMsg.options);
            } else {
                return;
            }

            const response: PluginToSandboxMessage = { callId: bridgeMsg.callId, result };
            // L-2: targetOrigin '*' -- see execute() comment for rationale
            this.iframe?.contentWindow?.postMessage(response, '*');
        } catch (e) {
            // M-8: Record error for circuit breaker
            this.bridge.recordError();
            const errorResponse: PluginToSandboxMessage = {
                callId: bridgeMsg.callId,
                error: e instanceof Error ? e.message : String(e),
            };
            this.iframe?.contentWindow?.postMessage(errorResponse, '*');
        }
    }

    private generateId(): string {
        return 'sx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }
}
