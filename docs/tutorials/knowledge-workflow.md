---
title: Knowledge workflow overview
description: Orientation across the four knowledge tutorials, semantic search, the two ingest paths, and Vault Health.
---

# Knowledge workflow overview

Vault Operator turns a flat vault into a queryable knowledge base. This page is the map: it shows the four tutorials that get you there, what each one is for, and which guide to open when you outgrow the tutorial.

## You will need

- A vault with at least a handful of notes (more is fine).
- An embedding provider configured, or willingness to set one up. See [Search your vault by meaning](./search-by-meaning) for the supported options.
- Five to twenty minutes per tutorial.

## Use this overview when

- You just installed the plugin and want to know where to start with knowledge work.
- You know one piece (for example the quick ingest) and want to see how it connects to the rest.
- You came here from an older link and need the current entry point.

## The four tutorials, in order

Do them in order the first time. After the first pass, each tutorial stands on its own.

1. [Search your vault by meaning](./search-by-meaning)
   Set up the embedding model, build the semantic index, and run your first meaning-based search. About twenty minutes plus indexing time on large vaults. This is the foundation: every other knowledge feature uses the same index.

2. [Capture a PDF with quick ingest](./quick-ingest)
   Drop a PDF, get a clean source note with page-level links back to the original. About three minutes per source. Single-pass: one tool call, no triage, no detour into sense-making.

3. [Sense-making with deep ingest](./deep-ingest)
   A guided five-step dialog that turns a research paper or long report into one or more sense-making notes with paragraph-level provenance. Five to fifteen minutes per source.

4. [Your first conversation](./first-conversation)
   Optional, but useful if you have never used the agent before. Covers the chat surface, approvals, and the default agent. Read it after step 1 if the ingest flow feels mysterious.

## Pick a path

The two ingest paths are not interchangeable. Use the table to choose.

| You have | You want | Use |
|---|---|---|
| A single PDF or web article | Capture now, read later | Quick ingest: "Ingest this PDF" (single-pass) |
| A research paper, long report, or domain-specific deck | Sense-making, paragraph-level provenance, multiple derived notes | Deep ingest: "Do a deep ingest of this paper" (five-step) |
| A natural-language question across your vault | Hits ranked by meaning, not keyword | Semantic search (ask the question in the chat) |
| A vague hunch that "something is wrong" with the vault | A structural check (orphans, broken links, missing frontmatter) | Vault Health |

## What the quick ingest does

The quick ingest is the fast path. One tool call. The agent reads the source, writes a clean source note into your inbox folder (default `Inbox/`), applies your ingest template, and stops. No triage, no decision card, no follow-up notes. Trigger it with a plain request like "Ingest this report".

Pick the quick ingest when you want the material in the vault now and you do not want a reading session. See [Capture a PDF with quick ingest](./quick-ingest) for the full walk-through, and [Knowledge ingest guide](/guides/knowledge-ingest) when you want to change the template or the target folder.

## What the deep ingest does

The deep ingest is the thorough path, started with a request like "Do a deep ingest of this paper". Five user-visible steps:

1. Triage: the agent suggests ingest, later, or discard with one paragraph of reasoning.
2. Output mode plus topic selection: you pick whether to produce one synthesis note, several topic notes, or zettels, and which topics from the source to keep.
3. Block-level ingest: the agent sets block ids in the source document.
4. The agent writes the derived note or notes.
5. The agent sets backlinks from the source to the derived notes.

The agent stops at every question and waits for you. See [Sense-making with deep ingest](./deep-ingest) for the walk-through, and [Block-level provenance concept](/concepts/provenance) for the underlying link model.

## What semantic search does

Semantic search is the index that powers everything else. Once you have built it, meaning-based questions in the chat, the `semantic_search` tool, and the deeper graph-walking features in the deep ingest all draw from the same vectors. If the index is not built, the agent falls back to plain text search.

The semantic auto-index default is off (`never`). You opt in explicitly on the Embeddings tab. See [Search your vault by meaning](./search-by-meaning) and [Knowledge discovery guide](/guides/knowledge-discovery).

## What Vault Health does

Vault Health is the structural check that catches what slipped through the ingest paths: orphan notes, broken links, untyped notes, frontmatter drift. Run it monthly on a small vault, weekly on a large one. See [Vault health check guide](/guides/vault-health).

## A typical knowledge week

This is what most users settle into after the first pass.

- Once: build the semantic index. Re-build only when you change the embedding model.
- Daily, on demand: drop a PDF or article into the chat and ask for a quick ingest.
- Once or twice per week: pick one source you actually want to think about and ask for a deep ingest of it.
- Weekly: ask a meaning-based question in the chat to surface notes you forgot you had.
- Monthly: run Vault Health and fix whatever it flags.

## Three worked examples

These show the four paths in real combinations. The examples are abridged, the full walk-throughs live in the sibling tutorials.

### A morning of capture

You have eight tabs open: three articles, two PDFs, a YouTube transcript, a long Substack post, and a slide deck. You do not want to read any of them right now.

1. Open the chat.
2. For each source, drop the file or paste the URL and tell the agent "ingest this".
3. The agent writes one source note per item into `Inbox/`.
4. Skim the take-aways at the end of the day. Move the worth-reading ones to a project folder.

Single tool call per source. No decisions, no follow-up notes. Total time: about three minutes per source.

### A deep read of one paper

You have a research paper you actually want to understand.

