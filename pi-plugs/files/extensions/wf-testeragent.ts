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
import type { WfImpplannerDecision } from "./wf-impplanner.ts";

const CONFIG_FILE_PATH = ".pi/extensions/wf-testeragent.config.jsonc";
const WF_TESTER_AGENT_MESSAGE_TYPE = "wf-testeragent-report";
const WF_TESTER_AGENT_STATE_ENTRY_TYPE = "wf-testeragent-state";
const STATUS_KEY = "wf-testeragent";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "readsubagent"];
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

const DEFAULT_WF_TESTER_AGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 272_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 128_000,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 32_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are wf-testeragent, a workflow-mode testing subagent for Pi. After implementation stages pass their own review, analyze the current branch for reasonable test gaps, add or update focused tests when useful, run targeted validation, and return only the requested JSON decision. Prefer meaningful, maintainable tests over broad or brittle coverage. If reviewer feedback is supplied, address that feedback before returning JSON.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

type WfTesterAgentModelOption = ChildAgentModelOption;

interface WfTesterAgentState {
  readonly selectedModelId?: string;
}

interface WfTesterAgentSavedState {
  readonly selectedModelId?: string;
}

export type WfTesterAgentDecision =
  | {
      readonly kind: "tested_changes";
      readonly changedFiles: readonly string[];
      readonly gapsFound: readonly string[];
      readonly notes?: readonly string[];
      readonly summary: string;
      readonly testsAdded: readonly string[];
      readonly testsRun: readonly string[];
      readonly validation: readonly string[];
    }
  | {
      readonly kind: "no_test_gaps";
      readonly gapsConsidered: readonly string[];
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
      readonly summary?: string;
      readonly testsRun: readonly string[];
    };

export interface WfTesterAgentRunResult {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfTesterAgentDecision;
  readonly parseError?: string;
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_WF_TESTER_AGENT_CONFIG };
let currentModelOptions: readonly WfTesterAgentModelOption[] = [
  createChildAgentModelOptionFromConfig(DEFAULT_WF_TESTER_AGENT_CONFIG),
];
let lastConfigError: string | undefined;
let selectedWfTesterAgentModelId: string | undefined;

function readWfTesterAgentModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly WfTesterAgentModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "wf-testeragent",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getWfTesterAgentModelOption(id: string | undefined): WfTesterAgentModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findWfTesterAgentModelOption(input: string): WfTesterAgentModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getWfTesterAgentModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableWfTesterAgentModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatWfTesterAgentModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedWfTesterAgentModelId,
  });
}

function applyWfTesterAgentModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(config, getWfTesterAgentModelOption(selectedWfTesterAgentModelId));
}

function readWfTesterAgentConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "wf-testeragent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_WF_TESTER_AGENT_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readActiveWfTesterAgentConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readWfTesterAgentConfig(cwd);
  currentModelOptions = readWfTesterAgentModelOptions(cwd, baseConfig);
  return applyWfTesterAgentModelSelection(baseConfig);
}

function reloadWfTesterAgentSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveWfTesterAgentConfig(cwd);
  registerWfTesterAgentProvider(pi, currentConfig);
}

function registerWfTesterAgentProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (wf-testeragent)",
    providerDisplayName: "Workflow Tester Agent",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) ctx.ui.notify(`wf-testeragent config ignored: ${lastConfigError}`, "warning");
}

function getSavedStateFromBranch(ctx: ExtensionContext): WfTesterAgentSavedState {
  let saved: WfTesterAgentSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== WF_TESTER_AGENT_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getWfTesterAgentModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readWfTesterAgentConfig(ctx.cwd);
  currentModelOptions = readWfTesterAgentModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedWfTesterAgentModelId = saved.selectedModelId;
  currentConfig = applyWfTesterAgentModelSelection(baseConfig);
  registerWfTesterAgentProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<WfTesterAgentState>(WF_TESTER_AGENT_STATE_ENTRY_TYPE, {
    ...(selectedWfTesterAgentModelId ? { selectedModelId: selectedWfTesterAgentModelId } : {}),
  });
}

