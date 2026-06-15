#!/usr/bin/env bash
# zzPi — dependency-aware project-local pi plug installer for Linux / macOS / Git Bash.
#
# From a cloned zzPi checkout:
#   ./install.sh --select
#
# From the public git repo raw URL:
#   curl -fsSL ${ZZ_PI_RAW_BASE:-https://raw.githubusercontent.com/dezverev/zzPi/main}/install.sh | bash -s -- --select
#
# Bootstraps the /zz-plugs manager plus selected pi plugs into ./.pi/ for the
# project you run it from.
# It can optionally direct-install selected plugs.
# This is intentionally NOT
# global: pi auto-discovers project-local extensions from .pi/extensions/.
set -euo pipefail

usage() {
  cat <<'EOF'
install.sh [options]

Options:
  --list                 List available visible plugs and exit.
  --select               Prompt for plug ids/numbers (empty = all visible).
  --all                  Bootstrap manager plus all visible plugs.
  --plugins a,b          Bootstrap manager plus these requested plug ids (hard deps auto-added).
                          Use --plugins none for no visible default plugs.
  --exclude a,b          Remove these ids from the requested set before resolving deps.
  --reset-config         Overwrite .config.jsonc files instead of merging missing defaults.
  --force                Allow claiming/overwriting existing unowned target files.
  --dry-run              Show the resolved install plan without writing .pi.
  -h, --help             Show this help.

With no --plugins/--all/--select, an existing install keeps its selected plug set;
first install uses the default visible plug set.

Environment:
  ZZ_PI_RAW_BASE              Raw git URL for this repo (default stamped at export time).
  ZZ_PI_PLUGS_URL              Exact plug bundle URL (default: local checkout ./pi-plugs,
                               otherwise $ZZ_PI_RAW_BASE/pi-plugs)
  ZZ_LIB_URL                   Exact shared zz-lib bundle URL (default: local checkout ./zz-lib,
                               otherwise $ZZ_PI_RAW_BASE/zz-lib)
  ZZ_PI_PLUGS_PROJECT_DIR      Target repo/project dir (default: current directory)
  ZZ_PI_PLUGS                  Same as --plugins
  ZZ_PI_PLUGS_ALL=1            Same as --all
  ZZ_PI_PLUGS_EXCLUDE          Same as --exclude
  ZZ_PI_PLUGS_SELECT=1         Same as --select
  ZZ_PI_PLUGS_RESET_CONFIG=1   Same as --reset-config
  ZZ_PI_PLUGS_FORCE=1          Same as --force
  ZZ_PI_PLUGS_DRY_RUN=1        Same as --dry-run
  ZZ_PI_PLUGS_ALLOW_SUBDIR=1   Allow running from a git subdirectory.
EOF
}

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [ -n "$SCRIPT_PATH" ] && [ "$SCRIPT_PATH" != "bash" ] && [ "$SCRIPT_PATH" != "-" ] && [ -f "$SCRIPT_PATH" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd -P)"
fi

DEFAULT_RAW_BASE="https://raw.githubusercontent.com/dezverev/zzPi/main"
DEFAULT_RAW_BASE="${DEFAULT_RAW_BASE%/}"
RAW_BASE="${ZZ_PI_RAW_BASE:-$DEFAULT_RAW_BASE}"
RAW_BASE="${RAW_BASE%/}"
if [ -n "${ZZ_PI_PLUGS_URL:-}" ]; then
  PLUGS_BASE="$ZZ_PI_PLUGS_URL"
elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/pi-plugs/manifest.json" ] && [ -f "$SCRIPT_DIR/pi-plugs/pi-plugs.tar.gz" ]; then
  PLUGS_BASE="file://$SCRIPT_DIR/pi-plugs"
else
  PLUGS_BASE="$RAW_BASE/pi-plugs"
fi
PLUGS_BASE="${PLUGS_BASE%/}"
if [ -n "${ZZ_LIB_URL:-}" ]; then
  ZZ_LIB_BASE="$ZZ_LIB_URL"
elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/zz-lib/manifest.json" ]; then
  ZZ_LIB_BASE="file://$SCRIPT_DIR/zz-lib"
else
  ZZ_LIB_BASE="$RAW_BASE/zz-lib"
fi
ZZ_LIB_BASE="${ZZ_LIB_BASE%/}"
PROJECT_DIR="${ZZ_PI_PLUGS_PROJECT_DIR:-$PWD}"

