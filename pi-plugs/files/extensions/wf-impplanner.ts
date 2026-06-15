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
import type {
  WfDesignPlanDecision,
  WfDesignPlanSelectedOption,
  WfDesignPlanStep,
} from "./wf-designplan.ts";

const CONFIG_FILE_PATH = ".pi/extensions/wf-impplanner.config.jsonc";
const WF_IMPPLANNER_MESSAGE_TYPE = "wf-impplanner-report";
const WF_IMPPLANNER_STATE_ENTRY_TYPE = "wf-impplanner-state";
const STATUS_KEY = "wf-impplanner";
const TEMP_ARTIFACT_PATH_PARTS = [".zzwf", "tmp"] as const;
const IMPLEMENTATION_PLAN_ARTIFACT_PATH_PARTS = ["zzwf", "implementationplans"] as const;
const TOPIC_SLUG_MAX_LENGTH = 80;
const DEFAULT_TOOLS = ["readsubagent", "explorationsubagent"];
const EXCLUDED_CHILD_TOOLS = [
  "reviewsubagent",
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

const WF_IMPPLANNER_STEP_SCHEMA = [
  "Return a WfImpplannerStepDecision JSON object using one of these shapes:",
  `{"kind":"step_plan","summary":"short synthesis","plan":{"title":"implementation step title","sourceDesignStepTitle":"source design-plan step title","objective":"what this individual implementation step accomplishes","dependencies":["dependency/checkpoint before starting"],"instructions":["detailed execution instruction"],"highPriorityTests":["test to write or run, preferably TDD when possible"],"checkpoints":["checkpoint before continuing"],"touchpoints":["repo path/symbol/context"],"examples":["code or pseudocode example when useful"],"risks":["risk"],"validation":["validation command/check"]},"questions":["optional question to carry forward"]}`,
  `{"kind":"questions","summary":"why this implementation step is blocked","questions":["question 1","question 2"]}`,
  "For reviewed final step output, prefer kind=step_plan. Preserve the step-plan schema exactly; ensure instructions are feasible, test-aware, checkpointed, and scoped to the single source design step. Do not return the adversarial-review envelope inside reviewedOutput.",
].join("\n");
const WF_IMPPLANNER_FINAL_SCHEMA = [
  "Return a WfImpplannerDecision JSON object using one of these shapes:",
  `{"kind":"implementation_plan","summary":"short synthesis","designPlanTitle":"source design-plan title","objective":"what the concrete implementation plan accomplishes","approach":"overall execution strategy and sequencing","stepPlans":[{"title":"implementation step title","sourceDesignStepTitle":"source design-plan step title","objective":"what this step accomplishes","dependencies":["dependency/checkpoint before starting"],"instructions":["detailed execution instruction"],"highPriorityTests":["test to write or run, preferably TDD when possible"],"checkpoints":["checkpoint before continuing"],"touchpoints":["repo path/symbol/context"],"examples":["code or pseudocode example when useful"],"risks":["risk"],"validation":["validation command/check"]}],"highPriorityTests":["cross-step high-priority test"],"checkpoints":["cross-step checkpoint"],"risks":["cross-cutting risk"],"unknowns":["open unknown"],"validation":["final validation"],"handoffPrompt":"optional concise prompt for the execution stage"}`,
  `{"kind":"questions","summary":"why implementation planning is blocked","questions":["question 1","question 2"]}`,
  "For reviewed final implementation-plan output, prefer kind=implementation_plan. Preserve the schema exactly; ensure the merged plan is concrete, sequenced, test-driven when possible, checkpointed, and feasible. Do not return the adversarial-review envelope inside reviewedOutput.",
].join("\n");

const DEFAULT_WF_IMPPLANNER_CONFIG: ChildPiAgentConfig = {
  contextWindow: 400_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "gpt-5.5",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 32_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are wf-impplanner, a workflow-mode implementation planning subagent for Pi. Consume a reviewed wf-designplan output whose steps are already broken into manageable stages. For each design-plan step, create a concrete individual execution plan with detailed instructions, TDD-first guidance when possible, high-priority tests, checkpoints, touchpoints, risks, validation, and code or pseudocode examples when useful. Do not mutate files. Return only the requested JSON decision.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

type WfImpplannerModelOption = ChildAgentModelOption;
export type WfImpplannerDesignPlan = Extract<WfDesignPlanDecision, { readonly kind: "design_plan" }>;

export type WfImpplannerStepDecision =
  | {
      readonly kind: "step_plan";
      readonly plan: WfImpplannerStepPlan;
      readonly questions?: readonly string[];
      readonly summary?: string;
    }
  | {
      readonly kind: "questions";
      readonly questions: readonly string[];
      readonly summary?: string;
    };

export interface WfImpplannerStepPlan {
  readonly checkpoints: readonly string[];
  readonly dependencies: readonly string[];
  readonly examples: readonly string[];
  readonly highPriorityTests: readonly string[];
  readonly instructions: readonly string[];
  readonly objective: string;
  readonly risks: readonly string[];
  readonly sourceDesignStepTitle: string;
  readonly title: string;
  readonly touchpoints: readonly string[];
  readonly validation: readonly string[];
}

export type WfImpplannerDecision =
  | {
      readonly kind: "implementation_plan";
      readonly approach: string;
      readonly checkpoints: readonly string[];
      readonly designPlanTitle: string;
      readonly handoffPrompt?: string;
      readonly highPriorityTests: readonly string[];
      readonly objective: string;
      readonly risks: readonly string[];
      readonly stepPlans: readonly WfImpplannerStepPlan[];
      readonly summary?: string;
      readonly unknowns: readonly string[];
      readonly validation: readonly string[];
    }
  | {
      readonly kind: "questions";
      readonly questions: readonly string[];
      readonly summary?: string;
    };

type WfImpplannerImplementationDecision = Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;

export interface WfImpplannerStepRunResult {
  readonly decision?: WfImpplannerStepDecision;
  readonly parseError?: string;
  readonly report: string;
  readonly result: ChildAgentRunResult;
  readonly stepIndex: number;
  readonly tempPath?: string;
}

export interface WfImpplannerRunResult {
  readonly artifactPath?: string;
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfImpplannerDecision;
  readonly parseError?: string;
  readonly report: string;
  readonly result: ChildAgentRunResult;
  readonly stepRuns: readonly WfImpplannerStepRunResult[];
}

interface WfImpplannerState {
  readonly selectedModelId?: string;
}

interface WfImpplannerSavedState {
  readonly selectedModelId?: string;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_WF_IMPPLANNER_CONFIG };
let currentModelOptions: readonly WfImpplannerModelOption[] = [
  createChildAgentModelOptionFromConfig(DEFAULT_WF_IMPPLANNER_CONFIG),
];
let lastConfigError: string | undefined;
let selectedWfImpplannerModelId: string | undefined;

function readWfImpplannerModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly WfImpplannerModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "wf-impplanner",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getWfImpplannerModelOption(id: string | undefined): WfImpplannerModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findWfImpplannerModelOption(input: string): WfImpplannerModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getWfImpplannerModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableWfImpplannerModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatWfImpplannerModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedWfImpplannerModelId,
  });
}

function applyWfImpplannerModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(config, getWfImpplannerModelOption(selectedWfImpplannerModelId));
}

function readWfImpplannerConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "wf-impplanner",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_WF_IMPPLANNER_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readActiveWfImpplannerConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readWfImpplannerConfig(cwd);
  currentModelOptions = readWfImpplannerModelOptions(cwd, baseConfig);
  return applyWfImpplannerModelSelection(baseConfig);
}

function reloadWfImpplannerSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveWfImpplannerConfig(cwd);
  registerWfImpplannerProvider(pi, currentConfig);
}

function registerWfImpplannerProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (wf-impplanner)",
    providerDisplayName: "Workflow Implementation Planner",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`wf-impplanner config ignored: ${lastConfigError}`, "warning");
  }
}

function getSavedStateFromBranch(ctx: ExtensionContext): WfImpplannerSavedState {
  let saved: WfImpplannerSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== WF_IMPPLANNER_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getWfImpplannerModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readWfImpplannerConfig(ctx.cwd);
  currentModelOptions = readWfImpplannerModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedWfImpplannerModelId = saved.selectedModelId;
  currentConfig = applyWfImpplannerModelSelection(baseConfig);
  registerWfImpplannerProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<WfImpplannerState>(WF_IMPPLANNER_STATE_ENTRY_TYPE, {
    ...(selectedWfImpplannerModelId ? { selectedModelId: selectedWfImpplannerModelId } : {}),
  });
}

