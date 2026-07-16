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
  "Use implementationsubagent only for substantial, already-designed coding work that the main agent can decompose into bounded implementation pieces.",
  "The main agent owns decomposition, ordering, integration, review, final verification, and all git operations. Do not delegate those responsibilities.",
  "Before calling implementationsubagent, create a non-empty Markdown document under docs/artifacts/implementationdocs. Front-load it with the problem context, approved design, invariants, repository touchpoints, implementation stages, acceptance criteria, risks, and verification plan.",
  "Call implementationsubagent with that implementationDoc and exactly one concrete task. Run pieces sequentially for the same document unless they are proven independent.",
  "The child may edit code and tests. It must maintain its derived ledger under docs/artifacts/implementationdocs/ledgers and report whether that ledger was updated.",
  "Inspect the returned report, ledger, diff, and tests before assigning another piece. Require documentUnchanged=true and ledgerUpdated=true; treat failures or unresolved blockers as incomplete work.",
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
    "You are implementationsubagent, a main-agent-controlled implementation worker. Implement one bounded piece from the supplied Markdown implementation document, modify code and tests only within that scope, maintain the supplied Markdown progress ledger throughout the run, validate your work, and return a concise Markdown report. Do not redesign the solution, orchestrate the overall project, or perform git commits, pushes, merges, rebases, or branch changes.",
  thinking: "max",
  tools: DEFAULT_TOOLS,
};

export interface ImplementationSubagentDecision {
  readonly markdown: string;
}

export interface ImplementationSubagentRunResult extends StandaloneAgentRunResult<ImplementationSubagentDecision> {
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
    "The supplied Markdown implementation document is the authoritative design and context. Treat it as read-only. Implement only the assigned piece; do not broaden scope or replace the design. If it lacks enough approved design or context, update the ledger and report questions or blockers rather than guessing.",
    "Before changing code, read the current repository state and create or update the supplied Markdown ledger with the assigned piece marked in progress. If its parent directories do not exist, create them. Update the ledger after meaningful milestones and again before returning.",
    "The ledger must retain cumulative progress across runs and include: implementation document path, current piece and status, timestamped progress notes, files changed, tests/commands and outcomes, decisions or deviations, remaining work, and blockers.",
    "Use readsubagent for targeted factual file inspection when useful. Use debuggersubagent when an unexpected failure has an uncertain root cause. Do not call vettingagents; the main agent owns any adversarial review of completed work. Do not delegate implementation itself.",
    "Run focused validation for the assigned piece. Do not commit, push, merge, rebase, switch branches, or rewrite unrelated user changes.",
    "Return a concise Markdown report, not JSON. Use clear sections for status, summary, files changed, validation, decisions or deviations, remaining work, and any questions or blockers.",
    task,
  ].join("\n\n");
}

function parseImplementationSubagentDecision(text: string): ImplementationSubagentDecision | undefined {
  const markdown = text.trim();
  return markdown ? { markdown } : undefined;
}

function formatImplementationSubagentReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: ImplementationSubagentDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = options.decision
    ? [options.decision.markdown, ""]
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
  commandUsage: "/implementationsubagent model [model] | config | status",
  configFilePath: CONFIG_FILE_PATH,
  defaultConfig: DEFAULT_IMPLEMENTATIONSUBAGENT_CONFIG,
  displayName: "Implementation subagent",
  excludeTools: EXCLUDED_CHILD_TOOLS,
  formatReport: formatImplementationSubagentReport,
  messageType: IMPLEMENTATIONSUBAGENT_MESSAGE_TYPE,
  modelDisplaySuffix: " (implementationsubagent)",
  parseDecision: parseImplementationSubagentDecision,
  parseErrorMessage: "implementationsubagent returned an empty Markdown report",
  providerDisplayName: "Implementation Subagent",
  stateEntryType: IMPLEMENTATIONSUBAGENT_STATE_ENTRY_TYPE,
});

