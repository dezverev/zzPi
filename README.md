# zzPi

`zzPi` is a minimum-complete agentic coding system built on [Pi](https://pi.dev).
It keeps the main model's context focused on decisions and edits while bounded
child agents handle repository grounding, diagnosis, design, implementation,
and independent challenge.

**Start with the manifesto:**
[The Minimum Complete Agentic Coding System](docs/minimum-complete-agentic-system.md).
It explains why a bare harness leaves important workflow gaps, why a large
always-on workflow pack can become context overhead on modern harnesses, and why
this particular set of conditional roles is the smallest useful middle layer.

## What problem it solves

The system targets three recurring costs of agentic coding:

1. **Stale or bloated context** — `readsubagent` inspects the current checkout
   and returns cited files, symbols, line ranges, search anchors, and
   uncertainty instead of filling the main thread with raw discovery.
2. **Single-pass blind spots** — `vettingagents` runs three separate review
   contexts with grounding, live-tree feasibility, and consistency/severity
   lenses so the parent can compare their findings.
3. **One-model economics** — every subagent can use its own model, provider,
   endpoint, and reasoning level. Workspace overrides persist, so each operation
   can use the minimum viable model rather than paying one rate for the session.

Implementation has its own safety loop. `implementationsubagent` accepts one
medium-to-small, independently vettable piece; maintains a persistent ledger;
checkpoints self-reported confidence; and returns early under the protocol when
confidence falls below 80%. The parent retains decomposition, sequencing,
review, validation, integration, and Git.

## The callable system

The parent composes only the roles a task needs:

| Role | Agent | Purpose |
|---|---|---|
| Grounding | `readsubagent` | Factual repository inspection and focused read planning |
| Diagnosis | `debuggersubagent` | Evidence-based root-cause analysis before editing |
| Options | `brainstormer` | Materially different solutions and tradeoffs |
| Design | `designplanner` / `design-loop` | A staged design for one explicitly selected solution |
| Execution | `implementationsubagent` | One bounded implementation piece with ledger and confidence evidence |
| Challenge | `vettingagents` | Three separate adversarial review lenses |
| Clarification | `promptenrichsubagent` | Optional, user-triggered prompt enrichment |

This is not a fixed pipeline. A small documentation edit may need only focused
reading and validation. A regression may add diagnosis. A cross-cutting feature
may use the full design, bounded implementation, and vetting loop.

The roles are workflow contracts, not an operating-system sandbox. Some
boundaries are enforced by schemas and handoff validation; others are enforced
by prompts and tool policy. Tests and parent review remain the final authority.

## Why Pi is the runner

Pi provides the extension and child-process control needed for the full system:

- project-local extensions can register tools and commands;
- child Pi processes can use local or remote OpenAI-compatible providers;
- every subagent can select a different model/reasoning configuration;
- workspace model overrides survive new sessions, restarts, and plug updates;
- local agents can absorb high-volume context work while the main model handles
  consequential reasoning and edits.

Codex, Claude Code, Copilot/VS Code, and other MCP-capable harnesses can use the
Pi-backed `readsubagent` integration. Those integrations provide focused live
repository grounding without requiring the full Pi extension runtime.

## Install Pi plugs

From a cloned zzPi checkout:

```bash
./install.sh --select
```

Or from the public repository:

```bash
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install.sh | bash -s -- --select
```

Useful installer forms:

```bash
./install.sh --list
./install.sh --all
./install.sh --plugins git-status,readsubagent,design-loop
./install.sh --dry-run --select
```

The installer writes project-local files under `./.pi/` in the directory where
it runs. Start Pi there, then use:

```text
/zz-plugs select
```

The selector manages normal Pi plugs and the Codex, Claude, and Copilot
readsubagent integrations from one UI.

## Configure models

Public configs default local endpoints to localhost. Point installed agents at
an LM Studio or other OpenAI-compatible endpoint with:

```text
/zz-model-setup setup
```

Non-interactive form:

```text
/zz-model-setup set http://<your-host>:1234 <model-id> <provider-id>
/reload
```

Each agent also exposes its own model/config command, such as
`/readsubagent model` or `/implementationsubagent model`. A selection is stored
under `.pi/subagent-model-overrides/`; use that agent's `model default` form to
return to its configured default.

## Main commands

- `/zz-plugs select` — install or remove Pi plugs and harness integrations.
- `/zz-model-setup setup` — configure the shared local-model endpoint.
- `/readsubagent ask ...` — request a cited factual repository map or answer.
- `/debuggersubagent ask ...` — request read-only-by-contract diagnosis.
- `/design-loop on|off|toggle|status` — control the callable brainstorm/design tools; the parent invokes them when needed.
- `/implementation-mode toggle` — toggle parent-directed bounded implementation.

## Standalone harness integrations

Run an installer from the target repository root:

```bash
# Codex
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-codex-readsubagent.sh | bash

# Claude Code
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-claude-readsubagent.sh | bash

# Copilot / VS Code
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-copilot-readsubagent.sh | bash

# Generic MCP-capable harness
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-zz-readsubagent-mcp.sh | bash
```

PowerShell counterparts are included beside each shell installer. Pi-backed MCP
operation requires `pi` on `PATH`, a usable Pi provider, and a reachable local
or remote OpenAI-compatible endpoint. Codex can avoid the Pi dependency by
falling back to its native custom agent, but that path still requires Codex
custom-agent support, the configured `zz_lmstudio_read` provider, and a
reachable compatible model endpoint.

## Repository ownership

`zzPi` is the public distribution generated from
[`zzHostWebsite`](https://github.com/dezverev/zzHostWebsite).

Generated paths include `docs/`, `pi-plugs/`, `zz-lib/`, harness artifacts,
installers, `.zzpi-generated-paths.json`, and `EXPORT_SOURCE.txt`. Do not edit
those files here; update their canonical source and rerun `export-zzpi.sh`.
`README.md`, `repoAssets/`, `.gitignore`, and `.git/` are intentionally
preserved as human-maintained destination content.

Key files:

- `install.sh` — public Pi plug installer.
- `pi-plugs/manifest.json` and `pi-plugs/pi-plugs.tar.gz` — generated plug distribution.
- `zz-lib/manifest.json` and `zz-lib/pi-plugs.tar.gz` — generated shared runtime.
- `pi-plugs/files/README.md` — detailed exported plug catalog.
- `EXPORT_SOURCE.txt` — exact source commit and export provenance.

## Screenshots

<details>
<summary>Show the Pi interface</summary>

![Full view](repoAssets/fullview.png)

![Extension selector](repoAssets/RecPluginSet.png)

![Git and context panes](repoAssets/tiles.png)

![Per-agent model setup](repoAssets/custommodels.png)

</details>

## More documentation

- [Minimum-complete-system manifesto](docs/minimum-complete-agentic-system.md)
- [Detailed Pi plug catalog](pi-plugs/files/README.md)
