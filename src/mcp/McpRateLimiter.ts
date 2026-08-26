/**
 * AUDIT-015 M-1: Sliding-window rate limiter for MCP tool calls.
 *
 * Schuetzt vor Burst- und Volume-Attacken auf das exposierte
 * MCP-Surface. Token-Budget-Guards in Memory-v2 wirken nur in der
 * Pipeline; externe Aufrufer koennten unbegrenzt Tools rufen, was
 * Cost (LLM/Embedding) und Memory-DB-Last verursacht.
 *
 * Limit-Klassen pro Tool:
 *   - 'cheap': read-only ohne LLM (read_notes, search_vault, ...)
 *   - 'medium': mit LLM/embedding aber nicht extraction (recall_memory)
 *   - 'expensive': triggert Pipeline (save_conversation, save_to_memory)
 *
 * Zaehlt pro Minute. Caller key ist mcpToken + sourceInterface; das
 * ist die feinste Granularitaet, die wir heute haben (in der Praxis
 * gibt es nur einen Token, aber mehrere source_interfaces).
 *
 * IMP-14-00-03: Dispatcher-Tools (execute_vault_op) tragen ihre Last
 * nicht selbst, sondern in der Operation, die sie ausfuehren. Ihre
 * Klasse kommt darum aus der inneren Operation, abgeleitet ueber die
 * Effekt-Klasse aus ADR-153. Der Caller-Key bleibt davon unberuehrt.
 */

import { resolveToolEffect, type ToolEffect } from '../core/tools/toolEffects';

export type RateLimitClass = 'cheap' | 'medium' | 'expensive';

export interface RateLimitDecision {
    allowed: boolean;
    /** When denied: seconds until the next call would be allowed. */
    retryAfterSec?: number;
    /** Diagnostic, immer gesetzt. */
    remainingInWindow: number;
    limitInWindow: number;
}

const LIMITS_PER_MINUTE: Record<RateLimitClass, number> = {
    cheap: 60,        // 1 pro Sekunde average
    medium: 30,       // 1 pro 2 Sekunden
    expensive: 10,    // alle 6 Sekunden -- LLM + Memory-Schreiben
};

const WINDOW_MS = 60_000;

export class McpRateLimiter {
    private buckets: Map<string, number[]> = new Map();

    /** Returns a decision; does NOT consume the slot. Use record() after. */
    check(callerKey: string, klass: RateLimitClass): RateLimitDecision {
        const now = Date.now();
        const limit = LIMITS_PER_MINUTE[klass];
        const bucketKey = `${callerKey}:${klass}`;
        const timestamps = this.buckets.get(bucketKey) ?? [];
        // Drop expired entries
        const fresh = timestamps.filter((t) => now - t < WINDOW_MS);
        this.buckets.set(bucketKey, fresh);
        if (fresh.length >= limit) {
            const oldest = fresh[0];
            const retryAfterSec = Math.ceil((WINDOW_MS - (now - oldest)) / 1000);
            return {
                allowed: false,
                retryAfterSec: Math.max(1, retryAfterSec),
                remainingInWindow: 0,
                limitInWindow: limit,
            };
        }
        return {
            allowed: true,
            remainingInWindow: limit - fresh.length,
            limitInWindow: limit,
        };
    }

    /** Consume a slot. Call only after check() returned allowed=true. */
    record(callerKey: string, klass: RateLimitClass): void {
        const bucketKey = `${callerKey}:${klass}`;
        const timestamps = this.buckets.get(bucketKey) ?? [];
        timestamps.push(Date.now());
        this.buckets.set(bucketKey, timestamps);
    }

    /** Combined check + record in one step. */
    consume(callerKey: string, klass: RateLimitClass): RateLimitDecision {
        const decision = this.check(callerKey, klass);
        if (decision.allowed) this.record(callerKey, klass);
        return decision;
    }

