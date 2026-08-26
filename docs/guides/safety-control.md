---
title: Safety and control
description: Auto-approve, checkpoints, approvals, and the operation log. How to stay in control of what Vault Operator does.
---

# Safety and control

Nothing changes in your vault without your knowledge.

See also: [Checkpoints](../concepts/checkpoints.md), [Governance](../concepts/governance.md), and the [Settings reference](../reference/settings.md).

## The approval system

Vault Operator is fail-closed by default. It asks before any action that modifies your vault. Every write, edit, delete, or external call triggers an approval card in the chat.

### What an approval card shows

When Vault Operator wants to do something, a card appears with the tool name and a short preview:

- **Write a file:** path and a truncated preview of the content
- **Edit a file:** path and a truncated preview of the edit
- **Delete a file:** which file will be removed
- **Move or rename:** source and destination paths

Click the card to expand the full payload before deciding. Four levels, from narrow to broad:

- **Allow once**: this action only.
- **Allow for this run**: stop asking for this kind of change until the current task ends. The grant is never persisted and is shared with sub-tasks of the same run.
- **Allow this session**: stop asking for this kind of change until the plugin reloads (restart Obsidian or disable/enable the plugin). The grant lives only in memory and is never written to disk.
- **Always allow**: auto-approve this category from now on (a persisted setting).

Run and session grants cover the whole effect category shown on the card, not just the one tool: approving a `delete_file` card for the session also covers the other vault-change tools (`move_file`, `create_folder`, further deletes) until the plugin reloads, and an MCP card covers every tool on every configured MCP server. Plugin-API calls carry one extra distinction: the grant records read vs. write, so approving a plugin-API *read* never covers plugin-API *writes*. Settings changes and agent self-modification can never be covered by any scope. High-blast-radius operations always re-ask, whatever scope was granted: `restore_checkpoint`, `extract_zip`, and the `vault_health_check` mass repairs (`fix_backlinks`, `cleanup`, `fix_categories`; the read-only `check` stays covered).

### If you do not answer, or press Escape

An approval card does not wait forever. If you leave one unanswered past the approval timeout (default 10 minutes, set on the same tab; 0 means wait indefinitely), the card auto-denies and the tool does not run. Silence is a no, never a yes. The card counts down out loud in its final minute.

Pressing Escape stops the running task, and any card still open resolves as denied. Escape stops the agent, it does not silently undo changes already written to disk. To roll those back, use the undo bar or a checkpoint (see below).

## Auto-approve categories

Every tool call is classified into one effect by a central registry, and the effect decides whether it can auto-approve. The master switch under **Settings > Vault Operator > Agents > Auto-approve** ships **off**: with it off, everything that writes, spends money, or leaves the device asks. Reads always run.

| Category | What it covers | Risk level |
|----------|----------------|------------|
| **reads** | Reading files, listing folders, searching, semantic search | Always run (nothing changes); no toggle |
| **note edits** | Writing, editing, appending, frontmatter updates, ingest | High (changes your content) |
| **vault changes** | Create/move/delete files, extract archives, restore checkpoint, canvas and office docs | High (changes structure; harder to undo) |
| **web** | Fetching pages, web search, anti-echo search | Medium (external data enters the vault) |
| **mcp** | Calling external MCP tools/servers | Medium (depends on the connected server) |
| **subtasks** | Spawning sub-agents | Medium |
| **skills** | Running a skill (only trusted built-in / Pro skills auto-approve) | Medium |
| **recipes** | Running a stored recipe | Medium |
| **plugin API** | Reading from / writing to other plugins (two separate toggles) | Medium to high |
| **sandbox** | Agent-authored expressions, skill scripts, dynamic skill tools | High (runs generated code); toggle carries a confirm |

Two effects are **never** auto-approvable, whatever the settings say: **settings changes** (`update_settings`, `configure_model`, MCP server management) and **agent self-modification** (persona, memory, source). The agent cannot turn its own permissions on.

:::warning Permissive combination
If you auto-approve both **web** and a write category, Vault Operator lights up a "Permissive" warning in the Auto-approve tab. The agent could fetch content from the internet and act on it without asking.
:::

## The permission center

Whatever you allow, you can find it again in one place and take it back. Open **Settings > Vault Operator > Agents > Auto-approve**. This one tab is the permission center: the category toggles above, the kill switch, the shell-command allowlist, and, at the bottom, a **Specific permissions** list of every individual grant the agent currently holds.

Each row in that list shows three things:

- **What it covers.** The concrete thing that was allowed: a domain, an MCP server, a plugin-API method, a shell command, or a for-this-session grant.
- **How far it reaches (scope).** "This vault" (persisted, travels with Sync), "This device" (persisted locally, never synced), or "This session" (gone when the plugin reloads). Different scopes have very different reach, so every row states its own.
- **Where it came from (provenance).** How the grant was made: from an approval card (with the date), from Settings, from a preset, or during onboarding. A toggle that is on tells you what is allowed but not who allowed it. The permission center records that you are the reason, and when.

