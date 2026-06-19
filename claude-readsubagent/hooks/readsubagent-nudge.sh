#!/usr/bin/env bash
# Read-planning nudge for Claude Code projects with zz readsubagent installed.
#
# Reinforces the CLAUDE.md "Read Planning" workflow: before focused reads of
# unfamiliar implementation files, scout the area through `readsubagent` first
# (skill/subagent/direct MCP tool) to get a subsystem map + smallest focused
# read list, then read against anchors.
#
# Wired from .claude/settings.json two ways:
#   readsubagent-nudge.sh nudge   <- PreToolUse, matcher "Read"
#   readsubagent-nudge.sh reset   <- UserPromptSubmit (clears the per-turn flag)
#
# Behaviour: NON-BLOCKING. On the FIRST focused implementation-file read it
# emits hookSpecificOutput.additionalContext (a reminder injected into the
# reading agent's context) and exits 0 — the read still proceeds. The main
# thread gets one nudge per turn; each subagent gets one nudge of its own. The
# reminder is self-suppressing once you've scouted.

set -u

MODE="${1:-nudge}"
BODY="$(cat 2>/dev/null)"

STATE_DIR="${TMPDIR:-/tmp}/claude-readsubagent-nudge"
mkdir -p "$STATE_DIR" 2>/dev/null || true

# Best-effort session id (jq if present, else a sed fallback, else "default").
sid=""
if command -v jq >/dev/null 2>&1; then
  sid="$(printf '%s' "$BODY" | jq -r '.session_id // empty' 2>/dev/null)"
fi
if [ -z "$sid" ]; then
  sid="$(printf '%s' "$BODY" | tr '\n' ' ' \
    | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi
[ -n "$sid" ] || sid="default"
SENTINEL="$STATE_DIR/${sid}.nudged"

# New turn → clear the per-turn flag so the next read-cluster gets one reminder.
if [ "$MODE" = "reset" ]; then
  rm -f "$SENTINEL" 2>/dev/null || true
  exit 0
fi

# Key the per-turn flag. Subagent tool calls carry "agent_id" — give each
# subagent its own one-nudge budget keyed by agent_id (subagents share the
# parent's session_id, so session-keying would let the main thread's nudge
# suppress every subagent's). The main thread stays keyed by session_id and is
# cleared each turn by the UserPromptSubmit reset.
aid=""
if command -v jq >/dev/null 2>&1; then
  aid="$(printf '%s' "$BODY" | jq -r '.agent_id // empty' 2>/dev/null)"
fi
if [ -z "$aid" ]; then
  aid="$(printf '%s' "$BODY" | tr '\n' ' ' \
    | sed -n 's/.*"agent_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi
[ -n "$aid" ] && SENTINEL="$STATE_DIR/agent-${aid}.nudged"

# Already reminded (this turn for the main thread, once for this subagent).
[ -e "$SENTINEL" ] && exit 0

# Pull the path being read.
file=""
if command -v jq >/dev/null 2>&1; then
  file="$(printf '%s' "$BODY" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
fi
if [ -z "$file" ]; then
  file="$(printf '%s' "$BODY" | tr '\n' ' ' \
    | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi
[ -n "$file" ] || exit 0

# Only implementation code — not docs/config/manifests/lockfiles.
case "$file" in
  *.rs|*.ts|*.tsx|*.js|*.mjs|*.cjs|*.py) ;;
  *) exit 0 ;;
esac

# First focused impl read this turn: mark it and emit the reminder.
: > "$SENTINEL" 2>/dev/null || true

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Read-planning reminder: before focused reads of unfamiliar implementation files, scout the area FIRST with readsubagent — use the readsubagent skill/subagent, or call mcp__zz_readsubagent__readsubagent directly when you already know the targets — for a subsystem map and the smallest focused read list, then read against those anchors. Ignore this if you've already scouted here or are re-reading a known file."}}
JSON
exit 0
