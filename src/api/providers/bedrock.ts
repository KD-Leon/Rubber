/**
 * BedrockProvider -- LLM provider for Amazon Bedrock.
 *
 * Uses the unified Converse API (ConverseStreamCommand) so the same code path
 * works for Claude, Nova, Llama and Mistral models. Region support includes
 * eu-central-1 and other EU regions via cross-region inference profiles
 * (model IDs like `eu.anthropic.claude-sonnet-4-5-20250929-v1:0`).
 *
 * Two authentication modes:
 *   1. Bedrock API key (bearer token, simpler, recommended) -- uses the
 *      clientConfig.token + authSchemePreference: ['httpBearerAuth'] path.
 *      This is AWS's newer single-token credential, typically exported as
 *      AWS_BEARER_TOKEN_BEDROCK in other tools. Optional custom endpoint URL.
 *   2. IAM access key ID + secret access key (classic SigV4 signing), plus
 *      optional session token for AWS SSO / STS temporary credentials.
 *
 * Shape matches src/api/providers/anthropic.ts: emits our internal ApiStream
 * chunks (text, tool_use, usage) so the AgentTask conversation loop doesn't
 * need to know which provider is active.
 */

// FIX-PERF-13: convert SDK runtime imports to type-only at module
// top-level so the @aws-sdk bundle (~120 KB minified) does not land in
// main.js unless a user actually picks Bedrock. Runtime values are
// pulled in via the lazy loader below the type imports.
import type {
    BedrockRuntimeClient,
    ConverseStreamCommand as ConverseStreamCommandType,
    ConverseCommand as ConverseCommandType,
    BedrockRuntimeClientConfig,
} from '@aws-sdk/client-bedrock-runtime';
interface BedrockSdk {
    BedrockRuntimeClient: new (cfg: BedrockRuntimeClientConfig) => BedrockRuntimeClient;
    ConverseStreamCommand: typeof ConverseStreamCommandType;
    ConverseCommand: typeof ConverseCommandType;
}
let _bedrockSdkPromise: Promise<BedrockSdk> | null = null;
function getBedrockSdk(): Promise<BedrockSdk> {
    if (!_bedrockSdkPromise) {
        _bedrockSdkPromise = import('@aws-sdk/client-bedrock-runtime').then((m) => ({
            BedrockRuntimeClient: m.BedrockRuntimeClient,
            ConverseStreamCommand: m.ConverseStreamCommand,
            ConverseCommand: m.ConverseCommand,
        }));
    }
    return _bedrockSdkPromise;
}
interface SmithySdk {
    NodeHttpHandler: new () => unknown;
}
let _smithySdkPromise: Promise<SmithySdk> | null = null;
function getSmithySdk(): Promise<SmithySdk> {
    if (!_smithySdkPromise) {
        _smithySdkPromise = import('@smithy/node-http-handler').then((m) => ({
            NodeHttpHandler: m.NodeHttpHandler,
        }));
    }
    return _smithySdkPromise;
}
// FIX-PERF-13: NodeHttpHandler runtime use is gated behind getSmithySdk()
// (see top of file). Type-only retained import would still pull the
// module type definitions but no runtime; leave it out entirely.
import type { LLMProvider } from '../../types/settings';
import type {
    ApiHandler,
    ApiStream,
    MessageParam,
    ModelInfo,
} from '../types';
import type { ToolDefinition } from '../../core/tools/types';
import { validateProviderUrl } from './providerUrlGuard';
import { prepareBedrockConverseInput, parseBedrockConverseStream } from '../adapters/bedrockConverse';
import { getModelContextWindow } from '../../types/model-registry';


// IMP-41-03-03 / ADR-150: the Converse wire format (helpers, conversion,
// request construction, stream parsing) lives in ../adapters/bedrockConverse.
export { messagesHaveToolBlocks, stripToolBlocksForNoToolsCall } from '../adapters/bedrockConverse';

/**
 * Pull the region out of a Bedrock endpoint URL, e.g.
 * `https://bedrock-runtime.eu-central-1.amazonaws.com` -> `eu-central-1`.
 * Returns null if the URL does not match the expected AWS pattern.
 */
