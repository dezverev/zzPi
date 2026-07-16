# Workflow mode

Workflow mode is a Pi extension workflow for turning an initial user ask into a clarified, researched, reviewed design plan and reviewed concrete implementation plan before implementation begins.

It lives entirely in the pi-plugs extension bundle under `clients/pi-plugs/extensions/`; it is not a Pi core feature. Selecting/installing the `workflowmode` plug pulls in its `wf-*` dependencies automatically through `pi-plugs.catalog.jsonc`.

## User-facing controls

- `/workflowmode` — toggles workflow mode on/off.
- `/workflowmode on` — turns workflow mode on and resets workflow state.
- `/workflowmode off` — turns workflow mode off and clears workflow state.
- `/workflowmode reset` — keeps workflow mode on/off as-is but clears pending workflow state.
- `/workflowmode status` — shows current workflow state.
- `/workflowmode model <model>` — selects the same configured child model for every `wf-*` stage agent. Current shared model ids are `gpt-5.6-sol-xhigh`, `gpt-5.6-sol-max`, `gpt-5.5-xhigh`, `qwen-35b-a3b`, and `glm-5p2-xhigh`.
- `Alt+W` — input-focused shortcut that toggles workflow mode.

After workflow mode is on, the next normal user prompt is intercepted by the workflow pipeline. Once the current workflow reaches a terminal state, later prompts pass through normally until workflow mode is reset or toggled again.

## Current pipeline

```text
user prompt
  ↓
wf-clarifier
  ↓ clarification questions? ── yes → wait for user answer → wf-clarifier again
  ↓ no
choose enriched prompt if needed
  ↓
wf-brainstormer
  ↓ brainstorming questions? ─ yes → wait for user answer → wf-brainstormer again
  ↓ no
wf-adversarialreview reviews brainstorm output
  ↓
choose brainstorm option
  ↓
wf-designplan
  ↓ design-plan questions? ─ yes → wait for user answer → wf-designplan again
  ↓ no
wf-adversarialreview reviews design-plan output
  ↓
wf-impplanner creates per-step implementation plans, reviews each step, merges them, and reviews the final plan
  ↓
wf-implementeragent implements one plan stage
  ↓
wf-revieweragent reviews the code
  ↓ not green → send reviewer feedback back to wf-implementeragent for the same stage
  ↓ green
next plan stage, until all stages are implemented and reviewed
  ↓
wf-testeragent analyzes reasonable test gaps and fills them
  ↓
wf-revieweragent reviews testing changes
  ↓ not green → send feedback back to wf-testeragent
  ↓ green/no gaps
wf-finalreviewagent reviews the whole branch
  ↓ not green → dispatch final remediation through wf-implementeragent → wf-revieweragent, then final review again
  ↓ green
workflow complete
```

### Stage responsibilities

| Stage | Extension | Responsibility |
| --- | --- | --- |
| Orchestrator | `workflowmode.ts` | Toggle mode, intercept prompts, track pending stage answers, select options, run stage review gates, and coordinate implementation/review loops. |
| Clarifier | `wf-clarifier.ts` | Clarify the initial ask and produce one or more enriched prompts, or ask clarification questions. |
| Brainstormer | `wf-brainstormer.ts` | Research solution options/tradeoffs from the clarified prompt. |
| Adversarial reviewer | `wf-adversarialreview.ts` | Stage-aware review gate for selected workflow outputs before final user-facing stage output. |
| Design planner | `wf-designplan.ts` | Turn the selected brainstorm option into ordered, manageable design/development stages. |
| Implementation planner | `wf-impplanner.ts` | Turn the reviewed design plan into reviewed per-step execution plans and one reviewed concrete implementation plan. |
| Implementer agent | `wf-implementeragent.ts` | Implement exactly one reviewed implementation-plan stage, applying reviewer feedback when supplied. |
| Reviewer agent | `wf-revieweragent.ts` | Review the implemented stage and return a green signal before workflow mode advances. |
| Tester agent | `wf-testeragent.ts` | Analyze branch changes for reasonable test gaps, fill them, and pass testing changes through review before final review. |
| Final review agent | `wf-finalreviewagent.ts` | Review the whole branch after all stages pass and dispatch final remediation loops until green. |
| Factual subagent | `readsubagent.ts` | Provides factual repo inspection only. It must not produce implementation plans, solution proposals, recommendations, or edit strategies. |

