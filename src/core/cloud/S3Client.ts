/**
 * S3Client -- minimal S3-compatible object storage client.
 *
 * Talks to any S3-compatible endpoint (AWS S3, Cloudflare R2, MinIO,
 * Aliyun OSS S3-compat gateway, Backblaze B2, ...). Two addressing styles:
 *   - path-style:    {endpoint}/{bucket}/{key}      (default; OSS/MinIO/R2/AWS)
 *   - virtual-host:  https://{bucket}.{endpoint-host}/{key}
 *
 * Tencent COS refuses path-style access outright (HTTP 403
 * PathStyleDomainForbidden), so the client auto-switches to virtual-host
 * addressing when the endpoint host is a myqcloud.com domain. An explicit
 * `addressStyle` in the config wins over the auto-detection.
 *
 * Signing: AWS Signature V4 over the real body hash (sent both in the
 * canonical request and the x-amz-content-sha256 request header), matching
 * what the AWS SDK v3 S3 client sends for regular PutObject calls.
 *
 * Transport: Obsidian's requestUrl (review-bot compliant -- no fetch()).
 * Crypto: node createHmac/createHash via require('crypto'), matching the
 * pattern used by sha256.ts / ChatGptOAuthService.ts (Electron renderer).
 */

import { requestUrl } from 'obsidian';

/* eslint-disable @typescript-eslint/no-require-imports -- Node crypto builtin for SigV4 HMAC; runtime built-in, not an external dep (same tolerated exception as sha256.ts). */
const nodeCrypto = require('crypto') as typeof import('crypto');
/* eslint-enable @typescript-eslint/no-require-imports */

export type S3AddressStyle = 'path' | 'virtual';

export interface S3ClientConfig {
    /** e.g. https://s3.eu-central-1.amazonaws.com or an R2/OSS/MinIO endpoint */
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Overrides the host-based auto-detection (myqcloud.com => virtual). */
    addressStyle?: S3AddressStyle;
}

export interface S3ObjectSummary {
    key: string;
    size: number;
    lastModifiedMs: number;
}

function sha256Hex(payload: string): string {
    return nodeCrypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Hex SHA256 over the exact request body (empty string when no body). */
function sha256HexOfBody(body?: ArrayBuffer | string): string {
    const h = nodeCrypto.createHash('sha256');
    if (body instanceof ArrayBuffer) h.update(Buffer.from(new Uint8Array(body)));
    else if (typeof body === 'string') h.update(body, 'utf8');
    return h.digest('hex');
}

function hmacSha256(key: Buffer | string, payload: string): Buffer {
    return nodeCrypto.createHmac('sha256', key).update(payload, 'utf8').digest();
}

/**
 * RFC 3986 encoding used by SigV4 canonical query strings and keys in URLs
 * (encodeURIComponent leaves !'()* unescaped; SigV4 requires them escaped).
 */
function rfc3986Encode(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
    );
}

/** Encode an object key for a URL path -- keeps `/` as separator. */
function encodeKeyPath(key: string): string {
    return key.split('/').map(rfc3986Encode).join('/');
}

interface SignedRequestUrl {
    /** The URL to hand to requestUrl (already percent-encoded). */
    url: string;
    host: string;
    amzDate: string;
    dateStamp: string;
    /** Value for the x-amz-content-sha256 request header (= signed value). */
    payloadHash: string;
    canonicalRequestHashTarget: string;
}

export class S3Client {
    constructor(private cfg: S3ClientConfig) {}

    // ── Public API ─────────────────────────────────────────────────────────

    async putObject(key: string, body: ArrayBuffer | string, contentType: string): Promise<void> {
        const res = await this.send('PUT', key, body, contentType);
        if (res.status >= 400) throw new Error(`S3Client putObject ${key}: HTTP ${res.status}`);
    }

    async getObject(key: string): Promise<ArrayBuffer> {
        const res = await this.send('GET', key);
        if (res.status === 404) throw new Error(`S3Client: object not found: ${key}`);
        if (res.status >= 400) throw new Error(`S3Client getObject ${key}: HTTP ${res.status}`);
        return res.arrayBuffer;
    }