LIST=0
SELECT="${ZZ_PI_PLUGS_SELECT:-0}"
ALL="${ZZ_PI_PLUGS_ALL:-0}"
PLUGINS="${ZZ_PI_PLUGS:-}"
EXCLUDE="${ZZ_PI_PLUGS_EXCLUDE:-}"
RESET_CONFIG="${ZZ_PI_PLUGS_RESET_CONFIG:-0}"
FORCE="${ZZ_PI_PLUGS_FORCE:-0}"
DRY_RUN="${ZZ_PI_PLUGS_DRY_RUN:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --list) LIST=1; shift ;;
    --select) SELECT=1; shift ;;
    --all) ALL=1; shift ;;
    --plugins) [ "$#" -ge 2 ] || { echo "--plugins needs a value" >&2; exit 2; }; PLUGINS="$2"; shift 2 ;;
    --plugins=*) PLUGINS="${1#*=}"; shift ;;
    --exclude) [ "$#" -ge 2 ] || { echo "--exclude needs a value" >&2; exit 2; }; EXCLUDE="$2"; shift 2 ;;
    --exclude=*) EXCLUDE="${1#*=}"; shift ;;
    --reset-config) RESET_CONFIG=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "install.sh needs curl" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "install.sh needs python3" >&2; exit 1; }

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd -P)"

if [ -z "${ZZ_PI_PLUGS_ALLOW_SUBDIR:-}" ] && command -v git >/dev/null 2>&1; then
  if git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GIT_ROOT="$(git -C "$PROJECT_DIR" rev-parse --show-toplevel)"
    GIT_ROOT="$(cd "$GIT_ROOT" && pwd -P)"
    if [ "$PROJECT_DIR" != "$GIT_ROOT" ]; then
      echo "Refusing to install into a git subdirectory:" >&2
      echo "  current: $PROJECT_DIR" >&2
      echo "  repo root: $GIT_ROOT" >&2
      echo "Run this from the repo root, or set ZZ_PI_PLUGS_PROJECT_DIR=$GIT_ROOT." >&2
      exit 1
    fi
  fi
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

MANIFEST_TMP="$TMP_DIR/manifest.json"
ARCHIVE_TMP="$TMP_DIR/pi-plugs.tar.gz"

curl -fsSL "$PLUGS_BASE/manifest.json" -o "$MANIFEST_TMP"
if [ "$LIST" != "1" ]; then
  curl -fsSL "$PLUGS_BASE/pi-plugs.tar.gz" -o "$ARCHIVE_TMP"
fi

ZZ_PI_PLUGS_LIST="$LIST" \
ZZ_PI_PLUGS_SELECT="$SELECT" \
ZZ_PI_PLUGS_ALL="$ALL" \
ZZ_PI_PLUGS="$PLUGINS" \
ZZ_PI_PLUGS_EXCLUDE="$EXCLUDE" \
ZZ_PI_PLUGS_RESET_CONFIG="$RESET_CONFIG" \
ZZ_PI_PLUGS_FORCE="$FORCE" \
ZZ_PI_PLUGS_DRY_RUN="$DRY_RUN" \
python3 - "$PROJECT_DIR" "$MANIFEST_TMP" "$ARCHIVE_TMP" "$PLUGS_BASE" "$ZZ_LIB_BASE" <<'PY'
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import hashlib
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

project_dir = Path(sys.argv[1]).resolve()
manifest_path = Path(sys.argv[2])
archive_path = Path(sys.argv[3])
plugs_base = sys.argv[4]
zz_lib_base = sys.argv[5].rstrip("/")
pi_dir = project_dir / ".pi"
state_path = pi_dir / "zz-pi-plugs-manifest.json"
zz_lib_state_path = pi_dir / "zz-lib-manifest.json"


def truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


list_only = truthy(os.environ.get("ZZ_PI_PLUGS_LIST"))
select_mode = truthy(os.environ.get("ZZ_PI_PLUGS_SELECT"))
all_mode = truthy(os.environ.get("ZZ_PI_PLUGS_ALL"))
plugin_arg = os.environ.get("ZZ_PI_PLUGS", "")
exclude_arg = os.environ.get("ZZ_PI_PLUGS_EXCLUDE", "")
reset_config = truthy(os.environ.get("ZZ_PI_PLUGS_RESET_CONFIG"))
force = truthy(os.environ.get("ZZ_PI_PLUGS_FORCE"))
dry_run = truthy(os.environ.get("ZZ_PI_PLUGS_DRY_RUN"))


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


