# Customize zz-pi with `.zzpi`

> This file is installed and updated by zz-plugs at `.pi/docs/zzpi-customization.md`.
> Do not edit the installed copy. Put project-owned customization under `.zzpi/`.

`.zzpi` is the repository-owned customization area for zz-pi. Commit its files when the customization should be shared by everyone working in the repository, or keep them untracked when they are local experiments.

Currently supported customization surfaces are:

```text
.zzpi/
├── custom-plugs/                 # enabled project child-agent/command extensions
├── custom-plugs-disabled/        # preserved but inactive extensions
├── zz-agent-models.jsonc         # additional project model choices
└── zz-agent-active-models.json   # current per-agent model selections
```

Files or directories not described in this guide are not a supported zz-pi API.

## Project custom plugs

Custom plugs are trusted TypeScript or JavaScript modules for project-specific child agents, tools, and slash commands. They use the existing zz-plugs child-agent runtime; they are not a second agent system.

Only immediate directories under `.zzpi/custom-plugs/` are imported. Directories under `.zzpi/custom-plugs-disabled/` are inventoried for `/zz-plugs select` but their code is never imported.

### Minimal layout

```text
.zzpi/custom-plugs/my-verifier/
├── zz-plug.json
└── index.ts
```

`zz-plug.json` uses the v1 manifest:

```json
{
  "apiVersion": 1,
  "id": "my-verifier",
  "entry": "index.ts",
  "title": "project verifier",
  "description": "Runs project-specific verification"
}
```

Rules:

- `apiVersion` must be `1`.
- `id` uses lowercase letters, digits, and single hyphens.
- `entry` is a relative, contained `.ts`, `.mts`, `.js`, or `.mjs` file.
- Duplicate IDs and duplicate directory names across active and disabled roots block activation.
- Unknown v1 manifest fields are ignored.

### Minimal child agent

A plug default-exports a synchronous or asynchronous registrar function. Use a type-only import from the installed runtime:

```ts
import type { CustomPlugRegisterV1 } from "../../../.pi/extensions/lib/custom-plug-types.ts";

const register: CustomPlugRegisterV1 = (registrar) => {
  registrar.registerChildAgent({
    id: "my-verifier",
    description: "Run project verification and report the result",
    config: {
      provider: "openai-codex",
      providerRegistration: "none",
      model: "gpt-5.6-sol",
      endpoint: "http://127.0.0.1:1234",
      contextWindow: 272000,
      maxOutputTokens: 128000,
      reportMaxChars: 32000,
      requestTimeoutMs: 1800000,
      thinking: "medium",
      tools: ["read", "bash", "grep", "find", "ls"],
      systemPrompt: "Run the requested verification. Do not edit files. Report commands, failures, and follow-up."
    },
    excludeTools: ["edit", "write"],
    buildPrompt: ({ cwd, task }) => `Working directory: ${cwd}\nTask: ${task}`,
    command: {
      name: "my-verify",
      description: "Run project verification",
      usage: "/my-verify [scope]"
    }
  });
};

export default register;
```

The v1 registrar exposes only:

- `registerChildAgent(definition)` — creates an LLM-callable task tool and, optionally, a slash command.
- `registerCommand(definition)` — creates a slash command whose bounded context can report text/progress and call a registered child agent.

It does not expose Pi renderers, lifecycle events, keyboard shortcuts, flags, raw `ExtensionAPI`, or custom TUI APIs.