    async deleteObject(key: string): Promise<void> {
        const res = await this.send('DELETE', key);
        // 204 on success; 404 is treated as success (idempotent delete).
        if (res.status >= 400 && res.status !== 404) {
            throw new Error(`S3Client deleteObject ${key}: HTTP ${res.status}`);
        }
    }

    /**
     * List all objects under a prefix (paginated ListObjectsV2).
     * Returns [] when the prefix does not exist.
     */
    async listObjects(prefix: string): Promise<S3ObjectSummary[]> {
        const out: S3ObjectSummary[] = [];
        let continuationToken: string | null = null;
        do {
            const query = new Map<string, string>([
                ['list-type', '2'],
                ['prefix', prefix],
            ]);
            if (continuationToken) query.set('continuation-token', continuationToken);
            const res = await this.send('GET', '', undefined, undefined, query);
            if (res.status >= 400) throw new Error(`S3Client listObjects: HTTP ${res.status}`);
            const parsed = parseListV2Xml(new TextDecoder().decode(res.arrayBuffer));
            out.push(...parsed.objects);
            continuationToken = parsed.nextContinuationToken;
        } while (continuationToken);
        return out;
    }

    /** Cheap connectivity check: lists up to one object at the bucket root. */
    async testConnection(): Promise<void> {
        const res = await this.send('GET', '', undefined, undefined, new Map([['list-type', '2']]));
        if (res.status >= 400) {
            // S3 error bodies carry a machine-readable <Code> (AccessDenied,
            // SignatureDoesNotMatch, ...) -- surface it for diagnosis.
            const body = new TextDecoder().decode(res.arrayBuffer);
            const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
            const msg = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
            throw new Error(
                `HTTP ${res.status}` +
                (code ? ` — ${code}` : '') +
                (msg ? `: ${msg}` : ''),
            );
        }
    }

    // ── Signing + transport ────────────────────────────────────────────────

    private async send(
        method: 'PUT' | 'GET' | 'DELETE',
        key: string,
        body?: ArrayBuffer | string,
        contentType?: string,
        query?: Map<string, string>,
    ): Promise<{ status: number; arrayBuffer: ArrayBuffer }> {
        // SigV4: every signed header must physically travel with the request.
        const payloadHash = sha256HexOfBody(body);
        const signed = this.buildSignedUrl(method, key, query, payloadHash);

        const headers: Record<string, string> = {
            Authorization: this.authorizationHeader(signed),
            'x-amz-date': signed.amzDate,
            'x-amz-content-sha256': payloadHash,
        };
        if (contentType) headers['Content-Type'] = contentType;

        const res = await requestUrl({
            url: signed.url,
            method,
            headers,
            body,
            throw: false,
        });
        return { status: res.status, arrayBuffer: res.arrayBuffer };
    }

