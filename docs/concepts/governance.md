---
title: Governance
description: How Vault Operator prevents the agent from doing damage. Path protection, approval, checkpoints, and audit logging.
---

# Governance

This is what makes it safe to give an AI write access to your notes.

See also: [Safety and control](../guides/safety-control.md) for the practical guide, [Checkpoints](./checkpoints.md), and the [Settings reference](../reference/settings.md).

The principle is fail-closed. If anything goes wrong during an approval check (a missing callback, an unloaded config, an unexpected error), the operation is denied. The agent never silently auto-approves. Every tool call, internal or MCP, flows through one central pipeline.

## The pipeline

`ToolExecutionPipeline` (`src/core/tool-execution/ToolExecutionPipeline.ts`) is the single enforcement point. Nothing bypasses it.

```mermaid
flowchart LR
    A[Tool call] --> B{Path blocked?}
    B -- yes --> X1[Denied]
    B -- no --> C{Approved?}
    C -- rejected --> X2[Denied]
    C -- approved --> D[Execute + Log]
    D --> E[Result]
```

Three questions, in order. Is the path allowed? Is the operation approved? Only then does the tool run, and the result is logged afterward.

## Path protection

Two files in the vault root control which paths the agent can access:

| File | Effect |
|------|--------|
| `.obsidian-agentignore` | Paths completely invisible to the agent. Uses gitignore syntax. |
| `.obsidian-agentprotected` | Paths readable but never writable, even with explicit approval. |

Both files use glob patterns. A line like `journal/private/**` blocks everything under that folder.

Some paths are always blocked regardless of configuration: `.git/`, Obsidian workspace files, and cache files. The governance config files themselves are always write-protected, so the agent cannot edit its own restrictions.

The `IgnoreService` (`src/core/governance/IgnoreService.ts`) enforces this. If it hasn't finished loading its patterns yet, it denies all access. Fail-closed.

An ignored path is hidden from enumeration, not only from reads (M-7). `list_files`, tag and link queries, vault statistics, and canvas generation all drop denied entries at the moment they collect results, through `denyZoneFilter.ts`, before any count, limit, or slice. That order matters: a hidden folder that still contributed to "42 notes not shown" would leak its size, and one that still consumed a result slot could be measured by shrinking a limit and counting the gaps. Hiding the names while publishing the count is the same leak with extra steps, so the count is taken over the visible set only.

Obsidian's own **Excluded files** list joins this same boundary. With `respectObsidianExcludedFiles` on (the default), `IgnoreService` reads `userIgnoreFilters` from `app.json` in the vault's config directory and folds the entries into the same `isIgnored` predicate that carries `.obsidian-agentignore`. Because that one predicate is the enforcement point, the exclusions hold everywhere it is consulted: the pipeline's path check for vault tool reads and writes, enumeration through `denyZoneFilter.ts` and the result filters in the search tools, the semantic index (excluded notes are skipped at index build, and rows embedded earlier are filtered out of `semantic_search` results at query time), vault health scans, sandbox scripts through the `SandboxBridge`, and the external MCP surface (`src/mcp/tools/mcpPathValidation.ts` plus the note-listing filter). Matching mirrors Obsidian's semantics: a `/.../` entry compiles as a case-insensitive regex (through `safeRegex`, so a pathological pattern degrades to a literal instead of hanging the renderer), and any other entry is a case- and unicode-folded path prefix. One deliberate asymmetry: the agent's own rule files fail closed, but reading the excluded list fails open (a missing or malformed `app.json` yields an empty list), because this list is an additive convenience and `.obsidian-agentignore` remains the authoritative deny source. Toggling the setting reloads the rules at once and bumps the ruleset generation, so caches keyed on it rebuild instead of serving the old view.

The agent's own config folder (`.vault-operator/`, except its skill workspace) is itself a deny zone (FIX-44-22). A tool or a sandbox script cannot write there, which is the concrete lock that stops the agent from rewriting `settings.json` to grant itself permissions. Authority over what the agent may do never lives inside a file the agent can edit.

## Below the vault API: safeFs and spawnAllowlist

Everything above decides whether an operation should be allowed. Beneath it sits a harder floor: whether the model can reach the dangerous primitives at all. By construction, it cannot.

