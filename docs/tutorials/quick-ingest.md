---
title: Capture a PDF with quick ingest
description: Drop a PDF into the chat and end up with a clean source note that links every claim back to the right page.
---

# Capture a PDF with quick ingest

This tutorial shows the fastest ingest path: drop a single PDF into the chat, get a clean source note with page-level links back to the original.

About three minutes per source. Use the quick ingest when you want the material captured for later, without spending a full reading session on it right now.

**Before you start:**

- Vault Operator installed, a model configured, semantic search built. If not, do [Search your vault by meaning](./search-by-meaning) first.
- One PDF you actually want in your vault. A short paper or a meeting export works best for the first run.

## Step 1: Drop the PDF into the chat

Drag the PDF onto the chat input. The file uploads, and Vault Operator writes it into your Obsidian attachment folder (whatever you set in Obsidian's Files and links settings). The chat shows a file chip with the saved vault path. You did not need to save the PDF manually first.

## Step 2: Ask for the ingest and approve the write

Type "Ingest this report" and send. Any phrasing that asks for a capture works, "Add this PDF to my vault as a source note" does the same.

The agent makes one tool call to `ingest_document` and asks for write approval. Approve, and one Markdown note lands in your default output folder (set in **Settings > Vault Operator > Vault > Vault > Default output folder**, default `Inbox/`). The note contains:

- Frontmatter from the bundled ingest template (the OKF template materialized into your Templates folder): source path, type, ingest date, plus fields like author, year, summary, tags.
- A two-or-three-sentence overview.
- A `## Key Take-Aways` section. Each take-away ends with a `↗` link that resolves to the exact page of the source.
- The full original PDF text, appended automatically.

That is the entire quick path. No triage card, no ingest/defer/discard choice. If you want that decision step plus sense-making notes and backlinks, use [Sense-making with deep ingest](./deep-ingest) instead.

## Step 3: Click a take-away

Open the new source note. Click any `↗` link next to a take-away. You land at the matching `## Page N` heading further down in the same file. The original wording is right there.

Six months from now, when you ask yourself "where did this claim come from?", the answer is one click away.

## Step 4: See the source in semantic search

Ask the agent something the source is relevant to:

> "What do I know about [topic from the PDF]?"

The new source note appears in the semantic search results, often near the top. The take-aways and the embedded text both feed the index.

## What you learned

You now know the quick ingest path. One drop, one approval, one source note with provenance. The PDF lives in your attachment folder and the searchable note lives in your default output folder (`Inbox/` by default).

## Next steps

For material that deserves a real reading session (a research paper, a long report, a domain-specific Office document), use the deep path:

- [Sense-making with deep ingest](./deep-ingest)

For the full reference on both paths, including configuration:

- [Knowledge ingest guide](/guides/knowledge-ingest)

For the why behind the `↗` links:

- [Block-level provenance concept](/concepts/provenance)
