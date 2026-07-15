# zzHostWebsite pi plug source

This directory is the tracked master source for the repo-local pi plug bundle served by `./deploy.sh`.

`deploy.sh` validates `pi-plugs.catalog.jsonc`, packages these files into `/srv/www/pi-plugs/`, and also publishes the shared runtime from `clients/zz-lib/` to `/srv/www/zz-lib/`. The public `install-pi-plugs.*` scripts install the selected dependency closure into a target repo's `./.pi/extensions/` directory and ensure `zz-lib` when selected plugs declare it. Pi then auto-discovers those project-local extensions when started from that target repo.

## Documentation

- [Workflow mode](./WORKFLOWMODE.md) — workflow-mode architecture, stage contracts, commands, configs, and extension guide.
- [zz-lib docs](../../docs/zz-lib/README.md) — shared runtime model and authoring guide for common helpers.

## Extensions

- `extensions/zz-plug-manager.ts` — internal bootstrap/manager extension. Adds `/zz-plugs list|status|select|install|remove|set|update` so plug selection can happen from inside pi. `/zz-plugs select` opens a scrollable `[ ]` / `[x]` checklist in TUI mode and also exposes Codex/Claude/Copilot readsubagent harness integrations for install/remove from the same UI.
- `extensions/00-right-overlay-tiler.ts` — coordinates right-side overlay panes and keeps them out of the main chat tile. Use `/right-overlay focus` or `Alt+O` to focus the side panes; use `Esc` to return focus to chat.
- `extensions/00-zz-subagent-runtime.ts` — internal shared child-agent runtime plug. Installs pi-plugs child-agent model options plus endpoint config, declares the shared `zz-lib` runtime, and adds `/zz-model-setup setup|status|set <endpoint> [model-id] [provider-id]` so users can point local-model configs at their own LM Studio/OpenAI-compatible endpoint.
- `extensions/git-status.ts` — shows a VS Code-style Git branch/change summary in the pi footer and opens the right-side details pane by default when a Git repo is detected. Use `/git-status` to toggle it.
- `extensions/tetris.ts` — adds `/tetris`, a right-side overlay Tetris game. Arrow keys move/rotate/drop, `Space` hard-drops, `Enter` opens the pause menu, and `Esc` pauses/hides back to chat until `/tetris` is run again. Settings are documented in `extensions/tetris.config.jsonc`.
- `extensions/pi-context.ts` — strips Pi's built-in `AGENTS.md`/`CLAUDE.md` project context before model calls and injects only `PI.md` files discovered globally and from parent directories. Use `/pi-context` to list the files that will be sent.
- `extensions/wf-clarifier.ts` — adds `/wf-clarifier model|config|ask <prompt>`, the first workflow-mode subagent. It uses `readsubagent` to return enriched prompt options or clarification questions.
- `extensions/wf-brainstormer.ts` — adds `/wf-brainstormer model|config|ask <prompt>`, the second workflow-mode subagent. It uses `readsubagent` to research solution options, tradeoffs, risks, and repo touchpoints from the clarified prompt.
- `extensions/wf-adversarialreview.ts` — adds `/wf-adversarialreview model|config|ask <stage-output>`, a stage-aware workflow review gate. It adversarially checks selected `wf-*` stage outputs before final user-facing workflow output is shown.
- `extensions/wf-designplan.ts` — adds `/wf-designplan model|config|ask <prompt>`, a workflow-mode design planning subagent. It turns the selected brainstorm option into a reviewed staged development design plan.
- `extensions/wf-impplanner.ts` — adds `/wf-impplanner model|config|ask <prompt>`, a workflow-mode implementation planning subagent. It turns the reviewed design plan into reviewed per-step execution plans and one reviewed concrete implementation plan.
- `extensions/wf-implementeragent.ts` — adds `/wf-implementeragent model|config|ask <manual implementation task>`, a workflow-mode implementation worker. It executes one reviewed `wf-impplanner` stage at a time.
- `extensions/wf-revieweragent.ts` — adds `/wf-revieweragent model|config|ask <manual review task>`, a workflow-mode implementation review gate. It green-lights each implemented stage before workflow mode advances.
- `extensions/wf-finalreviewagent.ts` — adds `/wf-finalreviewagent model|config|ask <manual branch review task>`, a whole-branch final review gate. It dispatches remediation steps back through implementer/reviewer loops until final review is green.
- `extensions/wf-testeragent.ts` — adds `/wf-testeragent model|config|ask <manual testing task>`, a testing gap filler. It runs before whole-branch final review to add reasonable focused tests, then sends those changes through review.
- `extensions/brainstormer.ts` — standalone read-only solution agent with `/brainstormer model|config|status|ask`; it researches structured solution options and tradeoffs without importing `wf-brainstormer`.
- `extensions/designplanner.ts` — standalone read-only technical design agent with `/designplanner model|config|status|ask`; it turns exactly one selected brainstorm solution into a staged design without importing `wf-designplan`.
- `extensions/design-loop.ts` — adds callable `brainstormer` and `designplanner` tools plus `/design-loop`. It requires explicit selection of one brainstormed solution before design planning, composes only the promoted standalone agents, and persists successful designs as readable `docs/artifacts/designs/*.design.md` documents.
- `extensions/workflowmode.ts` — adds `/workflowmode [on|off|toggle|status|reset|resume|continue|model <model>]` and input-focused `Alt+W` to clarify, enrich, brainstorm, select, design-plan, implementation-plan, implement each plan stage, loop implementation review, fill test gaps, then run whole-branch final review until everything is green-lit. Use `/workflowmode model <model>` to set every `wf-*` child-agent model at once.
- `extensions/debuggersubagent.ts` — adds `/debuggersubagent model|config|ask <problem>` and a `debuggersubagent` tool for standalone read-only root-cause diagnosis. It defaults to GPT-5.6 Sol xhigh and can diagnose any supplied bug, regression, or suspicious runtime result.
- `extensions/vettingagents.ts` — runs three independent read-only review lenses. Each lens has a six-minute default deadline so one stalled provider request returns a partial aggregate instead of holding the parent indefinitely; override with `PI_VETTING_LENS_TIMEOUT_MS`.
- `extensions/readsubagent.ts` — adds `/readsubagent on|off|toggle|status|model [model]|config|ask <question>` and a `readsubagent` tool for targeted file-inspection questions through a child Pi process when the main model needs an answer rather than direct file contents. Model choices come from `modelOptions` in `extensions/readsubagent.config.jsonc`.

