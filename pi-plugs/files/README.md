# zzHostWebsite pi plug source

This directory is the tracked master source for the repo-local pi plug bundle served by `./deploy.sh`.

`deploy.sh` validates `pi-plugs.catalog.jsonc`, packages these files into `/srv/www/pi-plugs/`, and also publishes the shared runtime from `clients/zz-lib/` to `/srv/www/zz-lib/`. The public `install-pi-plugs.*` scripts install the selected dependency closure into a target repo's `./.pi/extensions/` directory and ensure `zz-lib` when selected plugs declare it. Pi then auto-discovers those project-local extensions when started from that target repo.

## Documentation

- [zz-lib docs](../../docs/zz-lib/README.md) — shared runtime model and authoring guide for common helpers.

## Extensions

- `extensions/zz-plug-manager.ts` — internal bootstrap/manager extension. Adds `/zz-plugs list|status|select|install|remove|set|update` so plug selection can happen from inside pi. `/zz-plugs select` opens a scrollable `[ ]` / `[x]` checklist in TUI mode and also exposes Codex/Claude/Copilot readsubagent harness integrations for install/remove from the same UI.
- `extensions/00-right-overlay-tiler.ts` — coordinates right-side overlay panes and keeps them out of the main chat tile. Use `/right-overlay focus` or `Alt+O` to focus the side panes; use `Esc` to return focus to chat.
- `extensions/00-zz-subagent-runtime.ts` — internal shared child-agent runtime plug. Installs pi-plugs child-agent model options plus endpoint config, declares the shared `zz-lib` runtime, and adds `/zz-model-setup setup|status|set <endpoint> [model-id] [provider-id]` so users can point local-model configs at their own LM Studio/OpenAI-compatible endpoint.
- `extensions/git-status.ts` — shows a VS Code-style Git branch/change summary in the pi footer and opens the right-side details pane by default when a Git repo is detected. Use `/git-status` to toggle it.
- `extensions/tetris.ts` — adds `/tetris`, a right-side overlay Tetris game. Arrow keys move/rotate/drop, `Space` hard-drops, `Enter` opens the pause menu, and `Esc` pauses/hides back to chat until `/tetris` is run again. Settings are documented in `extensions/tetris.config.jsonc`.
- `extensions/pi-context.ts` — strips Pi's built-in `AGENTS.md`/`CLAUDE.md` project context before model calls and injects only `PI.md` files discovered globally and from parent directories. Use `/pi-context` to list the files that will be sent.
- `extensions/brainstormer.ts` — standalone read-only solution agent with `/brainstormer model|config|status|ask`; it researches structured solution options and tradeoffs.
- `extensions/designplanner.ts` — standalone read-only technical design agent with `/designplanner model|config|status|ask`; it turns exactly one selected brainstorm solution into a staged design.
- `extensions/design-loop.ts` — adds callable `brainstormer` and `designplanner` tools plus `/design-loop`. It requires explicit selection of one brainstormed solution before design planning, composes only the promoted standalone agents, and persists successful designs as readable `docs/artifacts/designs/*.design.md` documents.
- `extensions/debuggersubagent.ts` — adds `/debuggersubagent model|config|ask <problem>` and a `debuggersubagent` tool for standalone read-only root-cause diagnosis. It defaults to GPT-5.6 Sol xhigh and can diagnose any supplied bug, regression, or suspicious runtime result.
- `extensions/implementationsubagent.ts` — adds the main-agent-only `implementationsubagent` tool, `/implementationsubagent model|config|status`, `/implementation-mode`, and `Ctrl+Alt+I`. It implements exactly one medium-to-small independently vettable piece from a main-agent-authored Markdown brief under `docs/artifacts/implementationdocs`, maintains a derived Markdown ledger, defaults to GPT-5.6 Sol max, and can delegate factual reading and debugging internally. It refuses feature-sized work with `needs-decomposition`; the main agent reviews and course-corrects after every return and owns any vetting.
- `extensions/vettingagents.ts` — runs three independent read-only review lenses. Each lens has a 30-minute default deadline so one stalled provider request returns a partial aggregate instead of holding the parent indefinitely; override with `PI_VETTING_LENS_TIMEOUT_MS`.
- `extensions/readsubagent.ts` — adds `/readsubagent on|off|toggle|status|model [model]|config|ask <question>` and a `readsubagent` tool for targeted file-inspection questions through a child Pi process when the main model needs an answer rather than direct file contents. Model choices come from `modelOptions` in `extensions/readsubagent.config.jsonc`.

