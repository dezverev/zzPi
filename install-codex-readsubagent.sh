#!/usr/bin/env bash
# zz Codex readsubagent — repo-local skill + MCP installer.
#   cd /path/to/repo
#   curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-codex-readsubagent.sh | bash
set -euo pipefail

usage() {
  cat <<'EOF'
install-codex-readsubagent.sh [options]

Options:
  --project-dir DIR       Target repo/project dir (default: current directory).
  --model SELECTOR        pi model selector (default: lm-studio/qwen/qwen3.6-35b-a3b).
  --pi-bin NAME           pi executable name/path for the MCP server (default: pi).
  --skip-mcp              Do not install/register the repo-local MCP server.
  --skip-agents-md        Do not add/update the repo AGENTS.md guidance block.
  --skip-skill            Do not install/update .codex/skills/readsubagent/SKILL.md.
  --force                 Claim/overwrite existing unowned or modified managed files.
  --dry-run               Show the install plan without writing files.
  -h, --help              Show this help.

Environment:
  ZZ_DASH_URL                         Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_CODEX_READSUBAGENT_URL           Skill source URL (default: $ZZ_DASH_URL/codex-readsubagent)
  ZZ_READSUBAGENT_MCP_URL             MCP server source URL (default: $ZZ_DASH_URL/zz-readsubagent-mcp)
  ZZ_CODEX_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_CODEX_READSUBAGENT_MODEL         pi model selector
  ZZ_CODEX_READSUBAGENT_PI_BIN        pi executable name/path
  ZZ_CODEX_READSUBAGENT_SKIP_MCP=1
  ZZ_CODEX_READSUBAGENT_SKIP_AGENTS_MD=1
  ZZ_CODEX_READSUBAGENT_SKIP_SKILL=1
  ZZ_CODEX_READSUBAGENT_FORCE=1
  ZZ_CODEX_READSUBAGENT_DRY_RUN=1
  ZZ_CODEX_READSUBAGENT_ALLOW_SUBDIR=1
  CODEX_HOME                          User Codex config dir (default: ~/.codex; used only to retire the old provider block)
EOF
}

DEFAULT_HOST="https://raw.githubusercontent.com/dezverev/zzPi/main"
HOST_BASE="${ZZ_DASH_URL:-$DEFAULT_HOST}"
SOURCE_BASE="${ZZ_CODEX_READSUBAGENT_URL:-${HOST_BASE%/}/codex-readsubagent}"
SOURCE_BASE="${SOURCE_BASE%/}"
MCP_SOURCE_BASE="${ZZ_READSUBAGENT_MCP_URL:-${HOST_BASE%/}/zz-readsubagent-mcp}"
MCP_SOURCE_BASE="${MCP_SOURCE_BASE%/}"
PROJECT_DIR="${ZZ_CODEX_READSUBAGENT_PROJECT_DIR:-$PWD}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
MODEL="${ZZ_CODEX_READSUBAGENT_MODEL:-lm-studio/qwen/qwen3.6-35b-a3b}"
PI_BIN="${ZZ_CODEX_READSUBAGENT_PI_BIN:-pi}"
SKIP_MCP="${ZZ_CODEX_READSUBAGENT_SKIP_MCP:-0}"
SKIP_AGENTS_MD="${ZZ_CODEX_READSUBAGENT_SKIP_AGENTS_MD:-0}"
SKIP_SKILL="${ZZ_CODEX_READSUBAGENT_SKIP_SKILL:-0}"
FORCE="${ZZ_CODEX_READSUBAGENT_FORCE:-0}"
DRY_RUN="${ZZ_CODEX_READSUBAGENT_DRY_RUN:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-dir) [ "$#" -ge 2 ] || { echo "--project-dir needs a value" >&2; exit 2; }; PROJECT_DIR="$2"; shift 2 ;;
    --project-dir=*) PROJECT_DIR="${1#*=}"; shift ;;
    --model) [ "$#" -ge 2 ] || { echo "--model needs a value" >&2; exit 2; }; MODEL="$2"; shift 2 ;;
    --model=*) MODEL="${1#*=}"; shift ;;
    --pi-bin) [ "$#" -ge 2 ] || { echo "--pi-bin needs a value" >&2; exit 2; }; PI_BIN="$2"; shift 2 ;;
    --pi-bin=*) PI_BIN="${1#*=}"; shift ;;
    --skip-mcp) SKIP_MCP=1; shift ;;
    --skip-agents-md) SKIP_AGENTS_MD=1; shift ;;
    --skip-skill) SKIP_SKILL=1; shift ;;
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
    [ "$PROJECT_DIR" = "$GIT_ROOT" ] || {
      echo "Refusing to install into a git subdirectory: current=$PROJECT_DIR repo root=$GIT_ROOT" >&2
      exit 1
    }
  fi
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
SKILL_TMP="$TMP_DIR/SKILL.md"
SERVER_TMP="$TMP_DIR/zz-readsubagent-mcp.py"
case "$(printf '%s' "$SKIP_SKILL" | tr '[:upper:]' '[:lower:]')" in 1|true|yes|on) ;; *) curl -fsSL "$SOURCE_BASE/skills/readsubagent/SKILL.md" -o "$SKILL_TMP" ;; esac
case "$(printf '%s' "$SKIP_MCP" | tr '[:upper:]' '[:lower:]')" in 1|true|yes|on) ;; *) curl -fsSL "$MCP_SOURCE_BASE/zz-readsubagent-mcp.py" -o "$SERVER_TMP" ;; esac

