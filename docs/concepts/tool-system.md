---
title: Tool System
description: How tools work, how they're registered and grouped, and what happens when the LLM calls one.
---

# Tool system

A tool is a function the LLM can call. Each tool has a name, a description, a JSON schema for its inputs, and an `execute` method. That's the entire abstraction.

The model never touches the vault directly. It describes _what_ it wants to do by emitting a tool call, and the tool system decides whether and how to carry it out.

## BaseTool

Every tool extends `BaseTool` (`src/core/tools/BaseTool.ts`):

```typescript
abstract class BaseTool<TName extends ToolName = ToolName> {
    abstract readonly name: TName;
    abstract readonly isWriteOperation: boolean;

    abstract getDefinition(): ToolDefinition;
    abstract execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void>;

    protected validate(input: Record<string, unknown>): void { /* optional */ }
    protected formatError(error: unknown): string { /* wraps in <error> tags */ }
}
```

`isWriteOperation` is declared per tool, not inferred. The pipeline uses it to decide whether approval and checkpoints are needed. `getDefinition()` returns the JSON schema the LLM sees. `execute()` receives a `ToolExecutionContext` with callbacks for spawning subtasks, switching modes, signaling completion, and requesting approval.

## ToolRegistry

`ToolRegistry` (`src/core/tools/ToolRegistry.ts`) is a `Map<ToolName, BaseTool>`. Its constructor takes the plugin instance and optional service references (MCP client, sandbox executor, skill loader) and registers every built-in tool at startup. The canonical list lives in [`docs/reference/tools.md`](/reference/tools), generated from `src/core/tools/toolMetadata.ts`.

Beyond storage, the registry handles two filtering passes. `getToolDefinitions({ includeDeferred: false })` strips deferred tools from the default system prompt so the schema stays compact; the agent loads them on demand via `find_tool`. `getFilteredToolDefinitions(allowedTools)` narrows the set to a specific allowlist, used by the agent system to restrict tool access per profile. The model cannot call what it cannot see.

## Tool groups

Tools are organized into seven groups. Each group maps to a permission category. The examples below are illustrative, not exhaustive. The full set is in [`docs/reference/tools.md`](/reference/tools).

| Group | Examples | Effect on vault |
|-------|----------|-----------------|
| `read` | `read_file`, `list_files`, `search_files`, `read_checkpoint` | Never changes anything |
| `vault` | `get_frontmatter`, `semantic_search`, `query_base`, `vault_health_check`, `recall_memory` | Read-only metadata, search, memory recall, and ontology checks |
| `edit` | `write_file`, `edit_file`, `delete_file`, `move_file`, `generate_canvas`, `create_pptx`, `ingest_document`, `restore_checkpoint` | Modifies or creates files. Ingest tools live here because they write source notes. |
| `web` | `web_fetch`, `web_search`, `anti_echo_search` | External network access |
| `agent` | `attempt_completion`, `switch_agent`, `new_task`, `find_tool`, `invoke_skill`, `consult_flagship` | Controls the agent's own behavior |
| `mcp` | `use_mcp_tool`, `read_mcp_tool` | Calls external MCP servers |
| `skill` | `execute_command`, `call_plugin_api`, `execute_recipe`, `enable_plugin` | Runs Obsidian commands and plugin APIs |

When you create a [custom agent profile](/concepts/mode-system), you pick which groups it gets. A profile with only `read` and `vault` is physically unable to write files. The ingest tools (`ingest_triage`, `ingest_document`, `ingest_deep`) sit in the `edit` group rather than a separate ingest group, because they all produce vault writes. That keeps the permission model simple.

## Deferred tools

Most built-in tools load into the default system prompt. A smaller set is deferred: listed by name only, with full schemas fetched on demand via `find_tool`. That keeps the base prompt compact without hurting discoverability. When the agent needs a deferred tool, it calls `find_tool` with a keyword and gets back the full schema for one or two follow-up turns.

The deferred set covers five buckets:

- Vault intelligence helpers (extended search, frontmatter probes, link traversal)
- Specialised writers (base creation and updates, Excalidraw, ZIP extraction)
- Checkpoint inspectors (`list_checkpoints`, `read_checkpoint`, `diff_checkpoint`)
- Self-development and settings inspection (`update_settings`, `configure_model`, `inspect_self`, `read_agent_logs`)
- Niche agent utilities (memory-source management, advisor consult, plugin probes)

The deferred set is the `DEFERRED_TOOL_NAMES` set in `src/core/tools/toolMetadata.ts`.

## Execution pipeline

Every tool call flows through `ToolExecutionPipeline` (`src/core/tool-execution/ToolExecutionPipeline.ts`). The path from invocation to result:

```mermaid
flowchart LR
    A[LLM emits tool call] --> B{Path blocked?}
    B -- yes --> X1[Denied]
    B -- no --> C{Approval needed?}
    C -- yes, rejected --> X2[Denied]
    C -- yes, approved --> D[Checkpoint + Execute]
    C -- no --> D
    D --> E[Log result]
```

In detail:

1. The tool must exist in the registry. Unknown tool names return an error.
2. The `IgnoreService` checks whether any file path in the input is blocked or write-protected. If paths are blocked, the call is denied.
3. Write operations, MCP calls, sandbox evaluations, and subtask spawning go through `checkApproval()`. If no approval callback exists, the operation is denied. Fail-closed by design.
4. Before each write, a git snapshot captures the file's current content for undo.
5. The tool runs. The result is logged to a JSONL audit file via `OperationLogger`.

Read-only calls skip steps 3 and 4 entirely.

## Parallel execution

When the model emits multiple tool calls in a single response, read-safe tools run concurrently via `Promise.all()`. Write tools and control-flow tools always run sequentially. A single iteration can resolve four `read_file` calls in parallel instead of waiting for each one.

The rule is simple: if every tool in the batch is in the `PARALLEL_SAFE` set, the batch runs concurrently. Everything else queues.

## Dynamic tools

Users and the agent can create tools at runtime. `DynamicToolFactory` (`src/core/tools/dynamic/`) builds a tool instance from a name, schema, and execute function. `DynamicToolLoader` persists definitions so they survive across sessions.

Dynamic tools go through the same `ToolExecutionPipeline` as built-in tools. A dynamic tool that writes files still needs approval and still gets checkpointed.

## Tool repetition detection

`ToolRepetitionDetector` (`src/core/tool-execution/ToolRepetitionDetector.ts`) catches the agent when it gets stuck calling the same tool with the same arguments in a loop.

It maintains a sliding window of the last 15 calls. If an identical `tool:input` combination appears 3 or more times, the call is blocked with a recoverable error. For search tools, it also checks semantic similarity: queries with a Jaccard overlap above 0.5 that appear 3+ times are blocked too.

The error is recoverable on purpose. The agent sees the message and can try a different approach. `consecutiveMistakeLimit` in `AgentTask` is the final safety net if the agent keeps failing anyway.
