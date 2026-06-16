# zzPi

Public export of project-local Pi extensions/plugins.

This repository is generated. Do not edit generated `pi-plugs/` or `zz-lib/` artifacts directly; regenerate this repo from the source checkout instead.

## Install

From a cloned checkout of this repo:

```bash
./install.sh --select
```

From the public git repo raw files:

```bash
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install.sh | bash -s -- --select
```

Useful options:

```bash
./install.sh --list
./install.sh --all
./install.sh --plugins git-status,readsubagent,explorationsubagent
./install.sh --dry-run --select
```

The installer writes project-local files under `./.pi/` in the directory where you run it.

## Codex, Claude, and Copilot readsubagent

The same read-only **readsubagent** (a scout that runs on a local model and returns a cited read plan) is published here for Codex, Claude Code, and Copilot/VS Code too. Run from a target repo root.

Codex (custom agent + user-level LM Studio provider):

```bash
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-codex-readsubagent.sh | bash
```
```powershell
irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-codex-readsubagent.ps1 | iex
```

Claude Code (subagent + stdio MCP server):

```bash
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-claude-readsubagent.sh | bash
```
```powershell
irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-claude-readsubagent.ps1 | iex
```

Copilot / VS Code (workspace MCP server + Copilot instructions):

```bash
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-copilot-readsubagent.sh | bash
```
```powershell
irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-copilot-readsubagent.ps1 | iex
```

MCP server only (any MCP-capable harness):

```bash
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-zz-readsubagent-mcp.sh | bash
```

The Claude/Copilot/MCP readsubagent spawns a headless `pi` child on a local model, so it needs `pi` on PATH with a local-model provider — install the `zz-local-models` plug from this repo (`./install.sh --plugins zz-local-models`) or define your own Pi provider — and a local OpenAI-compatible server (e.g. LM Studio) reachable. Endpoints default to `127.0.0.1` in this public export; override with the documented `ZZ_*` env vars.

## Repository layout

- `install.sh` — public installer script.
- `pi-plugs/manifest.json` — generated plugin manifest.
- `pi-plugs/pi-plugs.tar.gz` — generated plugin archive consumed by the installer.
- `pi-plugs/files/` — exported source files used to build the archive.
- `zz-lib/manifest.json` — generated shared runtime manifest.
- `zz-lib/pi-plugs.tar.gz` — generated shared runtime archive.
- `zz-lib/files/` — exported shared runtime source files.
- `pi-plugs/files/README.md` — exported plugin catalog documentation.
- `pi-plugs/files/WORKFLOWMODE.md` — exported workflow mode documentation.
- `install-codex-readsubagent.{sh,ps1}` + `codex-readsubagent/readsubagent.toml` — Codex readsubagent installer + agent.
- `install-claude-readsubagent.{sh,ps1}` + `claude-readsubagent/readsubagent.md` — Claude Code readsubagent installer + subagent.
- `install-copilot-readsubagent.{sh,ps1}` — Copilot/VS Code readsubagent installer + workspace MCP instructions.
- `install-zz-readsubagent-mcp.{sh,ps1}` + `zz-readsubagent-mcp/` — harness-neutral readsubagent MCP server.

## Related docs

- [Plugin source README](pi-plugs/files/README.md)
- [Workflow mode guide](pi-plugs/files/WORKFLOWMODE.md)
