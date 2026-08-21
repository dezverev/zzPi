#!/usr/bin/env bash
# Non-blocking Copilot CLI reminder on the first implementation-file view per turn.
set -u
MODE="${1:-nudge}"
BODY="$(cat 2>/dev/null)"
STATE_DIR="${TMPDIR:-/tmp}/copilot-readsubagent-nudge"
mkdir -p "$STATE_DIR" 2>/dev/null || true
sid=""
if command -v jq >/dev/null 2>&1; then
  sid="$(printf '%s' "$BODY" | jq -r '.sessionId // .session_id // empty' 2>/dev/null)"
fi
[ -n "$sid" ] || sid="$(printf '%s' "$BODY" | tr '\n' ' ' | sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$sid" ] || sid="default"
SENTINEL="$STATE_DIR/${sid}.nudged"
if [ "$MODE" = reset ]; then rm -f "$SENTINEL" 2>/dev/null || true; exit 0; fi
[ -e "$SENTINEL" ] && exit 0
file=""
if command -v jq >/dev/null 2>&1; then
  file="$(printf '%s' "$BODY" | jq -r '.toolArgs.path // .toolArgs.filePath // .toolArgs.file_path // empty' 2>/dev/null)"
fi
if [ -z "$file" ]; then
  file="$(printf '%s' "$BODY" | tr '\n' ' ' | sed -n 's/.*"\(path\|filePath\|file_path\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/p' | head -n1)"
fi
case "$file" in *.rs|*.ts|*.tsx|*.js|*.mjs|*.cjs|*.py) ;; *) exit 0 ;; esac
: > "$SENTINEL" 2>/dev/null || true
printf '%s\n' '{"additionalContext":"Read-planning reminder: outside debugging, before focused reads of unfamiliar implementation files, scout the area FIRST with readsubagent—use the readsubagent skill, which calls zz_readsubagent/readsubagent directly—for a subsystem map and the smallest focused read list. Ignore this scouting nudge during debugging or failure investigation; inspect logs, traces, failure output, and other diagnostic or root-cause evidence directly in the main agent or use the debugger. Otherwise, ignore this if you already scouted here or are re-reading a known file."}'
