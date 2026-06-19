#!/usr/bin/env bash
# Block Claude Code's Explore subagent; steer factual scouting to readsubagent.
#
# Hard-stop companion to readsubagent-nudge.sh. The CLAUDE.md "Read Planning"
# workflow says read-planning / factual file inspection goes through
# `readsubagent`; the Explore fan-out scout is exactly what that tooling
# replaces, so it is DENIED here outright.
#
# Wired from .claude/settings.json:
#   block-explore-subagent.sh   <- PreToolUse, matcher "Agent|Task"
#
# Behaviour: BLOCKING. When the spawned subagent_type is "Explore", emit
# hookSpecificOutput.permissionDecision "deny" with a steer message and exit 0.
# Every other subagent type (general-purpose, Plan, readsubagent, custom) is
# untouched — exit 0 with no output = allow.

set -u

BODY="$(cat 2>/dev/null)"

# Pull the requested subagent_type (jq if present, else a sed fallback).
sub=""
if command -v jq >/dev/null 2>&1; then
  sub="$(printf '%s' "$BODY" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null)"
fi
if [ -z "$sub" ]; then
  sub="$(printf '%s' "$BODY" | tr '\n' ' ' \
    | sed -n 's/.*"subagent_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi

# Only the Explore scout is blocked; everything else proceeds.
[ "$sub" = "Explore" ] || exit 0

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The Explore subagent is disabled by this project's readsubagent setup — it is exactly what the readsubagent tooling replaces (see CLAUDE.md 'Read Planning'). For a subsystem map, the smallest focused read list, symbol/line anchors, or any factual file inspection, use readsubagent instead: call mcp__zz_readsubagent__readsubagent inline when you already know the targets (pass question plus path/paths/symbols/searchTerms/lineRanges), or dispatch the readsubagent subagent/skill for the wrapped workflow. For fan-out that genuinely needs judgment or edits rather than factual reading, use a general-purpose or Plan agent — not Explore."}}
JSON
exit 0
