---
name: readsubagent
description: Use only outside debugging to scout unfamiliar repository areas, plan focused reads, or answer focused ordinary code/config/docs facts. Never use for failure diagnosis, regression or flaky-test investigation, incident response, unexpected-runtime investigation, or diagnostic artifacts.
---

# readsubagent — non-debug read planning via MCP and pi

`readsubagent` is a read-only codebase scout. It delegates factual file
inspection to a local model through the repo MCP server, which launches a
headless `pi` child and returns a concise cited report.

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

## Required execution path

Call the direct repo MCP tool `readsubagent`. Do not launch a Codex custom agent
or another subagent. The MCP server itself starts the headless `pi` child.

Pass a precise factual `question` and, when known, `path` or `paths`, `symbols`,
`searchTerms`, `lineRanges`, `output`, and a small `maxReportChars` budget.

## Supported non-debug work

- A short map of an unfamiliar subsystem.
- Candidate files and the smallest focused read list.
- Definition locations, symbols, search anchors, and exact line ranges.
- Focused ordinary code, configuration, or documentation facts.
- Areas to avoid for now and uncertainty that could change the read plan.

Prefer a subsystem map, candidate files, anchors, smallest focused read list,
avoid-for-now areas, and uncertainty. Do not ask for code review, bug finding,
correctness/security/maintainability/type-safety judgments, design, edit
strategies, implementation plans, or accept/reject decisions.

## Be patient

The local model can take a while. Wait rather than assuming it stalled, and do
not retry merely because it is slow. If a report is vague, make one narrower
follow-up call before falling back to broader reads.
