import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getErrorMessage, isRecord, previewTask } from "./zz-lib/child-pi-agent.ts";
import {
  WORKFLOW_TREE_QUERY_EVENT,
  WORKFLOW_TREE_SNAPSHOT_EVENT,
  WORKFLOW_TREE_SNAPSHOT_SCHEMA_VERSION,
  WORKFLOW_TREE_STAGES,
  WORKFLOW_TREE_STATUSES,
  type WorkflowTreeOptionSummary,
  type WorkflowTreeProgressSummary,
  type WorkflowTreePromptSummary,
  type WorkflowTreeSnapshot,
  type WorkflowTreeStage,
  type WorkflowTreeStatus,
  type WorkflowTreeTerminalStatus,
} from "./lib/workflow-tree-state.ts";
import {
  type WfBrainstormerDecision,
  type WfBrainstormerOption,
  type WfBrainstormerRunResult,
  formatWfBrainstormerDecisionReport,
  parseWfBrainstormerDecision,
  runWfBrainstormerForPrompt,
  selectWfBrainstormerModel,
  sendWfBrainstormerReportMessage,
} from "./wf-brainstormer.ts";
import {
  runWfAdversarialReviewForStage,
  selectWfAdversarialReviewModel,
  sendWfAdversarialReviewReportMessage,
  stringifyReviewedOutput,
} from "./wf-adversarialreview.ts";
import {
  type WfClarifierPromptOption,
  runWfClarifierForPrompt,
  selectWfClarifierModel,
  sendWfClarifierReportMessage,
} from "./wf-clarifier.ts";
import {
  type WfDesignPlanDecision,
  type WfDesignPlanRunResult,
  reviewWfDesignPlanRun,
  runWfDesignPlanForOption,
  selectWfDesignPlanModel,
  sendWfDesignPlanReportMessage,
} from "./wf-designplan.ts";
import {
  type WfImpplannerDecision,
  type WfImpplannerRunResult,
  type WfImpplannerStepPlan,
  runWfImpplannerForDesignPlan,
  selectWfImpplannerModel,
  sendWfImpplannerReportMessage,
} from "./wf-impplanner.ts";
import {
  type WfImplementerAgentDecision,
  runWfImplementerAgentForStage,
  selectWfImplementerAgentModel,
  sendWfImplementerAgentReportMessage,
} from "./wf-implementeragent.ts";
import {
  type WfFinalReviewAgentDecision,
  type WfFinalReviewRemediationStep,
  formatWfFinalReviewAgentFeedback,
  runWfFinalReviewAgentForBranch,
  selectWfFinalReviewAgentModel,
  sendWfFinalReviewAgentReportMessage,
} from "./wf-finalreviewagent.ts";
import {
  type WfTesterAgentDecision,
  runWfTesterAgentForBranch,
  selectWfTesterAgentModel,
  sendWfTesterAgentReportMessage,
} from "./wf-testeragent.ts";
import {
  formatWfReviewerAgentFeedback,
  runWfReviewerAgentForStage,
  selectWfReviewerAgentModel,
  sendWfReviewerAgentReportMessage,
} from "./wf-revieweragent.ts";

const STATUS_KEY = "workflowmode";
const WORKFLOW_STATE_SCHEMA_VERSION = 1;
const WORKFLOW_STATE_DIR_PARTS = [".zzwf", "workflows"] as const;
const WORKFLOW_STATE_FILE = "current.json";
const WORKFLOW_ARCHIVE_TOPIC_SLUG_MAX_LENGTH = 80;

type WorkflowAgentModelSelector = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
  options?: { readonly quiet?: boolean },
) => Promise<void>;

const WORKFLOW_MODEL_OPTIONS = [
  { id: "gpt-5.6-sol-xhigh", label: "GPT-5.6 Sol xhigh (openai-codex)" },
  { id: "gpt-5.6-sol-max", label: "GPT-5.6 Sol max (openai-codex)" },
  { id: "gpt-5.5-xhigh", label: "GPT-5.5 xhigh (openai-codex)" },
  { id: "qwen-35b-a3b", label: "Qwen 3.6 35B A3B via proxy" },
  { id: "glm-5p2-xhigh", label: "GLM 5.2 xhigh (fireworks)" },
] as const;

const WORKFLOW_MODEL_ALIASES: Record<string, string> = {
  "gpt": "gpt-5.6-sol-xhigh",
  "gpt-5.5": "gpt-5.5-xhigh",
  "gpt-5.5-xhigh": "gpt-5.5-xhigh",
  "gpt-5.6-sol": "gpt-5.6-sol-xhigh",
  "gpt-5.6-sol-xhigh": "gpt-5.6-sol-xhigh",
  "gpt-5.6-sol-max": "gpt-5.6-sol-max",
  "gpt-max": "gpt-5.6-sol-max",
  "qwen": "qwen-35b-a3b",
  "qwen-35b-a3b": "qwen-35b-a3b",
  "qwen/qwen3.6-35b-a3b": "qwen-35b-a3b",
  "glm": "glm-5p2-xhigh",
  "glm-5p2": "glm-5p2-xhigh",
  "glm-5p2-xhigh": "glm-5p2-xhigh",
};

const WORKFLOW_AGENT_MODEL_SELECTORS: readonly {
  readonly name: string;
  readonly selectModel: WorkflowAgentModelSelector;
}[] = [
  { name: "wf-clarifier", selectModel: selectWfClarifierModel },
  { name: "wf-brainstormer", selectModel: selectWfBrainstormerModel },
  { name: "wf-adversarialreview", selectModel: selectWfAdversarialReviewModel },
  { name: "wf-designplan", selectModel: selectWfDesignPlanModel },
  { name: "wf-impplanner", selectModel: selectWfImpplannerModel },
  { name: "wf-implementeragent", selectModel: selectWfImplementerAgentModel },
  { name: "wf-revieweragent", selectModel: selectWfReviewerAgentModel },
  { name: "wf-finalreviewagent", selectModel: selectWfFinalReviewAgentModel },
  { name: "wf-testeragent", selectModel: selectWfTesterAgentModel },
];
function formatWorkflowModelOptions(): string {
  return WORKFLOW_MODEL_OPTIONS.map((option) => `${option.id}: ${option.label}`).join(", ");
}

function normalizeWorkflowModelRequest(requested: string): string | undefined {
  const normalized = requested.trim().toLowerCase();
  return WORKFLOW_MODEL_ALIASES[normalized];
}

function getWorkflowModeCommandCompletions(prefix: string) {
  const trimmed = prefix.trimStart();
  const hasTrailingSpace = /\s$/u.test(prefix);
  const parts = trimmed ? trimmed.split(/\s+/u) : [];
  const [first = "", ...rest] = parts;
  const normalizedFirst = first.toLowerCase();

  if ((normalizedFirst === "model" || normalizedFirst === "models") && (trimmed.includes(" ") || hasTrailingSpace)) {
    const modelPrefix = (hasTrailingSpace ? "" : rest.join(" ")).toLowerCase();
    return WORKFLOW_MODEL_OPTIONS
      .filter((option) => option.id.startsWith(modelPrefix) || option.label.toLowerCase().includes(modelPrefix))
      .map((option) => ({ value: option.id, label: `${option.id} — ${option.label}` }));
  }

  if (trimmed.includes(" ") || hasTrailingSpace) return null;

  return ["on", "off", "toggle", "status", "reset", "resume", "continue", "model"]
    .filter((option) => option.startsWith(normalizedFirst))
    .map((option) => ({ value: option, label: option }));
}

async function selectAllWorkflowAgentModels(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  requestedModel: string,
): Promise<void> {
  const selectedModelId = normalizeWorkflowModelRequest(requestedModel);
  if (!selectedModelId) {
    ctx.ui.notify(
      `Usage: /workflowmode model <model>. Available workflow model ids: ${formatWorkflowModelOptions()}`,
      "warning",
    );
    return;
  }

  const failures: string[] = [];
  for (const agent of WORKFLOW_AGENT_MODEL_SELECTORS) {
    try {
      await agent.selectModel(pi, ctx, selectedModelId, { quiet: true });
    } catch (error) {
      failures.push(`${agent.name}: ${getErrorMessage(error)}`);
    }
  }

  if (failures.length > 0) {
    ctx.ui.notify(
      `Workflow mode: selected ${selectedModelId} for ${WORKFLOW_AGENT_MODEL_SELECTORS.length - failures.length}/${WORKFLOW_AGENT_MODEL_SELECTORS.length} wf agents. Failures:\n${failures.join("\n")}`,
      "warning",
    );
    return;
  }

  ctx.ui.notify(
    `Workflow mode: selected ${selectedModelId} for all ${WORKFLOW_AGENT_MODEL_SELECTORS.length} wf agents`,
    "info",
  );
}

const WF_BRAINSTORMER_STAGE_SCHEMA = [
  "Return a WfBrainstormerDecision JSON object using one of these shapes:",
  `{"kind":"brainstorm","summary":"short synthesis","recommendedOption":"optional recommendation","options":[{"title":"Option title","approach":"strategy-level description","repoTouchpoints":["relevant path/symbol/context"],"pros":["benefit"],"cons":["tradeoff"],"risks":["risk"],"unknowns":["open unknown"],"nextSteps":["high-level next workflow step"]}],"questions":["optional question for later stages"]}`,
  `{"kind":"questions","summary":"why brainstorming is blocked","questions":["question 1","question 2"]}`,
  "For reviewed final brainstorm output, prefer kind=brainstorm. Preserve the brainstormer schema exactly; do not return the adversarial-review envelope inside reviewedOutput.",
].join("\n");
type InputHookResult =
  | { readonly action: "continue" }
  | { readonly action: "handled" }
  | { readonly action: "transform"; readonly text: string };

interface PendingClarification {
  readonly originalPrompt: string;
  readonly questions: readonly string[];
}

interface PendingBrainstorming {
  readonly clarifiedPrompt: string;
  readonly questions: readonly string[];
}

interface PendingDesignPlan {
  readonly brainstormDecision: WfBrainstormerDecision;
  readonly clarifiedPrompt: string;
  readonly questions: readonly string[];
  readonly selectedOption: WfBrainstormerOption;
}

interface PendingImpplanner {
  readonly brainstormDecision: WfBrainstormerDecision;
  readonly clarifiedPrompt: string;
  readonly designPlanDecision: Extract<WfDesignPlanDecision, { readonly kind: "design_plan" }>;
  readonly questions: readonly string[];
  readonly selectedOption: WfBrainstormerOption;
}

interface PendingImplementation {
  readonly brainstormDecision: WfBrainstormerDecision;
  readonly clarifiedPrompt: string;
  readonly designPlanDecision: Extract<WfDesignPlanDecision, { readonly kind: "design_plan" }>;
  readonly implementationPlanArtifactPath?: string;
  readonly implementationPlanDecision: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly selectedOption: WfBrainstormerOption;
  readonly stepIndex: number;
}

interface PendingFinalReview {
  readonly brainstormDecision: WfBrainstormerDecision;
  readonly clarifiedPrompt: string;
  readonly designPlanDecision: Extract<WfDesignPlanDecision, { readonly kind: "design_plan" }>;
  readonly finalReviewIteration: number;
  readonly implementationPlanArtifactPath?: string;
  readonly implementationPlanDecision: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly selectedOption: WfBrainstormerOption;
}

interface PendingTesting {
  readonly brainstormDecision: WfBrainstormerDecision;
  readonly clarifiedPrompt: string;
  readonly designPlanDecision: Extract<WfDesignPlanDecision, { readonly kind: "design_plan" }>;
  readonly finalReviewIteration: number;
  readonly implementationPlanArtifactPath?: string;
  readonly implementationPlanDecision: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly selectedOption: WfBrainstormerOption;
}

interface PendingClarifierPromptSelection {
  readonly prompts: readonly WfClarifierPromptOption[];
}

interface PendingBrainstormOptionSelection {
  readonly brainstormDecision: Extract<WfBrainstormerDecision, { kind: "brainstorm" }>;
  readonly clarifiedPrompt: string;
}

type WorkflowStateStatus = "waiting_for_answers" | "paused" | "complete" | "stopped";

type WorkflowStateStage =
  | "clarification_questions"
  | "clarifier_prompt_selection"
  | "brainstorming_questions"
  | "brainstorm_option_selection"
  | "design_plan_questions"
  | "impplanner_questions"
  | "implementation_stage"
  | "testing"
  | "final_review"
  | "complete"
  | "stopped";

const WORKFLOW_STATE_STATUS_SET: ReadonlySet<string> = new Set(WORKFLOW_TREE_STATUSES);
const WORKFLOW_STATE_STAGE_SET: ReadonlySet<string> = new Set(WORKFLOW_TREE_STAGES);
const WORKFLOW_STATE_STAGES_BY_STATUS: { readonly [Status in WorkflowStateStatus]: ReadonlySet<WorkflowStateStage> } = {
  waiting_for_answers: new Set<WorkflowStateStage>([
    "clarification_questions",
    "brainstorming_questions",
    "design_plan_questions",
    "impplanner_questions",
  ]),
  paused: new Set<WorkflowStateStage>([
    "clarifier_prompt_selection",
    "brainstorm_option_selection",
    "implementation_stage",
    "testing",
    "final_review",
  ]),
  complete: new Set<WorkflowStateStage>(["complete"]),
  stopped: new Set<WorkflowStateStage>(["stopped"]),
};

function isWorkflowStateStatus(value: string | undefined): value is WorkflowStateStatus {
  return typeof value === "string" && WORKFLOW_STATE_STATUS_SET.has(value);
}

function isWorkflowStateStage(value: string | undefined): value is WorkflowStateStage {
  return typeof value === "string" && WORKFLOW_STATE_STAGE_SET.has(value);
}

function isValidStoredWorkflowStateCombination(status: WorkflowStateStatus, stage: WorkflowStateStage): boolean {
  return WORKFLOW_STATE_STAGES_BY_STATUS[status].has(stage);
}

interface StoredWorkflowState {
  readonly schemaVersion: typeof WORKFLOW_STATE_SCHEMA_VERSION;
  readonly status: WorkflowStateStatus;
  readonly stage: WorkflowStateStage;
  readonly brainstormDecision?: WfBrainstormerDecision;
  readonly clarifiedPrompt?: string;
  readonly createdAt: string;
  readonly designPlanDecision?: Extract<WfDesignPlanDecision, { readonly kind: "design_plan" }>;
  readonly finalReviewIteration?: number;
  readonly implementationPlanArtifactPath?: string;
  readonly implementationPlanDecision?: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly implementationStepIndex?: number;
  readonly originalPrompt?: string;
  readonly prompts?: readonly WfClarifierPromptOption[];
  readonly questions?: readonly string[];
  readonly selectedOption?: WfBrainstormerOption;
  readonly updatedAt: string;
}