python3 - "$PROJECT_DIR" "$CODEX_DIR" "$SKILL_TMP" "$SERVER_TMP" "$SOURCE_BASE" "$MCP_SOURCE_BASE" "$MODEL" "$PI_BIN" "$SKIP_MCP" "$SKIP_AGENTS_MD" "$SKIP_SKILL" "$FORCE" "$DRY_RUN" <<'PY'
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

project_dir = Path(sys.argv[1]).resolve()
codex_dir = Path(sys.argv[2]).resolve()
skill_tmp = Path(sys.argv[3]).resolve()
server_tmp = Path(sys.argv[4]).resolve()
source_base = sys.argv[5].rstrip("/")
mcp_source_base = sys.argv[6].rstrip("/")
model = sys.argv[7]
pi_bin = sys.argv[8]
skip_mcp = sys.argv[9].strip().lower() in {"1", "true", "yes", "on"}
skip_agents_md = sys.argv[10].strip().lower() in {"1", "true", "yes", "on"}
skip_skill = sys.argv[11].strip().lower() in {"1", "true", "yes", "on"}
force = sys.argv[12].strip().lower() in {"1", "true", "yes", "on"}
dry_run = sys.argv[13].strip().lower() in {"1", "true", "yes", "on"}

rel_skill = ".codex/skills/readsubagent/SKILL.md"
rel_server = ".zz-mcp/zz-readsubagent-mcp.py"
obsolete_agent = ".codex/agents/readsubagent.toml"
skill_target = project_dir / rel_skill
server_target = project_dir / rel_server
obsolete_agent_target = project_dir / obsolete_agent
codex_config = project_dir / ".codex/config.toml"
agents_md = project_dir / "AGENTS.md"
manifest_path = project_dir / ".codex/zz-codex-readsubagent-manifest.json"
user_config = codex_dir / "config.toml"

GUIDANCE_START = "<!-- zz-codex-readsubagent:start -->"
GUIDANCE_END = "<!-- zz-codex-readsubagent:end -->"
GUIDANCE_BLOCK = f"""{GUIDANCE_START}
## Read Planning

Before focused reads of unfamiliar implementation files, use the repo-local
`readsubagent` skill. The skill calls the direct MCP tool registered in
`.codex/config.toml`; do not launch another Codex subagent.

Ask a targeted factual `question` and include repo-relative `path`/`paths`,
`symbols`, `searchTerms`, `lineRanges`, `output`, and `maxReportChars` where
useful. Use it for subsystem maps, focused read lists, definitions, factual
summaries, and line anchors—not implementation planning, edit strategy, bug
finding, code review, or correctness judgments. The local model can be slow;
wait rather than retrying merely because it is taking time.
{GUIDANCE_END}"""

