#!/usr/bin/env bash
# zz Claude readsubagent — repo-local installer for Linux / macOS / Git Bash.
#   cd /path/to/repo
#   curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-claude-readsubagent.sh | bash
#
# Thin Claude Code wrapper around the harness-neutral zz-readsubagent-mcp server.
# It installs the MCP server at ./.zz-mcp/zz-readsubagent-mcp.py, registers the
# zz_readsubagent server in ./.mcp.json, writes the ./.claude/agents/readsubagent.md
# subagent (restricted to that one MCP tool), installs the readsubagent skill and
# hooks, merges ./.claude/settings.json hook entries, and adds repo CLAUDE.md guidance.
# The MCP server spawns a headless `pi` child on a local Qwen model (via LM Studio).
set -euo pipefail

usage() {
  cat <<'EOF'
install-claude-readsubagent.sh [options]

Options:
  --project-dir DIR       Target repo/project dir (default: current directory).
  --model SELECTOR        pi model selector (default: lm-studio/qwen/qwen3.6-35b-a3b).
  --pi-bin NAME           pi executable name/path for the MCP server (default: pi).
  --skip-mcp              Do not add/update the zz_readsubagent server in .mcp.json.
  --skip-claude-md        Do not add/update the repo CLAUDE.md guidance block.
  --skip-hooks            Do not install hooks or merge .claude/settings.json.
  --skip-skill            Do not install the readsubagent Claude skill.
  --force                 Claim/overwrite existing unowned readsubagent files.
  --dry-run               Show the install plan without writing files.
  -h, --help              Show this help.

Environment:
  ZZ_DASH_URL                          Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_CLAUDE_READSUBAGENT_URL           Subagent source URL (default: $ZZ_DASH_URL/claude-readsubagent)
  ZZ_READSUBAGENT_MCP_URL              MCP server source URL (default: $ZZ_DASH_URL/zz-readsubagent-mcp)
  ZZ_CLAUDE_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_CLAUDE_READSUBAGENT_MODEL         pi model selector
  ZZ_CLAUDE_READSUBAGENT_PI_BIN        pi executable name/path
  ZZ_CLAUDE_READSUBAGENT_SKIP_MCP=1
  ZZ_CLAUDE_READSUBAGENT_SKIP_CLAUDE_MD=1
  ZZ_CLAUDE_READSUBAGENT_SKIP_HOOKS=1
  ZZ_CLAUDE_READSUBAGENT_SKIP_SKILL=1
  ZZ_CLAUDE_READSUBAGENT_FORCE=1
  ZZ_CLAUDE_READSUBAGENT_DRY_RUN=1
  ZZ_CLAUDE_READSUBAGENT_ALLOW_SUBDIR=1

Requires `pi` on PATH with the LM Studio (lm-studio) provider available so the
model selector resolves (install the repo-local pi plugs, or define a global Pi
lm-studio provider), and LM Studio reachable.
EOF
}

DEFAULT_HOST="https://raw.githubusercontent.com/dezverev/zzPi/main"
HOST_BASE="${ZZ_DASH_URL:-$DEFAULT_HOST}"
AGENT_SOURCE_BASE="${ZZ_CLAUDE_READSUBAGENT_URL:-${HOST_BASE%/}/claude-readsubagent}"
AGENT_SOURCE_BASE="${AGENT_SOURCE_BASE%/}"
MCP_SOURCE_BASE="${ZZ_READSUBAGENT_MCP_URL:-${HOST_BASE%/}/zz-readsubagent-mcp}"
MCP_SOURCE_BASE="${MCP_SOURCE_BASE%/}"
PROJECT_DIR="${ZZ_CLAUDE_READSUBAGENT_PROJECT_DIR:-$PWD}"
MODEL="${ZZ_CLAUDE_READSUBAGENT_MODEL:-lm-studio/qwen/qwen3.6-35b-a3b}"
PI_BIN="${ZZ_CLAUDE_READSUBAGENT_PI_BIN:-pi}"
SKIP_MCP="${ZZ_CLAUDE_READSUBAGENT_SKIP_MCP:-0}"
SKIP_CLAUDE_MD="${ZZ_CLAUDE_READSUBAGENT_SKIP_CLAUDE_MD:-0}"
SKIP_HOOKS="${ZZ_CLAUDE_READSUBAGENT_SKIP_HOOKS:-0}"
SKIP_SKILL="${ZZ_CLAUDE_READSUBAGENT_SKIP_SKILL:-0}"
FORCE="${ZZ_CLAUDE_READSUBAGENT_FORCE:-0}"},{
DRY_RUN="${ZZ_CLAUDE_READSUBAGENT_DRY_RUN:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-dir) [ "$#" -ge 2 ] || { echo "--project-dir needs a value" >&2; exit 2; }; PROJECT_DIR="$2"; shift 2 ;;
    --project-dir=*) PROJECT_DIR="${1#*=}"; shift ;;
    --model) [ "$#" -ge 2 ] || { echo "--model needs a value" >&2; exit 2; }; MODEL="$2"; shift 2 ;;
    --model=*) MODEL="${1#*=}"; shift ;;
    --pi-bin) [ "$#" -ge 2 ] || { echo "--pi-bin needs a value" >&2; exit 2; }; PI_BIN="$2"; shift 2 ;;
    --pi-bin=*) PI_BIN="${1#*=}"; shift ;;
    --skip-mcp) SKIP_MCP=1; shift ;;
    --skip-claude-md) SKIP_CLAUDE_MD=1; shift ;;
    --skip-hooks) SKIP_HOOKS=1; shift ;;
    --skip-skill) SKIP_SKILL=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "install-claude-readsubagent.sh needs curl" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "install-claude-readsubagent.sh needs python3" >&2; exit 1; }

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd -P)"