    /** Diagnostic: total active buckets. */
    size(): number { return this.buckets.size; }

    /** Clean up buckets that are empty after expiration. Idempotent. */
    cleanup(): void {
        const now = Date.now();
        for (const [k, ts] of this.buckets) {
            const fresh = ts.filter((t) => now - t < WINDOW_MS);
            if (fresh.length === 0) this.buckets.delete(k);
            else this.buckets.set(k, fresh);
        }
    }
}

/**
 * Map MCP-tool-name -> rate-limit class. Default 'cheap' for unknown
 * tools (defensive: any new tool that hits the limiter must be
 * classified explicitly to step up).
 */
export const TOOL_RATE_CLASS: Readonly<Record<string, RateLimitClass>> = {
    // cheap: read-only, no LLM
    get_context: 'cheap',
    read_notes: 'cheap',
    search_vault: 'cheap',
    list_memory_source_notes: 'cheap',
    get_vault_implicit_edges: 'cheap',
    get_vault_note_metadata: 'cheap',
    close_conversation: 'cheap',

    // medium: embedding or moderate compute
    recall_memory: 'medium',
    search_history: 'medium',
    sync_session: 'medium',
    update_memory: 'medium',  // legacy, routes to save_to_memory
    // IMP-14-00-03: nur noch der Fallback fuer einen Aufruf ohne (gueltige)
    // operation. Die echte Klasse kommt aus classifyToolCall.
    execute_vault_op: 'medium',

    // expensive: LLM-extract or memory-write
    save_to_memory: 'expensive',
    save_conversation: 'expensive',
    write_vault: 'expensive',
    mark_note_as_memory_source: 'expensive',
    unmark_note_as_memory_source: 'expensive',
};

export function classifyTool(toolName: string): RateLimitClass {
    return TOOL_RATE_CLASS[toolName] ?? 'cheap';
}

/**
 * IMP-14-00-03: Effekt-Klasse (ADR-153) -> Rate-Klasse.
 *
 * Die Effekt-Klasse ist die einzige Stelle, an der jedes Agent-Tool schon
 * heute nach Wirkung sortiert ist, und ein Vollstaendigkeits-Test haelt sie
 * lueckenlos. Eine zweite Namensliste hier wuerde genau die Drift erzeugen,
 * die dieser Fix beseitigt.
 *
 * Die Zuordnung folgt der Wirkung: lesen und Loop-Steuerung sind billig,
 * Netz-Egress und Fremdaufrufe kosten Latenz und Fremdquoten, alles was
 * schreibt, Code ausfuehrt oder eine eigene Schleife startet bekommt den
 * engsten Eimer.
 */
const EFFECT_RATE_CLASS: Readonly<Record<ToolEffect, RateLimitClass>> = {
    read: 'cheap',
    ui: 'cheap',
    web: 'medium',
    mcp: 'medium',
    'plugin-api': 'medium',
    skill: 'medium',
    'note-edit': 'expensive',
    'vault-change': 'expensive',
    config: 'expensive',
    'self-modify': 'expensive',
    subtask: 'expensive',
    sandbox: 'expensive',
    recipe: 'expensive',
};

const CLASS_RANK: Readonly<Record<RateLimitClass, number>> = {
    cheap: 0,
    medium: 1,
    expensive: 2,
};

function stricter(a: RateLimitClass, b: RateLimitClass): RateLimitClass {
    // eslint-disable-next-line security/detect-object-injection -- beide Schluessel sind RateLimitClass-Literale, keine Eingabe
    return CLASS_RANK[a] >= CLASS_RANK[b] ? a : b;
}

function asParams(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
}

/**
 * MCP-Tools, die selbst nichts tun, sondern eine innere Operation ausfuehren.
 */
const DISPATCH_TOOLS: ReadonlySet<string> = new Set(['execute_vault_op']);

