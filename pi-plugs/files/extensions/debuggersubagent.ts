import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  CHILD_PI_AGENT_ENV,
  type ChildAgentProgress,
  type ChildPiAgentConfig,
  getChildAgentResultDetails,
  isRecord,
  renderChildAgentToolCall,
  renderChildAgentToolResult,
} from "./zz-lib/child-pi-agent.ts";
import {
  appendRunInfo,
  createStandaloneChildAgent,
  getOptionalString,
  getStringArray,
  normalizeKind,
  parseJsonRecord,
  pushList,
  STANDALONE_AGENT_EXCLUDED_TOOLS,
  truncateReport,
  type StandaloneAgentRunResult,
} from "./lib/standalone-agent-common.ts";

const CONFIG_FILE_PATH = ".pi/extensions/debuggersubagent.config.jsonc";
const MODEL_OPTIONS_CONFIG_FILE_PATH = ".pi/extensions/zz-agent-models.config.jsonc";
const DEBUGGERSUBAGENT_MESSAGE_TYPE = "debuggersubagent-report";
const DEBUGGERSUBAGENT_STATE_ENTRY_TYPE = "debuggersubagent-state";
const DEFAULT_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
const NESTED_DEBUGGER_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
const DEBUGGER_EXCLUDED_TOOLS = [
  ...STANDALONE_AGENT_EXCLUDED_TOOLS,
  "readsubagent", "edit", "write", "implementationsubagent",
] as const;

const DEFAULT_DEBUGGERSUBAGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 272_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 128_000,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 32_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are debuggersubagent, a standalone diagnosis-only root-cause debugging specialist for Pi. Diagnose bugs, failures, regressions, flaky tests, and suspicious behavior before implementation begins. Inspect evidence directly, identify the most likely root cause, recommend a focused fix, and return only the requested JSON. You may run reproductions, tests, builds, linters, profilers, trace capture, and purpose-built ad hoc diagnostic scripts. Those commands may create ordinary generated diagnostic artifacts such as temporary files, caches, build/test output, coverage, traces, and screenshots; incidental diagnostic writes are expected. Do not intentionally edit existing repository source, tests, configuration, documentation, scripts, manifests, or lockfiles; apply the fix; mutate git history, index, or branches; install or remove packages; create virtualenvs or toolchains; switch versions via a version manager; change persistent project, application, or runtime state such as databases, services, containers, or durable fixtures; change persistent machine or user configuration; publish or change remote state; or perform destructive or irreversible operations. Read-only remote diagnostics are allowed. Isolate scratch artifacts where practical, identify material artifacts left behind in the report, and clean up only debugger-created disposable artifacts when safe; never delete user or project data. The parent agent decides whether and how to apply fixes.",
  thinking: "medium",
  tools: DEFAULT_TOOLS,
};

export type DebuggerSubagentDecision =
  | {
      readonly architectureConcern?: string | undefined;
      readonly evidence: readonly string[];
      readonly hypotheses: readonly string[];
      readonly kind: "debug_analysis";
      readonly pattern: string;
      readonly recommendedFix: string;
      readonly rootCause: string;
      readonly verificationCommands: readonly string[];
    }
  | {
      readonly kind: "questions";
      readonly questions: readonly string[];
      readonly summary?: string | undefined;
    }
  | {
      readonly evidence: readonly string[];
      readonly kind: "blocked";
      readonly reason: string;
      readonly summary?: string | undefined;
    };

export type DebuggerSubagentRunResult = StandaloneAgentRunResult<DebuggerSubagentDecision>;

function buildDebuggerSubagentPrompt(task: string): string {
  return [
    "You are running as debuggersubagent, a standalone root-cause debugging specialist for Pi.",
    "Inspect repository and runtime evidence directly with the available read, search, and shell tools. Do not call readsubagent, workflow, debuggersubagent, or implementation tools.",
    "You may run reproductions, tests, builds, linters, profilers, trace capture, and purpose-built ad hoc diagnostic scripts. These commands may create ordinary generated diagnostic artifacts such as temporary files, caches, build/test output, coverage, traces, and screenshots; incidental diagnostic writes are expected. Isolate scratch artifacts where practical and identify material artifacts left behind in the report. Cleanup is allowed only for debugger-created disposable artifacts when safe; never delete user or project data.",
    "Remain diagnosis-only: do not intentionally edit existing repository source, tests, configuration, documentation, scripts, manifests, or lockfiles; apply the fix; mutate git history, index, or branches; install or remove packages (pip, npm, uv, cargo, apt, brew, or any other package manager); create virtualenvs or toolchains; switch versions via a version manager; change persistent project, application, or runtime state such as databases, services, containers, or durable fixtures; change persistent machine or user configuration; publish or change remote state; or perform destructive or irreversible operations. Read-only remote diagnostics are allowed. If a repro requires one of those actions, report the requirement and the exact command you would have run instead of running it.",
    "Return JSON only. Do not wrap it in markdown. Use one of these shapes:",
    `{"kind":"debug_analysis","rootCause":"most likely root cause","evidence":["file/path:line or command output"],"pattern":"bug pattern or failure mode","hypotheses":["alternative considered"],"recommendedFix":"focused implementation instruction","verificationCommands":["command to verify"],"architectureConcern":"optional broader concern"}`,
    `{"kind":"questions","summary":"why diagnosis needs user input","questions":["question 1"]}`,
    `{"kind":"blocked","summary":"short blocker summary","reason":"why debugging cannot continue","evidence":["evidence gathered"]}`,
    `Delegated debugging task:\n${task}`,
  ].join("\n\n");
}

