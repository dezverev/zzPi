import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createAgentMode } from "./lib/agent-mode.ts";
import {
  readImplementationDocument,
  readImplementationLedger,
  resolveImplementationDocument,
  type ResolvedImplementationDocument,
} from "./lib/implementation-docs.ts";
import {
  IMPLEMENTATION_CONFIDENCE_THRESHOLD,
  evaluateImplementationConfidence,
  isImplementationHandoffAccepted,
  normalizeImplementationPiece,
  parseImplementationConfidenceCheckpoints,
  parseImplementationPieceReport,
  type ImplementationPieceStatus,
} from "./lib/implementation-piece.ts";
import {
  appendRunInfo,
  createStandaloneChildAgent,
  truncateReport,
  type StandaloneAgentRunResult,
} from "./lib/standalone-agent-common.ts";
import {
  CHILD_PI_AGENT_ENV,
  type ChildAgentProgress,
  type ChildAgentRunResult,
  type ChildPiAgentConfig,
  getChildAgentResultDetails,
  getErrorMessage,
  isRecord,
  renderChildAgentToolCall,
  renderChildAgentToolResult,
} from "./zz-lib/child-pi-agent.ts";

const CONFIG_FILE_PATH = ".pi/extensions/implementationsubagent.config.jsonc";
const IMPLEMENTATIONSUBAGENT_MESSAGE_TYPE = "implementationsubagent-report";
const IMPLEMENTATIONSUBAGENT_STATE_ENTRY_TYPE = "implementationsubagent-state";

const MANDATORY_SCOPE_GUARD = [
  "<implementation_piece_scope_guard>",
  "This invariant overrides any broader configurable instruction: implement exactly one medium-to-small, independently vettable outcome and then return to the main thread.",
  "Never implement an entire feature, multiple stages, later document pieces, adjacent cleanup, or follow-up work in the same run.",
  "If the assignment bundles outcomes or lacks independently executable focused validation, do not start implementation. Update the ledger and return with status needs-decomposition.",
  "Begin the final report with a ## Status section whose entire value is exactly one of: completed, needs-decomposition, or blocked.",
  "</implementation_piece_scope_guard>",
].join("\n");

const MANDATORY_CONFIDENCE_GUARD = [
  "<implementation_confidence_guard>",
  `Maintain an internal confidence score from 0% to 100% about completing this exact piece correctly under the approved design and available evidence. The minimum acceptable confidence is ${IMPLEMENTATION_CONFIDENCE_THRESHOLD}%.`,
  "Reassess confidence before the first implementation edit, after every meaningful milestone or unexpected result, and before final validation or return. Record each checkpoint's percentage and a concise evidence-based rationale in the ledger; do not expose hidden chain-of-thought. Every checkpoint must also include the exact phased machine-readable marker for the supplied confidence run ID, or the handoff will fail closed. Record initial before edits, sequential milestone-N markers after milestones, and final immediately before every return; never use the run ID elsewhere in the ledger.",
  `If confidence falls below ${IMPLEMENTATION_CONFIDENCE_THRESHOLD}% at any checkpoint, stop implementation work immediately, preserve and report any partial changes, update the ledger, and return to the main agent. Do not keep editing in an attempt to raise the score.`,
  "A low-confidence report must use status blocked, except when the scope guard requires needs-decomposition. Never report completed below the confidence threshold.",
  "Every final report must place a ## Confidence section immediately after ## Status. Its entire value must be one integer percentage from 0% through 100% and must equal the minimum confidence observed at any checkpoint in this run, not a later recovered score.",
  "A low-confidence report must also include non-empty ## Low-confidence reason and ## Clarifications needed sections with concise evidence and concrete questions the main agent can resolve before redispatch.",
  "</implementation_confidence_guard>",
].join("\n");

const MANDATORY_IMPLEMENTATION_GUARD = [
  MANDATORY_SCOPE_GUARD,
  MANDATORY_CONFIDENCE_GUARD,
].join("\n\n");

