#!/usr/bin/env bash
# zz Copilot readsubagent — repo-local installer for Linux / macOS / Git Bash.
#   cd /path/to/repo
#   curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-copilot-readsubagent.sh | bash
#
# GitHub Copilot CLI wrapper around the harness-neutral zz-readsubagent-mcp server.
# It installs a Copilot skill, installs the MCP server at
# ./.zz-mcp/zz-readsubagent-mcp.py, registers zz_readsubagent in
# ./.mcp.json, and adds ./.github/copilot-instructions.md guidance. The
# MCP server spawns a headless `pi` child on a local Qwen model (via LM Studio).
set -euo pipefail

usage() {
  cat <<'EOF'
install-copilot-readsubagent.sh [options]

Options:
  --project-dir DIR          Target repo/project dir (default: current directory).
  --model SELECTOR           pi model selector (default: lm-studio/qwen/qwen3.6-35b-a3b).
  --pi-bin NAME              pi executable name/path for the MCP server (default: pi).
  --skip-mcp                 Do not add/update the zz_readsubagent server in .mcp.json.
  --skip-instructions        Do not add/update .github/copilot-instructions.md guidance.
  --skip-copilot-instructions
                              Alias for --skip-instructions.
  --skip-skill               Do not install/update the Copilot readsubagent skill.
  --skip-hooks               Do not install/update Copilot CLI readsubagent hooks.
  --force                    Claim/overwrite existing or locally modified managed files/entries.
  --dry-run                  Show the install plan without writing files.
  -h, --help                 Show this help.

Environment:
  ZZ_DASH_URL                           Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_READSUBAGENT_MCP_URL               MCP server source URL (default: $ZZ_DASH_URL/zz-readsubagent-mcp)
  ZZ_COPILOT_READSUBAGENT_URL           Skill/hooks source URL (default: $ZZ_DASH_URL/copilot-readsubagent)
  ZZ_COPILOT_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_COPILOT_READSUBAGENT_MODEL         pi model selector
  ZZ_COPILOT_READSUBAGENT_PI_BIN        pi executable name/path
  ZZ_COPILOT_READSUBAGENT_SKIP_MCP=1
  ZZ_COPILOT_READSUBAGENT_SKIP_INSTRUCTIONS=1
  ZZ_COPILOT_READSUBAGENT_SKIP_SKILL=1
  ZZ_COPILOT_READSUBAGENT_SKIP_HOOKS=1
  ZZ_COPILOT_READSUBAGENT_FORCE=1
  ZZ_COPILOT_READSUBAGENT_DRY_RUN=1
  ZZ_COPILOT_READSUBAGENT_ALLOW_SUBDIR=1

Requires `pi` on PATH with the LM Studio (lm-studio) provider available so the
model selector resolves (install the repo-local pi plugs, or define a global Pi
lm-studio provider), and LM Studio reachable. In Copilot CLI, trust the project
when prompted so its repo-local MCP server and hooks can load.
EOF
}

DEFAULT_HOST="https://raw.githubusercontent.com/dezverev/zzPi/main"
HOST_BASE="${ZZ_DASH_URL:-$DEFAULT_HOST}"
MCP_SOURCE_BASE="${ZZ_READSUBAGENT_MCP_URL:-${HOST_BASE%/}/zz-readsubagent-mcp}"
MCP_SOURCE_BASE="${MCP_SOURCE_BASE%/}"
SOURCE_BASE="${ZZ_COPILOT_READSUBAGENT_URL:-${HOST_BASE%/}/copilot-readsubagent}"
SOURCE_BASE="${SOURCE_BASE%/}"
PROJECT_DIR="${ZZ_COPILOT_READSUBAGENT_PROJECT_DIR:-$PWD}"
MODEL="${ZZ_COPILOT_READSUBAGENT_MODEL:-lm-studio/qwen/qwen3.6-35b-a3b}"
PI_BIN="${ZZ_COPILOT_READSUBAGENT_PI_BIN:-pi}"
SKIP_MCP="${ZZ_COPILOT_READSUBAGENT_SKIP_MCP:-0}"
SKIP_INSTRUCTIONS="${ZZ_COPILOT_READSUBAGENT_SKIP_INSTRUCTIONS:-0}"
SKIP_SKILL="${ZZ_COPILOT_READSUBAGENT_SKIP_SKILL:-0}"
SKIP_HOOKS="${ZZ_COPILOT_READSUBAGENT_SKIP_HOOKS:-0}"
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
    --skip-skill) SKIP_SKILL=1; shift ;;
    --skip-hooks) SKIP_HOOKS=1; shift ;;
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

