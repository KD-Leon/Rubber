/**
 * Plugin API Allowlist — Built-in curated list of safe Plugin API methods (PAS-1.5)
 *
 * Tier 1 of the two-tier allowlist system.
 * Methods listed here have been manually reviewed for safety.
 * The isWrite flag is set correctly per method.
 *
 * Tier 2 (dynamic discovery) is handled by VaultDNAScanner at runtime.
 * Dynamically discovered methods are ALWAYS isWrite = true until the user
 * explicitly marks them as safe in settings.
 */

export interface AllowedApiMethod {
    pluginId: string;
    method: string;
    isWrite: boolean;
    description: string;
    /** Simple parameter schema for validation. Keys are param names, values are types. */
    paramSchema?: Record<string, 'string' | 'number' | 'boolean' | 'string[]'>;
    /** Maximum size of the JSON-stringified return value (bytes). */
    maxReturnSize: number;
}

/**
 * Methods that are ALWAYS blocked regardless of allowlist or discovery.
 * These methods can manipulate DOM, lifecycle, or execute arbitrary code.
 */
export const BLOCKED_METHODS: ReadonlySet<string> = new Set([
    'execute',
    'executeJs',
    'render',
    'register',
    'unregister',
    'onload',
    'onunload',
    'destroy',
    'eval',
]);

