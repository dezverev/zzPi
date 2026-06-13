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
} from "./lib/child-pi-agent.ts";
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
import type { WfImpplannerDecision, WfImpplannerStepPlan } from "./wf-impplanner.ts";

const CONFIG_FILE_PATH = ".pi/extensions/wf-implementeragent.config.jsonc";
const WF_IMPLEMENTER_AGENT_MESSAGE_TYPE = "wf-implementeragent-report";
const WF_IMPLEMENTER_AGENT_STATE_ENTRY_TYPE = "wf-implementeragent-state";
const STATUS_KEY = "wf-implementeragent";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "readsubagent", "explorationsubagent"];
const EXCLUDED_CHILD_TOOLS = [
  "localagent",
  "refagent",
  "prreview",
  "reviewsubagent",
  "gitopsagent",
  "simpletasksubagent",
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
  "wfimplemnteragent",
  "wf-implemnteragent",
  "wfrevieweragent",
  "wf-revieweragent",
  "wffinalreviewagent",
  "wf-finalreviewagent",
  "wftesteragent",
  "wf-testeragent",
] as const;

const DEFAULT_WF_IMPLEMENTER_AGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 400_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "gpt-5.5",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 32_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are wf-implementeragent, a workflow-mode implementation subagent for Pi. Consume exactly one wf-impplanner stage plan, modify the repository to implement only that stage, run targeted validation when practical, and return only the requested JSON decision. Do not advance to later plan stages. If reviewer feedback is supplied, address that feedback in the same stage scope before returning JSON.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

type WfImplementerAgentModelOption = ChildAgentModelOption;

interface WfImplementerAgentState {
  readonly selectedModelId?: string;
}

interface WfImplementerAgentSavedState {
  readonly selectedModelId?: string;
}

export type WfImplementerAgentDecision =
  | {
      readonly kind: "implemented_stage";
      readonly changedFiles: readonly string[];
      readonly notes?: readonly string[];
      readonly stageTitle: string;
      readonly summary: string;
      readonly testsRun: readonly string[];
      readonly validation: readonly string[];
    }
  | {
      readonly kind: "questions";
      readonly questions: readonly string[];
      readonly summary?: string;
    }
  | {
      readonly kind: "blocked";
      readonly changedFiles: readonly string[];
      readonly reason: string;
      readonly stageTitle: string;
      readonly summary?: string;
      readonly testsRun: readonly string[];
    };

export interface WfImplementerAgentRunResult {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfImplementerAgentDecision;
  readonly parseError?: string;
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_WF_IMPLEMENTER_AGENT_CONFIG };
let currentModelOptions: readonly WfImplementerAgentModelOption[] = [
  createChildAgentModelOptionFromConfig(DEFAULT_WF_IMPLEMENTER_AGENT_CONFIG),
];
let lastConfigError: string | undefined;
let selectedWfImplementerAgentModelId: string | undefined;

function readWfImplementerAgentModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly WfImplementerAgentModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "wf-implementeragent",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getWfImplementerAgentModelOption(id: string | undefined): WfImplementerAgentModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findWfImplementerAgentModelOption(input: string): WfImplementerAgentModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getWfImplementerAgentModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableWfImplementerAgentModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatWfImplementerAgentModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedWfImplementerAgentModelId,
  });
}

function applyWfImplementerAgentModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(config, getWfImplementerAgentModelOption(selectedWfImplementerAgentModelId));
}

function readWfImplementerAgentConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "wf-implementeragent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_WF_IMPLEMENTER_AGENT_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readActiveWfImplementerAgentConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readWfImplementerAgentConfig(cwd);
  currentModelOptions = readWfImplementerAgentModelOptions(cwd, baseConfig);
  return applyWfImplementerAgentModelSelection(baseConfig);
}

function reloadWfImplementerAgentSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveWfImplementerAgentConfig(cwd);
  registerWfImplementerAgentProvider(pi, currentConfig);
}

function registerWfImplementerAgentProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (wf-implementeragent)",
    providerDisplayName: "Workflow Implementer Agent",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) ctx.ui.notify(`wf-implementeragent config ignored: ${lastConfigError}`, "warning");
}

function getSavedStateFromBranch(ctx: ExtensionContext): WfImplementerAgentSavedState {
  let saved: WfImplementerAgentSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== WF_IMPLEMENTER_AGENT_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getWfImplementerAgentModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readWfImplementerAgentConfig(ctx.cwd);
  currentModelOptions = readWfImplementerAgentModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedWfImplementerAgentModelId = saved.selectedModelId;
  currentConfig = applyWfImplementerAgentModelSelection(baseConfig);
  registerWfImplementerAgentProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<WfImplementerAgentState>(WF_IMPLEMENTER_AGENT_STATE_ENTRY_TYPE, {
    ...(selectedWfImplementerAgentModelId ? { selectedModelId: selectedWfImplementerAgentModelId } : {}),
  });
}

async function selectWfImplementerAgentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  reloadWfImplementerAgentSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findWfImplementerAgentModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown wf-implementeragent model "${requested}". Available: ${formatAvailableWfImplementerAgentModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /wf-implementeragent model <model>. Available: ${formatAvailableWfImplementerAgentModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select wf-implementeragent model", choices);
    if (!choice) {
      ctx.ui.notify("wf-implementeragent model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No wf-implementeragent models are available", "warning");
    return;
  }

  selectedWfImplementerAgentModelId = option.id;
  persistState(pi);
  reloadWfImplementerAgentSettings(pi, ctx.cwd);
  ctx.ui.notify(
    `wf-implementeragent model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
    "info",
  );
}

function buildWfImplementerAgentTask(options: {
  readonly attempt: number;
  readonly implementationPlan: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly implementationPlanArtifactPath?: string | undefined;
  readonly reviewerFeedback?: string | undefined;
  readonly stepIndex: number;
  readonly stepPlan: WfImpplannerStepPlan;
  readonly totalSteps: number;
}): string {
  return [
    `Implementation stage: ${options.stepIndex + 1} of ${options.totalSteps}`,
    `Attempt: ${options.attempt}`,
    "",
    "Implementation plan artifact path, if available:",
    options.implementationPlanArtifactPath?.trim() || "- not supplied; use the JSON plan below",
    "",
    "Full reviewed implementation plan JSON:",
    JSON.stringify(options.implementationPlan, null, 2),
    "",
    "Single stage plan JSON to implement now:",
    JSON.stringify(options.stepPlan, null, 2),
    "",
    "Reviewer feedback to address in this attempt:",
    options.reviewerFeedback?.trim() || "- none; this is the first implementation attempt for this stage",
    "",
    "Implementation objective:",
    "- Modify the repository to implement only this single stage plan.",
    "- Respect dependencies/checkpoints and do not implement later stages unless the current stage explicitly requires a tiny enabling change.",
    "- Prefer a TDD flow when practical: add or update focused tests first, implement, then run the most relevant checks.",
    "- Keep changes minimal, maintainable, and aligned with existing project conventions.",
    "- If validation cannot be run, explain why in testsRun or validation.",
    "- When finished, return JSON only using the requested schema.",
  ].join("\n");
}

function buildWfImplementerAgentPrompt(task: string): string {
  return [
    "You are running as wf-implementeragent, the implementation worker in Pi workflow mode.",
    "You receive a reviewed wf-impplanner artifact and exactly one stage from that plan.",
    "Use the repository tools to implement that single stage. You may read files, edit/write files, and run shell commands/tests.",
    "Do not call other wf-* agents. Do not perform code review; a separate wf-revieweragent will review your work.",
    "Do not advance to later stages of the plan. If a later-stage item looks tempting, leave it for the later workflow stage.",
    "Return JSON only. Do not wrap it in markdown. Use one of these shapes:",
    `{"kind":"implemented_stage","stageTitle":"stage title","summary":"what changed","changedFiles":["repo/path"],"testsRun":["command or check and result"],"validation":["observable validation"],"notes":["optional note"]}`,
    `{"kind":"questions","summary":"why implementation is blocked on user input","questions":["question 1"]}`,
    `{"kind":"blocked","stageTitle":"stage title","summary":"short blocker summary","reason":"why the stage cannot be safely implemented","changedFiles":["repo/path"],"testsRun":["command or check and result"]}`,
    `Delegated wf-implementeragent task:\n${task}`,
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

export function parseWfImplementerAgentDecision(text: string): WfImplementerAgentDecision | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;
  const kind = (getOptionalString(parsed, "kind") ?? getOptionalString(parsed, "type") ?? "implemented_stage").toLowerCase();
  const summary = getOptionalString(parsed, "summary");

  if (kind === "questions" || kind === "question") {
    const questions = getStringArray(parsed.questions);
    return questions.length > 0 ? { kind: "questions", questions, ...(summary ? { summary } : {}) } : undefined;
  }

  if (kind === "blocked" || kind === "blocker") {
    const reason = getOptionalString(parsed, "reason") ?? getOptionalString(parsed, "detail") ?? summary;
    if (!reason) return undefined;
    return {
      changedFiles: getStringArray(parsed.changedFiles ?? parsed.changed_files ?? parsed.files),
      kind: "blocked",
      reason,
      stageTitle: getOptionalString(parsed, "stageTitle") ?? getOptionalString(parsed, "stage_title") ?? "Implementation stage",
      ...(summary ? { summary } : {}),
      testsRun: getStringArray(parsed.testsRun ?? parsed.tests_run ?? parsed.tests),
    };
  }

  if (
    kind &&
    kind !== "implemented_stage" &&
    kind !== "implemented" &&
    kind !== "complete" &&
    kind !== "completed"
  ) {
    return undefined;
  }

  const stageTitle = getOptionalString(parsed, "stageTitle") ?? getOptionalString(parsed, "stage_title");
  const changedFiles = getStringArray(parsed.changedFiles ?? parsed.changed_files ?? parsed.files);
  const testsRun = getStringArray(parsed.testsRun ?? parsed.tests_run ?? parsed.tests);
  const validation = getStringArray(parsed.validation ?? parsed.checks);
  const effectiveSummary = summary ?? getOptionalString(parsed, "result") ?? "Implementation stage completed";

  if (!stageTitle && changedFiles.length === 0 && testsRun.length === 0 && validation.length === 0) return undefined;

  return {
    changedFiles,
    kind: "implemented_stage",
    notes: getStringArray(parsed.notes),
    stageTitle: stageTitle ?? "Implementation stage",
    summary: effectiveSummary,
    testsRun,
    validation,
  };
}

function pushList(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push(`## ${title}`, "");
  items.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
}

export function formatWfImplementerAgentReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfImplementerAgentDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Workflow implementer agent", ""];
  const { decision } = options;

  if (decision?.kind === "implemented_stage") {
    lines.push(`- Stage: ${decision.stageTitle}`);
    lines.push(`- Status: implemented`);
    lines.push(`- Summary: ${decision.summary}`, "");
    pushList(lines, "Changed files", decision.changedFiles);
    pushList(lines, "Tests run", decision.testsRun);
    pushList(lines, "Validation", decision.validation);
    pushList(lines, "Notes", decision.notes ?? []);
  } else if (decision?.kind === "questions") {
    if (decision.summary) lines.push(decision.summary, "");
    pushList(lines, "Questions", decision.questions);
  } else if (decision?.kind === "blocked") {
    lines.push(`- Stage: ${decision.stageTitle}`);
    lines.push(`- Status: blocked`);
    if (decision.summary) lines.push(`- Summary: ${decision.summary}`);
    lines.push(`- Reason: ${decision.reason}`, "");
    pushList(lines, "Changed files", decision.changedFiles);
    pushList(lines, "Tests run", decision.testsRun);
  } else {
    lines.push("## Raw implementer output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }

  lines.push("## Run info", "");
  lines.push(`- Status: ${options.result.status}`);
  lines.push(`- Model: ${options.result.model ?? getModelSelector(options.config)}`);
  lines.push(`- Tools: ${options.result.toolCalls.map((call) => call.name).join(", ") || "none"}`);
  if (options.result.errorMessage) lines.push(`- Error: ${options.result.errorMessage}`);

  return truncateText(lines.join("\n"), options.config.reportMaxChars);
}

export async function runWfImplementerAgentForStage(options: {
  readonly attempt: number;
  readonly ctx: ExtensionContext;
  readonly implementationPlan: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly implementationPlanArtifactPath?: string | undefined;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly reviewerFeedback?: string | undefined;
  readonly stepIndex: number;
  readonly stepPlan: WfImpplannerStepPlan;
  readonly totalSteps: number;
}): Promise<WfImplementerAgentRunResult> {
  const config = readActiveWfImplementerAgentConfig(options.ctx.cwd);
  registerWfImplementerAgentProvider(options.pi, config);

  const task = buildWfImplementerAgentTask(options);
  const result = await runChildPiAgent({
    buildPrompt: buildWfImplementerAgentPrompt,
    config,
    defaultCwd: options.ctx.cwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    task,
  });
  const decision = parseWfImplementerAgentDecision(result.output);
  const parseError = decision ? undefined : "wf-implementeragent did not return parseable implementation JSON";
  const report = formatWfImplementerAgentReport({ config, decision, parseError, result });

  return { config, decision, ...(parseError ? { parseError } : {}), report, result };
}

export function sendWfImplementerAgentReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: WfImplementerAgentRunResult,
): void {
  sendChildAgentReportMessage({
    config: run.config,
    ctx,
    messageType: WF_IMPLEMENTER_AGENT_MESSAGE_TYPE,
    pi,
    report: run.report,
    result: run.result,
  });
}

function formatStatus(): string {
  return [
    `Model: ${getModelSelector(currentConfig)}`,
    `Config: ${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}`,
    "Commands: /wf-implementeragent model [model] | config | ask <manual implementation task>. Workflow mode calls this agent automatically per plan stage.",
  ].join("\n");
}

function registerWfImplementerCommand(pi: ExtensionAPI, name: string): void {
  pi.registerCommand(name, {
    description: "Run the workflow-mode implementer agent manually, inspect its config, or select its model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getWfImplementerAgentModelCompletions(modelPrefix);
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
        reloadWfImplementerAgentSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadWfImplementerAgentSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `wf-implementeragent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatWfImplementerAgentModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectWfImplementerAgentModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const task = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!task) {
        ctx.ui.notify(`Usage: /${name} model [model] | config | ask <manual implementation task>; or /${name} <manual implementation task>`, "warning");
        return;
      }

      const config = readActiveWfImplementerAgentConfig(ctx.cwd);
      registerWfImplementerAgentProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(task)}`);

      try {
        const result = await runChildPiAgent({
          buildPrompt: buildWfImplementerAgentPrompt,
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
        const decision = parseWfImplementerAgentDecision(result.output);
        const parseError = decision ? undefined : "wf-implementeragent did not return parseable implementation JSON";
        const report = formatWfImplementerAgentReport({ config, decision, parseError, result });
        sendChildAgentReportMessage({ config, ctx, messageType: WF_IMPLEMENTER_AGENT_MESSAGE_TYPE, pi, report, result });
        const level = result.status === "completed" && decision ? "info" : "warning";
        ctx.ui.notify(`wf-implementeragent ${result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`wf-implementeragent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}

export default function wfImplementerAgentExtension(pi: ExtensionAPI): void {
  reloadWfImplementerAgentSettings(pi, process.cwd());

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

  pi.registerMessageRenderer(WF_IMPLEMENTER_AGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "wf-implementeragent" }),
  );

  registerWfImplementerCommand(pi, "wf-implementeragent");
  registerWfImplementerCommand(pi, "wf-implemnteragent");
}
