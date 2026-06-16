#!/usr/bin/env bash
# zz Codex readsubagent — repo-local installer for Linux / macOS / Git Bash.
#   cd /path/to/repo
#   curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-codex-readsubagent.sh | bash
#
# Installs the project-local Codex readsubagent under ./.codex/agents/,
# adds repo AGENTS.md read-planning guidance, and ensures the user-level
# LM Studio provider required by the agent.
set -euo pipefail

usage() {
  cat <<'EOF'
install-codex-readsubagent.sh [options]

Options:
  --project-dir DIR       Target repo/project dir (default: current directory).
  --provider-url URL      LM Studio OpenAI-compatible base URL for ~/.codex/config.toml.
  --skip-provider         Do not add/update the user-level model provider.
  --skip-agents-md        Do not add/update the repo AGENTS.md guidance block.
  --force                 Claim/overwrite an existing unowned readsubagent TOML.
  --dry-run               Show the install plan without writing files.
  -h, --help              Show this help.

Environment:
  ZZ_DASH_URL                         Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_CODEX_READSUBAGENT_URL           Exact source URL (default: $ZZ_DASH_URL/codex-readsubagent)
  ZZ_CODEX_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_CODEX_READSUBAGENT_PROVIDER_URL  Provider base URL (default: http://127.0.0.1:11444/v1)
  ZZ_CODEX_READSUBAGENT_SKIP_PROVIDER=1
  ZZ_CODEX_READSUBAGENT_SKIP_AGENTS_MD=1
  ZZ_CODEX_READSUBAGENT_FORCE=1
  ZZ_CODEX_READSUBAGENT_DRY_RUN=1
  ZZ_CODEX_READSUBAGENT_ALLOW_SUBDIR=1
  CODEX_HOME                          User Codex config dir (default: ~/.codex)
EOF
}

truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

DEFAULT_HOST="https://raw.githubusercontent.com/dezverev/zzPi/main"
HOST_BASE="${ZZ_DASH_URL:-$DEFAULT_HOST}"
SOURCE_BASE="${ZZ_CODEX_READSUBAGENT_URL:-${HOST_BASE%/}/codex-readsubagent}"
SOURCE_BASE="${SOURCE_BASE%/}"
PROJECT_DIR="${ZZ_CODEX_READSUBAGENT_PROJECT_DIR:-$PWD}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
PROVIDER_URL="${ZZ_CODEX_READSUBAGENT_PROVIDER_URL:-http://127.0.0.1:11444/v1}"
SKIP_PROVIDER="${ZZ_CODEX_READSUBAGENT_SKIP_PROVIDER:-0}"
SKIP_AGENTS_MD="${ZZ_CODEX_READSUBAGENT_SKIP_AGENTS_MD:-0}"
FORCE="${ZZ_CODEX_READSUBAGENT_FORCE:-0}"
DRY_RUN="${ZZ_CODEX_READSUBAGENT_DRY_RUN:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-dir) [ "$#" -ge 2 ] || { echo "--project-dir needs a value" >&2; exit 2; }; PROJECT_DIR="$2"; shift 2 ;;
    --project-dir=*) PROJECT_DIR="${1#*=}"; shift ;;
    --provider-url) [ "$#" -ge 2 ] || { echo "--provider-url needs a value" >&2; exit 2; }; PROVIDER_URL="$2"; shift 2 ;;
    --provider-url=*) PROVIDER_URL="${1#*=}"; shift ;;
    --skip-provider) SKIP_PROVIDER=1; shift ;;
    --skip-agents-md) SKIP_AGENTS_MD=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "install-codex-readsubagent.sh needs curl" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "install-codex-readsubagent.sh needs python3" >&2; exit 1; }

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd -P)"
CODEX_DIR="$(mkdir -p "$CODEX_DIR" && cd "$CODEX_DIR" && pwd -P)"