type WorkflowTreeSnapshotOverrides = Partial<Omit<WorkflowTreeSnapshot, "emittedAt" | "schemaVersion" | "source">>;

const WORKFLOW_TREE_STAGE_BY_STATE: { readonly [Stage in WorkflowStateStage]: WorkflowTreeStage } = {
  clarification_questions: "clarification_questions",
  clarifier_prompt_selection: "clarifier_prompt_selection",
  brainstorming_questions: "brainstorming_questions",
  brainstorm_option_selection: "brainstorm_option_selection",
  design_plan_questions: "design_plan_questions",
  impplanner_questions: "impplanner_questions",
  implementation_stage: "implementation_stage",
  testing: "testing",
  final_review: "final_review",
  complete: "complete",
  stopped: "stopped",
};

const WORKFLOW_TREE_STATUS_BY_STATE: { readonly [Status in WorkflowStateStatus]: WorkflowTreeStatus } = {
  waiting_for_answers: "waiting_for_answers",
  paused: "paused",
  complete: "complete",
  stopped: "stopped",
};

function summarizeWorkflowTreePrompts(
  prompts: readonly WfClarifierPromptOption[] | undefined,
): readonly WorkflowTreePromptSummary[] | undefined {
  if (!prompts?.length) return undefined;
  return prompts.map((prompt, index) => ({
    id: `prompt-${index + 1}`,
    prompt: prompt.prompt,
    ...(prompt.rationale ? { description: prompt.rationale } : {}),
    title: prompt.title,
  }));
}

function summarizeWorkflowTreeOption(option: WfBrainstormerOption | undefined): WorkflowTreeOptionSummary | undefined {
  if (!option) return undefined;
  return {
    summary: option.approach,
    title: option.title,
  };
}

function getWorkflowTreeImplementationFields(options: {
  readonly implementationPlanDecision?: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly implementationStepIndex?: number;
}): WorkflowTreeSnapshotOverrides {
  const implementationStepIndex = options.implementationStepIndex;
  const implementationStepTotal = options.implementationPlanDecision?.stepPlans.length;
  const implementationStepTitle = implementationStepIndex === undefined
    ? undefined
    : options.implementationPlanDecision?.stepPlans[implementationStepIndex]?.title;

  return {
    ...(implementationStepIndex !== undefined ? { implementationStepIndex } : {}),
    ...(implementationStepTotal !== undefined ? { implementationStepTotal } : {}),
    ...(implementationStepTitle ? { implementationStepTitle } : {}),
  };
}

function getWorkflowTreeFieldsFromStoredState(state: StoredWorkflowState): WorkflowTreeSnapshotOverrides {
  const pendingPrompts = summarizeWorkflowTreePrompts(state.prompts);
  const selectedOption = summarizeWorkflowTreeOption(state.selectedOption);
  const selectedOptionTitle = state.selectedOption?.title ?? state.designPlanDecision?.selectedOptionTitle;
  const terminalStatus: WorkflowTreeTerminalStatus | undefined =
    state.status === "complete" || state.status === "stopped" ? state.status : undefined;

  return {
    stage: WORKFLOW_TREE_STAGE_BY_STATE[state.stage],
    status: WORKFLOW_TREE_STATUS_BY_STATE[state.status],
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.status === "paused" ? { pausedAt: state.updatedAt } : {}),
    ...(state.status === "complete" ? { completedAt: state.updatedAt } : {}),
    ...(terminalStatus ? { terminalAt: state.updatedAt, terminalStatus } : {}),
    ...(state.originalPrompt ? { originalPrompt: state.originalPrompt, pendingPrompt: state.originalPrompt } : {}),
    ...(state.clarifiedPrompt ? { clarifiedPrompt: state.clarifiedPrompt } : {}),
    ...(pendingPrompts ? { pendingPrompts } : {}),
    ...(state.questions?.length ? { pendingQuestions: state.questions } : {}),
    ...(selectedOption ? { selectedOption } : {}),
    ...(selectedOptionTitle ? { selectedOptionTitle } : {}),
    ...getWorkflowTreeImplementationFields({
      implementationPlanDecision: state.implementationPlanDecision,
      implementationStepIndex: state.implementationStepIndex,
    }),
    ...(state.finalReviewIteration !== undefined ? { finalReviewIteration: state.finalReviewIteration } : {}),
  };
}

function getWorkflowTreeLifecycleFromStoredState(state: StoredWorkflowState): WorkflowTreeSnapshot["lifecycle"] {
  if (state.status === "waiting_for_answers") return "waiting_for_user";
  if (state.status === "paused") return "paused";
  if (state.status === "complete") return "complete";
  return "stopped";
}

function summarizeWorkflowTreeError(error: unknown): NonNullable<WorkflowTreeSnapshot["error"]> {
  if (error instanceof Error) {
    return {
      message: getErrorMessage(error),
      ...(error.name ? { name: error.name } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
      occurredAt: new Date().toISOString(),
    };
  }

  return {
    message: getErrorMessage(error),
    occurredAt: new Date().toISOString(),
  };
}

function buildWorkflowTreeProgress(label: string, progress?: { readonly toolCalls: number; readonly turns: number }): WorkflowTreeProgressSummary {
  return {
    label,
    ...(progress ? { toolCalls: progress.toolCalls, turns: progress.turns } : {}),
  };
}

interface TitledOption {
  readonly title: string;
}

function formatQuestionList(questions: readonly string[]): string {
  return questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
}

function buildClarificationFallbackPrompt(
  currentInput: string,
  pendingClarification: PendingClarification | undefined,
): string {
  if (!pendingClarification) return currentInput;

  return [
    "Original workflow prompt:",
    pendingClarification.originalPrompt,
    "",
    "Clarifying questions:",
    formatQuestionList(pendingClarification.questions),
    "",
    "User answers:",
    currentInput,
  ].join("\n");
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase();
}

function getRecommendedBrainstormOption(
  decision: Extract<WfBrainstormerDecision, { kind: "brainstorm" }>,
): WfBrainstormerOption | undefined {
  const recommendation = decision.recommendedOption?.trim();
  if (!recommendation) return undefined;

  const normalized = normalizeTitle(recommendation);
  const exactMatches = decision.options.filter((option) => normalizeTitle(option.title) === normalized);
  if (exactMatches.length === 1) return exactMatches[0];

  const containedMatches = decision.options.filter((option) => {
    const title = normalizeTitle(option.title);
    return title.includes(normalized) || normalized.includes(title);
  });
  return containedMatches.length === 1 ? containedMatches[0] : undefined;
}

async function selectTitledOption<T extends TitledOption>(options: {
  readonly autoSelectReason?: string | undefined;
  readonly ctx: ExtensionContext;
  readonly noUiFallbackMessage: string;
  readonly prompt: string;
  readonly values: readonly T[];
}): Promise<T | undefined> {
  const firstOption = options.values[0];
  if (!firstOption) return undefined;

  if (options.values.length === 1) {
    options.ctx.ui.notify(`${options.autoSelectReason ?? "Workflow mode auto-selected the only option"}: ${firstOption.title}`, "info");
    return firstOption;
  }

  if (options.autoSelectReason) {
    options.ctx.ui.notify(options.autoSelectReason, "info");
  }

  if (!options.ctx.hasUI) {
    options.ctx.ui.notify(options.noUiFallbackMessage, "warning");
    return firstOption;
  }

  const labels = options.values.map((option, index) => `${index + 1}. ${option.title}`);
  const choice = await options.ctx.ui.select(options.prompt, labels);
  if (!choice) return undefined;

  const choiceIndex = labels.indexOf(choice);
  return choiceIndex >= 0 ? options.values[choiceIndex] : undefined;
}

async function selectClarifierPromptOption(
  options: readonly WfClarifierPromptOption[],
  ctx: ExtensionContext,
): Promise<WfClarifierPromptOption | undefined> {
  return selectTitledOption({
    ctx,
    noUiFallbackMessage:
      `Workflow mode received ${options.length} enriched prompts but no interactive UI is available; using option 1: ${options[0]?.title ?? "Option 1"}`,
    prompt: "Workflow mode: choose enriched prompt",
    values: options,
  });
}

async function selectBrainstormOption(
  decision: Extract<WfBrainstormerDecision, { kind: "brainstorm" }>,
  ctx: ExtensionContext,
): Promise<WfBrainstormerOption | undefined> {
  const recommended = getRecommendedBrainstormOption(decision);
  if (recommended) {
    ctx.ui.notify(`Workflow mode auto-selected recommended brainstorm option: ${recommended.title}`, "info");
    return recommended;
  }

  return selectTitledOption({
    ctx,
    noUiFallbackMessage:
      `Workflow brainstorm produced ${decision.options.length} options but no interactive UI is available and no unambiguous recommendation was found; using option 1: ${decision.options[0]?.title ?? "Option 1"}`,
    prompt: "Workflow mode: choose brainstorm option for design planning",
    values: decision.options,
  });
}

function describeBrainstormResult(run: WfBrainstormerRunResult): string {
  if (!run.decision) return "brainstorming finished with an unparseable response";
  if (run.decision.kind === "questions") return "brainstorming needs user answers";
  const optionCount = run.decision.options.length;
  return `brainstorming complete with ${optionCount} option${optionCount === 1 ? "" : "s"}`;
}

function describeDesignPlanResult(run: WfDesignPlanRunResult): string {
  if (!run.decision) return "design planning finished with an unparseable response";
  if (run.decision.kind === "questions") return "design planning needs user answers";
  return "design planning complete";
}

function describeImpplannerResult(run: WfImpplannerRunResult): string {
  if (!run.decision) return "implementation planning finished with an unparseable response";
  if (run.decision.kind === "questions") return "implementation planning needs user answers";
  return "implementation planning complete";
}

function isWorkflowResumeInput(input: string): boolean {
  const normalized = input.trim().toLowerCase().replace(/\s+/gu, " ");
  return new Set([
    "continue workflow",
    "resume",
    "resume workflow",
    "workflow continue",
    "workflow mode resume",
    "workflow resume",
    "workflowmode resume",
  ]).has(normalized);
}

function getWorkflowStatePaths(cwd: string): { readonly directory: string; readonly file: string; readonly tempFile: string } {
  const directory = join(cwd, ...WORKFLOW_STATE_DIR_PARTS);
  return {
    directory,
    file: join(directory, WORKFLOW_STATE_FILE),
    tempFile: join(directory, `${WORKFLOW_STATE_FILE}.${process.pid}.tmp`),
  };
}

function getWorkflowArchivePaths(
  cwd: string,
  state: StoredWorkflowState,
): { readonly directory: string; readonly file: string; readonly tempFile: string } {
  const directory = join(cwd, ...WORKFLOW_STATE_DIR_PARTS);
  const filename = `${getWorkflowArchiveDateStamp()}-${slugifyWorkflowArchiveTopic(getWorkflowArchiveTopic(state))}.json`;
  const file = join(directory, filename);
  return { directory, file, tempFile: join(directory, `${filename}.${process.pid}.tmp`) };
}

function getWorkflowArchiveDateStamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getWorkflowArchiveTopic(state: StoredWorkflowState): string {
  return (
    state.selectedOption?.title?.trim() ||
    state.designPlanDecision?.selectedOptionTitle?.trim() ||
    state.clarifiedPrompt?.trim() ||
    state.originalPrompt?.trim() ||
    "workflow"
  );
}

function slugifyWorkflowArchiveTopic(topic: string): string {
  const slug = topic
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, WORKFLOW_ARCHIVE_TOPIC_SLUG_MAX_LENGTH)
    .replace(/-+$/u, "");

  return slug || "workflow";
}

function getOptionalStoredString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getStoredStringArray(record: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function getOptionalStoredNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function getStoredPromptOptions(record: Record<string, unknown>): readonly WfClarifierPromptOption[] | undefined {
  const value = record.prompts;
  if (!Array.isArray(value)) return undefined;
  const prompts = value.filter(
    (item): item is WfClarifierPromptOption =>
      isRecord(item) && typeof item.title === "string" && typeof item.prompt === "string",
  );
  return prompts.length > 0 ? prompts : undefined;
}

function getStoredBrainstormDecision(
  record: Record<string, unknown>,
): Extract<WfBrainstormerDecision, { kind: "brainstorm" }> | undefined {
  const value = record.brainstormDecision;
  if (!isRecord(value) || value.kind !== "brainstorm" || !Array.isArray(value.options)) return undefined;
  return value as Extract<WfBrainstormerDecision, { kind: "brainstorm" }>;
}

function getStoredSelectedOption(record: Record<string, unknown>): WfBrainstormerOption | undefined {
  const value = record.selectedOption;
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.approach !== "string") return undefined;
  return value as WfBrainstormerOption;
}

function getStoredDesignPlanDecision(
  record: Record<string, unknown>,
): Extract<WfDesignPlanDecision, { readonly kind: "design_plan" }> | undefined {
  const value = record.designPlanDecision;
  if (!isRecord(value) || value.kind !== "design_plan" || !Array.isArray(value.steps)) return undefined;
  return value as Extract<WfDesignPlanDecision, { readonly kind: "design_plan" }>;
}

function getStoredImplementationPlanDecision(
  record: Record<string, unknown>,
): Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }> | undefined {
  const value = record.implementationPlanDecision;
  if (!isRecord(value) || value.kind !== "implementation_plan" || !Array.isArray(value.stepPlans)) return undefined;
  return value as Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
}

function parseStoredWorkflowState(text: string): StoredWorkflowState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== WORKFLOW_STATE_SCHEMA_VERSION) return undefined;
  const status = getOptionalStoredString(parsed, "status");
  const stage = getOptionalStoredString(parsed, "stage");
  const createdAt = getOptionalStoredString(parsed, "createdAt");
  const updatedAt = getOptionalStoredString(parsed, "updatedAt");
  if (!isWorkflowStateStatus(status) || !isWorkflowStateStage(stage) || !createdAt || !updatedAt) return undefined;
  if (!isValidStoredWorkflowStateCombination(status, stage)) return undefined;

  const brainstormDecision = getStoredBrainstormDecision(parsed);
  const clarifiedPrompt = getOptionalStoredString(parsed, "clarifiedPrompt");
  const designPlanDecision = getStoredDesignPlanDecision(parsed);
  const finalReviewIteration = getOptionalStoredNumber(parsed, "finalReviewIteration");
  const implementationPlanArtifactPath = getOptionalStoredString(parsed, "implementationPlanArtifactPath");
  const implementationPlanDecision = getStoredImplementationPlanDecision(parsed);
  const implementationStepIndex = getOptionalStoredNumber(parsed, "implementationStepIndex");
  const originalPrompt = getOptionalStoredString(parsed, "originalPrompt");
  const prompts = getStoredPromptOptions(parsed);
  const questions = getStoredStringArray(parsed, "questions");
  const selectedOption = getStoredSelectedOption(parsed);

  return {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    status,
    stage,
    ...(brainstormDecision ? { brainstormDecision } : {}),
    ...(clarifiedPrompt ? { clarifiedPrompt } : {}),
    createdAt,
    ...(designPlanDecision ? { designPlanDecision } : {}),
    ...(finalReviewIteration !== undefined ? { finalReviewIteration } : {}),
    ...(implementationPlanArtifactPath ? { implementationPlanArtifactPath } : {}),
    ...(implementationPlanDecision ? { implementationPlanDecision } : {}),
    ...(implementationStepIndex !== undefined ? { implementationStepIndex } : {}),
    ...(originalPrompt ? { originalPrompt } : {}),
    ...(prompts ? { prompts } : {}),
    ...(questions ? { questions } : {}),
    ...(selectedOption ? { selectedOption } : {}),
    updatedAt,
  };
}

