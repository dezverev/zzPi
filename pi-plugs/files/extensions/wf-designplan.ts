import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
import {
  runWfAdversarialReviewForStage,
  sendWfAdversarialReviewReportMessage,
  stringifyReviewedOutput,
} from "./wf-adversarialreview.ts";

const CONFIG_FILE_PATH = ".pi/extensions/wf-designplan.config.jsonc";
const WF_DESIGNPLAN_MESSAGE_TYPE = "wf-designplan-report";
const WF_DESIGNPLAN_STATE_ENTRY_TYPE = "wf-designplan-state";
const STATUS_KEY = "wf-designplan";
const DESIGNPLAN_ARTIFACT_PATH_PARTS = ["zzwf", "designplans"] as const;
const DESIGNPLAN_TOPIC_SLUG_MAX_LENGTH = 80;
const GENERIC_DESIGNPLAN_TOPICS = new Set([
  "design plan",
  "development design plan",
  "manual prompt",
  "selected option",
  "workflow design plan",
]);
const WF_DESIGNPLAN_STAGE_SCHEMA = [
  "Return a WfDesignPlanDecision JSON object using one of these shapes:",
  `{"kind":"design_plan","summary":"short synthesis","selectedOptionTitle":"selected option title","objective":"what the staged plan accomplishes","architecture":"design-level approach, boundaries, and sequencing rationale","steps":[{"title":"Stage/step title","details":"what this implementation stage accomplishes, why it is ordered here, and what should be true before moving on","touchpoints":["repo path/symbol/context"],"risks":["risk"],"validation":["validation idea"]}],"risks":["cross-cutting risk"],"unknowns":["open unknown"],"acceptanceCriteria":["observable success criterion"],"validation":["test/check/manual validation"],"questions":["optional question to carry forward"],"handoffPrompt":"optional concise prompt for the next workflow stage"}`,
  `{"kind":"questions","summary":"why design planning is blocked","questions":["question 1","question 2"]}`,
  "For reviewed final design-plan output, prefer kind=design_plan. Preserve the design-plan schema exactly; ensure steps are ordered, feasible, manageable implementation stages; do not return the adversarial-review envelope inside reviewedOutput.",
].join("\n");
const DEFAULT_TOOLS = ["readsubagent"];
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

const DEFAULT_WF_DESIGNPLAN_CONFIG: ChildPiAgentConfig = {
  contextWindow: 272_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 128_000,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 28_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are wf-designplan, a workflow-mode design planning subagent for Pi. Consume the selected brainstorm option and break the chosen idea/solution into smaller, manageable, implementable stages before implementation begins. Focus on sequencing, boundaries, dependencies, feasibility, validation, and handoff clarity rather than concrete code edits. Use readsubagent only for factual repo context, evidence, constraints, and uncertainty; do not ask it for implementation plans or solution proposals. Return only the requested JSON decision.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

type WfDesignPlanModelOption = ChildAgentModelOption;

interface WfDesignPlanState {
  readonly selectedModelId?: string;
}

interface WfDesignPlanSavedState {
  readonly selectedModelId?: string;
}

export interface WfDesignPlanSelectedOption {
  readonly approach: string;
  readonly cons: readonly string[];
  readonly nextSteps: readonly string[];
  readonly pros: readonly string[];
  readonly repoTouchpoints: readonly string[];
  readonly risks: readonly string[];
  readonly title: string;
  readonly unknowns: readonly string[];
}

export interface WfDesignPlanStep {
  readonly details: string;
  readonly risks: readonly string[];
  readonly title: string;
  readonly touchpoints: readonly string[];
  readonly validation: readonly string[];
}

export type WfDesignPlanDecision =
  | {
      readonly kind: "design_plan";
      readonly acceptanceCriteria: readonly string[];
      readonly architecture: string;
      readonly handoffPrompt?: string;
      readonly objective: string;
      readonly questions?: readonly string[];
      readonly risks: readonly string[];
      readonly selectedOptionTitle: string;
      readonly steps: readonly WfDesignPlanStep[];
      readonly summary?: string;
      readonly unknowns: readonly string[];
      readonly validation: readonly string[];
    }
  | {
      readonly kind: "questions";
      readonly questions: readonly string[];
      readonly summary?: string;
    };

type WfDesignPlanDesignDecision = Extract<WfDesignPlanDecision, { readonly kind: "design_plan" }>;

export interface WfDesignPlanRunResult {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfDesignPlanDecision;
  readonly parseError?: string;
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_WF_DESIGNPLAN_CONFIG };
let currentModelOptions: readonly WfDesignPlanModelOption[] = [
  createChildAgentModelOptionFromConfig(DEFAULT_WF_DESIGNPLAN_CONFIG),
];
let lastConfigError: string | undefined;
let selectedWfDesignPlanModelId: string | undefined;

function readWfDesignPlanModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly WfDesignPlanModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "wf-designplan",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getWfDesignPlanModelOption(id: string | undefined): WfDesignPlanModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findWfDesignPlanModelOption(input: string): WfDesignPlanModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getWfDesignPlanModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableWfDesignPlanModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatWfDesignPlanModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedWfDesignPlanModelId,
  });
}

function applyWfDesignPlanModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(config, getWfDesignPlanModelOption(selectedWfDesignPlanModelId));
}

function readWfDesignPlanConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "wf-designplan",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_WF_DESIGNPLAN_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readActiveWfDesignPlanConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readWfDesignPlanConfig(cwd);
  currentModelOptions = readWfDesignPlanModelOptions(cwd, baseConfig);
  return applyWfDesignPlanModelSelection(baseConfig);
}

function reloadWfDesignPlanSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveWfDesignPlanConfig(cwd);
  registerWfDesignPlanProvider(pi, currentConfig);
}

function registerWfDesignPlanProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (wf-designplan)",
    providerDisplayName: "Workflow Design Plan",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`wf-designplan config ignored: ${lastConfigError}`, "warning");
  }
}

function getSavedStateFromBranch(ctx: ExtensionContext): WfDesignPlanSavedState {
  let saved: WfDesignPlanSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== WF_DESIGNPLAN_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getWfDesignPlanModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readWfDesignPlanConfig(ctx.cwd);
  currentModelOptions = readWfDesignPlanModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedWfDesignPlanModelId = saved.selectedModelId;
  currentConfig = applyWfDesignPlanModelSelection(baseConfig);
  registerWfDesignPlanProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<WfDesignPlanState>(WF_DESIGNPLAN_STATE_ENTRY_TYPE, {
    ...(selectedWfDesignPlanModelId ? { selectedModelId: selectedWfDesignPlanModelId } : {}),
  });
}