async function selectWfImpplannerModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  reloadWfImpplannerSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findWfImpplannerModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown wf-impplanner model "${requested}". Available: ${formatAvailableWfImpplannerModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /wf-impplanner model <model>. Available: ${formatAvailableWfImpplannerModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select wf-impplanner model", choices);
    if (!choice) {
      ctx.ui.notify("wf-impplanner model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No wf-impplanner models are available", "warning");
    return;
  }

  selectedWfImpplannerModelId = option.id;
  persistState(pi);
  reloadWfImpplannerSettings(pi, ctx.cwd);
  ctx.ui.notify(
    `wf-impplanner model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
    "info",
  );
}

function formatQuestionList(questions: readonly string[]): string {
  return questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
}

function buildStepPlanTask(options: {
  readonly designPlan: WfImpplannerDesignPlan;
  readonly previousStepPlans: readonly WfImpplannerStepPlan[];
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
  readonly step: WfDesignPlanStep;
  readonly stepIndex: number;
}): string {
  const priorQuestions = options.priorQuestions?.length ? formatQuestionList(options.priorQuestions) : "- none";
  const priorAnswers = options.priorAnswers?.trim() || "- none";
  const previousPlans = options.previousStepPlans.length
    ? JSON.stringify(options.previousStepPlans, null, 2)
    : "- none; this is the first step";

  return [
    "Reviewed design plan:",
    JSON.stringify(options.designPlan, null, 2),
    "",
    `Current design-plan step ${options.stepIndex + 1} of ${options.designPlan.steps.length}:`,
    JSON.stringify(options.step, null, 2),
    "",
    "Previously reviewed individual implementation plans:",
    previousPlans,
    "",
    "Previous implementation-planning questions, if any:",
    priorQuestions,
    "",
    "User's answers to those questions, if any:",
    priorAnswers,
    "",
    "Implementation-planning objective:",
    "- Create one detailed, concrete execution plan for this single design-plan step only.",
    "- Prefer Test Driven Development when possible: identify tests to write first, then the implementation moves those tests drive.",
    "- Include checkpoints where the implementer should stop, test, and confirm the base is solid before continuing.",
    "- Include code or pseudocode examples when they materially clarify the execution approach.",
    "- Keep the plan actionable for a later implementation agent, but do not mutate files or produce patches now.",
    "- If essential details are missing and would materially change this step plan, return concise questions instead of a plan.",
  ].join("\n");
}

function buildStepPlanPrompt(task: string): string {
  return [
    "You are running as wf-impplanner, an implementation planning subagent in Pi workflow mode.",
    "Your job is to turn one reviewed wf-designplan stage into an individual concrete execution plan for a later implementation agent.",
    "Prefer Test Driven Development when possible: tests should appear before or alongside implementation instructions, and high-priority tests should be explicit.",
    "Find checkpoints where the implementer should pause to run tests, verify behavior, and establish a solid base before moving forward.",
    "Use readsubagent or explorationsubagent only for factual repo context, evidence, constraints, and uncertainty. Do not ask those tools for implementation plans or solution proposals; wf-impplanner owns the execution-plan synthesis.",
    "Do not write code, mutate files, or produce patches. Code or pseudocode examples are allowed only as illustrative guidance inside the plan.",
    "Return JSON only. Do not wrap it in markdown. Use exactly one of these shapes:",
    `{"kind":"step_plan","summary":"short synthesis","plan":{"title":"implementation step title","sourceDesignStepTitle":"source design-plan step title","objective":"what this individual implementation step accomplishes","dependencies":["dependency/checkpoint before starting"],"instructions":["detailed execution instruction"],"highPriorityTests":["test to write or run, preferably TDD when possible"],"checkpoints":["checkpoint before continuing"],"touchpoints":["repo path/symbol/context"],"examples":["code or pseudocode example when useful"],"risks":["risk"],"validation":["validation command/check"]},"questions":["optional question to carry forward"]}`,
    `{"kind":"questions","summary":"why implementation planning is blocked","questions":["question 1","question 2"]}`,
    "Step-plan rules: keep scope to the single design-plan step, make instructions concrete and ordered, include TDD/high-priority tests when possible, include checkpoints, include touchpoints and validation, and call out dependencies on previous steps.",
    `Delegated wf-impplanner step task:\n${task}`,
  ].join("\n\n");
}

function buildFinalPlanTask(options: {
  readonly designPlan: WfImpplannerDesignPlan;
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
  readonly stepPlans: readonly WfImpplannerStepPlan[];
}): string {
  const priorQuestions = options.priorQuestions?.length ? formatQuestionList(options.priorQuestions) : "- none";
  const priorAnswers = options.priorAnswers?.trim() || "- none";

  return [
    "Reviewed design plan:",
    JSON.stringify(options.designPlan, null, 2),
    "",
    "Reviewed individual implementation step plans:",
    JSON.stringify(options.stepPlans, null, 2),
    "",
    "Previous implementation-planning questions, if any:",
    priorQuestions,
    "",
    "User's answers to those questions, if any:",
    priorAnswers,
    "",
    "Final merge objective:",
    "- Merge the reviewed individual step plans into one concrete implementation plan.",
    "- Preserve the individual plans' ordering, tests, checkpoints, dependencies, risks, and validation guidance.",
    "- Prefer TDD where practical and identify cross-step high-priority tests.",
    "- Add code or pseudocode examples only when they clarify execution.",
    "- Keep the plan executable by a later implementation agent, but do not mutate files or produce patches now.",
  ].join("\n");
}

function buildFinalPlanPrompt(task: string): string {
  return [
    "You are running as wf-impplanner, an implementation planning subagent in Pi workflow mode.",
    "Your job is to merge individually reviewed implementation step plans into one concrete execution plan for a later implementation agent.",
    "Prefer Test Driven Development when possible, make high-priority tests explicit, and include checkpoints where the implementer should stop and verify a solid base.",
    "Do not write code, mutate files, or produce patches. Code or pseudocode examples are allowed only as illustrative guidance inside the plan.",
    "Return JSON only. Do not wrap it in markdown. Use exactly one of these shapes:",
    `{"kind":"implementation_plan","summary":"short synthesis","designPlanTitle":"source design-plan title","objective":"what the concrete implementation plan accomplishes","approach":"overall execution strategy and sequencing","stepPlans":[{"title":"implementation step title","sourceDesignStepTitle":"source design-plan step title","objective":"what this step accomplishes","dependencies":["dependency/checkpoint before starting"],"instructions":["detailed execution instruction"],"highPriorityTests":["test to write or run, preferably TDD when possible"],"checkpoints":["checkpoint before continuing"],"touchpoints":["repo path/symbol/context"],"examples":["code or pseudocode example when useful"],"risks":["risk"],"validation":["validation command/check"]}],"highPriorityTests":["cross-step high-priority test"],"checkpoints":["cross-step checkpoint"],"risks":["cross-cutting risk"],"unknowns":["open unknown"],"validation":["final validation"],"handoffPrompt":"optional concise prompt for the execution stage"}`,
    `{"kind":"questions","summary":"why implementation planning is blocked","questions":["question 1","question 2"]}`,
    "Final-plan rules: preserve all implementation stages, keep instructions concrete and ordered, avoid unsupported repo claims, make TDD/test checkpoints explicit, and include enough detail for execution without inventing facts.",
    `Delegated wf-impplanner final merge task:\n${task}`,
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

function normalizeStepPlan(value: unknown, fallback: { readonly sourceTitle: string; readonly title: string }): WfImpplannerStepPlan | undefined {
  if (!isRecord(value)) return undefined;
  const objective = getOptionalString(value, "objective") ?? getOptionalString(value, "details") ?? "";
  const instructions = getStringArray(value.instructions ?? value.steps ?? value.actions);
  if (!objective && instructions.length === 0) return undefined;

  return {
    checkpoints: getStringArray(value.checkpoints ?? value.gates),
    dependencies: getStringArray(value.dependencies ?? value.prerequisites),
    examples: getStringArray(value.examples ?? value.codeExamples ?? value.pseudocode),
    highPriorityTests: getStringArray(value.highPriorityTests ?? value.high_priority_tests ?? value.tests),
    instructions,
    objective: objective || "Implementation step",
    risks: getStringArray(value.risks),
    sourceDesignStepTitle:
      getOptionalString(value, "sourceDesignStepTitle") ?? getOptionalString(value, "source_design_step_title") ?? fallback.sourceTitle,
    title: getOptionalString(value, "title") ?? fallback.title,
    touchpoints: getStringArray(value.touchpoints ?? value.repoTouchpoints ?? value.files),
    validation: getStringArray(value.validation ?? value.finalChecks),
  };
}

function normalizeStepPlans(value: unknown): WfImpplannerStepPlan[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) =>
      normalizeStepPlan(item, {
        sourceTitle: `Design step ${index + 1}`,
        title: `Implementation step ${index + 1}`,
      }),
    )
    .filter((item): item is WfImpplannerStepPlan => Boolean(item));
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }

  return isRecord(parsed) ? parsed : undefined;
}

function parseWfImpplannerStepDecision(
  text: string,
  fallback: { readonly sourceTitle: string; readonly title: string },
): WfImpplannerStepDecision | undefined {
  const parsed = parseJsonObject(text);
  if (!parsed) return undefined;

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

  if (kindValue && kindValue !== "step_plan" && kindValue !== "stepplan" && kindValue !== "plan") return undefined;

  const plan = normalizeStepPlan(parsed.plan ?? parsed, fallback);
  if (!plan) return undefined;
  const questions = getStringArray(parsed.questions);
  return {
    kind: "step_plan",
    plan,
    ...(questions.length > 0 ? { questions } : {}),
    ...(summary ? { summary } : {}),
  };
}

export function parseWfImpplannerDecision(text: string): WfImpplannerDecision | undefined {
  const parsed = parseJsonObject(text);
  if (!parsed) return undefined;

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

  if (kindValue && kindValue !== "implementation_plan" && kindValue !== "implementationplan" && kindValue !== "plan") {
    return undefined;
  }

  const stepPlans = normalizeStepPlans(parsed.stepPlans ?? parsed.step_plans ?? parsed.steps ?? parsed.plans);
  const objective = getOptionalString(parsed, "objective") ?? summary ?? "Concrete implementation plan";
  const approach = getOptionalString(parsed, "approach") ?? getOptionalString(parsed, "strategy") ?? "";
  if (!approach && stepPlans.length === 0) return undefined;

  const handoffPrompt = getOptionalString(parsed, "handoffPrompt") ?? getOptionalString(parsed, "handoff_prompt");
  return {
    approach,
    checkpoints: getStringArray(parsed.checkpoints),
    designPlanTitle: getOptionalString(parsed, "designPlanTitle") ?? getOptionalString(parsed, "design_plan_title") ?? "Implementation plan",
    ...(handoffPrompt ? { handoffPrompt } : {}),
    highPriorityTests: getStringArray(parsed.highPriorityTests ?? parsed.high_priority_tests ?? parsed.tests),
    kind: "implementation_plan",
    objective,
    risks: getStringArray(parsed.risks),
    stepPlans,
    ...(summary ? { summary } : {}),
    unknowns: getStringArray(parsed.unknowns),
    validation: getStringArray(parsed.validation ?? parsed.finalChecks),
  };
}

function pushList(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push(`**${title}:**`);
  items.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
}

function formatStepPlanMarkdown(options: {
  readonly plan: WfImpplannerStepPlan;
  readonly stepIndex: number;
  readonly totalSteps: number;
}): string {
  const { plan } = options;
  const lines = [`# Implementation step ${options.stepIndex + 1} of ${options.totalSteps}: ${plan.title}`, ""];
  lines.push("## Source design step", "", plan.sourceDesignStepTitle, "");
  lines.push("## Objective", "", plan.objective, "");
  pushList(lines, "Dependencies / prerequisites", plan.dependencies);
  pushList(lines, "High-priority tests", plan.highPriorityTests);
  pushList(lines, "Execution instructions", plan.instructions);
  pushList(lines, "Checkpoints", plan.checkpoints);
  pushList(lines, "Touchpoints", plan.touchpoints);
  pushList(lines, "Examples / pseudocode", plan.examples);
  pushList(lines, "Risks", plan.risks);
  pushList(lines, "Validation", plan.validation);
  return lines.join("\n");
}

function formatWfImpplannerDecisionMarkdown(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfImpplannerDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
  readonly stepRuns?: readonly WfImpplannerStepRunResult[];
}): string {
  const lines = ["# Workflow implementation plan", ""];
  const { decision } = options;

  if (decision?.summary) lines.push(decision.summary, "");

  if (decision?.kind === "questions") {
    lines.push("## Questions for the user", "");
    decision.questions.forEach((question, index) => lines.push(`${index + 1}. ${question}`));
    lines.push("");
  } else if (decision?.kind === "implementation_plan") {
    lines.push("## Source design plan", "", decision.designPlanTitle, "");
    lines.push("## Objective", "", decision.objective, "");
    if (decision.approach) lines.push("## Implementation approach", "", decision.approach, "");
    pushList(lines, "High-priority tests", decision.highPriorityTests);
    pushList(lines, "Cross-step checkpoints", decision.checkpoints);

    if (decision.stepPlans.length > 0) {
      lines.push("## Execution plan", "");
      decision.stepPlans.forEach((plan, index) => {
        lines.push(`### ${index + 1}. ${plan.title}`, "");
        lines.push(`Source design step: ${plan.sourceDesignStepTitle}`, "");
        lines.push(plan.objective, "");
        pushList(lines, "Dependencies / prerequisites", plan.dependencies);
        pushList(lines, "High-priority tests", plan.highPriorityTests);
        pushList(lines, "Execution instructions", plan.instructions);
        pushList(lines, "Checkpoints", plan.checkpoints);
        pushList(lines, "Touchpoints", plan.touchpoints);
        pushList(lines, "Examples / pseudocode", plan.examples);
        pushList(lines, "Risks", plan.risks);
        pushList(lines, "Validation", plan.validation);
      });
    }

    pushList(lines, "Final validation", decision.validation);
    pushList(lines, "Risks", decision.risks);
    pushList(lines, "Unknowns", decision.unknowns);
    if (decision.handoffPrompt) lines.push("## Handoff prompt", "", "```text", decision.handoffPrompt, "```", "");
  } else {
    lines.push("## Raw implementation-planner output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }

  if (options.stepRuns?.length) {
    lines.push("## Individual step artifacts", "");
    options.stepRuns.forEach((stepRun) => {
      const status = stepRun.decision?.kind ?? stepRun.result.status;
      const pathText = stepRun.tempPath ? ` — ${stepRun.tempPath}` : "";
      lines.push(`- Step ${stepRun.stepIndex + 1}: ${status}${pathText}`);
    });
    lines.push("");
  }

  lines.push("## Run info", "");
  lines.push(`- Status: ${options.result.status}`);
  lines.push(`- Model: ${options.result.model ?? getModelSelector(options.config)}`);
  lines.push(`- Tools: ${options.result.toolCalls.map((call) => call.name).join(", ") || "none"}`);
  if (options.result.errorMessage) lines.push(`- Error: ${options.result.errorMessage}`);

  return lines.join("\n");
}

export function formatWfImpplannerDecisionReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfImpplannerDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
  readonly stepRuns?: readonly WfImpplannerStepRunResult[];
}): string {
  return truncateText(formatWfImpplannerDecisionMarkdown(options), options.config.reportMaxChars);
}

function getLocalDateStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function slugifyTopic(topic: string): string {
  const slug = topic
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, TOPIC_SLUG_MAX_LENGTH)
    .replace(/-+$/u, "");

  return slug || "implementation-plan";
}

