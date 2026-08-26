---
title: System prompt
description: How the agent's system prompt is assembled from modular sections, skills, memory, and agent context.
---

# System prompt

The system prompt is the first thing the model sees. It tells the agent who it is, what tools it has, what rules to follow, and what the vault looks like. The prompt is not a static string. It is assembled from around twenty modular sections, filtered by the active agent, and enriched with runtime context like skills and memory.

The orchestrator is `buildSystemPromptForMode()` in `src/core/systemPrompt.ts`, and the sections live in `src/core/prompts/sections/`. Those paths are in the plugin source code (this repository) for contributors building from source. They are not files inside the installed plugin, so you will not find them in your vault or in `.obsidian/plugins/vault-operator/`.

:::tip Trim the prompt as a user
You do not need to edit source files to make the prompt smaller. Turn on Settings > Vault Operator > Agents > Loop > Lean system prompt to switch to the compact prompt variants. It drops the long cost-heuristics text and collapses the plugin-skill catalogue, which re-expands once a skill is mentioned. The toggle saves several thousand tokens without removing tool, safety, or response-format guidance.
:::

## Why modular?

A monolithic prompt becomes unworkable past a few hundred lines. The Vault Operator prompt routinely exceeds 5,000 tokens because the agent has to understand the full tool surface, safety rules, vault conventions, and user-specific context. Modules solve two real problems. First, agents need different prompts: a read-only configuration drops write-tool descriptions, and subtasks skip skills and memory to stay lean. With modules you toggle sections on or off. Second, adding a skill or a new tool group should not require rewriting one large template. Each concern lives in its own file.

## Assembly order

Position matters. Language models pay more attention to content near the top (primacy effect) and the bottom (recency effect). A second constraint turned out to be more important than primacy: KV-cache efficiency.

Modern LLM APIs cache the key-value state of the prompt prefix. As long as the beginning of the prompt stays identical across calls, the cached tokens do not need to be recomputed. A single changed token at the start invalidates the entire cache for everything after it. Providers differ in how they expose this:

- Anthropic uses explicit `cache_control` markers on the system prompt.
- Bedrock Claude uses explicit `cachePoint` markers.
- OpenAI gpt-4o, gpt-4.1, o1, o3 and o4 do implicit prefix caching without a marker.
- Gemini does not cache short-lived prompts. TTL-based context caching is tracked separately and is not on by default.

The original prompt had the current timestamp at position 1. Every API call has a different timestamp, so we got zero cache hits across iterations. Moving the timestamp to the end and sorting all sections by stability turned the first roughly 20,000 tokens into a cache-stable prefix across a task session. As a rough illustration, over eight iterations billed computation drops from 8 x 25,000 = 200,000 tokens to roughly 25,000 + 7 x 5,000 = 60,000 on providers with prefix caching (illustrative arithmetic, not a benchmark).

The sections are now ordered by stability, with the stable prefix first and dynamic content last. The exact order matches `buildSystemPromptForMode()` in `src/core/systemPrompt.ts:233`.

Stable prefix (above the cache breakpoint, cached across iterations within a session):

| # | Section | What it does |
|---|---------|--------------|
| 1 | Mode definition | Sets the role (or a subagent profile override) that shapes everything below |
| 1b | Cost-aware heuristics | Plan-first, tool tiers, anti-overthinking, budget awareness. Lean variant on auto-mode mid-tier loops. |
| 2 | Capabilities | Compact summary of what the agent can do |
| 3 | Obsidian conventions | Vault rules: frontmatter, wikilinks, attachments |
| 4 | Tools | Compact tool catalogue, filtered by the agent's `toolGroups`. Full docs load on demand via `find_tool`. |
| 5 | Tool routing | Tool selection rules and decision guidelines |
| 6 | Objective | Task decomposition strategy |
| 7 | Response format | Output structure rules (omitted in subtasks) |
| 8 | Security boundary | Prompt-injection defence, permission boundaries |
| 8b | Skill directory | Stable list of every installed skill (name plus description). The model loads the full body on demand via `read_skill`. |

Cache breakpoint (sentinel line, stripped before send): providers that need an explicit marker put it on everything above this line. Everything below changes per message or session and is not cached.