Every row has a **Revoke** button. One click takes that single grant back, and the change is immediate. Revoking a session or run grant also stops a task that is currently running from leaning on it, so "I took it back" means it actually stopped.

The auto-approve categories are not repeated in this list. Their home is their toggle, and the provenance line is shown on the toggle itself. The list holds only the specific grants that have no toggle anywhere.

### Web access: which sites the agent may fetch

`web_fetch` used to sit behind a single **web** flag, so the only lasting yes was "any page, forever". Now, when you approve a web fetch and choose **Always allow**, Vault Operator remembers just that one domain. The next page on the same site is covered; a different site still asks. Each allowed domain is a row in the Specific permissions list, revocable on its own. Allowing `example.com` does not allow `evil-example.com` or any subdomain: exact host only.

### Skill scripts: approve one script, not the whole sandbox

A skill script that is not the copy the plugin ships is judged on its exact bytes, never on the **sandbox** category flag, so a broad "auto-approve sandbox" can never cover your own or an imported script. When you approve such a script and choose **Always allow this script**, Vault Operator remembers a fingerprint (SHA-256) of exactly those bytes. The next run of the same script is covered; change a single character and it asks again, because the fingerprint no longer matches. Each remembered script is a row in the Specific permissions list, revocable on its own. This is what makes a skill with helper scripts run without a card on every step, while still catching a script that was quietly rewritten underneath it.

### Shell commands: the execute_command allowlist

`execute_command` can only run Obsidian commands that are on its allowlist. Nothing else runs, no matter what any toggle, preset, or approval says. Two tiers:

- A small **built-in** set the plugin ships enabled (export the active note to PDF, open today's daily note, create an Excalidraw drawing, create a DB Folder database). Switch any of them off under **Obsidian commands** on the same tab.
- **Commands you enrol yourself.** Add them under **Obsidian commands**, picking from the commands registered in this vault. Enrolment happens here in Settings on purpose, never from an approval card: the list is the capability boundary, and letting one card click add an arbitrary third-party command, on a command id the agent itself chose, would let the agent widen its own reach. Templater's "insert template" is deliberately not shipped enabled, because Templater templates run arbitrary code. Enrol it only if you mean to.

Enrolled commands show up in Specific permissions and are revoked there.

## Kill switch

At the top of the Auto-approve tab sit two emergency brakes:

- **Always ask (paranoid mode).** A runtime override: while it is on, every action except reads and pure UI steps asks for confirmation, regardless of the category toggles, presets, and any run or session grants. The approval cards stop offering scope grants while it is active (a grant would not take effect). The switch is a persisted setting, so it stays on across restarts until you turn it off; use it when you are inspecting an unfamiliar skill or model and want to watch every step.
- **Reset to default-deny.** One click (behind a confirmation) puts everything back to fail-closed: the auto-approve master goes off, every category returns to asking, and every specific grant is cleared at once. That means the web-host list, the enrolled shell commands, inbound MCP write access, promoted plugin-API methods, trusted stdio servers and imported skills, plus any run or session grant. It is the companion to the permission center: where Revoke takes back one grant, this takes back all of them. Paranoid mode is deliberately left as it is, because turning a brake off should never be a side effect of pressing another one.

## Reviewing changes

### Before the edit

The approval card shows the tool name and a truncated preview. Expand the card to see the full path and payload before approving.

### After the edit

Once the agent runs the tool, the chat shows a result row with a `+N / -M` diff badge for files that were edited. Click the row to inspect the full diff.

### The edit review panel

Since v3.0.0, the same review panel handles every change that touches a note. It appears for sidebar tasks after the agent finishes, and for inline-chat actions like Rewrite or Translate (see [Inline chat](inline-chat.md)).

The panel layout:

- Side-by-side aligned diff. The left column shows the original content. The right column shows the proposed content.
- Line numbers and `+` / `−` gutters on both sides, so you can see exactly which lines were added or removed.
- The right column is editable (`contenteditable` with plaintext-only input). Click in and type to adjust the proposal before applying.
- A live `+N / −N` counter above the right column updates as you edit.
- When the change spans more than one file, a file list on the left lets you switch between them. Each file has a "Skip this file" toggle to skip writing that file.
- The footer offers two actions: "Discard" discards everything. "Apply" writes the right-column content to disk.

For sidebar tasks, the panel opens automatically once the agent finishes a turn that wrote files. The modal title reads "Review changes". For inline-chat actions, the panel opens automatically once the model finishes streaming.

### Checkpoint view

The same panel runs in checkpoint mode when you open a past snapshot. In this mode the right column is read-only and shows the snapshot content. The footer replaces "Apply" with "Restore", which restores the snapshot to the vault.

Inline-chat edits also create checkpoints under a stable per-note task id, so every inline Rewrite or Translate is undoable from the inline checkpoint marker in the chat (Diff, Undo this, Undo from here, More menu). See [Inline chat](inline-chat.md) for the marker controls.

## Checkpoints and undo

Vault Operator creates a checkpoint before the first modification to any file in a task. Checkpoints live in a shadow git repository (via isomorphic-git) that sits next to your vault, not inside it, so your own git history is untouched. For details see [Checkpoints](../concepts/checkpoints.md).

### The undo bar

After every task that modified files, an undo bar appears with one button:

- **"Undo all changes":** restore every file to its pre-task state in one click

In parallel, the edit review panel (see above) opens automatically so you can inspect, edit, and apply per file.

:::tip Undo is always available
Even if you auto-approve everything, the checkpoint system records the state before changes. You can always undo after the fact.
:::

### How checkpoints work

1. Vault Operator snapshots each file before its first modification in a task.
2. The shadow repo stores the snapshot as a git commit.
3. If you undo, the original content comes back from the snapshot.
4. Files that were newly created (did not exist before the task) get deleted on undo.

Checkpoints are automatic. There is nothing to configure.

## The operation log

Every tool call is recorded in a daily log file.

Each entry records:

- Timestamp
- Tool name and parameters (sensitive values like API keys are redacted)
- Success or failure
- Duration

**Location:** JSONL files in your vault under `.vault-operator/data/logs/`, one per day, named by date (for example `2026-03-31.jsonl`).

**Retention:** Logs are kept for 30 days, then deleted. Browse recent logs in **Settings > Vault Operator > Advanced > Data & diagnostics**.

:::info No file content in logs
The operation log records that a file was read or written, but not the full content. It logs path and content length, not the actual text.
:::

## The ignore file

Create `.obsidian-agentignore` in your vault root to define paths the agent must never access. Same syntax as `.gitignore`:

```
# Private journal: agent cannot read or modify these
journal/
diary-*.md

# Credentials and sensitive files
secrets/
*.env
```

There is also `.obsidian-agentprotected` for files the agent can read but never write:

```
# Templates: agent can reference but not modify
templates/
```

An ignored path is not just unreadable, it is invisible. It never shows up in a folder listing, a search, or a tag query, so the agent cannot even learn that it exists, and it cannot be written either. Both control files are protected themselves, so the agent cannot modify or delete them. The agent's own config folder is off-limits the same way, which is what stops a script from quietly rewriting its own settings to grant itself more permissions. See [Governance](../concepts/governance.md) for the full deny-zone model.

You also do not have to duplicate exclusions you already maintain in Obsidian. When **Respect Obsidian excluded files** is on (Settings > Vault Operator > Vault > Vault, enabled by default), the paths from Obsidian's own **Excluded files** setting (under Files and links in Obsidian's settings) are enforced as if each entry were a line in `.obsidian-agentignore`: they disappear from listings, searches, and tag queries, no vault tool can read or write them, the semantic index skips them when it builds, and they are off limits to skill scripts and to external MCP clients too. Entries behave as they do in Obsidian: a `/.../` entry is a case-insensitive regex, anything else matches the folder or path itself and everything under it. Notes that were embedded before you excluded them stay in the semantic index until the next rebuild, but they are filtered out of search results in the meantime. One caveat: if Obsidian's settings file cannot be read, the excluded list is treated as empty rather than locking you out of your vault, so keep anything truly sensitive in `.obsidian-agentignore`, which remains the authoritative list. Flipping the toggle takes effect immediately.