if [ -z "${ZZ_CODEX_READSUBAGENT_ALLOW_SUBDIR:-}" ] && command -v git >/dev/null 2>&1; then
  if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GIT_ROOT="$(git -C "$PROJECT_DIR" rev-parse --show-toplevel)"
    GIT_ROOT="$(cd "$GIT_ROOT" && pwd -P)"
    if [ "$PROJECT_DIR" != "$GIT_ROOT" ]; then
      echo "Refusing to install into a git subdirectory:" >&2
      echo "  current: $PROJECT_DIR" >&2
      echo "  repo root: $GIT_ROOT" >&2
      echo "Run this from the repo root, or set ZZ_CODEX_READSUBAGENT_PROJECT_DIR=$GIT_ROOT." >&2
      exit 1
    fi
  fi
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

AGENT_TMP="$TMP_DIR/readsubagent.toml"
curl -fsSL "$SOURCE_BASE/readsubagent.toml" -o "$AGENT_TMP"

python3 - "$PROJECT_DIR" "$CODEX_DIR" "$AGENT_TMP" "$SOURCE_BASE" "$PROVIDER_URL" "$SKIP_PROVIDER" "$SKIP_AGENTS_MD" "$FORCE" "$DRY_RUN" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path

project_dir = Path(sys.argv[1]).resolve()
codex_dir = Path(sys.argv[2]).resolve()
agent_tmp = Path(sys.argv[3]).resolve()
source_base = sys.argv[4].rstrip("/")
provider_url = sys.argv[5]
skip_provider = sys.argv[6].strip().lower() in {"1", "true", "yes", "on"}
skip_agents_md = sys.argv[7].strip().lower() in {"1", "true", "yes", "on"}
force = sys.argv[8].strip().lower() in {"1", "true", "yes", "on"}
dry_run = sys.argv[9].strip().lower() in {"1", "true", "yes", "on"}

rel_agent = ".codex/agents/readsubagent.toml"
agent_target = project_dir / rel_agent
agents_md = project_dir / "AGENTS.md"
manifest_path = project_dir / ".codex" / "zz-codex-readsubagent-manifest.json"
user_config = codex_dir / "config.toml"

MARKER_START = "<!-- zz-codex-readsubagent:start -->"
MARKER_END = "<!-- zz-codex-readsubagent:end -->"
AGENTS_BLOCK = f"""{MARKER_START}
## Read Planning

Before doing focused reads of specific implementation files, start with a
read-planning pass through the `readsubagent` custom agent.

Use `readsubagent` to get:

- A short map of the relevant subsystem.
- Candidate files and directories, with reasons.
- The smallest focused read list for the main agent.
- Search terms, symbols, or line anchors that should guide the focused reads.
- Files or areas that look related but should be avoided for now.
- Uncertainty or follow-up questions that could change the read plan.

Use at least a ten-minute wait for `readsubagent` when the tool supports an
explicit timeout; the role uses a local LM Studio model and may be slower than
hosted models. Prefer a longer wait over assuming the subagent stalled.

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
- A tool or environment limitation prevents using the custom agent.

**Crucial rule for ambiguity:** The decision to use `readsubagent` is about *knowledge*, not tool-call count. If there is *any ambiguity* about where to look or what to read, do NOT do exploratory manual reads (like `find`, `ls`, or `grep` to hunt around). Instead, use `readsubagent` by asking it a targeted question to clear the ambiguity and tell you exactly where and what to read.

When an exception applies, mention it briefly and continue with the smallest
reasonable focused read.
{MARKER_END}
"""