Dynamic suffix:

| # | Section | What it does |
|---|---------|--------------|
| 8c | Advisor hint | Suggests a single `consult_flagship` call after repeated failures (auto-mode only) |
| 9 | Plugin skills | Plugin-skill catalogue (lean stub until a plugin skill is invoked) |
| 10 | Memory | User memory context (skipped in subtasks) |
| 11 | Procedural recipes | Recipes matched against the current message (skipped in subtasks) |
| 12 | Custom instructions and rules | Global plus per-agent instructions and rule files from `{agentFolder}/rules/` |
| 13 | Explicit instructions | Hard guardrails kept verbatim (e.g. tool-format reminders) |
| 14 | Vault context | Current vault state and structure |
| 15 | Date and time | Current timestamp. Must be last because it invalidates KV-cache. |

Empty sections are filtered out before joining. If there is no memory context, the memory section is absent. No hollow headers, no wasted tokens.

Moving skills out of the top of the prompt loses some primacy effect. To compensate, the system appends the current task list as the final user message before every LLM call, exploiting the model's recency bias. The technique is borrowed from Manus context engineering.

## How skills are presented

Skills are markdown files with workflow instructions for a specific task type. Two loaders feed them into the prompt:

1. `BuiltinSkillMaterializer` writes the bundled skills to disk on plugin load.
2. `SelfAuthoredSkillLoader` reads user-created and learned skills from the configured agent folder. The default is `.vault-operator/data/skills/` (upgraded from `.obsidian-agent/skills/` in v2.13).

All installed skills appear in section 8b above the cache breakpoint as a directory: name plus one-line description. The directory sits in the stable cached prefix so it does not invalidate the KV cache between turns. The directory wraps the entries in `<available_skills>...</available_skills>` and tells the model that when a skill matches the task it must call `read_skill({ name: "<name>" })` to load the full body, then follow that workflow step by step (the skill body OVERRIDES default tool selection and general guidelines for that task).

The full skill body lives in the message stream as a tool result, not in the system prompt. This keeps the cache-stable prefix small and lets microcompaction trim older skill bodies once they are no longer needed.

## How memory is injected

The memory section pulls relevant entries from the user's memory database and inserts them as context. Subtasks skip memory entirely to keep child prompts focused.

## Token budget

The system prompt cannot exceed the model's context window. Adding a long custom instruction or loading several skills makes the prompt grow. Core sections (tools, security boundary) are always present. Optional sections (memory, plugin-skill catalogue, custom instructions) can be trimmed or skipped depending on available context.

Subtasks trim the hardest. A child task skips the skill directory, memory, response format, recipes, and custom instructions. It gets the tools, the rules, and the job, nothing more.

## Per-agent customization

Each agent provides a `roleDefinition` that goes into the mode-definition section, and optional `customInstructions` appended to the custom-instructions section. The `toolGroups` field controls which tools appear in the tools section. Two custom agents can produce very different system prompts from the same set of modules: a research configuration with only the read and vault groups gets a read-only role and no write tools, while the default agent gets the full set.

## Prompt caching

Caching has two levels. At the application level, `AgentTask` caches the assembled prompt per agent and rebuilds it only when the active agent changes, when a settings change affects tool availability, or when an explicit invalidation triggers.

At the API level, the stable prefix benefits from provider-level KV-cache:

- Anthropic and Bedrock receive an explicit cache marker on everything above the cache breakpoint.
- OpenAI gpt-4o, gpt-4.1, o1, o3 and o4 hit their implicit prefix cache automatically.
- Gemini does not cache short-lived prompts.

On providers that cache, all dynamic content sits below the breakpoint, so the first roughly 20,000 tokens are computed once per session and served from cache on subsequent iterations. This is one of the largest cost wins in the system. It turns the system prompt from the second-largest cost block into a near-zero marginal cost per iteration.

## Power steering

During long-running tasks, `AgentTask` injects a synthetic user message every N iterations. It contains the active agent's role definition, active skill names, and a reminder to stay on task. This is not a system-prompt change, it is a user-role message appended to the conversation history. The model treats it as a redirect.
