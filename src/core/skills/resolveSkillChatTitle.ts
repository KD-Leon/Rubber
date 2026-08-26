/**
 * resolveSkillChatTitle -- expands a skill's optional `chatTitle` frontmatter
 * template into a concrete conversation title.
 *
 * FIX-03-20-02 (title aspect): skills whose intent is always the same (e.g.
 * `/plaud-meeting-delta-ingest` -- "fetch the new Plaud transcripts") produce
 * identical LLM titles, so their chats are indistinguishable in History. Such
 * a skill declares `chatTitle: "Plaud {date}"` and gets a deterministic,
 * date-stamped title instead. Opt-in: skills without the field keep the normal
 * intent-/content-based title path.
 *
 * Supported placeholder: `{date}` -> DD-MM-YY (zero-padded, two-digit year).
 * Pure; the caller passes the clock so it stays testable.
 */
export function resolveSkillChatTitle(template: string, now: Date): string {
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear() % 100).padStart(2, '0');
    const date = `${dd}-${mm}-${yy}`;
    return template.replace(/\{date\}/g, date).trim();
}