There is no path from chat output to `fs.*`. The tools that take a path (`read_file`, `write_file`, `edit_file`) go through Obsidian's `vault.*` API, never the raw filesystem. The only calls that ever reach `fs` are hard-coded by the plugin (the knowledge database, the search index, the checkpoint store), and every one passes through `safeFs` (`src/core/security/safeFs.ts`), which resolves the path and checks it against a fixed allowlist of root directories. A path that escapes with `..` or lands outside the roots is rejected before any read or write happens.

There is no path by which the model can spawn a new process, or choose what is spawned. Every child process goes through `spawnAllowlist` (`src/core/security/spawnAllowlist.ts`), which checks the binary against a hard-coded list (`soffice` for office conversion, `pandoc` for recipe conversion, and `node` / `npx` for stdio MCP probes). Checkpoints need no binary: they run on `isomorphic-git`, pure JavaScript. A binary that is not on the list does not launch. There is no shell: `options.shell` is forced to `false`, shell metacharacters are rejected, and the `exec` / `execSync` string interfaces are not re-exported at all.

These two wrappers are why an adversarial model response, even one that talks its way past every approval, still cannot read a file outside the vault or run an arbitrary command. The trust boundaries and each allowlisted root and binary are documented in the reviewer notes that ship with the plugin (`REVIEWER_NOTES.md`).

## Approval effects (ADR-153)

Every tool call routes through the same approval check. What a tool is *allowed* to do is not something the tool declares about itself; it comes from one central registry, `TOOL_EFFECTS` in `src/core/tools/toolEffects.ts`, which maps every tool to exactly one effect class. The pipeline resolves the effect, looks up its policy in `EFFECT_POLICY`, and decides. A tool with no entry fails closed: it is treated as unclassified and always asks. This is deliberate. The earlier design let a tool opt out of approval by self-declaring `isWriteOperation = false`, and a handful of side-effecting tools did exactly that. The effect now comes from outside the tool.

The master toggle lives under Settings > Vault Operator > Agents > Auto-approve and ships **off**. With it off, every effect that writes, spends money, or leaves the device asks for confirmation.

| Effect | Examples | Policy |
|--------|----------|--------|
| `read` | `read_file`, `search_files`, `semantic_search`, `read_document` | Always auto. Reads never change the vault, so they run without asking and independently of the master toggle. There is no read toggle. |
| `ui` | `attempt_completion`, `update_todo_list`, `find_tool`, loop control | Always auto. Internal loop and UI control, master-independent. |
| `note-edit` | `write_file`, `edit_file`, `append_to_file`, `update_frontmatter`, `ingest_document`, `ingest_deep`, `ingest_triage` | Asks, unless the master AND the note-edits toggle are on. |
| `vault-change` | `create_folder`, `delete_file`, `move_file`, `extract_zip`, `restore_checkpoint`, Office/canvas creators | Asks, unless the master AND the vault-changes toggle are on. |
| `web` | `web_fetch`, `web_search`, `anti_echo_search` | Asks, unless the master AND the web toggle are on. |
| `mcp` | `use_mcp_tool`, `invoke_mcp_server` | Asks, unless the master AND the MCP toggle are on. |
| `subtask` | `new_task` | Asks, unless the master AND the subtasks toggle are on. |
| `skill` | `invoke_skill` | Asks, unless the master AND the skills toggle are on. Only skills from a trusted source (built-in / Pro) can auto-approve; an imported or self-authored skill still prompts. |
| `recipe` | `execute_recipe` | Asks, unless the master AND the recipes toggle are on. |
| `plugin-api` | `call_plugin_api` | Two flags: reads and writes hang off different toggles. The read/write decision comes from the call input, resolved the same way in the gate and in the "Always allow" button so they cannot disagree. |
| `sandbox` | `evaluate_expression`, `run_skill_script`, dynamic `custom_*` skill tools | Asks, unless the master AND the sandbox toggle are on. The toggle carries an explicit high-risk confirmation, because the code is authored by the LLM or a third-party skill. |
| `config` | `update_settings`, `configure_model`, `manage_mcp_server` | **Always asks. Can never be auto-approved.** This is the lock against self-escalation: the agent cannot turn its own permissions on. |
| `self-modify` | `update_soul`, `mark_for_memory`, `manage_source` | **Always asks. Can never be auto-approved.** Persona, memory, and source changes are always a human decision. |

`config` and `self-modify` are the two effects the master toggle and every preset can never reach. An agent that could talk its way into "don't ask again" for its own settings would have re-opened the exact hole this design closes.

