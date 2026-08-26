/**
 * safeRegex — ReDoS-safe regex construction
 *
 * Creates a RegExp from a user/LLM-supplied pattern string, falling back to
 * a literal (escaped) match when the pattern is too complex, too long, or
 * syntactically invalid.
 *
 * Extracted from SearchFilesTool (K-2 / S-02) so every call-site that builds
 * a RegExp from untrusted input can reuse the same protection.
 */

/** Escape all regex metacharacters so the string matches literally. */
export function literalEscape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detects catastrophic backtracking constructs:
 *  - (…)+ / (…)*   — group followed by quantifier
 *  - […]**         — char-class with double quantifier
 *  - (a|b|…)+      — alternation inside quantified group
 */
const REDOS_PATTERNS = /(\(.*\))[+*]{1,}|(\[.*\])[+*]{2,}|(\w+\|)+\w+[+*]/;

/**
 * A closing group paren immediately followed by a quantifier (`+`, `*`, `{n,m}`).
 * Combined with a `|` somewhere in the pattern this flags "alternation under a
 * quantifier", the ReDoS family `(a|aa){1,32}` / `((a|aa)){1,25}` etc.
 *
 * AUDIT 2026-07-14 (Codex M-6 + review): the previous `\([^()]*\|...\)` form
 * only matched a FLAT alternation group, so one extra paren layer
 * (`((a|aa)){1,25}`) bypassed it and froze a single `exec()` for seconds. This
 * paren-agnostic check catches nested groups too. It conservatively also flags
 * benign non-overlapping alternations (`(a|b){2}`), which then fall back to a
 * literal match — the safe default for untrusted/LLM-supplied patterns. A
 * linear-time engine (re2) would remove the need for pattern-sniffing entirely
 * and is the proper follow-up.
 */
const QUANTIFIED_GROUP = /\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/;

/**
 * Nested quantification: an inner quantifier (`+`, `*`, `?`, `}` closing a
 * `{n,m}`) sitting immediately before a group close that is itself followed by
 * an outer quantifier — the classic `(a+){12}` / `(a*){12}` / `([a-z]+){12}` /
 * `(a{1,12}){1,12}` catastrophic family.
 *
 * AUDIT 2026-07-14 (Codex re-review): the alternation check
 * (`includes('|') && QUANTIFIED_GROUP`) missed these because they carry no `|`;
 * `(a+){12}` froze a single exec() for 40+ seconds. This detector is unconditional
 * (no `|` guard) yet still leaves a plain `(abc)+` / `(abc){2}` — where the char
 * before `)` is not a quantifier — as a real regex, so it does NOT over-reject the
 * common non-nested case.
 */
const NESTED_QUANTIFIER = /[+*?}]\)\s*(?:[+*]|\{\d)/;

/**
 * Grouping-free catastrophic classes the paren-based detectors miss
 * (Codex re-review 2): sequential open-ended quantifiers on the SAME atom
 * (`a*a*`, `.*.*`, `\d*\d*` -- froze exec() for MINUTES) and a wildcard group
 * under a bounded quantifier (`(.*a){20}`).
 *
 * IMPORTANT: syntactic ReDoS detection is a blocklist and is inherently NOT
 * exhaustive -- a determined pattern can still find a shape that slips through.
 * The correct long-term fix is a linear-time engine (re2js) or running the match
 * in a worker with a hard timeout. Tracked as the safeRegex follow-up.
 */
const SEQUENTIAL_OVERLAP = /(\\?.)[*+]\1[*+]|\(\.[*+][^)]*\)\s*(?:[+*]|\{\d)/;

/** Max pattern length before treating as literal. */
const MAX_PATTERN_LENGTH = 500;

/**
 * Static (syntactic) ReDoS blocklist. Fast and synchronous, but inherently
 * incomplete -- see FIX-01-04-03 and the dynamic probe in regexSafetyProbe.ts.
 */
export function isPatternComplex(pattern: string): boolean {
    return (
        pattern.length > MAX_PATTERN_LENGTH ||
        // Nested quantifiers, possessive constructs, high repetition counts
        /(\(\?[=!<]|(\+|\*|\?)(\+|\?)|\{\d{3,}\})/.test(pattern) ||
        REDOS_PATTERNS.test(pattern) ||
        // Alternation under a quantifier, nested parens included (M-6).
        (pattern.includes('|') && QUANTIFIED_GROUP.test(pattern)) ||
        // Nested quantifiers `(a+){12}` — no alternation needed (M-6 re-review).
        NESTED_QUANTIFIER.test(pattern) ||
        // Sequential same-atom quantifiers `a*a*` / wildcard group (M-6 re-review 2).
        SEQUENTIAL_OVERLAP.test(pattern)
    );
}

/**
 * Build a safe RegExp.  Returns a literal-match regex when the input looks
 * like it could trigger catastrophic backtracking or exceeds length limits.
 *
 * This is the SYNCHRONOUS best-effort guard. For untrusted patterns matched
 * against arbitrary-length content on the main thread, prefer the asynchronous
 * `safeRegexChecked` (regexSafetyProbe.ts), which additionally MEASURES the
 * pattern's runtime in a terminable worker and defeats blocklist gaps.
 *
 * @param pattern  Raw pattern string (may come from LLM, frontmatter, user input)
 * @param flags    Optional regex flags (e.g. 'gi')
 */
export function safeRegex(pattern: string, flags?: string): RegExp {
    if (isPatternComplex(pattern)) {
        return new RegExp(literalEscape(pattern), flags);
    }

    try {
        return new RegExp(pattern, flags);
    } catch {
        return new RegExp(literalEscape(pattern), flags);
    }
}