## Role boundaries

Workflow mode deliberately separates responsibilities:

- `readsubagent` answers targeted file/config/source questions with concise evidence and citations.
- `wf-clarifier` uses factual subagent output to enrich the user's ask, not to plan implementation.
- `wf-brainstormer` owns solution-option synthesis.
- `wf-designplan` owns breaking the chosen idea/solution into ordered, manageable design/development stages.
- `wf-impplanner` owns detailed execution planning for those stages, including TDD guidance, high-priority tests, checkpoints, and code/pseudocode examples when useful.
- `wf-implementeragent` owns code changes for one implementation-plan stage at a time and must not advance to later stages.
- `wf-revieweragent` owns post-implementation/testing review and is the only agent that can green-light advancement to the next implementation stage, testing pass, or final-review remediation retry.
- `wf-testeragent` owns the pre-final-review testing gap pass and should add focused, maintainable tests only when gaps are reasonable.
- `wf-finalreviewagent` owns whole-branch review after all per-stage reviews and testing pass, and can dispatch final remediation steps back through implementer/reviewer loops until it returns green.
- `wf-adversarialreview` owns critique/correction of selected planning-stage outputs.

When adding or changing workflow agents, preserve this boundary. In particular, do not ask `readsubagent` for plans, recommendations, or edit strategies.

## Stage output contracts

Workflow agents return JSON only. The orchestrator parses that JSON and decides the next state.

### `wf-clarifier`

Returns either:

```json
{
  "kind": "prompts",
  "summary": "why this is clear enough",
  "prompts": [
    {
      "title": "Option title",
      "rationale": "why this option",
      "prompt": "enriched prompt text"
    }
  ]
}
```

or:

```json
{
  "kind": "questions",
  "summary": "why clarification is needed",
  "questions": ["question 1"]
}
```

If there is one prompt, workflow mode accepts it automatically. If there are multiple prompts, workflow mode asks the user to choose when interactive UI is available; without UI it falls back to the first option.

### `wf-brainstormer`

Returns either:

```json
{
  "kind": "brainstorm",
  "summary": "short synthesis",
  "recommendedOption": "Option title, when there is a clear superior option",
  "options": [
    {
      "title": "Option title",
      "approach": "strategy-level description",
      "repoTouchpoints": ["repo path/symbol/context"],
      "pros": ["benefit"],
      "cons": ["tradeoff"],
      "risks": ["risk"],
      "unknowns": ["open unknown"],
      "nextSteps": ["high-level next workflow step"]
    }
  ],
  "questions": ["optional question to carry forward"]
}
```

or:

```json
{
  "kind": "questions",
  "summary": "why brainstorming is blocked",
  "questions": ["question 1"]
}
```

Question outputs are shown directly and workflow mode waits for the user's next answer. Final brainstorm outputs are adversarially reviewed before they are used for option selection.

### Brainstorm option selection

After reviewed brainstorming:

1. If there is exactly one option, workflow mode auto-selects it.
2. If `recommendedOption` unambiguously matches an option title, workflow mode auto-selects that option.
3. Otherwise, interactive UI prompts the user to choose an option.
4. Without interactive UI and without an unambiguous recommendation, workflow mode falls back to option 1 with a warning.

### `wf-designplan`

Receives the clarified prompt, reviewed brainstorm decision, selected brainstorm option, and any follow-up answers. Returns either:

