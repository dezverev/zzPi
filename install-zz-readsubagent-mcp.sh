#!/usr/bin/env bash
# zz readsubagent MCP server — harness-neutral repo-local installer.
#   cd /path/to/repo
#   curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-zz-readsubagent-mcp.sh | bash
#
# Drops the single stdio MCP server file at ./.zz-mcp/zz-readsubagent-mcp.py and
# prints how to register it in any MCP-capable harness. The server spawns a
# headless `pi` child on a local Qwen model (via LM Studio) to do read planning.
#
# This is the reusable core. For a ready-made Claude Code subagent wrapper, use
# install-claude-readsubagent.sh instead (it installs this server and wraps it).
set -euo pipefail

usage() {
  cat <<'EOF'
install-zz-readsubagent-mcp.sh [options]

Options:
  --project-dir DIR   Target repo/project dir (default: current directory).
  --model SELECTOR    Model selector for the printed registration snippet
                      (default: lm-studio/qwen/qwen3.6-35b-a3b).
  --force             Claim/overwrite an existing unowned server file.
  --dry-run           Show the install plan without writing files.
  -h, --help          Show this help.

Environment:
  ZZ_DASH_URL                         Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_READSUBAGENT_MCP_URL             Exact source URL (default: $ZZ_DASH_URL/zz-readsubagent-mcp)
  ZZ_READSUBAGENT_MCP_PROJECT_DIR     Target repo/project dir
  ZZ_READSUBAGENT_MCP_MODEL           Model selector for the snippet
  ZZ_READSUBAGENT_MCP_FORCE=1
  ZZ_READSUBAGENT_MCP_DRY_RUN=1
  ZZ_READSUBAGENT_MCP_ALLOW_SUBDIR=1

Requires `pi` on PATH with the LM Studio (lm-studio) provider available so the
model selector resolves, and LM Studio reachable.
EOF
}

DEFAULT_HOST="https://raw.githubusercontent.com/dezverev/zzPi/main"
HOST_BASE="${ZZ_DASH_URL:-$DEFAULT_HOST}"
SOURCE_BASE="${ZZ_READSUBAGENT_MCP_URL:-${HOST_BASE%/}/zz-readsubagent-mcp}"
SOURCE_BASE="${SOURCE_BASE%/}"
PROJECT_DIR="${ZZ_READSUBAGENT_MCP_PROJECT_DIR:-$PWD}"
MODEL="${ZZ_READSUBAGENT_MCP_MODEL:-lm-studio/qwen/qwen3.6-35b-a3b}"
FORCE="${ZZ_READSUBAGENT_MCP_FORCE:-0}"
DRY_RUN="${ZZ_READSUBAGENT_MCP_DRY_RUN:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-dir) [ "$#" -ge 2 ] || { echo "--project-dir needs a value" >&2; exit 2; }; PROJECT_DIR="$2"; shift 2 ;;
    --project-dir=*) PROJECT_DIR="${1#*=}"; shift ;;
    --model) [ "$#" -ge 2 ] || { echo "--model needs a value" >&2; exit 2; }; MODEL="$2"; shift 2 ;;
    --model=*) MODEL="${1#*=}"; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "install-zz-readsubagent-mcp.sh needs curl" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "install-zz-readsubagent-mcp.sh needs python3" >&2; exit 1; }

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd -P)"

if [ -z "${ZZ_READSUBAGENT_MCP_ALLOW_SUBDIR:-}" ] && command -v git >/dev/null 2>&1; then
  if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GIT_ROOT="$(git -C "$PROJECT_DIR" rev-parse --show-toplevel)"
    GIT_ROOT="$(cd "$GIT_ROOT" && pwd -P)"
    if [ "$PROJECT_DIR" != "$GIT_ROOT" ]; then
      echo "Refusing to install into a git subdirectory:" >&2
      echo "  current: $PROJECT_DIR" >&2
      echo "  repo root: $GIT_ROOT" >&2
      echo "Run this from the repo root, or set ZZ_READSUBAGENT_MCP_PROJECT_DIR=$GIT_ROOT." >&2
      exit 1
    fi
  fi
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

SERVER_TMP="$TMP_DIR/zz-readsubagent-mcp.py"
curl -fsSL "$SOURCE_BASE/zz-readsubagent-mcp.py" -o "$SERVER_TMP"

PI_WARNING=""
if ! command -v pi >/dev/null 2>&1; then
  PI_WARNING="WARNING: 'pi' not found on PATH. The readsubagent MCP tool needs pi with the LM Studio (lm-studio) provider available."
fi

python3 - "$PROJECT_DIR" "$SERVER_TMP" "$SOURCE_BASE" "$MODEL" "$FORCE" "$DRY_RUN" <<'PY'
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

project_dir = Path(sys.argv[1]).resolve()
server_tmp = Path(sys.argv[2]).resolve()
source_base = sys.argv[3].rstrip("/")
model = sys.argv[4]
force = sys.argv[5].strip().lower() in {"1", "true", "yes", "on"}
dry_run = sys.argv[6].strip().lower() in {"1", "true", "yes", "on"}

rel_server = ".zz-mcp/zz-readsubagent-mcp.py"
server_target = project_dir / rel_server
manifest_path = project_dir / ".zz-mcp" / "zz-readsubagent-mcp-manifest.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest_owns(rel: str) -> bool:
    if not manifest_path.is_file():
        return False
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return False
    owned = data.get("owned_files") if isinstance(data, dict) else None
    return isinstance(owned, list) and rel in owned


if server_target.exists() and not manifest_owns(rel_server) and not force:
    if server_target.read_bytes() != server_tmp.read_bytes():
        raise SystemExit(
            f"Refusing to overwrite existing unowned {rel_server}. Use --force to claim it."
        )
    action = f"unchanged existing matching {rel_server}"
elif dry_run:
    action = f"would {'update' if server_target.exists() else 'create'} {rel_server}"
else:
    server_target.parent.mkdir(parents=True, exist_ok=True)
    server_target.write_bytes(server_tmp.read_bytes())
    action = f"installed {rel_server}"

if not dry_run:
    state = {
        "installer": "zz-readsubagent-mcp",
        "schemaVersion": 1,
        "source_url": source_base,
        "owned_files": [rel_server],
        "file_hashes": {rel_server: sha256(server_target)},
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

print("")
print("  zz readsubagent MCP server install plan" if dry_run else "  zz readsubagent MCP server installed")
print(f"  -> {action}")
print(f"  -> target repo: {project_dir}")
print(f"  -> source: {source_base}")
print("")
print("  Register this stdio MCP server in your harness (server name: zz_readsubagent,")
print("  tool: mcp__zz_readsubagent__readsubagent). Generic config:")
print("")
print("    command: python3")
print(f"    args:    [\"{rel_server}\"]   # relative to the repo root (the server's launch cwd)")
print(f"    env:     {{ \"ZZ_READSUBAGENT_MODEL\": \"{model}\" }}")
print("")
print("  Claude Code:")
print(f"    claude mcp add --scope project --transport stdio \\")
print(f"      --env ZZ_READSUBAGENT_MODEL={model} \\")
print(f"      -- zz_readsubagent python3 ./{rel_server}")
PY

if [ -n "$PI_WARNING" ]; then
  echo "  -> $PI_WARNING"
fi
