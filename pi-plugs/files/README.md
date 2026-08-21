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
- **`zz-codex-proxy`** (`extensions/zzCodexProxy.ts`) — registers `zz-codex-proxy/gpt-5.6-sol` in `/model` through the Pi-specific Codex proxy route. Set `ZZ_CODEX_PROXY_KEY` before starting Pi; configure the endpoint in `extensions/zzCodexProxy.config.jsonc`.
- **`context-tools`** (`extensions/context-tools.ts`) — shows context and tool-usage accounting in a right-side pane.
- **`git-status`** (`extensions/git-status.ts`) — shows a VS Code-style Git branch/change summary in the footer and details pane. Use `/git-status` to toggle it.
- **`pi-context`** (`extensions/pi-context.ts`) — replaces Pi's built-in project-context injection with discovered `PI.md` files. Use `/pi-context` to list what will be sent.
- **`debuggersubagent`** (`extensions/debuggersubagent.ts`) — adds `/debuggersubagent model|config|ask <problem>` and a diagnosis-only tool that can run ad hoc scripts and produce diagnostic artifacts without implementing fixes.
- **`implementationsubagent`** (`extensions/implementationsubagent.ts`) — adds the main-agent-only implementation tool, `/implementationsubagent model|config|status`, and `/implementation-mode on|off|toggle|status`. It accepts one bounded piece, maintains a ledger, validates confidence evidence, and returns a fail-closed handoff.
- **`readsubagent`** (`extensions/readsubagent.ts`) — adds `/readsubagent on|off|toggle|status|model [model|default]|config|ask <question>` and a non-debug codebase scouting tool. It returns cited maps and focused read plans for general informational work; debugging evidence stays with the main agent/debugger.
- **`vettingagents`** (`extensions/vettingagents.ts`) — runs three separate read-only-by-contract review contexts using grounding, live-tree feasibility, and consistency/severity lenses. Each lens has a configurable deadline.
- **`promptenrichsubagent`** (`extensions/promptenrichsubagent.ts`) — provides optional, user-triggered enrichment through `/pe <prompt>`, `/pe-model [model|default]`, and `/pe-config`; the parent does not invoke it automatically.
- **`tetris`** (`extensions/tetris.ts`) — adds `/tetris`, a right-side overlay game for waiting during agent runs.

These are workflow/tool-policy contracts rather than an operating-system
sandbox. Parent review and deterministic validation remain required.

## Project-local custom plugs

Every installation includes the complete customization guide at
[`.pi/docs/zzpi-customization.md`](docs/zzpi-customization.md). It covers custom
plugs, project model options, persistent agent model choices, ownership, reload,
and troubleshooting.

Trusted repositories can add child-agent tools and slash commands without
editing installer-owned extensions. Each immediate directory under the active
root `.zzpi/custom-plugs/` or disabled root `.zzpi/custom-plugs-disabled/` is
one candidate plug:

```text
.zzpi/
├── custom-plugs/                 # active; imported at startup
│   └── zz-plugs-verifier/
│       ├── zz-plug.json
│       └── index.ts
└── custom-plugs-disabled/        # inactive; inventoried but never imported
    └── another-sidecar/
        ├── zz-plug.json
        └── index.ts
```

Only the active root is imported and bound. The disabled root is read only for
manifest inventory, so inactive customer code is never executed.

`zz-plug.json` uses the version-1 manifest contract. It requires
`apiVersion: 1`, a unique lowercase/hyphenated `id`, and an `entry` path to a
contained `.ts`, `.mts`, `.js`, or `.mjs` file. Optional `title` and
`description` strings are for authors; unknown v1 fields are ignored. The entry
must default-export a synchronous or async function that receives the
constrained `CustomPlugRegistrarV1` facade. The facade supports only:

- `registerChildAgent(...)`, which registers an LLM-callable task tool and can
  generate one slash command;
- `registerCommand(...)`, whose bounded context can report text/progress and run
  a registered child agent.

It does not expose Pi renderers, lifecycle events, shortcuts, flags, raw
`ExtensionAPI`, or other custom UX APIs. For type checking from a copied plug,
use a type-only import such as:

```ts
import type { CustomPlugRegisterV1 } from "../../../.pi/extensions/lib/custom-plug-types.ts";

const register: CustomPlugRegisterV1 = (registrar) => {
  registrar.registerChildAgent({ /* complete v1 definition */ });
};
export default register;
```

Custom plug source may use relative imports and dependencies installed beside
the plug. Pi-only virtual aliases and imports from zz-plugs internals are not a
supported sidecar API. The initial host is the Node-distributed zz-pi runtime;
if its public `jiti` dependency is unavailable, startup reports that host error
instead of importing private Pi modules. Sidecars are trusted first-party code:
they execute with the user's normal process permissions and are **not** a
security sandbox. Review the complete plug and local dependencies before use.

The canonical verifier sample is
[`examples/custom-plugs/zz-plugs-verifier`](examples/custom-plugs/zz-plugs-verifier).
From the project root, copy it into the discovery directory:

```bash
mkdir -p .zzpi/custom-plugs
cp -R clients/pi-plugs/examples/custom-plugs/zz-plugs-verifier \
  .zzpi/custom-plugs/zz-plugs-verifier
```

Use `/zz-plugs select` to manage catalog plugs and project custom plugs in one
source-labeled checklist. Catalog rows use internal identity `catalog:<id>` and
custom rows use `custom:<directory>`, so matching displayed IDs remain
independent. In the non-TUI fallback, use the source-qualified references
`[catalog] <id>` and `[custom] <directory>`; install/remove/set aliases remain
catalog-only. Active custom directories begin
selected and disabled directories begin unselected. Invalid inactive rows stay
visible but cannot be activated until fixed. An unambiguous invalid active row
can still be deselected for quarantine. Duplicate custom manifest IDs or a
directory name present in both roots block ambiguous activation, and select-all
skips rows that cannot be activated.

Selection activates or deactivates a sidecar by renaming its whole directory
between the two sibling roots. The manager does not copy, delete, merge,
overwrite, or interpret customer source contents, so tracked, untracked,
ignored, hidden, and nested files move together. It completes preflight and
rechecks that each destination is absent immediately before rename. An observed
destination collision or an `EXDEV` cross-filesystem rename error fails without
a copy/delete fallback. Portable Node does not provide an atomic no-replace
directory rename: concurrent filesystem edits or moves during selection are
unsupported, and an uncooperative process can still create an empty destination
inside the POSIX check/rename window. This is not strict exclusion against
external filesystem races.

Completed custom moves are journaled. A later move or catalog exception prompts
reverse-order compensating renames, but compensation can also fail and does not
make the combined operation globally atomic. Catalog installation is separately
nontransactional and may have partially changed catalog files before throwing,
even when custom moves are compensated.

By default, a successful apply requests reload only after both custom and
catalog work succeed. Use `/zz-plugs select --dry-run` to report both plans
without changing roots or catalog state, and `--no-reload` to keep successful
changes without requesting reload. With no reload, auto-reload disabled, or a
reload failure, filesystem and catalog changes remain applied while the current
process may retain stale sidecar bindings until a later manual `/reload`; Pi has
no unregister API. A failed preflight, rename, compensation, or catalog apply
does not request reload.

Moving a tracked sidecar changes its Git path and may appear as a rename or as
delete/add changes. Review and commit the resulting active/disabled path change
as ordinary project source. These sidecars remain trusted first-party code in
both roots; disabling prevents startup import but is not a security boundary.

Start Pi after the normal project-trust decision, or use `/reload` after adding,
removing, or changing a sidecar. There is no sidecar watcher. Ask Pi to use the
`zz-plugs-verifier` tool with an optional verification scope, or invoke the
generated command directly:

```text
/zz-plugs-verify
/zz-plugs-verify custom-plug startup and adapter tests
```

