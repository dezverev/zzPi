#!/usr/bin/env bash
# Deny Copilot CLI's built-in explore subagent; use readsubagent for scouting.
set -u
BODY="$(cat 2>/dev/null)"
sub=""
if command -v jq >/dev/null 2>&1; then
  sub="$(printf '%s' "$BODY" | jq -r '.toolArgs.agentName // .toolArgs.agent_name // .toolArgs.agentType // .toolArgs.agent_type // .toolArgs.subagent_type // empty' 2>/dev/null)"
fi
if [ -z "$sub" ]; then
  sub="$(printf '%s' "$BODY" | tr '\n' ' ' | sed -n 's/.*"\(agentName\|agent_name\|agentType\|agent_type\|subagent_type\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/p' | head -n1)"
fi
[ "$(printf '%s' "$sub" | tr '[:upper:]' '[:lower:]')" = explore ] || exit 0
printf '%s\n' '{"permissionDecision":"deny","permissionDecisionReason":"The built-in explore subagent is disabled by this project readsubagent setup. For non-debug factual scouting/read planning only, use the readsubagent skill for subsystem maps, focused read lists, and symbol/line anchors; it calls zz_readsubagent/readsubagent directly. During debugging or failure investigation, do not use readsubagent: inspect source, logs, traces, failure output, and other diagnostic or root-cause evidence directly in the main agent or use the debugger. Use another agent only when the task genuinely needs judgment or edits."}'