if [ -z "${ZZ_CLAUDE_READSUBAGENT_ALLOW_SUBDIR:-}" ] && command -v git >/dev/null 2>&1; then
  if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GIT_ROOT="$(git -C "$PROJECT_DIR" rev-parse --show-toplevel)"
    GIT_ROOT="$(cd "$GIT_ROOT" && pwd -P)"
    if [ "$PROJECT_DIR" != "$GIT_ROOT" ]; then
      echo "Refusing to install into a git subdirectory:" >&2
      echo "  current: $PROJECT_DIR" >&2
      echo "  repo root: $GIT_ROOT" >&2
      echo "Run this from the repo root, or set ZZ_CLAUDE_READSUBAGENT_PROJECT_DIR=$GIT_ROOT." >&2
      exit 1
    fi
  fi
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

AGENT_TMP="$TMP_DIR/readsubagent.md"
SERVER_TMP="$TMP_DIR/zz-readsubagent-mcp.py"
HOOK_NUDGE_TMP="$TMP_DIR/readsubagent-nudge.sh"
HOOK_BLOCK_EXPLORE_TMP="$TMP_DIR/block-explore-subagent.sh"
HOOK_NUDGE_PS1_TMP="$TMP_DIR/readsubagent-nudge.ps1"
HOOK_BLOCK_EXPLORE_PS1_TMP="$TMP_DIR/block-explore-subagent.ps1"
SKILL_TMP="$TMP_DIR/SKILL.md"
curl -fsSL "$AGENT_SOURCE_BASE/readsubagent.md" -o "$AGENT_TMP"
curl -fsSL "$MCP_SOURCE_BASE/zz-readsubagent-mcp.py" -o "$SERVER_TMP"
case "$(printf '%s' "$SKIP_HOOKS" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ;;
  *)
    curl -fsSL "$AGENT_SOURCE_BASE/hooks/readsubagent-nudge.sh" -o "$HOOK_NUDGE_TMP"
    curl -fsSL "$AGENT_SOURCE_BASE/hooks/block-explore-subagent.sh" -o "$HOOK_BLOCK_EXPLORE_TMP"
    curl -fsSL "$AGENT_SOURCE_BASE/hooks/readsubagent-nudge.ps1" -o "$HOOK_NUDGE_PS1_TMP"
    curl -fsSL "$AGENT_SOURCE_BASE/hooks/block-explore-subagent.ps1" -o "$HOOK_BLOCK_EXPLORE_PS1_TMP"
    ;;
esac
case "$(printf '%s' "$SKIP_SKILL" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ;;
  *) curl -fsSL "$AGENT_SOURCE_BASE/skills/readsubagent/SKILL.md" -o "$SKILL_TMP" ;;
esac

PI_WARNING=""
if ! command -v "$PI_BIN" >/dev/null 2>&1; then
  PI_WARNING="WARNING: '$PI_BIN' not found on PATH. The readsubagent MCP tool needs pi with the LM Studio (lm-studio) provider available."
fi

