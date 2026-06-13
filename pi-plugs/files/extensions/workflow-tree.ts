import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  truncateToVisualLines,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  getErrorMessage,
  getPositiveIntegerField,
  readJsoncConfig,
} from "./lib/jsonc-config.ts";
import {
  registerRightOverlayPane,
  type RightOverlayPaneClient,
  type RightOverlayRenderState,
} from "./lib/right-overlay-tiler.ts";
import {
  WORKFLOW_TREE_LIFECYCLES,
  WORKFLOW_TREE_QUERY_EVENT,
  WORKFLOW_TREE_SNAPSHOT_EVENT,
  WORKFLOW_TREE_SNAPSHOT_SCHEMA_VERSION,
  WORKFLOW_TREE_STAGES,
  WORKFLOW_TREE_STATUSES,
  type WorkflowTreeCompletedStepSummary,
  type WorkflowTreeLifecycle,
  type WorkflowTreeOptionSummary,
  type WorkflowTreePromptSummary,
  type WorkflowTreeSnapshot,
  type WorkflowTreeSnapshotQuery,
  type WorkflowTreeStage,
  type WorkflowTreeStageMap,
  type WorkflowTreeStatus,
  type WorkflowTreeStatusMap,
} from "./lib/workflow-tree-state.ts";

const PANE_ID = "workflow-tree";
const CONFIG_FILE_PATH = ".pi/extensions/workflow-tree.config.jsonc";
const PERSISTED_WORKFLOW_SCHEMA_VERSION = 1;
const WORKFLOW_STATE_PATH_PARTS = [".zzwf", "workflows", "current.json"] as const;

export interface WorkflowTreeConfig {
  readonly overlayOrder: number;
  readonly paneMinWidth: number;
  readonly maxRenderVisualLines: number;
  readonly maxLabelLength: number;
  readonly maxCompletedSteps: number;
}

const DEFAULT_CONFIG: WorkflowTreeConfig = {
  overlayOrder: 21,
  paneMinWidth: 52,
  maxRenderVisualLines: 1_000,
  maxLabelLength: 72,
  maxCompletedSteps: 8,
};

export interface PersistedWorkflowSeed {
  readonly stage: WorkflowTreeStage;
  readonly status: WorkflowTreeStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly originalPrompt?: string;
  readonly clarifiedPrompt?: string;
  readonly pendingPrompt?: string;
  readonly pendingPrompts?: readonly WorkflowTreePromptSummary[];
  readonly pendingQuestions?: readonly string[];
  readonly selectedOption?: WorkflowTreeOptionSummary;
  readonly selectedOptionTitle?: string;
  readonly implementationStepIndex?: number;
  readonly implementationStepTotal?: number;
  readonly implementationStepTitle?: string;
  readonly finalReviewIteration?: number;
  readonly completedSteps?: readonly WorkflowTreeCompletedStepSummary[];
}

export type WorkflowTreeRowTone = "accent" | "muted" | "dim" | "warning" | "normal";

export interface WorkflowTreeRow {
  readonly depth: number;
  readonly label: string;
  readonly value?: string;
  readonly tone?: WorkflowTreeRowTone;
}

const WORKFLOW_TREE_STAGE_SET = new Set<string>(WORKFLOW_TREE_STAGES);
const WORKFLOW_TREE_STATUS_SET = new Set<string>(WORKFLOW_TREE_STATUSES);
const WORKFLOW_TREE_LIFECYCLE_SET = new Set<string>(WORKFLOW_TREE_LIFECYCLES);

export const WORKFLOW_TREE_STAGE_LABELS: WorkflowTreeStageMap<string> = {
  clarification_questions: "Clarification questions",
  clarifier_prompt_selection: "Clarifier prompt selection",
  brainstorming_questions: "Brainstorming questions",
  brainstorm_option_selection: "Brainstorm option selection",
  design_plan_questions: "Design plan questions",
  impplanner_questions: "Implementation planner questions",
  implementation_stage: "Implementation stage",
  testing: "Testing",
  final_review: "Final review",
  complete: "Complete",
  stopped: "Stopped",
};

export const WORKFLOW_TREE_STATUS_LABELS: WorkflowTreeStatusMap<string> = {
  waiting_for_answers: "Waiting for answers",
  paused: "Paused",
  complete: "Complete",
  stopped: "Stopped",
};

export const WORKFLOW_TREE_LIFECYCLE_LABELS: { readonly [Key in WorkflowTreeLifecycle]: string } = {
  inactive: "Inactive",
  waiting_for_initial_prompt: "Waiting for initial prompt",
  waiting_for_user: "Waiting for user",
  running: "Running",
  paused: "Paused",
  complete: "Complete",
  stopped: "Stopped",
  error: "Error",
};