const DEFAULT_TOOLS = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "readsubagent", "debuggersubagent",
] as const;

const EXCLUDED_CHILD_TOOLS = [
  "implementationsubagent", "vettingagents",
  "design-loop", "brainstormer", "designplanner", "promptenrichsubagent",
] as const;

const PARENT_PROMPT = [
  "<implementationsubagent>",
  "Use implementationsubagent only for already-designed coding work that the main agent can advance through medium-to-small implementation pieces.",
  "The main agent owns decomposition, ordering, integration, review, final verification, and all git operations. Do not delegate those responsibilities.",
  "Before calling implementationsubagent, create a non-empty Markdown document under docs/artifacts/implementationdocs. Front-load it with the problem context, approved design, invariants, repository touchpoints, implementation stages, acceptance criteria, risks, and verification plan.",
  "Before each call, carve out exactly one medium-to-small, independently vettable outcome with explicit piece-specific acceptance criteria and focused validation. Prefer one coherent behavior or layer and a small set of tightly related files.",
  "Never delegate an entire feature, multiple implementation stages, a cross-cutting catch-all, or a broad 'finish the rest' task in one call. If a piece cannot be reviewed and course-corrected independently, split it again before delegation.",
  "Call implementationsubagent with that implementationDoc and exactly one concrete task. Run only one implementation child at a time in this parent process, never target the same document or ledger concurrently from another session, and never assign the next piece before completing the main-thread feedback checkpoint for the prior return.",
  "The child may edit code and tests. It must maintain its derived ledger under docs/artifacts/implementationdocs/ledgers and report whether that ledger was updated. It must stop after the assigned piece rather than continuing into later document pieces.",
  "Treat every child return as a main-thread feedback checkpoint: inspect the report, ledger, diff, and focused tests; perform any needed review or vetting; integrate or course-correct; then decide the next piece. Continue only when handoffAccepted=true, which requires executionStatus=completed, pieceStatus=completed, confidenceEvidenceValid=true, confidenceGatePassed=true, documentUnchanged=true, and ledgerUpdated=true.",
  "If pieceStatus=needs-decomposition, split the assignment into smaller independently validated pieces; never redispatch the unchanged broad assignment. If pieceStatus=blocked, do not accept or advance the piece: resolve or escalate its blockers. When confidence fell below the threshold, also review the reason and partial changes, resolve the requested clarifications, make the approved directions more explicit, and redispatch a fresh implementation child for the same bounded piece. Treat a missing or invalid confidence report as blocked until its protocol and directions are clarified.",
  "The main agent decides whether completed work needs adversarial review and calls vettingagents itself when warranted; do not delegate vetting to the implementation child.",
  "Do not use implementationsubagent for solution exploration, design creation, tiny edits, uncertain root-cause debugging, broad review, or committing/pushing/merging.",
  "</implementationsubagent>",
].join("\n");

const DEFAULT_IMPLEMENTATIONSUBAGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 272_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 128_000,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 40_000,
  requestTimeoutMs: 45 * 60 * 1_000,
  systemPrompt:
    "You are implementationsubagent, a main-agent-controlled implementation worker. Implement exactly one medium-to-small, independently vettable piece from the supplied Markdown implementation document, modify code and tests only within that scope, maintain the supplied Markdown progress ledger throughout the run, run focused validation, and return promptly with a concise Markdown report. Stop when that piece is complete; never continue into later pieces. Maintain and checkpoint an internal confidence percentage throughout the work, record each checkpoint with the supplied run ID's machine-readable ledger marker, and report the minimum marked confidence observed during the run. If confidence falls below 80%, stop implementation, update the ledger, and return a blocked low-confidence handoff with the reason and concrete clarifications needed; never report completed below 80%. If the assignment is too broad or bundles multiple outcomes, record that it needs decomposition and return without attempting the larger scope. Do not redesign the solution, orchestrate the overall project, or perform git commits, pushes, merges, rebases, or branch changes.",
  thinking: "max",
  tools: DEFAULT_TOOLS,
};

