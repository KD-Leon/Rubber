/**
 * MCP connector catalog (FEAT-04-10, ADR-156).
 *
 * A curated, data-driven list of one-click MCP connectors. Each entry declares
 * an auth class; the connection engine branches on the class only, so adding a
 * connector is a data change, not an engine change. The first build ships
 * `none` (no auth) and `oauth-dcr` (self-registering OAuth) entries; the other
 * classes are declared so the model already has room for them.
 *
 * Endpoint URLs and auth classes were verified by probing each endpoint's
 * OAuth discovery (RFC 9728 / RFC 8414) before inclusion. Re-verify before
 * adding new entries -- a probe beats a claim.
 *
 * Wayfinder: src/ARCHITECTURE.map concept `mcp-connector-catalog`.
 */

import type { McpServerConfig } from '../../types/settings';

/**
 * - `none`: no authentication (connect immediately).
 * - `oauth-dcr`: OAuth 2.1 with dynamic client registration (zero-config).
 * - `oauth-public-preregistered`: OAuth public client, needs a vendor-registered
 *   client id (Phase 2; not yet used).
 * - `oauth-confidential`: OAuth confidential client, needs a broker (deferred).
 */
export type ConnectorAuthClass =
    | 'none'
    | 'oauth-dcr'
    | 'oauth-public-preregistered'
    | 'oauth-confidential';

export type ConnectorContext = 'business' | 'education' | 'research';

export interface ConnectorCatalogEntry {
    /** Stable server key; also the `mcpServers` map key. */
    id: string;
    displayName: string;
    /** 'remote' (default): HTTP/SSE with url+transport. 'stdio' (FEAT-04-13):
     *  a local program with command+args, Desktop-only, device-local. */
    kind?: 'remote' | 'stdio';
    /** Remote only: endpoint URL. Absent for stdio entries. */
    url?: string;
    transport?: 'streamable-http' | 'sse';
    authClass: ConnectorAuthClass;
    /** stdio only: launch command (node/npx) and base args. Org/secret values
     *  are collected in the guided setup, not stored in the catalog. */
    command?: string;
    args?: string[];
    description: string;
    contextTags: ConnectorContext[];
}

/** First-build catalog (locked with the user). */
export const MCP_CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
    {
        id: 'notion',
        displayName: 'Notion',
        url: 'https://mcp.notion.com/mcp',
        transport: 'streamable-http',
        authClass: 'oauth-dcr',
        description: 'Search and read your Notion workspace.',
        contextTags: ['business', 'education', 'research'],
    },
    {
        id: 'exa',
        displayName: 'Exa',
        url: 'https://mcp.exa.ai/mcp',
        transport: 'streamable-http',
        authClass: 'oauth-dcr',
        description: 'Semantic web and research-paper search.',
        contextTags: ['research', 'education'],
    },
    {
        id: 'tavily',
        displayName: 'Tavily',
        url: 'https://mcp.tavily.com/mcp/',
        transport: 'streamable-http',
        authClass: 'oauth-dcr',
        description: 'Real-time web search and content extraction.',
        contextTags: ['business', 'education', 'research'],
    },
    {
        id: 'readwise',
        displayName: 'Readwise',
        url: 'https://mcp2.readwise.io/mcp',
        transport: 'streamable-http',
        authClass: 'oauth-dcr',
        description: 'Answer from your highlights and Reader documents.',
        contextTags: ['education'],
    },
    {
        id: 'atlassian',
        displayName: 'Atlassian',
        url: 'https://mcp.atlassian.com/v1/mcp',
        transport: 'streamable-http',
        authClass: 'oauth-dcr',
        description: 'Jira issues and Confluence pages.',
        contextTags: ['business'],
    },
    {
        id: 'plaud',
        displayName: 'Plaud',
        url: 'https://mcp.plaud.ai/mcp',
        transport: 'streamable-http',
        authClass: 'oauth-dcr',
        description: 'Your Plaud recordings, transcripts and AI notes.',
        contextTags: ['business'],
    },
    {
        id: 'microsoft-learn',
        displayName: 'Microsoft Learn',
        url: 'https://learn.microsoft.com/api/mcp',
        transport: 'streamable-http',
        authClass: 'none',
        description: 'Microsoft and Azure documentation and training content.',
        contextTags: ['education'],
    },
    {
        id: 'icons8',
        displayName: 'Icons8',
        url: 'https://mcp.icons8.com/mcp/',
        transport: 'streamable-http',
        authClass: 'none',
        description: 'Free PNG icons and illustrations for canvas and diagrams.',
        contextTags: ['business', 'education', 'research'],
    },
    {
        // Local stdio server (FEAT-04-13). Not in the public MCP registry, so
        // it is offered as a curated entry; the guided setup (matched by this
        // id in connectorSetupGuides) collects the org + PAT. Desktop-only.
        id: 'azure-devops',
        displayName: 'Azure DevOps',
        kind: 'stdio',
        command: 'npx',
        args: ['-y', '@azure-devops/mcp'],
        authClass: 'none',
        description: 'Work items, repositories and pipelines from your Azure DevOps organization.',
        contextTags: ['business'],
    },
];