function getImplementationPlanTopic(options: {
  readonly decision?: WfImpplannerImplementationDecision | undefined;
  readonly designPlan: WfImpplannerDesignPlan;
  readonly selectedOption?: WfDesignPlanSelectedOption | undefined;
}): string {
  return (
    options.decision?.designPlanTitle?.trim() ||
    options.designPlan.selectedOptionTitle.trim() ||
    options.selectedOption?.title.trim() ||
    options.designPlan.objective.trim() ||
    "implementation plan"
  );
}

async function persistStepPlanArtifact(options: {
  readonly designPlan: WfImpplannerDesignPlan;
  readonly plan: WfImpplannerStepPlan;
  readonly selectedOption?: WfDesignPlanSelectedOption | undefined;
  readonly stepIndex: number;
  readonly totalSteps: number;
  readonly workspaceRoot: string;
}): Promise<string> {
  const directory = join(options.workspaceRoot, ...TEMP_ARTIFACT_PATH_PARTS);
  const topic = getImplementationPlanTopic({ designPlan: options.designPlan, selectedOption: options.selectedOption });
  const filename = `${getLocalDateStamp()}-${slugifyTopic(topic)}-step-${`${options.stepIndex + 1}`.padStart(2, "0")}-${slugifyTopic(options.plan.title)}.md`;
  const documentPath = join(directory, filename);
  const document = formatStepPlanMarkdown({
    plan: options.plan,
    stepIndex: options.stepIndex,
    totalSteps: options.totalSteps,
  });

  await mkdir(directory, { recursive: true });
  await writeFile(documentPath, `${document.trimEnd()}\n`, "utf8");
  return documentPath;
}