:::tip Always-blocked paths
Vault Operator never accesses `.git/`, the Obsidian workspace cache, or internal config files, no matter how you configure it.
:::

## Best practices

1. Start with approvals on. Leave auto-approve disabled until you are comfortable with how Vault Operator works. Watch the approval cards to learn what the agent does.

2. Enable categories gradually. Turn on `read` first (low risk), then add others as you build trust. Keep `edit` and `skill` on manual approval longer.

3. Avoid the permissive combination. Do not auto-approve `web` and `edit` at the same time unless you fully trust the content sources.

4. Use the ignore file. If you have sensitive notes (financial records, medical info, private journals), add them to `.obsidian-agentignore` before giving the agent broad permissions.

5. Review the operation log now and then. A quick scan of recent logs shows what the agent has been doing and catches anything off.

6. Back up your vault. Checkpoints give you undo inside Vault Operator, but a proper vault backup (Obsidian Sync, git, or a file-system backup) protects against everything else.

7. Run read-only sessions when you only want answers. Two paths that work today:
   - Leave auto-approve off for `edit`, `skill`, and `mcp`, and decline any write card. The agent then has to ask for every change.
   - Open the tool picker (knife icon in the chat header) and disable the `edit`, `web`, `agent`, `mcp`, and `skill` groups for the current agent. The override persists in `modeToolOverrides` and survives reloads.

   The New agent modal currently grants every tool group on create. Per-agent tool filtering happens through the tool picker override, not through the create form.

8. Review the permission center now and then. Open the Auto-approve tab and scan the Specific permissions list. Anything you do not recognise, revoke it. If it has drifted too far, one Reset to default-deny puts the fail-closed default back.