export function extractRegionFromBedrockUrl(url: string | undefined): string | null {
    if (!url) return null;
    const match = url.match(/^https?:\/\/(?:[^.]+\.)?([a-z]{2}-[a-z]+-\d+)\.amazonaws\.com/i);
    return match ? match[1].toLowerCase() : null;
}

/** FEAT-26-07 default header name when the user did not override it. */
const DEFAULT_GATEWAY_HEADER_NAME = 'Ocp-Apim-Subscription-Key';

/**
 * FEAT-26-07: pure helper. Strips AWS-signing headers (`Authorization`,
 * `X-Amz-*`) from the outgoing request and injects the configured gateway
 * subscription header. Case-insensitive against the request map.
 *
 * Exported so the contract is unit-testable without standing up the
 * full SDK middleware stack.
 */
export function applyGatewayHeaderTransform(
    request: { headers: Record<string, string> },
    headerName: string,
    headerValue: string,
): void {
    for (const key of Object.keys(request.headers)) {
        const lower = key.toLowerCase();
        if (lower === 'authorization' || lower.startsWith('x-amz-')) {
            delete request.headers[key];
        }
    }
    request.headers[headerName] = headerValue;
}

export class BedrockProvider implements ApiHandler {
    // FIX-PERF-13: client is built lazily on first send. Constructor
    // only validates the config so misconfiguration is still caught at
    // wire-up time without paying the SDK-import cost up front.
    private clientPromise: Promise<BedrockRuntimeClient> | null = null;
    private config: LLMProvider;

    constructor(config: LLMProvider) {
        this.config = config;

        // Default to bearer-token mode if not specified, since it's the recommended path.
        const authMode = config.awsAuthMode ?? 'api-key';

        // AUDIT-037 H-2: SSRF guard on config.baseUrl. The Bedrock SDK forwards
        // AWS credentials with every request, so a hostile endpoint walks off
        // with the API key or IAM secret. validateProviderUrl pins the host
        // to *.bedrock(-runtime).<region>.amazonaws.com and refuses metadata
        // hosts, private IPs and unmatched HTTPS targets.
        //
        // FEAT-26-07: in gateway mode the strict AWS allow-list is skipped so
        // enterprise APIM hosts can proxy the ConverseStream API. The standard
        // SSRF defenses (HTTPS-only, no metadata, no RFC1918) stay in force.
        if (config.baseUrl?.trim()) {
            validateProviderUrl('bedrock', config.baseUrl.trim(), {
                gatewayMode: authMode === 'gateway',
            });
        }

        // Gateway mode requires an explicit region -- the URL no longer
        // contains one. AWS modes can still fall back to parsing the URL.
        const region = authMode === 'gateway'
            ? (config.awsRegion?.trim() || '')
            : (config.awsRegion?.trim() || extractRegionFromBedrockUrl(config.baseUrl) || '');
        if (!region) {
            throw new Error('[Bedrock] awsRegion is required (e.g. eu-central-1) -- either pick a region or give an endpoint URL containing one');
        }

        // FIX-PERF-13: validate eagerly so wire-up errors surface
        // at construction, but defer client construction to first use.
        if (authMode === 'api-key' && !config.awsApiKey?.trim()) {
            throw new Error('[Bedrock] API key is required when authMode is api-key');
        }
        if (authMode === 'access-key') {
            if (!config.awsAccessKey?.trim() || !config.awsSecretKey?.trim()) {
                throw new Error('[Bedrock] awsAccessKey and awsSecretKey are required when authMode is access-key');
            }
        }
        if (authMode === 'gateway' && !config.gatewayHeaderValue?.trim()) {
            throw new Error('[Bedrock] gatewayHeaderValue is required when authMode is gateway');
        }
        // Region stash for getClient.
        this._resolvedRegion = region;
    }

    private _resolvedRegion = '';

