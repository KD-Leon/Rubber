/**
 * AUTH-3: render only the RFC-6749 error fields (`error`, `error_description`)
 * from a provider response, falling back to key NAMES (never values), so a raw
 * response body -- which can echo a `device_code` or other sensitive value --
 * never lands in a thrown Error, a log line, or the LLM context. Mirrors the
 * allowlist pattern of ChatGptOAuthService.extractOAuthError for the device/
 * poll flows that previously did `JSON.stringify(data)`.
 */
export function safeOAuthErrorDetail(data: Record<string, unknown>): string {
    const err = typeof data.error === 'string' ? data.error : '';
    const desc = typeof data.error_description === 'string' ? data.error_description : '';
    if (err || desc) return [err, desc].filter(Boolean).join(': ');
    return `unexpected response (fields: ${Object.keys(data).join(', ') || 'none'})`;
}