/**
 * Rate-Klasse einer inneren Agent-Operation.
 *
 * Zwei Quellen, die strengere gewinnt:
 *   - die Effekt-Klasse der Operation (fail-closed: eine Operation ohne
 *     Effekt-Eintrag ist unbekannt und zaehlt als 'expensive', damit ein
 *     Aufrufer den Namensraum nicht mit 60 Sondierungen pro Minute abklopft);
 *   - der direkte MCP-Eintrag aus TOOL_RATE_CLASS, falls es die Operation
 *     auch als eigenes MCP-Tool gibt. Sonst waere der Dispatcher ein Rabatt:
 *     recall_memory kostet direkt 'medium', hat als Agent-Tool aber den
 *     Effekt 'read'.
 */
function classifyOperation(
    operation: string,
    params?: Record<string, unknown>,
): RateLimitClass {
    return stricterOrEffect(
        rateClassForEffect(safeResolveToolEffect(operation, params)),
        directMcpClass(operation),
    );
}

/**
 * resolveToolEffect liest TOOL_EFFECTS als Objekt-Literal. Ein Prototyp-
 * Schluessel wie 'valueOf' trifft dort eine geerbte Funktion, die dann als
 * Effekt-Spec mit falschem this aufgerufen wird und wirft. Der Name kommt
 * hier vom Aufrufer, also faengt der Rate-Limiter das ab und behandelt es
 * als unbekannte Operation.
 */
function safeResolveToolEffect(
    operation: string,
    params?: Record<string, unknown>,
): ToolEffect | undefined {
    try {
        return resolveToolEffect(operation, params);
    } catch {
        return undefined;
    }
}

function stricterOrEffect(fromEffect: RateLimitClass, direct: RateLimitClass | undefined): RateLimitClass {
    return direct === undefined ? fromEffect : stricter(fromEffect, direct);
}

/**
 * Der operation-String kommt vom Aufrufer. Beide Tabellen sind Objekt-
 * Literale, also liefert ein Prototyp-Schluessel wie 'constructor' oder
 * '__proto__' ohne eigenen Property-Check einen Wert, der keine Klasse ist;
 * das Limit waere dann undefined und der Eimer bodenlos. Darum wird jeder
 * Treffer als eigene Property nachgewiesen und der Effekt zusaetzlich auf
 * einen echten String geprueft.
 */
function rateClassForEffect(effect: ToolEffect | undefined): RateLimitClass {
    if (typeof effect !== 'string') return 'expensive';
    if (!Object.prototype.hasOwnProperty.call(EFFECT_RATE_CLASS, effect)) return 'expensive';
    // eslint-disable-next-line security/detect-object-injection -- eigener Property-Nachweis eine Zeile darueber
    return EFFECT_RATE_CLASS[effect];
}

function directMcpClass(operation: string): RateLimitClass | undefined {
    if (!Object.prototype.hasOwnProperty.call(TOOL_RATE_CLASS, operation)) return undefined;
    // eslint-disable-next-line security/detect-object-injection -- eigener Property-Nachweis eine Zeile darueber
    const direct = TOOL_RATE_CLASS[operation];
    return Object.prototype.hasOwnProperty.call(CLASS_RANK, direct) ? direct : undefined;
}

/**
 * IMP-14-00-03: Rate-Klasse eines konkreten MCP-Aufrufs. Fuer alle Tools
 * ausser den Dispatchern identisch mit classifyTool. Ein Dispatch-Aufruf
 * ohne brauchbaren operation-String behaelt die aeussere Klasse; er wird
 * ohnehin vom Handler abgelehnt.
 */
export function classifyToolCall(
    toolName: string,
    args?: Record<string, unknown>,
): RateLimitClass {
    if (!DISPATCH_TOOLS.has(toolName)) return classifyTool(toolName);
    const operation = args?.operation;
    if (typeof operation !== 'string' || operation.length === 0) return classifyTool(toolName);
    return classifyOperation(operation, asParams(args?.params));
}