1. Drop the PDF into the chat and ask "Do a deep ingest of this paper".
2. Step one: the agent triages and says "ingest". You confirm.
3. Step two: you pick "three topic notes" and choose the topics that matter to you. The agent suggested six, you keep three.
4. Step three: the agent sets block ids in the source.
5. Step four: the agent writes the three derived notes, each with paragraph-level links back to the source.
6. Step five: the agent sets backlinks from the source to the three notes.

Five to fifteen minutes, mostly reading the take-aways. The provenance lets you re-verify any claim weeks later in one click.

### A research question across the vault

You vaguely remember writing about a concept months ago but you cannot find it by keyword.

1. Build the semantic index first if you have not yet.
2. Ask the question in the chat in plain language.
3. The top hits are ranked by meaning, not keyword overlap.
4. If the right note is not in the top five, open [Knowledge discovery guide](/guides/knowledge-discovery) and turn on graph expansion.

## Common pitfalls

These come up often enough to call out.

- The semantic index is not built. Search falls back to plain text and feels underwhelming. Open Settings > Vault Operator > Providers > Embeddings, enable the index, and click Build. The button is greyed out with "Enable semantic index first." until the toggle is on.
- The embedding model changed. The index is now mixed. Force-rebuild from the same tab. Force-rebuild deletes the existing index, cancel keeps progress.
- A quick ingest produced a note that already exists. The agent appends a numeric suffix. Move it on top of the older note if you want to merge, or delete it.
- A deep ingest did not stop where you expected. The agent stops at every `ask_followup_question`. If it ran past a step, your auto-approve settings let it through. See [Safety and control guide](/guides/safety-control).
- Vault Health says you have 400 orphans on a vault you just started using with Vault Operator. That is normal: notes without any inbound or outbound link are flagged as orphans. Fix the high-severity items first, ignore the long tail until it bothers you.

## FAQ

**Do I have to run a quick ingest before a deep ingest?**
No. The deep ingest includes its own capture step. The quick ingest is the path for sources you do not want to think about right now.

**Can I run a deep ingest on a note that is already in my vault?**
Yes. Drop the existing note as context and ask for a deep ingest. The agent treats it as the source.

**Is semantic search required for the quick ingest?**
No. The quick ingest writes a source note regardless. But the search and the graph expansion in the deep ingest work better with the index built.

**Where do the notes land?**
The quick ingest writes the source note into your default output folder (default `Inbox/`, configurable in Settings > Vault Operator > Vault > Vault). The deep ingest writes derived notes wherever you tell it in step two, defaulting to the same folder.

**Does the agent send my vault to the cloud?**
Only the chunks the agent reads to answer a turn, and only to the provider you configured. The semantic index and the source notes stay on disk. See [Governance and logging concept](/concepts/governance) for the details.

## Where the four tutorials end and the guides begin

The tutorials show one happy path each. The guides cover the configuration, edge cases, and reference material around that path.

- [Knowledge discovery guide](/guides/knowledge-discovery): the full picture of semantic search, including graph expansion and reranking.
- [Knowledge ingest guide](/guides/knowledge-ingest): the reference for both ingest paths, including template settings.
- [Vault health check guide](/guides/vault-health): the structural checks, severities, and remediation.
- [Memory and personalization guide](/guides/memory-personalization): how the agent learns your style and preferred sources.

## Where things live in Settings

The features described here are configured in three places.

- Settings > Vault Operator > Providers > Embeddings: embedding model, semantic index, index configuration, graph expansion.
- Settings > Vault Operator > Vault > Vault: ingest templates, default output folder, default ingest folder.
- Settings > Vault Operator > Agents > Memory: memory source notes and personalization toggles.

If you cannot find a setting, run the setup wizard again at Settings > Vault Operator > Advanced > Interface > Setup > Restart setup.

## What block-level provenance buys you

The two ingest paths both write links back to the source. The difference is the granularity.

- The quick ingest links at the page level. Click a take-away in the source note, land on the right page of the PDF or the right anchor in the article.
- The deep ingest links at the paragraph level (block ids). Click a claim in a derived note, land on the exact paragraph in the source that produced it.

The paragraph-level links pay off the most when you revisit a derived note weeks later and ask "where did I get this idea?". One click answers the question. See [Block-level provenance concept](/concepts/provenance) for how the link rewriter works.

## Performance notes

A few numbers that help you plan.

- Initial semantic index on a 1000-note vault with the standard chunk size (2000): about three to ten minutes, depending on the embedding provider.
- Index growth: incremental. A new note adds a few seconds, not a re-index.
- A quick ingest on a 30-page PDF: about 30 to 90 seconds, mostly the agent reading the file.
- A deep ingest on a 30-page research paper: five to fifteen minutes including the steps where the agent waits for you.
- Vault Health on a 1000-note vault: under a minute.

If you have a much larger vault, see [Knowledge discovery guide](/guides/knowledge-discovery) for chunk-size tuning. The four chunk sizes are 800 (small), 1200 (medium), 2000 (standard, default), and 3000 (large).

## Where to go next

If you have never run the agent: open [Your first conversation](./first-conversation), then come back here.

If you are ready to set up search: open [Search your vault by meaning](./search-by-meaning).

If you already have an index and want to put a PDF into the vault: open [Capture a PDF with quick ingest](./quick-ingest).

If you want to think with a source, not just capture it: open [Sense-making with deep ingest](./deep-ingest).

If you have done all four tutorials and want to wire the agent into your own workflows: open [Skills, rules, workflows guide](/guides/skills-rules-workflows).