export async function selectWfTesterAgentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
  options?: { readonly quiet?: boolean },
): Promise<void> {
  reloadWfTesterAgentSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findWfTesterAgentModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown wf-testeragent model "${requested}". Available: ${formatAvailableWfTesterAgentModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /wf-testeragent model <model>. Available: ${formatAvailableWfTesterAgentModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select wf-testeragent model", choices);
    if (!choice) {
      ctx.ui.notify("wf-testeragent model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No wf-testeragent models are available", "warning");
    return;
  }

  selectedWfTesterAgentModelId = option.id;
  persistState(pi);
  reloadWfTesterAgentSettings(pi, ctx.cwd);
  if (!options?.quiet) {
    ctx.ui.notify(
      `wf-testeragent model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
      "info",
    );
  }
}

function buildWfTesterAgentTask(options: {
  readonly finalReviewIteration: number;
  readonly implementationPlan: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly implementationPlanArtifactPath?: string | undefined;
  readonly reviewerFeedback?: string | undefined;
  readonly testingAttempt: number;
}): string {
  return [
    `Testing pass before final review iteration: ${options.finalReviewIteration + 1}`,
    `Tester attempt: ${options.testingAttempt}`,
    "",
    "Implementation plan artifact path, if available:",
    options.implementationPlanArtifactPath?.trim() || "- not supplied; use the JSON plan below",
    "",
    "Full reviewed implementation plan JSON:",
    JSON.stringify(options.implementationPlan, null, 2),
    "",
    "Reviewer feedback to address in this tester attempt:",
    options.reviewerFeedback?.trim() || "- none; this is the first tester attempt for this pass",
    "",
    "Testing objective:",
    "- Inspect the current branch changes and implementation plan to identify reasonable test gaps before whole-branch final review.",
    "- Add or update focused, maintainable tests when gaps are worth filling now.",
    "- Avoid brittle, duplicative, or excessive tests; it is acceptable to return no_test_gaps when existing coverage is reasonable.",
    "- Run targeted validation for tests you add or relevant existing tests when practical.",
    "- Prefer test-only changes. Only touch production code if a tiny testability fix is necessary and explain it clearly.",
    "- If validation cannot be run, explain why in testsRun or validation.",
    "- Return JSON only using the requested schema.",
  ].join("\n");
}

function buildWfTesterAgentPrompt(task: string): string {
  return [
    "You are running as wf-testeragent, the testing pass in Pi workflow mode.",
    "You run after planned implementation stages pass per-stage review and before wf-finalreviewagent reviews the whole branch.",
    "Use repository tools to inspect changed files, identify reasonable test gaps, add/update focused tests, and run targeted validation.",
    "Do not call other wf-* agents. Do not perform final code review; a separate reviewer/final reviewer will do that.",
    "Return JSON only. Do not wrap it in markdown. Use one of these shapes:",
    `{"kind":"tested_changes","summary":"what test gaps were filled","gapsFound":["gap"],"testsAdded":["test/file or case"],"changedFiles":["repo/path"],"testsRun":["command or check and result"],"validation":["observable validation"],"notes":["optional note"]}`,
    `{"kind":"no_test_gaps","summary":"why no additional tests are needed","gapsConsidered":["area considered"],"testsRun":["command or check and result"],"validation":["observable validation"]}`,
    `{"kind":"questions","summary":"why testing is blocked on user input","questions":["question 1"]}`,
    `{"kind":"blocked","summary":"short blocker summary","reason":"why the testing pass cannot be safely completed","changedFiles":["repo/path"],"testsRun":["command or check and result"]}`,
    `Delegated wf-testeragent task:\n${task}`,
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
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

export function parseWfTesterAgentDecision(text: string): WfTesterAgentDecision | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;
  const kind = (getOptionalString(parsed, "kind") ?? getOptionalString(parsed, "type") ?? "tested_changes")
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
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
      ...(summary ? { summary } : {}),
      testsRun: getStringArray(parsed.testsRun ?? parsed.tests_run ?? parsed.tests),
    };
  }

  if (kind === "no_test_gaps" || kind === "no_gaps" || kind === "no_changes" || kind === "none") {
    return {
      gapsConsidered: getStringArray(parsed.gapsConsidered ?? parsed.gaps_considered ?? parsed.areas),
      kind: "no_test_gaps",
      summary: summary ?? "No additional reasonable test gaps found",
      testsRun: getStringArray(parsed.testsRun ?? parsed.tests_run ?? parsed.tests),
      validation: getStringArray(parsed.validation ?? parsed.checks),
    };
  }

  if (kind && kind !== "tested_changes" && kind !== "tested" && kind !== "tests_added" && kind !== "complete") {
    return undefined;
  }

  const changedFiles = getStringArray(parsed.changedFiles ?? parsed.changed_files ?? parsed.files);
  const testsAdded = getStringArray(parsed.testsAdded ?? parsed.tests_added ?? parsed.addedTests ?? parsed.added_tests);
  const testsRun = getStringArray(parsed.testsRun ?? parsed.tests_run ?? parsed.tests);
  const validation = getStringArray(parsed.validation ?? parsed.checks);
  const gapsFound = getStringArray(parsed.gapsFound ?? parsed.gaps_found ?? parsed.gaps);

  if (!summary && changedFiles.length === 0 && testsAdded.length === 0 && testsRun.length === 0 && gapsFound.length === 0) {
    return undefined;
  }

  return {
    changedFiles,
    gapsFound,
    kind: "tested_changes",
    notes: getStringArray(parsed.notes),
    summary: summary ?? "Testing pass completed",
    testsAdded,
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

export function formatWfTesterAgentReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfTesterAgentDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Workflow tester agent", ""];
  const { decision } = options;

  if (decision?.kind === "tested_changes") {
    lines.push("- Status: tests added or updated");
    lines.push(`- Summary: ${decision.summary}`, "");
    pushList(lines, "Gaps found", decision.gapsFound);
    pushList(lines, "Tests added/updated", decision.testsAdded);
    pushList(lines, "Changed files", decision.changedFiles);
    pushList(lines, "Tests run", decision.testsRun);
    pushList(lines, "Validation", decision.validation);
    pushList(lines, "Notes", decision.notes ?? []);
  } else if (decision?.kind === "no_test_gaps") {
    lines.push("- Status: no additional reasonable test gaps found");
    lines.push(`- Summary: ${decision.summary}`, "");
    pushList(lines, "Gaps considered", decision.gapsConsidered);
    pushList(lines, "Tests run", decision.testsRun);
    pushList(lines, "Validation", decision.validation);
  } else if (decision?.kind === "questions") {
    if (decision.summary) lines.push(decision.summary, "");
    pushList(lines, "Questions", decision.questions);
  } else if (decision?.kind === "blocked") {
    lines.push("- Status: blocked");
    if (decision.summary) lines.push(`- Summary: ${decision.summary}`);
    lines.push(`- Reason: ${decision.reason}`, "");
    pushList(lines, "Changed files", decision.changedFiles);
    pushList(lines, "Tests run", decision.testsRun);
  } else {
    lines.push("## Raw tester output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }

  lines.push("## Run info", "");
  lines.push(`- Status: ${options.result.status}`);
  lines.push(`- Model: ${options.result.model ?? getModelSelector(options.config)}`);
  lines.push(`- Tools: ${options.result.toolCalls.map((call) => call.name).join(", ") || "none"}`);
  if (options.result.errorMessage) lines.push(`- Error: ${options.result.errorMessage}`);

  return truncateText(lines.join("\n"), options.config.reportMaxChars);
}

export async function runWfTesterAgentForBranch(options: {
  readonly ctx: ExtensionContext;
  readonly finalReviewIteration: number;
  readonly implementationPlan: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly implementationPlanArtifactPath?: string | undefined;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly reviewerFeedback?: string | undefined;
  readonly testingAttempt: number;
}): Promise<WfTesterAgentRunResult> {
  const config = readActiveWfTesterAgentConfig(options.ctx.cwd);
  registerWfTesterAgentProvider(options.pi, config);

  const task = buildWfTesterAgentTask(options);
  const result = await runChildPiAgent({
    buildPrompt: buildWfTesterAgentPrompt,
    config,
    defaultCwd: options.ctx.cwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    task,
  });
  const decision = parseWfTesterAgentDecision(result.output);
  const parseError = decision ? undefined : "wf-testeragent did not return parseable testing JSON";
  const report = formatWfTesterAgentReport({ config, decision, parseError, result });

  return { config, decision, ...(parseError ? { parseError } : {}), report, result };
}

export function sendWfTesterAgentReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: WfTesterAgentRunResult,
): void {
  sendChildAgentReportMessage({
    config: run.config,
    ctx,
    messageType: WF_TESTER_AGENT_MESSAGE_TYPE,
    pi,
    report: run.report,
    result: run.result,
  });
}

function formatStatus(): string {
  return [
    `Model: ${getModelSelector(currentConfig)}`,
    `Config: ${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}`,
    "Commands: /wf-testeragent model [model] | config | ask <manual testing task>. Workflow mode calls this agent automatically before final branch review.",
  ].join("\n");
}

export default function wfTesterAgentExtension(pi: ExtensionAPI): void {
  reloadWfTesterAgentSettings(pi, process.cwd());

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

  pi.registerMessageRenderer(WF_TESTER_AGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "wf-testeragent" }),
  );

  pi.registerCommand("wf-testeragent", {
    description: "Run the workflow-mode testing gap filler manually, inspect its config, or select its model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getWfTesterAgentModelCompletions(modelPrefix);
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
        reloadWfTesterAgentSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadWfTesterAgentSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `wf-testeragent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatWfTesterAgentModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectWfTesterAgentModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const task = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!task) {
        ctx.ui.notify(
          "Usage: /wf-testeragent model [model] | config | ask <manual testing task>; or /wf-testeragent <manual testing task>",
          "warning",
        );
        return;
      }

      const config = readActiveWfTesterAgentConfig(ctx.cwd);
      registerWfTesterAgentProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(task)}`);

      try {
        const result = await runChildPiAgent({
          buildPrompt: buildWfTesterAgentPrompt,
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
        const decision = parseWfTesterAgentDecision(result.output);
        const parseError = decision ? undefined : "wf-testeragent did not return parseable testing JSON";
        const report = formatWfTesterAgentReport({ config, decision, parseError, result });
        sendChildAgentReportMessage({ config, ctx, messageType: WF_TESTER_AGENT_MESSAGE_TYPE, pi, report, result });
        const level = result.status === "completed" && decision ? "info" : "warning";
        ctx.ui.notify(`wf-testeragent ${result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`wf-testeragent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
