/**
 * feedToToc -- turn an RSS/Atom feed into the table of contents it is
 * (FIX-24-03-09).
 *
 * web_fetch converts HTML to markdown but hands XML through raw, so a feed
 * arrived as up to 20000 characters of `<item><title>…</title>
 * <description>…entire teaser or article…</description></item>`. The consumer
 * wants titles, links and dates: on the failing daily-briefing run of
 * 2026-08-21 the raw form pushed every feed past the 10k inline threshold,
 * and the agent paged one TechCrunch feed through five re-reads at 2000
 * characters each -- for a list it needed only to skim. Twenty-seven feeds
 * that way is the run's whole turn budget.
 *
 * The conversion is lossless in the only dimension that matters here: every
 * entry appears, with its link, instead of the first five drowning the rest.
 */

/** One feed entry, reduced to what a table of contents carries. */
interface FeedEntry {
    title: string;
    link: string;
    date: string;
}

function decodeEntities(s: string): string {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function firstTag(block: string, tag: string): string {
    // Attributes allowed on the opening tag; namespaced variants are matched
    // by the caller passing the exact local name it wants.
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
    return m ? decodeEntities(m[1]) : '';
}

/** Atom puts the URL in an attribute; RSS in the element body. */
function atomLink(block: string): string {
    const alt = /<link\b[^>]*\brel=["']?alternate["']?[^>]*\bhref=["']([^"']+)["']/i.exec(block)
        ?? /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(block);
    return alt ? decodeEntities(alt[1]) : '';
}

/**
 * True when the payload looks like an RSS or Atom feed. Content type first
 * (authoritative when the server sets it), sniffing as the fallback because
 * plenty of feeds are served as text/xml or application/xml.
 */
export function looksLikeFeed(contentType: string, text: string): boolean {
    const ct = contentType.toLowerCase();
    if (ct.includes('rss') || ct.includes('atom')) return true;
    if (!ct.includes('xml') && !ct.includes('text/plain') && ct !== '') return false;
    const head = text.slice(0, 2000);
    return /<rss\b/i.test(head) || /<feed\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(head)
        || /<rdf:RDF\b/i.test(head);
}

/**
 * Render a feed as a compact markdown list. Returns null when nothing
 * entry-shaped is found, so the caller can fall back to the raw text rather
 * than hand back an empty document.
 *
 * @param max hard cap on entries; a feed with hundreds still stays scannable.
 */
export function feedToToc(text: string, max = 60): string | null {
    const blocks = text.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
    if (blocks.length === 0) return null;

    const entries: FeedEntry[] = [];
    for (const block of blocks.slice(0, max)) {
        const title = firstTag(block, 'title');
        const link = firstTag(block, 'link') || atomLink(block);
        const date = firstTag(block, 'pubDate') || firstTag(block, 'published')
            || firstTag(block, 'updated') || firstTag(block, 'dc:date');
        if (!title && !link) continue;
        entries.push({ title: title || '(untitled)', link, date });
    }
    if (entries.length === 0) return null;

    const channel = firstTag(text.slice(0, 4000), 'title');
    const lines = entries.map((e) => {
        const when = e.date ? ` — ${e.date}` : '';
        return e.link ? `- [${e.title}](${e.link})${when}` : `- ${e.title}${when}`;
    });
    const more = blocks.length > entries.length
        ? `\n\n[${blocks.length - entries.length} further entries omitted]`
        : '';
    return `# ${channel || 'Feed'}\n\n${entries.length} entries:\n\n${lines.join('\n')}${more}\n`;
}