SKILL_TMP="$TMP_DIR/SKILL.md"
HOOK_CONFIG_TMP="$TMP_DIR/zz-readsubagent.json"
HOOK_NUDGE_SH_TMP="$TMP_DIR/readsubagent-nudge.sh"
HOOK_NUDGE_PS1_TMP="$TMP_DIR/readsubagent-nudge.ps1"
HOOK_BLOCK_SH_TMP="$TMP_DIR/block-explore-subagent.sh"
HOOK_BLOCK_PS1_TMP="$TMP_DIR/block-explore-subagent.ps1"
SERVER_TMP="$TMP_DIR/zz-readsubagent-mcp.py"
curl -fsSL "$SOURCE_BASE/skills/readsubagent/SKILL.md" -o "$SKILL_TMP"
curl -fsSL "$SOURCE_BASE/hooks/zz-readsubagent.json" -o "$HOOK_CONFIG_TMP"
curl -fsSL "$SOURCE_BASE/hooks/readsubagent-nudge.sh" -o "$HOOK_NUDGE_SH_TMP"
curl -fsSL "$SOURCE_BASE/hooks/readsubagent-nudge.ps1" -o "$HOOK_NUDGE_PS1_TMP"
curl -fsSL "$SOURCE_BASE/hooks/block-explore-subagent.sh" -o "$HOOK_BLOCK_SH_TMP"
curl -fsSL "$SOURCE_BASE/hooks/block-explore-subagent.ps1" -o "$HOOK_BLOCK_PS1_TMP"
curl -fsSL "$MCP_SOURCE_BASE/zz-readsubagent-mcp.py" -o "$SERVER_TMP"

PI_WARNING=""
if ! command -v "$PI_BIN" >/dev/null 2>&1; then
  PI_WARNING="WARNING: '$PI_BIN' not found on PATH. The readsubagent MCP tool needs pi with the LM Studio (lm-studio) provider available."
fi

python3 - "$PROJECT_DIR" "$SKILL_TMP" "$HOOK_CONFIG_TMP" "$HOOK_NUDGE_SH_TMP" "$HOOK_NUDGE_PS1_TMP" "$HOOK_BLOCK_SH_TMP" "$HOOK_BLOCK_PS1_TMP" "$SERVER_TMP" "$SOURCE_BASE" "$MCP_SOURCE_BASE" "$MODEL" "$PI_BIN" "$SKIP_MCP" "$SKIP_INSTRUCTIONS" "$SKIP_SKILL" "$SKIP_HOOKS" "$FORCE" "$DRY_RUN" <<'PY'
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

project_dir = Path(sys.argv[1]).resolve()
skill_tmp = Path(sys.argv[2]).resolve()
hook_config_tmp = Path(sys.argv[3]).resolve()
hook_nudge_sh_tmp = Path(sys.argv[4]).resolve()
hook_nudge_ps1_tmp = Path(sys.argv[5]).resolve()
hook_block_sh_tmp = Path(sys.argv[6]).resolve()
hook_block_ps1_tmp = Path(sys.argv[7]).resolve()
server_tmp = Path(sys.argv[8]).resolve()
source_base = sys.argv[9].rstrip("/")
mcp_source_base = sys.argv[10].rstrip("/")
model = sys.argv[11]
pi_bin = sys.argv[12]
skip_mcp = sys.argv[13].strip().lower() in {"1", "true", "yes", "on"}
skip_instructions = sys.argv[14].strip().lower() in {"1", "true", "yes", "on"}
skip_skill = sys.argv[15].strip().lower() in {"1", "true", "yes", "on"}
skip_hooks = sys.argv[16].strip().lower() in {"1", "true", "yes", "on"}
force = sys.argv[17].strip().lower() in {"1", "true", "yes", "on"}
dry_run = sys.argv[18].strip().lower() in {"1", "true", "yes", "on"}

obsolete_agent = ".github/agents/readsubagent.agent.md"
rel_skill = ".github/skills/readsubagent/SKILL.md"
rel_hook_config = ".github/hooks/zz-readsubagent.json"
rel_hook_nudge_sh = ".github/hooks/readsubagent-nudge.sh"
rel_hook_nudge_ps1 = ".github/hooks/readsubagent-nudge.ps1"
rel_hook_block_sh = ".github/hooks/block-explore-subagent.sh"
rel_hook_block_ps1 = ".github/hooks/block-explore-subagent.ps1"
rel_server = ".zz-mcp/zz-readsubagent-mcp.py"
obsolete_agent_target = project_dir / obsolete_agent
skill_target = project_dir / rel_skill
hook_config_target = project_dir / rel_hook_config
hook_nudge_sh_target = project_dir / rel_hook_nudge_sh
hook_nudge_ps1_target = project_dir / rel_hook_nudge_ps1
hook_block_sh_target = project_dir / rel_hook_block_sh
hook_block_ps1_target = project_dir / rel_hook_block_ps1
server_target = project_dir / rel_server
mcp_json = project_dir / ".mcp.json"
instructions_md = project_dir / ".github" / "copilot-instructions.md"
manifest_path = project_dir / ".github" / "zz-copilot-readsubagent-manifest.json"