export type ImplementationSubagentStatus = ImplementationPieceStatus;

export interface ImplementationSubagentDecision {
  readonly clarificationsNeeded?: string | undefined;
  readonly confidence: number;
  readonly lowConfidenceReason?: string | undefined;
  readonly markdown: string;
  readonly status: ImplementationSubagentStatus;
}

export interface ImplementationSubagentRunResult extends StandaloneAgentRunResult<ImplementationSubagentDecision> {
  readonly confidenceCheckpointCount: number;
  readonly confidenceEvidenceValid: boolean;
  readonly confidenceGatePassed: boolean;
  readonly confidenceRunId: string;
  readonly confidenceThreshold: number;
  readonly handoffAccepted: boolean;
  readonly minimumObservedConfidence?: number | undefined;
  readonly documentError?: string | undefined;
  readonly documentPath: string;
  readonly documentUnchanged: boolean;
  readonly ledgerError?: string | undefined;
  readonly ledgerPath: string;
  readonly ledgerUpdated: boolean;
}

function buildImplementationSubagentPrompt(task: string): string {
  return [
    "You are running as implementationsubagent, a bounded implementation worker controlled by the main agent.",
    "This run is a short feedback unit. Complete exactly one medium-to-small, independently vettable outcome and stop. Do not implement later pieces from the document, opportunistic follow-ups, or adjacent cleanup.",
    "The supplied Markdown implementation document is the authoritative design and context. Treat it as read-only. Implement only the assigned piece; do not broaden scope or replace the design. If it lacks enough approved design or context, update the ledger and report questions or blockers rather than guessing.",
    "Before editing, check whether the assigned piece has one coherent outcome, explicit acceptance criteria, and focused validation. If it bundles multiple outcomes, spans multiple implementation stages, or cannot be validated independently, mark it blocked as needs-decomposition in the ledger and return without starting the broad implementation.",
    "Before changing code, read the current repository state, assess confidence, and create or update the supplied Markdown ledger with the assigned piece marked in progress and the confidence checkpoint recorded. If its parent directories do not exist, create them. Reassess and record confidence after meaningful milestones or unexpected results and again before final validation or return. Retain the minimum confidence observed during the run for the final report; never replace a lower checkpoint with a later recovered score.",
    "The ledger must retain cumulative progress across runs and include: implementation document path, current piece and status, timestamped progress notes, confidence checkpoints with concise evidence-based rationales, files changed, tests/commands and outcomes, decisions or deviations, remaining work, and blockers.",
    "Use readsubagent for targeted factual file inspection when useful. Use debuggersubagent when an unexpected failure has an uncertain root cause. Do not call vettingagents; the main agent owns any adversarial review of completed work. Do not delegate implementation itself.",
    "Run only the supplied focused validation for the assigned piece, plus the smallest checks required to make that evidence trustworthy. Do not commit, push, merge, rebase, switch branches, or rewrite unrelated user changes.",
    `Maintain an internal confidence percentage while working. If it falls below ${IMPLEMENTATION_CONFIDENCE_THRESHOLD}%, stop implementation immediately, preserve and report partial changes, update the ledger, and return rather than guessing or continuing. Use status \`blocked\`, unless the scope guard requires \`needs-decomposition\`.`,
    "Return a concise Markdown report, not JSON. Begin with `## Status` followed on the next line by exactly one value: `completed`, `needs-decomposition`, or `blocked`. Immediately follow it with `## Confidence` and one integer percentage from `0%` through `100%` equal to the minimum confidence observed during the run. Never report `completed` below `80%`. For confidence below `80%`, include non-empty `## Low-confidence reason` and `## Clarifications needed` sections. Then use clear sections for summary, files changed, validation, decisions or deviations, remaining work, and any questions or blockers.",
    task,
  ].join("\n\n");
}

function parseImplementationSubagentDecision(text: string): ImplementationSubagentDecision | undefined {
  const markdown = text.trim();
  if (!markdown) return undefined;
  const report = parseImplementationPieceReport(markdown);
  return report ? { markdown, ...report } : undefined;
}

function formatImplementationSubagentReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: ImplementationSubagentDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const rawMarkdown = options.result.output.trim();
  const lines = options.decision
    ? [options.decision.markdown, ""]
    : rawMarkdown
      ? [rawMarkdown, ""]
      : ["# Implementation subagent", "", "_No Markdown report was returned._", ""];
  if (options.parseError) lines.push(`Report warning: ${options.parseError}`, "");
  appendRunInfo(lines, { config: options.config, result: options.result });
  return truncateReport(lines, options.config);
}

const implementationSubagent = createStandaloneChildAgent<ImplementationSubagentDecision>({
  agentName: "implementationsubagent",
  allowCommandRun: false,
  buildPrompt: buildImplementationSubagentPrompt,
  commandDescription: "Inspect or configure the parent-controlled implementation subagent",
  commandUsage: "/implementationsubagent model [model|default] | config | status",
  configFilePath: CONFIG_FILE_PATH,
  defaultConfig: DEFAULT_IMPLEMENTATIONSUBAGENT_CONFIG,
  displayName: "Implementation subagent",
  excludeTools: EXCLUDED_CHILD_TOOLS,
  formatReport: formatImplementationSubagentReport,
  mandatorySystemPrompt: MANDATORY_IMPLEMENTATION_GUARD,
  messageType: IMPLEMENTATIONSUBAGENT_MESSAGE_TYPE,
  modelDisplaySuffix: " (implementationsubagent)",
  parseDecision: parseImplementationSubagentDecision,
  parseErrorMessage: "implementationsubagent report did not satisfy the required status/confidence handoff contract",
  providerDisplayName: "Implementation Subagent",
  stateEntryType: IMPLEMENTATIONSUBAGENT_STATE_ENTRY_TYPE,
});