let currentConfig: WorkflowTreeConfig = { ...DEFAULT_CONFIG };
let lastContext: ExtensionContext | undefined;
let latestSnapshot: WorkflowTreeSnapshot | undefined;
let persistedSeed: PersistedWorkflowSeed | undefined;
let overlayTiler: RightOverlayPaneClient | undefined;

function loadConfig(ctx: ExtensionContext): void {
  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, ctx.cwd);
    currentConfig = record
      ? {
          overlayOrder: getPositiveIntegerField(record, "overlayOrder") ?? DEFAULT_CONFIG.overlayOrder,
          paneMinWidth: getPositiveIntegerField(record, "paneMinWidth") ?? DEFAULT_CONFIG.paneMinWidth,
          maxRenderVisualLines:
            getPositiveIntegerField(record, "maxRenderVisualLines") ??
            DEFAULT_CONFIG.maxRenderVisualLines,
          maxLabelLength:
            getPositiveIntegerField(record, "maxLabelLength") ?? DEFAULT_CONFIG.maxLabelLength,
          maxCompletedSteps:
            getPositiveIntegerField(record, "maxCompletedSteps") ?? DEFAULT_CONFIG.maxCompletedSteps,
        }
      : { ...DEFAULT_CONFIG };
  } catch (error) {
    currentConfig = { ...DEFAULT_CONFIG };
    ctx.ui.notify(`workflow-tree config ignored: ${getErrorMessage(error)}`, "warning");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function getNumberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStringArrayField(
  record: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;

  const trimmed = value.map((item) => item.trim()).filter(Boolean);
  return trimmed.length > 0 ? trimmed : undefined;
}

function isWorkflowTreeStage(value: unknown): value is WorkflowTreeStage {
  return typeof value === "string" && WORKFLOW_TREE_STAGE_SET.has(value);
}

function isWorkflowTreeStatus(value: unknown): value is WorkflowTreeStatus {
  return typeof value === "string" && WORKFLOW_TREE_STATUS_SET.has(value);
}

function isWorkflowTreeLifecycle(value: unknown): value is WorkflowTreeLifecycle {
  return typeof value === "string" && WORKFLOW_TREE_LIFECYCLE_SET.has(value);
}

function isWorkflowTreeTerminalStatus(
  value: unknown,
): value is NonNullable<WorkflowTreeSnapshot["terminalStatus"]> {
  return value === "complete" || value === "stopped" || value === "error";
}

function optionalStringFieldsAreStrings(
  record: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => record[field] === undefined || typeof record[field] === "string");
}

function optionalNumberFieldsAreFinite(
  record: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every(
    (field) => record[field] === undefined || (typeof record[field] === "number" && Number.isFinite(record[field])),
  );
}

function optionalArrayFieldIs<T>(
  record: Record<string, unknown>,
  field: string,
  guard: (value: unknown) => value is T,
): boolean {
  const value = record[field];
  return value === undefined || (Array.isArray(value) && value.every(guard));
}

function isPromptSummaryPayload(value: unknown): value is WorkflowTreePromptSummary {
  return (
    isRecord(value) &&
    optionalStringFieldsAreStrings(value, ["id", "title", "prompt", "question", "description"]) &&
    objectHasText(value, ["id", "title", "prompt", "question", "description"])
  );
}

function isOptionSummaryPayload(value: unknown): value is WorkflowTreeOptionSummary {
  return (
    isRecord(value) &&
    optionalStringFieldsAreStrings(value, ["id", "title", "prompt", "summary"]) &&
    objectHasText(value, ["id", "title", "prompt", "summary"])
  );
}

function isProgressSummaryPayload(value: unknown): value is NonNullable<WorkflowTreeSnapshot["progress"]> {
  return (
    isRecord(value) &&
    optionalStringFieldsAreStrings(value, ["label"]) &&
    optionalNumberFieldsAreFinite(value, ["current", "total", "turns", "toolCalls"])
  );
}

function isCompletedStepSummaryPayload(value: unknown): value is WorkflowTreeCompletedStepSummary {
  return (
    isRecord(value) &&
    optionalNumberFieldsAreFinite(value, ["index"]) &&
    optionalStringFieldsAreStrings(value, ["title", "summary", "completedAt"]) &&
    (value.status === undefined || isWorkflowTreeStatus(value.status) || isWorkflowTreeTerminalStatus(value.status))
  );
}

