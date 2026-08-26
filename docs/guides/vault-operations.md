---
title: Vault operations
description: How Vault Operator reads, writes, searches, and structures your vault.
---

# Vault operations

Vault Operator can read, write, search, and organize files across your entire vault.

**You will need:** Vault Operator installed and one model configured. Auto-approve is off by default, which is the safe choice while you learn how the agent edits files. For read-only review, create a Custom Agent with only the `read` and `vault` groups, or set Auto-approve to ask every time.

**Use this guide when:** you want to know which read, write, edit, search, and structure tools the agent has, when each fires, and how checkpoints protect you from a bad write.

**You will know it works when:** the agent can read a note you asked about, edit a single section without rewriting the whole file, move or rename a note with backlinks intact, and you can undo any write from the checkpoint history.

## How it works

The agent does not access your vault directly. It uses tools: small, single-purpose functions. When you ask it to find a note or create a file, it picks the right tools and calls them on your behalf.

Every tool call shows up in the [activity block](/guides/chat-interface#activity-blocks), and write operations need [approval](/guides/safety-control) unless you enable auto-approve.

## Reading your vault

These tools let the agent look at your files without changing anything. They are safe to leave on Auto-approve, since they never modify the vault.

| Tool | What it does |
|------|-------------|
| **read_file** | Opens a note and reads its content |
| **list_files** | Lists files and folders in a given path |
| **search_files** | Finds notes by text content (keyword search) |
| **search_by_tag** | Finds all notes with a specific tag |
| **get_frontmatter** | Reads the YAML metadata at the top of a note |
| **get_linked_notes** | Follows wikilinks and backlinks from a note |
| **get_daily_note** | Opens today's daily note (or a specific date) |

### Examples

- *"What notes do I have in the Projects folder?"* (uses `list_files`)
- *"Find everything I wrote about client onboarding"* (uses `search_files`)
- *"Show me all notes tagged #review"* (uses `search_by_tag`)
- *"What links to my quarterly goals note?"* (uses `get_linked_notes`)
- *"Read today's daily note"* (uses `get_daily_note`)

:::tip Semantic search goes further
Keyword search matches exact words. To find notes by meaning (e.g., "notes about improving sleep" finding a note titled "Evening Routine"), see [Knowledge Discovery](/guides/knowledge-discovery).
:::

## Writing and editing

These tools modify your vault. Each call needs approval by default. You can change that under Settings > Vault Operator > Agents > Auto-approve.

| Tool | What it does |
|------|-------------|
| **write_file** | Creates a new note or replaces an existing one |
| **edit_file** | Makes targeted changes to part of a note |
| **append_to_file** | Adds content to the end of an existing note |
| **update_frontmatter** | Changes YAML metadata fields |

### Examples

- *"Create a note summarizing our Q1 results"* (uses `write_file`)
- *"Replace the second paragraph in @project-brief with a shorter version"* (uses `edit_file`)
- *"Add today's action items to @task-list"* (uses `append_to_file`)
- *"Set the status field to 'complete' in @project-brief"* (uses `update_frontmatter`)

:::info Checkpoints protect your files
Before any write operation, Vault Operator saves a snapshot. If something goes wrong, click Undo in the [undo bar](/guides/chat-interface#the-undo-bar) to restore the original.
:::

## Organizing files and folders

These tools help you restructure your vault.

| Tool | What it does |
|------|-------------|
| **create_folder** | Creates a new folder (including nested paths) |
| **move_file** | Moves a note to a different folder or renames it |
| **delete_file** | Sends a note to the Obsidian trash |
| **extract_zip** | Unpacks a `.zip` or `.skill` archive from the vault into a target folder (path-traversal + zip-bomb guarded) |

### Examples

- *"Create an Archive/2025 folder and move all notes tagged #archived there"* (uses `create_folder` + `move_file`)
- *"Rename @old-project-name to new-project-name"* (uses `move_file`)
- *"Delete all empty notes in the Inbox folder"* (uses `delete_file`)
- *"Unzip @ki-briefing-deutsch.zip into Inbox/"* (uses `extract_zip`)

:::warning Deletion respects Obsidian trash settings
Deleted files go to your configured Obsidian trash (system trash or the vault `.trash` folder). You can recover them from there.
:::

## Vault statistics

The agent can give you an overview of your vault using **get_vault_stats**:

- Total number of notes, folders, and attachments
- Vault size
- Tag distribution
- Recently modified files

**Example:** *"Give me a summary of my vault: how many notes, what are the most used tags?"*

## Canvas and visual maps

Vault Operator can create visual representations of your notes and their relationships.

| Tool | What it does |
|------|-------------|
| **generate_canvas** | Creates an Obsidian Canvas (.canvas) with cards and connections |
| **create_excalidraw** | Creates an Excalidraw drawing (requires the Excalidraw plugin) |

**Example:** *"Create a canvas map showing all notes in the Projects folder and their connections"*

## Bases (structured data)

Bases let you work with your notes as structured data, similar to a database view.

| Tool | What it does |
|------|-------------|
| **create_base** | Creates a new Base from notes matching certain criteria |
| **query_base** | Queries an existing Base with filters and sorting |
| **update_base** | Modifies entries in a Base |

**Example:** *"Create a Base of all notes tagged #book with columns for author, rating, and status from frontmatter"*

:::info Built on Obsidian Bases
Bases use Obsidian's built-in Bases feature. The Bases core feature requires a recent Obsidian version (Bases shipped in Obsidian 1.9); on older releases the Base tools are unavailable.
:::

## Clipping web pages

The **clip_web_page** tool archives a web page as a permanent note, similar to the Obsidian Web Clipper. Unlike `web_fetch`, which reads a page into the conversation and truncates long text, the clipper writes the full article into a file.

**Example:** *"Clip https://example.com/article into Sources/Article.md"*

What the tool does:

- Downloads the page and converts it to Markdown. It only sees the served HTML: it does not run JavaScript, so content a page loads in the browser is not clipped, and there is no paywall or login handling.
- Writes the note in two parts: a header, then the full article text under a literal `## Originaltext` heading. The agent normally writes the header itself (complete frontmatter plus a short summary). If it passes no header, the tool writes minimal frontmatter with `url`, `type: source`, and the page title and description.
- Downloads the article's images into your vault and rewrites their links to Obsidian embeds (`![[...]]`), so the note renders offline. By default images land in your attachment folder under `clips/{page-slug}/`, which makes deleting a clip and its images one folder operation; the agent can name a different folder. Images that fail to download keep an absolute remote URL.
- Never overwrites notes: the target path must not exist yet. Image filenames are derived from the image URL, so clipping the same page again reuses the same image files instead of duplicating them.

Safety limits: the page URL and every image URL go through the same guard chain as `web_fetch` (private and internal addresses are blocked, and redirects are re-checked at every hop). Image downloads are capped per image (10 MB), in total (40 MB), and in count (20 by default, up to 50 via `max_images`). Only image content types are accepted, and SVG files are stripped of scripts before they are saved. The approval card names the source URL, the target note, and the image folder before anything is written.

## Tips

1. Be specific about paths. "The Projects folder" is clearer than "my project notes."
2. Use @-mentions for specific files. The agent doesn't have to search for them then.
3. Let the agent chain tools. A request like "find all notes about X, summarize them, and create a new note with the summary" uses multiple tools automatically.
4. Check the activity block to see which files were read or changed.
5. For read-only exploration, create a Custom Agent with only the `read` and `vault` groups, or set Auto-approve to ask every time so no write goes through without your confirmation.

## Next steps

- [Knowledge discovery](/guides/knowledge-discovery): semantic search and the knowledge graph
- [Chat interface](/guides/chat-interface): attachments, history, and shortcuts
- [Office documents](/guides/office-documents): create PPTX, DOCX, and XLSX from your notes