manifest = load_json(manifest_path)
plugins = manifest.get("plugins", [])
if not isinstance(plugins, list):
    raise SystemExit("bad manifest: plugins is not an array")
plugin_by_id = {p.get("id"): p for p in plugins if isinstance(p, dict) and isinstance(p.get("id"), str)}
visible_ids = [p["id"] for p in plugins if isinstance(p, dict) and not p.get("internal")]
file_info = {f.get("path"): f for f in manifest.get("files", []) if isinstance(f, dict)}
manager_id = "zz-plug-manager"
manager_config = "extensions/zz-plug-manager.config.jsonc"
if manager_id not in plugin_by_id:
    raise SystemExit(f"bad manifest: missing required {manager_id} plugin")


def split_tokens(value: str) -> list[str]:
    return [part for part in re.split(r"[\s,]+", value.strip()) if part]


def plugin_title(pid: str) -> str:
    plugin = plugin_by_id.get(pid) or {}
    return str(plugin.get("title") or pid)


def print_plugin_list() -> None:
    print("Available pi plugs:")
    for i, pid in enumerate(visible_ids, 1):
        plugin = plugin_by_id[pid]
        deps = [dep for dep in plugin.get("pluginDeps", []) if dep in plugin_by_id]
        dep_text = f" (requires: {', '.join(deps)})" if deps else ""
        desc = str(plugin.get("description") or "")
        print(f"  {i:2d}) {pid:<24} {plugin_title(pid)}{dep_text}")
        if desc:
            print(f"      {desc}")


if list_only:
    print_plugin_list()
    raise SystemExit(0)


def parse_plugin_refs(value: str) -> list[str]:
    selected: list[str] = []
    for token in split_tokens(value):
        lower = token.lower()
        if lower == "all":
            for pid in visible_ids:
                if pid not in selected:
                    selected.append(pid)
            continue
        if lower in {"none", "empty"}:
            continue
        if token.isdigit():
            idx = int(token)
            if idx < 1 or idx > len(visible_ids):
                raise SystemExit(f"plugin number out of range: {token}")
            pid = visible_ids[idx - 1]
        else:
            pid = token
            if pid not in plugin_by_id:
                raise SystemExit(f"unknown pi plug: {pid}")
        if plugin_by_id.get(pid, {}).get("internal"):
            raise SystemExit(f"{pid} is internal and cannot be selected directly")
        if pid not in selected:
            selected.append(pid)
    return selected


def prompt_for_plugins() -> list[str]:
    print_plugin_list()
    prompt = "\nSelect plugs by number/id/comma list [all]: "
    try:
        with open("/dev/tty", "r+", encoding="utf-8") as tty:
            tty.write(prompt)
            tty.flush()
            answer = tty.readline()
    except OSError as exc:
        raise SystemExit("--select needs a TTY; use --plugins a,b for non-interactive install") from exc
    answer = answer.strip()
    if not answer:
        return list(visible_ids)
    return parse_plugin_refs(answer)