MCP_START = "# zz-codex-readsubagent-mcp:start"
MCP_END = "# zz-codex-readsubagent-mcp:end"
env = {"ZZ_READSUBAGENT_MODEL": model}
if pi_bin != "pi":
    env["ZZ_READSUBAGENT_PI_BIN"] = pi_bin
env_toml = ", ".join(f"{key} = {json.dumps(value)}" for key, value in env.items())
MCP_BLOCK = f"""{MCP_START}
[mcp_servers.readsubagent]
command = "python3"
args = ["{rel_server}"]
cwd = "."
enabled = true
required = false
startup_timeout_sec = 10
tool_timeout_sec = 1800
enabled_tools = ["readsubagent"]
env = {{ {env_toml} }}
{MCP_END}"""

PROVIDER_START = "# zz-codex-readsubagent:start"
PROVIDER_END = "# zz-codex-readsubagent:end"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_manifest() -> dict:
    if not manifest_path.is_file():
        return {}
    try:
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


prior = load_manifest()
prior_owned = set(prior.get("owned_files") if isinstance(prior.get("owned_files"), list) else [])
prior_hashes = prior.get("file_hashes") if isinstance(prior.get("file_hashes"), dict) else {}


def replace_block(text: str, start: str, end: str, block: str) -> tuple[str, bool]:
    pattern = re.compile(rf"{re.escape(start)}.*?{re.escape(end)}", re.S)
    if pattern.search(text):
        return pattern.sub(block.rstrip(), text), True
    return text.rstrip() + ("\n\n" if text.strip() else "") + block.rstrip(), False


def remove_block(text: str, start: str, end: str) -> str:
    pattern = re.compile(rf"(?:^|\n){re.escape(start)}.*?{re.escape(end)}(?:\n|$)", re.S)
    return pattern.sub("\n", text).strip() + ("\n" if text.strip() else "")


def validate_markers(path: Path, start: str, end: str) -> None:
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    if text.count(start) != text.count(end) or text.count(start) > 1:
        raise SystemExit(f"Refusing to edit {path}: managed markers are malformed or duplicated")


def preflight_file(rel: str, target: Path, payload: Path) -> None:
    if not target.exists():
        return
    if rel in prior_owned:
        expected = prior_hashes.get(rel)
        if not expected and not force:
            raise SystemExit(f"Cannot verify ownership baseline for {rel}. Use --force to replace it.")
        if expected and sha256(target) != expected and not force:
            raise SystemExit(f"Refusing to overwrite locally modified managed {rel}. Use --force to replace it.")
    elif target.read_bytes() != payload.read_bytes() and not force:
        raise SystemExit(f"Refusing to overwrite existing unowned {rel}. Use --force to claim it.")


if not skip_skill:
    preflight_file(rel_skill, skill_target, skill_tmp)
if not skip_mcp:
    preflight_file(rel_server, server_target, server_tmp)
validate_markers(codex_config, MCP_START, MCP_END)
validate_markers(agents_md, GUIDANCE_START, GUIDANCE_END)
validate_markers(user_config, PROVIDER_START, PROVIDER_END)


def install_file(rel: str, target: Path, payload: Path) -> str:
    if dry_run:
        return f"would {'update' if target.exists() else 'create'} {rel}"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(payload.read_bytes())
    return f"installed {rel}"


def retire_agent() -> str | None:
    if obsolete_agent not in prior_owned or not obsolete_agent_target.is_file():
        return None
    expected = prior_hashes.get(obsolete_agent)
    if expected and sha256(obsolete_agent_target) != expected:
        return f"preserved locally modified obsolete {obsolete_agent}"
    if dry_run:
        return f"would remove obsolete {obsolete_agent}"
    obsolete_agent_target.unlink()
    return f"removed obsolete {obsolete_agent}"


def retire_provider() -> str | None:
    if not user_config.is_file():
        return None
    text = user_config.read_text(encoding="utf-8")
    if PROVIDER_START not in text:
        return None
    if dry_run:
        return f"would remove obsolete zz_lmstudio_read provider from {user_config}"
    user_config.write_text(remove_block(text, PROVIDER_START, PROVIDER_END), encoding="utf-8")
    return f"removed obsolete zz_lmstudio_read provider from {user_config}"