The separate `explorationsubagent` product was retired on 2026-07-14. Existing `readsubagent` behavior and configuration are unchanged.

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
- `extensions/wf-clarifier.config.jsonc` — workflow clarifier child Pi model, `modelOptions` entries for `/wf-clarifier model`, and the `readsubagent` tool allowlist used during prompt enrichment.
- `extensions/wf-brainstormer.config.jsonc` — workflow brainstormer child Pi model, `modelOptions` entries for `/wf-brainstormer model`, and the `readsubagent` tool allowlist used during solution brainstorming.
- `extensions/wf-adversarialreview.config.jsonc` — workflow adversarial-review child Pi model, `modelOptions` entries for `/wf-adversarialreview model`, and the `readsubagent` tool allowlist used during stage-output review.
- `extensions/wf-designplan.config.jsonc` — workflow design-plan child Pi model, `modelOptions` entries for `/wf-designplan model`, and the `readsubagent` tool allowlist used during design planning.
- `extensions/wf-impplanner.config.jsonc` — workflow implementation-planner child Pi model, `modelOptions` entries for `/wf-impplanner model`, and the `readsubagent` tool allowlist used during implementation planning.
- `extensions/wf-implementeragent.config.jsonc` — workflow implementer-agent child Pi model, `modelOptions` entries for `/wf-implementeragent model`, mutating implementation tool allowlist plus readsubagent, timeouts, and report limits.
- `extensions/wf-revieweragent.config.jsonc` — workflow reviewer-agent child Pi model, `modelOptions` entries for `/wf-revieweragent model`, read/search/bash review tool allowlist plus readsubagent, timeouts, and report limits.
- `extensions/wf-finalreviewagent.config.jsonc` — workflow final-review-agent child Pi model, `modelOptions` entries for `/wf-finalreviewagent model`, read/search/bash review tool allowlist plus readsubagent, timeouts, and report limits.
- `extensions/wf-testeragent.config.jsonc` — workflow tester-agent child Pi model, `modelOptions` entries for `/wf-testeragent model`, mutating testing tool allowlist plus readsubagent, timeouts, and report limits.
- `extensions/debuggersubagent.config.jsonc` — debugger child Pi model, `modelOptions` entries for `/debuggersubagent model`, and read/search/`bash` tool allowlist plus readsubagent; prompts restrict it to non-mutating diagnosis.

## Implementation

The standalone `implementation-loop`, `impplanner`, and `implementeragent` products were retired on 2026-07-13. Continue accepted designs through normal parent-agent implementation, or use `workflowmode` when the full internal `wf-*` workflow is desired. The standalone design stack remains available through `design-loop`, `brainstormer`, and `designplanner`.

After editing extensions or config in a running pi session, use `/reload`.
