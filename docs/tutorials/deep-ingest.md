---
title: Sense-making with deep ingest
description: Walk through a guided five-step reading session that turns a research paper into sense-making notes with block-level provenance.
---

# Sense-making with deep ingest

The deep ingest is the thorough path: a guided, five-step dialog that turns a serious source into one or more sense-making notes. Five to fifteen minutes per source, including reading time.

Use it for research papers, long reports, domain-specific PPTX or DOCX, or anything where the answer to "what did this source actually say?" matters more than capture speed.

**Before you start:**

- Vault Operator installed, a model configured, semantic search built, and the quick ingest path tried at least once. If not, do [Capture a PDF with quick ingest](./quick-ingest) first. The deep path builds on the same building blocks.
- One source you genuinely want to read. The output is only as useful as the source.

## The five steps in one paragraph

The agent walks you through five user-visible steps. First it runs triage and asks for a decision (ingest, defer, or discard). Then it asks for the output mode and which topics to extract. After that the agent runs `ingest_deep` to set block ids in the source, writes the sense-making note or zettel, and finally sets backlinks in the source. The agent stops and waits for your answer at three points: after triage, after the topic table, and at output mode selection.

Now the same flow, step by step, with what you see and what to do.

## Step 1: Triage and decision

Drag the source into the chat. PDF, DOCX, PPTX, XLSX, or a Markdown file already in the vault all work. If you drag a file from outside the vault, Vault Operator saves it to your attachment folder first and points the agent at the vault path.

Ask for the deep path in plain language: "Deep-ingest this paper" or "Do a deep ingest of this PDF into my Sources folder". The agent calls `ingest_triage` and shows the triage card. The card includes:

- Cluster match, tension hint, source diversity, recommendation.
- Related notes from your vault. Semantic search hits, top results.
- Related facts from memory. What you have remembered about this topic.
- Related chat history. Past conversations that touched this material.

Answer the agent: ingest, defer, or discard. If you choose defer or discard, the workflow ends here. The decision is logged so the same source will not trigger triage twice.

## Step 2: Output mode and topic selection

If you chose ingest, the agent reads the source (this is the only long-running step you cannot speed up) and produces a numbered topic table:

```
1. The empirical setup and sample
2. The behavioral nudge mechanism
3. Cross-cultural replication results
4. Limitations and unaddressed confounders
5. Implications for policy design
```

Answer with "All", "1,2,4", or "skip" if you decided you do not want to extract anything. The agent only writes notes for the topics you picked.

Then the agent asks which output shape you want:

- **One sense-making note.** All chosen topics in one dense Markdown note, each take-away with a `↗` link to the source. Good for papers you will reference as one unit.
- **Multiple atomic zettel.** One bibliography note plus N atomic notes, Luhmann-style. Good for material with several distinct ideas that should each be linkable on their own.
- **Source-only with take-aways in chat.** The triage card and a clean source note get written. The take-aways stay in the chat dialog. Per-aspect detail notes are created on demand later, once the dialog reveals what is worth a separate zettel. This is the default and works for most cases.
- **Stop.** None of the modes fit. Nothing further is written.

The choice is yours. The agent will not push you into a giant sense-making note unless you ask for it.

## Step 3: `ingest_deep` sets block ids in the source

The agent calls `ingest_deep` with the chosen topics and explicit block anchors. The tool returns the anchor-to-block-id mapping for the source file. This is what makes the `↗` links in the next step land at the exact paragraph.

## Step 4: Write sense-making note or zettel

Now the agent writes the derived notes in a continuous run with a single up-front approval. The approval card shows full content for each planned write so you can review the batch before confirming. If a take-away references a source paragraph the matcher could not locate, you will see it called out in the tool result so you can either rerun with corrected anchor text or accept the take-away without a block reference. Silent skips do not happen.

## Step 5: Set backlinks in the source

The last action is a single `update_frontmatter` on the source note that links every newly created note via the configured backlinks property (default `Notizen`, configurable in Settings).

## What you have after the session

- One source note in your sources folder with frontmatter linking to every derived note.
- N derived notes (zero to many depending on your choices in steps 2 and 4), each with `↗` links back to the source paragraph for every key statement.
- One or more stub notes for new entities the deep ingest identified. Each stub includes a short explanation and a link back to the source that triggered its creation, so the stub is a real starting point rather than an empty file.
- The triage decision logged, so the same source will not be re-triaged.

## Follow a take-away to its source

Open one of the derived notes. Click any `↗`. You land directly at the source paragraph, with no page to scan. That is the payoff: weeks later, when you revisit the topic, every claim is two clicks away from its paragraph in the original.

## Try it again with a different output mode

The five-step flow is the same every time. Try a second source with a different output mode (zettel instead of single note, for example) to see which shape matches your reading style.

## What you learned

You ran a full sense-making session on a serious source. You picked the topics, picked the output shape, approved the writes, and ended up with a small graph of notes that all trace back to the original source with paragraph-level precision.

## Next steps

- [Knowledge ingest guide](/guides/knowledge-ingest): the full reference, including configuration and edge cases.
- [Block-level provenance concept](/concepts/provenance): the link system and why blocks beat pages.
- [Vault health check guide](/guides/vault-health): catches drifted entries, including notes whose source links no longer resolve.
- [Memory and personalization guide](/guides/memory-personalization): how Vault Operator remembers your preferred topics, categories, and output modes over time.
