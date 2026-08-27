import { setTooltip } from 'obsidian';
import { cacheHitRate, formatTokensCompact } from '../../core/telemetry/TaskTelemetry';

export interface TelemetryFooterParams {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens?: number;
    costEur?: number;
    isSubscription?: boolean;
    time?: string;
}

/**
 * Render the assistant message telemetry footer as modern structured capsule pills (方案 2).
 * Formats token counts, cache hit rate, and time with high readability and fast tooltips.
 * Price is removed as requested by the user.
 */
export function renderTelemetryFooter(
    footerEl: HTMLElement,
    params: TelemetryFooterParams | string,
): void {
    footerEl.empty();
    footerEl.addClass('message-footer');

    if (typeof params === 'string') {
        renderLegacyFooterString(footerEl, params);
        return;
    }

    const t = params.time ?? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // 1. Time pill
    const timePill = footerEl.createSpan('mf-pill mf-time');
    timePill.setText(t);

    // 2. Tokens pill: ↑ 27.7k · ↓ 371
    const inCompact = formatTokensCompact(params.inputTokens);
    const outCompact = formatTokensCompact(params.outputTokens);
    const tokensPill = footerEl.createSpan('mf-pill mf-tokens');
    tokensPill.setText(`↑ ${inCompact} · ↓ ${outCompact}`);
    setTooltip(tokensPill, `输入: ${params.inputTokens.toLocaleString()} tokens\n输出: ${params.outputTokens.toLocaleString()} tokens`, { delay: 50, placement: 'top' });

    // 3. Cache pill (if cache read > 0 or hit rate > 0)
    const hit = cacheHitRate(params.inputTokens, params.cacheReadTokens, params.cacheCreationTokens ?? 0);
    if (params.cacheReadTokens > 0 || (hit !== null && hit > 0)) {
        const cachePill = footerEl.createSpan('mf-pill mf-cache');
        const hitStr = hit !== null ? `${hit}%` : '';
        cachePill.setText(`⚡ ${hitStr ? `${hitStr} 缓存` : `${formatTokensCompact(params.cacheReadTokens)} 缓存`}`);
        setTooltip(cachePill, `缓存读取: ${params.cacheReadTokens.toLocaleString()} tokens (${hit ?? 0}% 命中率)`, { delay: 50, placement: 'top' });
    }
}

function renderLegacyFooterString(footerEl: HTMLElement, raw: string): void {
    // Parse legacy string e.g. "11:40 · 27,663 in · 371 out · 24,960 cached · 47% hit · 0,0651 €"
    const timeMatch = raw.match(/\b\d{1,2}:\d{2}\b/);
    const inMatch = raw.match(/([\d,.]+)\s*in/i);
    const outMatch = raw.match(/([\d,.]+)\s*out/i);
    const cachedMatch = raw.match(/([\d,.]+)\s*cached/i);
    const hitMatch = raw.match(/(\d+)%\s*hit/i);

    if (timeMatch || inMatch || outMatch || cachedMatch || hitMatch) {
        if (timeMatch) {
            const timePill = footerEl.createSpan('mf-pill mf-time');
            timePill.setText(timeMatch[0]);
        }
        if (inMatch || outMatch) {
            const inVal = inMatch ? parseInt(inMatch[1].replace(/,/g, ''), 10) : 0;
            const outVal = outMatch ? parseInt(outMatch[1].replace(/,/g, ''), 10) : 0;
            const inCompact = !isNaN(inVal) && inVal > 0 ? formatTokensCompact(inVal) : (inMatch ? inMatch[1] : '0');
            const outCompact = !isNaN(outVal) && outVal > 0 ? formatTokensCompact(outVal) : (outMatch ? outMatch[1] : '0');
            const tokensPill = footerEl.createSpan('mf-pill mf-tokens');
            tokensPill.setText(`↑ ${inCompact} · ↓ ${outCompact}`);
            setTooltip(tokensPill, `输入: ${inMatch ? inMatch[1] : '0'} tokens\n输出: ${outMatch ? outMatch[1] : '0'} tokens`, { delay: 50, placement: 'top' });
        }
        if (cachedMatch || hitMatch) {
            const cachePill = footerEl.createSpan('mf-pill mf-cache');
            const hitText = hitMatch ? `${hitMatch[1]}%` : '';
            const cachedVal = cachedMatch ? parseInt(cachedMatch[1].replace(/,/g, ''), 10) : 0;
            const cachedCompact = !isNaN(cachedVal) && cachedVal > 0 ? formatTokensCompact(cachedVal) : (cachedMatch ? cachedMatch[1] : '');
            cachePill.setText(`⚡ ${hitText ? `${hitText} 缓存` : `${cachedCompact} 缓存`}`);
            setTooltip(cachePill, `缓存读取: ${cachedMatch ? cachedMatch[1] : '0'} tokens (${hitMatch ? `${hitMatch[1]}%` : ''})`, { delay: 50, placement: 'top' });
        }
    } else {
        const span = footerEl.createSpan('mf-pill');
        span.setText(raw);
    }
}