function buildDelegatedTask(options: {
  readonly acceptanceCriteria: readonly string[];
  readonly confidenceRunId: string;
  readonly context?: string | undefined;
  readonly focusedValidation: readonly string[];
  readonly document: ResolvedImplementationDocument;
  readonly relevantPaths?: readonly string[] | undefined;
  readonly task: string;
}): string {
  const { document } = options;
  return [
    `Implementation document path: ${document.documentPath}`,
    `Ledger path: ${document.ledgerPath}`,
    [
      `Confidence checkpoint run ID: ${options.confidenceRunId}`,
      `Before implementation edits, add \`<!-- implementationsubagent-confidence:${options.confidenceRunId}:initial:85% -->\`, replacing 85 with the initial integer score.`,
      `After meaningful milestones, add sequential \`milestone-1\`, \`milestone-2\`, and later markers in the form \`<!-- implementationsubagent-confidence:${options.confidenceRunId}:milestone-1:85% -->\`.`,
      `Immediately before every return, add \`<!-- implementationsubagent-confidence:${options.confidenceRunId}:final:85% -->\`. Do not write this run ID anywhere else in the ledger.`,
      "The handoff fails closed unless the phased marker sequence is valid and the report's ## Confidence value equals the minimum marked score.",
    ].join("\n"),
    `Assigned implementation piece:\n${options.task}`,
    options.context ? `Additional parent context:\n${options.context}` : "",
    options.relevantPaths?.length
      ? `Relevant paths suggested by the parent:\n${options.relevantPaths.map((path) => `- ${path}`).join("\n")}`
      : "",
    `Piece-specific acceptance criteria:\n${options.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
    `Focused validation for this piece:\n${options.focusedValidation.map((step) => `- ${step}`).join("\n")}`,
    [
      `BEGIN IMPLEMENTATION DOCUMENT (${document.documentPath})`,
      document.documentContent,
      "END IMPLEMENTATION DOCUMENT",
    ].join("\n"),
    document.ledgerContent === undefined
      ? `No ledger exists yet. Create ${document.ledgerPath} before editing implementation files.`
      : [
          `BEGIN CURRENT LEDGER (${document.ledgerPath})`,
          document.ledgerContent,
          "END CURRENT LEDGER",
        ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

let implementationRunActive = false;

export async function runImplementationSubagentForPiece(options: {
  readonly acceptanceCriteria: readonly string[];
  readonly context?: string | undefined;
  readonly focusedValidation: readonly string[];
  readonly ctx: ExtensionContext;
  readonly implementationDoc: string;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly relevantPaths?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly task: string;
}): Promise<ImplementationSubagentRunResult> {
  const piece = normalizeImplementationPiece(
    options.task,
    options.acceptanceCriteria,
    options.focusedValidation,
  );
  if (implementationRunActive) {
    throw new Error("implementationsubagent already has an active piece; complete the main-thread feedback checkpoint before starting another");
  }
  implementationRunActive = true;
  try {
    const document = await resolveImplementationDocument(options.ctx.cwd, options.implementationDoc);
    const confidenceRunId = randomUUID();
    const run = await implementationSubagent.run({
      ctx: options.ctx,
      onProgress: options.onProgress,
      pi: options.pi,
      signal: options.signal,
      task: buildDelegatedTask({
        acceptanceCriteria: piece.acceptanceCriteria,
        confidenceRunId,
        context: options.context,
        document,
        focusedValidation: piece.focusedValidation,
        relevantPaths: options.relevantPaths,
        task: piece.task,
      }),
    });

    let documentAfter: string | undefined;
    let documentError: string | undefined;
    let ledgerAfter: string | undefined;
    let ledgerError: string | undefined;
    try {
      documentAfter = await readImplementationDocument(document.absoluteDocumentPath);
    } catch (error) {
      documentError = getErrorMessage(error);
    }
    try {
      ledgerAfter = await readImplementationLedger(document.absoluteLedgerPath);
    } catch (error) {
      ledgerError = getErrorMessage(error);
    }
    const confidenceThreshold = IMPLEMENTATION_CONFIDENCE_THRESHOLD;
    const confidenceCheckpoints = ledgerAfter === undefined
      ? undefined
      : parseImplementationConfidenceCheckpoints(ledgerAfter, confidenceRunId);
    const confidenceEvaluation = evaluateImplementationConfidence(
      run.decision?.confidence,
      confidenceCheckpoints,
      run.decision?.status,
    );
    const {
      confidenceCheckpointCount,
      confidenceEvidenceValid,
      confidenceGatePassed,
      minimumObservedConfidence,
    } = confidenceEvaluation;
    const documentUnchanged = documentAfter === document.documentContent;
    const ledgerUpdated = ledgerAfter !== undefined && ledgerAfter !== document.ledgerContent;
    const handoffAccepted = isImplementationHandoffAccepted({
      confidenceEvidenceValid,
      confidenceGatePassed,
      documentUnchanged,
      executionStatus: run.result.status,
      ledgerUpdated,
      pieceStatus: run.decision?.status,
    });
    const confidenceVerification = run.decision
      ? `Confidence evidence: report ${run.decision.confidence}%; ${confidenceCheckpointCount} current-run ledger checkpoint(s); ledger minimum ${minimumObservedConfidence === undefined ? "missing or invalid" : `${minimumObservedConfidence}%`}; ${confidenceEvidenceValid ? "matched" : "MISMATCH — handoff rejected"}; ${confidenceGatePassed ? "threshold passed" : `below or unable to prove ${confidenceThreshold}% threshold`}`
      : `WARNING: Confidence gate could not be evaluated; required threshold is ${confidenceThreshold}%`;
    const documentVerification = documentUnchanged
      ? `Implementation document remained unchanged: ${document.documentPath}`
      : `WARNING: Implementation document changed or became unreadable: ${document.documentPath}${documentError ? ` (${documentError})` : ""}`;
    const ledgerVerification = ledgerUpdated
      ? `Ledger updated: ${document.ledgerPath}`
      : `WARNING: Ledger was not updated: ${document.ledgerPath}${ledgerError ? ` (${ledgerError})` : ""}`;
    const statusVerification = `Child execution status: ${run.result.status}; piece status: ${run.decision?.status ?? "missing or invalid"}; handoff accepted: ${handoffAccepted}`;

    return {
      ...run,
      confidenceCheckpointCount,
      confidenceEvidenceValid,
      confidenceGatePassed,
      confidenceRunId,
      confidenceThreshold,
      handoffAccepted,
      ...(minimumObservedConfidence === undefined ? {} : { minimumObservedConfidence }),
      ...(documentError ? { documentError } : {}),
      documentPath: document.documentPath,
      documentUnchanged,
      ...(ledgerError ? { ledgerError } : {}),
      ledgerPath: document.ledgerPath,
      ledgerUpdated,
      report: `${run.report.trimEnd()}\n\n## Handoff verification\n\n- ${statusVerification}\n- ${confidenceVerification}\n- ${documentVerification}\n- ${ledgerVerification}\n`,
    };
  } finally {
    implementationRunActive = false;
  }
}

