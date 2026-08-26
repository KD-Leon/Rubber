/**
 * McpOAuthProvider -- OAuth 2.1 client provider for outbound MCP connectors.
 *
 * Implements the MCP SDK `OAuthClientProvider` interface (ADR-154). The SDK's
 * StreamableHTTPClientTransport drives the whole flow (discovery, dynamic
 * client registration, PKCE, refresh) and calls back into this provider to
 * load/store client registration + tokens, obtain a redirect target, and open
 * the browser. Redirect capture is a fixed `obsidian://` handler validated by
 * OAuth state (ADR-155); token persistence is delegated to McpClient callbacks
 * so the secret fields land in the encrypted settings pass.
 *
 * This provider is intentionally I/O-free: browser opening, persistence, and
 * randomness are injected so the class is unit-testable and stays out of
 * Electron/crypto imports.
 *
 * Wayfinder: src/ARCHITECTURE.map concept `mcp-oauth`.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientMetadata,
    OAuthClientInformationFull,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpOAuthSession } from '../../types/settings';

/** The single redirect URI registered for every OAuth MCP connector. */
export const MCP_OAUTH_REDIRECT_URI = 'obsidian://vault-operator-mcp-oauth';

export interface McpOAuthProviderDeps {
    /** Loads the persisted session for this server (plaintext, post-decrypt). */
    loadSession: () => McpOAuthSession | undefined;
    /** Persists a session patch for this server; secret fields are encrypted on save. */
    saveSession: (patch: McpOAuthSession) => void | Promise<void>;
    /** Opens the authorization URL in the user's external browser. */
    openBrowser: (url: string) => void | Promise<void>;
    /** Generates a random URL-safe state value. */
    randomState: () => string;
}

export class McpOAuthProvider implements OAuthClientProvider {
    private _state: string;
    private _codeVerifier?: string;
    /**
     * Whether the connect in flight was started BY THE USER. Defaults to false
     * so an automatic connect can never open a browser window; see
     * redirectToAuthorization.
     */
    private _interactive = false;

    constructor(private readonly deps: McpOAuthProviderDeps) {
        this._state = deps.randomState();
    }

    /**
     * Start a fresh authorization attempt: regenerate the state and drop any
     * stale in-memory code verifier so a previous flow's state cannot be
     * replayed against this one.
     */
    beginAuth(): void {
        this._state = this.deps.randomState();
        this._codeVerifier = undefined;
    }

    /** The state value McpClient maps to this server's pending flow. */
    getState(): string {
        return this._state;
    }

    get redirectUrl(): string {
        return MCP_OAUTH_REDIRECT_URI;
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: 'Vault Operator',
            redirect_uris: [MCP_OAUTH_REDIRECT_URI],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        };
    }

    state(): string {
        return this._state;
    }

    clientInformation(): OAuthClientInformationFull | undefined {
        return this.deps.loadSession()?.clientInformation as OAuthClientInformationFull | undefined;
    }

    async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
        await this.deps.saveSession({ clientInformation: info });
    }

    tokens(): OAuthTokens | undefined {
        return this.deps.loadSession()?.tokens as OAuthTokens | undefined;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        await this.deps.saveSession({ tokens });
    }

    /**
     * Marks whether the CURRENT connect attempt may open a browser. Set per
     * connect by McpClient, defaulting to false, so the decision is re-made
     * every time instead of lingering from an earlier flow.
     */
    setInteractive(interactive: boolean): void {
        this._interactive = interactive;
    }

    /**
     * The SDK calls this for any authorization it cannot complete silently --
     * including the boot connect, where a stale token yields a 401 and the
     * refresh does not produce usable tokens.
     *
     * Opening the system browser there means a plugin reload spawns a login
     * page the user never asked for, so the browser is opened ONLY when the
     * user explicitly started an authorization (McpClient.authorize). On an
     * automatic connect we return without opening anything: the SDK then
     * reports REDIRECT, the transport raises UnauthorizedError, and McpClient
     * puts the server into 'awaiting-auth', which the MCP settings tab already
     * renders with an Authorize action. Nothing is lost, the user just decides
     * when the login happens.
     */
    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        if (!this._interactive) {
            console.debug(
                '[McpOAuth] Authorization required, but this connect was automatic. ' +
                'Not opening a browser; the server is marked awaiting-auth.',
            );
            return;
        }
        await this.deps.openBrowser(authorizationUrl.toString());
    }

    saveCodeVerifier(codeVerifier: string): void {
        this._codeVerifier = codeVerifier;
    }

    codeVerifier(): string {
        if (!this._codeVerifier) {
            throw new Error('No PKCE code verifier for this session; restart the authorization.');
        }
        return this._codeVerifier;
    }

    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
        if (scope === 'verifier' || scope === 'all') this._codeVerifier = undefined;
        if (scope === 'tokens' || scope === 'all') await this.deps.saveSession({ tokens: undefined });
        if (scope === 'client' || scope === 'all') await this.deps.saveSession({ clientInformation: undefined });
    }
}