async function persistImplementationPlanArtifact(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision: WfImpplannerImplementationDecision;
  readonly designPlan: WfImpplannerDesignPlan;
  readonly result: ChildAgentRunResult;
  readonly selectedOption?: WfDesignPlanSelectedOption | undefined;
  readonly stepRuns: readonly WfImpplannerStepRunResult[];
  readonly workspaceRoot: string;
}): Promise<string> {
  const directory = join(options.workspaceRoot, ...IMPLEMENTATION_PLAN_ARTIFACT_PATH_PARTS);
  const topic = getImplementationPlanTopic({
    decision: options.decision,
    designPlan: options.designPlan,
    selectedOption: options.selectedOption,
  });
  const filename = `${getLocalDateStamp()}-${slugifyTopic(topic)}.md`;
  const documentPath = join(directory, filename);
  const document = formatWfImpplannerDecisionMarkdown({
    config: options.config,
    decision: options.decision,
    result: options.result,
    stepRuns: options.stepRuns,
  });

  await mkdir(directory, { recursive: true });
  await writeFile(documentPath, `${document.trimEnd()}\n`, "utf8");
  return documentPath;
}

async function reviewStepDecision(options: {
  readonly config: ChildPiAgentConfig;
  readonly ctx: ExtensionContext;
  readonly designPlan: WfImpplannerDesignPlan;
  readonly decision: Extract<WfImpplannerStepDecision, { readonly kind: "step_plan" }>;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly result: ChildAgentRunResult;
  readonly selectedOption?: WfDesignPlanSelectedOption | undefined;
  readonly stepIndex: number;
}): Promise<Extract<WfImpplannerStepDecision, { readonly kind: "step_plan" }>> {
  try {
    const stepReport = formatStepPlanMarkdown({
      plan: options.decision.plan,
      stepIndex: options.stepIndex,
      totalSteps: options.designPlan.steps.length,
    });
    const review = await runWfAdversarialReviewForStage({
      ctx: options.ctx,
      expectedOutputSchema: WF_IMPPLANNER_STEP_SCHEMA,
      originalPrompt: options.designPlan.objective,
      pi: options.pi,
      stageContext: [
        "This is one individual wf-impplanner step plan. Review it before it is written as a temporary step artifact or merged into the final implementation plan.",
        "Check that the step is feasible, scoped to one design-plan stage, test-driven when possible, checkpointed, and specific enough for implementation.",
        "Reviewed design plan:",
        JSON.stringify(options.designPlan, null, 2),
        "Selected option, if supplied:",
        options.selectedOption ? JSON.stringify(options.selectedOption, null, 2) : "- none supplied",
      ].join("\n"),
      stageId: `wf-impplanner-step-${options.stepIndex + 1}`,
      stageOutput: JSON.stringify(options.decision, null, 2),
      stageReport: stepReport,
      onProgress: options.onProgress,
    });

    sendWfAdversarialReviewReportMessage(options.pi, options.ctx, review);

    if (!review.decision?.reviewedOutput || review.decision.verdict === "blocked") {
      options.ctx.ui.notify(
        `wf-impplanner step ${options.stepIndex + 1} review did not provide usable reviewed output; using original step plan.`,
        "warning",
      );
      return options.decision;
    }

    const reviewedDecision = parseWfImpplannerStepDecision(
      stringifyReviewedOutput(review.decision.reviewedOutput),
      {
        sourceTitle: options.decision.plan.sourceDesignStepTitle,
        title: options.decision.plan.title,
      },
    );
    if (!reviewedDecision || reviewedDecision.kind !== "step_plan") {
      options.ctx.ui.notify(
        `wf-impplanner step ${options.stepIndex + 1} review returned invalid step-plan schema; using original step plan.`,
        "warning",
      );
      return options.decision;
    }

    return reviewedDecision;
  } catch (error) {
    options.ctx.ui.notify(
      `wf-impplanner step ${options.stepIndex + 1} review failed: ${getErrorMessage(error)}. Using original step plan.`,
      "warning",
    );
    return options.decision;
  }
}

