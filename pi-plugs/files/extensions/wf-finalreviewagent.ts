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

const CONFIG_FILE_PATH = ".pi/extensions/wf-finalreviewagent.config.jsonc";
const WF_FINAL_REVIEW_AGENT_MESSAGE_TYPE = "wf-finalreviewagent-report";
const WF_FINAL_REVIEW_AGENT_STATE_ENTRY_TYPE = "wf-finalreviewagent-state";
const STATUS_KEY = "wf-finalreviewagent";
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

const DEFAULT_WF_FINAL_REVIEW_AGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 272_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 128_000,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 32_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are wf-finalreviewagent, a workflow-mode whole-branch final reviewer for Pi. After all implementation stages and their per-stage reviews pass, review the branch as a whole. Do not mutate files. If the branch is not ready, return concrete remediation steps that wf-implementeragent can execute, then expect to review the branch again after those fixes pass their own reviewer loop. Return only the requested JSON decision.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

type WfFinalReviewAgentModelOption = ChildAgentModelOption;

interface WfFinalReviewAgentState {
  readonly selectedModelId?: string;
}

interface WfFinalReviewAgentSavedState {
  readonly selectedModelId?: string;
}

export interface WfFinalReviewAgentIssue {
  readonly detail: string;
  readonly severity: "info" | "minor" | "major" | "critical";
  readonly suggestion?: string;
  readonly title: string;
}

export interface WfFinalReviewRemediationStep {
  readonly highPriorityTests: readonly string[];
  readonly instructions: readonly string[];
  readonly objective: string;
  readonly risks: readonly string[];
  readonly title: string;
  readonly touchpoints: readonly string[];
  readonly validation: readonly string[];
}

export interface WfFinalReviewAgentDecision {
  readonly feedback?: string;
  readonly greenSignal: boolean;
  readonly issues: readonly WfFinalReviewAgentIssue[];
  readonly kind: "final_review";
  readonly remediationSteps: readonly WfFinalReviewRemediationStep[];
  readonly summary?: string;
  readonly testsRun: readonly string[];
  readonly verdict: "pass" | "needs_changes" | "blocked";
}

export interface WfFinalReviewAgentRunResult {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfFinalReviewAgentDecision;
  readonly parseError?: string;
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_WF_FINAL_REVIEW_AGENT_CONFIG };
let currentModelOptions: readonly WfFinalReviewAgentModelOption[] = [
  createChildAgentModelOptionFromConfig(DEFAULT_WF_FINAL_REVIEW_AGENT_CONFIG),
];
let lastConfigError: string | undefined;
let selectedWfFinalReviewAgentModelId: string | undefined;

function readWfFinalReviewAgentModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly WfFinalReviewAgentModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "wf-finalreviewagent",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getWfFinalReviewAgentModelOption(id: string | undefined): WfFinalReviewAgentModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findWfFinalReviewAgentModelOption(input: string): WfFinalReviewAgentModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getWfFinalReviewAgentModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableWfFinalReviewAgentModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatWfFinalReviewAgentModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedWfFinalReviewAgentModelId,
  });
}

function applyWfFinalReviewAgentModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(config, getWfFinalReviewAgentModelOption(selectedWfFinalReviewAgentModelId));
}

function readWfFinalReviewAgentConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "wf-finalreviewagent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_WF_FINAL_REVIEW_AGENT_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readActiveWfFinalReviewAgentConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readWfFinalReviewAgentConfig(cwd);
  currentModelOptions = readWfFinalReviewAgentModelOptions(cwd, baseConfig);
  return applyWfFinalReviewAgentModelSelection(baseConfig);
}

function reloadWfFinalReviewAgentSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveWfFinalReviewAgentConfig(cwd);
  registerWfFinalReviewAgentProvider(pi, currentConfig);
}

function registerWfFinalReviewAgentProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (wf-finalreviewagent)",
    providerDisplayName: "Workflow Final Review Agent",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) ctx.ui.notify(`wf-finalreviewagent config ignored: ${lastConfigError}`, "warning");
}