def read_existing_selected_plugins() -> list[str] | None:
    if not state_path.is_file():
        return None
    try:
        state = load_json(state_path)
    except Exception:
        return None

    def normalize_plugin_ids(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        selected: list[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            if item not in visible_ids:
                continue
            if item not in selected:
                selected.append(item)
        return selected

    if isinstance(state.get("selected_plugins"), list):
        return normalize_plugin_ids(state.get("selected_plugins"))
    if isinstance(state.get("installed_plugins"), list):
        return normalize_plugin_ids(state.get("installed_plugins"))
    return None


if plugin_arg.strip():
    requested = parse_plugin_refs(plugin_arg)
elif all_mode:
    requested = list(visible_ids)
elif select_mode:
    requested = prompt_for_plugins()
else:
    # Re-runs without explicit --plugins keep the existing selected plug set,
    # including an intentionally empty set from --plugins none.
    # First install still bootstraps the generally useful context-tools pane and Tetris.
    existing_selection = read_existing_selected_plugins()
    requested = (
        existing_selection
        if existing_selection is not None
        else parse_plugin_refs("context-tools,tetris")
    )

exclude = set(parse_plugin_refs(exclude_arg)) if exclude_arg.strip() else set()
requested = [pid for pid in requested if pid not in exclude]


def dependency_closure(roots: list[str]) -> list[str]:
    ordered: list[str] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(pid: str) -> None:
        if pid not in plugin_by_id:
            raise SystemExit(f"unknown plugin dependency: {pid}")
        if pid in visited:
            return
        if pid in visiting:
            raise SystemExit(f"plugin dependency cycle involving {pid}")
        visiting.add(pid)
        for dep in plugin_by_id[pid].get("pluginDeps", []) or []:
            visit(str(dep))
        visiting.remove(pid)
        visited.add(pid)
        ordered.append(pid)

    for root in roots:
        visit(root)
    return ordered


installed = [manager_id] + [pid for pid in dependency_closure([manager_id] + requested) if pid != manager_id]
auto_required = [pid for pid in installed if pid != manager_id and pid not in requested]


def version_key(value: str) -> tuple[int, ...]:
    parts = [int(part) for part in re.split(r"[^0-9]+", value) if part]
    return tuple(parts or [0])


def normalize_shared_dep(value: Any, owner: str) -> tuple[str, str]:
    if isinstance(value, str):
        return value, "0.0.0"
    if isinstance(value, dict) and isinstance(value.get("id"), str):
        min_version = value.get("minVersion", value.get("min_version", "0.0.0"))
        return value["id"], str(min_version or "0.0.0")
    raise SystemExit(f"bad sharedDeps entry for {owner}")


def required_shared_libs_for_plugins(plugin_ids: list[str]) -> list[dict[str, str]]:
    merged: dict[str, str] = {}
    for pid in plugin_ids:
        plugin = plugin_by_id[pid]
        for raw_dep in plugin.get("sharedDeps", []) or []:
            dep_id, min_version = normalize_shared_dep(raw_dep, pid)
            if dep_id != "zz-lib":
                raise SystemExit(f"unsupported shared dependency for {pid}: {dep_id}")
            if dep_id not in merged or version_key(min_version) > version_key(merged[dep_id]):
                merged[dep_id] = min_version
    return [{"id": dep_id, "minVersion": min_version} for dep_id, min_version in sorted(merged.items())]


required_shared_libs = required_shared_libs_for_plugins(installed)


def add_owner(owners: dict[str, list[str]], rel: str, owner: str) -> None:
    rel = rel.replace("\\", "/").lstrip("/")
    if not rel or ".." in rel.split("/"):
        raise SystemExit(f"bad manifest path: {rel}")
    owners.setdefault(rel, [])
    if owner not in owners[rel]:
        owners[rel].append(owner)


owned_files: dict[str, list[str]] = {}
for rel in manifest.get("commonFiles", []) or []:
    add_owner(owned_files, str(rel), "__common__")
config_files: set[str] = set()
for pid in installed:
    plugin = plugin_by_id[pid]
    add_owner(owned_files, str(plugin["entry"]), pid)
    for rel in plugin.get("fileDeps", []) or []:
        add_owner(owned_files, str(rel), pid)
    for rel in plugin.get("configFiles", []) or []:
        rel = str(rel).replace("\\", "/").lstrip("/")
        config_files.add(rel)
        add_owner(owned_files, rel, pid)

missing = sorted(path for path in owned_files if path not in file_info)
if missing:
    raise SystemExit("manifest/archive missing required files:\n  - " + "\n  - ".join(missing))

print("Resolved pi plug install plan:")
print("  requested: " + (", ".join(requested) if requested else "(none)"))
if auto_required:
    print("  auto deps: " + ", ".join(auto_required))
if required_shared_libs:
    print("  shared:   " + ", ".join(f"{dep['id']}>={dep['minVersion']}" for dep in required_shared_libs))
print(f"  files:     {len(owned_files)}")
print(f"  target:    {pi_dir}")
if dry_run:
    print("\nDry run: no files written.")
    raise SystemExit(0)

if not archive_path.is_file():
    raise SystemExit("archive was not downloaded")


def hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_target(base: Path, rel: str) -> Path:
    target = (base / rel).resolve()
    base_real = base.resolve()
    if target != base_real and base_real not in target.parents:
        raise SystemExit(f"path escapes target .pi: {rel}")
    return target


def safe_extract(archive: Path, dest: Path) -> None:
    dest_real = dest.resolve()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            rel = member.name.replace("\\", "/").lstrip("/")
            if not rel or ".." in rel.split("/"):
                raise SystemExit(f"archive contains unsafe path: {member.name}")
            target = (dest / rel).resolve()
            if target != dest_real and dest_real not in target.parents:
                raise SystemExit(f"archive path escapes extraction dir: {member.name}")
        tar.extractall(dest)


def bundle_file_url(base_url: str, rel: str) -> str:
    encoded = "/".join(urllib.parse.quote(part) for part in rel.split("/"))
    return f"{base_url.rstrip('/')}/files/{encoded}"


def download_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url) as response:  # noqa: S310 - installer fetches user-configured bundle URLs
        return response.read()


def download_json(url: str) -> dict[str, Any]:
    parsed = json.loads(download_bytes(url).decode("utf-8"))
    if not isinstance(parsed, dict):
        raise SystemExit(f"bad JSON response from {url}")
    return parsed


def shared_lib_version(manifest: dict[str, Any]) -> str:
    shared_lib = manifest.get("sharedLib")
    if isinstance(shared_lib, dict) and isinstance(shared_lib.get("version"), str):
        return shared_lib["version"]
    if isinstance(manifest.get("zzLibVersion"), str):
        return manifest["zzLibVersion"]
    if isinstance(manifest.get("version"), str):
        return manifest["version"]
    return "0.0.0"


def ensure_zz_lib(dep: dict[str, str]) -> int:
    min_version = dep["minVersion"]
    manifest_url = f"{zz_lib_base}/manifest.json"
    lib_manifest = download_json(manifest_url)
    lib_id = lib_manifest.get("sharedLib", {}).get("id") if isinstance(lib_manifest.get("sharedLib"), dict) else "zz-lib"
    if lib_id != "zz-lib":
        raise SystemExit(f"bad zz-lib manifest: sharedLib.id is {lib_id!r}")
    lib_version = shared_lib_version(lib_manifest)
    if version_key(lib_version) < version_key(min_version):
        raise SystemExit(f"zz-lib {lib_version} from {zz_lib_base} is older than required {min_version}")

    lib_common = [str(path) for path in lib_manifest.get("commonFiles", []) or []]
    if not lib_common:
        raise SystemExit("bad zz-lib manifest: commonFiles is empty")
    lib_files = {str(f.get("path")): f for f in lib_manifest.get("files", []) if isinstance(f, dict)}
    missing = [rel for rel in lib_common if rel not in lib_files]
    if missing:
        raise SystemExit("zz-lib manifest is missing files:\n  - " + "\n  - ".join(missing))

    old_state = load_json(zz_lib_state_path) if zz_lib_state_path.is_file() else {}
    old_owned_raw = old_state.get("owned_files")
    old_owned = {str(path) for path in old_owned_raw} if isinstance(old_owned_raw, dict) else set()

    collisions: list[str] = []
    for rel in sorted(lib_common):
        target = safe_target(pi_dir, rel)
        if target.exists() and rel not in old_owned and not force:
            collisions.append(rel)
    if collisions:
        raise SystemExit(
            "Refusing to overwrite existing unowned zz-lib files:\n  - "
            + "\n  - ".join(collisions)
            + "\nUse --force if you want this installer to claim them."
        )

    pi_dir.mkdir(parents=True, exist_ok=True)
    owned_files_for_state = {rel: ["zz-lib"] for rel in sorted(lib_common)}
    for rel in sorted(lib_common):
        info = lib_files[rel]
        expected = str(info.get("sha256") or "")
        data = download_bytes(bundle_file_url(zz_lib_base, rel))
        actual = hashlib.sha256(data).hexdigest()
        if expected and actual != expected:
            raise SystemExit(f"zz-lib hash mismatch for {rel}: expected {expected}, got {actual}")
        target = safe_target(pi_dir, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    file_hashes = {rel: hash_file(safe_target(pi_dir, rel)) for rel in sorted(lib_common)}
    state = {
        "installer": "zz-lib",
        "schemaVersion": 1,
        "zzLibVersion": lib_version,
        "manifest_updated_at": lib_manifest.get("updated_at"),
        "source": lib_manifest.get("source"),
        "bundle_url": zz_lib_base,
        "owned_files": owned_files_for_state,
        "file_hashes": file_hashes,
    }
    zz_lib_state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    return len(lib_common)


def ensure_shared_libs(deps: list[dict[str, str]]) -> list[str]:
    ensured: list[str] = []
    for dep in deps:
        if dep["id"] != "zz-lib":
            raise SystemExit(f"unsupported shared dependency: {dep['id']}")
        count = ensure_zz_lib(dep)
        ensured.append(f"zz-lib {dep['minVersion']} ({count} files)")
    return ensured


def strip_json_comments(text: str) -> str:
    output: list[str] = []
    in_string = False
    escaping = False
    i = 0
    while i < len(text):
        char = text[i]
        next_char = text[i + 1] if i + 1 < len(text) else ""
        if in_string:
            output.append(char)
            if escaping:
                escaping = False
            elif char == "\\":
                escaping = True
            elif char == '"':
                in_string = False
            i += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            i += 1
            continue
        if char == "/" and next_char == "/":
            i += 2
            while i < len(text) and text[i] not in "\r\n":
                i += 1
            if i < len(text):
                output.append("\n")
            i += 1
            continue
        if char == "/" and next_char == "*":
            i += 2
            while i + 1 < len(text) and not (text[i] == "*" and text[i + 1] == "/"):
                if text[i] in "\r\n":
                    output.append("\n")
                i += 1
            i += 2
            continue
        output.append(char)
        i += 1
    return "".join(output)


def strip_json_trailing_commas(text: str) -> str:
    output: list[str] = []
    in_string = False
    escaping = False
    i = 0
    while i < len(text):
        char = text[i]
        if in_string:
            output.append(char)
            if escaping:
                escaping = False
            elif char == "\\":
                escaping = True
            elif char == '"':
                in_string = False
            i += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            i += 1
            continue
        if char == ",":
            cursor = i + 1
            while cursor < len(text) and text[cursor].isspace():
                cursor += 1
            if cursor < len(text) and text[cursor] in "}]":
                i += 1
                continue
        output.append(char)
        i += 1
    return "".join(output)


def parse_jsonc_object(text: str, label: str) -> dict[str, Any]:
    parsed = json.loads(strip_json_trailing_commas(strip_json_comments(text)))
    if not isinstance(parsed, dict):
        raise ValueError(f"{label} must contain a JSON object")
    return parsed


def clone_json(value: Any) -> Any:
    return json.loads(json.dumps(value))


def fill_missing_config(existing: dict[str, Any], defaults: dict[str, Any]) -> bool:
    changed = False
    for key, default_value in defaults.items():
        if key not in existing:
            existing[key] = clone_json(default_value)
            changed = True
            continue
        existing_value = existing[key]
        if isinstance(existing_value, dict) and isinstance(default_value, dict):
            changed = fill_missing_config(existing_value, default_value) or changed
    return changed


def merge_config_file(target: Path, source: Path, rel: str, warnings: list[str]) -> bool:
    try:
        existing = parse_jsonc_object(target.read_text(encoding="utf-8"), rel)
        defaults = parse_jsonc_object(source.read_text(encoding="utf-8"), rel)
        if not fill_missing_config(existing, defaults):
            return False
        target.write_text(
            "// Updated by zz pi plugs: existing values preserved; missing defaults filled from the latest bundle.\n"
            + json.dumps(existing, indent=2)
            + "\n",
            encoding="utf-8",
        )
        return True
    except Exception as exc:
        warnings.append(f"preserved config without merging {rel}: {exc}")
        return False


def load_old_state() -> dict[str, Any]:
    if not state_path.is_file():
        return {}
    try:
        return load_json(state_path)
    except Exception:
        return {}


ensured_shared_libs = ensure_shared_libs(required_shared_libs)

old_state = load_old_state()
old_owned_raw = old_state.get("owned_files")
if isinstance(old_owned_raw, dict):
    old_owned = {str(path) for path in old_owned_raw}
else:
    # Migration path from the first non-selectable installer, which stored the server manifest directly.
    old_owned = {str(item.get("path")) for item in old_state.get("files", []) if isinstance(item, dict) and item.get("path")}
old_hashes = old_state.get("file_hashes") if isinstance(old_state.get("file_hashes"), dict) else {}
if not old_hashes:
    old_hashes = {
        str(item.get("path")): str(item.get("sha256"))
        for item in old_state.get("files", [])
        if isinstance(item, dict) and item.get("path") and item.get("sha256")
    }
old_config_files = set(old_state.get("config_files", [])) if isinstance(old_state.get("config_files"), list) else {
    path for path in old_owned if path.endswith(".config.jsonc")
}

new_owned = set(owned_files)
collisions: list[str] = []
for rel in sorted(new_owned):
    target = safe_target(pi_dir, rel)
    if target.exists() and rel not in old_owned and not force:
        collisions.append(rel)
if collisions:
    raise SystemExit(
        "Refusing to overwrite existing unowned .pi files:\n  - "
        + "\n  - ".join(collisions)
        + "\nUse --force if you want this installer to claim them."
    )

extract_dir = Path(tempfile.mkdtemp(prefix="zz-pi-plugs-extract-"))
try:
    safe_extract(archive_path, extract_dir)
    pi_dir.mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []
    removed: list[str] = []
    preserved_configs: list[str] = []
    merged_configs: list[str] = []

    for rel in sorted(old_owned - new_owned, reverse=True):
        target = safe_target(pi_dir, rel)
        if not target.exists() or not target.is_file():
            continue
        if rel in old_config_files:
            previous_hash = old_hashes.get(rel)
            if previous_hash and hash_file(target) != previous_hash:
                warnings.append(f"kept modified config from removed plug: {rel}")
                continue
        target.unlink()
        removed.append(rel)

    # Clean empty directories under .pi, deepest first.
    for root, dirs, _files in os.walk(pi_dir, topdown=False):
        for dirname in dirs:
            path = Path(root) / dirname
            try:
                path.rmdir()
            except OSError:
                pass

    for rel in sorted(new_owned):
        source = safe_target(extract_dir, rel)
        if not source.is_file():
            raise SystemExit(f"archive is missing required file: {rel}")
        target = safe_target(pi_dir, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        if rel in config_files and target.exists() and not reset_config:
            if merge_config_file(target, source, rel, warnings):
                merged_configs.append(rel)
            else:
                preserved_configs.append(rel)
            continue
        shutil.copy2(source, target)

    if manager_config in new_owned and manager_config not in preserved_configs and manager_config not in merged_configs:
        manager_config_path = safe_target(pi_dir, manager_config)
        manager_config_path.write_text(
            '{\n'
            '  // Static source served by zzHostWebsite.\n'
            f'  "sourceUrl": "{plugs_base}",\n'
            f'  "zzLibUrl": "{zz_lib_base}",\n\n'
            '  // Reload automatically after /zz-plugs install/remove/set/update succeeds.\n'
            '  "autoReload": true,\n'
            '}\n',
            encoding="utf-8",
        )

    file_hashes = {rel: hash_file(safe_target(pi_dir, rel)) for rel in sorted(new_owned) if safe_target(pi_dir, rel).is_file()}
    state = {
        "installer": "zz-pi-plugs",
        "schemaVersion": 2,
        "manifest_updated_at": manifest.get("updated_at"),
        "source": manifest.get("source"),
        "bundle_url": plugs_base,
        "selected_plugins": requested,
        "installed_plugins": installed,
        "auto_required_plugins": auto_required,
        "required_shared_libs": required_shared_libs,
        "owned_files": {rel: owned_files[rel] for rel in sorted(owned_files)},
        "config_files": sorted(config_files),
        "file_hashes": file_hashes,
    }
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
finally:
    shutil.rmtree(extract_dir, ignore_errors=True)

print("\n  zz pi plugs installed project-locally")
print(f"  -> selected: {', '.join(requested) if requested else '(none)'}")
if auto_required:
    print(f"  -> auto deps: {', '.join(auto_required)}")
if ensured_shared_libs:
    print(f"  -> shared libs: {', '.join(ensured_shared_libs)}")
print(f"  -> installed plugins: {len(installed)}")
print(f"  -> files owned: {len(new_owned)}")
if merged_configs:
    print(f"  -> updated configs: {len(merged_configs)}")
if preserved_configs:
    print(f"  -> preserved configs: {len(preserved_configs)}")
if removed:
    print(f"  -> removed stale files: {len(removed)}")
for warning in warnings:
    print(f"  warning: {warning}")
print(f"  -> target: {pi_dir}")
print("  -> restart pi or run /reload in this repo")
PY
