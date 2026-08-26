/**
 * connectorSetupGuides -- non-technical, step-by-step guidance for connectors
 * that need a user-supplied token/API key (FEAT-04-11).
 *
 * The generic "add server" dialog only exposes a raw header field, which the
 * target audience cannot use. For known token-based servers, a guide tells the
 * user exactly which credential is needed, where to create it (a direct,
 * pre-scoped link), which permissions to grant, and how it maps onto the
 * request header. Keep entries first-party and accurate.
 */

/** A non-secret input collected before the credential (e.g. an org name).
 *  Each renders as a labeled field with its own "what / where to get it" hint.
 *  FEAT-04-13 Phase 1: the per-field guidance the setup wizard shows. */
export interface ConnectorSetupField {
    /** Stable key. For a stdio positional arg use `argPosition`; for an env
     *  var set `envName` on the guide and reference it here by key equality. */
    key: string;
    label: string;
    hint: string;
    placeholder?: string;
    /** stdio only: append this field's value to the launch args (positional,
     *  e.g. the Azure DevOps org). Order follows the fields[] array. */
    appendToArgs?: boolean;
}

export interface ConnectorSetupGuide {
    /** Matched by exact registry name and/or by endpoint host suffix. */
    match: { registryName?: string; host?: string };
    /** What the user needs, e.g. "a GitHub personal access token". */
    credentialName: string;
    /** Direct link where the user creates the credential (ideally pre-scoped). */
    createUrl: string;
    /** Plain-language permissions hint, e.g. "repo and workflow". */
    scopeHint?: string;
    /**
     * Where the secret goes. 'header' (default) = remote HTTP server, written
     * to `headerName`. 'env' = local stdio server, written to `envName` in
     * config.env (FEAT-04-13). */
    target?: 'header' | 'env';
    /** Request header the credential goes into (header target, e.g. "Authorization"). */
    headerName?: string;
    /** Prefix the value with "Bearer " before storing it (header target). */
    bearer?: boolean;
    /** Env var the secret goes into (env target, e.g. "AZURE_DEVOPS_EXT_PAT"). */
    envName?: string;
    /** stdio launch command (env target). Restricted to node/npx by spawnAllowlist. */
    command?: string;
    /** stdio base launch args (env target); field values with appendToArgs are added after. */
    args?: string[];
    /** Non-secret inputs collected before the secret, each with its own hint. */
    fields?: ConnectorSetupField[];
    /** Short ordered steps shown in the setup dialog. */
    steps: string[];
}

export const CONNECTOR_SETUP_GUIDES: ConnectorSetupGuide[] = [
    {
        match: { registryName: 'io.github.github/github-mcp-server', host: 'api.githubcopilot.com' },
        credentialName: 'GitHub personal access token',
        createUrl: 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Vault%20Operator',
        scopeHint: 'repo and workflow',
        target: 'header',
        headerName: 'Authorization',
        bearer: true,
        steps: [
            'Click "Get token" to open GitHub (the repo and workflow permissions are preselected).',
            'Scroll down and click "Generate token", then confirm.',
            'Copy the token GitHub shows once (starts with "ghp_") and paste it below.',
        ],
    },
    {
        // Local stdio server. Not in the public MCP registry, so it is reached
        // via the curated catalog id (Phase 2), matched here by that id.
        match: { registryName: 'azure-devops' },
        credentialName: 'an Azure DevOps personal access token (PAT)',
        createUrl: 'https://dev.azure.com/_usersSettings/tokens',
        scopeHint: 'Work Items (Read), Code (Read) and Build (Read)',
        target: 'env',
        envName: 'AZURE_DEVOPS_EXT_PAT',
        command: 'npx',
        args: ['-y', '@azure-devops/mcp'],
        fields: [
            {
                key: 'org',
                label: 'Organization name',
                hint: 'The short name in your Azure DevOps URL: dev.azure.com/<organization>. It is added to the launch command.',
                placeholder: 'your-org',
                appendToArgs: true,
            },
        ],
        steps: [
            'Open your Azure DevOps organization in a browser and read its name from the URL (dev.azure.com/<organization>). Enter it above.',
            'Click "Get token", then "New Token".',
            'Grant the scopes Work Items (Read), Code (Read) and Build (Read), set an expiry, and click Create.',
            'Copy the token shown once and paste it below. It is stored encrypted on this device and only passed to the local server.',
        ],
    },
];

/** Find a setup guide by registry name (preferred) or endpoint host. */
export function findSetupGuide(opts: { registryName?: string; url?: string }): ConnectorSetupGuide | undefined {
    let host = '';
    if (opts.url) {
        try { host = new URL(opts.url).hostname.toLowerCase(); } catch { host = ''; }
    }
    for (const guide of CONNECTOR_SETUP_GUIDES) {
        if (opts.registryName && guide.match.registryName === opts.registryName) return guide;
        if (host && guide.match.host && (host === guide.match.host || host.endsWith(`.${guide.match.host}`))) return guide;
    }
    return undefined;
}
