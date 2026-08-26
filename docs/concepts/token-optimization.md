---
title: Token optimization
description: How Vault Operator reduces token costs through fast paths, cache alignment, and context externalization.
---

# Token optimization

A naive agent loop is expensive. The agent sends a system prompt, all tool definitions, the full conversation history, and every tool result to the LLM on every turn. For a simple "find and summarize" task, that can add up to 634,000 input tokens.

Vault Operator uses three complementary strategies that bring this down to roughly 60,000 tokens for the same task, about a tenfold reduction.

## The cost problem

Without optimization:

1. The system prompt includes the schemas for every tool in the active tool groups (read, vault, edit, web, agent, mcp, skill). Niche tools are deferred behind `find_tool`, but a typical chat still ships dozens of schemas.
2. Every tool result stays in the conversation history.
3. The LLM re-reads everything on every turn, even parts that haven't changed.
4. A task that could be done in 2 tool calls takes 8 because the agent plans one step at a time.

With models like GitHub Copilot's Sonnet that have a 168K context limit, complex tasks would simply fail because the context overflowed.

## Strategy 1: Fast path execution

When the agent has seen a similar task before, it skips the iterative loop entirely:

1. `FastPathExecutor` checks if any learned recipe matches the current request.
2. If a match is found, it makes one planning call to the LLM with the recipe and the specific inputs.
3. The LLM returns a batch of tool calls (all at once, not one at a time).
4. Vault Operator executes them deterministically without further LLM calls.
5. One final LLM call formats the result.

That's 2-3 LLM calls instead of 8. The agent learns new recipes automatically from successful task completions.

If the fast path fails or no recipe matches, Vault Operator falls back to the normal agent loop. Nothing breaks.

## Strategy 2: KV-cache-aligned prompt

LLM providers cache the key-value pairs computed from the prompt prefix. If the same prefix appears again, those computations are reused and you pay less.

Vault Operator arranges the system prompt so stable content comes first and volatile content comes last. The stable prefix covers the role definition, tool definitions, rules, capabilities, agent instructions, and shared safety language. These rarely change inside a session. The volatile tail covers active file context, retrieved memory, recipes, soul snippets, and the current date and time, which change every turn.

Because tools, rules, and agent definitions don't change between turns, the provider can cache them. Cache support differs per provider:

| Provider | Cache mode |
|---|---|
| Anthropic | Explicit, via `cache_control` blocks |
| Bedrock (Claude) | Explicit, via `bedrock-cachepoint` |
| OpenAI (gpt-4o, gpt-4.1, o1, o3, o4) | Implicit prefix caching |
| Gemini | Not used in this version (TTL context caching is deferred) |
| Other providers | None; the prompt structure still works, it just doesn't save money |

## Strategy 3: Context externalization

When a tool returns a large result (say, the content of a 200-line note), keeping it in the conversation history means the LLM re-reads it on every subsequent turn.

`ResultExternalizer` catches results larger than 2,000 characters, writes them to a temporary file under `.vault-operator/cache/tmp/{taskId}/`, and replaces the result with a compact, tool-specific summary that includes a path the agent can re-read:

```
[search_files] Found 42 matches.
Top files:
  - notes/foo.md
  - notes/bar.md
...
Full results saved to: .vault-operator/cache/tmp/<taskId>/search_files-3.md
Use read_file("...") to see all matches with context.
```

If the agent needs the full content later, it reads it with `read_file`. Most of the time it doesn't, because it already acted on the summary the turn the result was generated.

## Combined effect

| Scenario | Before | After | Reduction |
|----------|--------|-------|-----------|
| Simple task (search + summarize) | 634K tokens | 60K tokens | 90% |
| Complex task (multi-step vault work) | 800K+ tokens | 257K tokens | 68% |
| GitHub Copilot (168K limit) | Overflow error | Works | N/A |

These figures are illustrative estimates from development runs, not formal benchmarks. Your actual numbers depend on vault size, model, task, and how often a recipe matches.

## Trade-offs

- Fast path requires learning time. New task patterns run through the normal loop until a recipe is built.
- Externalized results add file I/O. For very short conversations (1-2 turns), the overhead isn't worth it.
- KV-cache hits depend on the provider. Some providers don't support caching at all. The prompt structure still works, it just doesn't save money.

## Related

- [The agent loop](/concepts/agent-loop): How the core loop works and where fast path fits in
- [System prompt](/concepts/system-prompt): The prompt section ordering in detail
- [Memory system](/concepts/memory-system): How recipes are learned and matched