python3 - "$PROJECT_DIR" "$AGENT_TMP" "$SERVER_TMP" "$HOOK_NUDGE_TMP" "$HOOK_BLOCK_EXPLORE_TMP" "$HOOK_NUDGE_PS1_TMP" "$HOOK_BLOCK_EXPLORE_PS1_TMP" "$SKILL_TMP" "$AGENT_SOURCE_BASE" "$MCP_SOURCE_BASE" "$MODEL" "$PI_BIN" "$SKIP_MCP" "$SKIP_CLAUDE_MD" "$SKIP_HOOKS" "$SKIP_SKILL" "$FORCE" "$DRY_RUN" <<'PY'
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

project_dir = Path(sys.argv[1]).resolve()
agent_tmp = Path(sys.argv[2]).resolve()
server_tmp = Path(sys.argv[3]).resolve()
hook_nudge_tmp = Path(sys.argv[4]).resolve()
hook_block_explore_tmp = Path(sys.argv[5]).resolve()
hook_nudge_ps1_tmp = Path(sys.argv[6]).resolve()
hook_block_explore_ps1_tmp = Path(sys.argv[7]).resolve()
skill_tmp = Path(sys.argv[8]).resolve()
source_base = sys.argv[9].rstrip("/")
mcp_source_base = sys.argv[10].rstrip("/")
model = sys.argv[11]
pi_bin = sys.argv[12]
skip_mcp = sys.argv[13].strip().lower() in {"1", "true", "yes", "on"}
skip_claude_md = sys.argv[14].strip().lower() in {"1", "true", "yes", "on"}
skip_hooks = sys.argv[15].strip().lower() in {"1", "true", "yes", "on"}
skip_skill = sys.argv[16].strip().lower() in {"1", "true", "yes", "on"}
force = sys.argv[17].strip().lower() in {"1", "true", "yes", "on"}
dry_run = sys.argv[18].strip().lower() in {"1", "true", "yes", "on"}

rel_agent = ".claude/agents/readsubagent.md"
rel_hook_nudge = ".claude/hooks/readsubagent-nudge.sh"
rel_hook_block_explore = ".claude/hooks/block-explore-subagent.sh"
rel_hook_nudge_ps1 = ".claude/hooks/readsubagent-nudge.ps1"
rel_hook_block_explore_ps1 = ".claude/hooks/block-explore-subagent.ps1"
rel_skill = ".claude/skills/readsubagent/SKILL.md"
rel_server = ".zz-mcp/zz-readsubagent-mcp.py"
agent_target = project_dir / rel_agent
hook_nudge_target = project_dir / rel_hook_nudge
hook_block_explore_target = project_dir / rel_hook_block_explore
hook_nudge_ps1_target = project_dir / rel_hook_nudge_ps1
hook_block_explore_ps1_target = project_dir / rel_hook_block_explore_ps1
skill_target = project_dir / rel_skill
server_target = project_dir / rel_server
settings_json = project_dir / ".claude" / "settings.json"
mcp_json = project_dir / ".mcp.json"
claude_md = project_dir / "CLAUDE.md"
manifest_path = project_dir / ".claude" / "zz-claude-readsubagent-manifest.json"

SERVER_NAME = "zz_readsubagent"
SERVER_ARGS_PATH = ".zz-mcp/zz-readsubagent-mcp.py"
MARKER_START = "<!-- zz-claude-readsubagent:start -->"
MARKER_END = "<!-- zz-claude-readsubagent:end -->"
CLAUDE_BLOCK = f"""{MARKER_START}
## Read Planning

Before doing focused reads of specific implementation files, start with a
read-planning pass through `readsubagent`, which delegates to a local model
(Qwen via LM Studio, through a headless `pi` child).

`readsubagent` is reachable three equivalent ways — use whichever fits:

- the **`readsubagent` skill** (via the Skill tool),
- the **`readsubagent` subagent** (`Agent(subagent_type=\"readsubagent\")`), and
- the **direct MCP tool `mcp__zz_readsubagent__readsubagent`**, served by
  `.zz-mcp/zz-readsubagent-mcp.py`.

Prefer the **direct MCP tool** when you already know the targets: it is the
lowest-overhead path and gives the most control. Pass `question` (required) plus
any of `path`/`paths`, `symbols`, `searchTerms`, `lineRanges`, `output`, and
`maxReportChars` to scope the inspection. Reach for the skill or subagent when
you want the wrapped read-planning workflow instead.

Use `readsubagent` (any entry point) to get a short subsystem map, candidate
files, the smallest focused read list, useful search terms/line anchors, areas
to avoid, and uncertainty or follow-up questions.

The local model can be slow. Allow a long wait for `readsubagent`; prefer
waiting over assuming it stalled. Use it only for factual read planning and file
inspection, not implementation planning or code-review judgments.
{MARKER_END}
"""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_manifest() -> dict:
    if not manifest_path.is_file():
        return {}
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def manifest_owns(rel: str) -> bool:
    owned = load_manifest().get("owned_files")
    return isinstance(owned, list) and rel in owned


