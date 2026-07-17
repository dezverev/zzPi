# The Minimum Complete Agentic Coding System

> A manifesto for the smallest agentic coding layer that still closes the loop.

## The position

Modern coding harnesses already know how to call tools, edit files, run tests, and follow project instructions. They do not need a second operating system made of prompts. They do need a small amount of workflow structure so the main model does not have to discover the repository, invent the process, implement everything, and review itself in one overloaded context.

That is the line this system tries to hold:

- **Any less leaves a known loop uncovered.** In this design's risk model, removing a role brings back stale assumptions, premature fixes, design drift, unbounded implementation, single-pass blind spots, or an unnecessarily high model bill.
- **Any more should justify its context cost.** Mandatory personas, always-on stages, duplicated plans, and giant instruction packs compete with the code and the user for the model's attention.
- **The tools are available, not compulsory.** The parent invokes only the stages the task needs.

This is "minimum complete," not merely minimal: the smallest useful slice that preserves grounding, direction, execution discipline, independent checking, and cost control.

## Between a bare harness and a workflow framework

A bare or older harness can provide shell, search, and edit tools while giving the model little workflow direction. The model then improvises: it reads broadly, fixes before diagnosing, skips explicit design choices, and reviews its own output from the same context that produced it.

At the other extreme, large workflow packs—including Superpowers-style systems—can be valuable when they compensate for a weak harness or model. On a modern harness, however, an always-on collection of roles, checklists, artifacts, and stage instructions can duplicate capabilities the harness and model already have. The result can be more ceremony, more injected context, and more opportunities for the process to become the task.

The middle layer should be thinner:

| Approach | What it provides | Typical tradeoff |
|---|---|---|
| Bare harness | Raw tools and model autonomy | Too little direction; quality depends on the model inventing a good process every time |
| Large workflow framework | A prescribed process for most tasks | Strong direction, but potentially duplicated context, mandatory stages, and coordination overhead |
| Minimum complete layer | Narrow agents with explicit role contracts, called only when needed | Enough workflow to close failure loops without turning every request into a pipeline |

This is not an argument that one framework is universally bad. It is a claim about fit: as harnesses and models become more capable, the useful workflow layer should get smaller, more conditional, and more explicit about what each token buys.

## The three context failures

### 1. Stale context and documentation rot

Long-lived prompt copies and remembered repository maps age immediately. A `readsubagent` instead inspects the live checkout when the parent needs a factual answer. It returns a compact map with files, symbols, line ranges, search anchors, and uncertainty, leaving raw discovery outside the main thread.

That does **not** make an incorrect document true. It does make the agent's working context current with the checked-out tree, keeps citations recoverable, and avoids treating an old session summary as repository state.

The boundary matters: the read agent retrieves and summarizes facts. It does not review correctness or choose an implementation. Those judgments remain in the main thread, where the relevant evidence—not the whole repository—is available.

### 2. Hallucination and single-pass blind spots

A model checking its own work in the same context often repeats its own assumptions. `vettingagents` runs three separate child executions with distinct review lenses over a high-value design, diff, or implementation result. They may use the same selected model, but each receives its own context and separately checks grounding, live-tree feasibility, or consistency/severity before the parent compares their findings. Their contracts prohibit mutation and expose no direct edit/write tools; shell access means that non-mutation is policy-enforced rather than an operating-system sandbox.

Cross-checking is not a proof of truth. Three lens passes can still share a blind spot. It is a practical way to make one plausible story compete with separate readings before the parent relies on it. Tests, type checks, runtime validation, and human judgment still decide the result.

### 3. Cost without discrimination

Repository reading, debugging, design, implementation, and adversarial review do not all require the same model. Each subagent has its own selectable model/reasoning configuration, and workspace overrides persist across sessions and upgrades.

That makes model choice an operation-level decision:

- use the smallest reliable model for high-volume factual reading;
- spend more reasoning on ambiguous diagnosis or consequential design;
- use a capable implementation model only for a bounded piece;
- reserve three-lens vetting for artifacts whose risk justifies three reads.

The objective is not "always use the cheapest model." It is **minimum viable model per operation**: the least expensive route that meets the quality bar for that role.

## The minimum set of roles

Each role exists because it closes a different failure loop.

| Role | Tool | Failure it prevents |
|---|---|---|
| Live grounding | `readsubagent` | Broad main-thread exploration, stale repository maps, and raw-file context pollution |
| Root-cause diagnosis | `debuggersubagent` | Editing symptoms before establishing evidence for the cause |
| Solution exploration | `brainstormer` | Locking onto the first plausible approach without material alternatives |
| Selected design | `designplanner` / `design-loop` | Treating a recommendation as user approval or implementing an ungrounded plan |
| Bounded execution | `implementationsubagent` | Feature-sized delegation, silent uncertainty, and an autonomous child owning integration |
| Independent challenge | `vettingagents` | Letting one context both make and certify a high-value claim without separate challenge |
| Economic routing | Per-agent model controls | Paying the strongest-model rate for every operation or forcing one local model onto every role |

Prompt enrichment remains optional and user-triggered. It can improve an underspecified request, but it is not silently inserted into every task.