function parseDebuggerSubagentDecision(text: string): DebuggerSubagentDecision | undefined {
  const parsed = parseJsonRecord(text);
  if (!parsed) return undefined;

  const kind = normalizeKind(getOptionalString(parsed, "kind") ?? getOptionalString(parsed, "type"), "debug_analysis");
  const summary = getOptionalString(parsed, "summary");

  if (kind === "questions" || kind === "question") {
    const questions = getStringArray(parsed.questions);
    return questions.length > 0 ? { kind: "questions", questions, ...(summary ? { summary } : {}) } : undefined;
  }

  if (kind === "blocked" || kind === "blocker") {
    const reason = getOptionalString(parsed, "reason") ?? getOptionalString(parsed, "detail") ?? summary;
    if (!reason) return undefined;
    return {
      evidence: getStringArray(parsed.evidence),
      kind: "blocked",
      reason,
      ...(summary ? { summary } : {}),
    };
  }

  if (kind !== "debug_analysis" && kind !== "analysis" && kind !== "diagnosis" && kind !== "debug") {
    return undefined;
  }

  const rootCause = getOptionalString(parsed, "rootCause") ?? getOptionalString(parsed, "root_cause") ?? getOptionalString(parsed, "cause");
  const recommendedFix = getOptionalString(parsed, "recommendedFix") ?? getOptionalString(parsed, "recommended_fix") ?? getOptionalString(parsed, "fix");
  if (!rootCause || !recommendedFix) return undefined;

  return {
    ...(getOptionalString(parsed, "architectureConcern") ?? getOptionalString(parsed, "architecture_concern")
      ? { architectureConcern: getOptionalString(parsed, "architectureConcern") ?? getOptionalString(parsed, "architecture_concern") }
      : {}),
    evidence: getStringArray(parsed.evidence),
    hypotheses: getStringArray(parsed.hypotheses ?? parsed.alternatives),
    kind: "debug_analysis",
    pattern: getOptionalString(parsed, "pattern") ?? getOptionalString(parsed, "failureMode") ?? "Unknown failure pattern",
    recommendedFix,
    rootCause,
    verificationCommands: getStringArray(parsed.verificationCommands ?? parsed.verification_commands ?? parsed.commands),
  };
}

function formatDebuggerSubagentReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: DebuggerSubagentDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: DebuggerSubagentRunResult["result"];
}): string {
  const lines = ["# Debugger subagent", ""];
  const { decision } = options;

  if (decision?.kind === "debug_analysis") {
    lines.push("- Status: diagnosis complete");
    lines.push(`- Root cause: ${decision.rootCause}`);
    lines.push(`- Pattern: ${decision.pattern}`);
    lines.push(`- Recommended fix: ${decision.recommendedFix}`);
    if (decision.architectureConcern) lines.push(`- Architecture concern: ${decision.architectureConcern}`);
    lines.push("");
    pushList(lines, "Evidence", decision.evidence);
    pushList(lines, "Hypotheses considered", decision.hypotheses);
    pushList(lines, "Verification commands", decision.verificationCommands);
  } else if (decision?.kind === "questions") {
    if (decision.summary) lines.push(decision.summary, "");
    pushList(lines, "Questions", decision.questions);
  } else if (decision?.kind === "blocked") {
    lines.push("- Status: blocked");
    if (decision.summary) lines.push(`- Summary: ${decision.summary}`);
    lines.push(`- Reason: ${decision.reason}`, "");
    pushList(lines, "Evidence", decision.evidence);
  } else {
    lines.push("## Raw debugger output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }

  appendRunInfo(lines, { config: options.config, result: options.result });
  return truncateReport(lines, options.config);
}

const debuggerSubagent = createStandaloneChildAgent<DebuggerSubagentDecision>({
  agentName: "debuggersubagent",
  buildPrompt: buildDebuggerSubagentPrompt,
  commandDescription: "Run the standalone root-cause debugging specialist, inspect its config, or select its model",
  commandUsage: "/debuggersubagent model [model|default] | config | ask <problem>; or /debuggersubagent <problem>",
  configFilePath: CONFIG_FILE_PATH,
  defaultModelOptionId: "gpt-5.6-sol-medium",
  modelOptionsConfigFilePath: MODEL_OPTIONS_CONFIG_FILE_PATH,
  defaultConfig: DEFAULT_DEBUGGERSUBAGENT_CONFIG,
  displayName: "Debugger subagent",
  excludeTools: DEBUGGER_EXCLUDED_TOOLS,
  formatReport: formatDebuggerSubagentReport,
  messageType: DEBUGGERSUBAGENT_MESSAGE_TYPE,
  modelDisplaySuffix: " (debuggersubagent)",
  parseDecision: parseDebuggerSubagentDecision,
  parseErrorMessage: "debuggersubagent did not return parseable debugging JSON",
  providerDisplayName: "Debugger Subagent",
  stateEntryType: DEBUGGERSUBAGENT_STATE_ENTRY_TYPE,
});

export function parseDebuggerSubagentOutput(text: string): DebuggerSubagentDecision | undefined {
  return parseDebuggerSubagentDecision(text);
}

export async function runDebuggerSubagentForProblem(options: {
  readonly attempt?: number | undefined;
  readonly context?: string | undefined;
  readonly ctx: ExtensionContext;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly problem: string;
  readonly relevantPaths?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly tools?: readonly string[] | undefined;
}): Promise<DebuggerSubagentRunResult> {
  const task = [
    `Problem: ${options.problem}`,
    options.context ? `\nContext:\n${options.context}` : "",
    options.relevantPaths?.length ? `\nRelevant paths:\n${options.relevantPaths.map((path) => `- ${path}`).join("\n")}` : "",
    options.attempt !== undefined ? `\nDebug attempt: ${options.attempt}` : "",
  ].filter(Boolean).join("\n");
  return debuggerSubagent.run({
    ctx: options.ctx,
    onProgress: options.onProgress,
    pi: options.pi,
    signal: options.signal,
    task,
    tools: options.tools,
  });
}

export async function selectDebuggerSubagentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
  options?: { readonly quiet?: boolean },
): Promise<void> {
  await debuggerSubagent.selectModel(pi, ctx, args, options);
}

export function sendDebuggerSubagentReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: DebuggerSubagentRunResult,
): void {
  debuggerSubagent.sendReportMessage(pi, ctx, run);
}

export default function debuggerSubagentExtension(pi: ExtensionAPI): void {
  debuggerSubagent.register(pi);

  pi.registerTool({
    name: "debuggersubagent",
    label: "Debugger Subagent",
    description:
      "Delegate root-cause diagnosis of bugs, failures, regressions, flaky tests, and suspicious behavior to a diagnosis-only child Pi agent. It gathers repository evidence and returns a structured diagnosis, focused fix recommendation, and verification commands without implementing the fix.",
    promptSnippet:
      "Delegate evidence-based root-cause debugging to a non-implementing child Pi agent before implementing a fix",
    promptGuidelines: [
      "Use debuggersubagent when a bug, regression, failing test, flaky behavior, or unexpected runtime result needs evidence-based root-cause analysis.",
      "Delegate before editing when the cause is uncertain; include symptoms, expected versus actual behavior, reproduction details, errors, and relevant paths when available.",
      "Treat the result as diagnostic evidence: inspect its root cause, alternatives, recommended fix, and verification commands before deciding what to change.",
      "The debugger is diagnosis-only and may create incidental diagnostic artifacts. Keep implementation, code-review judgment, git operations, and final verification in the parent workflow.",
      "Do not use debuggersubagent for ordinary feature planning, factual file summarization, broad repo discovery, or bugs whose root cause is already established.",
    ],
    parameters: Type.Object({
      problem: Type.String({
        description:
          "Bug, failure, regression, flaky test, or suspicious behavior to diagnose. Include symptoms and expected versus actual behavior.",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Additional reproduction steps, error messages, logs, prior hypotheses, environment details, or constraints.",
        }),
      ),
      relevantPaths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Repo-relative files or directories that are likely relevant to the problem.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const run = await runDebuggerSubagentForProblem({
        context: params.context,
        ctx,
        onProgress: (progress) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `debuggersubagent running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
              },
            ],
            details: progress,
          });
        },
        pi,
        problem: params.problem,
        relevantPaths: params.relevantPaths,
        signal,
        tools: process.env[CHILD_PI_AGENT_ENV] === "1" ? NESTED_DEBUGGER_TOOLS : undefined,
      });

      return {
        content: [{ type: "text", text: run.report }],
        details: getChildAgentResultDetails(run.result, run.config),
      };
    },

    renderCall(rawArgs: unknown, theme, context) {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const problem = typeof args.problem === "string" ? args.problem : "";
      const pathCount = Array.isArray(args.relevantPaths) ? args.relevantPaths.length : 0;
      const scope = pathCount > 0 ? `${pathCount} path${pathCount === 1 ? "" : "s"}` : "repo";
      return renderChildAgentToolCall(theme, {
        agentName: "debuggersubagent",
        model: debuggerSubagent.getActiveModelSelector(context.cwd),
        scope,
        task: problem || "...",
      });
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "debuggersubagent" });
    },
  });
}