export async function selectWfDesignPlanModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
  options?: { readonly quiet?: boolean },
): Promise<void> {
  reloadWfDesignPlanSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findWfDesignPlanModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown wf-designplan model "${requested}". Available: ${formatAvailableWfDesignPlanModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /wf-designplan model <model>. Available: ${formatAvailableWfDesignPlanModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select wf-designplan model", choices);
    if (!choice) {
      ctx.ui.notify("wf-designplan model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No wf-designplan models are available", "warning");
    return;
  }

  selectedWfDesignPlanModelId = option.id;
  persistState(pi);
  reloadWfDesignPlanSettings(pi, ctx.cwd);
  if (!options?.quiet) {
    ctx.ui.notify(
      `wf-designplan model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
      "info",
    );
  }
}

function buildWfDesignPlanTask(options: {
  readonly brainstormDecision?: unknown;
  readonly clarifiedPrompt: string;
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
  readonly selectedOption: WfDesignPlanSelectedOption;
}): string {
  const priorQuestions = options.priorQuestions?.length
    ? options.priorQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n")
    : "- none";
  const priorAnswers = options.priorAnswers?.trim() || "- none";

  return [
    "Clarified workflow prompt:",
    options.clarifiedPrompt,
    "",
    "Selected brainstorm option:",
    JSON.stringify(options.selectedOption, null, 2),
    "",
    "Reviewed brainstorm decision/context:",
    options.brainstormDecision ? JSON.stringify(options.brainstormDecision, null, 2) : "- none supplied",
    "",
    "Previous design-plan questions, if any:",
    priorQuestions,
    "",
    "User's answers to those questions, if any:",
    priorAnswers,
    "",
    "Design-plan objective:",
    "- Convert the selected brainstorm option into a staged development plan: smaller, manageable, implementable steps that a later implementation agent can execute in order.",
    "- Ground each stage in repo facts and the selected option's constraints, risks, unknowns, dependencies, and touchpoints.",
    "- This is still pre-implementation design. Do not write code, mutate files, or spell out low-level patch details.",
    "- If essential product/technical details are missing and would materially change the design, return concise questions instead of a plan.",
  ].join("\n");
}

function buildWfDesignPlanPrompt(task: string): string {
  return [
    "You are running as wf-designplan, a design planning subagent in Pi workflow mode.",
    "Your job is to turn one selected wf-brainstormer option into a staged development design plan that breaks the idea/solution into smaller, manageable, implementable steps for later workflow stages.",
    "Use the readsubagent tool for factual inspection of relevant architecture, conventions, similar code, configuration, constraints, files, symbols, and docs.",
    "When calling readsubagent, ask only for factual repo findings, evidence, relationships, constraints, and uncertainty. Do not ask it for implementation plans, solution proposals, recommendations, or edit strategies; wf-designplan owns the design synthesis.",
    "Do not write code, mutate files, or produce patches. Do produce a clear sequence of implementation-ready stages with repo touchpoints, dependencies, risks, and validation guidance.",
    "Return JSON only. Do not wrap it in markdown. Use exactly one of these shapes:",
    `{"kind":"design_plan","summary":"short synthesis","selectedOptionTitle":"selected option title","objective":"what the staged plan accomplishes","architecture":"design-level approach, boundaries, and sequencing rationale","steps":[{"title":"Stage/step title","details":"what this implementation stage accomplishes, why it is ordered here, and what should be true before moving on","touchpoints":["repo path/symbol/context"],"risks":["risk"],"validation":["validation idea"]}],"risks":["cross-cutting risk"],"unknowns":["open unknown"],"acceptanceCriteria":["observable success criterion"],"validation":["test/check/manual validation"],"questions":["optional question to carry forward"],"handoffPrompt":"optional concise prompt for the next workflow stage"}`,
    `{"kind":"questions","summary":"why design planning is blocked","questions":["question 1","question 2"]}`,
    "Design-plan rules: make touchpoints concrete, make steps ordered and independently understandable, keep steps design-level rather than code patches, call out dependencies between stages, include unknowns instead of inventing facts, and include validation/acceptance criteria useful to later implementation stages.",
    "Question rules: ask only questions whose answers would materially change the design plan; keep the list concise.",
    `Delegated wf-designplan task:\n${task}`,
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

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function getOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePlanSteps(value: unknown): WfDesignPlanStep[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): WfDesignPlanStep | undefined => {
      if (!isRecord(item)) return undefined;
      const details = getOptionalString(item, "details") ?? getOptionalString(item, "description") ?? "";
      if (!details) return undefined;

      return {
        details,
        risks: getStringArray(item.risks),
        title: getOptionalString(item, "title") ?? `Step ${index + 1}`,
        touchpoints: getStringArray(item.touchpoints ?? item.repoTouchpoints ?? item.files),
        validation: getStringArray(item.validation ?? item.tests),
      };
    })
    .filter((item): item is WfDesignPlanStep => Boolean(item));
}

export function parseWfDesignPlanDecision(text: string): WfDesignPlanDecision | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;

  const kindValue =
    typeof parsed.kind === "string"
      ? parsed.kind.toLowerCase()
      : typeof parsed.type === "string"
        ? parsed.type.toLowerCase()
        : "";
  const summary = getOptionalString(parsed, "summary");

  if (kindValue === "questions" || kindValue === "question") {
    const questions = getStringArray(parsed.questions);
    return questions.length > 0 ? { kind: "questions", questions, ...(summary ? { summary } : {}) } : undefined;
  }

  if (kindValue && kindValue !== "design_plan" && kindValue !== "designplan" && kindValue !== "plan") {
    return undefined;
  }

  const steps = normalizePlanSteps(parsed.steps ?? parsed.plan);
  const objective = getOptionalString(parsed, "objective") ?? summary ?? "Development design plan";
  const architecture = getOptionalString(parsed, "architecture") ?? getOptionalString(parsed, "approach") ?? "";
  if (!architecture && steps.length === 0) return undefined;

  const questions = getStringArray(parsed.questions);
  const handoffPrompt = getOptionalString(parsed, "handoffPrompt") ?? getOptionalString(parsed, "handoff_prompt");

  return {
    acceptanceCriteria: getStringArray(parsed.acceptanceCriteria ?? parsed.acceptance_criteria),
    architecture,
    ...(handoffPrompt ? { handoffPrompt } : {}),
    kind: "design_plan",
    objective,
    ...(questions.length > 0 ? { questions } : {}),
    risks: getStringArray(parsed.risks),
    selectedOptionTitle: getOptionalString(parsed, "selectedOptionTitle") ?? getOptionalString(parsed, "selected_option_title") ?? "Selected option",
    steps,
    ...(summary ? { summary } : {}),
    unknowns: getStringArray(parsed.unknowns),
    validation: getStringArray(parsed.validation ?? parsed.tests),
  };
}

function pushList(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push(`**${title}:**`);
  items.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
}

function formatWfDesignPlanDecisionMarkdown(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfDesignPlanDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Workflow design plan", ""];
  const { decision } = options;

  if (decision?.summary) {
    lines.push(decision.summary, "");
  }

  if (decision?.kind === "questions") {
    lines.push("## Questions for the user", "");
    decision.questions.forEach((question, index) => {
      lines.push(`${index + 1}. ${question}`);
    });
    lines.push("");
  } else if (decision?.kind === "design_plan") {
    lines.push("## Selected option", "", decision.selectedOptionTitle, "");
    lines.push("## Objective", "", decision.objective, "");
    if (decision.architecture) lines.push("## Design approach", "", decision.architecture, "");

    if (decision.steps.length > 0) {
      lines.push("## Implementation stages", "");
      decision.steps.forEach((step, index) => {
        lines.push(`### ${index + 1}. ${step.title}`, "", step.details, "");
        pushList(lines, "Touchpoints", step.touchpoints);
        pushList(lines, "Risks", step.risks);
        pushList(lines, "Validation", step.validation);
      });
    }

    pushList(lines, "Acceptance criteria", decision.acceptanceCriteria);
    pushList(lines, "Validation", decision.validation);
    pushList(lines, "Risks", decision.risks);
    pushList(lines, "Unknowns", decision.unknowns);
    pushList(lines, "Questions to carry forward", decision.questions ?? []);
    if (decision.handoffPrompt) {
      lines.push("## Handoff prompt", "", "```text", decision.handoffPrompt, "```", "");
    }
  } else {
    lines.push("## Raw design-plan output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }

  lines.push("## Run info", "");
  lines.push(`- Status: ${options.result.status}`);
  lines.push(`- Model: ${options.result.model ?? getModelSelector(options.config)}`);
  lines.push(`- Tools: ${options.result.toolCalls.map((call) => call.name).join(", ") || "none"}`);
  if (options.result.errorMessage) lines.push(`- Error: ${options.result.errorMessage}`);

  return lines.join("\n");
}

export function formatWfDesignPlanDecisionReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfDesignPlanDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  return truncateText(formatWfDesignPlanDecisionMarkdown(options), options.config.reportMaxChars);
}

export async function reviewWfDesignPlanRun(options: {
  readonly clarifiedPrompt: string;
  readonly ctx: ExtensionContext;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly run: WfDesignPlanRunResult;
  readonly selectedOption: WfDesignPlanSelectedOption;
}): Promise<WfDesignPlanRunResult> {
  if (options.run.decision?.kind !== "design_plan") return options.run;

  try {
    const review = await runWfAdversarialReviewForStage({
      ctx: options.ctx,
      expectedOutputSchema: WF_DESIGNPLAN_STAGE_SCHEMA,
      originalPrompt: options.clarifiedPrompt,
      pi: options.pi,
      stageContext: [
        "This is the final wf-designplan output. Review it before the design-plan report is displayed to the user or saved as a living design-plan document.",
        "The intended workflow is: wf-brainstormer identifies the idea/solution; wf-designplan breaks that idea into smaller, manageable, implementable stages; wf-adversarialreview checks whether those stages are feasible, ordered, sufficiently scoped, and supported by repo facts.",
        "Selected option:",
        JSON.stringify(options.selectedOption, null, 2),
      ].join("\n"),
      stageId: "wf-designplan",
      stageOutput: JSON.stringify(options.run.decision, null, 2),
      stageReport: options.run.report,
      onProgress: options.onProgress,
    });

    sendWfAdversarialReviewReportMessage(options.pi, options.ctx, review);

    if (!review.decision?.reviewedOutput || review.decision.verdict === "blocked") {
      options.ctx.ui.notify(
        "wf-designplan adversarial review did not provide usable reviewed output; showing original design-plan output.",
        "warning",
      );
      return options.run;
    }

    const reviewedDecision = parseWfDesignPlanDecision(stringifyReviewedOutput(review.decision.reviewedOutput));
    if (!reviewedDecision || reviewedDecision.kind !== "design_plan") {
      options.ctx.ui.notify(
        "wf-designplan adversarial review returned output that does not match the design-plan schema; showing original design-plan output.",
        "warning",
      );
      return options.run;
    }

    const reviewedRun: WfDesignPlanRunResult = {
      ...options.run,
      decision: reviewedDecision,
      report: formatWfDesignPlanDecisionReport({
        config: options.run.config,
        decision: reviewedDecision,
        result: options.run.result,
      }),
    };

    try {
      await persistWfDesignPlanDecision({
        clarifiedPrompt: options.clarifiedPrompt,
        config: reviewedRun.config,
        ctx: options.ctx,
        decision: reviewedDecision,
        result: reviewedRun.result,
        selectedOption: options.selectedOption,
      });
    } catch (error) {
      options.ctx.ui.notify(`wf-designplan could not save reviewed design plan: ${getErrorMessage(error)}`, "warning");
    }

    return reviewedRun;
  } catch (error) {
    options.ctx.ui.notify(
      `wf-designplan adversarial review failed: ${getErrorMessage(error)}. Showing original design-plan output.`,
      "warning",
    );
    return options.run;
  }
}

export async function runWfDesignPlanForOption(options: {
  readonly brainstormDecision?: unknown;
  readonly clarifiedPrompt: string;
  readonly ctx: ExtensionContext;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
  readonly selectedOption: WfDesignPlanSelectedOption;
}): Promise<WfDesignPlanRunResult> {
  const config = readActiveWfDesignPlanConfig(options.ctx.cwd);
  registerWfDesignPlanProvider(options.pi, config);

  const task = buildWfDesignPlanTask({
    brainstormDecision: options.brainstormDecision,
    clarifiedPrompt: options.clarifiedPrompt,
    priorAnswers: options.priorAnswers,
    priorQuestions: options.priorQuestions,
    selectedOption: options.selectedOption,
  });
  const result = await runChildPiAgent({
    buildPrompt: buildWfDesignPlanPrompt,
    config,
    defaultCwd: options.ctx.cwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    task,
  });
  const decision = parseWfDesignPlanDecision(result.output);
  const parseError = decision ? undefined : "wf-designplan did not return parseable decision JSON";
  const report = formatWfDesignPlanDecisionReport({ config, decision, parseError, result });

  if (result.status === "completed" && decision?.kind === "design_plan") {
    try {
      await persistWfDesignPlanDecision({
        clarifiedPrompt: options.clarifiedPrompt,
        config,
        ctx: options.ctx,
        decision,
        result,
        selectedOption: options.selectedOption,
      });
    } catch (error) {
      options.ctx.ui.notify(`wf-designplan could not save design plan: ${getErrorMessage(error)}`, "warning");
    }
  }

  return { config, decision, ...(parseError ? { parseError } : {}), report, result };
}

export function sendWfDesignPlanReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: WfDesignPlanRunResult,
): void {
  sendChildAgentReportMessage({
    config: run.config,
    ctx,
    messageType: WF_DESIGNPLAN_MESSAGE_TYPE,
    pi,
    report: run.report,
    result: run.result,
  });
}

function getLocalDateStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isGenericDesignPlanTopic(topic: string): boolean {
  return GENERIC_DESIGNPLAN_TOPICS.has(topic.trim().toLowerCase());
}

function getDesignPlanTopic(options: {
  readonly clarifiedPrompt: string;
  readonly decision: WfDesignPlanDesignDecision;
  readonly selectedOption: WfDesignPlanSelectedOption;
}): string {
  const candidates = [
    options.decision.selectedOptionTitle,
    options.selectedOption.title,
    options.clarifiedPrompt,
    options.selectedOption.approach,
    options.decision.objective,
    options.decision.summary,
  ];

  for (const candidate of candidates) {
    const topic = candidate?.trim();
    if (!topic || isGenericDesignPlanTopic(topic)) continue;
    return topic;
  }

  return "design plan";
}

function slugifyDesignPlanTopic(topic: string): string {
  const slug = topic
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, DESIGNPLAN_TOPIC_SLUG_MAX_LENGTH)
    .replace(/-+$/u, "");

  return slug || "design-plan";
}

async function persistWfDesignPlanDecision(options: {
  readonly clarifiedPrompt: string;
  readonly config: ChildPiAgentConfig;
  readonly ctx: ExtensionContext;
  readonly decision: WfDesignPlanDesignDecision;
  readonly result: ChildAgentRunResult;
  readonly selectedOption: WfDesignPlanSelectedOption;
}): Promise<void> {
  const directory = join(options.ctx.cwd, ...DESIGNPLAN_ARTIFACT_PATH_PARTS);
  const topic = getDesignPlanTopic(options);
  const filename = `${getLocalDateStamp()}-${slugifyDesignPlanTopic(topic)}.md`;
  const documentPath = join(directory, filename);
  const document = formatWfDesignPlanDecisionMarkdown({
    config: options.config,
    decision: options.decision,
    result: options.result,
  });

  await mkdir(directory, { recursive: true });
  await writeFile(documentPath, `${document.trimEnd()}\n`, "utf8");
}

