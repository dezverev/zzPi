#!/usr/bin/env bash
# zz Copilot readsubagent — repo-local installer for Linux / macOS / Git Bash.
#   cd /path/to/repo
#   curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-copilot-readsubagent.sh | bash
#
# Copilot/VS Code wrapper around the harness-neutral zz-readsubagent-mcp server.
# It installs the MCP server at ./.zz-mcp/zz-readsubagent-mcp.py, registers the
# zz_readsubagent server in ./.vscode/mcp.json, and adds repo
# ./.github/copilot-instructions.md guidance. The MCP server spawns a headless
# `pi` child on a local Qwen model (via LM Studio).
set -euo pipefail

usage() {
  cat <<'EOF'
install-copilot-readsubagent.sh [options]

Options:
  --project-dir DIR          Target repo/project dir (default: current directory).
  --model SELECTOR           pi model selector (default: lm-studio/qwen/qwen3.6-35b-a3b).
  --pi-bin NAME              pi executable name/path for the MCP server (default: pi).
  --skip-mcp                 Do not add/update the zz_readsubagent server in .vscode/mcp.json.
  --skip-instructions        Do not add/update .github/copilot-instructions.md guidance.
  --skip-copilot-instructions
                              Alias for --skip-instructions.
  --force                    Claim/overwrite existing unowned readsubagent files/entries.
  --dry-run                  Show the install plan without writing files.
  -h, --help                 Show this help.

Environment:
  ZZ_DASH_URL                           Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_READSUBAGENT_MCP_URL               MCP server source URL (default: $ZZ_DASH_URL/zz-readsubagent-mcp)
  ZZ_COPILOT_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_COPILOT_READSUBAGENT_MODEL         pi model selector
  ZZ_COPILOT_READSUBAGENT_PI_BIN        pi executable name/path
  ZZ_COPILOT_READSUBAGENT_SKIP_MCP=1
  ZZ_COPILOT_READSUBAGENT_SKIP_INSTRUCTIONS=1
  ZZ_COPILOT_READSUBAGENT_FORCE=1
  ZZ_COPILOT_READSUBAGENT_DRY_RUN=1
  ZZ_COPILOT_READSUBAGENT_ALLOW_SUBDIR=1

Requires `pi` on PATH with the LM Studio (lm-studio) provider available so the
model selector resolves (install the repo-local pi plugs, or define a global Pi
lm-studio provider), and LM Studio reachable. In VS Code/Copilot, approve or
enable the workspace MCP server if prompted.
EOF
}

DEFAULT_HOST="https://raw.githubusercontent.com/dezverev/zzPi/main"
HOST_BASE="${ZZ_DASH_URL:-$DEFAULT_HOST}"
MCP_SOURCE_BASE="${ZZ_READSUBAGENT_MCP_URL:-${HOST_BASE%/}/zz-readsubagent-mcp}"
MCP_SOURCE_BASE="${MCP_SOURCE_BASE%/}"
PROJECT_DIR="${ZZ_COPILOT_READSUBAGENT_PROJECT_DIR:-$PWD}"
MODEL="${ZZ_COPILOT_READSUBAGENT_MODEL:-lm-studio/qwen/qwen3.6-35b-a3b}"
PI_BIN="${ZZ_COPILOT_READSUBAGENT_PI_BIN:-pi}"
SKIP_MCP="${ZZ_COPILOT_READSUBAGENT_SKIP_MCP:-0}"
SKIP_INSTRUCTIONS="${ZZ_COPILOT_READSUBAGENT_SKIP_INSTRUCTIONS:-0}"
FORCE="${ZZ_COPILOT_READSUBAGENT_FORCE:-0}"
DRY_RUN="${ZZ_COPILOT_READSUBAGENT_DRY_RUN:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-dir) [ "$#" -ge 2 ] || { echo "--project-dir needs a value" >&2; exit 2; }; PROJECT_DIR="$2"; shift 2 ;;
    --project-dir=*) PROJECT_DIR="${1#*=}"; shift ;;
    --model) [ "$#" -ge 2 ] || { echo "--model needs a value" >&2; exit 2; }; MODEL="$2"; shift 2 ;;
    --model=*) MODEL="${1#*=}"; shift ;;
    --pi-bin) [ "$#" -ge 2 ] || { echo "--pi-bin needs a value" >&2; exit 2; }; PI_BIN="$2"; shift 2 ;;
    --pi-bin=*) PI_BIN="${1#*=}"; shift ;;
    --skip-mcp) SKIP_MCP=1; shift ;;
    --skip-instructions|--skip-copilot-instructions) SKIP_INSTRUCTIONS=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "install-copilot-readsubagent.sh needs curl" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "install-copilot-readsubagent.sh needs python3" >&2; exit 1; }

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd -P)"