async function reviewFinalDecision(options: {
  readonly config: ChildPiAgentConfig;
  readonly ctx: ExtensionContext;
  readonly designPlan: WfImpplannerDesignPlan;
  readonly decision: WfImpplannerImplementationDecision;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly result: ChildAgentRunResult;
  readonly selectedOption?: WfDesignPlanSelectedOption | undefined;
  readonly stepRuns: readonly WfImpplannerStepRunResult[];
}): Promise<WfImpplannerImplementationDecision> {
  try {
    const finalReport = formatWfImpplannerDecisionMarkdown({
      config: options.config,
      decision: options.decision,
      result: options.result,
      stepRuns: options.stepRuns,
    });
    const review = await runWfAdversarialReviewForStage({
      ctx: options.ctx,
      expectedOutputSchema: WF_IMPPLANNER_FINAL_SCHEMA,
      originalPrompt: options.designPlan.objective,
      pi: options.pi,
      stageContext: [
        "This is the final merged wf-impplanner implementation plan. It has already been saved once; review it as a whole before it is saved as the final implementation-plan living document.",
        "Check that the merged plan is feasible, ordered, test-driven when possible, checkpointed, coherent across steps, and specific enough for execution.",
        "Reviewed design plan:",
        JSON.stringify(options.designPlan, null, 2),
        "Selected option, if supplied:",
        options.selectedOption ? JSON.stringify(options.selectedOption, null, 2) : "- none supplied",
      ].join("\n"),
      stageId: "wf-impplanner-final",
      stageOutput: JSON.stringify(options.decision, null, 2),
      stageReport: finalReport,
      onProgress: options.onProgress,
    });

    sendWfAdversarialReviewReportMessage(options.pi, options.ctx, review);

    if (!review.decision?.reviewedOutput || review.decision.verdict === "blocked") {
      options.ctx.ui.notify(
        "wf-impplanner final review did not provide usable reviewed output; using saved implementation plan.",
        "warning",
      );
      return options.decision;
    }

    const reviewedDecision = parseWfImpplannerDecision(stringifyReviewedOutput(review.decision.reviewedOutput));
    if (!reviewedDecision || reviewedDecision.kind !== "implementation_plan") {
      options.ctx.ui.notify(
        "wf-impplanner final review returned invalid implementation-plan schema; using saved implementation plan.",
        "warning",
      );
      return options.decision;
    }

    return reviewedDecision;
  } catch (error) {
    options.ctx.ui.notify(
      `wf-impplanner final review failed: ${getErrorMessage(error)}. Using saved implementation plan.`,
      "warning",
    );
    return options.decision;
  }
}

