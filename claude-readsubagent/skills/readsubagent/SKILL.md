---
name: readsubagent
description: Use when about to do focused reads of unfamiliar implementation files, or when you need a factual answer about files (subsystem map, smallest focused read list, symbol/line anchors, API or flow map, config/docs detail) without pulling large file contents into the main context. Read planning and read-only codebase scouting. Not for code review, bug finding, correctness judgments, edit strategies, or implementation planning.
---

# readsubagent — read planning via a local model

## Overview

`readsubagent` is a read-only codebase scout. It delegates file inspection to a **local** model (Qwen via LM Studio, through a headless `pi` child) and returns a concise, cited report — so you get a read plan or a factual answer **without** loading large file contents into your main context.

**Core principle:** scout before you read. Get the map and the smallest focused read list first, then do your own focused reads against the anchors it returns.

## When to Use

- **Before** focused reads of an unfamiliar subsystem — to get where things live and the 3-6 files to read first.
- To get a factual answer about files without the bytes: a summary, symbol/definition location, an API/flow map, a config or docs detail, or exact line ranges.
- To keep the main context lean when the question is "where / what / which files," not "is this correct."

## When NOT to Use

This is a factual scout, not a reviewer. Do **not** use it for:

- Code review, bug finding, correctness or type-safety judgments
- Accept/reject decisions, maintainability/security calls
- Edit strategies or implementation planning

For those, gather the facts/anchors here, then reason or review in the main agent.

## How to Use

Use whichever entry point best fits the moment:

- **Direct MCP tool** (`mcp__zz_readsubagent__readsubagent`) when you already
  know the targets and want the lowest-overhead call.
- **`readsubagent` subagent** (`Agent(subagent_type="readsubagent")`) when you
  want the thin delegator to relay only a distilled plan.
- **This skill** when you want the workflow and prompt shape in front of you.

Give it:

- A precise **factual question** (what to find, summarize, compare, extract, or explain).
- **paths/path** — repo-relative files or dirs to focus on, ordered by relevance, when known.
- **symbols** — functions, classes, types, config keys, routes to look for.
- **searchTerms** — focused search strings or regexes.
- **lineRanges** — e.g. `src/file.ts:120-180` when known.
- **output** — the report shape you want (see below).

## Read-planning output shape to request

1. **Subsystem map** — 2-5 bullets on where the behavior lives.
2. **Focused read list** — paths / line ranges, each with why it matters.
3. **Anchors** — symbols, search terms, routes, config keys, line regions.
4. **Avoid for now** — files that look related but are off path.
5. **Uncertainty** — what could change the plan.

## Be patient — the local model is slow

The local model can take a while. **Wait** for it to return; prefer a long wait over assuming it stalled. Do **not** retry just because it is taking time. If a report is too vague, send **one** narrower follow-up (tighter question, specific paths/symbols/line ranges) before giving up.

## Common Mistakes

- **Asking it to judge.** It returns facts/anchors, not verdicts. Reframe as "where/what/which," then review yourself.
- **Calling the MCP tool inline for broad scouting** when the subagent wrapper would keep the main context lean.
- **Retrying on slowness.** It's slow by design; let it finish.
- **Skipping the scout** and reading broadly anyway — use the focused read list it gives you.
- **Treating a tool failure as "read it myself broadly."** If it fails, report the failure and that `pi` + the LM Studio provider need to be available; don't silently fan out broad reads.
