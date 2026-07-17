# zzPi Pi plug catalog

The maintained source for this catalog and plug bundle is
[`zzHostWebsite/clients/pi-plugs`](https://github.com/dezverev/zzHostWebsite/tree/master/clients/pi-plugs).
The public exporter copies this catalog and publishes a sanitized build under
`zzPi/pi-plugs/files/`; this README intentionally appears in both locations.
Public copies are generated and should not be edited directly.

For the design rationale behind the agent set, see
[The Minimum Complete Agentic Coding System](../../docs/minimum-complete-agentic-system.md).

## Install and manage

From the root of the public zzPi checkout:

```bash
./install.sh --select
```

The installer resolves the selected dependency closure into the target
repository's `./.pi/extensions/` directory and installs the shared `zz-lib`
runtime when a selected plug requires it. Pi discovers those project-local
extensions when started from that repository.

Inside Pi, `/zz-plugs select` opens a scrollable in-Pi checklist and additionally
manages the Codex, Claude, and Copilot readsubagent integrations.

## Extensions

- **`zz-plug-manager`** (`extensions/zz-plug-manager.ts`) — internal bootstrap/manager extension. Adds `/zz-plugs list|status|select|install|remove|set|update`.
- **`right-overlay-tiler`** (`extensions/00-right-overlay-tiler.ts`) — coordinates right-side overlay panes. Use `/right-overlay focus` or `Alt+O` to focus them and `Esc` to return to chat.
- **`zz-subagent-runtime`** (`extensions/00-zz-subagent-runtime.ts`) — shared child-agent runtime. Installs model options and endpoint config, declares `zz-lib`, and adds `/zz-model-setup setup|status|set <endpoint> [model-id] [provider-id]`.
- **`zz-local-models`** (`extensions/zzLocalModels.ts`) — registers shared local/remote-local model definitions in Pi's normal model picker.
- **`context-tools`** (`extensions/context-tools.ts`) — shows context and tool-usage accounting in a right-side pane.
- **`git-status`** (`extensions/git-status.ts`) — shows a VS Code-style Git branch/change summary in the footer and details pane. Use `/git-status` to toggle it.
- **`pi-context`** (`extensions/pi-context.ts`) — replaces Pi's built-in project-context injection with discovered `PI.md` files. Use `/pi-context` to list what will be sent.
- **`debuggersubagent`** (`extensions/debuggersubagent.ts`) — adds `/debuggersubagent model|config|ask <problem>` and a diagnosis tool operating under a non-mutation contract.
- **`implementationsubagent`** (`extensions/implementationsubagent.ts`) — adds the main-agent-only implementation tool, `/implementationsubagent model|config|status`, and `/implementation-mode on|off|toggle|status`. It accepts one bounded piece, maintains a ledger, validates confidence evidence, and returns a fail-closed handoff.
- **`brainstormer`** (`extensions/brainstormer.ts`) — read-only-by-contract solution agent with `/brainstormer model|config|status|ask`; it returns materially different options and tradeoffs.
- **`designplanner`** (`extensions/designplanner.ts`) — read-only-by-contract design agent with `/designplanner model|config|status|ask`; it designs exactly one selected brainstorm solution.
- **`design-loop`** (`extensions/design-loop.ts`) — exposes callable `brainstormer` and `designplanner` tools plus `/design-loop on|off|toggle|status`. Parent policy requires explicit user selection before design planning, and successful designs are stored under `docs/artifacts/designs/`.
- **`readsubagent`** (`extensions/readsubagent.ts`) — adds `/readsubagent on|off|toggle|status|model [model|default]|config|ask <question>` and a targeted file-inspection tool. It returns cited factual maps and focused read plans.
- **`vettingagents`** (`extensions/vettingagents.ts`) — runs three separate read-only-by-contract review contexts using grounding, live-tree feasibility, and consistency/severity lenses. Each lens has a configurable deadline.
- **`promptenrichsubagent`** (`extensions/promptenrichsubagent.ts`) — provides optional, user-triggered enrichment through `/pe <prompt>`, `/pe-model [model|default]`, and `/pe-config`; the parent does not invoke it automatically.
- **`tetris`** (`extensions/tetris.ts`) — adds `/tetris`, a right-side overlay game for waiting during agent runs.

These are workflow/tool-policy contracts rather than an operating-system
sandbox. Parent review and deterministic validation remain required.

## Model selection and runtime

The shared child runtime caps each parent process at three concurrent child Pi
runs and attempts to close an idle parent Codex WebSocket before spawning them.
Override the cap with `PI_CHILD_AGENT_MAX_CONCURRENCY` when needed.

Each subagent exposes model choices from its adjacent JSONC config. Model
commands create workspace-persistent overrides under
`.pi/subagent-model-overrides/`; selections survive new sessions, process
restarts, and plug updates. Use the agent's `model default` or `model reset`
form to clear an override. Mode on/off toggles remain session-branch state.

## Configuration files

Extension tunables live beside the extensions and reload with `/reload`:

- `extensions/zz-plug-manager.config.jsonc` — distribution URLs and auto-reload behavior.
- `extensions/right-overlay-tiler.config.jsonc` — pane geometry, focus shortcut, and scroll timings.
- `extensions/context-tools.config.jsonc` — context-tree limits and token/image estimates.
- `extensions/git-status.config.jsonc` — Git polling, pane limits, and command timeout.
- `extensions/tetris.config.jsonc` — game overlay and auto-pause behavior.
- `extensions/pi-context.config.jsonc` — `PI.md` discovery and prompt insertion.
- `extensions/local-model-endpoints.config.jsonc` — shared local/remote-local endpoint selection written by `/zz-model-setup`.
- `extensions/zzLocalModels.config.jsonc` — shared model definitions exposed in Pi's model picker.
- `extensions/readsubagent.config.jsonc` — child model options, read-only tool allowlist, guard policy, timeouts, and report limits.
- `extensions/debuggersubagent.config.jsonc` — debugger model options and diagnosis tool policy.
- `extensions/implementationsubagent.config.jsonc` — implementation model options, nested read/debug access, and mutating tools. Non-configurable scope and confidence guards still apply.
- `extensions/brainstormer.config.jsonc` — brainstormer model options and read-only tool policy.
- `extensions/designplanner.config.jsonc` — design-planner model options and read-only tool policy.
- `extensions/vettingagents.config.jsonc` — vetting model options and review limits.
- `extensions/promptenrichsubagent.config.jsonc` — prompt-enrichment model options and limits.

## Bounded implementation protocol

The parent authors a context-rich Markdown implementation document under
`docs/artifacts/implementationdocs`, decomposes work, and delegates one
medium-to-small independently vettable outcome per call. Only one implementation child runs at a time per parent process. Separate Pi sessions or processes must not target the same implementation document or ledger concurrently. The child maintains a derived ledger, runs focused validation, and reports phased confidence evidence.

Below 80% self-reported confidence, the child protocol requires an early
non-completed handoff with partial state, reason, and clarification questions.
The extension validates status, confidence markers, ledger state, and document
integrity before computing `handoffAccepted`. The parent reviews every return,
resolves uncertainty, and retains sequencing, integration, vetting, final
verification, and Git ownership.

After changing an extension or config in a running Pi session, use `/reload`.
