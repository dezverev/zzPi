export const WORKFLOW_TREE_SNAPSHOT_EVENT = "workflow-tree:snapshot";
export const WORKFLOW_TREE_QUERY_EVENT = "workflow-tree:query";
export const WORKFLOW_TREE_SNAPSHOT_SCHEMA_VERSION = 1;

export const WORKFLOW_TREE_STAGES = [
  "clarification_questions",
  "clarifier_prompt_selection",
  "brainstorming_questions",
  "brainstorm_option_selection",
  "design_plan_questions",
  "impplanner_questions",
  "implementation_stage",
  "testing",
  "final_review",
  "complete",
  "stopped",
] as const;

export const WORKFLOW_TREE_STATUSES = [
  "waiting_for_answers",
  "paused",
  "complete",
  "stopped",
] as const;

export const WORKFLOW_TREE_LIFECYCLES = [
  "inactive",
  "waiting_for_initial_prompt",
  "waiting_for_user",
  "running",
  "paused",
  "complete",
  "stopped",
  "error",
] as const;

export type WorkflowTreeStage = (typeof WORKFLOW_TREE_STAGES)[number];
export type WorkflowTreeStatus = (typeof WORKFLOW_TREE_STATUSES)[number];
export type WorkflowTreeLifecycle = (typeof WORKFLOW_TREE_LIFECYCLES)[number];
export type WorkflowTreeTerminalStatus = Extract<WorkflowTreeLifecycle, "complete" | "stopped" | "error">;

/** Use these for renderer-only maps so missing stage/status literals fail type-checks. */
export type WorkflowTreeStageMap<Value> = { readonly [Stage in WorkflowTreeStage]: Value };
export type WorkflowTreeStatusMap<Value> = { readonly [Status in WorkflowTreeStatus]: Value };

export interface WorkflowTreePromptSummary {
  readonly id?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly question?: string;
  readonly description?: string;
}

export interface WorkflowTreeOptionSummary {
  readonly id?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly summary?: string;
}

export interface WorkflowTreeProgressSummary {
  readonly label?: string;
  readonly current?: number;
  readonly total?: number;
  readonly turns?: number;
  readonly toolCalls?: number;
}

export interface WorkflowTreeCompletedStepSummary {
  readonly index?: number;
  readonly title?: string;
  readonly status?: WorkflowTreeTerminalStatus | WorkflowTreeStatus;
  readonly summary?: string;
  readonly completedAt?: string;
}

export interface WorkflowTreeErrorSummary {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
  readonly occurredAt?: string;
}

export interface WorkflowTreeSnapshot {
  readonly schemaVersion: typeof WORKFLOW_TREE_SNAPSHOT_SCHEMA_VERSION;

  /**
   * Actual workflowmode enabled flag. This is independent of Workflow Tree UI
   * ownership and may remain true after terminal complete/stopped restoration
   * while overlayVisible and suppressContextTree are both false.
   */
  readonly workflowModeEnabled: boolean;

  readonly hasWorkflowState: boolean;
  readonly lifecycle: WorkflowTreeLifecycle;

  /** UI intent for the Workflow Tree pane; do not infer it from lifecycle alone. */
  readonly overlayVisible: boolean;

  /** UI intent for Context Tree suppression; keep separate from overlay visibility. */
  readonly suppressContextTree: boolean;

  readonly source: string;
  readonly emittedAt: string;

  readonly stage?: WorkflowTreeStage;
  readonly status?: WorkflowTreeStatus;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly pausedAt?: string;
  readonly terminalAt?: string;

  readonly originalPrompt?: string;
  readonly clarifiedPrompt?: string;
  readonly pendingPrompt?: string;
  readonly pendingPrompts?: readonly WorkflowTreePromptSummary[];
  readonly pendingQuestions?: readonly string[];

  readonly selectedOption?: WorkflowTreeOptionSummary;
  readonly selectedOptionTitle?: string;

  readonly currentSubagent?: string;
  readonly loopLabel?: string;
  readonly phaseLabel?: string;
  readonly progress?: WorkflowTreeProgressSummary;

  readonly implementationStepIndex?: number;
  readonly implementationStepTotal?: number;
  readonly implementationStepTitle?: string;
  readonly finalReviewIteration?: number;
  readonly completedSteps?: readonly WorkflowTreeCompletedStepSummary[];

  readonly terminalStatus?: WorkflowTreeTerminalStatus;
  readonly terminalMessage?: string;
  readonly error?: WorkflowTreeErrorSummary;
}

export interface WorkflowTreeSnapshotQuery {
  readonly requester?: string;
  readonly reason?: string;
  readonly requestedAt?: string;
}
