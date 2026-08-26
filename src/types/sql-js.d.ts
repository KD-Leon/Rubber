declare module 'sql.js' {
    interface SqlJsStatic {
        Database: new (data?: ArrayLike<number>) => Database;
    }

    interface Database {
        run(sql: string, params?: unknown[]): Database;
        exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
        prepare(sql: string): Statement;
        export(): Uint8Array;
        close(): void;
    }

    interface Statement {
        bind(params?: unknown[]): boolean;
        step(): boolean;
        getAsObject(params?: Record<string, unknown>): Record<string, unknown>;
        get(params?: unknown[]): unknown[];
        free(): void;
        run(params?: unknown[]): void;
        reset(): void;
    }

    function initSqlJs(config?: { wasmBinary?: ArrayBuffer }): Promise<SqlJsStatic>;
    export default initSqlJs;
}
