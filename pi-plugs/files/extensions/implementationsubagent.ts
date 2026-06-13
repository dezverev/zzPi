import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  CHILD_PI_AGENT_ENV,
  type ChildAgentProgress,
  type ChildAgentRunResult,
  type ChildPiAgentConfig,
  formatChildAgentConfig,
  formatChildAgentReport,
  getChildAgentResultDetails,
  getErrorMessage,
  getModelSelector,
  isRecord,
  LEGACY_LOCALAGENT_CHILD_ENV,
  previewTask,
  readChildPiAgentConfig,
  registerChildAgentProvider,
  renderChildAgentMessage,
  renderChildAgentToolResult,
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
import { getBooleanField, readJsoncConfig } from "./lib/jsonc-config.ts";

const CONFIG_FILE_PATH = ".pi/extensions/implementationsubagent.config.jsonc";
const IMPLEMENTATION_SUBAGENT_MESSAGE_TYPE = "implementationsubagent-report";
const IMPLEMENTATION_SUBAGENT_STATE_ENTRY_TYPE = "implementationsubagent-state";
const STATUS_KEY = "implementationsubagent";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "readsubagent", "explorationsubagent"];
const EXCLUDED_CHILD_TOOLS = [
  "localagent",
  "refagent",
  "prreview",
  "reviewsubagent",
  "gitopsagent",
  "simpletasksubagent",
  "implementationsubagent",
  "zzSubagentImplemention",
  "zzSubagentImplementation",
  "zzsubagentimplemention",
  "zzsubagentimplementation",
  "zz-subagent-implementation",
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

const MAIN_IMPLEMENTATION_SUBAGENT_PROMPT = [
  "<zzSubagentImplemention_mode>",
  "zzSubagentImplemention mode is ON. Mandatory decision rule: for any involved implementation task, delegate the implementation work to implementationsubagent instead of doing all edits directly in the parent context unless the change is truly trivial.",
  "Give implementationsubagent a concrete, self-contained task: the implementation plan or intended approach, necessary repository context, relevant paths/symbols discovered so far, constraints, acceptance criteria, and validation to run when practical.",
  "The parent agent should still do lightweight orchestration: clarify the user's goal, gather only the context needed to write a good delegation, review the child report, perform final verification when needed, and summarize results to the user.",
  "Use normal parent tools directly for trivial one-file edits, exact last-mile reads needed to prepare a delegation, final verification snippets, and user-visible summaries. Use readsubagent for targeted factual file questions and explorationsubagent for broad repo discovery before delegating implementation when that reduces ambiguity.",
  "Do not delegate code-review judgment, PR readiness, git/branch/commit/push operations, or broad exploratory archaeology to implementationsubagent; use the dedicated review/git/exploration tools when available.",
  "If implementationsubagent reports blockers, questions, failed validation, or risky ambiguity, stop and surface that information instead of silently expanding scope.",
  "</zzSubagentImplemention_mode>",
].join("\n");

const DEFAULT_IMPLEMENTATION_SUBAGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 400_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "gpt-5.5",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 40_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are implementationsubagent, a Pi implementation subagent. Work autonomously on the delegated implementation task using repository tools as needed. Follow repo PI.md/AGENTS.md instructions. Keep scope tight to the supplied plan and context, edit/write files when needed, run targeted validation when practical, and return a concise structured report with status, files changed, tests/checks run, validation result, blockers/questions, and notes. Do not perform git commits, pushes, branch operations, PR operations, broad code review, or unrelated follow-up work unless explicitly requested.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

interface ImplementationSubagentState {
  readonly enabled: boolean;
  readonly selectedModelId?: string;
}

interface ImplementationSubagentSavedState {
  readonly enabled?: boolean;
  readonly selectedModelId?: string;
}

interface ImplementationSubagentMainConfig {
  readonly enabledByDefault: boolean;
}

interface ImplementationSubagentRunOptions {
  readonly config: ChildPiAgentConfig;
  readonly context?: string | undefined;
  readonly constraints?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly defaultCwd: string;
  readonly maxReportChars?: number | undefined;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly output?: string | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly plan?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly task: string;
  readonly validation?: readonly string[] | undefined;
}

type ImplementationSubagentModelOption = ChildAgentModelOption;

const DEFAULT_IMPLEMENTATION_SUBAGENT_MAIN_CONFIG: ImplementationSubagentMainConfig = {
  enabledByDefault: false,
};

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_IMPLEMENTATION_SUBAGENT_CONFIG };
let currentMainConfig: ImplementationSubagentMainConfig = {
  ...DEFAULT_IMPLEMENTATION_SUBAGENT_MAIN_CONFIG,
};
let currentModelOptions: readonly ImplementationSubagentModelOption[] = [
  createChildAgentModelOptionFromConfig(DEFAULT_IMPLEMENTATION_SUBAGENT_CONFIG),
];
let implementationSubagentEnabled = false;
let lastConfigError: string | undefined;
let lastMainConfigError: string | undefined;
let selectedImplementationSubagentModelId: string | undefined;

function readImplementationSubagentModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly ImplementationSubagentModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "implementationsubagent",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getImplementationSubagentModelOption(
  id: string | undefined,
): ImplementationSubagentModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findImplementationSubagentModelOption(input: string): ImplementationSubagentModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getImplementationSubagentModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableImplementationSubagentModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatImplementationSubagentModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedImplementationSubagentModelId,
  });
}

function applyImplementationSubagentModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(
    config,
    getImplementationSubagentModelOption(selectedImplementationSubagentModelId),
  );
}

function readImplementationSubagentConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "implementationsubagent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_IMPLEMENTATION_SUBAGENT_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readImplementationSubagentMainConfig(cwd: string): ImplementationSubagentMainConfig {
  lastMainConfigError = undefined;

  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, cwd);
    if (!record) return { ...DEFAULT_IMPLEMENTATION_SUBAGENT_MAIN_CONFIG };

    return {
      enabledByDefault:
        getBooleanField(record, "enabledByDefault") ??
        DEFAULT_IMPLEMENTATION_SUBAGENT_MAIN_CONFIG.enabledByDefault,
    };
  } catch (error) {
    lastMainConfigError = getErrorMessage(error);
    return { ...DEFAULT_IMPLEMENTATION_SUBAGENT_MAIN_CONFIG };
  }
}

function readActiveImplementationSubagentConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readImplementationSubagentConfig(cwd);
  currentModelOptions = readImplementationSubagentModelOptions(cwd, baseConfig);
  return applyImplementationSubagentModelSelection(baseConfig);
}

function reloadImplementationSubagentSettings(pi: ExtensionAPI, cwd: string): void {
  currentMainConfig = readImplementationSubagentMainConfig(cwd);
  currentConfig = readActiveImplementationSubagentConfig(cwd);
  registerImplementationSubagentProvider(pi, currentConfig);
}

function registerImplementationSubagentProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (implementationsubagent)",
    providerDisplayName: "Implementation Subagent",
  });
}

function notifyConfigErrors(ctx: ExtensionContext): void {
  if (lastConfigError) ctx.ui.notify(`implementationsubagent config ignored: ${lastConfigError}`, "warning");
  if (lastMainConfigError) {
    ctx.ui.notify(`implementationsubagent main config ignored: ${lastMainConfigError}`, "warning");
  }
}

function getSavedStateFromBranch(ctx: ExtensionContext): ImplementationSubagentSavedState {
  let saved: ImplementationSubagentSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== IMPLEMENTATION_SUBAGENT_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const enabled = typeof entry.data.enabled === "boolean" ? entry.data.enabled : saved.enabled;
    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getImplementationSubagentModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : saved.selectedModelId;

    saved = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(selectedModelId ? { selectedModelId } : {}),
    };
  }

  return saved;
}

function applyStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(
    STATUS_KEY,
    implementationSubagentEnabled ? "zzSubagentImplemention: on" : undefined,
  );
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readImplementationSubagentConfig(ctx.cwd);
  currentModelOptions = readImplementationSubagentModelOptions(ctx.cwd, baseConfig);
  currentMainConfig = readImplementationSubagentMainConfig(ctx.cwd);

  const saved = getSavedStateFromBranch(ctx);
  implementationSubagentEnabled = saved.enabled ?? currentMainConfig.enabledByDefault;
  selectedImplementationSubagentModelId = saved.selectedModelId;
  currentConfig = applyImplementationSubagentModelSelection(baseConfig);
  registerImplementationSubagentProvider(pi, currentConfig);
  applyStatus(ctx);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<ImplementationSubagentState>(IMPLEMENTATION_SUBAGENT_STATE_ENTRY_TYPE, {
    enabled: implementationSubagentEnabled,
    ...(selectedImplementationSubagentModelId
      ? { selectedModelId: selectedImplementationSubagentModelId }
      : {}),
  });
}

function setEnabled(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): void {
  implementationSubagentEnabled = enabled;
  persistState(pi);
  applyStatus(ctx);
}

async function selectImplementationSubagentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  reloadImplementationSubagentSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findImplementationSubagentModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown implementationsubagent model "${requested}". Available: ${formatAvailableImplementationSubagentModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /zzSubagentImplemention model <model>. Available: ${formatAvailableImplementationSubagentModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select implementationsubagent model", choices);
    if (!choice) {
      ctx.ui.notify("implementationsubagent model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No implementationsubagent models are available", "warning");
    return;
  }

  selectedImplementationSubagentModelId = option.id;
  persistState(pi);
  reloadImplementationSubagentSettings(pi, ctx.cwd);
  applyStatus(ctx);
  ctx.ui.notify(
    `implementationsubagent model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
    "info",
  );
}

function normalizeStringList(items: readonly string[] | undefined): string[] {
  return Array.from(new Set((items ?? []).map((item) => item.trim()).filter(Boolean)));
}

function normalizePathList(
  path: string | undefined,
  paths: readonly string[] | undefined,
): string[] {
  return normalizeStringList([...(paths ?? []), ...(path ? [path] : [])]);
}

function formatListSection(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none specified";
}

function formatMainConfig(config: ImplementationSubagentMainConfig): string {
  return [`enabledByDefault: ${config.enabledByDefault}`].join("\n");
}

function formatDelegatedTask(options: {
  readonly constraints: readonly string[];
  readonly context?: string | undefined;
  readonly maxReportChars?: number | undefined;
  readonly output?: string | undefined;
  readonly paths: readonly string[];
  readonly plan?: string | undefined;
  readonly task: string;
  readonly validation: readonly string[];
}): string {
  const output = options.output?.trim();
  const reportBudget = options.maxReportChars
    ? `Aim to keep the final parent-visible report under ${Math.floor(options.maxReportChars).toLocaleString("en-US")} characters.`
    : "Keep the final parent-visible report concise while still including changed files, validation, blockers, and any follow-up needed.";

  return [
    "Implementation task:",
    options.task.trim(),
    "",
    "Parent-supplied implementation plan or intended approach:",
    options.plan?.trim() || "- not supplied; infer the smallest safe approach from the task and repository context",
    "",
    "Relevant repo-relative paths:",
    formatListSection(options.paths),
    "",
    "Additional repository/user context:",
    options.context?.trim() || "- none supplied",
    "",
    "Constraints and scope limits:",
    formatListSection(options.constraints),
    "",
    "Validation requested by parent:",
    formatListSection(options.validation),
    "",
    "Desired final report:",
    output ||
      [
        "- Status: completed, blocked, or questions",
        "- Summary of what changed",
        "- Files changed (repo-relative)",
        "- Tests/checks run and results",
        "- Validation evidence or why validation was not run",
        "- Blockers/questions/follow-up, if any",
      ].join("\n"),
    "",
    "Report constraints:",
    `- ${reportBudget}`,
    "- Do not include unrelated raw command output unless it is necessary to explain a failure.",
    "- If you cannot safely implement within the supplied scope, stop and report blockers/questions instead of expanding scope.",
  ].join("\n");
}

function buildImplementationSubagentPrompt(task: string): string {
  return [
    "You are running as implementationsubagent, an implementation worker spawned by the parent Pi agent.",
    "Implement the delegated task in the repository. Treat the parent-supplied task, plan, context, constraints, and validation requests as the scope boundary.",
    "Use repository tools to inspect files, edit/write files, and run focused checks/tests when practical. Use readsubagent or explorationsubagent only for factual context gathering when it materially reduces ambiguity.",
    "Do not perform git commits, pushes, branch operations, PR operations, broad code-review judgment, or unrelated follow-up work. Do not call implementationsubagent, localagent, review/git agents, or wf-* agents.",
    "Prefer minimal, maintainable changes aligned with existing project conventions. If the task is unsafe, underspecified, or blocked, return questions/blockers rather than guessing.",
    "Return a concise structured final report with: Status, Summary, Files Changed, Tests/Checks Run, Validation, Blockers/Questions, and Notes. Include exact repo-relative paths for changed files.",
    `Delegated implementation task:\n${task}`,
  ].join("\n\n");
}

async function runImplementationSubagentTask(
  options: ImplementationSubagentRunOptions,
): Promise<ChildAgentRunResult> {
  const task = formatDelegatedTask({
    constraints: normalizeStringList(options.constraints),
    context: options.context,
    maxReportChars: options.maxReportChars,
    output: options.output,
    paths: normalizeStringList(options.paths),
    plan: options.plan,
    task: options.task,
    validation: normalizeStringList(options.validation),
  });

  return runChildPiAgent({
    buildPrompt: buildImplementationSubagentPrompt,
    config: options.config,
    cwd: options.cwd,
    defaultCwd: options.defaultCwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    signal: options.signal,
    task,
  });
}

function getReportMaxChars(config: ChildPiAgentConfig, requested: number | undefined): number {
  if (requested === undefined) return config.reportMaxChars;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error("implementationsubagent maxReportChars must be a positive number.");
  }

  return Math.min(config.reportMaxChars, Math.floor(requested));
}

function formatReport(
  result: ChildAgentRunResult,
  config: ChildPiAgentConfig,
  requestedMaxReportChars?: number,
): string {
  return truncateText(
    formatChildAgentReport(result, config, { title: "Implementation subagent report" }),
    getReportMaxChars(config, requestedMaxReportChars),
  );
}

function isChildPiAgentProcess(): boolean {
  return (
    process.env[CHILD_PI_AGENT_ENV] === "1" || process.env[LEGACY_LOCALAGENT_CHILD_ENV] === "1"
  );
}

function formatStatus(): string {
  return [
    `zzSubagentImplemention mode: ${implementationSubagentEnabled ? "on" : "off"}`,
    `enabled by default: ${currentMainConfig.enabledByDefault ? "on" : "off"}`,
    formatImplementationSubagentModelSelection(currentConfig),
    `Config: ${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}`,
    "When on, the main agent is instructed to delegate involved implementation work to implementationsubagent with a concrete plan, relevant context, scope limits, and validation expectations. Alt+S toggles this mode.",
    "Commands: /zzSubagentImplemention on | off | toggle | status | model [model] | config | ask <implementation task>. Aliases: /zzSubagentImplementation, /zzsubagentimplemention, /zzsubagentimplementation, /implementationsubagent, /zz-subagent-implementation.",
  ].join("\n");
}

function getCommandCompletions(prefix: string) {
  const trimmed = prefix.trimStart();
  const hasTrailingSpace = /\s$/u.test(prefix);
  const parts = trimmed ? trimmed.split(/\s+/u) : [];
  const [first = "", ...rest] = parts;
  const normalizedFirst = first.toLowerCase();

  if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
    const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
    return getImplementationSubagentModelCompletions(modelPrefix);
  }

  if (trimmed.includes(" ") || hasTrailingSpace) return null;

  return ["on", "off", "toggle", "status", "model", "ask", "config"]
    .filter((item) => item.startsWith(normalizedFirst))
    .map((value) => ({ value, label: value }));
}

function registerImplementationSubagentCommand(pi: ExtensionAPI, name: string): void {
  pi.registerCommand(name, {
    description:
      "Toggle zzSubagentImplemention mode, select its model, or manually run an implementation subagent task",
    getArgumentCompletions: getCommandCompletions,
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [command = "status", ...rest] = trimmed.split(/\s+/u);
      const normalized = command.toLowerCase();

      if (!trimmed || normalized === "status") {
        reloadImplementationSubagentSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        applyStatus(ctx);
        notifyConfigErrors(ctx);
        return;
      }

      if (normalized === "on" || normalized === "off" || normalized === "toggle") {
        const nextEnabled = normalized === "toggle" ? !implementationSubagentEnabled : normalized === "on";
        setEnabled(pi, ctx, nextEnabled);
        ctx.ui.notify(formatStatus(), "info");
        return;
      }

      if (normalized === "config") {
        reloadImplementationSubagentSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `implementationsubagent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatImplementationSubagentModelSelection(currentConfig)}\n${formatMainConfig(currentMainConfig)}`,
          "info",
        );
        notifyConfigErrors(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectImplementationSubagentModel(pi, ctx, rest.join(" "));
        notifyConfigErrors(ctx);
        return;
      }

      const task = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!task) {
        ctx.ui.notify(
          `Usage: /${name} on | off | toggle | status | model [model] | config | ask <implementation task>`,
          "warning",
        );
        return;
      }

      const config = readActiveImplementationSubagentConfig(ctx.cwd);
      registerImplementationSubagentProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(task)}`);

      try {
        const result = await runImplementationSubagentTask({
          config,
          defaultCwd: ctx.cwd,
          task,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        const report = formatReport(result, config);
        sendChildAgentReportMessage({
          config,
          ctx,
          messageType: IMPLEMENTATION_SUBAGENT_MESSAGE_TYPE,
          pi,
          report,
          result,
        });

        const level = result.status === "completed" ? "info" : "warning";
        ctx.ui.notify(`implementationsubagent ${result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`implementationsubagent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        applyStatus(ctx);
      }
    },
  });
}

