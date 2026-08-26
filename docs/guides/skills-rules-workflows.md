---
title: Skills, rules and workflows
description: Create custom behaviors, constraints, and automated task sequences.
---

# Skills, rules and workflows

You can shape Vault Operator's behavior without writing code: give it permanent instructions (rules), teach it new abilities (skills), and build reusable multi-step sequences (workflows).

## The four building blocks

| Type | What it does | Triggered by | Location |
|------|-------------|-------------|----------|
| Rules | Static instructions always injected into the system prompt | Always active (toggle on/off) | `.vault-operator/rules/*.md` |
| Skills | Instruction sets injected when relevant keywords are detected | Automatic keyword matching | See skill locations below |
| Workflows | Multi-step sequences triggered by slash commands | `/workflow-name` in chat | `.vault-operator/workflows/*.md` |
| Custom prompts | Reusable templates with variables | `/` picker in chat | Settings > Vault Operator > Customize > Prompts |

Skills live in three subtrees, depending on origin:

- Bundled skills: `.vault-operator/data/skills/{name}/SKILL.md` (shipped with the plugin, refreshed on update).
- Plugin skills: `.vault-operator/data/skills/plugin/{name}/SKILL.md` (auto-generated from installed Obsidian plugins).
- Your own skills: `.vault-operator/data/skills/{name}/SKILL.md` (created by you, persisted across updates).

## Rules

Rules are the simplest customization. A rule is a Markdown file that gets injected into every conversation.

To create one:
1. Navigate to `.vault-operator/rules/` in your vault
2. Create a new `.md` file (e.g., `tone.md`)
3. Write your instruction in plain text

```markdown
Always respond in a friendly, concise tone.
Never use bullet points. Use numbered lists instead.
When summarizing notes, always include the creation date.
```

Toggle rules on and off in **Settings > Vault Operator > Customize > Rules**. Disabled rules stay in the folder but stop being injected.

:::tip When to use rules
Rules work best for global constraints that should always apply: tone of voice, formatting preferences, language requirements, domain terminology.
:::

## Skills

Skills go further than rules. They are only injected when the agent detects that a conversation is relevant to the skill's domain, which keeps the system prompt lean.

:::tip Bundled skills
Vault Operator ships with three bundled skills you can use right away: `/sandbox-environment` (sandbox API reference for skills that run scripts), `/vault-health-batch` (works through Vault Health findings in batches), and `/vault-operator-guide` (answers questions about Vault Operator itself). Bundled skills live inside the plugin and update with new releases. They sit alongside any skills you author yourself in your vault. The `/skill-creator` skill, which guides you through building your own skill, installs on demand from the skill registry (Settings > Skills > Browse the registry); the Create-skill button takes you there when it is missing.
:::

To create one:
1. Create a folder under `.vault-operator/data/skills/` (e.g., `meeting-notes/`)
2. Add a `SKILL.md` file with frontmatter:

```markdown
---
name: meeting-notes
description: Formats meeting notes with attendees, decisions, and action items
---

When the user asks you to create or format meeting notes:
1. Ask for the meeting title, date, and attendees if not provided
2. Structure the note with these sections: Attendees, Agenda, Discussion, Decisions, Action Items
3. Tag action items with the responsible person
4. Add frontmatter with type: meeting, date, and participants
```

The `name` must be kebab-case (lowercase letters, digits, hyphens). The agent matches this skill when the user mentions meetings, agendas, or action items.

### Per-agent filtering

Skills can be restricted to specific agents. A skill meant for the writing agent won't activate in a read-only agent, so the suggestion won't include write actions it can't execute.

### Plugin integration

Vault Operator discovers your installed Obsidian plugins and can use them. There are three mechanisms.

Plugin skills (automatic). On startup, Vault Operator scans all installed plugins and generates skill files that describe their capabilities. If you have Dataview installed, the agent knows it can run Dataview queries. If you have Templater, it knows about your templates. You can see these in **Settings > Vault Operator > Customize > Skills > Plugin skills** and toggle them on or off per plugin.

Plugin commands. The agent can run any Obsidian command through the `execute_command` tool. That includes commands from your plugins, like "Dataview: Refresh all views" or "Templater: Insert template". Commands require approval by default (configurable under **Settings > Vault Operator > Agents > Auto-approve > Plugin skills**).

Plugin API. For deeper integration, the agent can read data from plugin APIs using `call_plugin_api`. It can query Dataview results or read Omnisearch indexes. Write access to plugin APIs is off by default and requires explicit opt-in under **Settings > Vault Operator > Agents > Auto-approve > Plugin API writes**.

:::tip Rescan after installing plugins
If you install a new plugin while Obsidian is running, go to **Settings > Vault Operator > Customize > Skills** and click **Rescan vault** to pick it up. Otherwise it gets discovered on next restart.
:::

You can also create your own skills that build on plugin capabilities. A "Project Dashboard" skill could use Dataview queries to generate a summary canvas, for example.

### Skills that run scripts

For binary formats (PPTX, DOCX, XLSX) or heavy compute (image processing with sharp, data transforms), a skill can call `run_skill_script`. The skill ships a Node script next to its `SKILL.md`, and the agent invokes it with arguments. Use this when the work is deterministic and would be expensive in tool calls (for example, building a 30-slide deck from a JSON outline, or batch-resizing image attachments).

## Workflows

Workflows are saved procedures. They define a sequence of steps the agent follows when triggered.

To create one:
1. Create a file in `.vault-operator/workflows/` (e.g., `weekly-review.md`)
2. Define the steps:

```markdown
# Weekly Review

1. Search for all notes created or modified in the last 7 days
2. Group them by folder and summarize each group
3. List any open action items (unchecked checkboxes)
4. Create a new note called "Weekly Review - [date]" with the summary
5. Move the note to the Reviews/ folder
```

Trigger it by typing `/weekly-review` in the chat input. The agent follows the steps in order.

### Forcing a workflow

You can also pin a workflow to an agent profile so it applies automatically. Open the workflow picker (type `/` in the chat) and use the pin control on a workflow entry. While pinned, the workflow's instructions are prepended to every message you send with that agent, and a chip above the input shows that it is active. Messages that already start with an explicit `/` command are sent as typed (your command wins over the pin). Pin the same workflow again to clear it. The pin is stored per agent profile and per vault, and if the pinned workflow file is later deleted or disabled, you get a one-time warning and the picker keeps a row for it so you can unpin.

## Custom prompts

Custom prompts are reusable message templates with variable placeholders. Two variables are supported:

| Variable | Replaced with |
|----------|--------------|
| `{{userInput}}` | Whatever the user types after selecting the prompt |
| `{{activeFile}}` | The content of the currently open note |

Example: a prompt called "Explain Like I'm 5" with the template `Explain the following in simple terms a beginner would understand: {{activeFile}}`.

Create and manage custom prompts in **Settings > Vault Operator > Customize > Prompts**, or type `/` in the chat to browse and trigger them.

## Choosing the right tool

| You want to... | Use |
|----------------|-----|
| Set a permanent formatting or tone rule | Rule |
| Teach the agent a domain-specific process | Skill |
| Build a repeatable multi-step procedure | Workflow |
| Save a frequently used prompt | Custom prompt |

:::warning Keep rules focused
Too many rules bloat the system prompt and can confuse the model. Prefer skills for specialized knowledge. They only activate when needed.
:::

## Next steps

- [Office documents](/guides/office-documents): create presentations, documents, and spreadsheets.
- [Connectors](/guides/connectors): hook up external tools and expose your vault.
- [Multi-agent and tasks](/guides/multi-agent): hand work off to sub-agents.
