---
title: Office documents (beta)
description: Create PPTX, DOCX, and XLSX files from your notes. Read existing Office files as conversation context. The creation side is still maturing.
---

# Office documents

:::warning Beta feature
Office document creation is a beta feature. Reading existing Office files (the parsing side used by the ingest workflows, `@`-mentions, and chat attachments) is solid and production-ready. Creation produces working files, but the visual quality is closer to a clean default deck than to a brand-matched corporate output. Read the [What works today](#what-works-today) and [What does not work yet](#what-does-not-work-yet) sections before you rely on it for client deliverables.
:::

You will need: Vault Operator installed, a configured AI provider, and (for PPTX creation) the office optional asset enabled under `Settings > Vault Operator > Advanced > Optional assets`.

Use this guide when: you want to pull text and data out of existing Office files into a conversation, or generate a Word document, an Excel sheet, or a draft slide deck from notes.

You will know it works when: the agent shows the create tool call in the activity block and writes the file to your chosen output folder (default `Inbox/`).

Vault Operator can read existing Office files (PPTX, DOCX, XLSX, PDF, CSV, JSON) and use their content as context in conversations. It can also create PPTX, DOCX, and XLSX files from structured input.

## Reading Office files (production-ready)

Drop a file into the chat, mention it with `@filename.pptx`, or ask the agent to read a vault file. Parsing happens automatically:

- PPTX: text from all slides plus speaker notes
- DOCX: headings, paragraphs, tables
- XLSX: sheet names, cell data, formulas
- PDF: page text with structure preserved
- CSV and JSON: structured data

Once parsed, the content behaves like any other note in the conversation. The agent can summarize it, extract action items, compare it to other material, or feed it into an ingest workflow.

For deeper capture into the vault, see [Knowledge ingest](/guides/knowledge-ingest). PDFs and Office files are first-class sources for both the quick ingest and the deep ingest.

## Creating Office files (beta)

### What works today

You invoke creation by asking in the chat. Under the hood the agent calls three tools by name:

- `create_docx` writes a `.docx` file with headings, paragraphs, bullet lists, numbered lists, and tables. Output is clean, readable, and stable.
- `create_xlsx` writes an `.xlsx` file with sheets, headers, data rows, formulas, and column widths. Stable.
- `create_pptx` writes a `.pptx` file. Beta. It uses PptxGenJS internally. The JSON schema accepts four layouts: `title`, `section`, `content`, `closing`. The `theme` argument is a freeform object of colors (primary, accent, background, text) and a font family. Bullets, tables, images, and speaker notes are supported.

For decks, a separate planning tool, `plan_presentation`, runs an internal AI call that analyzes source material and proposes a complete deck plan (titles, content per slide, layout choices) before generation. You review the plan in the chat, request adjustments, and then `create_pptx` consumes the plan. The named themes `executive`, `modern`, and `minimal` are selected at the `plan_presentation` step from the bundled template catalog. `create_pptx` itself takes the resolved color and font values, not the theme name.

The pipeline is one path: `plan_presentation` followed by `create_pptx`. There is no separate adhoc PPTX path in this version.

### What does not work yet

The plugin does not clone real corporate PowerPoint templates. Earlier versions tried this with the `pptx-automizer` library; after extensive iteration the approach was dropped in favor of the simpler PptxGenJS path. Practical consequences:

- Corporate `.pptx` templates with custom slide masters, branded layouts, and complex shape arrangements are not reproduced. The output uses one of the built-in layouts with theme colors and fonts you pass in.
- Visual rendering of the generated PPTX for layout verification (a `render_presentation` step you may see referenced in some skills) is not active in this version. The library code exists, but no tool exposes it.
- A template-ingest workflow for deriving custom themes from a `.pptx` is not part of the current build. Stay with the bundled `executive`, `modern`, and `minimal` themes.

For brand-critical decks, the realistic recipe today:

1. Generate a draft via `plan_presentation` followed by `create_pptx`, using the closest bundled theme.
2. Open the file in PowerPoint or Keynote.
3. Apply your real corporate template via PowerPoint's "Reset Layout" or by copying slides into a template file.

This works, but it adds manual steps. If brand-perfect output matters out of the box, expect to spend time on the polish pass.

For advanced cases (custom layout logic, batch generation, post-processing in code), use `run_skill_script` from a custom skill. The sandbox can drive PptxGenJS directly with full programmatic control, at the cost of writing the script yourself.

### Tips for getting useful output

1. Provide a real source. The deeper your source material (notes, data, an outline), the better the plan and the result.
2. Be explicit about structure. "Five slides: intro, three content slides, summary" beats "make a presentation."
3. Use `plan_presentation` first. It surfaces the deck structure before any binary is written. You can correct course before commit.
4. Iterate per slide. After the first version, ask the agent to adjust specific slides instead of regenerating the whole deck.
5. Keep expectations matched to the tool. Use this for internal docs, drafts, agenda decks, structured handouts. For external pitch decks and client deliverables, treat the generated file as a starting point you finish manually.

## Example prompts

The honest happy path:

- "Create a Word document from this note with headings for each section and a table at the end."
- "Turn the data in `Reports/Q1.md` into an Excel file with one sheet per region and a total row at the bottom."
- "Build a five-slide internal status presentation about the Acme project from my meeting notes. Use the modern theme."

## How to read the activity block

When the agent runs the office workflow, the activity block shows the steps in order: source reading, `plan_presentation` (for decks), the create tool call, and any self-check output. The self-check is a structural pass (are required fields filled, no empty slides, no stray placeholder text). It is not a visual render. Reviewing the file after writing is still your job.

## Where this is going

The creation side is a work in progress. Two paths are open: invest further in real template cloning (re-attempting `pptx-automizer` or a different engine), or stay on the PptxGenJS path and grow the layout library to cover more design patterns. Direction depends on user feedback. If brand-matched output is your blocker, open an issue or discussion on GitHub.

## Related

- [Knowledge ingest guide](/guides/knowledge-ingest): the reading side, where PPTX, DOCX, XLSX, and PDF feed structured notes back into the vault.
- [Tools reference](/reference/tools): the full input schema for `create_pptx`, `create_docx`, `create_xlsx`, and `plan_presentation`.
- [Office pipeline concept](/concepts/office-pipeline): the architecture of the creation pipeline and why template cloning was hard.
