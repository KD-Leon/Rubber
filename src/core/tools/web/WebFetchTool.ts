/**
 * WebFetchTool - Fetch a URL and return readable content.
 *
 * The SSRF guard and the redirect-safe node:http transport now live in
 * ./ssrfGuard (shared with clip_web_page). Obsidian's requestUrl is deliberately
 * NOT used, because it follows redirects internally without an exposed cap,
 * which would defeat per-hop validation. HTML is converted to Markdown via the
 * shared ./htmlToMarkdown. Adapted from Kilo Code's UrlContentFetcher pattern.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
// AUDIT 2026-07-14 (Codex) M-7: response body cap shared with SandboxBridge.
import { MAX_RESPONSE_BYTES, parseContentLength, readCappedResponseBody } from '../../utils/httpBodyCap';
// Extracted so clip_web_page reuses the exact same converter + guard chain (no drift).
import { htmlToMarkdown } from './htmlToMarkdown';
import { feedToToc, looksLikeFeed } from './feedToToc';
import { guardUrl, fetchWithRedirectGuard, isPrivateIP, hasInternalSuffix } from './ssrfGuard';

// Re-export so existing importers (and the M-7 / SSRF regression tests) keep
// resolving these from WebFetchTool.
export { MAX_RESPONSE_BYTES, parseContentLength, readCappedResponseBody };
export { isPrivateIP, hasInternalSuffix };

interface WebFetchInput {
    url: string;
    maxLength?: number;
    startIndex?: number;
}

export class WebFetchTool extends BaseTool<'web_fetch'> {
    readonly name = 'web_fetch' as const;
    readonly isWriteOperation = false;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'web_fetch',
            description:
                'Fetch a URL and return its content as readable text. Use for reading documentation, articles, APIs, or any public webpage. HTML is automatically converted to Markdown.',
            input_schema: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The URL to fetch (must start with http:// or https://).',
                    },
                    maxLength: {
                        type: 'number',
                        description:
                            'Maximum characters to return (default: 20000). Large pages are truncated.',
                    },
                    startIndex: {
                        type: 'number',
                        description:
                            'Start reading from this character offset (default: 0). Use with maxLength to paginate large pages.',
                    },
                },
                required: ['url'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { url, maxLength = 20000, startIndex = 0 } = input as unknown as WebFetchInput;
        const { callbacks } = context;

        if (!url) {
            callbacks.pushToolResult(this.formatError(new Error('url parameter is required')));
            return;
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            callbacks.pushToolResult(
                this.formatError(new Error('URL must start with http:// or https://'))
            );
            return;
        }

        // H-3 + M-2 + M-3 + L-5 + L-13 + L-14: Two-phase SSRF check, re-run on every redirect hop.
        // Phase 1 rejects obviously private hostnames + split-horizon suffixes (no DNS); Phase 2
        // resolves via the OS resolver and rejects any private IP (fail-closed on lookup failure).
        // fetchWithRedirectGuard re-validates every subsequent hop, closing the L-14 redirect bypass.
        const guardResult = await guardUrl(url);
        if (!guardResult.ok) {
            callbacks.pushToolResult(this.formatError(new Error(guardResult.reason)));
            return;
        }

        try {
            callbacks.log(`Fetching: ${url}`);

            const TIMEOUT_MS = 15_000;
            const response = await fetchWithRedirectGuard(url, { timeoutMs: TIMEOUT_MS, responseType: 'text' });

            const statusCode = response.status;

            if (statusCode >= 400) {
                callbacks.pushToolResult(
                    this.formatError(
                        new Error(`HTTP ${statusCode} error fetching ${url}`)
                    )
                );
                return;
            }

            const contentType = (response.headers['content-type'] ?? '').toLowerCase();
            let content: string;

            // M-4: Limit raw response size before HTML parsing to prevent ReDoS on
            // giant pages with complex regex patterns in htmlToMarkdown().
            const MAX_PARSE_BYTES = 2_000_000; // 2 MB
            const rawText = response.text ?? '';
            const safeText = rawText.length > MAX_PARSE_BYTES ? rawText.slice(0, MAX_PARSE_BYTES) : rawText;

            if (contentType.includes('text/html') || contentType === '') {
                content = htmlToMarkdown(safeText);
            } else if (looksLikeFeed(contentType, safeText)) {
                // FIX-24-03-09: a feed is a table of contents, and raw XML is
                // the worst possible shape for one -- the <description> bulk
                // pushed every feed past the inline threshold and the agent
                // paged through 20000 characters to reach a list of titles.
                // Falls back to the raw text when nothing entry-shaped parses.
                content = feedToToc(safeText) ?? safeText;
            } else {
                // Plain text, JSON, etc.
                content = safeText;
            }

            // Apply pagination
            const totalLength = content.length;
            const slice = content.slice(startIndex, startIndex + maxLength);
            const truncated = startIndex + maxLength < totalLength;

            // AUDIT-034 L-15: wrap web body in the untrusted-content boundary
            // tag so the model treats fetched markup as data, not instructions.
            let body = slice;
            if (truncated) {
                body += `\n\n[Content truncated. Use startIndex=${startIndex + maxLength} to read more.]`;
            }
            const result = this.formatUntrustedContent('web', body, {
                url,
                status: String(statusCode),
                chars: String(totalLength),
            });

            callbacks.pushToolResult(result);
            callbacks.log(
                `Fetched ${url} — ${statusCode}, ${slice.length} chars returned${truncated ? ' (truncated)' : ''}`
            );
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
        }
    }
}