export default function implementationSubagentExtension(pi: ExtensionAPI): void {
  if (process.env[CHILD_PI_AGENT_ENV] === "1") return;

  implementationSubagent.register(pi);
  const mode = createAgentMode(pi, {
    id: "implementationsubagent",
    label: "implementation subagent",
    tools: ["implementationsubagent"],
    enabledByDefault: () => true,
    shortcut: "ctrl+alt+i",
  });

  pi.on("session_start", (_event, ctx) => mode.restore(ctx));
  pi.on("session_tree", (_event, ctx) => mode.restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => mode.clearStatus(ctx));
  pi.on("before_agent_start", (event) => {
    if (!mode.isEnabled() || !pi.getActiveTools().includes("implementationsubagent")) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${PARENT_PROMPT}` };
  });

  pi.registerTool({
    name: "implementationsubagent",
    label: "Implementation Subagent",
    description:
      "Delegate one medium-to-small, independently vettable implementation piece from a main-agent-authored Markdown implementation document. The child can edit code and tests, use nested read/debug subagents, maintain its persistent ledger and confidence checkpoints, and return early for clarification whenever confidence falls below 80%.",
    promptSnippet:
      "Delegate one medium-to-small, already-designed, independently vettable coding piece to a ledger-maintaining implementation child agent",
    promptGuidelines: [
      "Use implementationsubagent only for approved, already-designed coding work decomposed into medium-to-small independently vettable pieces.",
      "Before calling implementationsubagent, create a context-rich Markdown document under docs/artifacts/implementationdocs containing the design, constraints, touchpoints, stages, acceptance criteria, risks, and verification plan.",
      "The main agent owns decomposition, sequencing, integration, review, final verification, and git operations; pass exactly one coherent outcome with explicit acceptance criteria per call.",
      "Do not bundle an entire feature, multiple stages, unrelated layers, or 'finish the rest' work. Split any piece that cannot receive focused validation and meaningful main-thread review on its own.",
      "The child may mutate code and tests and must maintain its derived ledger under docs/artifacts/implementationdocs/ledgers. Continue only when handoffAccepted=true, which requires executionStatus=completed, pieceStatus=completed, confidenceEvidenceValid=true, confidenceGatePassed=true, documentUnchanged=true, and ledgerUpdated=true.",
      "Split needs-decomposition work instead of redispatching it unchanged. Resolve any blocked handoff before continuing. For a confidence-blocked or malformed handoff, inspect the reason, partial state, and clarifications needed; clarify the approved directions and redispatch a fresh child for the same bounded piece rather than advancing or telling the current child to continue.",
      "Run only one implementation child at a time in this parent process, and never target the same document or ledger from another session concurrently. After every return, inspect the report, ledger, diff, and focused tests, then review, vet, integrate, or course-correct before choosing the next piece.",
      "The main agent owns review and may call vettingagents on completed work when necessary; the implementation child must not call vettingagents itself.",
      "Do not use implementationsubagent for design work, tiny edits, uncertain root-cause debugging, broad code review, or any commit/push/merge operation.",
    ],
    parameters: Type.Object({
      implementationDoc: Type.String({
        description:
          "Repo-relative path to a non-empty Markdown implementation document under docs/artifacts/implementationdocs (not under ledgers).",
      }),
      task: Type.String({
        minLength: 12,
        description: "One medium-to-small, coherent, independently vettable implementation outcome from the supplied document; never an entire feature or multiple stages.",
      }),
      context: Type.Optional(Type.String({
        description: "Additional current-state context that is not already captured in the implementation document.",
      })),
      relevantPaths: Type.Optional(Type.Array(Type.String(), {
        description: "Repo-relative files or directories likely needed for this implementation piece.",
      })),
      acceptanceCriteria: Type.Array(Type.String({ minLength: 12 }), {
        minItems: 1,
        description: "Required observable acceptance criteria for this piece so the main thread can validate and vet it independently.",
      }),
      focusedValidation: Type.Array(Type.String({ minLength: 8 }), {
        minItems: 1,
        description: "Required focused test commands or validation checks that can establish this piece independently.",
      }),
    }, { additionalProperties: false }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const run = await runImplementationSubagentForPiece({
        acceptanceCriteria: params.acceptanceCriteria,
        context: params.context,
        focusedValidation: params.focusedValidation,
        ctx,
        implementationDoc: params.implementationDoc,
        onProgress: (progress) => {
          onUpdate?.({
            content: [{
              type: "text",
              text: `implementationsubagent running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
            }],
            details: progress,
          });
        },
        pi,
        relevantPaths: params.relevantPaths,
        signal,
        task: params.task,
      });

      return {
        content: [{ type: "text", text: run.report }],
        details: {
          ...getChildAgentResultDetails(run.result, run.config),
          executionStatus: run.result.status,
          status: run.result.status === "completed" && !run.handoffAccepted ? "blocked" : run.result.status,
          confidenceCheckpointCount: run.confidenceCheckpointCount,
          confidenceEvidenceValid: run.confidenceEvidenceValid,
          confidenceGatePassed: run.confidenceGatePassed,
          confidenceRunId: run.confidenceRunId,
          confidenceThreshold: run.confidenceThreshold,
          handoffAccepted: run.handoffAccepted,
          ...(run.minimumObservedConfidence === undefined
            ? {}
            : { minimumObservedConfidence: run.minimumObservedConfidence }),
          ...(run.parseError ? { parseError: run.parseError } : {}),
          ...(run.decision ? { confidence: run.decision.confidence } : {}),
          ...(run.decision?.lowConfidenceReason
            ? { lowConfidenceReason: run.decision.lowConfidenceReason }
            : {}),
          ...(run.decision?.clarificationsNeeded
            ? { clarificationsNeeded: run.decision.clarificationsNeeded }
            : {}),
          documentPath: run.documentPath,
          documentUnchanged: run.documentUnchanged,
          ...(run.documentError ? { documentError: run.documentError } : {}),
          ledgerPath: run.ledgerPath,
          ledgerUpdated: run.ledgerUpdated,
          ...(run.decision ? { pieceStatus: run.decision.status } : {}),
          ...(run.ledgerError ? { ledgerError: run.ledgerError } : {}),
        },
      };
    },

    renderCall(rawArgs: unknown, theme, context) {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const implementationDoc = typeof args.implementationDoc === "string" ? args.implementationDoc : "implementation doc";
      const task = typeof args.task === "string" ? args.task : "...";
      return renderChildAgentToolCall(theme, {
        agentName: "implementationsubagent",
        model: implementationSubagent.getActiveModelSelector(context.cwd),
        scope: implementationDoc,
        task,
      });
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "implementationsubagent" });
    },
  });

  pi.registerCommand("implementation-mode", {
    description: "Enable, disable, toggle, or inspect implementationsubagent mode.",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (mode.handleAction(action, ctx)) return;
      ctx.ui.notify("Usage: /implementation-mode on|off|toggle|status", "warning");
    },
  });
}
