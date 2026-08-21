---
name: readsubagent
description: Use only outside debugging to scout unfamiliar repository areas, plan focused reads, or answer focused ordinary code/config/docs facts. Never use for failure diagnosis, regression or flaky-test investigation, incident response, unexpected-runtime investigation, or diagnostic artifacts.
---

# readsubagent — non-debug read planning via a local model

`readsubagent` is a read-only codebase scout. It delegates file inspection to a
local model through a headless `pi` child and returns a concise cited report
without loading large file contents into the main context.

## First gate: task context

Task context is the first gate, before file type or factuality. Do not use
`readsubagent` when debugging, diagnosing a failure, investigating a regression or flaky test,
handling an incident, or investigating unexpected runtime behavior.

In those contexts, the main agent or debugger must inspect source,
configuration, documentation, and diagnostic evidence directly. Never ask
`readsubagent` to scout the debug path, suggest evidence to inspect, summarize
evidence, or gather root-cause facts. Diagnostic evidence includes logs, stack
traces, crash reports, core dumps, test failure output, traces, profiler output,
runtime captures, screenshots produced for diagnosis, and similar artifacts.

A user-requested self-health check is the narrow exception: make one tiny
factual MCP call to verify that `readsubagent` itself responds. This does not
permit inspection of application debugging evidence.

## How to use it outside debugging

Call the direct MCP tool `zz_readsubagent/readsubagent`. Do not launch a Copilot
custom agent; the MCP server starts the headless `pi` child.

Give it a precise factual `question` and, when known, `path` or `paths`,
`symbols`, `searchTerms`, `lineRanges`, `output`, and a small `maxReportChars`
budget.

Supported work includes unfamiliar-subsystem scouting and focused ordinary
code, configuration, or documentation facts. Prefer this output:

1. **Subsystem map** — where behavior lives.
2. **Smallest focused read list** — the files or line ranges to read and why.
3. **Anchors** — symbols, search terms, routes, config keys, or line regions.
4. **Avoid for now** — related-looking areas that are off path.
5. **Uncertainty** — what could change the plan.

Do not ask for code review, bug finding, correctness/security/maintainability or
type-safety judgments, design, edit strategies, implementation plans, or
accept/reject decisions.

## Be patient

The local model can take a while. Wait rather than assuming it stalled. Do not
retry merely because it is slow. If a report is vague, send one narrower
follow-up before falling back to broader reads.