**Escalation levels.** For any effect except `config` and `self-modify`, the approval card offers a four-step scope ladder:

1. **Allow once**: this single call.
2. **Allow for this run**: the grant dies with the current task and is never persisted. Run-scoped grants are inherited by sub-tasks and invoked skills.
3. **Allow this session**: the grant outlives individual tasks but lives only in memory. It is never written to disk and disappears when the plugin reloads.
4. **Always allow**: a standing auto-approval that enables the matching settings category.

Run- and session-scoped grants cover the whole effect class of the approved card: a session grant given on a `delete_file` card also covers the other vault-change tools until the plugin reloads. Only `call_plugin_api` grants carry one refinement on top of the class: the grant records whether the approved call was a read or a write, so approving a read for the run or session never covers writes. High-blast-radius operations always re-ask even when their effect class was approved for the run or the session: `restore_checkpoint` (mass rollback), `extract_zip` (bulk extraction), and the `vault_health_check` repair actions (`fix_backlinks`, `cleanup`, `fix_categories`; mass frontmatter mutation across many notes). For `vault_health_check` the exemption is input-conditional, like the plugin-api read/write refinement: the read-only `check` stays covered by a vault-change grant, while each mass repair raises its own scope card.

**The diff gate.** CUD tools that can compute what they would do without doing it (`write_file`, `edit_file`, `append_to_file`, `update_frontmatter`, `delete_file`, `set_block_anchors`, `mark_note_as_memory_source`, `unmark_note_as_memory_source`) show a real pre-write diff. The diff is produced by the same resolver that performs the write, so the preview cannot lie, and rejecting means the tool never runs. `delete_file` renders the whole doomed note as a deletion diff.

**Batch and scope approval.** Multi-file tools get ONE approval for the whole operation instead of a blind name card or a card per file. A tool that can enumerate its planned writes without performing them presents that plan to the gate, in one of two honest forms:

- **Multi-entry diff review.** When per-file before/after content is computable, the gate opens the same review used after tasks: one real diff per file, with a per-file Skip. Approving applies the un-skipped subset; skipping every file or discarding rejects the call. The review is read-only in this role: the tool performs its writes internally, so a hand edit inside one entry could not be honored, and the pipeline drops any stray edited content from batch approvals. `restore_checkpoint` works this way: current content versus snapshot content for every restored file, a deletion entry for every file the task created, and the skip decisions travel into the restore itself (a skipped file is neither rewritten nor trashed).
- **Scope card.** When the per-file result depends on processing the tool has not done yet, the card presents the planned file list plus an operation summary (20 visible rows, the full list under details), and the decision is all-or-nothing. That is still one honest approval for a defined scope. `vault_health_check` repairs (`fix_backlinks`, `cleanup`, `fix_categories`) plan their exact target set through the same selection code the repair runs, pinned by parity tests; `extract_zip` plans through a dry run of the same extraction code; `ingest_document` and `ingest_deep` (source-only mode) name the files they will create or annotate.

The plan must cover every file the tool would touch. Where that cannot be guaranteed up front (ingest output modes that name their files while running, the PDF markdown-mirror path), the tool falls back to the plain card rather than presenting an underlisted scope. Diff-review batch approvals count as diff-reviewed, so those files do not resurface in the post-task review; scope-card approvals do not (no diff was shown), and the post-task review remains their diff surface. A diff review is only a review at readable size: above 100 entries the pipeline itself downgrades the batch to a scope card before the gate opens, and the approval accordingly does not count as diff-reviewed. The cap lives in the pipeline contract, not in the UI, so what the gate showed and what the pipeline records can never disagree.

The approved plan also binds the execution. After an approved batch gate the pipeline hands the tool the approved path set: the un-skipped subset from a diff review, or the full planned list from a scope card. Tools that re-select their targets at execute time (the `vault_health_check` repairs) honor that set as a filter, so a file that drifted into the selection while the card was open (a user edit, a metadata-cache refresh, a concurrent task) is skipped, not silently written. The repair writes only what the card showed.

**Known limitation: card-only approvals.** Some write tools cannot produce a meaningful text diff, and for them the gate deliberately shows the plain approval card (tool name, target, parameters) instead of pretending. This covers the binary and structured creators (`create_pptx`, `create_docx`, `create_xlsx`, `create_excalidraw`, `create_drawio`, `create_base`, `update_base`, `generate_canvas`), path-level operations (`move_file`, `create_folder`), and tools whose persistent effect is a database record rather than file content (`ingest_triage` writes a triage-log entry, not the note). Every one of these still asks; what it cannot show is a line-by-line preview of a format that has no lines.

