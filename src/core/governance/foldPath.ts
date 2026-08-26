/**
 * foldPath -- one definition of "the same path" for every governance decision.
 *
 * AUDIT 2026-07-26 M-2 introduced an NFKC + uppercase-roundtrip fold in
 * IgnoreService because pattern matching was case-sensitive on case-insensitive
 * filesystems. The follow-up finding (P3, NFD bypass) showed the fold was not
 * applied to every comparison in that same file, and that agentFolderGuard used
 * a plain `.toLowerCase()` instead. Three slightly different notions of
 * sameness across two files that guard the same deny zone is how a bypass
 * survives a fix: the audit checks the one comparison it read.
 *
 * Two properties matter:
 *
 * - `normalize('NFKC')` collapses Unicode representations that name the same
 *   file. A decomposed "u + combining diaeresis" and a precomposed "u-umlaut"
 *   are one file on disk; without normalisation one spelling matches a rule and
 *   the other walks past it.
 * - The uppercase round trip is load-bearing. NTFS and exFAT fold via
 *   uppercase, so `U+0131` (dotless i) and friends only fold correctly this
 *   way; `.toLowerCase()` alone gets them wrong.
 *
 * Deliberately NOT a path canonicaliser: it does not touch separators, `.` or
 * `..`. Segment handling lives in IgnoreService.normalize, which preserves `..`
 * on purpose so the fail-closed traversal check can still see it.
 */

/** Case- and Unicode-folded form of `s`, for comparing two paths for sameness. */
export function foldPath(s: string): string {
    return (s ?? '').normalize('NFKC').toUpperCase().toLowerCase();
}