function getSavedStateFromBranch(ctx: ExtensionContext): WfFinalReviewAgentSavedState {
  let saved: WfFinalReviewAgentSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== WF_FINAL_REVIEW_AGENT_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getWfFinalReviewAgentModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readWfFinalReviewAgentConfig(ctx.cwd);
  currentModelOptions = readWfFinalReviewAgentModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedWfFinalReviewAgentModelId = saved.selectedModelId;
  currentConfig = applyWfFinalReviewAgentModelSelection(baseConfig);
  registerWfFinalReviewAgentProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<WfFinalReviewAgentState>(WF_FINAL_REVIEW_AGENT_STATE_ENTRY_TYPE, {
    ...(selectedWfFinalReviewAgentModelId ? { selectedModelId: selectedWfFinalReviewAgentModelId } : {}),
  });
}

export async function selectWfFinalReviewAgentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
  options?: { readonly quiet?: boolean },
): Promise<void> {
  reloadWfFinalReviewAgentSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findWfFinalReviewAgentModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown wf-finalreviewagent model "${requested}". Available: ${formatAvailableWfFinalReviewAgentModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /wf-finalreviewagent model <model>. Available: ${formatAvailableWfFinalReviewAgentModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select wf-finalreviewagent model", choices);
    if (!choice) {
      ctx.ui.notify("wf-finalreviewagent model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No wf-finalreviewagent models are available", "warning");
    return;
  }

  selectedWfFinalReviewAgentModelId = option.id;
  persistState(pi);
  reloadWfFinalReviewAgentSettings(pi, ctx.cwd);
  if (!options?.quiet) {
    ctx.ui.notify(
      `wf-finalreviewagent model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
      "info",
    );
  }
}

function buildWfFinalReviewAgentTask(options: {
  readonly finalReviewIteration: number;
  readonly implementationPlan: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly implementationPlanArtifactPath?: string | undefined;
}): string {
  return [
    `Final review pass: ${options.finalReviewIteration + 1}`,
    "",
    "Implementation plan artifact path, if available:",
    options.implementationPlanArtifactPath?.trim() || "- not supplied; use the JSON plan below",
    "",
    "Full reviewed implementation plan JSON:",
    JSON.stringify(options.implementationPlan, null, 2),
    "",
    "Review objective:",
    "- Perform a whole-branch review after all implementation-plan stages have passed their per-stage wf-revieweragent checks.",
    "- Inspect git status/diff, touched files, tests, and cross-stage integration risks.",
    "- Use read/search/bash tools and readsubagent for evidence. Do not mutate files.",
    "- If the branch is acceptable, return pass with greenSignal=true.",
    "- If fixes are needed, return needs_changes with remediationSteps that can be dispatched to wf-implementeragent. Keep each remediation step concrete, scoped, test-aware, and reviewable.",
    "- If the branch cannot be safely remediated automatically, return blocked with clear feedback.",
    "- Return JSON only using the requested schema.",
  ].join("\n");
}

function buildWfFinalReviewAgentPrompt(task: string): string {
  return [
    "You are running as wf-finalreviewagent, the whole-branch final review gate in Pi workflow mode.",
    "You review the entire current branch after all planned implementation stages and per-stage reviews have passed.",
    "Do not write code or mutate files. Your output controls whether workflow mode completes or dispatches more implementer/reviewer remediation loops.",
    "Return JSON only. Do not wrap it in markdown. Use exactly this shape:",
    `{"kind":"final_review","verdict":"pass|needs_changes|blocked","greenSignal":true,"summary":"short branch-level review summary","feedback":"overall feedback when not green","issues":[{"severity":"info|minor|major|critical","title":"issue title","detail":"issue detail","suggestion":"optional fix"}],"remediationSteps":[{"title":"fix step title","objective":"what this remediation step accomplishes","instructions":["specific implementer instruction"],"highPriorityTests":["test/check to add or run"],"touchpoints":["repo path/symbol/context"],"risks":["risk"],"validation":["validation command/check"]}],"testsRun":["command or check and result"]}`,
    "For verdict=pass, greenSignal must be true and remediationSteps should be empty. For needs_changes or blocked, greenSignal must be false. For needs_changes, include at least one remediationStep unless the feedback itself is the only safe handoff.",
    `Delegated wf-finalreviewagent task:\n${task}`,
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

function normalizeSeverity(value: unknown): WfFinalReviewAgentIssue["severity"] {
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

function normalizeVerdict(value: unknown, greenSignal: boolean | undefined): WfFinalReviewAgentDecision["verdict"] {
  if (greenSignal === true) return "pass";
  if (typeof value !== "string") return "needs_changes";
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (normalized === "pass" || normalized === "passed" || normalized === "green" || normalized === "approved") {
    return greenSignal === false ? "needs_changes" : "pass";
  }
  if (normalized === "blocked" || normalized === "block") return "blocked";
  return "needs_changes";
}

function normalizeIssues(value: unknown): readonly WfFinalReviewAgentIssue[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): WfFinalReviewAgentIssue | undefined => {
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
    .filter((item): item is WfFinalReviewAgentIssue => Boolean(item));
}

function normalizeRemediationSteps(value: unknown): readonly WfFinalReviewRemediationStep[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): WfFinalReviewRemediationStep | undefined => {
      if (!isRecord(item)) return undefined;
      const title = getOptionalString(item, "title") ?? getOptionalString(item, "name") ?? `Final review remediation ${index + 1}`;
      const objective =
        getOptionalString(item, "objective") ??
        getOptionalString(item, "summary") ??
        getOptionalString(item, "details") ??
        title;
      const instructions = getStringArray(item.instructions ?? item.steps ?? item.actions ?? item.suggestions);
      return {
        highPriorityTests: getStringArray(item.highPriorityTests ?? item.high_priority_tests ?? item.tests),
        instructions: instructions.length > 0 ? instructions : [objective],
        objective,
        risks: getStringArray(item.risks),
        title,
        touchpoints: getStringArray(item.touchpoints ?? item.files ?? item.paths),
        validation: getStringArray(item.validation ?? item.checks),
      };
    })
    .filter((item): item is WfFinalReviewRemediationStep => Boolean(item));
}

export function parseWfFinalReviewAgentDecision(text: string): WfFinalReviewAgentDecision | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;
  const kind = (getOptionalString(parsed, "kind") ?? getOptionalString(parsed, "type") ?? "final_review").toLowerCase();
  if (kind && kind !== "final_review" && kind !== "review" && kind !== "branch_review") return undefined;

  const explicitGreenSignal = typeof parsed.greenSignal === "boolean" ? parsed.greenSignal : undefined;
  const verdict = normalizeVerdict(parsed.verdict ?? parsed.status, explicitGreenSignal);
  const greenSignal = explicitGreenSignal ?? (verdict === "pass");
  const issues = normalizeIssues(parsed.issues);
  const remediationSteps = normalizeRemediationSteps(
    parsed.remediationSteps ?? parsed.remediation_steps ?? parsed.fixSteps ?? parsed.fix_steps,
  );
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
    kind: "final_review",
    remediationSteps,
    ...(summary ? { summary } : {}),
    testsRun: getStringArray(parsed.testsRun ?? parsed.tests_run ?? parsed.tests),
    verdict,
  };
}

function formatIssue(issue: WfFinalReviewAgentIssue, index: number): string {
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

export function formatWfFinalReviewAgentFeedback(decision: WfFinalReviewAgentDecision): string {
  const lines = [
    `Final reviewer verdict: ${decision.verdict}`,
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
  if (decision.remediationSteps.length > 0) {
    lines.push("", "Remediation steps:");
    decision.remediationSteps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.title}: ${step.objective}`);
      step.instructions.forEach((instruction) => lines.push(`   - ${instruction}`));
    });
  }
  if (decision.testsRun.length > 0) {
    lines.push("", "Final reviewer tests/checks:", ...decision.testsRun.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

export function formatWfFinalReviewAgentReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfFinalReviewAgentDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Workflow final review agent", ""];
  const { decision } = options;

  if (decision) {
    lines.push(`- Verdict: ${decision.verdict}`);
    lines.push(`- Green signal: ${decision.greenSignal ? "yes" : "no"}`);
    if (decision.summary) lines.push(`- Summary: ${decision.summary}`);
    if (decision.feedback) lines.push("", "## Feedback", "", decision.feedback, "");
    if (decision.issues.length > 0) {
      lines.push("## Issues", "", ...decision.issues.map(formatIssue), "");
    } else {
      lines.push("", "No issues found.", "");
    }
    if (decision.remediationSteps.length > 0) {
      lines.push("## Remediation steps", "");
      decision.remediationSteps.forEach((step, index) => {
        lines.push(`### ${index + 1}. ${step.title}`, "", step.objective, "");
        pushList(lines, "Instructions", step.instructions);
        pushList(lines, "High-priority tests", step.highPriorityTests);
        pushList(lines, "Touchpoints", step.touchpoints);
        pushList(lines, "Risks", step.risks);
        pushList(lines, "Validation", step.validation);
      });
    }
    pushList(lines, "Tests/checks run", decision.testsRun);
  } else {
    lines.push("## Raw final reviewer output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }

  lines.push("## Run info", "");
  lines.push(`- Status: ${options.result.status}`);
  lines.push(`- Model: ${options.result.model ?? getModelSelector(options.config)}`);
  lines.push(`- Tools: ${options.result.toolCalls.map((call) => call.name).join(", ") || "none"}`);
  if (options.result.errorMessage) lines.push(`- Error: ${options.result.errorMessage}`);

  return truncateText(lines.join("\n"), options.config.reportMaxChars);
}

export async function runWfFinalReviewAgentForBranch(options: {
  readonly ctx: ExtensionContext;
  readonly finalReviewIteration: number;
  readonly implementationPlan: Extract<WfImpplannerDecision, { readonly kind: "implementation_plan" }>;
  readonly implementationPlanArtifactPath?: string | undefined;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
}): Promise<WfFinalReviewAgentRunResult> {
  const config = readActiveWfFinalReviewAgentConfig(options.ctx.cwd);
  registerWfFinalReviewAgentProvider(options.pi, config);

  const task = buildWfFinalReviewAgentTask(options);
  const result = await runChildPiAgent({
    buildPrompt: buildWfFinalReviewAgentPrompt,
    config,
    defaultCwd: options.ctx.cwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    task,
  });
  const decision = parseWfFinalReviewAgentDecision(result.output);
  const parseError = decision ? undefined : "wf-finalreviewagent did not return parseable final-review JSON";
  const report = formatWfFinalReviewAgentReport({ config, decision, parseError, result });

  return { config, decision, ...(parseError ? { parseError } : {}), report, result };
}

export function sendWfFinalReviewAgentReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: WfFinalReviewAgentRunResult,
): void {
  sendChildAgentReportMessage({
    config: run.config,
    ctx,
    messageType: WF_FINAL_REVIEW_AGENT_MESSAGE_TYPE,
    pi,
    report: run.report,
    result: run.result,
  });
}

function formatStatus(): string {
  return [
    `Model: ${getModelSelector(currentConfig)}`,
    `Config: ${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}`,
    "Commands: /wf-finalreviewagent model [model] | config | ask <manual branch review task>. Workflow mode calls this agent automatically after all implementation stages pass review.",
  ].join("\n");
}

export default function wfFinalReviewAgentExtension(pi: ExtensionAPI): void {
  reloadWfFinalReviewAgentSettings(pi, process.cwd());

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

  pi.registerMessageRenderer(WF_FINAL_REVIEW_AGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "wf-finalreviewagent" }),
  );

  pi.registerCommand("wf-finalreviewagent", {
    description: "Run the workflow-mode whole-branch final reviewer manually, inspect its config, or select its model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getWfFinalReviewAgentModelCompletions(modelPrefix);
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
        reloadWfFinalReviewAgentSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadWfFinalReviewAgentSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `wf-finalreviewagent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatWfFinalReviewAgentModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectWfFinalReviewAgentModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const task = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!task) {
        ctx.ui.notify(
          "Usage: /wf-finalreviewagent model [model] | config | ask <manual branch review task>; or /wf-finalreviewagent <manual branch review task>",
          "warning",
        );
        return;
      }

      const config = readActiveWfFinalReviewAgentConfig(ctx.cwd);
      registerWfFinalReviewAgentProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(task)}`);

      try {
        const result = await runChildPiAgent({
          buildPrompt: buildWfFinalReviewAgentPrompt,
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
        const decision = parseWfFinalReviewAgentDecision(result.output);
        const parseError = decision ? undefined : "wf-finalreviewagent did not return parseable final-review JSON";
        const report = formatWfFinalReviewAgentReport({ config, decision, parseError, result });
        sendChildAgentReportMessage({ config, ctx, messageType: WF_FINAL_REVIEW_AGENT_MESSAGE_TYPE, pi, report, result });
        const level = result.status === "completed" && decision ? "info" : "warning";
        ctx.ui.notify(`wf-finalreviewagent ${result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`wf-finalreviewagent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