def ensure_config() -> str:
    if skip_mcp:
        return "skipped .codex/config.toml MCP registration"
    existing = codex_config.read_text(encoding="utf-8") if codex_config.exists() else ""
    if MCP_START not in existing and re.search(r"(?m)^\[mcp_servers\.readsubagent\]\s*$", existing):
        return "preserved existing unmanaged readsubagent MCP server in .codex/config.toml"
    next_text, replaced = replace_block(existing, MCP_START, MCP_END, MCP_BLOCK)
    if dry_run:
        return f"would {'update' if replaced else 'add'} .codex/config.toml MCP registration"
    codex_config.parent.mkdir(parents=True, exist_ok=True)
    codex_config.write_text(next_text.rstrip() + "\n", encoding="utf-8")
    return f"{'updated' if replaced else 'added'} .codex/config.toml MCP registration"


def ensure_guidance() -> str:
    if skip_agents_md:
        return "skipped AGENTS.md guidance"
    existing = agents_md.read_text(encoding="utf-8") if agents_md.exists() else "# Codex Guidance\n"
    next_text, replaced = replace_block(existing, GUIDANCE_START, GUIDANCE_END, GUIDANCE_BLOCK)
    if dry_run:
        return f"would {'update' if replaced else 'add'} AGENTS.md read-planning block"
    agents_md.write_text(next_text.rstrip() + "\n", encoding="utf-8")
    return f"{'updated' if replaced else 'added'} AGENTS.md read-planning block"


actions: list[str] = []
retired = retire_agent()
if retired:
    actions.append(retired)
provider_retired = retire_provider()
if provider_retired:
    actions.append(provider_retired)
if skip_skill:
    actions.append("skipped Codex readsubagent skill")
else:
    actions.append(install_file(rel_skill, skill_target, skill_tmp))
if skip_mcp:
    actions.append("skipped repo-local Codex MCP server")
else:
    actions.append(install_file(rel_server, server_target, server_tmp))
actions.extend([ensure_config(), ensure_guidance()])

if not dry_run:
    owned = set(prior_owned)
    owned.discard(obsolete_agent)
    if not skip_skill:
        owned.add(rel_skill)
    if not skip_mcp:
        owned.add(rel_server)
    owned = {rel for rel in owned if (project_dir / rel).is_file() and rel not in {".codex/config.toml"}}
    refreshed = ({rel_skill} if not skip_skill else set()) | ({rel_server} if not skip_mcp else set())
    hashes = {}
    for rel in sorted(owned):
        hashes[rel] = sha256(project_dir / rel) if rel in refreshed or rel not in prior_hashes else prior_hashes[rel]
    prior_blocks = set(prior.get("managed_blocks") if isinstance(prior.get("managed_blocks"), list) else [])
    prior_blocks.discard("~/.codex/config.toml:zz-codex-readsubagent")
    if not skip_agents_md:
        prior_blocks.add("AGENTS.md:zz-codex-readsubagent")
    if not skip_mcp:
        prior_blocks.add(".codex/config.toml:zz-codex-readsubagent-mcp")
    state = {
        "installer": "zz-codex-readsubagent",
        "schemaVersion": 2,
        "source_url": source_base,
        "mcp_source_url": mcp_source_base,
        "owned_files": sorted(owned),
        "managed_blocks": sorted(prior_blocks),
        "file_hashes": hashes,
        "mcp_server": {
            "name": "readsubagent",
            "config_path": str(codex_config),
            "server_path": rel_server,
            "model": model,
            "pi_bin": pi_bin,
            "managed": ".codex/config.toml:zz-codex-readsubagent-mcp" in prior_blocks,
        },
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

print("")
print("  zz Codex readsubagent install plan" if dry_run else "  zz Codex readsubagent installed")
for action in actions:
    print(f"  -> {action}")
print(f"  -> model: {model}")
print(f"  -> target repo: {project_dir}")
if not dry_run:
    print("  -> restart Codex from this repo so it discovers .codex/skills/readsubagent/SKILL.md and .codex/config.toml")
PY