def replace_marked_block(text: str, start: str, end: str, block: str) -> tuple[str, bool]:
    pattern = re.compile(rf"{re.escape(start)}.*?{re.escape(end)}", re.S)
    if pattern.search(text):
        return pattern.sub(block.rstrip(), text), True
    return text.rstrip() + ("\n\n" if text.strip() else "") + block.rstrip(), False


def ensure_file(rel: str, target: Path, tmp: Path, *, executable: bool = False) -> str:
    if target.exists() and not manifest_owns(rel) and not force:
        if target.read_bytes() != tmp.read_bytes():
            raise SystemExit(
                f"Refusing to overwrite existing unowned {rel}. Use --force if you want this installer to claim it."
            )
        if executable and not dry_run:
            target.chmod(target.stat().st_mode | 0o755)
        return f"unchanged existing matching {rel}"
    if dry_run:
        action = "update" if target.exists() else "create"
        return f"would {action} {rel}"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(tmp.read_bytes())
    if executable:
        target.chmod(target.stat().st_mode | 0o755)
    return f"installed {rel}"


HOOK_NUDGE_COMMAND = '"${CLAUDE_PROJECT_DIR}/.claude/hooks/readsubagent-nudge.sh" nudge'
HOOK_RESET_COMMAND = '"${CLAUDE_PROJECT_DIR}/.claude/hooks/readsubagent-nudge.sh" reset'
HOOK_BLOCK_EXPLORE_COMMAND = '"${CLAUDE_PROJECT_DIR}/.claude/hooks/block-explore-subagent.sh"'


def hook_entry(command: str, matcher: str | None = None) -> dict:
    entry: dict = {"hooks": [{"type": "command", "command": command, "timeout": 5}]}
    if matcher is not None:
        entry["matcher"] = matcher
    return entry


def entry_has_command(entry: object, command: str) -> bool:
    if not isinstance(entry, dict):
        return False
    hooks = entry.get("hooks")
    if not isinstance(hooks, list):
        return False
    return any(isinstance(hook, dict) and hook.get("command") == command for hook in hooks)


def ensure_hook_event(settings: dict, event: str, entry: dict, command: str) -> bool:
    hooks_root = settings.setdefault("hooks", {})
    if not isinstance(hooks_root, dict):
        raise SystemExit("Refusing to edit .claude/settings.json because hooks is not an object")
    event_entries = hooks_root.get(event)
    if event_entries is None:
        event_entries = []
        hooks_root[event] = event_entries
    if not isinstance(event_entries, list):
        raise SystemExit(f"Refusing to edit .claude/settings.json because hooks.{event} is not a list")
    if any(entry_has_command(existing, command) for existing in event_entries):
        return False
    event_entries.append(entry)
    return True