The parent agent is still essential. It classifies the task, selects stages, owns decomposition and sequencing, reviews every handoff, runs final validation, and controls Git. Subagents are bounded instruments, not a replacement hierarchy.

## The operating loop

The system has a direction without forcing every task through every stage:

1. **Ground only where needed.** Ask for a factual read plan, then read the smallest exact slices required for judgment or editing.
2. **Diagnose unexpected behavior before fixing it.** A debugger operating under a non-mutation contract gathers evidence and recommends focused verification.
3. **Explore real design choices when the solution is not already selected.** Brainstorm materially distinct options; the parent protocol requires the user to select one before detailed design.
4. **Write the implementation contract.** Put context, invariants, stages, risks, acceptance criteria, and validation in a durable Markdown brief.
5. **Delegate one independently vettable piece.** Never hand an implementation child an entire feature or a vague "finish the rest" assignment.
6. **Stop on uncertainty.** The child protocol requires confidence checkpoints and an early handoff when self-reported confidence falls below the threshold.
7. **Review in the parent.** Inspect the report, ledger, diff, and focused tests before assigning another piece.
8. **Vet when the stakes warrant it.** Use independent lenses for high-value plans and results, not as mandatory theater on every tiny edit.
9. **Verify and integrate.** Deterministic tests and the parent-owned Git workflow remain the final gate.

A documentation typo may need only steps 1 and 9. A regression may need 1, 2, 7, and 9. A cross-cutting feature may need the full loop. Conditional composition is the point.

## Why the confidence gate matters

An implementation agent should not convert confusion into confident-looking code.

`implementationsubagent` receives one bounded outcome, explicit acceptance criteria, and focused validation. Its protocol requires progress in a persistent ledger and a report containing the minimum self-assessed confidence recorded during the run—not merely the final score. Below 80%, the child is instructed to stop, preserve partial state, explain the reason, and ask concrete clarification questions.

The extension validates the returned status, phased confidence evidence, ledger update, and document integrity, then computes `handoffAccepted` fail-closed. It cannot observe a child's private reasoning or technically prevent a parent from violating the workflow after a rejected handoff. The parent policy advances only when execution and piece status are complete, confidence evidence is valid, the confidence gate passed, the implementation document stayed unchanged, and the ledger was updated. Otherwise the parent decomposes further, resolves the ambiguity, or redispatches a fresh child with clearer approved directions.

This is deliberately less autonomous than "give an agent the feature." It is also more useful: uncertainty becomes a visible control signal instead of hidden implementation risk.

## Why less fails

Remove one boundary and the corresponding shortcut reappears:

- no live read agent: the main model spends context on discovery or trusts stale summaries;
- no diagnostic role: implementation starts before root cause is established;
- no explicit solution selection: the tool silently chooses product direction;
- no bounded implementation contract: scope expands and review arrives too late;
- no confidence stop: ambiguity is buried under plausible code;
- no independent vetting: the same assumptions create and approve the artifact;
- no per-agent model routing: cost and latency are set by the most demanding stage.

A collection with fewer names may look simpler, but if the parent must recreate these controls in every prompt, the complexity still exists—it is merely implicit and inconsistent.

## Why more becomes bloat

Additional machinery has a real price when it:

- injects instructions for roles that the current task will not use;
- requires every request to traverse a fixed pipeline;
- creates multiple plans or summaries containing the same facts;
- keeps broad repository content in the main context "just in case";
- asks agents to narrate progress instead of producing evidence;
- duplicates planning, tool use, or review behavior already native to the harness;
- adds an agent without giving it a distinct failure boundary and acceptance test.

The test for a new workflow component is therefore strict:

> Which recurring failure does this component prevent that an existing bounded role cannot, and is that benefit worth its context, latency, and coordination cost?

If the answer is unclear, do not add the component.

## Sharp boundaries are the feature

The system stays small because roles do not blur. These are workflow contracts: schemas and status validation enforce some boundaries, while prompts and tool policy enforce others. They are not an operating-system security boundary.

- readers do not perform code review;
- debuggers do not edit;
- brainstormers do not turn recommendations into decisions;
- designers do not implement;
- implementation children do not own decomposition, vetting, integration, or Git;
- vetters do not mutate the artifact they judge;
- the parent does not outsource final responsibility.

These constraints can feel conservative. They are what let each agent receive a narrow prompt, use an appropriately sized model, and return an output the parent can actually evaluate.

## What this system does not promise

It does not eliminate bad documentation, hallucination, regressions, or cost. It does not replace tests or domain expertise. Self-reported confidence is not a correctness score, and independent agents are not perfectly independent.

It promises something narrower and testable:

- current repository evidence can be gathered without flooding the main context;
- uncertainty and solution choice are made explicit before implementation advances;
- implementation work is bounded and checkpointed;
- important claims can be challenged by independent readers;
- model spend can match the operation rather than the whole session;
- the parent and user retain control of decisions and integration.

That is the minimum complete slice: no giant agent bureaucracy, no bare-harness improvisation, and no pretending that one overloaded context should read, decide, build, and certify everything alone.