    private getClient(): Promise<BedrockRuntimeClient> {
        if (this.clientPromise) return this.clientPromise;
        this.clientPromise = (async () => {
            const config = this.config;
            const authMode = config.awsAuthMode ?? 'api-key';
            const sdk = await getBedrockSdk();

            const clientConfig: BedrockRuntimeClientConfig = {
                region: this._resolvedRegion,
                ...(config.baseUrl?.trim() ? { endpoint: config.baseUrl.trim() } : {}),
            };
            if (authMode === 'gateway') {
                const smithy = await getSmithySdk();
                clientConfig.requestHandler = new smithy.NodeHttpHandler() as BedrockRuntimeClientConfig['requestHandler'];
            }
            if (authMode === 'api-key') {
                clientConfig.token = { token: config.awsApiKey!.trim() };
                clientConfig.authSchemePreference = ['httpBearerAuth'];
            } else if (authMode === 'access-key') {
                clientConfig.credentials = {
                    accessKeyId: config.awsAccessKey!.trim(),
                    secretAccessKey: config.awsSecretKey!.trim(),
                    ...(config.awsSessionToken ? { sessionToken: config.awsSessionToken.trim() } : {}),
                };
            } else {
                clientConfig.credentials = {
                    accessKeyId: 'vault-operator-gateway',
                    secretAccessKey: 'vault-operator-gateway',
                };
            }

            const client = new sdk.BedrockRuntimeClient(clientConfig);

            if (authMode === 'gateway') {
                const headerName = (config.gatewayHeaderName?.trim() || DEFAULT_GATEWAY_HEADER_NAME);
                const headerValue = config.gatewayHeaderValue!.trim();
                client.middlewareStack.add(
                    (next) => async (args) => {
                        const request = (args as { request?: { headers?: Record<string, string> } }).request;
                        if (request && request.headers) {
                            applyGatewayHeaderTransform(
                                request as { headers: Record<string, string> },
                                headerName,
                                headerValue,
                            );
                        }
                        return next(args);
                    },
                    {
                        step: 'finalizeRequest',
                        name: 'vault-operator-gateway-auth',
                        priority: 'low',
                    },
                );
            }
            return client;
        })();
        return this.clientPromise;
    }

    getModel(): { id: string; info: ModelInfo } {
        // Resolve the real window from the central registry. getModelContextWindow
        // normalizes the Bedrock-decorated id (region prefix + "-vN:M" suffix),
        // so "eu.anthropic.claude-opus-4-8-v1:0" maps to the 1M Opus floor
        // instead of a hardcoded 200k that condensed the loop far too early.
        return {
            id: this.config.model,
            info: {
                // ADR-158 stage 1: discovery-reported window wins
                contextWindow: this.config.contextWindow ?? getModelContextWindow(this.config.model),
                supportsTools: true,
                supportsStreaming: true,
            },
        };
    }

    async *createMessage(
        systemPrompt: string,
        messages: MessageParam[],
        tools: ToolDefinition[],
        abortSignal?: AbortSignal,
    ): ApiStream {
        const input = prepareBedrockConverseInput(this.config, systemPrompt, messages, tools);
        const sdk = await getBedrockSdk();
        const client = await this.getClient();
        const command = new sdk.ConverseStreamCommand(input);

        const response = await client.send(command, { abortSignal });
        if (!response.stream) {
            throw new Error('[Bedrock] Converse stream returned no body');
        }

        yield* parseBedrockConverseStream(response.stream, {
            model: this.config.model,
            cachingEnabled: this.config.promptCachingEnabled === true,
        });
    }

    /**
     * Quick non-streaming classification call for the skill matcher.
     * Uses ConverseCommand (no stream) to keep it cheap.
     */
    async classifyText(prompt: string, abortSignal?: AbortSignal, maxTokens = 50): Promise<string> {
        // No temperature: Opus 4.7+, Fable and Mythos reject any sampling
        // parameter with a ValidationException, and the direct Anthropic and
        // OpenAI classify paths omit it too. The classification is short and
        // deterministic enough without it.
        //
        // FIX-19-05-05: maxTokens ist jetzt parametrisiert. Default 50 fuer den
        // 1-Wort-Prefilter (yes/no/unsure); der Freshness-Verifier uebergibt
        // ~512, weil sein JSON-Urteil sonst mitten in der summary abgeschnitten
        // wird -> Parse-Fehler -> stiller FAIL_CLOSED.
        const sdk = await getBedrockSdk();
        const client = await this.getClient();
        const response = await client.send(
            new sdk.ConverseCommand({
                modelId: this.config.model,
                messages: [{ role: 'user', content: [{ text: prompt }] }],
                inferenceConfig: { maxTokens },
            }),
            { abortSignal },
        );

        const blocks = response.output?.message?.content ?? [];
        for (const block of blocks) {
            if (block.text) return block.text.trim();
        }
        return '';
    }

}