**Sandbox governance.** Sandbox code reaches the vault through the `SandboxBridge`, which now obeys the same rules as the tools: it consults the `IgnoreService`, takes a checkpoint before each write, and treats the agent's own config folder (`.vault-operator/`, except the skill workspace) as a deny-zone, so a script cannot grant itself permissions by rewriting `settings.json`. A skill's trust class (`builtin` / `pro`) is verified against a provenance manifest the plugin controls, not read from the skill's own frontmatter, so a third-party skill cannot forge `source: pro`.

## Seeing and revoking consent

A permission you cannot find again is not really consent, it is a setting that happened to get set. Older versions spread consent across a dozen stores: the category toggles here, promoted plugin-API methods under Advanced, stdio trust in the MCP tab, and session grants, inbound MCP write access and imported-skill trust with no surface at all. The honest answer to "what have I allowed, and how do I take it back?" was "look in four places, and for some of it you cannot".

`permissionInventory.ts` collects every standing and live grant into one flat list, and `permissionRevoke.ts` takes any one of them back. Both are pure and host-shaped (no Obsidian, no DOM), so the kill switch and the settings list enumerate the same set and cannot drift apart the way the stores did. Every entry carries two things the old surfaces never stated:

- **Scope.** `vault` (persisted, travels with Sync), `device` (persisted locally, never synced), `session` (dies on plugin reload), or `run` (dies with the task). Widest to narrowest, because "this vault" and "until Obsidian restarts" have very different blast radii.
- **Provenance.** `card`, `settings`, `preset`, `onboarding`, or `unknown`, with a timestamp. The stamp is best-effort by design: a missing stamp degrades to `unknown`, never to a wrong claim. Revoking a grant clears its provenance too, so a later re-grant cannot inherit an old date and claim you allowed it earlier than you did.

Revocation is one function with one case per store. A new consent store that forgets to add a case fails loudly (`unknown store`) rather than rendering a Revoke button that quietly does nothing. Revoking a session grant also bumps a revocation epoch, which is what makes an already-running task drop the grant instead of coasting on it.

**Web-host grants (M-5).** `web_fetch` no longer hides behind a single web flag whose only lasting answer was "any page, forever". A standing grant now records one host (`webHostGrants.ts`): per host, because the next path on the same origin carries the same trust and the same reach; exact match, because allowing `example.com` must not cover `evil-example.com` or a subdomain. This only changes when `web_fetch` skips a card. It could always reach any host once a human approved it.

**Command allowlist (M-8).** `execute_command` is different, and the difference is the point. Here the list *is* the capability boundary, not just a record of when to skip a card. A command that is not on the allowlist does not run, whatever the approval path answers (preset, category toggle, run or session grant, or a person clicking Allow). That is why enrolment happens in Settings and never from a card: a card grant on a command id the agent itself chose would reduce the allowlist to a one-time prompt and let the agent drive its own expansion, the exact shape ADR-153 closed for presets. A denylist was rejected because the command space is third-party and unbounded, and you cannot enumerate what is dangerous in a set you do not control.

**Paranoid mode and the approval timeout.** Two runtime brakes sit above all of this. Paranoid mode ("Always ask") is a persisted override: while on, the pipeline asks for every effect except `read` and `ui`, regardless of the toggles, presets, and any run or session grant, and the cards stop offering scope grants because none would take effect. It is deliberately not an `autoApproval` category key, so the effect-policy drift contract stays untouched. Separately, an unanswered card is denied after the approval timeout (default 10 minutes, `advancedApi.approvalTimeoutMinutes`, 0 to wait indefinitely): silence is fail-closed, never a yes.

**Reset to default-deny.** One button returns the whole surface to fail-closed: the restrictive preset, plus every specific grant cleared at once. That covers the web hosts, the enrolled commands, inbound MCP write access, promoted plugin-API methods and their promotion counters, trusted stdio servers and imported skills, and every run and session grant. Anything the permission list can show has to be reachable from the one button that claims to clear everything, or a reset would teach the user that the brake does not work. Paranoid mode is left untouched on purpose, because turning a brake off is never a side effect of pressing another.