The separate `explorationsubagent` product was retired on 2026-07-14. Existing `readsubagent` behavior and configuration are unchanged.

The explicit `workflowmode`, `workflow-tree`, and internal `wf-*` products were retired on 2026-07-16. Parent-directed standalone agents now compose planning, implementation, debugging, and review dynamically as needed.

## Extension config files

The shared child runtime caps each parent process at three concurrent child Pi runs and closes the idle parent Codex WebSocket before spawning them, reducing WebSocket connection-limit fallback to SSE. Override the cap with `PI_CHILD_AGENT_MAX_CONCURRENCY` when needed.

Extension tunables live beside the extensions as commented JSONC files and are reloaded with `/reload`:

- `extensions/zz-plug-manager.config.jsonc` — source URL and auto-reload setting for `/zz-plugs`.
- `extensions/right-overlay-tiler.config.jsonc` — shared right-pane geometry, focus shortcut, and scroll-repeat timings.
- `extensions/context-tools.config.jsonc` — context-tree pane limits, token/image estimates, and auto-show behavior.
- `extensions/git-status.config.jsonc` — Git polling interval, pane limits, and command timeout.
- `extensions/tetris.config.jsonc` — Tetris overlay behavior, including whether to auto-pause when a prompt finishes.
- `extensions/pi-context.config.jsonc` — PI.md discovery behavior and system-prompt insertion settings.
- `extensions/local-model-endpoints.config.jsonc` — shared true-local vs remote-local LM Studio endpoint selector for child Pi agents; `/zz-model-setup` writes this plus installed local model/subagent configs.
- `extensions/readsubagent.config.jsonc` — read-subagent child Pi model, `modelOptions` entries for `/readsubagent model` (model/endpoint/provider/providerRegistration/contextWindow/maxOutputTokens/reportMaxChars/thinking/tools), read-only tool allowlist, default/toggle-mode behavior, direct-read guard policy, timeouts, and report limits.
- `extensions/debuggersubagent.config.jsonc` — debugger child Pi model, `modelOptions` entries for `/debuggersubagent model`, and read/search/`bash` tool allowlist plus readsubagent; prompts restrict it to non-mutating diagnosis.
- `extensions/implementationsubagent.config.jsonc` — implementation child model options, GPT-5.6 Sol max default, mutating code/test tools, and nested readsubagent/debuggersubagent access. A non-configurable scope guard still limits every model option to one medium-to-small piece; vetting remains a main-agent responsibility.

## Implementation

The old standalone `implementation-loop`, `impplanner`, and `implementeragent` products remain retired. The distinct `implementationsubagent` replacement keeps decomposition and orchestration in the main agent, accepts one context-rich Markdown implementation document plus one medium-to-small independently vettable piece with required acceptance criteria and focused validation per call, and maintains a readable ledger under `docs/artifacts/implementationdocs/ledgers`. Only one implementation child runs at a time per parent process; separate Pi sessions must not target the same document or ledger concurrently. Each return is a main-thread feedback checkpoint before the next piece. The parent agent can dynamically compose `design-loop`, `brainstormer`, `designplanner`, `implementationsubagent`, `debuggersubagent`, and `vettingagents` as the task requires.

After editing extensions or config in a running pi session, use `/reload`.