if [ -z "${ZZ_COPILOT_READSUBAGENT_ALLOW_SUBDIR:-}" ] && command -v git >/dev/null 2>&1; then
  if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GIT_ROOT="$(git -C "$PROJECT_DIR" rev-parse --show-toplevel)"
    GIT_ROOT="$(cd "$GIT_ROOT" && pwd -P)"
    if [ "$PROJECT_DIR" != "$GIT_ROOT" ]; then
      echo "Refusing to install into a git subdirectory:" >&2
      echo "  current: $PROJECT_DIR" >&2
      echo "  repo root: $GIT_ROOT" >&2
      echo "Run this from the repo root, or set ZZ_COPILOT_READSUBAGENT_PROJECT_DIR=$GIT_ROOT." >&2
      exit 1
    fi
  fi
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

SERVER_TMP="$TMP_DIR/zz-readsubagent-mcp.py"
curl -fsSL "$MCP_SOURCE_BASE/zz-readsubagent-mcp.py" -o "$SERVER_TMP"

PI_WARNING=""
if ! command -v "$PI_BIN" >/dev/null 2>&1; then
  PI_WARNING="WARNING: '$PI_BIN' not found on PATH. The readsubagent MCP tool needs pi with the LM Studio (lm-studio) provider available."
fi

python3 - "$PROJECT_DIR" "$SERVER_TMP" "$MCP_SOURCE_BASE" "$MODEL" "$PI_BIN" "$SKIP_MCP" "$SKIP_INSTRUCTIONS" "$FORCE" "$DRY_RUN" <<'PY'
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

project_dir = Path(sys.argv[1]).resolve()
server_tmp = Path(sys.argv[2]).resolve()
source_base = sys.argv[3].rstrip("/")
model = sys.argv[4]
pi_bin = sys.argv[5]
skip_mcp = sys.argv[6].strip().lower() in {"1", "true", "yes", "on"}
skip_instructions = sys.argv[7].strip().lower() in {"1", "true", "yes", "on"}
force = sys.argv[8].strip().lower() in {"1", "true", "yes", "on"}
dry_run = sys.argv[9].strip().lower() in {"1", "true", "yes", "on"}

rel_server = ".zz-mcp/zz-readsubagent-mcp.py"
server_target = project_dir / rel_server
mcp_json = project_dir / ".vscode" / "mcp.json"
instructions_md = project_dir / ".github" / "copilot-instructions.md"
manifest_path = project_dir / ".github" / "zz-copilot-readsubagent-manifest.json"

