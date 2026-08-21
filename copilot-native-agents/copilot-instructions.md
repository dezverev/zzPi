<!-- zz-copilot-agents:start -->
## Delegated Workflow Roles

Three native agents complement the separately installed `readsubagent` skill.
The parent owns decomposition, sequencing, review, integration, final
verification, direct edits, and all git operations.

Brainstorm and design in the parent conversation when requested. The user and
parent select the direction, resolve behavior-affecting ambiguity, and record
consequential decisions. Before delegating implementation, the parent turns the
selected direction into a structured Markdown implementation document and a
bounded task with explicit acceptance criteria and focused validation.

| Situation | Delegate |
|---|---|
| A non-debug repository fact, location, or focused read plan is needed | `readsubagent` skill |
| A failure has an uncertain cause | `zz-debugger` |
| One bounded approved-design piece warrants delegated implementation | `zz-implementer` |
| An important plan, diff, or completion claim needs challenge | `zz-vetter` x3 |

Use agents deliberately, not as a mandatory pipeline. The parent may handle
routine decisions and small, localized, low-risk edits directly.

The original user ask remains the scope baseline. Small, directly coupled
correctness changes may remain in scope. Pause and ask before materially
expanding behavior, affected subsystems, dependencies, migrations, risk, or
delivery effort.

### Role rules

Use the `readsubagent` skill only for non-debug factual scouting, inspection,
and read planning according to its separately managed instruction block. Do not
ask it to review correctness, diagnose failures, compare solutions, design
changes, or implement. The debugger gathers evidence directly with its native
tools and does not call or depend on `readsubagent`.

**`zz-debugger`** is diagnosis-only, not filesystem-pure. Use it before editing
when a failure's cause is uncertain. Include symptoms, expected and actual
behavior, reproduction output, and relevant paths. It may create ordinary
generated diagnostic artifacts but never applies fixes or intentionally edits
existing repository implementation assets; the parent decides whether to apply
its recommendation.

**`zz-implementer`** is the sole write-capable delegated specialist, not the
sole writer including the parent. Reserve it for one bounded piece of approved
work that warrants implementation-document and ledger ceremony. Before calling
it:

1. Create a non-empty implementation document under
   `docs/artifacts/implementationdocs/` with context, approved design,
   invariants, touchpoints, stages, acceptance criteria, risks, and validation.
2. Assign exactly one medium-to-small, independently reviewable piece with the
   original ask, focused acceptance criteria, and validation.
3. Run only one implementer at a time repository-wide.

Never assign an entire feature, multiple stages, or "finish the rest." After
each return, inspect the report, ledger, diff, and focused validation. Accept a
piece only when:

- status is `completed` and confidence is at least 80%;
- the ledger was updated and its minimum confidence matches the report;
- the new ledger record has the next ordinal and contiguous non-empty progress;
- the implementation document is unchanged; and
- the claimed validation passed.

If status is `needs-decomposition`, split the piece. If it is `blocked`,
confidence is below 80%, or status/confidence is malformed, resolve the issue
and redispatch a fresh implementer for the same bounded piece.

The implementer must stop at material scope boundaries. Its lifecycle hooks
provide cooperative exclusive-run, implementation-document integrity, and
append-only ledger checks; they do not defend against a hostile same-user
process. Continue reviewing every handoff. Agent or hook updates may require a
fresh Copilot CLI session.

**`zz-vetter`** is read-only. For important artifacts, launch three independent
instances in parallel, one per lens:

- `research-grounding`: claims match real evidence;
- `feasibility-live-tree`: the artifact works against the current tree;
- `consistency-severity`: conclusions are consistent and severity is honest.

Give each instance artifact paths, the claim to verify, relevant symbols/search
terms, and known concerns. Vetters report findings and never edit.

### Shared constraints

- `zz-vetter` remains read-only. `zz-debugger` is non-implementing but may create
  incidental diagnostic artifacts. Among delegated specialists, only
  `zz-implementer` intentionally edits existing repository implementation
  assets.
- No delegated agent performs git mutations.
- Every agent receives explicit paths, symbols, constraints, prior findings,
  and the selected solution when applicable; agents do not inherit the parent's
  conversation context.
- The parent verifies delegated reports against the live repository before
  relying on them.
<!-- zz-copilot-agents:end -->