function isErrorSummaryPayload(value: unknown): value is NonNullable<WorkflowTreeSnapshot["error"]> {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    optionalStringFieldsAreStrings(value, ["name", "stack", "occurredAt"])
  );
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "…";
  return `${value.slice(0, maxLength - 1)}…`;
}

function objectHasText(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => typeof value[field] === "string" && value[field].trim() !== "");
}

function summarizePrompt(value: unknown): WorkflowTreePromptSummary | undefined {
  if (typeof value === "string") {
    const prompt = normalizeInline(value);
    return prompt ? { prompt } : undefined;
  }

  if (!isRecord(value) || !objectHasText(value, ["id", "title", "prompt", "question", "description"])) {
    return undefined;
  }

  const id = getStringField(value, "id");
  const title = getStringField(value, "title");
  const prompt = getStringField(value, "prompt");
  const question = getStringField(value, "question");
  const description = getStringField(value, "description");

  return {
    ...(id ? { id: normalizeInline(id) } : {}),
    ...(title ? { title: normalizeInline(title) } : {}),
    ...(prompt ? { prompt: normalizeInline(prompt) } : {}),
    ...(question ? { question: normalizeInline(question) } : {}),
    ...(description ? { description: normalizeInline(description) } : {}),
  };
}

function summarizeOption(value: unknown): WorkflowTreeOptionSummary | undefined {
  if (typeof value === "string") {
    const title = normalizeInline(value);
    return title ? { title } : undefined;
  }

  if (!isRecord(value) || !objectHasText(value, ["id", "title", "prompt", "summary"])) {
    return undefined;
  }

  const id = getStringField(value, "id");
  const title = getStringField(value, "title");
  const prompt = getStringField(value, "prompt");
  const summary = getStringField(value, "summary");

  return {
    ...(id ? { id: normalizeInline(id) } : {}),
    ...(title ? { title: normalizeInline(title) } : {}),
    ...(prompt ? { prompt: normalizeInline(prompt) } : {}),
    ...(summary ? { summary: normalizeInline(summary) } : {}),
  };
}

function summarizePromptArray(value: unknown): readonly WorkflowTreePromptSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const summaries = value
    .map((item) => summarizePrompt(item))
    .filter((item): item is WorkflowTreePromptSummary => item !== undefined);
  return summaries.length > 0 ? summaries : undefined;
}

function getImplementationStepPlans(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.stepPlans)) return undefined;

  const steps = value.stepPlans.filter(isRecord);
  return steps.length > 0 ? steps : undefined;
}

function buildSeedCompletedSteps(
  steps: readonly Record<string, unknown>[] | undefined,
  implementationStepIndex: number | undefined,
): readonly WorkflowTreeCompletedStepSummary[] | undefined {
  if (!steps || implementationStepIndex === undefined || implementationStepIndex <= 0) return undefined;

  return steps.slice(0, implementationStepIndex).map((step, index) => {
    const title = getStringField(step, "title");
    return {
      index: index + 1,
      ...(title ? { title: normalizeInline(title) } : {}),
      status: "complete" as const,
    };
  });
}

export function parsePersistedWorkflowSeed(value: unknown): PersistedWorkflowSeed | undefined {
  if (!isRecord(value) || value.schemaVersion !== PERSISTED_WORKFLOW_SCHEMA_VERSION) return undefined;

  const stage = value.stage;
  const status = value.status;
  const createdAt = getStringField(value, "createdAt");
  const updatedAt = getStringField(value, "updatedAt");

  if (!isWorkflowTreeStage(stage) || !isWorkflowTreeStatus(status) || !createdAt || !updatedAt) {
    return undefined;
  }

  const originalPrompt = getStringField(value, "originalPrompt");
  const clarifiedPrompt = getStringField(value, "clarifiedPrompt");
  const pendingPrompt = getStringField(value, "pendingPrompt");
  const pendingPrompts = summarizePromptArray(value.prompts);
  const pendingQuestions = getStringArrayField(value, "questions");
  const selectedOption = summarizeOption(value.selectedOption);
  const selectedOptionTitle = selectedOption?.title ?? getStringField(value, "selectedOptionTitle");
  const implementationStepIndex = getNumberField(value, "implementationStepIndex");
  const finalReviewIteration = getNumberField(value, "finalReviewIteration");
  const implementationSteps = getImplementationStepPlans(value.implementationPlanDecision);
  const implementationStepTotal = implementationSteps?.length;
  const implementationStep =
    implementationStepIndex !== undefined ? implementationSteps?.[implementationStepIndex] : undefined;
  const implementationStepTitle = implementationStep
    ? getStringField(implementationStep, "title")
    : undefined;
  const completedSteps = buildSeedCompletedSteps(implementationSteps, implementationStepIndex);

  return {
    stage,
    status,
    createdAt,
    updatedAt,
    ...(originalPrompt ? { originalPrompt: normalizeInline(originalPrompt) } : {}),
    ...(clarifiedPrompt ? { clarifiedPrompt: normalizeInline(clarifiedPrompt) } : {}),
    ...(pendingPrompt ? { pendingPrompt: normalizeInline(pendingPrompt) } : {}),
    ...(pendingPrompts ? { pendingPrompts } : {}),
    ...(pendingQuestions ? { pendingQuestions } : {}),
    ...(selectedOption ? { selectedOption } : {}),
    ...(selectedOptionTitle ? { selectedOptionTitle: normalizeInline(selectedOptionTitle) } : {}),
    ...(implementationStepIndex !== undefined ? { implementationStepIndex } : {}),
    ...(implementationStepTotal !== undefined ? { implementationStepTotal } : {}),
    ...(implementationStepTitle ? { implementationStepTitle: normalizeInline(implementationStepTitle) } : {}),
    ...(finalReviewIteration !== undefined ? { finalReviewIteration } : {}),
    ...(completedSteps ? { completedSteps } : {}),
  };
}