PROVIDER_START = "# zz-codex-readsubagent:start"
PROVIDER_END = "# zz-codex-readsubagent:end"
PROVIDER_BLOCK = f"""{PROVIDER_START}
[model_providers.zz_lmstudio_read]
name = "LM Studio readsubagent"
base_url = "{provider_url}"
{PROVIDER_END}
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


def ensure_agent() -> str:
    if agent_target.exists() and not manifest_owns(rel_agent) and not force:
        if agent_target.read_bytes() != agent_tmp.read_bytes():
            raise SystemExit(
                f"Refusing to overwrite existing unowned {rel_agent}. Use --force if you want this installer to claim it."
            )
        return "unchanged existing matching readsubagent.toml"
    if dry_run:
        action = "update" if agent_target.exists() else "create"
        return f"would {action} {rel_agent}"
    agent_target.parent.mkdir(parents=True, exist_ok=True)
    agent_target.write_bytes(agent_tmp.read_bytes())
    return f"installed {rel_agent}"


def ensure_agents_md() -> str:
    if skip_agents_md:
        return "skipped AGENTS.md guidance"
    if dry_run:
        return "would add/update AGENTS.md read-planning block"
    existing = agents_md.read_text(encoding="utf-8") if agents_md.exists() else "# Codex Guidance\n"
    next_text, replaced = replace_marked_block(existing, MARKER_START, MARKER_END, AGENTS_BLOCK)
    agents_md.write_text(next_text.rstrip() + "\n", encoding="utf-8")
    return "updated AGENTS.md read-planning block" if replaced else "added AGENTS.md read-planning block"


def ensure_provider() -> str:
    if skip_provider:
        return "skipped user-level provider"
    existing = user_config.read_text(encoding="utf-8") if user_config.exists() else ""
    if PROVIDER_START in existing and PROVIDER_END in existing:
        next_text, _ = replace_marked_block(existing, PROVIDER_START, PROVIDER_END, PROVIDER_BLOCK)
        if dry_run:
            return f"would update {user_config}"
        user_config.parent.mkdir(parents=True, exist_ok=True)
        user_config.write_text(next_text.rstrip() + "\n", encoding="utf-8")
        return f"updated {user_config}"
    if re.search(r"(?m)^\[model_providers\.zz_lmstudio_read\]\s*$", existing):
        return f"preserved existing unmanaged zz_lmstudio_read provider in {user_config}"
    if dry_run:
        return f"would add zz_lmstudio_read provider to {user_config}"
    user_config.parent.mkdir(parents=True, exist_ok=True)
    next_text = existing.rstrip() + ("\n\n" if existing.strip() else "") + PROVIDER_BLOCK.rstrip() + "\n"
    user_config.write_text(next_text, encoding="utf-8")
    return f"added zz_lmstudio_read provider to {user_config}"


try:
    import tomllib  # type: ignore[import-not-found]
except ModuleNotFoundError:
    toml_status = "skipped TOML parse check: python tomllib is unavailable"
else:
    with agent_tmp.open("rb") as fh:
        tomllib.load(fh)
    toml_status = "validated readsubagent.toml"

actions = [toml_status, ensure_agent(), ensure_agents_md(), ensure_provider()]

if not dry_run:
    state = {
        "installer": "zz-codex-readsubagent",
        "schemaVersion": 1,
        "source_url": source_base,
        "owned_files": [rel_agent],
        "managed_blocks": [
            "AGENTS.md:zz-codex-readsubagent",
            "~/.codex/config.toml:zz-codex-readsubagent" if not skip_provider else "",
        ],
        "file_hashes": {rel_agent: sha256(agent_target)},
        "provider": {
            "name": "zz_lmstudio_read",
            "base_url": provider_url,
            "config_path": str(user_config),
            "managed": not skip_provider,
        },
    }
    state["managed_blocks"] = [item for item in state["managed_blocks"] if item]
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

print("")
print("  zz Codex readsubagent install plan" if dry_run else "  zz Codex readsubagent installed")
for action in actions:
    print(f"  -> {action}")
print(f"  -> target repo: {project_dir}")
print(f"  -> source: {source_base}")
if not dry_run:
    print("  -> restart Codex from this repo so it discovers .codex/agents/readsubagent.toml")
PY