function buildDelegatedTask(options: {
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly context?: string | undefined;
  readonly document: ResolvedImplementationDocument;
  readonly relevantPaths?: readonly string[] | undefined;
  readonly task: string;
}): string {
  const { document } = options;
  return [
    `Implementation document path: ${document.documentPath}`,
    `Ledger path: ${document.ledgerPath}`,
    `Assigned implementation piece:\n${options.task}`,
    options.context ? `Additional parent context:\n${options.context}` : "",
    options.relevantPaths?.length
      ? `Relevant paths suggested by the parent:\n${options.relevantPaths.map((path) => `- ${path}`).join("\n")}`
      : "",
    options.acceptanceCriteria?.length
      ? `Piece-specific acceptance criteria:\n${options.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`
      : "",
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

export async function runImplementationSubagentForPiece(options: {
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly context?: string | undefined;
  readonly ctx: ExtensionContext;
  readonly implementationDoc: string;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly relevantPaths?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly task: string;
}): Promise<ImplementationSubagentRunResult> {
  if (!options.task.trim()) throw new Error("implementation task must not be empty");
  const document = await resolveImplementationDocument(options.ctx.cwd, options.implementationDoc);
  const run = await implementationSubagent.run({
    ctx: options.ctx,
    onProgress: options.onProgress,
    pi: options.pi,
    signal: options.signal,
    task: buildDelegatedTask({
      acceptanceCriteria: options.acceptanceCriteria,
      context: options.context,
      document,
      relevantPaths: options.relevantPaths,
      task: options.task,
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
  const documentUnchanged = documentAfter === document.documentContent;
  const ledgerUpdated = ledgerAfter !== undefined && ledgerAfter !== document.ledgerContent;
  const documentVerification = documentUnchanged
    ? `Implementation document remained unchanged: ${document.documentPath}`
    : `WARNING: Implementation document changed or became unreadable: ${document.documentPath}${documentError ? ` (${documentError})` : ""}`;
  const ledgerVerification = ledgerUpdated
    ? `Ledger updated: ${document.ledgerPath}`
    : `WARNING: Ledger was not updated: ${document.ledgerPath}${ledgerError ? ` (${ledgerError})` : ""}`;

  return {
    ...run,
    ...(documentError ? { documentError } : {}),
    documentPath: document.documentPath,
    documentUnchanged,
    ...(ledgerError ? { ledgerError } : {}),
    ledgerPath: document.ledgerPath,
    ledgerUpdated,
    report: `${run.report.trimEnd()}\n\n## Handoff verification\n\n- ${documentVerification}\n- ${ledgerVerification}\n`,
  };
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
      "Delegate one bounded implementation piece from a main-agent-authored Markdown implementation document. The child can edit code and tests, use nested read/debug subagents, and must update its own persistent ledger.",
    promptSnippet:
      "Delegate one bounded, already-designed coding piece to a ledger-maintaining implementation child agent",
    promptGuidelines: [
      "Use implementationsubagent only for substantial coding work with an approved design that the main agent has decomposed into bounded pieces.",
      "Before calling implementationsubagent, create a context-rich Markdown document under docs/artifacts/implementationdocs containing the design, constraints, touchpoints, stages, acceptance criteria, risks, and verification plan.",
      "The main agent owns decomposition, sequencing, integration, review, final verification, and git operations; pass exactly one implementation piece per call.",
      "The child may mutate code and tests and must maintain its derived ledger under docs/artifacts/implementationdocs/ledgers. Require documentUnchanged=true and ledgerUpdated=true before continuing.",
      "Run pieces for the same implementation document sequentially unless they are proven independent, and inspect each report, ledger, diff, and test result before the next call.",
      "The main agent owns review and may call vettingagents on completed work when necessary; the implementation child must not call vettingagents itself.",
      "Do not use implementationsubagent for design work, tiny edits, uncertain root-cause debugging, broad code review, or any commit/push/merge operation.",
    ],
    parameters: Type.Object({
      implementationDoc: Type.String({
        description:
          "Repo-relative path to a non-empty Markdown implementation document under docs/artifacts/implementationdocs (not under ledgers).",
      }),
      task: Type.String({
        description: "One concrete, bounded implementation piece from the supplied document.",
      }),
      context: Type.Optional(Type.String({
        description: "Additional current-state context that is not already captured in the implementation document.",
      })),
      relevantPaths: Type.Optional(Type.Array(Type.String(), {
        description: "Repo-relative files or directories likely needed for this implementation piece.",
      })),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String(), {
        description: "Piece-specific acceptance criteria that refine, but do not replace, the document contract.",
      })),
    }, { additionalProperties: false }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const run = await runImplementationSubagentForPiece({
        acceptanceCriteria: params.acceptanceCriteria,
        context: params.context,
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
          documentPath: run.documentPath,
          documentUnchanged: run.documentUnchanged,
          ...(run.documentError ? { documentError: run.documentError } : {}),
          ledgerPath: run.ledgerPath,
          ledgerUpdated: run.ledgerUpdated,
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