## Checkpoints

Before any write operation, the pipeline takes a git snapshot of the affected file. This uses a shadow repository at `{vault-parent}/vault-operator-shared/checkpoints/` (outside the vault, so Obsidian Sync and iCloud do not replicate it) powered by `isomorphic-git` (pure JavaScript, no native git binary needed).

`GitCheckpointService` (`src/core/checkpoints/GitCheckpointService.ts`) commits the file's current content into the shadow repo before the tool modifies it. Each checkpoint records the task ID, commit hash, timestamp, changed files, and the tool that triggered it. Files that didn't exist before the checkpoint are tracked separately so restore can delete them.

After any task, you can undo all changes. Every write operation gets its own checkpoint, so you can roll back to any intermediate state. The vault's own git history, if it has one, is never touched.

## The external MCP surface

When the local connector is enabled, external MCP clients (Claude Desktop, ChatGPT, Perplexity, or anything holding the bearer token) reach the vault through a second surface. It follows the same effect-based rules, adapted to a context that cannot show an approval card.

**Declared effects, derived gate.** Every MCP tool definition carries a mandatory effect declaration (`read`, `session`, `dispatch`, or `write`) in `src/mcp/toolDefinitions.ts`. The write gate is derived from those declarations, never hand-maintained next to them, and an undeclared or unknown tool resolves to `write`: forgetting a declaration gates a tool instead of exposing it. A drift test pins the ungated sets, mirroring the agent-side `TOOL_EFFECTS` contract.

**Standing consent instead of a card.** Write-class MCP tools (`write_vault`, `save_to_memory`, `update_memory`) are disabled by default and only run once you enable **Allow write tools over MCP** under Settings > Vault Operator > Customize > Connectors. The generic `execute_vault_op` dispatcher routes every operation through the same `ToolExecutionPipeline` as the agent, with an explicit headless approval policy: your toggle counts as standing consent for write effects (`note-edit`, `vault-change`), so `get_daily_note` with `create: true` follows the same decision as `write_vault`. With the toggle off, the client receives a clean error naming the setting, not a fabricated "denied by user".

**What no toggle can open.** `config` and `self-modify` effects (settings, persona, long-term-memory extraction via `mark_for_memory`) are rejected over MCP unconditionally. The self-escalation lock is checked before the consent set, so no standing consent can cover them. Effects that would genuinely need a human decision in the moment (web egress, sandbox execution, subtasks) are also unavailable headless. The headless policy is the sole authority on this surface: the in-app auto-approval toggles and any "for the rest of this run" grants apply only to the agent you supervise in the sidebar and never authorize an external MCP client.

**Compensating checkpoint.** Since no card is shown, `write_vault` snapshots every target file before the batch, and pipeline-routed writes get the usual per-write checkpoint, so an unwanted external write stays undoable via `restore_checkpoint`. Memory writes (`save_to_memory`, `update_memory`) persist single additive facts into the user-global memory database outside the vault, where the vault checkpoint cannot reach; the undo path there is deleting the fact in the Memory tab.

::: warning Breaking change in 3.2.4
`save_to_memory` and `update_memory` are now behind the same **Allow write tools over MCP** toggle as `write_vault` (default off). External clients that saved memory before 3.2.4 will receive an error naming the setting until you re-enable write access under Settings > Vault Operator > Customize > Connectors.
:::

## Audit log

Every tool call is logged to a JSONL file via `OperationLogger` (`src/core/governance/OperationLogger.ts`). One file per day, stored under the agent folder at `.vault-operator/data/logs/YYYY-MM-DD.jsonl`. Files older than 30 days get deleted automatically.

Each entry records:

| Field | Content |
|-------|---------|
| `timestamp` | ISO 8601 |
| `taskId` | Which task triggered the call |
| `mode` | Active mode at the time |
| `tool` | Tool name |
| `params` | Input parameters (PII-scrubbed) |
| `result` | Output summary (capped at 2000 chars) |
| `success` | Whether the call succeeded |
| `durationMs` | Execution time |

Sensitive values (passwords, tokens, API keys) are replaced with `[REDACTED]` before logging. File content fields are logged as `[N chars]` instead of the full text. URLs have credentials stripped.

The log is append-only during a session. You can read it with any tool that understands JSONL, or use the built-in `read_agent_logs` tool to have the agent analyze its own history.
