import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  type ChildAgentProgress,
  type ChildAgentRunResult,
  type ChildPiAgentConfig,
  formatChildAgentConfig,
  getErrorMessage,
  getModelSelector,
  isRecord,
  previewTask,
  readChildPiAgentConfig,
  registerChildAgentProvider,
  renderChildAgentMessage,
  runChildPiAgent,
  sendChildAgentReportMessage,
  truncateText,
} from "./zz-lib/child-pi-agent.ts";
import {
  type ChildAgentModelOption,
  applyChildAgentModelSelection,
  createChildAgentModelOptionFromConfig,
  findChildAgentModelOption,
  formatAvailableChildAgentModels,
  formatChildAgentModelSelection,
  getChildAgentModelChoiceLabel,
  getChildAgentModelCompletions,
  getChildAgentModelOption,
  readChildAgentModelOptions,
} from "./lib/child-agent-model-options.ts";
import type { WfImplementerAgentDecision } from "./wf-implementeragent.ts";
import type { WfImpplannerDecision, WfImpplannerStepPlan } from "./wf-impplanner.ts";

const CONFIG_FILE_PATH = ".pi/extensions/wf-revieweragent.config.jsonc";
const WF_REVIEWER_AGENT_MESSAGE_TYPE = "wf-revieweragent-report";
const WF_REVIEWER_AGENT_STATE_ENTRY_TYPE = "wf-revieweragent-state";
const STATUS_KEY = "wf-revieweragent";
const DEFAULT_TOOLS = ["read", "bash", "grep", "find", "ls", "readsubagent"];
const EXCLUDED_CHILD_TOOLS = [
  "vettingagents",
  "vetting-agents",
  "wfclarifier",
  "wf-clarifier",
  "wfbrainstormer",
  "wf-brainstormer",
  "wfadversarialreview",
  "wf-adversarialreview",
  "wfdesignplan",
  "wf-designplan",
  "wfimpplanner",
  "wf-impplanner",
  "wfimplementeragent",
  "wf-implementeragent",
  "wfrevieweragent",
  "wf-revieweragent",
  "wffinalreviewagent",
  "wf-finalreviewagent",
  "wftesteragent",
  "wf-testeragent",
] as const;

const DEFAULT_WF_REVIEWER_AGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 272_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 128_000,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 32_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are wf-revieweragent, a workflow-mode code reviewer for Pi. Review the repository after a single wf-implementeragent stage, run targeted read-only checks/tests when practical, and decide whether the workflow may advance to the next implementation-plan stage. Do not mutate files. Return only the requested JSON decision.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

type WfReviewerAgentModelOption = ChildAgentModelOption;

interface WfReviewerAgentState {
  readonly selectedModelId?: string;
}

interface WfReviewerAgentSavedState {
  readonly selectedModelId?: string;
}

export interface WfReviewerAgentIssue {
  readonly detail: string;
  readonly severity: "info" | "minor" | "major" | "critical";
  readonly suggestion?: string;
  readonly title: string;
}

export interface WfReviewerAgentDecision {
  readonly kind: "reviewed_stage";
  readonly feedback?: string;
  readonly greenSignal: boolean;
  readonly issues: readonly WfReviewerAgentIssue[];
  readonly stageTitle: string;
  readonly summary?: string;
  readonly testsRun: readonly string[];
  readonly verdict: "pass" | "needs_changes" | "blocked";
}

export interface WfReviewerAgentRunResult {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfReviewerAgentDecision;
  readonly parseError?: string;
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_WF_REVIEWER_AGENT_CONFIG };
let currentModelOptions: readonly WfReviewerAgentModelOption[] = [
  createChildAgentModelOptionFromConfig(DEFAULT_WF_REVIEWER_AGENT_CONFIG),
];
let lastConfigError: string | undefined;
let selectedWfReviewerAgentModelId: string | undefined;

function readWfReviewerAgentModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly WfReviewerAgentModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "wf-revieweragent",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getWfReviewerAgentModelOption(id: string | undefined): WfReviewerAgentModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findWfReviewerAgentModelOption(input: string): WfReviewerAgentModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getWfReviewerAgentModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableWfReviewerAgentModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatWfReviewerAgentModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedWfReviewerAgentModelId,
  });
}

function applyWfReviewerAgentModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(config, getWfReviewerAgentModelOption(selectedWfReviewerAgentModelId));
}

function readWfReviewerAgentConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "wf-revieweragent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_WF_REVIEWER_AGENT_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readActiveWfReviewerAgentConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readWfReviewerAgentConfig(cwd);
  currentModelOptions = readWfReviewerAgentModelOptions(cwd, baseConfig);
  return applyWfReviewerAgentModelSelection(baseConfig);
}

function reloadWfReviewerAgentSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveWfReviewerAgentConfig(cwd);
  registerWfReviewerAgentProvider(pi, currentConfig);
}

function registerWfReviewerAgentProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (wf-revieweragent)",
    providerDisplayName: "Workflow Reviewer Agent",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) ctx.ui.notify(`wf-revieweragent config ignored: ${lastConfigError}`, "warning");
}

function getSavedStateFromBranch(ctx: ExtensionContext): WfReviewerAgentSavedState {
  let saved: WfReviewerAgentSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== WF_REVIEWER_AGENT_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getWfReviewerAgentModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readWfReviewerAgentConfig(ctx.cwd);
  currentModelOptions = readWfReviewerAgentModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedWfReviewerAgentModelId = saved.selectedModelId;
  currentConfig = applyWfReviewerAgentModelSelection(baseConfig);
  registerWfReviewerAgentProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<WfReviewerAgentState>(WF_REVIEWER_AGENT_STATE_ENTRY_TYPE, {
    ...(selectedWfReviewerAgentModelId ? { selectedModelId: selectedWfReviewerAgentModelId } : {}),
  });
}