function createQuestionsResult(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision: Extract<WfImpplannerDecision, { readonly kind: "questions" }>;
  readonly result: ChildAgentRunResult;
  readonly stepRuns: readonly WfImpplannerStepRunResult[];
}): WfImpplannerRunResult {
  const report = formatWfImpplannerDecisionReport({
    config: options.config,
    decision: options.decision,
    result: options.result,
    stepRuns: options.stepRuns,
  });
  return { config: options.config, decision: options.decision, report, result: options.result, stepRuns: options.stepRuns };
}

export async function runWfImpplannerForDesignPlan(options: {
  readonly clarifiedPrompt: string;
  readonly ctx: ExtensionContext;
  readonly designPlan: WfImpplannerDesignPlan;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
  readonly selectedOption?: WfDesignPlanSelectedOption | undefined;
}): Promise<WfImpplannerRunResult> {
  const config = readActiveWfImpplannerConfig(options.ctx.cwd);
  registerWfImpplannerProvider(options.pi, config);

  let artifactPath: string | undefined;
  const stepRuns: WfImpplannerStepRunResult[] = [];
  const stepPlans: WfImpplannerStepPlan[] = [];
  const designSteps = options.designPlan.steps.length
    ? options.designPlan.steps
    : [
        {
          details: options.designPlan.architecture || options.designPlan.objective,
          risks: options.designPlan.risks,
          title: options.designPlan.selectedOptionTitle || "Implementation",
          touchpoints: [],
          validation: options.designPlan.validation,
        },
      ];

  for (const [stepIndex, step] of designSteps.entries()) {
    const stepTask = buildStepPlanTask({
      designPlan: { ...options.designPlan, steps: designSteps },
      previousStepPlans: stepPlans,
      priorAnswers: options.priorAnswers,
      priorQuestions: options.priorQuestions,
      step,
      stepIndex,
    });
    const stepResult = await runChildPiAgent({
      buildPrompt: buildStepPlanPrompt,
      config,
      defaultCwd: options.ctx.cwd,
      excludeTools: EXCLUDED_CHILD_TOOLS,
      onProgress: options.onProgress,
      task: stepTask,
    });
    const fallback = { sourceTitle: step.title, title: step.title };
    const parsedStepDecision = parseWfImpplannerStepDecision(stepResult.output, fallback);
    const stepParseError = parsedStepDecision ? undefined : "wf-impplanner did not return parseable step-plan JSON";

    if (parsedStepDecision?.kind === "questions") {
      const stepReport = formatWfImpplannerDecisionReport({
        config,
        decision: { kind: "questions", questions: parsedStepDecision.questions, ...(parsedStepDecision.summary ? { summary: parsedStepDecision.summary } : {}) },
        result: stepResult,
        stepRuns,
      });
      stepRuns.push({
        decision: parsedStepDecision,
        ...(stepParseError ? { parseError: stepParseError } : {}),
        report: stepReport,
        result: stepResult,
        stepIndex,
      });
      return createQuestionsResult({
        config,
        decision: { kind: "questions", questions: parsedStepDecision.questions, ...(parsedStepDecision.summary ? { summary: parsedStepDecision.summary } : {}) },
        result: stepResult,
        stepRuns,
      });
    }

    if (!parsedStepDecision || parsedStepDecision.kind !== "step_plan") {
      const report = formatWfImpplannerDecisionReport({
        config,
        parseError: stepParseError,
        result: stepResult,
        stepRuns,
      });
      stepRuns.push({
        ...(stepParseError ? { parseError: stepParseError } : {}),
        report,
        result: stepResult,
        stepIndex,
      });
      return { config, ...(stepParseError ? { parseError: stepParseError } : {}), report, result: stepResult, stepRuns };
    }

    const reviewedStepDecision = await reviewStepDecision({
      config,
      ctx: options.ctx,
      designPlan: { ...options.designPlan, steps: designSteps },
      decision: parsedStepDecision,
      onProgress: options.onProgress,
      pi: options.pi,
      result: stepResult,
      selectedOption: options.selectedOption,
      stepIndex,
    });
    let tempPath: string | undefined;
    try {
      tempPath = await persistStepPlanArtifact({
        designPlan: { ...options.designPlan, steps: designSteps },
        plan: reviewedStepDecision.plan,
        selectedOption: options.selectedOption,
        stepIndex,
        totalSteps: designSteps.length,
        workspaceRoot: options.ctx.cwd,
      });
    } catch (error) {
      options.ctx.ui.notify(`wf-impplanner could not save temporary step plan: ${getErrorMessage(error)}`, "warning");
    }
    stepPlans.push(reviewedStepDecision.plan);
    const stepReport = formatStepPlanMarkdown({
      plan: reviewedStepDecision.plan,
      stepIndex,
      totalSteps: designSteps.length,
    });
    stepRuns.push({
      decision: reviewedStepDecision,
      report: stepReport,
      result: stepResult,
      stepIndex,
      ...(tempPath ? { tempPath } : {}),
    });
  }

  const finalTask = buildFinalPlanTask({
    designPlan: { ...options.designPlan, steps: designSteps },
    priorAnswers: options.priorAnswers,
    priorQuestions: options.priorQuestions,
    stepPlans,
  });
  const result = await runChildPiAgent({
    buildPrompt: buildFinalPlanPrompt,
    config,
    defaultCwd: options.ctx.cwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    task: finalTask,
  });
  let decision = parseWfImpplannerDecision(result.output);
  const parseError = decision ? undefined : "wf-impplanner did not return parseable implementation-plan JSON";

  if (decision?.kind === "questions") {
    return createQuestionsResult({ config, decision, result, stepRuns });
  }

  if (decision?.kind === "implementation_plan") {
    try {
      artifactPath = await persistImplementationPlanArtifact({
        config,
        decision,
        designPlan: { ...options.designPlan, steps: designSteps },
        result,
        selectedOption: options.selectedOption,
        stepRuns,
        workspaceRoot: options.ctx.cwd,
      });
    } catch (error) {
      options.ctx.ui.notify(`wf-impplanner could not save implementation plan before review: ${getErrorMessage(error)}`, "warning");
    }

    const reviewedDecision = await reviewFinalDecision({
      config,
      ctx: options.ctx,
      designPlan: { ...options.designPlan, steps: designSteps },
      decision,
      onProgress: options.onProgress,
      pi: options.pi,
      result,
      selectedOption: options.selectedOption,
      stepRuns,
    });
    decision = reviewedDecision;

    try {
      artifactPath = await persistImplementationPlanArtifact({
        config,
        decision: reviewedDecision,
        designPlan: { ...options.designPlan, steps: designSteps },
        result,
        selectedOption: options.selectedOption,
        stepRuns,
        workspaceRoot: options.ctx.cwd,
      });
    } catch (error) {
      options.ctx.ui.notify(`wf-impplanner could not save reviewed implementation plan: ${getErrorMessage(error)}`, "warning");
    }
  }

  const report = formatWfImpplannerDecisionReport({ config, decision, parseError, result, stepRuns });
  return { ...(artifactPath ? { artifactPath } : {}), config, decision, ...(parseError ? { parseError } : {}), report, result, stepRuns };
}