function formatStatus(): string {
  return [
    formatWfDesignPlanModelSelection(currentConfig),
    "Commands: /wf-designplan model [model] | config | ask <prompt>. You can also run /wf-designplan <prompt> directly.",
  ].join("\n");
}

function createManualSelectedOption(prompt: string): WfDesignPlanSelectedOption {
  return {
    approach: prompt,
    cons: [],
    nextSteps: [],
    pros: [],
    repoTouchpoints: [],
    risks: [],
    title: "Manual prompt",
    unknowns: [],
  };
}

export default function wfDesignPlanExtension(pi: ExtensionAPI): void {
  reloadWfDesignPlanSettings(pi, process.cwd());

  pi.on("session_start", (_event, ctx) => {
    restoreState(pi, ctx);
    notifyConfigErrorIfNeeded(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreState(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerMessageRenderer(WF_DESIGNPLAN_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "wf-designplan" }),
  );

  pi.registerCommand("wf-designplan", {
    description: "Run the workflow-mode design-plan subagent or select its model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getWfDesignPlanModelCompletions(modelPrefix);
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
        reloadWfDesignPlanSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadWfDesignPlanSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `wf-designplan config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatWfDesignPlanModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectWfDesignPlanModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const prompt = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!prompt) {
        ctx.ui.notify(
          "Usage: /wf-designplan model [model] | config | ask <prompt>; or /wf-designplan <prompt>",
          "warning",
        );
        return;
      }

      const config = readActiveWfDesignPlanConfig(ctx.cwd);
      registerWfDesignPlanProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(prompt)}`);

      try {
        const selectedOption = createManualSelectedOption(prompt);
        const run = await runWfDesignPlanForOption({
          clarifiedPrompt: prompt,
          ctx,
          pi,
          selectedOption,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        if (run.decision?.kind === "design_plan") {
          ctx.ui.setStatus(STATUS_KEY, `reviewing ${model}: ${previewTask(prompt)}`);
        }
        const reviewedRun = await reviewWfDesignPlanRun({
          clarifiedPrompt: prompt,
          ctx,
          pi,
          run,
          selectedOption,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `reviewing ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        sendWfDesignPlanReportMessage(pi, ctx, reviewedRun);
        const level = reviewedRun.result.status === "completed" && reviewedRun.decision ? "info" : "warning";
        const reportDescription = run.decision?.kind === "design_plan" ? "reviewed report" : "report";
        ctx.ui.notify(`wf-designplan ${reviewedRun.result.status}; ${reportDescription} added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`wf-designplan failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