async function readStoredWorkflowState(cwd: string): Promise<StoredWorkflowState | undefined> {
  try {
    const { file } = getWorkflowStatePaths(cwd);
    return parseStoredWorkflowState(await readFile(file, "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeWorkflowStateFile(options: {
  readonly directory: string;
  readonly file: string;
  readonly state: StoredWorkflowState;
  readonly tempFile: string;
}): Promise<void> {
  await mkdir(options.directory, { recursive: true });
  await writeFile(options.tempFile, `${JSON.stringify(options.state, null, 2)}\n`, "utf8");
  await rename(options.tempFile, options.file);
}

async function writeStoredWorkflowState(cwd: string, state: StoredWorkflowState): Promise<void> {
  await writeWorkflowStateFile({ ...getWorkflowStatePaths(cwd), state });
}

async function archiveStoredWorkflowState(cwd: string, state: StoredWorkflowState): Promise<void> {
  await writeWorkflowStateFile({ ...getWorkflowArchivePaths(cwd, state), state });
}

async function removeStoredWorkflowState(cwd: string): Promise<void> {
  const { file } = getWorkflowStatePaths(cwd);
  await rm(file, { force: true });
}

export default function workflowModeExtension(pi: ExtensionAPI): void {
  let workflowModeEnabled = false;
  let workflowStarted = false;
  let workflowTerminalState: "complete" | "stopped" | undefined;
  let pendingClarification: PendingClarification | undefined;
  let pendingBrainstorming: PendingBrainstorming | undefined;
  let pendingDesignPlan: PendingDesignPlan | undefined;
  let pendingImpplanner: PendingImpplanner | undefined;
  let pendingImplementation: PendingImplementation | undefined;
  let pendingTesting: PendingTesting | undefined;
  let pendingFinalReview: PendingFinalReview | undefined;
  let pendingClarifierPromptSelection: PendingClarifierPromptSelection | undefined;
  let pendingBrainstormOptionSelection: PendingBrainstormOptionSelection | undefined;
  let resumeInjectedInput = false;
  let workflowStateCreatedAt: string | undefined;
  let latestWorkflowTreeSnapshot: WorkflowTreeSnapshot | undefined;
  let activeWorkflowTreeProgress: WorkflowTreeSnapshotOverrides | undefined;

  const getWorkflowTreeFieldsFromCurrentState = (): WorkflowTreeSnapshotOverrides => {
    if (pendingClarification) {
      return {
        currentSubagent: "wf-clarifier",
        loopLabel: "Clarification",
        originalPrompt: pendingClarification.originalPrompt,
        pendingPrompt: pendingClarification.originalPrompt,
        pendingQuestions: pendingClarification.questions,
        phaseLabel: "Waiting for clarification answers",
        stage: "clarification_questions",
        status: "waiting_for_answers",
      };
    }

    if (pendingClarifierPromptSelection) {
      const pendingPrompts = summarizeWorkflowTreePrompts(pendingClarifierPromptSelection.prompts);
      return {
        currentSubagent: "wf-clarifier",
        loopLabel: "Prompt selection",
        ...(pendingPrompts ? { pendingPrompts } : {}),
        phaseLabel: "Paused for prompt selection",
        stage: "clarifier_prompt_selection",
        status: "paused",
      };
    }

    if (pendingBrainstorming) {
      return {
        clarifiedPrompt: pendingBrainstorming.clarifiedPrompt,
        currentSubagent: "wf-brainstormer",
        loopLabel: "Brainstorming",
        pendingPrompt: pendingBrainstorming.clarifiedPrompt,
        pendingQuestions: pendingBrainstorming.questions,
        phaseLabel: "Waiting for brainstorming answers",
        stage: "brainstorming_questions",
        status: "waiting_for_answers",
      };
    }

    if (pendingBrainstormOptionSelection) {
      return {
        clarifiedPrompt: pendingBrainstormOptionSelection.clarifiedPrompt,
        currentSubagent: "wf-brainstormer",
        loopLabel: "Brainstorm option selection",
        pendingPrompt: pendingBrainstormOptionSelection.clarifiedPrompt,
        phaseLabel: "Paused for brainstorm option selection",
        stage: "brainstorm_option_selection",
        status: "paused",
      };
    }

    if (pendingDesignPlan) {
      const selectedOption = summarizeWorkflowTreeOption(pendingDesignPlan.selectedOption);
      return {
        clarifiedPrompt: pendingDesignPlan.clarifiedPrompt,
        currentSubagent: "wf-designplan",
        loopLabel: "Design planning",
        pendingPrompt: pendingDesignPlan.selectedOption.title,
        pendingQuestions: pendingDesignPlan.questions,
        phaseLabel: "Waiting for design-plan answers",
        ...(selectedOption ? { selectedOption } : {}),
        selectedOptionTitle: pendingDesignPlan.selectedOption.title,
        stage: "design_plan_questions",
        status: "waiting_for_answers",
      };
    }

    if (pendingImpplanner) {
      const selectedOption = summarizeWorkflowTreeOption(pendingImpplanner.selectedOption);
      return {
        clarifiedPrompt: pendingImpplanner.clarifiedPrompt,
        currentSubagent: "wf-impplanner",
        loopLabel: "Implementation planning",
        pendingPrompt: pendingImpplanner.designPlanDecision.objective,
        pendingQuestions: pendingImpplanner.questions,
        phaseLabel: "Waiting for implementation-plan answers",
        ...(selectedOption ? { selectedOption } : {}),
        selectedOptionTitle: pendingImpplanner.selectedOption.title,
        stage: "impplanner_questions",
        status: "waiting_for_answers",
      };
    }

    if (pendingImplementation) {
      const selectedOption = summarizeWorkflowTreeOption(pendingImplementation.selectedOption);
      return {
        clarifiedPrompt: pendingImplementation.clarifiedPrompt,
        currentSubagent: "wf-implementeragent",
        loopLabel: "Implementation",
        phaseLabel: "Paused at implementation stage",
        ...(selectedOption ? { selectedOption } : {}),
        selectedOptionTitle: pendingImplementation.selectedOption.title,
        stage: "implementation_stage",
        status: "paused",
        ...getWorkflowTreeImplementationFields({
          implementationPlanDecision: pendingImplementation.implementationPlanDecision,
          implementationStepIndex: pendingImplementation.stepIndex,
        }),
      };
    }

    if (pendingTesting) {
      const selectedOption = summarizeWorkflowTreeOption(pendingTesting.selectedOption);
      return {
        clarifiedPrompt: pendingTesting.clarifiedPrompt,
        currentSubagent: "wf-testeragent",
        finalReviewIteration: pendingTesting.finalReviewIteration,
        loopLabel: "Testing",
        phaseLabel: "Paused at testing pass",
        ...(selectedOption ? { selectedOption } : {}),
        selectedOptionTitle: pendingTesting.selectedOption.title,
        stage: "testing",
        status: "paused",
        ...getWorkflowTreeImplementationFields({
          implementationPlanDecision: pendingTesting.implementationPlanDecision,
          implementationStepIndex: pendingTesting.implementationPlanDecision.stepPlans.length,
        }),
      };
    }

    if (pendingFinalReview) {
      const selectedOption = summarizeWorkflowTreeOption(pendingFinalReview.selectedOption);
      return {
        clarifiedPrompt: pendingFinalReview.clarifiedPrompt,
        currentSubagent: "wf-finalreviewagent",
        finalReviewIteration: pendingFinalReview.finalReviewIteration,
        loopLabel: "Final review",
        phaseLabel: "Paused at final review",
        ...(selectedOption ? { selectedOption } : {}),
        selectedOptionTitle: pendingFinalReview.selectedOption.title,
        stage: "final_review",
        status: "paused",
        ...getWorkflowTreeImplementationFields({
          implementationPlanDecision: pendingFinalReview.implementationPlanDecision,
          implementationStepIndex: pendingFinalReview.implementationPlanDecision.stepPlans.length,
        }),
      };
    }

    if (workflowStarted && workflowTerminalState) {
      return {
        lifecycle: workflowTerminalState,
        phaseLabel: workflowTerminalState === "complete" ? "Workflow complete" : "Workflow stopped",
        stage: workflowTerminalState,
        status: workflowTerminalState,
        terminalStatus: workflowTerminalState,
      };
    }

    return {};
  };

  const getCurrentWorkflowTreeLifecycle = (): WorkflowTreeSnapshot["lifecycle"] => {
    if (workflowStarted && workflowTerminalState) return workflowTerminalState;
    if (pendingClarification || pendingBrainstorming || pendingDesignPlan || pendingImpplanner) return "waiting_for_user";
    if (pendingClarifierPromptSelection || pendingBrainstormOptionSelection || pendingImplementation || pendingTesting || pendingFinalReview) {
      return "paused";
    }
    if (workflowModeEnabled) return "waiting_for_initial_prompt";
    return "inactive";
  };

  const shouldShowWorkflowTreeForLifecycle = (lifecycle: WorkflowTreeSnapshot["lifecycle"]): boolean =>
    workflowModeEnabled &&
    (lifecycle === "waiting_for_initial_prompt" ||
      lifecycle === "waiting_for_user" ||
      lifecycle === "running" ||
      lifecycle === "paused" ||
      lifecycle === "error");

  const buildWorkflowTreeSnapshot = (
    source: string,
    overrides: WorkflowTreeSnapshotOverrides = {},
  ): WorkflowTreeSnapshot => {
    const currentFields = getWorkflowTreeFieldsFromCurrentState();
    const progressFields = workflowModeEnabled && activeWorkflowTreeProgress ? activeWorkflowTreeProgress : {};
    const merged = { ...currentFields, ...progressFields, ...overrides };
    const lifecycle = merged.lifecycle ?? getCurrentWorkflowTreeLifecycle();
    const hasState = merged.hasWorkflowState ?? (hasWorkflowState() || lifecycle === "running");
    const overlayVisible = merged.overlayVisible ?? shouldShowWorkflowTreeForLifecycle(lifecycle);
    const suppressContextTree = merged.suppressContextTree ?? overlayVisible;

    return {
      schemaVersion: WORKFLOW_TREE_SNAPSHOT_SCHEMA_VERSION,
      workflowModeEnabled,
      hasWorkflowState: hasState,
      lifecycle,
      overlayVisible,
      suppressContextTree,
      source,
      emittedAt: new Date().toISOString(),
      ...merged,
    };
  };

  const emitWorkflowTreeSnapshot = (snapshot: WorkflowTreeSnapshot): void => {
    latestWorkflowTreeSnapshot = snapshot;
    pi.events.emit(WORKFLOW_TREE_SNAPSHOT_EVENT, snapshot);
  };

  const publishWorkflowTreeSnapshot = (
    source: string,
    overrides: WorkflowTreeSnapshotOverrides = {},
  ): WorkflowTreeSnapshot => {
    const snapshot = buildWorkflowTreeSnapshot(source, overrides);
    emitWorkflowTreeSnapshot(snapshot);
    return snapshot;
  };

  const publishWorkflowTreeSnapshotFromStoredState = (
    source: string,
    state: StoredWorkflowState,
    overrides: WorkflowTreeSnapshotOverrides = {},
  ): WorkflowTreeSnapshot => {
    activeWorkflowTreeProgress = undefined;
    return publishWorkflowTreeSnapshot(source, {
      ...getWorkflowTreeFieldsFromStoredState(state),
      hasWorkflowState: true,
      lifecycle: getWorkflowTreeLifecycleFromStoredState(state),
      ...overrides,
    });
  };

  const publishWorkflowTreeProgressSnapshot = (
    source: string,
    overrides: WorkflowTreeSnapshotOverrides,
  ): WorkflowTreeSnapshot => {
    activeWorkflowTreeProgress = {
      hasWorkflowState: true,
      lifecycle: "running",
      overlayVisible: true,
      suppressContextTree: true,
      ...overrides,
    };
    return publishWorkflowTreeSnapshot(source, activeWorkflowTreeProgress);
  };

  const publishWorkflowTreeErrorSnapshot = (
    source: string,
    error: unknown,
    overrides: WorkflowTreeSnapshotOverrides = {},
  ): WorkflowTreeSnapshot => {
    activeWorkflowTreeProgress = undefined;
    const errorSummary = summarizeWorkflowTreeError(error);
    return publishWorkflowTreeSnapshot(source, {
      error: errorSummary,
      hasWorkflowState: hasWorkflowState(),
      lifecycle: "error",
      overlayVisible: true,
      suppressContextTree: true,
      terminalMessage: errorSummary.message,
      terminalStatus: "error",
      ...overrides,
    });
  };

  const getWorkflowTreeTerminalStatus = (state: StoredWorkflowState): WorkflowTreeTerminalStatus =>
    state.status === "complete" ? "complete" : "stopped";

  const publishWorkflowTreeTerminalBeforeArchive = (
    state: StoredWorkflowState,
    options: {
      readonly error?: unknown;
      readonly source: string;
      readonly terminalMessage?: string;
      readonly terminalStatus?: WorkflowTreeTerminalStatus;
      readonly visibleLifecycle?: WorkflowTreeSnapshot["lifecycle"];
    },
  ): void => {
    const terminalStatus = options.terminalStatus ?? getWorkflowTreeTerminalStatus(state);
    const errorSummary = options.error === undefined ? undefined : summarizeWorkflowTreeError(options.error);
    const terminalMessage = options.terminalMessage ?? errorSummary?.message;
    publishWorkflowTreeSnapshotFromStoredState(options.source, state, {
      ...(errorSummary ? { error: errorSummary } : {}),
      lifecycle: options.visibleLifecycle ?? terminalStatus,
      overlayVisible: true,
      suppressContextTree: true,
      ...(terminalMessage ? { terminalMessage } : {}),
      terminalStatus,
    });
  };

  const publishWorkflowTreeRestorationAfterArchive = (
    state: StoredWorkflowState,
    options: { readonly source: string; readonly terminalMessage?: string },
  ): void => {
    const terminalStatus = getWorkflowTreeTerminalStatus(state);
    publishWorkflowTreeSnapshotFromStoredState(options.source, state, {
      hasWorkflowState: hasWorkflowState(),
      lifecycle: terminalStatus,
      overlayVisible: false,
      suppressContextTree: false,
      ...(options.terminalMessage ? { terminalMessage: options.terminalMessage } : {}),
      terminalStatus,
    });
  };

  pi.events.on(WORKFLOW_TREE_QUERY_EVENT, () => {
    const currentSnapshot = buildWorkflowTreeSnapshot("workflowmode:query");
    const cachedHiddenSnapshot = latestWorkflowTreeSnapshot?.overlayVisible === false ? latestWorkflowTreeSnapshot : undefined;
    if (!workflowModeEnabled && !hasWorkflowState() && cachedHiddenSnapshot) {
      emitWorkflowTreeSnapshot({
        ...cachedHiddenSnapshot,
        source: "workflowmode:query:cached-hidden",
        emittedAt: new Date().toISOString(),
      });
      return;
    }
    emitWorkflowTreeSnapshot(currentSnapshot);
  });

  const statusText = (): string => {
    if (!workflowModeEnabled) return "off";
    if (pendingBrainstormOptionSelection) return "on; paused at brainstorm option selection";
    if (pendingClarifierPromptSelection) return "on; paused at prompt selection";
    if (pendingTesting) return `on; testing pass before final review ${pendingTesting.finalReviewIteration + 1}`;
    if (pendingFinalReview) return `on; final branch review pass ${pendingFinalReview.finalReviewIteration + 1}`;
    if (pendingImplementation) return `on; implementing stage ${pendingImplementation.stepIndex + 1} of ${pendingImplementation.implementationPlanDecision.stepPlans.length}`;
    if (pendingImpplanner) return "on; waiting for implementation-plan answers";
    if (pendingDesignPlan) return "on; waiting for design-plan answers";
    if (pendingBrainstorming) return "on; waiting for brainstorming answers";
    if (pendingClarification) return "on; waiting for clarification answers";
    if (workflowStarted) {
      return workflowTerminalState === "stopped" ? "on; workflow stopped" : "on; workflow implementation complete";
    }
    return "on; waiting for initial prompt";
  };

  const resetWorkflow = (): void => {
    workflowStarted = false;
    workflowTerminalState = undefined;
    pendingClarification = undefined;
    pendingBrainstorming = undefined;
    pendingDesignPlan = undefined;
    pendingImpplanner = undefined;
    pendingImplementation = undefined;
    pendingTesting = undefined;
    pendingFinalReview = undefined;
    pendingClarifierPromptSelection = undefined;
    pendingBrainstormOptionSelection = undefined;
    resumeInjectedInput = false;
    workflowStateCreatedAt = undefined;
    activeWorkflowTreeProgress = undefined;
  };

  const hasWorkflowState = (): boolean =>
    workflowStarted ||
    pendingClarification !== undefined ||
    pendingBrainstorming !== undefined ||
    pendingDesignPlan !== undefined ||
    pendingImpplanner !== undefined ||
    pendingImplementation !== undefined ||
    pendingTesting !== undefined ||
    pendingFinalReview !== undefined ||
    pendingClarifierPromptSelection !== undefined ||
    pendingBrainstormOptionSelection !== undefined;

  const createWorkflowState = (
    status: WorkflowStateStatus,
    stage: WorkflowStateStage,
    details: Omit<StoredWorkflowState, "createdAt" | "schemaVersion" | "stage" | "status" | "updatedAt"> = {},
  ): StoredWorkflowState => {
    const now = new Date().toISOString();
    workflowStateCreatedAt = workflowStateCreatedAt ?? now;
    return {
      schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
      status,
      stage,
      ...details,
      createdAt: workflowStateCreatedAt,
      updatedAt: now,
    };
  };

  const persistWorkflowState = async (ctx: ExtensionContext, state: StoredWorkflowState): Promise<void> => {
    try {
      await writeStoredWorkflowState(ctx.cwd, state);
      publishWorkflowTreeSnapshotFromStoredState("workflowmode:persist", state);
    } catch (error) {
      publishWorkflowTreeErrorSnapshot("workflowmode:persist:error", error, {
        ...getWorkflowTreeFieldsFromStoredState(state),
        hasWorkflowState: hasWorkflowState(),
      });
      ctx.ui.notify(`Workflow mode could not save local state: ${getErrorMessage(error)}`, "warning");
    }
  };

  const clearWorkflowStateFile = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await removeStoredWorkflowState(ctx.cwd);
    } catch (error) {
      ctx.ui.notify(`Workflow mode could not clear local state: ${getErrorMessage(error)}`, "warning");
    }
  };

  const archiveWorkflowState = async (
    ctx: ExtensionContext,
    state: StoredWorkflowState,
    options: { readonly error?: unknown; readonly source?: string; readonly terminalMessage?: string } = {},
  ): Promise<void> => {
    const terminalMessage = options.terminalMessage ?? (options.error === undefined ? undefined : getErrorMessage(options.error));
    publishWorkflowTreeTerminalBeforeArchive(state, {
      ...(options.error === undefined ? {} : { error: options.error, terminalStatus: "error" as const, visibleLifecycle: "error" as const }),
      source: options.source ?? "workflowmode:archive",
      ...(terminalMessage ? { terminalMessage } : {}),
    });

    try {
      await archiveStoredWorkflowState(ctx.cwd, state);
    } catch (error) {
      ctx.ui.notify(`Workflow mode could not archive local state: ${getErrorMessage(error)}`, "warning");
    }
    await clearWorkflowStateFile(ctx);
    publishWorkflowTreeRestorationAfterArchive(state, {
      source: `${options.source ?? "workflowmode:archive"}:restored`,
      ...(terminalMessage ? { terminalMessage } : {}),
    });
  };

  const restoreWorkflowState = async (ctx: ExtensionContext): Promise<boolean> => {
    if (hasWorkflowState()) {
      publishWorkflowTreeSnapshot("workflowmode:restore:memory");
      return true;
    }

    let state: StoredWorkflowState | undefined;
    try {
      state = await readStoredWorkflowState(ctx.cwd);
    } catch (error) {
      publishWorkflowTreeErrorSnapshot("workflowmode:restore:error", error, { hasWorkflowState: false });
      ctx.ui.notify(`Workflow mode could not read local state: ${getErrorMessage(error)}`, "warning");
      return false;
    }

    if (!state) return false;

    workflowStateCreatedAt = state.createdAt;
    workflowStarted = false;
    workflowTerminalState = undefined;
    pendingClarification = undefined;
    pendingBrainstorming = undefined;
    pendingDesignPlan = undefined;
    pendingImpplanner = undefined;
    pendingImplementation = undefined;
    pendingTesting = undefined;
    pendingFinalReview = undefined;
    pendingClarifierPromptSelection = undefined;
    pendingBrainstormOptionSelection = undefined;

    if (state.stage === "clarification_questions" && state.originalPrompt && state.questions?.length) {
      pendingClarification = { originalPrompt: state.originalPrompt, questions: state.questions };
    } else if (state.stage === "clarifier_prompt_selection" && state.prompts?.length) {
      pendingClarifierPromptSelection = { prompts: state.prompts };
    } else if (state.stage === "brainstorming_questions" && state.clarifiedPrompt && state.questions?.length) {
      pendingBrainstorming = { clarifiedPrompt: state.clarifiedPrompt, questions: state.questions };
    } else if (state.stage === "brainstorm_option_selection" && state.brainstormDecision && state.clarifiedPrompt) {
      pendingBrainstormOptionSelection = {
        brainstormDecision: state.brainstormDecision as Extract<WfBrainstormerDecision, { kind: "brainstorm" }>,
        clarifiedPrompt: state.clarifiedPrompt,
      };
    } else if (
      state.stage === "design_plan_questions" &&
      state.brainstormDecision &&
      state.clarifiedPrompt &&
      state.questions?.length &&
      state.selectedOption
    ) {
      pendingDesignPlan = {
        brainstormDecision: state.brainstormDecision,
        clarifiedPrompt: state.clarifiedPrompt,
        questions: state.questions,
        selectedOption: state.selectedOption,
      };
    } else if (
      state.stage === "impplanner_questions" &&
      state.brainstormDecision &&
      state.clarifiedPrompt &&
      state.designPlanDecision &&
      state.questions?.length &&
      state.selectedOption
    ) {
      pendingImpplanner = {
        brainstormDecision: state.brainstormDecision,
        clarifiedPrompt: state.clarifiedPrompt,
        designPlanDecision: state.designPlanDecision,
        questions: state.questions,
        selectedOption: state.selectedOption,
      };
    } else if (
      state.stage === "implementation_stage" &&
      state.brainstormDecision &&
      state.clarifiedPrompt &&
      state.designPlanDecision &&
      state.implementationPlanDecision &&
      state.selectedOption
    ) {
      pendingImplementation = {
        brainstormDecision: state.brainstormDecision,
        clarifiedPrompt: state.clarifiedPrompt,
        designPlanDecision: state.designPlanDecision,
        ...(state.implementationPlanArtifactPath ? { implementationPlanArtifactPath: state.implementationPlanArtifactPath } : {}),
        implementationPlanDecision: state.implementationPlanDecision,
        selectedOption: state.selectedOption,
        stepIndex: state.implementationStepIndex ?? 0,
      };
    } else if (
      state.stage === "testing" &&
      state.brainstormDecision &&
      state.clarifiedPrompt &&
      state.designPlanDecision &&
      state.implementationPlanDecision &&
      state.selectedOption
    ) {
      pendingTesting = {
        brainstormDecision: state.brainstormDecision,
        clarifiedPrompt: state.clarifiedPrompt,
        designPlanDecision: state.designPlanDecision,
        finalReviewIteration: state.finalReviewIteration ?? 0,
        ...(state.implementationPlanArtifactPath ? { implementationPlanArtifactPath: state.implementationPlanArtifactPath } : {}),
        implementationPlanDecision: state.implementationPlanDecision,
        selectedOption: state.selectedOption,
      };
    } else if (
      state.stage === "final_review" &&
      state.brainstormDecision &&
      state.clarifiedPrompt &&
      state.designPlanDecision &&
      state.implementationPlanDecision &&
      state.selectedOption
    ) {
      pendingFinalReview = {
        brainstormDecision: state.brainstormDecision,
        clarifiedPrompt: state.clarifiedPrompt,
        designPlanDecision: state.designPlanDecision,
        finalReviewIteration: state.finalReviewIteration ?? 0,
        ...(state.implementationPlanArtifactPath ? { implementationPlanArtifactPath: state.implementationPlanArtifactPath } : {}),
        implementationPlanDecision: state.implementationPlanDecision,
        selectedOption: state.selectedOption,
      };
    } else if (state.stage === "complete") {
      workflowStarted = true;
      workflowTerminalState = "complete";
    } else if (state.stage === "stopped") {
      workflowStarted = true;
      workflowTerminalState = "stopped";
    } else {
      return false;
    }

    workflowModeEnabled = true;
    activeWorkflowTreeProgress = undefined;
    publishWorkflowTreeSnapshot("workflowmode:restore");
    return true;
  };

  const toggleWorkflowMode = (): void => {
    workflowModeEnabled = !workflowModeEnabled;
    resetWorkflow();
  };

  pi.registerCommand("workflowmode", {
    description: "Toggle, reset, resume, inspect workflow mode, or set every wf-* child model.",
    getArgumentCompletions: getWorkflowModeCommandCompletions,
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [command = "", ...rest] = trimmed.split(/\s+/u);
      const action = command.toLowerCase();

      if (action === "on") {
        workflowModeEnabled = true;
        resetWorkflow();
        await clearWorkflowStateFile(ctx);
        publishWorkflowTreeSnapshot("workflowmode:command:on");
      } else if (action === "off") {
        workflowModeEnabled = false;
        resetWorkflow();
        await clearWorkflowStateFile(ctx);
        publishWorkflowTreeSnapshot("workflowmode:command:off");
      } else if (action === "status") {
        const restored = await restoreWorkflowState(ctx);
        if (!restored) publishWorkflowTreeSnapshot("workflowmode:command:status");
      } else if (action === "reset") {
        resetWorkflow();
        await clearWorkflowStateFile(ctx);
        publishWorkflowTreeSnapshot("workflowmode:command:reset");
      } else if (action === "resume" || action === "continue") {
        const restored = await restoreWorkflowState(ctx);
        if (!restored || !hasWorkflowState()) {
          publishWorkflowTreeSnapshot(`workflowmode:command:${action}`);
          ctx.ui.notify("Workflow mode: no saved workflow to resume", "info");
          return;
        }
        workflowModeEnabled = true;
        if (pendingClarifierPromptSelection || pendingBrainstormOptionSelection || pendingImplementation || pendingTesting || pendingFinalReview) {
          resumeInjectedInput = true;
          pi.sendUserMessage("resume workflow", { deliverAs: "followUp" });
          ctx.ui.notify("Workflow mode: resuming saved workflow", "info");
          return;
        }
      } else if (action === "model" || action === "models") {
        await selectAllWorkflowAgentModels(pi, ctx, rest.join(" "));
        return;
      } else {
        toggleWorkflowMode();
        await clearWorkflowStateFile(ctx);
        publishWorkflowTreeSnapshot("workflowmode:command:toggle");
      }

      ctx.ui.notify(`Workflow mode: ${statusText()}`, "info");
    },
  });

  pi.registerShortcut("alt+w", {
    description: "Toggle workflow mode",
    handler: async (ctx) => {
      toggleWorkflowMode();
      await clearWorkflowStateFile(ctx);
      publishWorkflowTreeSnapshot("workflowmode:shortcut:alt+w");
      ctx.ui.notify(`Workflow mode: ${statusText()}`, "info");
    },
  });

  pi.on("input", async (event, ctx): Promise<InputHookResult> => {
    const publishAgentProgress = (source: string, options: {
      readonly currentSubagent: string;
      readonly finalReviewIteration?: number;
      readonly implementationStepIndex?: number;
      readonly implementationStepTitle?: string;
      readonly implementationStepTotal?: number;
      readonly loopLabel: string;
      readonly phaseLabel: string;
      readonly progress?: { readonly toolCalls: number; readonly turns: number };
      readonly stage?: WorkflowTreeStage;
    }): void => {
      publishWorkflowTreeProgressSnapshot(source, {
        currentSubagent: options.currentSubagent,
        loopLabel: options.loopLabel,
        phaseLabel: options.phaseLabel,
        progress: buildWorkflowTreeProgress(options.phaseLabel, options.progress),
        ...(options.finalReviewIteration !== undefined ? { finalReviewIteration: options.finalReviewIteration } : {}),
        ...(options.implementationStepIndex !== undefined ? { implementationStepIndex: options.implementationStepIndex } : {}),
        ...(options.implementationStepTitle ? { implementationStepTitle: options.implementationStepTitle } : {}),
        ...(options.implementationStepTotal !== undefined ? { implementationStepTotal: options.implementationStepTotal } : {}),
        ...(options.stage ? { stage: options.stage } : {}),
      });
    };

    const runReviewGate = async (options: {
      readonly expectedOutputSchema: string;
      readonly originalPrompt: string;
      readonly stageContext: string;
      readonly stageId: string;
      readonly stageOutput: string;
      readonly stageReport: string;
    }): Promise<unknown | undefined> => {
      ctx.ui.setStatus(STATUS_KEY, `reviewing ${options.stageId}: ${previewTask(options.originalPrompt)}`);
      publishAgentProgress("workflowmode:progress:review-gate", {
        currentSubagent: "wf-adversarialreview",
        loopLabel: options.stageId,
        phaseLabel: `Reviewing ${options.stageId}`,
      });

      try {
        const review = await runWfAdversarialReviewForStage({
          ctx,
          expectedOutputSchema: options.expectedOutputSchema,
          originalPrompt: options.originalPrompt,
          pi,
          stageContext: options.stageContext,
          stageId: options.stageId,
          stageOutput: options.stageOutput,
          stageReport: options.stageReport,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `reviewing ${options.stageId}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
            publishAgentProgress("workflowmode:progress:review-gate", {
              currentSubagent: "wf-adversarialreview",
              loopLabel: options.stageId,
              phaseLabel: `Reviewing ${options.stageId}`,
              progress,
            });
          },
        });

        sendWfAdversarialReviewReportMessage(pi, ctx, review);

        if (!review.decision?.reviewedOutput || review.decision.verdict === "blocked") {
          ctx.ui.notify(
            `Workflow adversarial review did not provide usable reviewed output for ${options.stageId}; showing original stage output.`,
            "warning",
          );
          return undefined;
        }

        return review.decision.reviewedOutput;
      } catch (error) {
        ctx.ui.notify(
          `Workflow adversarial review failed for ${options.stageId}: ${getErrorMessage(error)}. Showing original stage output.`,
          "warning",
        );
        return undefined;
      }
    };

    const reviewBrainstormerRun = async (
      run: WfBrainstormerRunResult,
      clarifiedPrompt: string,
    ): Promise<WfBrainstormerRunResult> => {
      if (run.decision?.kind === "questions") return run;

      const reviewedOutput = await runReviewGate({
        expectedOutputSchema: WF_BRAINSTORMER_STAGE_SCHEMA,
        originalPrompt: clarifiedPrompt,
        stageContext:
          "This is the final wf-brainstormer output for workflow mode. Review it before the brainstorm report is displayed to the user or consumed by wf-designplan.",
        stageId: "wf-brainstormer",
        stageOutput: run.decision ? JSON.stringify(run.decision, null, 2) : run.result.output,
        stageReport: run.report,
      });
      if (reviewedOutput === undefined) return run;

      const reviewedDecision = parseWfBrainstormerDecision(stringifyReviewedOutput(reviewedOutput));
      if (!reviewedDecision || reviewedDecision.kind !== "brainstorm") {
        ctx.ui.notify(
          "Workflow adversarial review returned output that does not match the brainstormer schema; showing original brainstorm output.",
          "warning",
        );
        return run;
      }

      const report = formatWfBrainstormerDecisionReport({
        config: run.config,
        decision: reviewedDecision,
        result: run.result,
      });
      return { ...run, decision: reviewedDecision, report };
    };

    const createFinalReviewFallbackRemediation = (
      decision: WfFinalReviewAgentDecision,
    ): WfFinalReviewRemediationStep => ({
      highPriorityTests: decision.testsRun.length > 0 ? decision.testsRun : ["Run the most relevant targeted validation after applying the final-review fixes."],
      instructions: [
        decision.feedback ?? decision.summary ?? "Address the final review findings.",
        ...decision.issues.map((issue) => `${issue.title}: ${issue.detail}${issue.suggestion ? ` Suggested fix: ${issue.suggestion}` : ""}`),
      ].filter(Boolean),
      objective: decision.feedback ?? decision.summary ?? "Address final review findings so the branch can pass final review.",
      risks: decision.issues
        .filter((issue) => issue.severity === "major" || issue.severity === "critical")
        .map((issue) => `${issue.severity}: ${issue.title}`),
      title: "Address final review findings",
      touchpoints: [],
      validation: decision.testsRun.length > 0 ? decision.testsRun : ["Run targeted checks for the final-review remediation."],
    });

    const remediationStepToImpplannerStep = (
      remediation: WfFinalReviewRemediationStep,
      remediationIndex: number,
    ): WfImpplannerStepPlan => ({
      checkpoints: ["Stop after this remediation is complete and wait for wf-revieweragent approval before another final review."],
      dependencies: ["All planned implementation stages have passed per-stage review; this is final-review remediation."],
      examples: [],
      highPriorityTests: remediation.highPriorityTests,
      instructions: remediation.instructions,
      objective: remediation.objective,
      risks: remediation.risks,
      sourceDesignStepTitle: `Final review remediation ${remediationIndex + 1}`,
      title: remediation.title,
      touchpoints: remediation.touchpoints,
      validation: remediation.validation,
    });

    const testerDecisionToReviewerInput = (
      decision: Extract<WfTesterAgentDecision, { readonly kind: "tested_changes" }>,
    ): WfImplementerAgentDecision => ({
      changedFiles: decision.changedFiles,
      kind: "implemented_stage",
      ...(decision.notes ? { notes: decision.notes } : {}),
      stageTitle: "Testing gap coverage",
      summary: decision.summary,
      testsRun: decision.testsRun,
      validation: decision.validation,
    });

    const testingStepPlan = (
      decision: Extract<WfTesterAgentDecision, { readonly kind: "tested_changes" }>,
    ): WfImpplannerStepPlan => ({
      checkpoints: ["Stop after testing-gap changes pass wf-revieweragent before final branch review starts."],
      dependencies: ["All planned implementation stages have passed per-stage review."],
      examples: [],
      highPriorityTests: decision.testsAdded.length > 0 ? decision.testsAdded : decision.testsRun,
      instructions: [
        "Review the tests added or updated by wf-testeragent for relevance, maintainability, and alignment with the branch changes.",
        ...decision.gapsFound.map((gap) => `Covered gap: ${gap}`),
      ],
      objective: "Fill reasonable test gaps before whole-branch final review.",
      risks: [],
      sourceDesignStepTitle: "Pre-final-review testing pass",
      title: "Testing gap coverage",
      touchpoints: decision.changedFiles,
      validation: decision.validation.length > 0 ? decision.validation : decision.testsRun,
    });

    const runTestingLoop = async (options: PendingTesting): Promise<InputHookResult> => {
      const stateDetails = () => ({
        brainstormDecision: options.brainstormDecision,
        clarifiedPrompt: options.clarifiedPrompt,
        designPlanDecision: options.designPlanDecision,
        finalReviewIteration: options.finalReviewIteration,
        ...(options.implementationPlanArtifactPath
          ? { implementationPlanArtifactPath: options.implementationPlanArtifactPath }
          : {}),
        implementationPlanDecision: options.implementationPlanDecision,
        implementationStepIndex: options.implementationPlanDecision.stepPlans.length,
        selectedOption: options.selectedOption,
      });

      try {
        pendingTesting = options;
        pendingFinalReview = undefined;
        await persistWorkflowState(ctx, createWorkflowState("paused", "testing", stateDetails()));

        let reviewerFeedback: string | undefined;
        let testingAttempt = 1;
        while (true) {
          ctx.ui.setStatus(
            STATUS_KEY,
            `testing gaps before final review ${options.finalReviewIteration + 1}: ${previewTask(options.selectedOption.title)}`,
          );
          publishAgentProgress("workflowmode:progress:testing", {
            currentSubagent: "wf-testeragent",
            finalReviewIteration: options.finalReviewIteration,
            implementationStepIndex: options.implementationPlanDecision.stepPlans.length,
            implementationStepTotal: options.implementationPlanDecision.stepPlans.length,
            loopLabel: "Testing",
            phaseLabel: `Testing gaps before final review ${options.finalReviewIteration + 1}`,
            stage: "testing",
          });
          const testerRun = await runWfTesterAgentForBranch({
            ctx,
            finalReviewIteration: options.finalReviewIteration,
            implementationPlan: options.implementationPlanDecision,
            implementationPlanArtifactPath: options.implementationPlanArtifactPath,
            pi,
            reviewerFeedback,
            testingAttempt,
            onProgress: (progress) => {
              const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
              ctx.ui.setStatus(
                STATUS_KEY,
                `testing gaps before final review ${options.finalReviewIteration + 1}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
              );
              publishAgentProgress("workflowmode:progress:testing", {
                currentSubagent: "wf-testeragent",
                finalReviewIteration: options.finalReviewIteration,
                implementationStepIndex: options.implementationPlanDecision.stepPlans.length,
                implementationStepTotal: options.implementationPlanDecision.stepPlans.length,
                loopLabel: "Testing",
                phaseLabel: `Testing gaps before final review ${options.finalReviewIteration + 1}`,
                progress,
                stage: "testing",
              });
            },
          });
          sendWfTesterAgentReportMessage(pi, ctx, testerRun);

          if (!testerRun.decision) {
            workflowStarted = true;
            workflowTerminalState = "stopped";
            pendingTesting = undefined;
            await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails()));
            ctx.ui.notify("wf-testeragent did not return parseable JSON; workflow stopped.", "error");
            return { action: "handled" };
          }

          if (testerRun.decision.kind === "questions") {
            workflowStarted = true;
            workflowTerminalState = "stopped";
            pendingTesting = undefined;
            await archiveWorkflowState(
              ctx,
              createWorkflowState("stopped", "stopped", {
                ...stateDetails(),
                questions: testerRun.decision.questions,
              }),
            );
            ctx.ui.notify(
              "wf-testeragent needs user input during the testing pass; workflow stopped with its questions in the report.",
              "warning",
            );
            return { action: "handled" };
          }

          if (testerRun.decision.kind === "blocked") {
            workflowStarted = true;
            workflowTerminalState = "stopped";
            pendingTesting = undefined;
            await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails()));
            ctx.ui.notify(`wf-testeragent blocked the testing pass: ${testerRun.decision.reason}`, "error");
            return { action: "handled" };
          }

          if (testerRun.decision.kind === "no_test_gaps") {
            ctx.ui.notify("wf-testeragent found no additional reasonable test gaps; starting whole-branch final review.", "info");
            break;
          }

          const reviewerStepPlan = testingStepPlan(testerRun.decision);
          ctx.ui.setStatus(STATUS_KEY, `reviewing testing pass: ${previewTask(reviewerStepPlan.title)}`);
          publishAgentProgress("workflowmode:progress:testing-review", {
            currentSubagent: "wf-revieweragent",
            finalReviewIteration: options.finalReviewIteration,
            implementationStepIndex: options.implementationPlanDecision.stepPlans.length,
            implementationStepTitle: reviewerStepPlan.title,
            implementationStepTotal: options.implementationPlanDecision.stepPlans.length + 1,
            loopLabel: "Testing review",
            phaseLabel: "Reviewing testing pass",
            stage: "testing",
          });
          const reviewerRun = await runWfReviewerAgentForStage({
            attempt: testingAttempt,
            ctx,
            implementationPlan: options.implementationPlanDecision,
            implementationPlanArtifactPath: options.implementationPlanArtifactPath,
            implementerDecision: testerDecisionToReviewerInput(testerRun.decision),
            implementerReport: testerRun.report,
            pi,
            previousFeedback: reviewerFeedback,
            stepIndex: options.implementationPlanDecision.stepPlans.length,
            stepPlan: reviewerStepPlan,
            totalSteps: options.implementationPlanDecision.stepPlans.length + 1,
            onProgress: (progress) => {
              const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
              ctx.ui.setStatus(
                STATUS_KEY,
                `reviewing testing pass: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
              );
              publishAgentProgress("workflowmode:progress:testing-review", {
                currentSubagent: "wf-revieweragent",
                finalReviewIteration: options.finalReviewIteration,
                implementationStepIndex: options.implementationPlanDecision.stepPlans.length,
                implementationStepTitle: reviewerStepPlan.title,
                implementationStepTotal: options.implementationPlanDecision.stepPlans.length + 1,
                loopLabel: "Testing review",
                phaseLabel: "Reviewing testing pass",
                progress,
                stage: "testing",
              });
            },
          });
          sendWfReviewerAgentReportMessage(pi, ctx, reviewerRun);

          if (!reviewerRun.decision) {
            workflowStarted = true;
            workflowTerminalState = "stopped";
            pendingTesting = undefined;
            await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails()));
            ctx.ui.notify("wf-revieweragent did not return parseable JSON for the testing pass; workflow stopped.", "error");
            return { action: "handled" };
          }

          if (reviewerRun.decision.greenSignal && reviewerRun.decision.verdict === "pass") {
            ctx.ui.notify("wf-revieweragent approved the testing pass; starting whole-branch final review.", "info");
            break;
          }

          if (reviewerRun.decision.verdict === "blocked") {
            workflowStarted = true;
            workflowTerminalState = "stopped";
            pendingTesting = undefined;
            await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails()));
            ctx.ui.notify("wf-revieweragent blocked the testing pass; workflow stopped.", "error");
            return { action: "handled" };
          }

          reviewerFeedback = formatWfReviewerAgentFeedback(reviewerRun.decision);
          testingAttempt += 1;
          ctx.ui.notify("wf-revieweragent requested changes to the testing pass; sending feedback back to wf-testeragent.", "warning");
        }

        pendingTesting = undefined;
        pendingFinalReview = {
          brainstormDecision: options.brainstormDecision,
          clarifiedPrompt: options.clarifiedPrompt,
          designPlanDecision: options.designPlanDecision,
          finalReviewIteration: options.finalReviewIteration,
          ...(options.implementationPlanArtifactPath
            ? { implementationPlanArtifactPath: options.implementationPlanArtifactPath }
            : {}),
          implementationPlanDecision: options.implementationPlanDecision,
          selectedOption: options.selectedOption,
        };
        await persistWorkflowState(ctx, createWorkflowState("paused", "final_review", stateDetails()));
        return await runFinalReviewLoop(pendingFinalReview);
      } catch (error) {
        workflowStarted = true;
        workflowTerminalState = "stopped";
        pendingTesting = undefined;
        await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails()), {
          error,
          source: "workflowmode:testing:error",
        });
        ctx.ui.notify(`Workflow testing pass failed: ${getErrorMessage(error)}. Use /workflowmode reset to retry.`, "error");
        return { action: "handled" };
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    const runFinalReviewLoop = async (options: PendingFinalReview): Promise<InputHookResult> => {
      let finalReviewIteration = Math.max(options.finalReviewIteration, 0);

      const stateDetails = (iteration: number) => ({
        brainstormDecision: options.brainstormDecision,
        clarifiedPrompt: options.clarifiedPrompt,
        designPlanDecision: options.designPlanDecision,
        finalReviewIteration: iteration,
        ...(options.implementationPlanArtifactPath
          ? { implementationPlanArtifactPath: options.implementationPlanArtifactPath }
          : {}),
        implementationPlanDecision: options.implementationPlanDecision,
        implementationStepIndex: options.implementationPlanDecision.stepPlans.length,
        selectedOption: options.selectedOption,
      });

      try {
        while (true) {
          pendingFinalReview = { ...options, finalReviewIteration };
          pendingImplementation = undefined;
          pendingTesting = undefined;
          await persistWorkflowState(
            ctx,
            createWorkflowState("paused", "final_review", stateDetails(finalReviewIteration)),
          );

          ctx.ui.setStatus(
            STATUS_KEY,
            `final branch review pass ${finalReviewIteration + 1}: ${previewTask(options.selectedOption.title)}`,
          );
          publishAgentProgress("workflowmode:progress:final-review", {
            currentSubagent: "wf-finalreviewagent",
            finalReviewIteration,
            implementationStepIndex: options.implementationPlanDecision.stepPlans.length,
            implementationStepTotal: options.implementationPlanDecision.stepPlans.length,
            loopLabel: "Final review",
            phaseLabel: `Final branch review pass ${finalReviewIteration + 1}`,
            stage: "final_review",
          });
          const finalReviewRun = await runWfFinalReviewAgentForBranch({
            ctx,
            finalReviewIteration,
            implementationPlan: options.implementationPlanDecision,
            implementationPlanArtifactPath: options.implementationPlanArtifactPath,
            pi,
            onProgress: (progress) => {
              const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
              ctx.ui.setStatus(
                STATUS_KEY,
                `final branch review pass ${finalReviewIteration + 1}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
              );
              publishAgentProgress("workflowmode:progress:final-review", {
                currentSubagent: "wf-finalreviewagent",
                finalReviewIteration,
                implementationStepIndex: options.implementationPlanDecision.stepPlans.length,
                implementationStepTotal: options.implementationPlanDecision.stepPlans.length,
                loopLabel: "Final review",
                phaseLabel: `Final branch review pass ${finalReviewIteration + 1}`,
                progress,
                stage: "final_review",
              });
            },
          });
          sendWfFinalReviewAgentReportMessage(pi, ctx, finalReviewRun);

          if (!finalReviewRun.decision) {
            workflowStarted = true;
            workflowTerminalState = "stopped";
            pendingFinalReview = undefined;
            await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(finalReviewIteration)));
            ctx.ui.notify("wf-finalreviewagent did not return a parseable final review; workflow stopped.", "error");
            return { action: "handled" };
          }

          if (finalReviewRun.decision.greenSignal && finalReviewRun.decision.verdict === "pass") {
            workflowStarted = true;
            workflowTerminalState = "complete";
            pendingFinalReview = undefined;
            pendingImplementation = undefined;
            pendingTesting = undefined;
            pendingImpplanner = undefined;
            await archiveWorkflowState(ctx, createWorkflowState("complete", "complete", stateDetails(finalReviewIteration)));
            ctx.ui.notify("Workflow mode complete; final branch review returned a green signal.", "info");
            return { action: "handled" };
          }

          if (finalReviewRun.decision.verdict === "blocked") {
            workflowStarted = true;
            workflowTerminalState = "stopped";
            pendingFinalReview = undefined;
            await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(finalReviewIteration)));
            ctx.ui.notify("wf-finalreviewagent blocked final review; workflow stopped. See final review report for details.", "error");
            return { action: "handled" };
          }

          const remediationSteps = finalReviewRun.decision.remediationSteps.length > 0
            ? finalReviewRun.decision.remediationSteps
            : [createFinalReviewFallbackRemediation(finalReviewRun.decision)];
          const finalReviewFeedback = formatWfFinalReviewAgentFeedback(finalReviewRun.decision);
          ctx.ui.notify(
            `wf-finalreviewagent requested ${remediationSteps.length} remediation step${remediationSteps.length === 1 ? "" : "s"}; dispatching implementer/reviewer loops before final review retries.`,
            "warning",
          );

          for (const [remediationIndex, remediation] of remediationSteps.entries()) {
            const stepPlan = remediationStepToImpplannerStep(remediation, remediationIndex);
            const syntheticStepIndex = options.implementationPlanDecision.stepPlans.length + remediationIndex;
            const syntheticTotalSteps = options.implementationPlanDecision.stepPlans.length + remediationSteps.length;
            let reviewerFeedback: string | undefined = finalReviewFeedback;
            let attempt = 1;

            while (true) {
              ctx.ui.setStatus(
                STATUS_KEY,
                `implementing final-review remediation ${remediationIndex + 1}/${remediationSteps.length}: ${previewTask(stepPlan.title)}`,
              );
              publishAgentProgress("workflowmode:progress:final-review-remediation", {
                currentSubagent: "wf-implementeragent",
                finalReviewIteration,
                implementationStepIndex: syntheticStepIndex,
                implementationStepTitle: stepPlan.title,
                implementationStepTotal: syntheticTotalSteps,
                loopLabel: "Final-review remediation",
                phaseLabel: `Implementing final-review remediation ${remediationIndex + 1}/${remediationSteps.length}`,
                stage: "final_review",
              });
              const implementerRun = await runWfImplementerAgentForStage({
                attempt,
                ctx,
                implementationPlan: options.implementationPlanDecision,
                implementationPlanArtifactPath: options.implementationPlanArtifactPath,
                pi,
                reviewerFeedback,
                stepIndex: syntheticStepIndex,
                stepPlan,
                totalSteps: syntheticTotalSteps,
                onProgress: (progress) => {
                  const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
                  ctx.ui.setStatus(
                    STATUS_KEY,
                    `implementing final-review remediation ${remediationIndex + 1}/${remediationSteps.length}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
                  );
                  publishAgentProgress("workflowmode:progress:final-review-remediation", {
                    currentSubagent: "wf-implementeragent",
                    finalReviewIteration,
                    implementationStepIndex: syntheticStepIndex,
                    implementationStepTitle: stepPlan.title,
                    implementationStepTotal: syntheticTotalSteps,
                    loopLabel: "Final-review remediation",
                    phaseLabel: `Implementing final-review remediation ${remediationIndex + 1}/${remediationSteps.length}`,
                    progress,
                    stage: "final_review",
                  });
                },
              });
              sendWfImplementerAgentReportMessage(pi, ctx, implementerRun);

              if (!implementerRun.decision) {
                workflowStarted = true;
                workflowTerminalState = "stopped";
                pendingFinalReview = undefined;
                await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(finalReviewIteration)));
                ctx.ui.notify("wf-implementeragent did not return parseable JSON during final-review remediation; workflow stopped.", "error");
                return { action: "handled" };
              }

              if (implementerRun.decision.kind === "questions") {
                workflowStarted = true;
                workflowTerminalState = "stopped";
                pendingFinalReview = undefined;
                await archiveWorkflowState(
                  ctx,
                  createWorkflowState("stopped", "stopped", {
                    ...stateDetails(finalReviewIteration),
                    questions: implementerRun.decision.questions,
                  }),
                );
                ctx.ui.notify(
                  "wf-implementeragent needs user input during final-review remediation; workflow stopped with its questions in the report.",
                  "warning",
                );
                return { action: "handled" };
              }

              if (implementerRun.decision.kind === "blocked") {
                workflowStarted = true;
                workflowTerminalState = "stopped";
                pendingFinalReview = undefined;
                await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(finalReviewIteration)));
                ctx.ui.notify(`wf-implementeragent blocked final-review remediation: ${implementerRun.decision.reason}`, "error");
                return { action: "handled" };
              }

              ctx.ui.setStatus(
                STATUS_KEY,
                `reviewing final-review remediation ${remediationIndex + 1}/${remediationSteps.length}: ${previewTask(stepPlan.title)}`,
              );
              publishAgentProgress("workflowmode:progress:final-review-remediation-review", {
                currentSubagent: "wf-revieweragent",
                finalReviewIteration,
                implementationStepIndex: syntheticStepIndex,
                implementationStepTitle: stepPlan.title,
                implementationStepTotal: syntheticTotalSteps,
                loopLabel: "Final-review remediation review",
                phaseLabel: `Reviewing final-review remediation ${remediationIndex + 1}/${remediationSteps.length}`,
                stage: "final_review",
              });
              const reviewerRun = await runWfReviewerAgentForStage({
                attempt,
                ctx,
                implementationPlan: options.implementationPlanDecision,
                implementationPlanArtifactPath: options.implementationPlanArtifactPath,
                implementerDecision: implementerRun.decision,
                implementerReport: implementerRun.report,
                pi,
                previousFeedback: reviewerFeedback,
                stepIndex: syntheticStepIndex,
                stepPlan,
                totalSteps: syntheticTotalSteps,
                onProgress: (progress) => {
                  const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
                  ctx.ui.setStatus(
                    STATUS_KEY,
                    `reviewing final-review remediation ${remediationIndex + 1}/${remediationSteps.length}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
                  );
                  publishAgentProgress("workflowmode:progress:final-review-remediation-review", {
                    currentSubagent: "wf-revieweragent",
                    finalReviewIteration,
                    implementationStepIndex: syntheticStepIndex,
                    implementationStepTitle: stepPlan.title,
                    implementationStepTotal: syntheticTotalSteps,
                    loopLabel: "Final-review remediation review",
                    phaseLabel: `Reviewing final-review remediation ${remediationIndex + 1}/${remediationSteps.length}`,
                    progress,
                    stage: "final_review",
                  });
                },
              });
              sendWfReviewerAgentReportMessage(pi, ctx, reviewerRun);

              if (!reviewerRun.decision) {
                workflowStarted = true;
                workflowTerminalState = "stopped";
                pendingFinalReview = undefined;
                await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(finalReviewIteration)));
                ctx.ui.notify("wf-revieweragent did not return parseable JSON for final-review remediation; workflow stopped.", "error");
                return { action: "handled" };
              }

              if (reviewerRun.decision.greenSignal && reviewerRun.decision.verdict === "pass") {
                ctx.ui.notify(
                  `wf-revieweragent approved final-review remediation ${remediationIndex + 1}/${remediationSteps.length}.`,
                  "info",
                );
                break;
              }

              if (reviewerRun.decision.verdict === "blocked") {
                workflowStarted = true;
                workflowTerminalState = "stopped";
                pendingFinalReview = undefined;
                await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(finalReviewIteration)));
                ctx.ui.notify("wf-revieweragent blocked final-review remediation; workflow stopped.", "error");
                return { action: "handled" };
              }

              reviewerFeedback = formatWfReviewerAgentFeedback(reviewerRun.decision);
              attempt += 1;
              ctx.ui.notify(
                `wf-revieweragent requested changes for final-review remediation ${remediationIndex + 1}; sending feedback back to wf-implementeragent.`,
                "warning",
              );
            }
          }

          finalReviewIteration += 1;
          pendingFinalReview = undefined;
          pendingTesting = {
            brainstormDecision: options.brainstormDecision,
            clarifiedPrompt: options.clarifiedPrompt,
            designPlanDecision: options.designPlanDecision,
            finalReviewIteration,
            ...(options.implementationPlanArtifactPath
              ? { implementationPlanArtifactPath: options.implementationPlanArtifactPath }
              : {}),
            implementationPlanDecision: options.implementationPlanDecision,
            selectedOption: options.selectedOption,
          };
          ctx.ui.notify(
            "Final-review remediations passed per-stage review; running testing gap pass again before final review retries.",
            "info",
          );
          return await runTestingLoop(pendingTesting);
        }
      } catch (error) {
        workflowStarted = true;
        workflowTerminalState = "stopped";
        pendingFinalReview = undefined;
        await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(finalReviewIteration)), {
          error,
          source: "workflowmode:final-review:error",
        });
        ctx.ui.notify(`Workflow final review loop failed: ${getErrorMessage(error)}. Use /workflowmode reset to retry.`, "error");
        return { action: "handled" };
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    const runImplementationLoop = async (options: PendingImplementation): Promise<InputHookResult> => {
      const totalSteps = options.implementationPlanDecision.stepPlans.length;
      let stepIndex = Math.min(Math.max(options.stepIndex, 0), totalSteps);

      const stateDetails = (implementationStepIndex: number) => ({
        brainstormDecision: options.brainstormDecision,
        clarifiedPrompt: options.clarifiedPrompt,
        designPlanDecision: options.designPlanDecision,
        ...(options.implementationPlanArtifactPath
          ? { implementationPlanArtifactPath: options.implementationPlanArtifactPath }
          : {}),
        implementationPlanDecision: options.implementationPlanDecision,
        implementationStepIndex,
        selectedOption: options.selectedOption,
      });

      if (totalSteps === 0) {
        pendingImplementation = undefined;
        pendingImpplanner = undefined;
        pendingTesting = {
          brainstormDecision: options.brainstormDecision,
          clarifiedPrompt: options.clarifiedPrompt,
          designPlanDecision: options.designPlanDecision,
          finalReviewIteration: 0,
          ...(options.implementationPlanArtifactPath
            ? { implementationPlanArtifactPath: options.implementationPlanArtifactPath }
            : {}),
          implementationPlanDecision: options.implementationPlanDecision,
          selectedOption: options.selectedOption,
        };
        await persistWorkflowState(
          ctx,
          createWorkflowState("paused", "testing", { ...stateDetails(0), finalReviewIteration: 0 }),
        );
        ctx.ui.notify("Workflow mode implementation plan has no stages; starting testing gap pass.", "info");
        return await runTestingLoop(pendingTesting);
      }

      try {
        while (stepIndex < totalSteps) {
          const stepPlan = options.implementationPlanDecision.stepPlans[stepIndex];
          if (!stepPlan) break;

          pendingImplementation = { ...options, stepIndex };
          await persistWorkflowState(
            ctx,
            createWorkflowState("paused", "implementation_stage", stateDetails(stepIndex)),
          );

          let reviewerFeedback: string | undefined;
          let attempt = 1;
          while (true) {
            ctx.ui.setStatus(
              STATUS_KEY,
              `implementing stage ${stepIndex + 1}/${totalSteps}: ${previewTask(stepPlan.title)}`,
            );
            publishAgentProgress("workflowmode:progress:implementation", {
              currentSubagent: "wf-implementeragent",
              implementationStepIndex: stepIndex,
              implementationStepTitle: stepPlan.title,
              implementationStepTotal: totalSteps,
              loopLabel: "Implementation",
              phaseLabel: `Implementing stage ${stepIndex + 1}/${totalSteps}`,
              stage: "implementation_stage",
            });
            const implementerRun = await runWfImplementerAgentForStage({
              attempt,
              ctx,
              implementationPlan: options.implementationPlanDecision,
              implementationPlanArtifactPath: options.implementationPlanArtifactPath,
              pi,
              reviewerFeedback,
              stepIndex,
              stepPlan,
              totalSteps,
              onProgress: (progress) => {
                const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
                ctx.ui.setStatus(
                  STATUS_KEY,
                  `implementing stage ${stepIndex + 1}/${totalSteps}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
                );
                publishAgentProgress("workflowmode:progress:implementation", {
                  currentSubagent: "wf-implementeragent",
                  implementationStepIndex: stepIndex,
                  implementationStepTitle: stepPlan.title,
                  implementationStepTotal: totalSteps,
                  loopLabel: "Implementation",
                  phaseLabel: `Implementing stage ${stepIndex + 1}/${totalSteps}`,
                  progress,
                  stage: "implementation_stage",
                });
              },
            });
            sendWfImplementerAgentReportMessage(pi, ctx, implementerRun);

            if (!implementerRun.decision) {
              workflowStarted = true;
              workflowTerminalState = "stopped";
              pendingImplementation = undefined;
              await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(stepIndex)));
              ctx.ui.notify(
                `wf-implementeragent did not return a parseable implementation result for stage ${stepIndex + 1}; workflow stopped.`,
                "error",
              );
              return { action: "handled" };
            }

            if (implementerRun.decision.kind === "questions") {
              workflowStarted = true;
              workflowTerminalState = "stopped";
              pendingImplementation = undefined;
              await archiveWorkflowState(
                ctx,
                createWorkflowState("stopped", "stopped", {
                  ...stateDetails(stepIndex),
                  questions: implementerRun.decision.questions,
                }),
              );
              ctx.ui.notify(
                "wf-implementeragent needs user input during implementation; workflow stopped with its questions in the report.",
                "warning",
              );
              return { action: "handled" };
            }

            if (implementerRun.decision.kind === "blocked") {
              workflowStarted = true;
              workflowTerminalState = "stopped";
              pendingImplementation = undefined;
              await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(stepIndex)));
              ctx.ui.notify(
                `wf-implementeragent blocked on stage ${stepIndex + 1}: ${implementerRun.decision.reason}`,
                "error",
              );
              return { action: "handled" };
            }

            ctx.ui.setStatus(
              STATUS_KEY,
              `reviewing implementation stage ${stepIndex + 1}/${totalSteps}: ${previewTask(stepPlan.title)}`,
            );
            publishAgentProgress("workflowmode:progress:implementation-review", {
              currentSubagent: "wf-revieweragent",
              implementationStepIndex: stepIndex,
              implementationStepTitle: stepPlan.title,
              implementationStepTotal: totalSteps,
              loopLabel: "Implementation review",
              phaseLabel: `Reviewing implementation stage ${stepIndex + 1}/${totalSteps}`,
              stage: "implementation_stage",
            });
            const reviewerRun = await runWfReviewerAgentForStage({
              attempt,
              ctx,
              implementationPlan: options.implementationPlanDecision,
              implementationPlanArtifactPath: options.implementationPlanArtifactPath,
              implementerDecision: implementerRun.decision,
              implementerReport: implementerRun.report,
              pi,
              previousFeedback: reviewerFeedback,
              stepIndex,
              stepPlan,
              totalSteps,
              onProgress: (progress) => {
                const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
                ctx.ui.setStatus(
                  STATUS_KEY,
                  `reviewing implementation stage ${stepIndex + 1}/${totalSteps}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
                );
                publishAgentProgress("workflowmode:progress:implementation-review", {
                  currentSubagent: "wf-revieweragent",
                  implementationStepIndex: stepIndex,
                  implementationStepTitle: stepPlan.title,
                  implementationStepTotal: totalSteps,
                  loopLabel: "Implementation review",
                  phaseLabel: `Reviewing implementation stage ${stepIndex + 1}/${totalSteps}`,
                  progress,
                  stage: "implementation_stage",
                });
              },
            });
            sendWfReviewerAgentReportMessage(pi, ctx, reviewerRun);

            if (!reviewerRun.decision) {
              workflowStarted = true;
              workflowTerminalState = "stopped";
              pendingImplementation = undefined;
              await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(stepIndex)));
              ctx.ui.notify(
                `wf-revieweragent did not return a parseable review result for stage ${stepIndex + 1}; workflow stopped.`,
                "error",
              );
              return { action: "handled" };
            }

            if (reviewerRun.decision.greenSignal && reviewerRun.decision.verdict === "pass") {
              ctx.ui.notify(
                `wf-revieweragent approved stage ${stepIndex + 1}/${totalSteps}; moving to the next implementation stage.`,
                "info",
              );
              break;
            }

            if (reviewerRun.decision.verdict === "blocked") {
              workflowStarted = true;
              workflowTerminalState = "stopped";
              pendingImplementation = undefined;
              await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(stepIndex)));
              ctx.ui.notify(
                `wf-revieweragent blocked stage ${stepIndex + 1}; workflow stopped. See reviewer report for details.`,
                "error",
              );
              return { action: "handled" };
            }

            reviewerFeedback = formatWfReviewerAgentFeedback(reviewerRun.decision);
            attempt += 1;
            ctx.ui.notify(
              `wf-revieweragent requested changes for stage ${stepIndex + 1}; sending feedback back to wf-implementeragent.`,
              "warning",
            );
          }

          stepIndex += 1;
          if (stepIndex < totalSteps) {
            pendingImplementation = { ...options, stepIndex };
            await persistWorkflowState(
              ctx,
              createWorkflowState("paused", "implementation_stage", stateDetails(stepIndex)),
            );
          }
        }

        pendingImplementation = undefined;
        pendingImpplanner = undefined;
        pendingTesting = {
          brainstormDecision: options.brainstormDecision,
          clarifiedPrompt: options.clarifiedPrompt,
          designPlanDecision: options.designPlanDecision,
          finalReviewIteration: 0,
          ...(options.implementationPlanArtifactPath
            ? { implementationPlanArtifactPath: options.implementationPlanArtifactPath }
            : {}),
          implementationPlanDecision: options.implementationPlanDecision,
          selectedOption: options.selectedOption,
        };
        await persistWorkflowState(
          ctx,
          createWorkflowState("paused", "testing", { ...stateDetails(totalSteps), finalReviewIteration: 0 }),
        );
        ctx.ui.notify(
          "Workflow mode implementation stages complete; starting testing gap pass before final review.",
          "info",
        );
        return await runTestingLoop(pendingTesting);
      } catch (error) {
        workflowStarted = true;
        workflowTerminalState = "stopped";
        pendingImplementation = undefined;
        pendingTesting = undefined;
        pendingFinalReview = undefined;
        await archiveWorkflowState(ctx, createWorkflowState("stopped", "stopped", stateDetails(stepIndex)), {
          error,
          source: "workflowmode:implementation:error",
        });
        ctx.ui.notify(
          `Workflow implementation loop failed: ${getErrorMessage(error)}. Use /workflowmode reset to retry.`,
          "error",
        );
        return { action: "handled" };
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    const runImpplanner = async (options: {
      readonly brainstormDecision: WfBrainstormerDecision;
      readonly clarifiedPrompt: string;
      readonly designPlanDecision: Extract<WfDesignPlanDecision, { readonly kind: "design_plan" }>;
      readonly priorAnswers?: string | undefined;
      readonly priorQuestions?: readonly string[] | undefined;
      readonly selectedOption: WfBrainstormerOption;
    }): Promise<InputHookResult> => {
      ctx.ui.setStatus(STATUS_KEY, `implementation planning: ${previewTask(options.selectedOption.title)}`);
      publishAgentProgress("workflowmode:progress:impplanner", {
        currentSubagent: "wf-impplanner",
        loopLabel: "Implementation planning",
        phaseLabel: "Implementation planning",
        stage: "impplanner_questions",
      });

      try {
        const run = await runWfImpplannerForDesignPlan({
          clarifiedPrompt: options.clarifiedPrompt,
          ctx,
          designPlan: options.designPlanDecision,
          pi,
          priorAnswers: options.priorAnswers,
          priorQuestions: options.priorQuestions,
          selectedOption: options.selectedOption,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `implementation planning: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
            publishAgentProgress("workflowmode:progress:impplanner", {
              currentSubagent: "wf-impplanner",
              loopLabel: "Implementation planning",
              phaseLabel: "Implementation planning",
              progress,
              stage: "impplanner_questions",
            });
          },
        });

        if (run.decision?.kind === "questions") {
          sendWfImpplannerReportMessage(pi, ctx, run);
          pendingImpplanner = {
            brainstormDecision: options.brainstormDecision,
            clarifiedPrompt: options.clarifiedPrompt,
            designPlanDecision: options.designPlanDecision,
            questions: run.decision.questions,
            selectedOption: options.selectedOption,
          };
          await persistWorkflowState(
            ctx,
            createWorkflowState("waiting_for_answers", "impplanner_questions", {
              brainstormDecision: options.brainstormDecision,
              clarifiedPrompt: options.clarifiedPrompt,
              designPlanDecision: options.designPlanDecision,
              questions: run.decision.questions,
              selectedOption: options.selectedOption,
            }),
          );
          ctx.ui.notify(
            "Workflow implementation planner needs answers before the workflow can complete. Answer the listed questions in your next prompt.",
            "warning",
          );
          return { action: "handled" };
        }

        sendWfImpplannerReportMessage(pi, ctx, run);
        pendingImpplanner = undefined;

        if (run.decision?.kind === "implementation_plan") {
          pendingImplementation = {
            brainstormDecision: options.brainstormDecision,
            clarifiedPrompt: options.clarifiedPrompt,
            designPlanDecision: options.designPlanDecision,
            ...(run.artifactPath ? { implementationPlanArtifactPath: run.artifactPath } : {}),
            implementationPlanDecision: run.decision,
            selectedOption: options.selectedOption,
            stepIndex: 0,
          };
          await persistWorkflowState(
            ctx,
            createWorkflowState("paused", "implementation_stage", {
              brainstormDecision: options.brainstormDecision,
              clarifiedPrompt: options.clarifiedPrompt,
              designPlanDecision: options.designPlanDecision,
              ...(run.artifactPath ? { implementationPlanArtifactPath: run.artifactPath } : {}),
              implementationPlanDecision: run.decision,
              implementationStepIndex: 0,
              selectedOption: options.selectedOption,
            }),
          );
          ctx.ui.notify(
            `Workflow mode ${describeImpplannerResult(run)}; starting implementation stage loop with wf-implementeragent and wf-revieweragent.`,
            "info",
          );
          return await runImplementationLoop(pendingImplementation);
        }

        workflowStarted = true;
        workflowTerminalState = "stopped";
        await archiveWorkflowState(
          ctx,
          createWorkflowState("stopped", "stopped", {
            brainstormDecision: options.brainstormDecision,
            clarifiedPrompt: options.clarifiedPrompt,
            designPlanDecision: options.designPlanDecision,
            selectedOption: options.selectedOption,
          }),
        );
        const level = run.result.status === "completed" && run.decision ? "info" : "warning";
        ctx.ui.notify(
          `Workflow mode ${describeImpplannerResult(run)}; implementation did not start because no valid implementation plan is available.`,
          level,
        );
        return { action: "handled" };
      } catch (error) {
        workflowStarted = true;
        workflowTerminalState = "stopped";
        pendingImpplanner = undefined;
        pendingImplementation = undefined;
        await archiveWorkflowState(
          ctx,
          createWorkflowState("stopped", "stopped", {
            brainstormDecision: options.brainstormDecision,
            clarifiedPrompt: options.clarifiedPrompt,
            designPlanDecision: options.designPlanDecision,
            selectedOption: options.selectedOption,
          }),
          { error, source: "workflowmode:impplanner:error" },
        );
        ctx.ui.notify(
          `Workflow implementation planner failed: ${getErrorMessage(error)}. Implementation has not started; use /workflowmode reset to retry.`,
          "error",
        );
        return { action: "handled" };
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    const runDesignPlan = async (options: {
      readonly brainstormDecision: WfBrainstormerDecision;
      readonly clarifiedPrompt: string;
      readonly priorAnswers?: string | undefined;
      readonly priorQuestions?: readonly string[] | undefined;
      readonly selectedOption: WfBrainstormerOption;
    }): Promise<InputHookResult> => {
      ctx.ui.setStatus(STATUS_KEY, `design planning: ${previewTask(options.selectedOption.title)}`);
      publishAgentProgress("workflowmode:progress:design-plan", {
        currentSubagent: "wf-designplan",
        loopLabel: "Design planning",
        phaseLabel: "Design planning",
        stage: "design_plan_questions",
      });

      try {
        const run = await runWfDesignPlanForOption({
          brainstormDecision: options.brainstormDecision,
          clarifiedPrompt: options.clarifiedPrompt,
          ctx,
          pi,
          priorAnswers: options.priorAnswers,
          priorQuestions: options.priorQuestions,
          selectedOption: options.selectedOption,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `design planning: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
            publishAgentProgress("workflowmode:progress:design-plan", {
              currentSubagent: "wf-designplan",
              loopLabel: "Design planning",
              phaseLabel: "Design planning",
              progress,
              stage: "design_plan_questions",
            });
          },
        });

        if (run.decision?.kind === "questions") {
          sendWfDesignPlanReportMessage(pi, ctx, run);
          pendingDesignPlan = {
            brainstormDecision: options.brainstormDecision,
            clarifiedPrompt: options.clarifiedPrompt,
            questions: run.decision.questions,
            selectedOption: options.selectedOption,
          };
          await persistWorkflowState(
            ctx,
            createWorkflowState("waiting_for_answers", "design_plan_questions", {
              brainstormDecision: options.brainstormDecision,
              clarifiedPrompt: options.clarifiedPrompt,
              questions: run.decision.questions,
              selectedOption: options.selectedOption,
            }),
          );
          ctx.ui.notify(
            "Workflow design planner needs answers before the workflow can complete. Answer the listed questions in your next prompt.",
            "warning",
          );
          return { action: "handled" };
        }

        if (run.decision?.kind === "design_plan") {
          ctx.ui.setStatus(STATUS_KEY, `reviewing wf-designplan: ${previewTask(options.selectedOption.title)}`);
          publishAgentProgress("workflowmode:progress:design-plan-review", {
            currentSubagent: "wf-adversarialreview",
            loopLabel: "Design-plan review",
            phaseLabel: "Reviewing wf-designplan",
            stage: "design_plan_questions",
          });
        }
        const reviewedRun = await reviewWfDesignPlanRun({
          clarifiedPrompt: options.clarifiedPrompt,
          ctx,
          pi,
          run,
          selectedOption: options.selectedOption,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `reviewing wf-designplan: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
            publishAgentProgress("workflowmode:progress:design-plan-review", {
              currentSubagent: "wf-adversarialreview",
              loopLabel: "Design-plan review",
              phaseLabel: "Reviewing wf-designplan",
              progress,
              stage: "design_plan_questions",
            });
          },
        });
        sendWfDesignPlanReportMessage(pi, ctx, reviewedRun);

        pendingDesignPlan = undefined;
        if (reviewedRun.decision?.kind === "design_plan") {
          ctx.ui.notify(
            `Workflow mode ${describeDesignPlanResult(reviewedRun)} after adversarial review; starting implementation planning.`,
            "info",
          );
          return await runImpplanner({
            brainstormDecision: options.brainstormDecision,
            clarifiedPrompt: options.clarifiedPrompt,
            designPlanDecision: reviewedRun.decision,
            selectedOption: options.selectedOption,
          });
        }

        workflowStarted = true;
        workflowTerminalState = "stopped";
        await archiveWorkflowState(
          ctx,
          createWorkflowState("stopped", "stopped", {
            brainstormDecision: options.brainstormDecision,
            clarifiedPrompt: options.clarifiedPrompt,
            selectedOption: options.selectedOption,
          }),
        );
        const level = reviewedRun.result.status === "completed" && reviewedRun.decision ? "info" : "warning";
        ctx.ui.notify(
          `Workflow mode ${describeDesignPlanResult(reviewedRun)} after adversarial review; implementation planning did not start because no valid design plan is available.`,
          level,
        );
        return { action: "handled" };
      } catch (error) {
        workflowStarted = true;
        workflowTerminalState = "stopped";
        pendingDesignPlan = undefined;
        await archiveWorkflowState(
          ctx,
          createWorkflowState("stopped", "stopped", {
            brainstormDecision: options.brainstormDecision,
            clarifiedPrompt: options.clarifiedPrompt,
            selectedOption: options.selectedOption,
          }),
          { error, source: "workflowmode:design-plan:error" },
        );
        ctx.ui.notify(
          `Workflow design planner failed: ${getErrorMessage(error)}. Implementation has not started; use /workflowmode reset to retry.`,
          "error",
        );
        return { action: "handled" };
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    const runBrainstorming = async (options: {
      readonly clarifiedPrompt: string;
      readonly priorAnswers?: string | undefined;
      readonly priorQuestions?: readonly string[] | undefined;
    }): Promise<InputHookResult> => {
      ctx.ui.setStatus(STATUS_KEY, `brainstorming: ${previewTask(options.clarifiedPrompt)}`);
      publishAgentProgress("workflowmode:progress:brainstorming", {
        currentSubagent: "wf-brainstormer",
        loopLabel: "Brainstorming",
        phaseLabel: "Brainstorming",
        stage: "brainstorming_questions",
      });

      try {
        const run = await runWfBrainstormerForPrompt({
          clarifiedPrompt: options.clarifiedPrompt,
          ctx,
          pi,
          priorAnswers: options.priorAnswers,
          priorQuestions: options.priorQuestions,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `brainstorming: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
            publishAgentProgress("workflowmode:progress:brainstorming", {
              currentSubagent: "wf-brainstormer",
              loopLabel: "Brainstorming",
              phaseLabel: "Brainstorming",
              progress,
              stage: "brainstorming_questions",
            });
          },
        });

        if (run.decision?.kind === "questions") {
          sendWfBrainstormerReportMessage(pi, ctx, run);
          pendingBrainstorming = {
            clarifiedPrompt: options.clarifiedPrompt,
            questions: run.decision.questions,
          };
          await persistWorkflowState(
            ctx,
            createWorkflowState("waiting_for_answers", "brainstorming_questions", {
              clarifiedPrompt: options.clarifiedPrompt,
              questions: run.decision.questions,
            }),
          );
          ctx.ui.notify(
            "Workflow brainstormer needs answers before the workflow can continue. Answer the listed questions in your next prompt.",
            "warning",
          );
          return { action: "handled" };
        }

        const reviewedRun = await reviewBrainstormerRun(run, options.clarifiedPrompt);
        sendWfBrainstormerReportMessage(pi, ctx, reviewedRun);

        if (!reviewedRun.decision || reviewedRun.decision.kind !== "brainstorm") {
          workflowStarted = true;
          workflowTerminalState = "stopped";
          pendingBrainstorming = undefined;
          pendingBrainstormOptionSelection = undefined;
          await archiveWorkflowState(
            ctx,
            createWorkflowState("stopped", "stopped", { clarifiedPrompt: options.clarifiedPrompt }),
          );
          const level = reviewedRun.result.status === "completed" && reviewedRun.decision ? "info" : "warning";
          ctx.ui.notify(
            `Workflow mode ${describeBrainstormResult(reviewedRun)} after adversarial review; design planning did not start because no valid brainstorm option is available.`,
            level,
          );
          return { action: "handled" };
        }

        const selectedOption = await selectBrainstormOption(reviewedRun.decision, ctx);
        if (!selectedOption) {
          pendingBrainstorming = undefined;
          pendingBrainstormOptionSelection = {
            brainstormDecision: reviewedRun.decision,
            clarifiedPrompt: options.clarifiedPrompt,
          };
          await persistWorkflowState(
            ctx,
            createWorkflowState("paused", "brainstorm_option_selection", {
              brainstormDecision: reviewedRun.decision,
              clarifiedPrompt: options.clarifiedPrompt,
            }),
          );
          ctx.ui.notify(
            "Workflow brainstorm option selection paused. Ask side questions normally, then send `resume workflow` to choose an option and continue design planning.",
            "info",
          );
          return { action: "handled" };
        }

        pendingBrainstormOptionSelection = undefined;
        pendingBrainstorming = undefined;
        await clearWorkflowStateFile(ctx);
        ctx.ui.notify(`Workflow mode selected brainstorm option for design planning: ${selectedOption.title}`, "info");
        return await runDesignPlan({
          brainstormDecision: reviewedRun.decision,
          clarifiedPrompt: options.clarifiedPrompt,
          selectedOption,
        });
      } catch (error) {
        workflowStarted = true;
        workflowTerminalState = "stopped";
        pendingBrainstorming = undefined;
        pendingBrainstormOptionSelection = undefined;
        await archiveWorkflowState(
          ctx,
          createWorkflowState("stopped", "stopped", { clarifiedPrompt: options.clarifiedPrompt }),
          { error, source: "workflowmode:brainstorming:error" },
        );
        ctx.ui.notify(
          `Workflow brainstormer failed: ${getErrorMessage(error)}. Implementation has not started; use /workflowmode reset to retry.`,
          "error",
        );
        return { action: "handled" };
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    const runClarification = async (inputText: string): Promise<InputHookResult> => {
      const hadPendingClarification = pendingClarification !== undefined;
      const originalPrompt = pendingClarification?.originalPrompt ?? inputText;
      const priorQuestions = pendingClarification?.questions;
      const priorAnswers = pendingClarification ? inputText : undefined;
      const fallbackPrompt = buildClarificationFallbackPrompt(inputText, pendingClarification);

      ctx.ui.setStatus(STATUS_KEY, `clarifying: ${previewTask(originalPrompt)}`);
      publishAgentProgress("workflowmode:progress:clarification", {
        currentSubagent: "wf-clarifier",
        loopLabel: "Clarification",
        phaseLabel: "Clarifying",
        stage: "clarification_questions",
      });

      try {
        const run = await runWfClarifierForPrompt({
          ctx,
          pi,
          priorAnswers,
          priorQuestions,
          userPrompt: originalPrompt,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `clarifying: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
            publishAgentProgress("workflowmode:progress:clarification", {
              currentSubagent: "wf-clarifier",
              loopLabel: "Clarification",
              phaseLabel: "Clarifying",
              progress,
              stage: "clarification_questions",
            });
          },
        });

        sendWfClarifierReportMessage(pi, ctx, run);

        if (!run.decision) {
          pendingClarification = undefined;
          ctx.ui.notify(
            `Workflow clarifier could not parse its response; continuing to brainstorming with ${hadPendingClarification ? "combined" : "original"} prompt.`,
            "warning",
          );
          return await runBrainstorming({ clarifiedPrompt: fallbackPrompt });
        }

        if (run.decision.kind === "questions") {
          pendingClarification = {
            originalPrompt,
            questions: run.decision.questions,
          };
          await persistWorkflowState(
            ctx,
            createWorkflowState("waiting_for_answers", "clarification_questions", {
              originalPrompt,
              questions: run.decision.questions,
            }),
          );
          ctx.ui.notify(
            "Workflow clarifier needs answers before brainstorming can start. Answer the listed questions in your next prompt.",
            "warning",
          );
          return { action: "handled" };
        }

        const selected = await selectClarifierPromptOption(run.decision.prompts, ctx);
        if (!selected) {
          pendingClarification = undefined;
          pendingClarifierPromptSelection = { prompts: run.decision.prompts };
          await persistWorkflowState(
            ctx,
            createWorkflowState("paused", "clarifier_prompt_selection", { prompts: run.decision.prompts }),
          );
          ctx.ui.notify(
            "Workflow prompt selection paused. Ask side questions normally, then send `resume workflow` to choose a prompt and continue brainstorming.",
            "info",
          );
          return { action: "handled" };
        }

        pendingClarifierPromptSelection = undefined;
        pendingClarification = undefined;
        await clearWorkflowStateFile(ctx);
        ctx.ui.notify(`Workflow mode accepted enriched prompt: ${selected.title}`, "info");
        return await runBrainstorming({ clarifiedPrompt: selected.prompt });
      } catch (error) {
        pendingClarification = undefined;
        publishWorkflowTreeErrorSnapshot("workflowmode:clarification:error", error, { hasWorkflowState: true });
        ctx.ui.notify(
          `Workflow clarifier failed: ${getErrorMessage(error)}. Continuing to brainstorming without clarification.`,
          "error",
        );
        return await runBrainstorming({ clarifiedPrompt: fallbackPrompt });
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    const resumePausedWorkflow = async (): Promise<InputHookResult> => {
      publishWorkflowTreeSnapshot("workflowmode:resume-paused");

      if (pendingClarifierPromptSelection) {
        const pending = pendingClarifierPromptSelection;
        const selected = await selectClarifierPromptOption(pending.prompts, ctx);
        if (!selected) {
          ctx.ui.notify(
            "Workflow prompt selection is still paused. Ask side questions normally, then send `resume workflow` when ready.",
            "info",
          );
          return { action: "handled" };
        }

        pendingClarifierPromptSelection = undefined;
        pendingClarification = undefined;
        await clearWorkflowStateFile(ctx);
        ctx.ui.notify(`Workflow mode accepted enriched prompt: ${selected.title}`, "info");
        return await runBrainstorming({ clarifiedPrompt: selected.prompt });
      }

      if (pendingBrainstormOptionSelection) {
        const pending = pendingBrainstormOptionSelection;
        const selectedOption = await selectBrainstormOption(pending.brainstormDecision, ctx);
        if (!selectedOption) {
          ctx.ui.notify(
            "Workflow brainstorm option selection is still paused. Ask side questions normally, then send `resume workflow` when ready.",
            "info",
          );
          return { action: "handled" };
        }

        pendingBrainstormOptionSelection = undefined;
        pendingBrainstorming = undefined;
        await clearWorkflowStateFile(ctx);
        ctx.ui.notify(`Workflow mode selected brainstorm option for design planning: ${selectedOption.title}`, "info");
        return await runDesignPlan({
          brainstormDecision: pending.brainstormDecision,
          clarifiedPrompt: pending.clarifiedPrompt,
          selectedOption,
        });
      }

      if (pendingImplementation) {
        return await runImplementationLoop(pendingImplementation);
      }

      if (pendingTesting) {
        return await runTestingLoop(pendingTesting);
      }

      if (pendingFinalReview) {
        return await runFinalReviewLoop(pendingFinalReview);
      }

      ctx.ui.notify(`Workflow mode: ${statusText()}`, "info");
      return { action: "handled" };
    };

    const currentInput = event.text.trim();
    const isExtensionResumeInput =
      event.source === "extension" && resumeInjectedInput && isWorkflowResumeInput(currentInput);
    if (isExtensionResumeInput) resumeInjectedInput = false;

    if (!workflowModeEnabled || workflowStarted || (event.source === "extension" && !isExtensionResumeInput)) {
      return { action: "continue" };
    }

    if (!currentInput) return { action: "continue" };

    if (pendingClarifierPromptSelection || pendingBrainstormOptionSelection) {
      if (isWorkflowResumeInput(currentInput)) return resumePausedWorkflow();
      return { action: "continue" };
    }

    if (pendingImplementation) {
      if (isWorkflowResumeInput(currentInput)) return await runImplementationLoop(pendingImplementation);
      return { action: "continue" };
    }

    if (pendingTesting) {
      if (isWorkflowResumeInput(currentInput)) return await runTestingLoop(pendingTesting);
      return { action: "continue" };
    }

    if (pendingFinalReview) {
      if (isWorkflowResumeInput(currentInput)) return await runFinalReviewLoop(pendingFinalReview);
      return { action: "continue" };
    }

    if (isWorkflowResumeInput(currentInput)) {
      publishWorkflowTreeSnapshot("workflowmode:input:resume-status");
      ctx.ui.notify(`Workflow mode: ${statusText()}`, "info");
      return { action: "handled" };
    }

    if (pendingImpplanner) {
      const pending = pendingImpplanner;
      return runImpplanner({
        brainstormDecision: pending.brainstormDecision,
        clarifiedPrompt: pending.clarifiedPrompt,
        designPlanDecision: pending.designPlanDecision,
        priorAnswers: event.text,
        priorQuestions: pending.questions,
        selectedOption: pending.selectedOption,
      });
    }

    if (pendingDesignPlan) {
      const pending = pendingDesignPlan;
      return runDesignPlan({
        brainstormDecision: pending.brainstormDecision,
        clarifiedPrompt: pending.clarifiedPrompt,
        priorAnswers: event.text,
        priorQuestions: pending.questions,
        selectedOption: pending.selectedOption,
      });
    }

    if (pendingBrainstorming) {
      const pending = pendingBrainstorming;
      return runBrainstorming({
        clarifiedPrompt: pending.clarifiedPrompt,
        priorAnswers: event.text,
        priorQuestions: pending.questions,
      });
    }

    return runClarification(event.text);
  });
}