export const PLUGIN_API_ALLOWLIST: AllowedApiMethod[] = [
    // ── Dataview — read-only ────────────────────────────────────────────────
    {
        pluginId: 'dataview',
        method: 'query',
        isWrite: false,
        description: 'Execute a DQL query and return structured results',
        paramSchema: { source: 'string' },
        maxReturnSize: 50_000,
    },
    {
        pluginId: 'dataview',
        method: 'tryQueryMarkdown',
        isWrite: false,
        description: 'Execute a DQL query and return results as markdown',
        paramSchema: { source: 'string' },
        maxReturnSize: 50_000,
    },
    {
        pluginId: 'dataview',
        method: 'pages',
        isWrite: false,
        description: 'Get pages matching a DQL source expression',
        paramSchema: { source: 'string' },
        maxReturnSize: 50_000,
    },
    {
        pluginId: 'dataview',
        method: 'page',
        isWrite: false,
        description: 'Get metadata for a single page by path',
        paramSchema: { path: 'string' },
        maxReturnSize: 10_000,
    },

    // ── Omnisearch — read-only ──────────────────────────────────────────────
    {
        pluginId: 'omnisearch',
        method: 'search',
        isWrite: false,
        description: 'Full-text vault search via Omnisearch',
        paramSchema: { query: 'string' },
        maxReturnSize: 50_000,
    },

    // ── MetaEdit — read ─────────────────────────────────────────────────────
    {
        pluginId: 'metaedit',
        method: 'getPropertyValue',
        isWrite: false,
        description: 'Read a frontmatter property value from a file',
        paramSchema: { propertyName: 'string', file: 'string' },
        maxReturnSize: 10_000,
    },
    {
        pluginId: 'metaedit',
        method: 'getFilesWithProperty',
        isWrite: false,
        description: 'Find all files that have a specific frontmatter property',
        paramSchema: { propertyName: 'string' },
        maxReturnSize: 50_000,
    },

    // ── MetaEdit — write (requires approval) ────────────────────────────────
    {
        pluginId: 'metaedit',
        method: 'update',
        isWrite: true,
        description: 'Update a frontmatter property value in a file',
        paramSchema: { propertyName: 'string', propertyValue: 'string', file: 'string' },
        maxReturnSize: 1_000,
    },

    // ── Frontmatter Editor — read ───────────────────────────────────────────
    // Curated surface for the frontmatter-operator plugin (branded
    // "Frontmatter Operator" in the UI). Its API self-describes via
    // describeActions(); these entries make the read methods
    // auto-approvable and the write methods approval-gated without relying
    // on the dynamic-discovery promotion path. Args are objects (opts), so
    // paramSchema (simple types only) is omitted except where a scalar id
    // applies.
    //
    // FO also ships 12 Obsidian commands (open-frontmatter-operator,
    // set-property, undo-last, cleanup-refusal-tags, dedupe-wikilinks,
    // list-properties, ...). All command variants that touch data open
    // interactive modals for humans; agents use the API methods below.
    {
        pluginId: 'frontmatter-operator',
        method: 'describeActions',
        isWrite: false,
        description: 'Return the full action catalog (methods, params, examples) -- call first to learn the surface',
        maxReturnSize: 50_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'listProperties',
        isWrite: false,
        description: 'List every frontmatter property in the vault with usage count, types and sample values',
        maxReturnSize: 50_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'getMatchingPaths',
        isWrite: false,
        description: 'Resolve a NoteSelector to matching note paths plus a count (agent-friendly preview)',
        maxReturnSize: 50_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'listSnapshots',
        isWrite: false,
        description: 'List undo snapshots (id, timestamp, affected note count), newest first',
        maxReturnSize: 20_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'scan',
        isWrite: false,
        description: 'Scan the vault and return the full frontmatter property inventory',
        maxReturnSize: 50_000,
    },

    // ── Frontmatter Editor — write (requires approval, snapshotted) ──────────
    {
        pluginId: 'frontmatter-operator',
        method: 'setProperty',
        isWrite: true,
        description: 'Set a frontmatter property on the selected notes (snapshotted, undoable)',
        maxReturnSize: 10_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'deleteProperties',
        isWrite: true,
        description: 'Delete one or more frontmatter properties from the selected notes (snapshotted)',
        maxReturnSize: 10_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'renameProperty',
        isWrite: true,
        description: 'Rename a frontmatter property across the selected notes (snapshotted)',
        maxReturnSize: 10_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'renameValues',
        isWrite: true,
        description: 'Rename values of a frontmatter property across the selected notes (mappings from -> to, snapshotted)',
        maxReturnSize: 10_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'copyProperty',
        isWrite: true,
        description: 'Copy values from source properties into a target property (snapshotted)',
        maxReturnSize: 10_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'mergeProperties',
        isWrite: true,
        description: 'Merge source properties into a target and delete the sources (snapshotted)',
        maxReturnSize: 10_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'cleanupRefusalTags',
        isWrite: true,
        description: 'Remove LLM refusal text from frontmatter and return a report (snapshotted; pass dryRun to preview)',
        maxReturnSize: 50_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'dedupeWikilinks',
        isWrite: true,
        description: 'Collapse duplicate frontmatter wikilinks and return a report (snapshotted; pass dryRun to preview)',
        maxReturnSize: 50_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'undoLast',
        isWrite: true,
        description: 'Restore the most recent snapshot, reverting the last action',
        maxReturnSize: 10_000,
    },
    {
        pluginId: 'frontmatter-operator',
        method: 'restoreSnapshot',
        isWrite: true,
        description: 'Restore a specific snapshot by id',
        paramSchema: { id: 'string' },
        maxReturnSize: 10_000,
    },
];

/**
 * Look up a method in the built-in allowlist.
 * Returns the AllowedApiMethod if found, undefined otherwise.
 */
export function findAllowedMethod(pluginId: string, method: string): AllowedApiMethod | undefined {
    return PLUGIN_API_ALLOWLIST.find(
        (entry) => entry.pluginId === pluginId && entry.method === method,
    );
}

/**
 * Return every allowlisted method for a plugin. Used by the PLUGIN SKILLS
 * prompt section to render the API surface next to the plugin's commands
 * without a runtime describeActions() call.
 */
export function getAllowedMethodsForPlugin(pluginId: string): AllowedApiMethod[] {
    return PLUGIN_API_ALLOWLIST.filter((entry) => entry.pluginId === pluginId);
}