SERVER_NAME = "zz_readsubagent"
SERVER_ARGS_PATH = ".zz-mcp/zz-readsubagent-mcp.py"
MARKER_START = "<!-- zz-copilot-readsubagent:start -->"
MARKER_END = "<!-- zz-copilot-readsubagent:end -->"
COPILOT_BLOCK = f"""{MARKER_START}
## Read Planning

Before doing focused reads of specific implementation files, ask Copilot to use
the `readsubagent` tool from the `zz_readsubagent` MCP server to get a
read-planning pass. The tool delegates to a local model via `pi` and returns a
concise factual report with paths and line ranges.

Use `readsubagent` to get:

- A short map of the relevant subsystem.
- Candidate files and directories, with reasons.
- The smallest focused read list for the main agent.
- Search terms, symbols, or line anchors that should guide the focused reads.
- Files or areas that look related but should be avoided for now.
- Uncertainty or follow-up questions that could change the read plan.

The local model can be slow. Allow a long wait for `readsubagent`; prefer
waiting over assuming it stalled.

The main agent should then read only the recommended files or sections first.
Expand beyond that list only when the focused reads reveal a concrete reason.

Use `readsubagent` only for factual read planning and file inspection. Do not
ask it to create implementation plans, choose edit strategies, review code,
find bugs, judge correctness, or validate type/control-flow safety. For those
tasks, do direct focused reads in the main thread or use a review-focused agent
when one is available.

When to skip readsubagent (Exceptions):

- You already know the exact files and lines you need to read (no ambiguity).
- The user names exact files or asks for an immediate direct read.
- The needed context is already in the current thread.
- A tool or environment limitation prevents using the MCP tool.

**Crucial rule for ambiguity:** The decision to use `readsubagent` is about *knowledge*, not tool-call count. If there is *any ambiguity* about where to look or what to read, do NOT do exploratory manual reads (like `find`, `ls`, or `grep` to hunt around). Instead, ask Copilot to call the `readsubagent` MCP tool with a targeted question to clear the ambiguity and tell you exactly where and what to read.

When an exception applies, mention it briefly and continue with the smallest
reasonable focused read.
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


def ensure_file(rel: str, target: Path, tmp: Path) -> str:
    if target.exists() and not manifest_owns(rel) and not force:
        if target.read_bytes() != tmp.read_bytes():
            raise SystemExit(
                f"Refusing to overwrite existing unowned {rel}. Use --force if you want this installer to claim it."
            )
        return f"unchanged existing matching {rel}"
    if dry_run:
        action = "update" if target.exists() else "create"
        return f"would {action} {rel}"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(tmp.read_bytes())
    return f"installed {rel}"


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


def ensure_vscode_mcp() -> str:
    if skip_mcp:
        return "skipped .vscode/mcp.json registration"
    data: dict = {}
    if mcp_json.exists():
        try:
            loaded = json.loads(mcp_json.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except Exception as exc:
            raise SystemExit(f"Refusing to edit malformed .vscode/mcp.json: {exc}")
    servers = data.get("servers")
    if not isinstance(servers, dict):
        servers = {}
    existing = servers.get(SERVER_NAME)
    managed = SERVER_NAME in (load_manifest().get("managed_servers") or [])
    if isinstance(existing, dict) and not managed and not force:
        return f"preserved existing unmanaged {SERVER_NAME} server in .vscode/mcp.json"
    if dry_run:
        verb = "update" if isinstance(existing, dict) else "add"
        return f"would {verb} {SERVER_NAME} server in .vscode/mcp.json"
    servers[SERVER_NAME] = server_entry()
    data["servers"] = servers
    mcp_json.parent.mkdir(parents=True, exist_ok=True)
    mcp_json.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return f"registered {SERVER_NAME} server in .vscode/mcp.json"


def ensure_instructions() -> str:
    if skip_instructions:
        return "skipped .github/copilot-instructions.md guidance"
    if dry_run:
        return "would add/update .github/copilot-instructions.md read-planning block"
    existing = instructions_md.read_text(encoding="utf-8") if instructions_md.exists() else "# Copilot Instructions\n"
    next_text, replaced = replace_marked_block(existing, MARKER_START, MARKER_END, COPILOT_BLOCK)
    instructions_md.parent.mkdir(parents=True, exist_ok=True)
    instructions_md.write_text(next_text.rstrip() + "\n", encoding="utf-8")
    return (
        "updated .github/copilot-instructions.md read-planning block"
        if replaced
        else "added .github/copilot-instructions.md read-planning block"
    )


actions = [
    ensure_file(rel_server, server_target, server_tmp),
    ensure_vscode_mcp(),
    ensure_instructions(),
]

if not dry_run:
    managed_blocks = [".github/copilot-instructions.md:zz-copilot-readsubagent" if not skip_instructions else ""]
    state = {
        "installer": "zz-copilot-readsubagent",
        "schemaVersion": 1,
        "source_url": source_base,
        "owned_files": [rel_server],
        "managed_blocks": [item for item in managed_blocks if item],
        "managed_servers": [] if skip_mcp else [SERVER_NAME],
        "file_hashes": {rel_server: sha256(server_target)},
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
print("  zz Copilot readsubagent install plan" if dry_run else "  zz Copilot readsubagent installed")
for action in actions:
    print(f"  -> {action}")
print(f"  -> model: {model}")
print(f"  -> target repo: {project_dir}")
print(f"  -> source: {source_base}")
if not dry_run:
    print("  -> open VS Code/Copilot Chat in this repo and approve or enable the zz_readsubagent MCP server when prompted")
PY

if [ -n "$PI_WARNING" ]; then
  echo "  -> $PI_WARNING"
fi
