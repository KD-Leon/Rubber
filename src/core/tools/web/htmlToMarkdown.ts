/**
 * htmlToMarkdown -- dependency-free HTML -> Markdown converter.
 *
 * Extracted from WebFetchTool (which now imports it) so clip_web_page can reuse
 * the exact same conversion instead of keeping a drifting copy. The CWE-116
 * fixpoint tag-stripping and the entity-decode ordering are load-bearing
 * security properties -- see the inline notes; do not "simplify" the while-loops
 * into single passes.
 *
 * Unlike the original WebFetchTool copy, this version converts `<img>` tags to
 * markdown image links (`![alt](src)`) instead of stripping them. web_fetch now
 * surfaces images as readable links, and clip_web_page can find, download, and
 * rewrite them.
 */

import { parseImgTag } from './imageClipper';

export function htmlToMarkdown(html: string): string {
    let md = html;

    // Remove DOCTYPE, comments (loop to handle nested/reconstructed sequences)
    md = md.replace(/<!DOCTYPE[^>]*>/gi, '');
    while (/<!--[\s\S]*?-->/g.test(md)) {
        md = md.replace(/<!--[\s\S]*?-->/g, '');
    }

    // Remove <head> entirely (scripts, styles, meta)
    md = md.replace(/<head[\s\S]*?<\/head[^>]*>/gi, '');

    // Remove script and style blocks (loop to handle nested/reconstructed tags,
    // [^>]* in closing tag handles malformed end tags like </script \n bar>)
    while (/<script[\s\S]*?<\/script[^>]*>/gi.test(md)) {
        md = md.replace(/<script[\s\S]*?<\/script[^>]*>/gi, '');
    }
    while (/<style[\s\S]*?<\/style[^>]*>/gi.test(md)) {
        md = md.replace(/<style[\s\S]*?<\/style[^>]*>/gi, '');
    }
    md = md.replace(/<noscript[\s\S]*?<\/noscript[^>]*>/gi, '');

    // Remove nav, footer, aside, header — usually not main content
    md = md.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    md = md.replace(/<footer[\s\S]*?<\/footer>/gi, '');
    md = md.replace(/<aside[\s\S]*?<\/aside>/gi, '');

    // Block-level: headings
    md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
    md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
    md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
    md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
    md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
    md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

    // Block-level: paragraphs, divs, sections
    md = md.replace(/<\/p>/gi, '\n\n');
    md = md.replace(/<p[^>]*>/gi, '\n');
    md = md.replace(/<\/div>/gi, '\n');
    md = md.replace(/<div[^>]*>/gi, '\n');
    md = md.replace(/<\/section>/gi, '\n');
    md = md.replace(/<section[^>]*>/gi, '\n');
    md = md.replace(/<article[^>]*>/gi, '\n');
    md = md.replace(/<\/article>/gi, '\n');
    md = md.replace(/<main[^>]*>/gi, '\n');
    md = md.replace(/<\/main>/gi, '\n');

    // Lists
    md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
    md = md.replace(/<\/?[uo]l[^>]*>/gi, '\n');

    // Images: convert to markdown image links BEFORE the generic tag strip so
    // the src survives (WebFetchTool used to drop these). The src is emitted
    // raw; the entity-decode pass below normalises &amp; consistently with
    // imageClipper.resolveImageUrl, so the download work-list and the rewrite
    // resolve to the same absolute URLs. srcset is folded to its largest
    // candidate inside parseImgTag. The tokenizer is quote-aware -- it consumes
    // whole quoted attribute values -- so a literal '>' inside alt/title text
    // (e.g. alt="revenue > costs") does not truncate the tag, drop the image, or
    // leak raw attribute text into the archived note.
    //
    // ReDoS SAFETY (AUDIT 2026-07-31 H-1): the third alternative is [^"'>], NOT
    // [^>]. Excluding the quote chars makes the three alternatives mutually
    // exclusive, so a run of quote characters has exactly one parse and the match
    // is linear. With [^>] a quote could be consumed either by the quoted-string
    // group or by the char class -- an ambiguity that backtracks exponentially on
    // an unterminated tag (`<img ` + N quotes with no closing '>'): ~60 bytes
    // froze the renderer thread for minutes. htmlToMarkdown runs on attacker-
    // served HTML via BOTH web_fetch and clip_web_page, so the guard matters for
    // both. Verified linear to N=1e6 (~5 ms) while still matching alt-with-'>'.
    md = md.replace(/<img\b(?:"[^"]*"|'[^']*'|[^"'>])*>/gi, (tag) => {
        const { src, alt } = parseImgTag(tag);
        return src ? `\n![${alt}](${src})\n` : '';
    });

    // Inline: links
    md = md.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
    md = md.replace(/<a[^>]+href='([^']*)'[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
    // Links without href
    md = md.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');

    // Inline: emphasis
    md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, '**$2**');
    md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, '*$2*');

    // Inline: code
    md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
    md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

    // Line breaks
    md = md.replace(/<br\s*\/?>/gi, '\n');
    md = md.replace(/<hr\s*\/?>/gi, '\n---\n');

    // Tables (simplified)
    md = md.replace(/<th[^>]*>([\s\S]*?)<\/th>/gi, '| $1 ');
    md = md.replace(/<td[^>]*>([\s\S]*?)<\/td>/gi, '| $1 ');
    md = md.replace(/<\/tr>/gi, '|\n');
    md = md.replace(/<[^>]*(tr|table|thead|tbody|tfoot)[^>]*>/gi, '\n');

    // Final safety pass: remove any script/style fragments that survived conversion
    // Use while-loops to handle nested/reconstructed fragments like <scr<script>ipt> (CWE-116)
    while (/<\/?script[^>]*>/gi.test(md)) {
        md = md.replace(/<\/?script[^>]*>/gi, '');
    }
    while (/<\/?style[^>]*>/gi.test(md)) {
        md = md.replace(/<\/?style[^>]*>/gi, '');
    }

    // Strip ALL remaining HTML tags in a loop until stable (CWE-116 / CodeQL #50)
    // A single pass can miss tags reconstructed from nested fragments.
    {
        let prev: string;
        do {
            prev = md;
            md = md.replace(/<[^>]+>/g, '');
        } while (md !== prev);
    }

    // Decode common HTML entities (&amp; last to prevent double-unescaping)
    md = md.replace(/&lt;/g, '<');
    md = md.replace(/&gt;/g, '>');
    md = md.replace(/&quot;/g, '"');
    md = md.replace(/&#39;/g, "'");
    md = md.replace(/&nbsp;/g, ' ');
    md = md.replace(/&mdash;/g, '—');
    md = md.replace(/&ndash;/g, '–');
    md = md.replace(/&hellip;/g, '...');
    md = md.replace(/&amp;/g, '&');
    md = md.replace(/&#(\d+);/g, (_m: string, code: string) => String.fromCharCode(parseInt(code, 10)));
    md = md.replace(/&#x([0-9a-f]+);/gi, (_m: string, code: string) =>
        String.fromCharCode(parseInt(code, 16))
    );

    // Post-decode safety: entity decoding may reconstruct HTML tags (CodeQL #53)
    // Remove dangerous tags first, then strip all remaining tags until stable.
    while (/<\/?script[^>]*>/gi.test(md)) {
        md = md.replace(/<\/?script[^>]*>/gi, '');
    }
    while (/<\/?style[^>]*>/gi.test(md)) {
        md = md.replace(/<\/?style[^>]*>/gi, '');
    }
    {
        let prev: string;
        do {
            prev = md;
            md = md.replace(/<[^>]+>/g, '');
        } while (md !== prev);
    }

    // Collapse excessive blank lines (max 2 in a row)
    md = md.replace(/\n{3,}/g, '\n\n');

    // Trim leading/trailing whitespace on each line
    md = md
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n');

    return md.trim();
}