/**
 * Map the catalog to seedable built-in `McpServerConfig` entries. OAuth
 * connectors seed disabled (they require authorization first); no-auth
 * connectors seed enabled so they connect on boot like icons8.
 */
export function getCatalogBuiltinServers(): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    for (const entry of MCP_CONNECTOR_CATALOG) {
        // stdio entries are Desktop-only + device-local + trust-gated; they are
        // never seeded as always-on built-ins (FEAT-04-13).
        if (entry.kind === 'stdio') continue;
        const isOAuth = entry.authClass !== 'none';
        out[entry.id] = {
            type: entry.transport ?? 'streamable-http',
            url: entry.url,
            timeout: 60,
            isBuiltIn: true,
            disabled: isOAuth,
            ...(isOAuth ? { authType: 'oauth' as const } : {}),
        };
    }
    return out;
}

/** Look up catalog display metadata by server id (for the settings UI). */
export function getCatalogEntry(id: string): ConnectorCatalogEntry | undefined {
    return MCP_CONNECTOR_CATALOG.find((entry) => entry.id === id);
}

/** Normalized (lowercase, no trailing slash) catalog endpoints. stdio entries
 *  have no url and are skipped. */
const CATALOG_URL_SET: ReadonlySet<string> = new Set(
    MCP_CONNECTOR_CATALOG.filter((e) => e.url).map((e) => e.url!.toLowerCase().replace(/\/+$/, '')),
);

/** True when `url` is a curated catalog endpoint (drives the "Official" mark). */
export function isCatalogUrl(url: string | undefined): boolean {
    if (!url) return false;
    return CATALOG_URL_SET.has(url.toLowerCase().replace(/\/+$/, ''));
}

/**
 * Build the `McpServerConfig` a catalog entry materializes into when a user
 * adds it from the discovery search. Unlike {@link getCatalogBuiltinServers},
 * the result is NOT flagged `isBuiltIn`: it is a user-chosen server that must
 * survive {@link pruneUntouchedSeededBuiltinsInPlace} and stay deletable.
 * Seeds disabled; the connector's toggle runs the auth/connect step.
 */
export function catalogConfigForAdd(id: string): McpServerConfig | undefined {
    const entry = getCatalogEntry(id);
    if (!entry) return undefined;
    if (entry.kind === 'stdio') {
        // Base stdio shell; the org positional and the PAT are added by the
        // guided setup, then persisted to the device-local store (FEAT-04-13).
        return {
            type: 'stdio',
            command: entry.command,
            args: [...(entry.args ?? [])],
            timeout: 60,
            disabled: true,
        };
    }
    const isOAuth = entry.authClass !== 'none';
    return {
        type: entry.transport ?? 'streamable-http',
        url: entry.url,
        timeout: 60,
        disabled: true,
        ...(isOAuth ? { authType: 'oauth' as const } : {}),
    };
}

/** A built-in seed the user never engaged with: still off, never authorized. */
function isUntouchedSeed(cfg: McpServerConfig): boolean {
    if (cfg.disabled === false) return false;
    if (cfg.oauth?.tokens?.access_token) return false;
    const headers = cfg.headers ?? {};
    return !Object.values(headers).some((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Migration for the hidden-catalog model (ADR-156 revision): the catalog is no
 * longer seeded into the visible server list. Older installs carry seeded
 * catalog placeholders (`isBuiltIn`, still disabled, never authorized); remove
 * exactly those. Kept untouched: the permanent helpers in `keep` (icons8), any
 * built-in the user enabled or authorized, and every user-added server. Returns
 * true when something was removed.
 */
export function pruneUntouchedSeededBuiltinsInPlace(
    settings: { mcpServers?: Record<string, McpServerConfig> },
    keep: ReadonlySet<string>,
): boolean {
    const servers = settings.mcpServers;
    if (!servers) return false;
    let changed = false;
    for (const [name, cfg] of Object.entries(servers)) {
        if (cfg.isBuiltIn !== true) continue;
        if (keep.has(name)) continue;
        if (isUntouchedSeed(cfg)) {
            delete servers[name];
            changed = true;
        }
    }
    return changed;
}