The sample uses `openai-codex` / `gpt-5.6-sol` with medium reasoning and only
read/search tools plus `bash` for validation. Runtime enforcement treats a child
as successful only when its status is `completed` and none of its recorded tool
calls has `isError: true`; tools, generated commands, and standalone orchestration
reject failed statuses or any failed tool call. The prompt/report policy separately
requires commands executed, overall PASS/FAIL, failures, and recommended follow-up,
and instructs the model not to claim PASS after a command fails. Textual report
consistency is prompt policy rather than additional runtime parsing.

Manifest, import, registration, namespace-collision, reserved `zz-plugs` command,
and binding failures are isolated per plug and summarized by the manager as standard startup warning
diagnostics. A missing `.zzpi/custom-plugs` directory is a silent no-op. Fix the
named manifest/entry and run `/reload`; no partial registration is committed
when collection fails, while a host binding error may warn that Pi has no
unregister API for definitions already bound from that plug.

## Model selection and runtime

The `zz-codex-proxy` provider uses Pi's generic `openai-responses` adapter
against `/codex/pi/v1/responses`. The proxy converts that request into Pi's
native Codex wire shape while leaving the Copilot endpoint and normalizer
unchanged. All usage is ingested as `provider = "openai-codex"` for the existing
Codex telemetry views. The proxy currently enforces medium reasoning, so every
Pi thinking-level selection maps to medium for this provider. The packaged
`gpt-5.6-sol-medium-zz-codex-proxy` child-model option makes this provider
selectable from every zz subagent model command alongside the direct
`openai-codex` option. Child processes inherit `ZZ_CODEX_PROXY_KEY`; the
`zz-codex-proxy` plug must remain enabled.

The shared child runtime caps each parent process at three concurrent child Pi
runs and attempts to close an idle parent Codex WebSocket before spawning them.
Override the cap with `PI_CHILD_AGENT_MAX_CONCURRENCY` when needed.

Every subagent reads the same ordered model choices from
`extensions/zz-agent-models.config.jsonc`. Adjacent agent JSONC configs retain
only agent-specific operational policy and fallback default fields; their legacy
`modelOptions` blocks have been removed and are not runtime selection sources.
The central catalog, all five adjacent agent configs, and the two local-model
setup configs are authoritative bundled files: plug updates replace local edits
to model settings, endpoints, and operational defaults rather than preserving
or merging them. `/zz-model-setup` changes remain active until the next plug
update reapplies bundled defaults. The shared Qwen child option self-registers
through the dedicated `zz-agent-local` provider; setup rejects IDs reserved by
remote providers such as `openai-codex`, `zz-codex-proxy`, and `fireworks`.

A repository may add options for all of its subagents without modifying
installer-owned files by committing `.zzpi/zz-agent-models.jsonc`. Its
`version: 1` / `modelOptions` entries are validated and appended after the
packaged choices. Project IDs must not collide with packaged IDs; an invalid
project catalog warns and is ignored while packaged choices remain available.
Self-registering project options must use a unique, non-reserved provider and
an explicit endpoint. For example:

```jsonc
{
  "version": 1,
  "modelOptions": {
    "gpt-5.6-sol-low": {
      "label": "GPT-5.6 Sol, low thinking",
      "provider": "openai-codex",
      "providerRegistration": "none",
      "model": "gpt-5.6-sol",
      "contextWindow": 272000,
      "maxOutputTokens": 128000,
      "thinking": "low"
    }
  }
}
```

Model commands persist active choices in the project-root
`.zzpi/zz-agent-active-models.json`, creating it on the first explicit model
selection or reset. The file may be committed when a repository wants common
choices:

```json
{
  "version": 1,
  "models": {
    "readsubagent": "qwen-35b-a3b",
    "vettingagents": "gpt-5.6-sol-medium"
  }
}
```

Model values are option IDs from the merged packaged and project catalogs. Entries for agents
that are not installed are ignored and preserved. Resolution checks a requested
agent's shared entry first, then the legacy
`.pi/subagent-model-overrides/<agent>.json` location, a valid restored session
choice for backward compatibility, and finally the agent config default. Use the
agent's `model default` or `model reset` form to store an explicit `null` reset
that masks legacy and session choices. Selections survive new sessions, process
restarts, and plug updates. Mode on/off toggles remain session-branch state.

## Configuration files