export async function selectWfReviewerAgentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
  options?: { readonly quiet?: boolean },
): Promise<void> {
  reloadWfReviewerAgentSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findWfReviewerAgentModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown wf-revieweragent model "${requested}". Available: ${formatAvailableWfReviewerAgentModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /wf-revieweragent model <model>. Available: ${formatAvailableWfReviewerAgentModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select wf-revieweragent model", choices);
    if (!choice) {
      ctx.ui.notify("wf-revieweragent model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No wf-revieweragent models are available", "warning");
    return;
  }

  selectedWfReviewerAgentModelId = option.id;
  persistState(pi);
  reloadWfReviewerAgentSettings(pi, ctx.cwd);
  if (!options?.quiet) {
    ctx.ui.notify(
      `wf-revieweragent model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
      "info",
    );
  }
}

function buildWfReviewerAgentTask(options: {
  readonly attempt: number;
  readonly implementationPlan: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly implementationPlanArtifactPath?: string | undefined;
  readonly implementerDecision: WfImplementerAgentDecision;
  readonly implementerReport: string;
  readonly previousFeedback?: string | undefined;
  readonly stepIndex: number;
  readonly stepPlan: WfImpplannerStepPlan;
  readonly totalSteps: number;
}): string {
  return [
    `Review stage: ${options.stepIndex + 1} of ${options.totalSteps}`,
    `Implementation attempt: ${options.attempt}`,
    "",
    "Implementation plan artifact path, if available:",
    options.implementationPlanArtifactPath?.trim() || "- not supplied; use the JSON plan below",
    "",
    "Full reviewed implementation plan JSON:",
    JSON.stringify(options.implementationPlan, null, 2),
    "",
    "Single stage plan JSON that should now be complete:",
    JSON.stringify(options.stepPlan, null, 2),
    "",
    "Previous reviewer feedback supplied to the implementer, if any:",
    options.previousFeedback?.trim() || "- none",
    "",
    "Implementer JSON decision:",
    JSON.stringify(options.implementerDecision, null, 2),
    "",
    "Implementer report:",
    options.implementerReport.trim() || "- no report supplied",
    "",
    "Review objective:",
    "- Decide whether this stage is acceptable and the workflow may advance to the next implementation-plan stage.",
    "- Inspect changed code and relevant surrounding code. Run targeted tests/checks when practical.",
    "- Do not mutate files. If changes are needed, provide actionable feedback for wf-implementeragent.",
    "- Only send a green signal when the implementation satisfies this stage, does not create obvious regressions, and validation is adequate for moving on.",
    "- Return JSON only using the requested schema.",
  ].join("\n");
}

function buildWfReviewerAgentPrompt(task: string): string {
  return [
    "You are running as wf-revieweragent, the implementation review gate in Pi workflow mode.",
    "Your job is code review for exactly one wf-implementeragent stage before workflow mode advances to the next plan stage.",
    "Use read/search/bash tools for review and validation. Do not edit or write files.",
    "Return a green signal only when the stage is acceptable to move forward. If not acceptable, return needs_changes with feedback that can be handed directly to wf-implementeragent.",
    "Return JSON only. Do not wrap it in markdown. Use exactly this shape:",
    `{"kind":"reviewed_stage","stageTitle":"stage title","verdict":"pass|needs_changes|blocked","greenSignal":true,"summary":"short review summary","feedback":"required changes for implementer when not green","issues":[{"severity":"info|minor|major|critical","title":"issue title","detail":"issue detail","suggestion":"optional fix"}],"testsRun":["command or check and result"]}`,
    "For verdict=pass, greenSignal must be true and feedback may be omitted. For needs_changes or blocked, greenSignal must be false and feedback should explain exactly what the implementer must change.",
    `Delegated wf-revieweragent task:\n${task}`,
  ].join("\n\n");
}

function extractJsonCandidate(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  const candidates = [fenced?.[1], text].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  }

  return undefined;
}

function getOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function normalizeSeverity(value: unknown): WfReviewerAgentIssue["severity"] {
  if (typeof value !== "string") return "minor";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "info" ||
    normalized === "minor" ||
    normalized === "major" ||
    normalized === "critical"
  ) {
    return normalized;
  }
  return "minor";
}

function normalizeVerdict(value: unknown, greenSignal: boolean | undefined): WfReviewerAgentDecision["verdict"] {
  if (greenSignal === true) return "pass";
  if (typeof value !== "string") return "needs_changes";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (normalized === "pass" || normalized === "passed" || normalized === "green" || normalized === "approved") {
    return greenSignal === false ? "needs_changes" : "pass";
  }
  if (normalized === "blocked" || normalized === "block") return "blocked";
  return "needs_changes";
}

function normalizeIssues(value: unknown): readonly WfReviewerAgentIssue[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): WfReviewerAgentIssue | undefined => {
      if (!isRecord(item)) return undefined;
      const detail = getOptionalString(item, "detail") ?? getOptionalString(item, "description") ?? "";
      if (!detail) return undefined;
      const suggestion = getOptionalString(item, "suggestion") ?? getOptionalString(item, "requiredChange");
      return {
        detail,
        severity: normalizeSeverity(item.severity),
        ...(suggestion ? { suggestion } : {}),
        title: getOptionalString(item, "title") ?? `Issue ${index + 1}`,
      };
    })
    .filter((item): item is WfReviewerAgentIssue => Boolean(item));
}

export function parseWfReviewerAgentDecision(text: string): WfReviewerAgentDecision | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;
  const kind = (getOptionalString(parsed, "kind") ?? getOptionalString(parsed, "type") ?? "reviewed_stage").toLowerCase();
  if (kind && kind !== "reviewed_stage" && kind !== "review" && kind !== "stage_review") return undefined;

  const explicitGreenSignal = typeof parsed.greenSignal === "boolean" ? parsed.greenSignal : undefined;
  const verdict = normalizeVerdict(parsed.verdict ?? parsed.status, explicitGreenSignal);
  const greenSignal = explicitGreenSignal ?? (verdict === "pass");
  const issues = normalizeIssues(parsed.issues);
  const summary = getOptionalString(parsed, "summary");
  const feedback =
    getOptionalString(parsed, "feedback") ??
    getOptionalString(parsed, "requiredChanges") ??
    getOptionalString(parsed, "required_changes") ??
    summary;

  return {
    ...(feedback && !greenSignal ? { feedback } : {}),
    greenSignal,
    issues,
    kind: "reviewed_stage",
    stageTitle: getOptionalString(parsed, "stageTitle") ?? getOptionalString(parsed, "stage_title") ?? "Implementation stage",
    ...(summary ? { summary } : {}),
    testsRun: getStringArray(parsed.testsRun ?? parsed.tests_run ?? parsed.tests),
    verdict,
  };
}

function formatIssue(issue: WfReviewerAgentIssue, index: number): string {
  const lines = [`${index + 1}. **${issue.severity}: ${issue.title}**`, `   - ${issue.detail}`];
  if (issue.suggestion) lines.push(`   - Suggestion: ${issue.suggestion}`);
  return lines.join("\n");
}

function pushList(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push(`## ${title}`, "");
  items.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
}

export function formatWfReviewerAgentFeedback(decision: WfReviewerAgentDecision): string {
  const lines = [
    `Reviewer verdict: ${decision.verdict}`,
    `Green signal: ${decision.greenSignal ? "yes" : "no"}`,
  ];
  if (decision.summary) lines.push(`Summary: ${decision.summary}`);
  if (decision.feedback) lines.push("", "Feedback:", decision.feedback);
  if (decision.issues.length > 0) {
    lines.push("", "Issues:");
    decision.issues.forEach((issue, index) => {
      lines.push(`${index + 1}. [${issue.severity}] ${issue.title}: ${issue.detail}`);
      if (issue.suggestion) lines.push(`   Suggestion: ${issue.suggestion}`);
    });
  }
  if (decision.testsRun.length > 0) {
    lines.push("", "Reviewer tests/checks:", ...decision.testsRun.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

export function formatWfReviewerAgentReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfReviewerAgentDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Workflow reviewer agent", ""];
  const { decision } = options;

  if (decision) {
    lines.push(`- Stage: ${decision.stageTitle}`);
    lines.push(`- Verdict: ${decision.verdict}`);
    lines.push(`- Green signal: ${decision.greenSignal ? "yes" : "no"}`);
    if (decision.summary) lines.push(`- Summary: ${decision.summary}`);
    if (decision.feedback) lines.push("", "## Feedback for implementer", "", decision.feedback, "");
    if (decision.issues.length > 0) {
      lines.push("## Issues", "", ...decision.issues.map(formatIssue), "");
    } else {
      lines.push("", "No issues found.", "");
    }
    pushList(lines, "Tests/checks run", decision.testsRun);
  } else {
    lines.push("## Raw reviewer output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }

  lines.push("## Run info", "");
  lines.push(`- Status: ${options.result.status}`);
  lines.push(`- Model: ${options.result.model ?? getModelSelector(options.config)}`);
  lines.push(`- Tools: ${options.result.toolCalls.map((call) => call.name).join(", ") || "none"}`);
  if (options.result.errorMessage) lines.push(`- Error: ${options.result.errorMessage}`);

  return truncateText(lines.join("\n"), options.config.reportMaxChars);
}

export async function runWfReviewerAgentForStage(options: {
  readonly attempt: number;
  readonly ctx: ExtensionContext;
  readonly implementationPlan: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly implementationPlanArtifactPath?: string | undefined;
  readonly implementerDecision: WfImplementerAgentDecision;
  readonly implementerReport: string;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly previousFeedback?: string | undefined;
  readonly stepIndex: number;
  readonly stepPlan: WfImpplannerStepPlan;
  readonly totalSteps: number;
}): Promise<WfReviewerAgentRunResult> {
  const config = readActiveWfReviewerAgentConfig(options.ctx.cwd);
  registerWfReviewerAgentProvider(options.pi, config);

  const task = buildWfReviewerAgentTask(options);
  const result = await runChildPiAgent({
    buildPrompt: buildWfReviewerAgentPrompt,
    config,
    defaultCwd: options.ctx.cwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    task,
  });
  const decision = parseWfReviewerAgentDecision(result.output);
  const parseError = decision ? undefined : "wf-revieweragent did not return parseable review JSON";
  const report = formatWfReviewerAgentReport({ config, decision, parseError, result });

  return { config, decision, ...(parseError ? { parseError } : {}), report, result };
}

export function sendWfReviewerAgentReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: WfReviewerAgentRunResult,
): void {
  sendChildAgentReportMessage({
    config: run.config,
    ctx,
    messageType: WF_REVIEWER_AGENT_MESSAGE_TYPE,
    pi,
    report: run.report,
    result: run.result,
  });
}

function formatStatus(): string {
  return [
    `Model: ${getModelSelector(currentConfig)}`,
    `Config: ${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}`,
    "Commands: /wf-revieweragent model [model] | config | ask <manual review task>. Workflow mode calls this agent automatically after each implementation attempt.",
  ].join("\n");
}

export default function wfReviewerAgentExtension(pi: ExtensionAPI): void {
  reloadWfReviewerAgentSettings(pi, process.cwd());

  pi.on("session_start", (_event, ctx) => {
    restoreState(pi, ctx);
    notifyConfigErrorIfNeeded(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreState(pi, ctx);
    notifyConfigErrorIfNeeded(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerMessageRenderer(WF_REVIEWER_AGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "wf-revieweragent" }),
  );

  pi.registerCommand("wf-revieweragent", {
    description: "Run the workflow-mode reviewer agent manually, inspect its config, or select its model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getWfReviewerAgentModelCompletions(modelPrefix);
      }

      if (trimmed.includes(" ") || hasTrailingSpace) return null;

      return ["model", "ask", "config", "status"]
        .filter((item) => item.startsWith(normalizedFirst))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [command = "status", ...rest] = trimmed.split(/\s+/u);
      const normalized = command.toLowerCase();

      if (!trimmed || normalized === "status") {
        reloadWfReviewerAgentSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadWfReviewerAgentSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `wf-revieweragent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatWfReviewerAgentModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectWfReviewerAgentModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const task = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!task) {
        ctx.ui.notify(
          "Usage: /wf-revieweragent model [model] | config | ask <manual review task>; or /wf-revieweragent <manual review task>",
          "warning",
        );
        return;
      }

      const config = readActiveWfReviewerAgentConfig(ctx.cwd);
      registerWfReviewerAgentProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(task)}`);

      try {
        const result = await runChildPiAgent({
          buildPrompt: buildWfReviewerAgentPrompt,
          config,
          defaultCwd: ctx.cwd,
          excludeTools: EXCLUDED_CHILD_TOOLS,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
          task,
        });
        const decision = parseWfReviewerAgentDecision(result.output);
        const parseError = decision ? undefined : "wf-revieweragent did not return parseable review JSON";
        const report = formatWfReviewerAgentReport({ config, decision, parseError, result });
        sendChildAgentReportMessage({ config, ctx, messageType: WF_REVIEWER_AGENT_MESSAGE_TYPE, pi, report, result });
        const level = result.status === "completed" && decision ? "info" : "warning";
        ctx.ui.notify(`wf-revieweragent ${result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`wf-revieweragent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