export function sendWfImpplannerReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: WfImpplannerRunResult,
): void {
  sendChildAgentReportMessage({
    config: run.config,
    ctx,
    messageType: WF_IMPPLANNER_MESSAGE_TYPE,
    pi,
    report: run.report,
    result: run.result,
  });
}

function formatStatus(): string {
  return [
    formatWfImpplannerModelSelection(currentConfig),
    "Commands: /wf-impplanner model [model] | config | ask <prompt>. You can also run /wf-impplanner <prompt> directly.",
  ].join("\n");
}

function createManualDesignPlan(prompt: string): WfImpplannerDesignPlan {
  return {
    acceptanceCriteria: [],
    architecture: prompt,
    kind: "design_plan",
    objective: prompt,
    risks: [],
    selectedOptionTitle: "Manual prompt",
    steps: [
      {
        details: prompt,
        risks: [],
        title: "Manual implementation request",
        touchpoints: [],
        validation: [],
      },
    ],
    unknowns: [],
    validation: [],
  };
}

export default function wfImpplannerExtension(pi: ExtensionAPI): void {
  reloadWfImpplannerSettings(pi, process.cwd());

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

  pi.registerMessageRenderer(WF_IMPPLANNER_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "wf-impplanner" }),
  );

  pi.registerCommand("wf-impplanner", {
    description: "Run the workflow-mode implementation-planning subagent or select its model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getWfImpplannerModelCompletions(modelPrefix);
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
        reloadWfImpplannerSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadWfImpplannerSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `wf-impplanner config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatWfImpplannerModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectWfImpplannerModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const prompt = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!prompt) {
        ctx.ui.notify(
          "Usage: /wf-impplanner model [model] | config | ask <prompt>; or /wf-impplanner <prompt>",
          "warning",
        );
        return;
      }

      const config = readActiveWfImpplannerConfig(ctx.cwd);
      registerWfImpplannerProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(prompt)}`);

      try {
        const run = await runWfImpplannerForDesignPlan({
          clarifiedPrompt: prompt,
          ctx,
          designPlan: createManualDesignPlan(prompt),
          pi,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        sendWfImpplannerReportMessage(pi, ctx, run);
        const level = run.result.status === "completed" && run.decision ? "info" : "warning";
        ctx.ui.notify(`wf-impplanner ${run.result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`wf-impplanner failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