Extension tunables live beside the extensions and reload with `/reload`:

- `extensions/zz-plug-manager.config.jsonc` — distribution URLs and auto-reload behavior.
- `extensions/right-overlay-tiler.config.jsonc` — pane geometry, focus shortcut, and scroll timings.
- `extensions/context-tools.config.jsonc` — context-tree limits and token/image estimates.
- `extensions/git-status.config.jsonc` — Git polling, pane limits, and command timeout.
- `extensions/tetris.config.jsonc` — game overlay and auto-pause behavior.
- `extensions/pi-context.config.jsonc` — `PI.md` discovery and prompt insertion.
- `extensions/local-model-endpoints.config.jsonc` — authoritative shared local/remote-local endpoint selection written by `/zz-model-setup` and reset on plug update.
- `extensions/zzLocalModels.config.jsonc` — authoritative shared model definitions exposed in Pi's model picker and reset on plug update.
- `extensions/zz-agent-models.config.jsonc` — authoritative shared `modelOptions` list for every child agent.
- `extensions/readsubagent.config.jsonc` — read-only tool policy, guard policy, fallback default, timeouts, and report limits.
- `extensions/debuggersubagent.config.jsonc` — debugger operational/default and diagnosis tool policy.
- `extensions/implementationsubagent.config.jsonc` — implementation operational/default policy, nested non-debug read access, and mutating tools. Debugging is handed back to the main agent. Non-configurable scope, confidence, and escalation guards still apply.
- `extensions/vettingagents.config.jsonc` — vetting operational/default policy and review limits.
- `extensions/promptenrichsubagent.config.jsonc` — prompt-enrichment operational/default policy and limits.

## Manual design and implementation workflow

Modern models can brainstorm, clarify, and design directly in the parent
conversation when asked, so the former `brainstormer`, `designplanner`, and
`design-loop` Pi plugs—and their native planning-agent counterparts—were retired
rather than imposing a second orchestration layer. Bring your own direction when
you have it; when you do not, ask the parent to explore materially different
options and select the direction together.

Record consequential decisions in a manually authored Markdown handoff or
design document, and resolve behavior-affecting ambiguity before coding. Before
delegating implementation, the parent turns that approved direction into a
context-rich Markdown implementation document under
`docs/artifacts/implementationdocs`, with context, invariants, touchpoints,
stages, acceptance criteria, risks, and focused validation. Together with the
tool's bounded-task schema, this workflow-policy document is the durable contract between flexible
manual design and bounded execution; it is not generated or orchestrated by a
standalone Pi design plug.

## Bounded implementation protocol

The parent decomposes the implementation document and delegates one
medium-to-small independently vettable outcome per call. Only one implementation child runs at a time per parent process. Separate Pi sessions or processes must not target the same implementation document or ledger concurrently. The child maintains a derived ledger, runs focused validation, and reports phased confidence evidence. Confidence uses evidence anchors rather than an uncalibrated intuition: 95–100 requires comprehensive direct verification, 90–94 strong executable evidence with only minor gaps, and 80–89 passing criteria/checks with only non-critical gaps. Initially, the child scores requirement/design clarity, bounded feasibility, and whether a credible validation path exists—criteria scheduled after coding are not yet failures. Known validation impossibility, behavior-affecting ambiguity, unexplained failures, or no credible completion path cap confidence below 80 immediately; at final return, unverified criteria or incomplete work also cap it below 80, and static-only evidence where execution was expected caps it at 85.

Below 80% self-reported confidence, the child protocol requires an early
non-completed handoff with partial state, reason, and clarification questions.
The extension validates status, confidence markers, ledger state, and document
integrity before computing `handoffAccepted`. Malformed handoffs expose stable
format/semantic diagnostic codes without weakening any acceptance gate. A
successful child reports required but unapproved out-of-scope actions under
`## Escalations`; informational escalations do not penalize confidence, while
outstanding required work still requires a non-completed status. The parent reviews every return,
resolves uncertainty, and retains sequencing, integration, vetting, final
verification, and Git ownership.

After changing an extension or config in a running Pi session, use `/reload`.