```json
{
  "kind": "design_plan",
  "summary": "short synthesis",
  "selectedOptionTitle": "selected option title",
  "objective": "what the staged plan accomplishes",
  "architecture": "design-level approach, boundaries, and sequencing rationale",
  "steps": [
    {
      "title": "Stage/step title",
      "details": "what this implementation stage accomplishes, why it is ordered here, and what should be true before moving on",
      "touchpoints": ["repo path/symbol/context"],
      "risks": ["risk"],
      "validation": ["validation idea"]
    }
  ],
  "risks": ["cross-cutting risk"],
  "unknowns": ["open unknown"],
  "acceptanceCriteria": ["observable success criterion"],
  "validation": ["test/check/manual validation"],
  "questions": ["optional question to carry forward"],
  "handoffPrompt": "optional concise prompt for the next workflow stage"
}
```

or:

```json
{
  "kind": "questions",
  "summary": "why design planning is blocked",
  "questions": ["question 1"]
}
```

Final design-plan outputs are adversarially reviewed before being consumed by `wf-impplanner`.

### `wf-impplanner`

Receives the clarified prompt, reviewed design plan, selected brainstorm option, and any follow-up answers. It creates reviewed per-step plans in `.zzwf/tmp/`, merges them into one concrete plan saved under `zzwf/implementationplans/`, and adversarially reviews the final merged plan. Returns either:

```json
{
  "kind": "implementation_plan",
  "summary": "short synthesis",
  "designPlanTitle": "source design-plan title",
  "objective": "what the concrete implementation plan accomplishes",
  "approach": "overall execution strategy and sequencing",
  "stepPlans": [
    {
      "title": "implementation step title",
      "sourceDesignStepTitle": "source design-plan step title",
      "objective": "what this step accomplishes",
      "dependencies": ["dependency/checkpoint before starting"],
      "instructions": ["detailed execution instruction"],
      "highPriorityTests": ["test to write or run, preferably TDD when possible"],
      "checkpoints": ["checkpoint before continuing"],
      "touchpoints": ["repo path/symbol/context"],
      "examples": ["code or pseudocode example when useful"],
      "risks": ["risk"],
      "validation": ["validation command/check"]
    }
  ],
  "highPriorityTests": ["cross-step high-priority test"],
  "checkpoints": ["cross-step checkpoint"],
  "risks": ["cross-cutting risk"],
  "unknowns": ["open unknown"],
  "validation": ["final validation"],
  "handoffPrompt": "optional concise prompt for the execution stage"
}
```

or:

```json
{
  "kind": "questions",
  "summary": "why implementation planning is blocked",
  "questions": ["question 1"]
}
```

Final implementation-plan outputs are adversarially reviewed before being consumed by the implementation loop.

### `wf-implementeragent`

Receives the reviewed implementation plan artifact plus exactly one `stepPlans[]` entry. It mutates the repository for that stage only, optionally applying reviewer feedback from a previous attempt. Returns one of:

```json
{
  "kind": "implemented_stage",
  "stageTitle": "stage title",
  "summary": "what changed",
  "changedFiles": ["repo/path"],
  "testsRun": ["command or check and result"],
  "validation": ["observable validation"],
  "notes": ["optional note"]
}
```

```json
{
  "kind": "questions",
  "summary": "why implementation is blocked on user input",
  "questions": ["question 1"]
}
```

```json
{
  "kind": "blocked",
  "stageTitle": "stage title",
  "summary": "short blocker summary",
  "reason": "why the stage cannot be safely implemented",
  "changedFiles": ["repo/path"],
  "testsRun": ["command or check and result"]
}
```

### `wf-revieweragent`

Receives the same plan/stage plus the implementer report. It reviews code without mutating files and decides whether workflow mode may advance. Returns:

```json
{
  "kind": "reviewed_stage",
  "stageTitle": "stage title",
  "verdict": "pass|needs_changes|blocked",
  "greenSignal": true,
  "summary": "short review summary",
  "feedback": "required changes for implementer when not green",
  "issues": [
    {
      "severity": "info|minor|major|critical",
      "title": "issue title",
      "detail": "issue detail",
      "suggestion": "optional fix"
    }
  ],
  "testsRun": ["command or check and result"]
}
```

Workflow mode advances only when `verdict` is `pass` and `greenSignal` is `true`. For `needs_changes`, reviewer feedback is sent back to the mutating agent for another attempt on the same stage or testing pass.

### `wf-testeragent`

Receives the reviewed implementation plan and current branch after planned implementation stages have passed `wf-revieweragent`. It fills reasonable test gaps before final review. Returns one of:

```json
{
  "kind": "tested_changes",
  "summary": "what test gaps were filled",
  "gapsFound": ["gap"],
  "testsAdded": ["test/file or case"],
  "changedFiles": ["repo/path"],
  "testsRun": ["command or check and result"],
  "validation": ["observable validation"],
  "notes": ["optional note"]
}
```

```json
{
  "kind": "no_test_gaps",
  "summary": "why no additional tests are needed",
  "gapsConsidered": ["area considered"],
  "testsRun": ["command or check and result"],
  "validation": ["observable validation"]
}
```

```json
{
  "kind": "questions",
  "summary": "why testing is blocked on user input",
  "questions": ["question 1"]
}
```

```json
{
  "kind": "blocked",
  "summary": "short blocker summary",
  "reason": "why the testing pass cannot be safely completed",
  "changedFiles": ["repo/path"],
  "testsRun": ["command or check and result"]
}
```

When `wf-testeragent` changes tests, workflow mode sends those changes through `wf-revieweragent`; reviewer feedback loops back to `wf-testeragent` until green. `no_test_gaps` proceeds directly to whole-branch final review.

### `wf-finalreviewagent`

Receives the reviewed implementation plan and current branch after all planned stages have passed `wf-revieweragent`. It performs a whole-branch review without mutating files. Returns:

```json
{
  "kind": "final_review",
  "verdict": "pass|needs_changes|blocked",
  "greenSignal": true,
  "summary": "short branch-level review summary",
  "feedback": "overall feedback when not green",
  "issues": [
    {
      "severity": "info|minor|major|critical",
      "title": "issue title",
      "detail": "issue detail",
      "suggestion": "optional fix"
    }
  ],
  "remediationSteps": [
    {
      "title": "fix step title",
      "objective": "what this remediation step accomplishes",
      "instructions": ["specific implementer instruction"],
      "highPriorityTests": ["test/check to add or run"],
      "touchpoints": ["repo path/symbol/context"],
      "risks": ["risk"],
      "validation": ["validation command/check"]
    }
  ],
  "testsRun": ["command or check and result"]
}
```

Workflow mode completes only when `verdict` is `pass` and `greenSignal` is `true`. For `needs_changes`, each `remediationSteps[]` item is converted into a synthetic implementation stage and dispatched through `wf-implementeragent` plus `wf-revieweragent`; after those remediation loops pass, `wf-finalreviewagent` reviews the whole branch again.

### `wf-adversarialreview`

Receives a stage id, original prompt/context, stage output JSON, a human-readable stage report, and the expected output schema for the reviewed stage. Returns:

```json
{
  "kind": "reviewed_stage",
  "stageId": "wf-brainstormer",
  "verdict": "pass",
  "summary": "short review summary",
  "issues": [
    {
      "severity": "minor",
      "title": "issue title",
      "detail": "issue detail",
      "suggestion": "optional correction"
    }
  ],
  "reviewedOutput": {}
}
```

`reviewedOutput` must match the reviewed stage's expected schema. If review fails, blocks, or returns invalid schema, workflow mode warns and falls back to the original stage output.

## Manual commands for individual agents

Each workflow stage can also be invoked directly:

- `/wf-clarifier model|config|ask <prompt>`
- `/wf-brainstormer model|config|ask <prompt>`
- `/wf-adversarialreview model|config|ask <stage-output>`
- `/wf-designplan model|config|ask <prompt>`
- `/wf-impplanner model|config|ask <prompt>`
- `/wf-implementeragent model|config|ask <manual implementation task>`
- `/wf-revieweragent model|config|ask <manual review task>`
- `/wf-testeragent model|config|ask <manual testing task>`
- `/wf-finalreviewagent model|config|ask <manual branch review task>`

For workflow stages, the `model` command selects a configured model option for that stage. Use `/workflowmode model <model>` to set all `wf-*` stage agents at once. The `config` command shows the active config, model selector, tools, and timeouts.

## Config and models

Each workflow stage has a JSONC config beside the extension:

- `extensions/wf-clarifier.config.jsonc`
- `extensions/wf-brainstormer.config.jsonc`
- `extensions/wf-adversarialreview.config.jsonc`
- `extensions/wf-designplan.config.jsonc`
- `extensions/wf-impplanner.config.jsonc`
- `extensions/wf-implementeragent.config.jsonc`
- `extensions/wf-revieweragent.config.jsonc`
- `extensions/wf-testeragent.config.jsonc`
- `extensions/wf-finalreviewagent.config.jsonc`

By default, these stages use `openai-codex/gpt-5.6-sol` with `thinking: "xhigh"`. Planning stages are configured with `tools: ["readsubagent"]` so repository inspection is delegated to the existing Qwen-based factual subagent. `wf-implementeragent` and `wf-testeragent` are configured with mutating code/testing tools plus `readsubagent`; `wf-revieweragent` and `wf-finalreviewagent` are configured with read/search/bash tools plus `readsubagent`.

The factual subagent keeps its own model config:

- `extensions/readsubagent.config.jsonc`

## Installation and updates

Selecting `workflowmode` installs the full dependency closure automatically:

```text
workflowmode
├─ wf-clarifier
├─ wf-brainstormer
├─ wf-adversarialreview
├─ wf-designplan
├─ wf-impplanner
├─ wf-implementeragent
├─ wf-revieweragent
├─ wf-testeragent
├─ wf-finalreviewagent
├─ readsubagent
└─ zz-subagent-runtime
```

Useful commands:

```text
/zz-plugs install workflowmode
/zz-plugs update
/reload
```

Existing config files are preserved by `/zz-plugs update`. If a config default changes and you want the new defaults, use:

```text
/zz-plugs update --reset-config
/reload
```

`--reset-config` overwrites local config edits.

## Extending the workflow

When adding a new workflow stage:

1. Create `extensions/wf-<stage>.ts` with the same child-agent pattern as the existing `wf-*` agents.
2. Create `extensions/wf-<stage>.config.jsonc` with `modelOptions`, `tools`, timeouts, report limits, and a strict JSON-only system prompt.
3. Add the stage to `pi-plugs.catalog.jsonc` and add it to `workflowmode.pluginDeps` if the orchestrator needs it.
4. Add the new stage name to `EXCLUDED_CHILD_TOOLS` in all `wf-*` agents to prevent recursive workflow-agent calls.
5. Define a JSON output contract and parser for the new stage.
6. Add a report formatter for human-readable output.
7. In `workflowmode.ts`, add pending state for question loops if the stage can return questions.
8. If the output is final/user-facing or consumed by a later planning stage, add an adversarial-review schema and review gate before display/consumption.
9. For implementation stages, pair the implementer with a reviewer gate and loop reviewer feedback back to the implementer until the reviewer returns a green signal.
10. For testing passes, run test-gap changes through reviewer feedback before advancing to final review.
11. For final branch review, dispatch final-review remediation steps through the same implementer/reviewer loop before retrying testing and final review.
12. Update this document and `README.md`.

Prefer additive, stage-specific helpers over a large generic pipeline until repeated patterns are stable enough to justify further abstraction.