export default function implementationSubagentExtension(pi: ExtensionAPI): void {
  reloadImplementationSubagentSettings(pi, process.cwd());

  pi.on("session_start", (_event, ctx) => {
    restoreState(pi, ctx);
    notifyConfigErrors(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreState(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerMessageRenderer(IMPLEMENTATION_SUBAGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "implementationsubagent" }),
  );

  pi.on("before_agent_start", (event) => {
    if (!implementationSubagentEnabled || isChildPiAgentProcess()) return undefined;
    if (!pi.getActiveTools().includes("implementationsubagent")) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${MAIN_IMPLEMENTATION_SUBAGENT_PROMPT}`,
    };
  });

  pi.registerShortcut("alt+s", {
    description: "Toggle zzSubagentImplemention implementation-subagent mode",
    handler: (ctx) => {
      setEnabled(pi, ctx, !implementationSubagentEnabled);
      ctx.ui.notify(formatStatus(), "info");
    },
  });

  registerImplementationSubagentCommand(pi, "zzSubagentImplemention");
  registerImplementationSubagentCommand(pi, "zzSubagentImplementation");
  registerImplementationSubagentCommand(pi, "zzsubagentimplemention");
  registerImplementationSubagentCommand(pi, "zzsubagentimplementation");
  registerImplementationSubagentCommand(pi, "implementationsubagent");
  registerImplementationSubagentCommand(pi, "zz-subagent-implementation");

  pi.registerTool({
    name: "implementationsubagent",
    label: "Implementation Subagent",
    description:
      "Delegate an involved implementation task to a local child Pi process. The child can inspect files, edit/write code, run targeted commands/tests, and returns a concise implementation report.",
    promptSnippet:
      "Delegate involved implementation work to a child Pi process with a concrete plan and context",
    promptGuidelines: [
      "Use implementationsubagent when zzSubagentImplemention mode is on and the user task involves non-trivial implementation work that can be scoped for a child agent.",
      "Give implementationsubagent a self-contained task with the plan or intended approach, repo-relative paths, relevant context, constraints, acceptance criteria, and validation to run when practical.",
      "Prefer readsubagent for targeted factual file questions and explorationsubagent for broad repo discovery before implementation delegation when context is still unclear.",
      "Prefer normal parent tools for trivial edits, exact oldText reads, final verification, and user-facing summaries.",
      "Do not use implementationsubagent for code-review judgment, PR readiness, git/branch/commit/push operations, or broad repo archaeology.",
      "After implementationsubagent returns, inspect its report, run any needed final verification, and surface blockers/questions rather than silently expanding scope.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description:
          "Self-contained implementation task for the child process. Include the concrete outcome expected.",
      }),
      plan: Type.Optional(
        Type.String({
          description:
            "Implementation plan or intended approach the child should follow. Include stages/checkpoints if useful.",
        }),
      ),
      path: Type.Optional(Type.String({ description: "Single repo-relative path relevant to the task" })),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Repo-relative files or directories relevant to the task, ordered by relevance",
        }),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "Additional user/repository context, facts discovered by the parent, or constraints not captured elsewhere",
        }),
      ),
      constraints: Type.Optional(
        Type.Array(Type.String(), {
          description: "Scope limits, safety boundaries, style constraints, or things the child must not change",
        }),
      ),
      validation: Type.Optional(
        Type.Array(Type.String(), {
          description: "Targeted checks/tests/commands the child should run when practical",
        }),
      ),
      output: Type.Optional(
        Type.String({
          description:
            "Desired final report shape and level of detail, e.g. changed files/tests/blockers summary",
        }),
      ),
      maxReportChars: Type.Optional(
        Type.Number({
          description:
            "Optional maximum characters to return to the main context. Clamped to the configured reportMaxChars.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Optional working directory for the child process" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = readActiveImplementationSubagentConfig(ctx.cwd);
      registerImplementationSubagentProvider(pi, config);
      const paths = normalizePathList(params.path, params.paths);
      const result = await runImplementationSubagentTask({
        config,
        context: params.context,
        constraints: params.constraints,
        cwd: params.cwd,
        defaultCwd: ctx.cwd,
        maxReportChars: params.maxReportChars,
        output: params.output,
        paths,
        plan: params.plan,
        signal,
        task: params.task,
        validation: params.validation,
        onProgress: (progress) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `implementationsubagent running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
              },
            ],
            details: progress,
          });
        },
      });

      const report = formatReport(result, config, params.maxReportChars);
      return {
        content: [{ type: "text", text: report }],
        details: getChildAgentResultDetails(result, config),
      };
    },

    renderCall(rawArgs: unknown, theme) {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const task = typeof args.task === "string" ? args.task : "";
      const path = typeof args.path === "string" ? args.path : "";
      const pathCount = Array.isArray(args.paths) ? args.paths.length : 0;
      const pathText = path || (pathCount > 0 ? `${pathCount} paths` : "implementation");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("implementationsubagent"))} ${theme.fg("accent", pathText)} ${theme.fg("dim", previewTask(task || "..."))}`,
        0,
        0,
      );
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "implementationsubagent" });
    },
  });
}