Custom plug child-agent configs require positive integer context/token/report/timeout limits, a system prompt, provider/model/endpoint fields, a supported thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`), and a tool list. `providerRegistration` is either `none` for an existing provider or `openai-compatible` for a provider the child runtime should register.

### Enable and disable plugs

Run:

```text
/zz-plugs select
```

The checklist labels managed packages as `[catalog]` and project extensions as `[custom]`.

- Selected custom rows live in `.zzpi/custom-plugs/`.
- Unselected custom rows live in `.zzpi/custom-plugs-disabled/`.
- Non-TUI selection accepts `custom:<directory>` or `[custom] <directory>` references.
- `/zz-plugs install`, `remove`, and `set` remain catalog-only.
- `select --dry-run` reports moves without changing files.
- `select --no-reload` applies changes but leaves the current process stale until `/reload`.

Activation moves the whole directory by rename. Nested, hidden, tracked, untracked, and ignored files move together. zz-plugs never intentionally copies, merges, deletes, or overwrites custom source. Observed destination collisions and cross-device (`EXDEV`) moves fail safely. Completed moves are journaled and compensated in reverse order if a later move or catalog operation fails.

Portable Node does not provide an atomic no-replace directory rename. Do not concurrently edit or move these directories while applying selection; an external process can race the final destination check. Catalog installation is also nontransactional, so a failed combined operation can leave partial catalog changes even when custom moves are restored.

Changing roots changes Git paths and may appear as a rename or delete/add. Reload is requested only after custom and catalog work succeeds. If reload is disabled or fails, old in-process commands/tools can remain until manual `/reload` because Pi has no unregister API.

Custom plugs execute with your normal user permissions. The registrar is a compatibility boundary, not a security sandbox. Review all plug source and local dependencies before enabling it.

## Add project model choices

Use `.zzpi/zz-agent-models.jsonc` to append model choices without editing installer-owned files:

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
    },
    "project-local-model": {
      "label": "Project local model",
      "provider": "project-local-provider",
      "providerRegistration": "openai-compatible",
      "endpoint": "http://127.0.0.1:1234/v1",
      "model": "project-model-id",
      "contextWindow": 65536,
      "maxOutputTokens": 8192,
      "thinking": "medium"
    }
  }
}
```

Rules:

- `version` must be `1` and `modelOptions` must be nonempty.
- Option IDs must not collide with packaged model option IDs.
- `model`, `provider`, `providerRegistration`, and `thinking` are required.
- `contextWindow` and `maxOutputTokens` are positive integers.
- `providerRegistration: "openai-compatible"` requires an explicit endpoint and a unique, non-reserved provider ID.
- Reserved provider IDs include `anthropic`, `fireworks`, `google`, `openai`, `openai-codex`, `zz-agent-local`, and `zz-codex-proxy`.
- `providerRegistration: "none"` selects a provider already available to Pi.

An invalid project catalog is warned about and ignored; packaged model choices remain available.

## Select active models per agent

Agent model commands persist their choices in `.zzpi/zz-agent-active-models.json`:

```json
{
  "version": 1,
  "models": {
    "readsubagent": "project-local-model",
    "vettingagents": "gpt-5.6-sol-medium",
    "debuggersubagent": null
  }
}
```

Values are model option IDs from the packaged or project model catalog. The packaged `gpt-5.6-sol-medium-zz-codex-proxy` option routes through the enabled `zz-codex-proxy` provider and inherits `ZZ_CODEX_PROXY_KEY` in child processes. `null` explicitly resets that agent to its default. Prefer each agent's `model` command instead of hand-editing this file; commands preserve unrelated agent entries and write the file atomically.

Resolution order is the shared `.zzpi` preference, a supported legacy override, a valid restored session choice, then the agent's configured default.

## Installer-owned `.pi` configuration

Do not put project customization into installer-owned source files under `.pi/extensions`.

- Files listed as plug `configFiles` are copied when missing and receive missing default keys on update while existing values win. `--reset-config` replaces them with bundled defaults.
- TypeScript runtime files and other authoritative bundled files are replaced on update.
- Shared model and endpoint files such as `.pi/extensions/zz-agent-models.config.jsonc`, `local-model-endpoints.config.jsonc`, and `zzLocalModels.config.jsonc` are authoritative and can be reset by plug updates.
- Use `.zzpi/zz-agent-models.jsonc` and agent model commands for durable project model customization.

This guide itself is an installer-owned common file. Updates replace `.pi/docs/zzpi-customization.md`; edits to `.zzpi` are not part of guide ownership.

## Troubleshooting

- **A custom plug is absent from the checklist:** confirm it is an immediate directory in one of the two custom roots and has `zz-plug.json`.
- **A plug cannot be activated:** fix manifest/path diagnostics, duplicate IDs/directories, or a destination collision, then rerun selection.
- **A newly enabled plug is not available:** run `/reload`; if the bundle was just upgraded, run `/zz-plugs update --force` first.
- **A project model choice is missing:** inspect startup warnings for schema, ID collision, provider, endpoint, or numeric-limit errors.
- **An update replaced model endpoint settings:** those bundled files are authoritative; move durable choices into the supported `.zzpi` files above.