export function readPersistedWorkflowSeed(cwd: string): PersistedWorkflowSeed | undefined {
  try {
    const raw = readFileSync(join(cwd, ...WORKFLOW_STATE_PATH_PARTS), "utf8");
    return parsePersistedWorkflowSeed(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function parseWorkflowTreeSnapshotPayload(payload: unknown): WorkflowTreeSnapshot | undefined {
  if (!isRecord(payload)) return undefined;

  if (payload.schemaVersion !== WORKFLOW_TREE_SNAPSHOT_SCHEMA_VERSION) return undefined;
  if (typeof payload.workflowModeEnabled !== "boolean") return undefined;
  if (typeof payload.hasWorkflowState !== "boolean") return undefined;
  if (!isWorkflowTreeLifecycle(payload.lifecycle)) return undefined;
  if (typeof payload.overlayVisible !== "boolean") return undefined;
  if (typeof payload.suppressContextTree !== "boolean") return undefined;
  if (typeof payload.source !== "string" || typeof payload.emittedAt !== "string") return undefined;

  if (payload.stage !== undefined && !isWorkflowTreeStage(payload.stage)) return undefined;
  if (payload.status !== undefined && !isWorkflowTreeStatus(payload.status)) return undefined;
  if (payload.terminalStatus !== undefined && !isWorkflowTreeTerminalStatus(payload.terminalStatus)) {
    return undefined;
  }

  if (
    !optionalStringFieldsAreStrings(payload, [
      "createdAt",
      "updatedAt",
      "startedAt",
      "completedAt",
      "pausedAt",
      "terminalAt",
      "originalPrompt",
      "clarifiedPrompt",
      "pendingPrompt",
      "selectedOptionTitle",
      "currentSubagent",
      "loopLabel",
      "phaseLabel",
      "implementationStepTitle",
      "terminalMessage",
    ])
  ) {
    return undefined;
  }

  if (
    !optionalNumberFieldsAreFinite(payload, [
      "implementationStepIndex",
      "implementationStepTotal",
      "finalReviewIteration",
    ])
  ) {
    return undefined;
  }

  if (!optionalArrayFieldIs(payload, "pendingPrompts", isPromptSummaryPayload)) return undefined;
  if (!optionalArrayFieldIs(payload, "pendingQuestions", (value): value is string => typeof value === "string")) {
    return undefined;
  }
  if (payload.selectedOption !== undefined && !isOptionSummaryPayload(payload.selectedOption)) {
    return undefined;
  }
  if (payload.progress !== undefined && !isProgressSummaryPayload(payload.progress)) return undefined;
  if (!optionalArrayFieldIs(payload, "completedSteps", isCompletedStepSummaryPayload)) return undefined;
  if (payload.error !== undefined && !isErrorSummaryPayload(payload.error)) return undefined;

  return payload as WorkflowTreeSnapshot;
}

export function workflowTreeStageLabel(stage: WorkflowTreeStage): string {
  return WORKFLOW_TREE_STAGE_LABELS[stage];
}

export function workflowTreeStatusLabel(status: WorkflowTreeStatus): string {
  return WORKFLOW_TREE_STATUS_LABELS[status];
}

function workflowTreeLifecycleLabel(lifecycle: WorkflowTreeLifecycle): string {
  return WORKFLOW_TREE_LIFECYCLE_LABELS[lifecycle];
}

function lifecycleTone(lifecycle: WorkflowTreeLifecycle): WorkflowTreeRowTone {
  if (lifecycle === "error") return "warning";
  if (lifecycle === "inactive") return "dim";
  if (lifecycle === "complete") return "accent";
  if (lifecycle === "stopped" || lifecycle === "paused") return "muted";
  return "accent";
}

function pushRow(
  rows: WorkflowTreeRow[],
  depth: number,
  label: string,
  value: string | undefined,
  tone: WorkflowTreeRowTone = "normal",
): void {
  const normalizedValue = value ? normalizeInline(value) : undefined;
  rows.push({ depth, label, ...(normalizedValue ? { value: normalizedValue } : {}), tone });
}

function promptSummaryText(prompt: WorkflowTreePromptSummary): string | undefined {
  return prompt.title ?? prompt.question ?? prompt.prompt ?? prompt.description ?? prompt.id;
}

function optionSummaryText(option: WorkflowTreeOptionSummary): string | undefined {
  return option.title ?? option.prompt ?? option.summary ?? option.id;
}

function formatProgress(progress: WorkflowTreeSnapshot["progress"]): string | undefined {
  if (!progress) return undefined;

  const parts: string[] = [];
  if (progress.label) parts.push(progress.label);
  if (progress.current !== undefined && progress.total !== undefined) {
    parts.push(`${progress.current}/${progress.total}`);
  } else if (progress.current !== undefined) {
    parts.push(String(progress.current));
  }
  if (progress.turns !== undefined) {
    parts.push(`${progress.turns} turn${progress.turns === 1 ? "" : "s"}`);
  }
  if (progress.toolCalls !== undefined) {
    parts.push(`${progress.toolCalls} tool call${progress.toolCalls === 1 ? "" : "s"}`);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatImplementationStep(
  index: number | undefined,
  total: number | undefined,
  title: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (index !== undefined && total !== undefined) parts.push(`${index}/${total}`);
  else if (index !== undefined) parts.push(`index ${index}`);
  else if (total !== undefined) parts.push(`${total} total`);
  if (title) parts.push(title);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatCompletedStep(step: WorkflowTreeCompletedStepSummary): string {
  const parts: string[] = [];
  if (step.index !== undefined) parts.push(`#${step.index}`);
  if (step.title) parts.push(step.title);
  if (step.status) {
    parts.push(
      isWorkflowTreeStatus(step.status)
        ? workflowTreeStatusLabel(step.status)
        : workflowTreeLifecycleLabel(step.status),
    );
  }
  if (step.summary) parts.push(step.summary);
  return parts.length > 0 ? parts.join(" · ") : "Completed step";
}

export function deriveWorkflowTreeRows(
  snapshot: WorkflowTreeSnapshot | undefined,
  seed: PersistedWorkflowSeed | undefined,
  config: WorkflowTreeConfig = currentConfig,
): readonly WorkflowTreeRow[] {
  const rows: WorkflowTreeRow[] = [];

  if (!snapshot) {
    pushRow(rows, 0, "Snapshot", "Waiting for workflowmode snapshot replay", "dim");
    pushRow(rows, 1, "Pane", "hidden until overlayVisible is true", "dim");
    return rows;
  }

  const activeSeed = snapshot.hasWorkflowState ? seed : undefined;
  const stage = snapshot.stage ?? activeSeed?.stage;
  const status = snapshot.status ?? activeSeed?.status;
  const originalPrompt = snapshot.originalPrompt ?? activeSeed?.originalPrompt;
  const clarifiedPrompt = snapshot.clarifiedPrompt ?? activeSeed?.clarifiedPrompt;
  const pendingPrompt = snapshot.pendingPrompt ?? activeSeed?.pendingPrompt;
  const pendingPrompts = snapshot.pendingPrompts ?? activeSeed?.pendingPrompts;
  const pendingQuestions = snapshot.pendingQuestions ?? activeSeed?.pendingQuestions;
  const selectedOption = snapshot.selectedOption ?? activeSeed?.selectedOption;
  const selectedOptionTitle =
    snapshot.selectedOptionTitle ?? selectedOption?.title ?? activeSeed?.selectedOptionTitle;
  const implementationStepIndex =
    snapshot.implementationStepIndex ?? activeSeed?.implementationStepIndex;
  const implementationStepTotal =
    snapshot.implementationStepTotal ?? activeSeed?.implementationStepTotal;
  const implementationStepTitle =
    snapshot.implementationStepTitle ?? activeSeed?.implementationStepTitle;
  const finalReviewIteration = snapshot.finalReviewIteration ?? activeSeed?.finalReviewIteration;
  const completedSteps = snapshot.completedSteps ?? activeSeed?.completedSteps;

  pushRow(
    rows,
    0,
    "Workflow",
    `${workflowTreeLifecycleLabel(snapshot.lifecycle)}${stage ? ` · ${workflowTreeStageLabel(stage)}` : ""}`,
    lifecycleTone(snapshot.lifecycle),
  );
  pushRow(
    rows,
    1,
    "Workflow mode",
    snapshot.workflowModeEnabled ? "enabled" : "off",
    snapshot.workflowModeEnabled ? "accent" : "dim",
  );
  pushRow(
    rows,
    1,
    "Workflow state",
    snapshot.hasWorkflowState ? "active/restored" : "none",
    snapshot.hasWorkflowState ? "accent" : "dim",
  );
  pushRow(
    rows,
    1,
    "Workflow Tree pane",
    snapshot.overlayVisible ? "visible" : "hidden",
    snapshot.overlayVisible ? "accent" : "dim",
  );
  pushRow(
    rows,
    1,
    "Context Tree",
    snapshot.suppressContextTree ? "suppressed" : "available",
    snapshot.suppressContextTree ? "warning" : "dim",
  );

  if (stage) pushRow(rows, 1, "Stage", workflowTreeStageLabel(stage), "accent");
  if (status) pushRow(rows, 1, "Status", workflowTreeStatusLabel(status), "muted");

  if (!snapshot.hasWorkflowState) {
    const message =
      snapshot.lifecycle === "waiting_for_initial_prompt"
        ? "Workflow mode is waiting for the first user prompt."
        : "No persisted workflow state is active.";
    pushRow(rows, 1, "State detail", message, "dim");
  }

  if (originalPrompt || clarifiedPrompt || pendingPrompt || pendingPrompts || pendingQuestions) {
    pushRow(rows, 1, "Prompt", undefined, "muted");
    if (originalPrompt) pushRow(rows, 2, "Original", originalPrompt, "normal");
    if (clarifiedPrompt) pushRow(rows, 2, "Clarified", clarifiedPrompt, "normal");
    if (pendingPrompt) pushRow(rows, 2, "Pending prompt", pendingPrompt, "warning");

    pendingQuestions?.forEach((question, index) => {
      pushRow(rows, 2, `Question ${index + 1}`, question, "warning");
    });

    pendingPrompts?.forEach((prompt, index) => {
      pushRow(rows, 2, `Prompt option ${index + 1}`, promptSummaryText(prompt), "warning");
    });
  }

  if (selectedOption || selectedOptionTitle) {
    pushRow(rows, 1, "Selection", selectedOptionTitle ?? optionSummaryText(selectedOption!), "muted");
    if (selectedOption?.summary) pushRow(rows, 2, "Summary", selectedOption.summary, "dim");
    if (selectedOption?.prompt) pushRow(rows, 2, "Prompt", selectedOption.prompt, "dim");
  }

  if (snapshot.currentSubagent || snapshot.loopLabel || snapshot.phaseLabel || snapshot.progress) {
    pushRow(rows, 1, "Execution", undefined, "muted");
    if (snapshot.currentSubagent) pushRow(rows, 2, "Subagent", snapshot.currentSubagent, "accent");
    if (snapshot.loopLabel) pushRow(rows, 2, "Loop", snapshot.loopLabel, "normal");
    if (snapshot.phaseLabel) pushRow(rows, 2, "Phase", snapshot.phaseLabel, "normal");
    pushRow(rows, 2, "Progress", formatProgress(snapshot.progress), "normal");
  }

  const implementationStep = formatImplementationStep(
    implementationStepIndex,
    implementationStepTotal,
    implementationStepTitle,
  );
  if (implementationStep || finalReviewIteration !== undefined || completedSteps) {
    pushRow(rows, 1, "Implementation", undefined, "muted");
    if (implementationStep) pushRow(rows, 2, "Current step", implementationStep, "accent");
    if (finalReviewIteration !== undefined) {
      pushRow(rows, 2, "Final review iteration", String(finalReviewIteration), "normal");
    }

    if (completedSteps && completedSteps.length > 0) {
      const hidden = Math.max(0, completedSteps.length - config.maxCompletedSteps);
      const shown = completedSteps.slice(hidden);
      if (hidden > 0) {
        pushRow(rows, 2, "Completed steps", `${hidden} earlier step${hidden === 1 ? "" : "s"} hidden`, "dim");
      } else {
        pushRow(rows, 2, "Completed steps", `${completedSteps.length}`, "dim");
      }
      shown.forEach((step) => pushRow(rows, 3, "Done", formatCompletedStep(step), "dim"));
    }
  }

  if (snapshot.terminalStatus || snapshot.terminalMessage || snapshot.lifecycle === "error") {
    pushRow(rows, 1, "Terminal", snapshot.terminalStatus ?? snapshot.lifecycle, "warning");
    if (snapshot.terminalMessage) pushRow(rows, 2, "Message", snapshot.terminalMessage, "warning");
  }

  if (snapshot.error) {
    pushRow(rows, 1, "Error", snapshot.error.message, "warning");
    if (snapshot.error.name) pushRow(rows, 2, "Name", snapshot.error.name, "warning");
    if (snapshot.error.occurredAt) pushRow(rows, 2, "Occurred", snapshot.error.occurredAt, "dim");
  }

  if (snapshot.createdAt ?? activeSeed?.createdAt) {
    pushRow(rows, 1, "Created", snapshot.createdAt ?? activeSeed?.createdAt, "dim");
  }
  if (snapshot.updatedAt ?? activeSeed?.updatedAt) {
    pushRow(rows, 1, "Updated", snapshot.updatedAt ?? activeSeed?.updatedAt, "dim");
  }
  if (snapshot.pausedAt) pushRow(rows, 1, "Paused", snapshot.pausedAt, "dim");
  if (snapshot.terminalAt) pushRow(rows, 1, "Terminal at", snapshot.terminalAt, "dim");
  if (snapshot.completedAt) pushRow(rows, 1, "Completed", snapshot.completedAt, "dim");
  pushRow(rows, 1, "Source", `${snapshot.source} · ${snapshot.emittedAt}`, "dim");

  return rows;
}

function hasLaterSibling(rows: readonly WorkflowTreeRow[], index: number, depth: number): boolean {
  for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
    const row = rows[cursor];
    if (row.depth < depth) return false;
    if (row.depth === depth) return true;
  }

  return false;
}

function rowConnector(rows: readonly WorkflowTreeRow[], index: number): string {
  const depth = rows[index]?.depth ?? 0;
  if (depth <= 0) return "";

  let prefix = "";
  for (let level = 1; level < depth; level += 1) {
    prefix += hasLaterSibling(rows, index, level) ? "│ " : "  ";
  }

  return `${prefix}${hasLaterSibling(rows, index, depth) ? "├─" : "└─"}`;
}

function styleLabel(row: WorkflowTreeRow, ctx: ExtensionContext, config: WorkflowTreeConfig): string {
  const theme = ctx.ui.theme;
  const label = truncateEnd(row.label, config.maxLabelLength);

  if (row.tone === "accent") return theme.fg("accent", label);
  if (row.tone === "muted") return theme.fg("muted", label);
  if (row.tone === "dim") return theme.fg("dim", label);
  if (row.tone === "warning") return theme.fg("warning", label);
  return label;
}

function rowLine(
  rows: readonly WorkflowTreeRow[],
  index: number,
  ctx: ExtensionContext,
  config: WorkflowTreeConfig,
): string {
  const row = rows[index];
  const theme = ctx.ui.theme;
  const connector = rowConnector(rows, index);
  const prefix = connector ? `${theme.fg("dim", connector)} ` : "";
  const label = styleLabel(row, ctx, config);
  const maxValueLength = config.maxLabelLength * 2;
  const value = row.value ? truncateEnd(row.value, maxValueLength) : undefined;

  if (!value) return `${prefix}${label}`;
  if (!connector) return `${label} ${theme.fg("dim", `· ${value}`)}`;
  return `${prefix}${label}: ${theme.fg("dim", value)}`;
}

export function buildWorkflowTreeLines(
  ctx: ExtensionContext,
  snapshot: WorkflowTreeSnapshot | undefined,
  seed: PersistedWorkflowSeed | undefined,
  config: WorkflowTreeConfig = currentConfig,
): string[] {
  const rows = deriveWorkflowTreeRows(snapshot, seed, config);
  return rows.map((_row, index) => rowLine(rows, index, ctx, config));
}

function ansiSequenceLength(value: string, index: number): number {
  if (value.charCodeAt(index) !== 0x1b || value.charCodeAt(index + 1) !== 0x5b) return 0;

  for (let cursor = index + 2; cursor < value.length; cursor += 1) {
    const code = value.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) return cursor - index + 1;
  }

  return 0;
}

export function visibleLength(value: string): number {
  let visible = 0;
  for (let index = 0; index < value.length; ) {
    const ansiLength = ansiSequenceLength(value, index);
    if (ansiLength > 0) {
      index += ansiLength;
      continue;
    }

    const char = Array.from(value.slice(index))[0];
    if (!char) break;
    visible += 1;
    index += char.length;
  }

  return visible;
}

export function truncateAnsi(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleLength(value) <= maxWidth) return value;
  if (maxWidth <= 1) return "…";

  let output = "";
  let visible = 0;
  for (let index = 0; index < value.length; ) {
    const ansiLength = ansiSequenceLength(value, index);
    if (ansiLength > 0) {
      output += value.slice(index, index + ansiLength);
      index += ansiLength;
      continue;
    }

    const char = Array.from(value.slice(index))[0];
    if (!char || visible >= maxWidth - 1) break;
    output += char;
    visible += 1;
    index += char.length;
  }

  return `${output}…`;
}

function padAnsi(value: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(value));
  return `${value}${" ".repeat(padding)}`;
}

function panelLine(content: string, width: number, border: (value: string) => string): string {
  if (width < 8) return truncateAnsi(content, width);

  const innerWidth = width - 4;
  const truncated = truncateAnsi(content, innerWidth);
  return `${border("│")} ${padAnsi(truncated, innerWidth)} ${border("│")}`;
}

function panelBorder(
  title: string | undefined,
  width: number,
  border: (value: string) => string,
): string {
  if (width <= 0) return "";
  if (width < 8) return border("─".repeat(width));

  const innerWidth = width - 2;
  if (!title) return border(`╰${"─".repeat(innerWidth)}╯`);

  const label = ` ${title} `;
  const truncatedLabel = truncateAnsi(label, innerWidth);
  const remaining = Math.max(0, innerWidth - visibleLength(truncatedLabel));
  return border(`╭${truncatedLabel}${"─".repeat(remaining)}╮`);
}

export function buildWorkflowTreePaneLines(
  ctx: ExtensionContext,
  width: number,
  state: RightOverlayRenderState,
  snapshot: WorkflowTreeSnapshot | undefined = latestSnapshot,
  seed: PersistedWorkflowSeed | undefined = persistedSeed,
  config: WorkflowTreeConfig = currentConfig,
): string[] {
  const theme = ctx.ui.theme;
  const border = (value: string) => theme.fg(state.focused ? "borderAccent" : "borderMuted", value);
  const wrapped = truncateToVisualLines(
    buildWorkflowTreeLines(ctx, snapshot, seed, config).join("\n"),
    config.maxRenderVisualLines,
    Math.max(8, width - 4),
    0,
  ).visualLines;

  return [
    panelBorder("Workflow Tree", width, border),
    ...wrapped.map((line) => panelLine(line, width, border)),
    panelBorder(undefined, width, border),
  ];
}

function setWorkflowTreeVisible(visible: boolean): void {
  overlayTiler?.setVisible(visible);
}

function emitSnapshotQuery(pi: ExtensionAPI, reason: string): void {
  const query: WorkflowTreeSnapshotQuery = {
    requester: PANE_ID,
    reason,
    requestedAt: new Date().toISOString(),
  };
  pi.events.emit(WORKFLOW_TREE_QUERY_EVENT, query);
}

export default function workflowTreeExtension(pi: ExtensionAPI): void {
  pi.events.on(WORKFLOW_TREE_SNAPSHOT_EVENT, (payload) => {
    const snapshot = parseWorkflowTreeSnapshotPayload(payload);
    if (!snapshot) return;

    latestSnapshot = snapshot;
    if (!lastContext) return;

    setWorkflowTreeVisible(snapshot.overlayVisible === true);
    overlayTiler?.requestRender();
  });

  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    latestSnapshot = undefined;
    persistedSeed = undefined;
    loadConfig(ctx);

    overlayTiler?.dispose();
    overlayTiler = registerRightOverlayPane(pi, {
      id: PANE_ID,
      order: currentConfig.overlayOrder,
      minWidth: currentConfig.paneMinWidth,
      render: (width, state) => buildWorkflowTreePaneLines(ctx, width, state),
    });
    overlayTiler.setVisible(false);

    persistedSeed = readPersistedWorkflowSeed(ctx.cwd);
    emitSnapshotQuery(pi, "session_start");
  });

  pi.on("session_shutdown", () => {
    lastContext = undefined;
    persistedSeed = undefined;
    latestSnapshot = undefined;
    overlayTiler?.setVisible(false);
    overlayTiler?.dispose();
    overlayTiler = undefined;
  });
}
