/**
 * Leveled logging.
 *
 * The plugin logs from hot paths: one line per stream event, per indexed file,
 * per tool step. Two costs follow. The console work itself, and -- the reason
 * this layer exists -- eviction: ConsoleRingBuffer keeps the last 500 entries
 * for the agent to read back through read_agent_logs, so a chatty loop pushes
 * out the entries that would have explained an actual failure.
 *
 * So `debug` is a no-op unless the user turns on debugMode (Settings > Debug),
 * while `warn` and `error` always pass through -- something a user or the
 * agent may need to act on stays visible by default.
 *
 * Review-Bot: console.debug/warn/error only, never console.log.
 */

/**
 * Module-level rather than injected: logging is called from constructors,
 * free functions and static paths that have no plugin handle to thread a
 * dependency through. One process hosts one plugin instance, so a module flag
 * matches the real lifetime. Wired in main.ts at boot and on the settings
 * toggle.
 */
let debugEnabled = false;

export function setDebugLogging(on: boolean): void {
    debugEnabled = on;
}

export function isDebugLogging(): boolean {
    return debugEnabled;
}

/**
 * A message part: any value, or a thunk returning one. A thunk defers work
 * that should not happen while debug logging is off --
 * `log.debug(() => JSON.stringify(bigObject))` costs nothing until someone
 * switches the level on. (Typed as plain `unknown` because a union with a
 * function type collapses to `unknown` anyway; the thunk case is a runtime
 * contract, honoured by resolve() below.)
 */
export type LogArg = unknown;

export interface Logger {
    debug(...args: LogArg[]): void;
    warn(...args: LogArg[]): void;
    error(...args: LogArg[]): void;
}

function resolve(args: LogArg[]): unknown[] {
    return args.map((a) => (typeof a === 'function' ? (a as () => unknown)() : a));
}

/**
 * A logger tagged with its source, e.g. createLogger('Responses') prints
 * `[Responses] ...`. The tag matches the bracketed prefixes already used
 * across the codebase, so migrated call sites keep their console appearance.
 */
export function createLogger(source: string): Logger {
    const tag = `[${source}]`;
    return {
        debug(...args: LogArg[]): void {
            if (!debugEnabled) return;
            console.debug(tag, ...resolve(args));
        },
        warn(...args: LogArg[]): void {
            console.warn(tag, ...resolve(args));
        },
        error(...args: LogArg[]): void {
            console.error(tag, ...resolve(args));
        },
    };
}