SERVER_NAME = "zz_readsubagent"
SERVER_ARGS_PATH = ".zz-mcp/zz-readsubagent-mcp.py"
MARKER_START = "<!-- zz-copilot-readsubagent:start -->"
MARKER_END = "<!-- zz-copilot-readsubagent:end -->"
COPILOT_BLOCK = f"""{MARKER_START}
## Read Planning

Before doing focused reads of specific implementation files, start with a
read-planning pass through `readsubagent`. It delegates to a local model via
`pi` and returns a concise factual report with paths and line ranges.

Use the `readsubagent` skill. The skill calls the direct
`zz_readsubagent/readsubagent` MCP tool; do not launch another Copilot custom
agent.

If the user asks to test, smoke-check, verify, or diagnose readsubagent itself,
make one small factual MCP call immediately and report whether it succeeded; do
not ask the user to invent another test prompt.

Pass `question` plus any of
`path`/`paths`, `symbols`, `searchTerms`, `lineRanges`, `output`, and
`maxReportChars` to scope the inspection.

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


def manifest_hash(rel: str) -> str | None:
    hashes = load_manifest().get("file_hashes")
    value = hashes.get(rel) if isinstance(hashes, dict) else None
    return value if isinstance(value, str) else None


def replace_marked_block(text: str, start: str, end: str, block: str) -> tuple[str, bool]:
    pattern = re.compile(rf"{re.escape(start)}.*?{re.escape(end)}", re.S)
    if pattern.search(text):
        return pattern.sub(block.rstrip(), text), True
    return text.rstrip() + ("\n\n" if text.strip() else "") + block.rstrip(), False


def preflight_file(rel: str, target: Path, tmp: Path) -> bool:
    if not target.exists() or force:
        return False
    matches_payload = target.read_bytes() == tmp.read_bytes()
    if not manifest_owns(rel) and not matches_payload:
        raise SystemExit(
            f"Refusing to overwrite existing unowned {rel}. Use --force if you want this installer to claim it."
        )
    expected_hash = manifest_hash(rel)
    if manifest_owns(rel) and not expected_hash:
        raise SystemExit(
            f"Cannot verify ownership baseline for managed {rel}. Use --force to replace it."
        )
    if manifest_owns(rel) and sha256(target) != expected_hash and not matches_payload:
        raise SystemExit(
            f"Refusing to overwrite locally modified managed {rel}. Use --force to replace it."
        )
    return matches_payload


def ensure_file(rel: str, target: Path, tmp: Path, *, executable: bool = False) -> str:
    if preflight_file(rel, target, tmp):
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


def server_entry(entry_model: str = model, entry_pi_bin: str = pi_bin) -> dict:
    env = {"ZZ_READSUBAGENT_MODEL": entry_model}
    if entry_pi_bin != "pi":
        env["ZZ_READSUBAGENT_PI_BIN"] = entry_pi_bin
    return {
        "type": "local",
        "command": "python3",
        "args": [SERVER_ARGS_PATH],
        "env": env,
        "tools": ["readsubagent"],
    }


def assert_managed_mcp_entry_unchanged(servers: dict) -> None:
    prior = load_manifest()
    if SERVER_NAME not in (prior.get("managed_servers") or []) or force:
        return
    server_state = prior.get("server")
    prior_model = server_state.get("model") if isinstance(server_state, dict) else None
    prior_pi_bin = server_state.get("pi_bin", "pi") if isinstance(server_state, dict) else None
    if not isinstance(prior_model, str) or not isinstance(prior_pi_bin, str):
        raise SystemExit(f"Cannot verify legacy ownership of {SERVER_NAME} in .mcp.json. Use --force to replace it.")
    if SERVER_NAME not in servers or servers[SERVER_NAME] != server_entry(prior_model, prior_pi_bin):
        raise SystemExit(
            f"Refusing to overwrite locally modified managed {SERVER_NAME} server in .mcp.json. Use --force to replace it."
        )


mcp_managed_this_run = False


def ensure_mcp() -> str:
    global mcp_managed_this_run
    if skip_mcp:
        return "skipped .mcp.json registration"
    data: dict = {}
    if mcp_json.exists():
        try:
            loaded = json.loads(mcp_json.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                raise ValueError("root is not an object")
            data = loaded
        except Exception as exc:
            raise SystemExit(f"Refusing to edit malformed .mcp.json: {exc}")
    servers = data.get("mcpServers")
    if servers is None:
        servers = {}
    elif not isinstance(servers, dict):
        raise SystemExit("Refusing to edit .mcp.json because mcpServers is not an object")
    assert_managed_mcp_entry_unchanged(servers)
    existing_present = SERVER_NAME in servers
    managed = SERVER_NAME in (load_manifest().get("managed_servers") or [])
    if existing_present and not managed and not force:
        return f"preserved existing unmanaged {SERVER_NAME} server in .mcp.json"
    if dry_run:
        verb = "update" if existing_present else "add"
        return f"would {verb} {SERVER_NAME} server in .mcp.json"
    servers[SERVER_NAME] = server_entry()
    mcp_managed_this_run = True
    data["mcpServers"] = servers
    mcp_json.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return f"registered {SERVER_NAME} server in .mcp.json"


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


def preflight_parent(target: Path) -> None:
    parent = target.parent
    while parent != project_dir:
        if parent.exists():
            if not parent.is_dir():
                raise SystemExit(f"Refusing to install because {parent} is not a directory")
            break
        parent = parent.parent


def preflight_configuration() -> None:
    for target in [server_target, manifest_path]:
        preflight_parent(target)
    if manifest_path.exists() and not manifest_path.is_file():
        raise SystemExit("Refusing to write Copilot manifest because its path is not a file")
    if not skip_skill:
        preflight_parent(skill_target)
    if not skip_hooks:
        for target in [hook_config_target, hook_nudge_sh_target, hook_nudge_ps1_target, hook_block_sh_target, hook_block_ps1_target]:
            preflight_parent(target)
    if not skip_instructions:
        preflight_parent(instructions_md)
        if instructions_md.exists():
            try:
                text = instructions_md.read_text(encoding="utf-8")
            except Exception as exc:
                raise SystemExit(f"Refusing to edit .github/copilot-instructions.md: {exc}")
            if text.count(MARKER_START) != text.count(MARKER_END) or text.count(MARKER_START) > 1:
                raise SystemExit("Refusing to edit .github/copilot-instructions.md because managed markers are malformed or duplicated")
    if not skip_mcp:
        preflight_parent(mcp_json)
    if not skip_mcp and mcp_json.exists():
        try:
            data = json.loads(mcp_json.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("root is not an object")
            if data.get("mcpServers") is not None and not isinstance(data["mcpServers"], dict):
                raise ValueError("mcpServers is not an object")
            assert_managed_mcp_entry_unchanged(data.get("mcpServers") or {})
        except Exception as exc:
            raise SystemExit(f"Refusing to edit malformed .mcp.json: {exc}")


files_to_install = [(rel_server, server_target, server_tmp)]
if not skip_skill:
    files_to_install.append((rel_skill, skill_target, skill_tmp))
if not skip_hooks:
    files_to_install.extend([
        (rel_hook_config, hook_config_target, hook_config_tmp),
        (rel_hook_nudge_sh, hook_nudge_sh_target, hook_nudge_sh_tmp),
        (rel_hook_nudge_ps1, hook_nudge_ps1_target, hook_nudge_ps1_tmp),
        (rel_hook_block_sh, hook_block_sh_target, hook_block_sh_tmp),
        (rel_hook_block_ps1, hook_block_ps1_target, hook_block_ps1_tmp),
    ])
for preflight_rel, preflight_target, preflight_tmp in files_to_install:
    preflight_file(preflight_rel, preflight_target, preflight_tmp)
preflight_configuration()

def retire_obsolete_agent() -> str | None:
    prior = load_manifest()
    owned = prior.get("owned_files")
    if not isinstance(owned, list) or obsolete_agent not in owned or not obsolete_agent_target.is_file():
        return None
    prior_hashes = prior.get("file_hashes")
    expected = prior_hashes.get(obsolete_agent) if isinstance(prior_hashes, dict) else None
    if expected and sha256(obsolete_agent_target) != expected:
        return f"preserved locally modified obsolete {obsolete_agent}"
    if dry_run:
        return f"would remove obsolete {obsolete_agent}"
    obsolete_agent_target.unlink()
    return f"removed obsolete {obsolete_agent}"


actions = [ensure_file(rel_server, server_target, server_tmp)]
retired = retire_obsolete_agent()
if retired:
    actions.append(retired)
if skip_skill:
    actions.append("skipped Copilot readsubagent skill")
else:
    actions.append(ensure_file(rel_skill, skill_target, skill_tmp))
if skip_hooks:
    actions.append("skipped Copilot CLI readsubagent hooks")
else:
    actions.extend([
        ensure_file(rel_hook_config, hook_config_target, hook_config_tmp),
        ensure_file(rel_hook_nudge_sh, hook_nudge_sh_target, hook_nudge_sh_tmp, executable=True),
        ensure_file(rel_hook_nudge_ps1, hook_nudge_ps1_target, hook_nudge_ps1_tmp),
        ensure_file(rel_hook_block_sh, hook_block_sh_target, hook_block_sh_tmp, executable=True),
        ensure_file(rel_hook_block_ps1, hook_block_ps1_target, hook_block_ps1_tmp),
    ])
actions.extend([ensure_mcp(), ensure_instructions()])

if not dry_run:
    prior_state = load_manifest()
    prior_owned = prior_state.get("owned_files")
    owned_files = set(prior_owned if isinstance(prior_owned, list) else [])
    owned_files.discard(obsolete_agent)
    owned_files.add(rel_server)
    if not skip_skill:
        owned_files.add(rel_skill)
    if not skip_hooks:
        owned_files.update([rel_hook_config, rel_hook_nudge_sh, rel_hook_nudge_ps1, rel_hook_block_sh, rel_hook_block_ps1])
    owned_files = sorted(rel for rel in owned_files if (project_dir / rel).is_file())

    def merged_management(key: str, current: list[str], skipped: bool) -> list[str]:
        previous = prior_state.get(key)
        values = set(previous if skipped and isinstance(previous, list) else [])
        values.update(current)
        return sorted(values)

    managed_blocks = merged_management(
        "managed_blocks",
        [] if skip_instructions else [".github/copilot-instructions.md:zz-copilot-readsubagent"],
        skip_instructions,
    )
    managed_servers = merged_management(
        "managed_servers", [SERVER_NAME] if mcp_managed_this_run else [], skip_mcp
    )
    server_model = model
    server_pi_bin = pi_bin
    server_config_path = str(mcp_json)
    prior_server = prior_state.get("server")
    if skip_mcp and isinstance(prior_server, dict):
        if isinstance(prior_server.get("model"), str):
            server_model = prior_server["model"]
        if isinstance(prior_server.get("pi_bin"), str):
            server_pi_bin = prior_server["pi_bin"]
        if isinstance(prior_server.get("config_path"), str):
            server_config_path = prior_server["config_path"]
    state = {
        "installer": "zz-copilot-readsubagent",
        "schemaVersion": 1,
        "source_url": source_base,
        "mcp_source_url": mcp_source_base,
        "owned_files": owned_files,
        "managed_blocks": managed_blocks,
        "managed_servers": managed_servers,
        "file_hashes": {},
        "server": {
            "name": SERVER_NAME,
            "model": server_model,
            "pi_bin": server_pi_bin,
            "config_path": server_config_path,
            "managed": SERVER_NAME in managed_servers,
        },
    }
    prior_hashes = prior_state.get("file_hashes")
    prior_hashes = prior_hashes if isinstance(prior_hashes, dict) else {}
    refreshed_files = {rel_server}
    if not skip_skill:
        refreshed_files.add(rel_skill)
    if not skip_hooks:
        refreshed_files.update([rel_hook_config, rel_hook_nudge_sh, rel_hook_nudge_ps1, rel_hook_block_sh, rel_hook_block_ps1])
    for rel in owned_files:
        if rel in refreshed_files or rel not in prior_hashes:
            state["file_hashes"][rel] = sha256(project_dir / rel)
        else:
            state["file_hashes"][rel] = prior_hashes[rel]
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

print("")
print("  zz Copilot readsubagent install plan" if dry_run else "  zz Copilot readsubagent installed")
for action in actions:
    print(f"  -> {action}")
print(f"  -> model: {model}")
print(f"  -> target repo: {project_dir}")
print(f"  -> source: {source_base}")
print(f"  -> MCP source: {mcp_source_base}")
if not dry_run:
    print("  -> start Copilot CLI in this repo and approve folder trust so the MCP server and hooks can load")
PY

if [ -n "$PI_WARNING" ]; then
  echo "  -> $PI_WARNING"
fi