    /**
     * Builds the request URL plus every value needed to compute the
     * Authorization header afterwards. Kept separate from the send call so
     * the pure signing math stays unit-testable without network I/O.
     */
    private buildSignedUrl(
        method: 'PUT' | 'GET' | 'DELETE',
        key: string,
        query: Map<string, string> | undefined,
        payloadHash: string,
    ): SignedRequestUrl {
        const endpoint = this.cfg.endpoint.replace(/\/+$/, '');
        const parsed = parseEndpoint(endpoint);
        const style = resolveAddressStyle(parsed.host, this.cfg.addressStyle);
        // Virtual-host style moves the bucket into the host; the bucket
        // owns the whole domain so no path prefix remains.
        const host = style === 'virtual' ? `${this.cfg.bucket}.${parsed.host}` : parsed.host;
        const now = new Date();
        const amzDate =
            now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
        const dateStamp = amzDate.slice(0, 8);

        const canonicalQuery = [...(query ?? new Map<string, string>())]
            .map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(v)] as const)
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
            .map(([k, v]) => `${k}=${v}`)
            .join('&');

        const canonicalUri =
            style === 'virtual'
                ? (key ? '/' + encodeKeyPath(key) : '/')
                : `/${this.cfg.bucket}${key ? '/' + encodeKeyPath(key) : ''}`;

        // The exact target URL sent over the wire.
        const wireUrl = `https://${host}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`;

        // Canonical request (SigV4 spec §Canonical Request):
        //   Method \n CanonicalURI \n CanonicalQuery \n CanonicalHeaders \n SignedHeaders \n HashedPayload
        // Path-style: Host header is endpoint-only and the bucket lives in
        // the URI. Virtual-host: the bucket is part of the signed Host.
        // The payload hash is the real SHA256 of the body (empty-body hash
        // for body-less requests) -- the same value sent in the
        // x-amz-content-sha256 request header.
        const canonicalHeaders =
            `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
        const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
        const canonicalRequest = [
            method,
            canonicalUri,
            canonicalQuery,
            canonicalHeaders,
            signedHeaders,
            payloadHash,
        ].join('\n');

        return {
            url: wireUrl,
            host,
            amzDate,
            dateStamp,
            payloadHash,
            canonicalRequestHashTarget: canonicalRequest,
        };
    }

    private authorizationHeader(signed: SignedRequestUrl): string {
        const scope = `${signed.dateStamp}/${this.cfg.region}/s3/aws4_request`;
        const stringToSign = [
            'AWS4-HMAC-SHA256',
            signed.amzDate,
            scope,
            sha256Hex(signed.canonicalRequestHashTarget),
        ].join('\n');

        const kDate = hmacSha256(`AWS4${this.cfg.secretAccessKey}`, signed.dateStamp);
        const kRegion = hmacSha256(kDate, this.cfg.region);
        const kService = hmacSha256(kRegion, 's3');
        const kSigning = hmacSha256(kService, 'aws4_request');

        const signature = nodeCrypto.createHmac('sha256', kSigning)
            .update(stringToSign, 'utf8')
            .digest('hex');

        return (
            `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, ` +
            `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`
        );
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract scheme + host from an endpoint like "https://s3.region.amazonaws.com". */
function parseEndpoint(endpoint: string): { scheme: string; host: string } {
    const m = /^(https?):\/\/([^/?#]+)/i.exec(endpoint);
    if (!m) throw new Error(`S3Client: invalid endpoint URL: ${endpoint}`);
    return { scheme: m[1], host: m[2].toLowerCase() };
}

/**
 * Addressing style for a request. Tencent COS rejects path-style access
 * outright (PathStyleDomainForbidden), so myqcloud.com endpoints force
 * virtual-host addressing unless explicitly overridden by config.
 */
export function resolveAddressStyle(host: string, explicit?: S3AddressStyle): S3AddressStyle {
    if (explicit) return explicit;
    return /(^|\.)myqcloud\.com$/.test(host) ? 'virtual' : 'path';
}

/**
 * Parse the minimal subset of ListObjectsV2 XML we need. A tiny regex-based
 * extraction keeps the bundle free of a full XML parser dependency; the
 * response shape from every S3-compatible service is stable.
 */
export function parseListV2Xml(xml: string): {
    objects: S3ObjectSummary[];
    nextContinuationToken: string | null;
} {
    const objects: S3ObjectSummary[] = [];
    const contentRe = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match: RegExpExecArray | null;
    while ((match = contentRe.exec(xml)) !== null) {
        const block = match[1];
        const key = extractTag(block, 'Key');
        if (key === null || key === '') continue;
        const sizeStr = extractTag(block, 'Size') ?? '0';
        const lastModified = extractTag(block, 'LastModified');
        const size = Number.parseInt(sizeStr, 10);
        objects.push({
            key,
            size: Number.isFinite(size) ? size : 0,
            lastModifiedMs: lastModified ? Date.parse(lastModified) : 0,
        });
    }
    const nextContinuationToken = extractTag(xml, 'NextContinuationToken');
    return { objects, nextContinuationToken };
}

function extractTag(block: string, tag: string): string | null {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
    if (!m) return null;
    return decodeXmlEntities(m[1]);
}

function decodeXmlEntities(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}