def ensure_settings_hooks() -> str:
    if skip_hooks:
        return "skipped Claude readsubagent hooks"
    if dry_run:
        return "would merge readsubagent hooks into .claude/settings.json"
    data: dict = {}
    if settings_json.exists():
        try:
            loaded = json.loads(settings_json.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
            else:
                raise ValueError("root is not an object")
        except Exception as exc:
            raise SystemExit(f"Refusing to edit malformed .claude/settings.json: {exc}")
    changed = False
    changed |= ensure_hook_event(data, "PreToolUse", hook_entry(HOOK_NUDGE_COMMAND, "Read"), HOOK_NUDGE_COMMAND)
    changed |= ensure_hook_event(data, "PreToolUse", hook_entry(HOOK_BLOCK_EXPLORE_COMMAND, "Agent|Task"), HOOK_BLOCK_EXPLORE_COMMAND)
    changed |= ensure_hook_event(data, "UserPromptSubmit", hook_entry(HOOK_RESET_COMMAND), HOOK_RESET_COMMAND)
    settings_json.parent.mkdir(parents=True, exist_ok=True)
    settings_json.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return "merged readsubagent hooks into .claude/settings.json" if changed else "readsubagent hooks already present in .claude/settings.json"


def server_entry() -> dict:
    env = {"ZZ_READSUBAGENT_MODEL": model}
    if pi_bin != "pi":
        env["ZZ_READSUBAGENT_PI_BIN"] = pi_bin
    return {
        "type": "stdio",
        "command": "python3",
        "args": [SERVER_ARGS_PATH],
        "env": env,
    }


def ensure_mcp() -> str:
    if skip_mcp:
        return "skipped .mcp.json registration"
    data: dict = {}
    if mcp_json.exists():
        try:
            loaded = json.loads(mcp_json.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except Exception as exc:
            raise SystemExit(f"Refusing to edit malformed .mcp.json: {exc}")
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    existing = servers.get(SERVER_NAME)
    managed = SERVER_NAME in (load_manifest().get("managed_servers") or [])
    if isinstance(existing, dict) and not managed and not force:
        return f"preserved existing unmanaged {SERVER_NAME} server in .mcp.json"
    if dry_run:
        verb = "update" if isinstance(existing, dict) else "add"
        return f"would {verb} {SERVER_NAME} server in .mcp.json"
    servers[SERVER_NAME] = server_entry()
    data["mcpServers"] = servers
    mcp_json.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return f"registered {SERVER_NAME} server in .mcp.json"


def ensure_claude_md() -> str:
    if skip_claude_md:
        return "skipped CLAUDE.md guidance"
    if dry_run:
        return "would add/update CLAUDE.md read-planning block"
    existing = claude_md.read_text(encoding="utf-8") if claude_md.exists() else "# Project Guidance\n"
    next_text, replaced = replace_marked_block(existing, MARKER_START, MARKER_END, CLAUDE_BLOCK)
    claude_md.write_text(next_text.rstrip() + "\n", encoding="utf-8")
    return "updated CLAUDE.md read-planning block" if replaced else "added CLAUDE.md read-planning block"


actions = [
    ensure_file(rel_agent, agent_target, agent_tmp),
    ensure_file(rel_server, server_target, server_tmp),
]
if skip_hooks:
    actions.append("skipped Claude readsubagent hook files")
else:
    actions.extend([
        ensure_file(rel_hook_nudge, hook_nudge_target, hook_nudge_tmp, executable=True),
        ensure_file(rel_hook_block_explore, hook_block_explore_target, hook_block_explore_tmp, executable=True),
        ensure_file(rel_hook_nudge_ps1, hook_nudge_ps1_target, hook_nudge_ps1_tmp),
        ensure_file(rel_hook_block_explore_ps1, hook_block_explore_ps1_target, hook_block_explore_ps1_tmp),
    ])
if skip_skill:
    actions.append("skipped Claude readsubagent skill")
else:
    actions.append(ensure_file(rel_skill, skill_target, skill_tmp))
actions.extend([
    ensure_settings_hooks(),
    ensure_mcp(),
    ensure_claude_md(),
])

if not dry_run:
    owned_files = [rel_agent, rel_server]
    if not skip_hooks:
        owned_files.extend([rel_hook_nudge, rel_hook_block_explore, rel_hook_nudge_ps1, rel_hook_block_explore_ps1])
    if not skip_skill:
        owned_files.append(rel_skill)
    managed_blocks = ["CLAUDE.md:zz-claude-readsubagent" if not skip_claude_md else ""]
    state = {
        "installer": "zz-claude-readsubagent",
        "schemaVersion": 1,
        "source_url": source_base,
        "mcp_source_url": mcp_source_base,
        "owned_files": owned_files,
        "managed_blocks": [item for item in managed_blocks if item],
        "managed_settings": [] if skip_hooks else [".claude/settings.json:readsubagent-hooks"],
        "managed_servers": [] if skip_mcp else [SERVER_NAME],
        "file_hashes": {rel: sha256(project_dir / rel) for rel in owned_files},
        "server": {
            "name": SERVER_NAME,
            "model": model,
            "pi_bin": pi_bin,
            "config_path": str(mcp_json),
            "managed": not skip_mcp,
        },
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

print("")
print("  zz Claude readsubagent install plan" if dry_run else "  zz Claude readsubagent installed")
for action in actions:
    print(f"  -> {action}")
print(f"  -> model: {model}")
print(f"  -> target repo: {project_dir}")
print(f"  -> sources: {source_base} + zz-readsubagent-mcp")
if not dry_run:
    print("  -> open Claude Code in this repo and approve the zz_readsubagent MCP server when prompted")
PY

if [ -n "$PI_WARNING" ]; then
  echo "  -> $PI_WARNING"
fi
