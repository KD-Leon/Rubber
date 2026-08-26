---
title: Knowledge discovery
description: Semantic search, knowledge graph, implicit connections, and local reranking.
---

# Knowledge discovery

Most search tools match exact words. Vault Operator understands meaning. A search for "improving focus" can find a note titled "Deep Work Techniques" even though the words do not overlap.

**You will need:** an embedding model (OpenAI, Google, or a local model via Ollama), the semantic index enabled, and a built index. See the [Settings reference](/reference/settings#embeddings) for the embedding settings, or follow [Your first knowledge workflow](/tutorials/knowledge-workflow) for a guided setup.

**Use this guide when:** you want to ask "what do I know about X?" instead of grep, you want the agent to follow links and tags from a seed note, or you want to find notes that should be linked but are not yet.

**You will know it works when:** a semantic search for a vague phrase ("morning routine", "supplier risk", "Kant on duty") surfaces the right notes by meaning, and the implicit-connections background job flags a handful of plausible link suggestions for review.

## What is semantic search?

Traditional keyword search looks for exact text matches. Semantic search converts your notes into numerical vectors (embeddings) that represent their meaning. Your query is converted the same way, and the system finds notes whose vectors are closest to yours.

This means:
- *"recipes for pasta"* finds notes about Italian cooking, even if they never say "pasta"
- *"how to sleep better"* finds your note titled "Evening Wind-Down Routine"
- *"budget planning"* finds notes about financial forecasting and expense tracking

## Setup

Semantic search requires an embedding model to convert text into embeddings. You set this up once, Vault Operator handles the rest.

1. Open **Settings > Vault Operator > Providers > Embeddings**
2. Under **Embedding models**, add a model (for example OpenAI `text-embedding-3-small` or Google `text-embedding-004`)
3. Under **Semantic index**, enable **Enable semantic index**
4. Click **Build index** to process your vault

:::tip Which embedding model?
Any configured provider that supports embeddings will work. OpenAI `text-embedding-3-small` and Google `text-embedding-004` are fast, cheap, and well tested. Local models via Ollama (such as `nomic-embed-text`) work well if you want everything to stay on your machine. The plugin ships with no embedding model pre-configured, so pick one that matches your privacy needs.
:::

### Building the index

The first build processes every note in your vault. This can take a few minutes for large vaults (1000+ notes). After that, the index updates based on your settings:

- On startup: new or changed files are re-indexed if **Auto-index strategy** is set to "on startup"
- On file changes: edits trigger re-indexing if **Auto-index on file changes** is on (default: off)
- Manually: use **Build index** for incremental updates, or **Force rebuild** to delete and rebuild from scratch

The default auto-index strategy is "never", so you stay in control of when the index runs.

:::info Your notes stay local
Embeddings are stored in a local database inside your vault. If you use a cloud embedding model, note content is sent to the provider for processing, but the resulting embeddings live only on your machine. With a local model, nothing leaves your device.
:::

## How search works

When you or the agent run a semantic search, Vault Operator combines multiple retrieval strategies:

### 1. BM25 (keyword matching)

A fast, traditional ranking algorithm. It finds notes that contain your search terms and ranks them by relevance. Good for specific terms like names, dates, or technical jargon.

### 2. Semantic similarity (embedding matching)

Compares the meaning of your query against the embeddings of every chunk in your vault. Finds conceptually related notes even without keyword overlap.

### 3. Reciprocal rank fusion (RRF)

Combines the results from BM25 and semantic search into a single ranked list. Notes that score well on both methods rise to the top. This hybrid ranking beats either method alone.

## The knowledge graph

Beyond search, Vault Operator builds a knowledge graph from the structure already in your vault:

- **Wikilinks:** `[[note]]` connections between your notes
- **Tags:** shared tags create implicit groupings
- **Map-of-content properties:** frontmatter fields like `topics`, `concepts`, `people` link related notes

## Graph expansion

After semantic search picks the top matches, graph expansion follows wikilinks and map-of-content properties one or more steps further to pull in related context. This is helpful when the top hit is a stub note that points at the real content elsewhere. It costs a few extra reads per search.

Configure it under **Settings > Vault Operator > Providers > Embeddings > Graph expansion**:

- **Expansion hops:** how far to follow links from each hit.
  - **1 hop (direct links):** the safe default. Only notes directly linked from a hit are pulled in.
  - **2 hops:** links of links. Broader recall, a bit more noise.
  - **3 hops (broad):** wide net. Useful for very sparse vaults, expect off-topic results.
- **Map-of-content property names:** comma-separated frontmatter keys to treat as edges (for example `topics, concepts, people`).

**Example:** Searching for "machine learning" finds your note on Neural Networks. With 2 hops, graph expansion follows its wikilinks to Training Data and Model Evaluation, notes that search alone would miss.

## Implicit connections

Vault Operator can find notes that are semantically similar but not linked to each other: two notes about closely related topics, written months apart, that you never connected.

When it finds them, a suggestion banner appears in the sidebar offering to show you the discovered relationships.

:::tip Scales with vault size
The larger your vault, the more useful implicit connections get.
:::

## Local reranking

After the initial search returns candidates, Vault Operator can run a second pass using a cross-encoder model to improve result quality. This model runs entirely on your device via WebAssembly. No data is sent anywhere.

The reranker (based on ms-marco-MiniLM) reads each candidate alongside your query and produces a more accurate relevance score. False positives get pushed down; actually relevant results move up.

Toggle it under **Settings > Vault Operator > Providers > Embeddings > Local reranking**.

## HyDE (hypothetical document embeddings)

For vague queries like "what are my goals?" a direct embedding of the query often misses the right notes. HyDE asks the model to first write a short hypothetical note that would answer the query, then embeds that text and searches with it. Recall improves for abstract questions.

The trade-off: HyDE costs one extra model call per semantic search. Toggle it under **Settings > Vault Operator > Providers > Embeddings > Index configuration**.

## Contextual retrieval

When enabled, Vault Operator enriches each chunk with surrounding context before creating its embedding. It reads the note around a chunk and adds a brief description of what that chunk covers. This improves search accuracy for short or ambiguous passages.

For example, a chunk containing just a table of numbers becomes much more findable when the system adds context like "quarterly revenue figures from the 2025 financial review."

## Confidence scoring

Not all links are equal. A wikilink you typed by hand is a stronger signal than a similarity score computed in the background. The graph tracks this difference.

Wikilinks get the highest confidence. MOC property links (`related`, `parent`, and similar frontmatter fields) get medium confidence. Implicit connections from semantic similarity get the lowest. When search results include graph-expanded notes, these scores affect ranking, so a note reached through a direct wikilink outranks one reached through a weak implicit connection.

## Knowledge freshness

Search results include a freshness signal based on file modification time. Notes you edited recently get a small relevance boost. A note you updated yesterday about "project status" will rank above one you haven't touched in six months on the same topic. Older notes still appear, they just don't get the boost.

## Community detection

The knowledge graph often contains natural clusters: groups of notes that link to each other frequently but have few connections to the rest of the vault. Vault Operator runs the Louvain algorithm at startup to find these clusters. The results feed into vault health checks, where they help spot notes whose category tag doesn't match the cluster they actually belong to.

## God-node detection

The flip side of a healthy hub is a note that has collected too many backlinks to still be useful. A topic note with eighty connections is no longer an index, it's a dumping ground. Vault Operator flags these "god nodes" as part of the vault health check so you can think about splitting them into more focused notes. The threshold is configurable in [Settings > Vault Operator > Vault > Vault](/reference/settings#vault-health-check).

## Scanned PDFs and OCR

PDFs that contain only scanned images (no extractable text layer) are common in academic workflows, and on its own the PDF parser can't read them. If you have the Obsidian Text Extractor plugin installed and have already let it OCR your attachments, Vault Operator falls back to that plugin's OCR cache when indexing scanned PDFs. Anything you've processed with Text Extractor becomes searchable here too, with no additional API calls.

## Configuration

All settings live under **Settings > Vault Operator > Providers > Embeddings**.

| Setting | Where | Recommendation |
|---------|-------|----------------|
| **Embedding model** | Embedding models | Add one model that matches your privacy needs and provider |
| **Enable semantic index** | Semantic index | Must be on before you can build the index |
| **Chunk size** | Index configuration | Pick one of: Small (800 chars), Medium (1200 chars), Standard (2000 chars, default), Large (3000 chars). Smaller for short atomic notes, larger for long journals |
| **Excluded folders** | Index configuration | Skip templates, archive, or attachment folders to keep the index focused |
| **Auto-index strategy** | Index configuration | Default "never" keeps you in control. Set to "on startup" for active vaults |
| **Auto-index on file changes** | Index configuration | Default off. Turn on for API-based embedding models if you want live updates |
| **HyDE** | Index configuration | Improves recall on vague queries, costs one extra model call per search |
| **Expansion hops** | Graph expansion | 1 hop is the safe default, 2 hops for broader recall, 3 hops only for sparse vaults |
| **Local reranking** | Local reranking | Enable for better result quality at minimal performance cost |

:::warning Large vaults
For vaults with 5000+ notes, the initial index build may take 10-20 minutes depending on your embedding model. After that, incremental updates are fast. Consider excluding attachment folders or archives you rarely search.
:::

## Examples

- *"Find notes related to my goals for this year"* (semantic search finds notes about resolutions, plans, and objectives)
- *"What do I know about distributed systems?"* (searches by meaning across your vault)
- *"Show me notes similar to @architecture-decisions"* (finds thematically related notes)
- *"Are there any notes I should link together?"* (triggers implicit connection discovery)

## Next steps

- [Vault operations](/guides/vault-operations): reading, writing, and organizing your files
- [Memory and personalization](/guides/memory-personalization): how Vault Operator remembers your preferences
- [Settings reference](/reference/settings): all embedding and search settings explained
