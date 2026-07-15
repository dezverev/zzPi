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

const CONFIG_FILE_PATH = ".pi/extensions/wf-adversarialreview.config.jsonc";
const WF_ADVERSARIAL_REVIEW_MESSAGE_TYPE = "wf-adversarialreview-report";
const WF_ADVERSARIAL_REVIEW_STATE_ENTRY_TYPE = "wf-adversarialreview-state";
const STATUS_KEY = "wf-adversarialreview";
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

const DEFAULT_WF_ADVERSARIAL_REVIEW_CONFIG: ChildPiAgentConfig = {
  contextWindow: 272_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 128_000,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 20_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are wf-adversarialreview, a workflow-mode review gate for Pi. Adversarially review selected wf-* stage outputs before they are shown as final user-facing workflow output. Use readsubagent only for factual repo context, evidence, constraints, and uncertainty; do not ask it for implementation plans or solution proposals. Return only the requested JSON review envelope.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

type WfAdversarialReviewModelOption = ChildAgentModelOption;

interface WfAdversarialReviewState {
  readonly selectedModelId?: string;
}

interface WfAdversarialReviewSavedState {
  readonly selectedModelId?: string;
}

export interface WfAdversarialReviewIssue {
  readonly detail: string;
  readonly severity: "info" | "minor" | "major" | "critical";
  readonly suggestion?: string;
  readonly title: string;
}

export interface WfAdversarialReviewDecision {
  readonly kind: "reviewed_stage";
  readonly issues: readonly WfAdversarialReviewIssue[];
  readonly reviewedOutput?: unknown;
  readonly stageId: string;
  readonly summary?: string;
  readonly verdict: "pass" | "revised" | "blocked";
}

export interface WfAdversarialReviewRunResult {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfAdversarialReviewDecision;
  readonly parseError?: string;
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_WF_ADVERSARIAL_REVIEW_CONFIG };
let currentModelOptions: readonly WfAdversarialReviewModelOption[] = [
  createChildAgentModelOptionFromConfig(DEFAULT_WF_ADVERSARIAL_REVIEW_CONFIG),
];
let lastConfigError: string | undefined;
let selectedWfAdversarialReviewModelId: string | undefined;

function readWfAdversarialReviewModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly WfAdversarialReviewModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "wf-adversarialreview",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getWfAdversarialReviewModelOption(
  id: string | undefined,
): WfAdversarialReviewModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findWfAdversarialReviewModelOption(
  input: string,
): WfAdversarialReviewModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getWfAdversarialReviewModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableWfAdversarialReviewModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatWfAdversarialReviewModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedWfAdversarialReviewModelId,
  });
}

function applyWfAdversarialReviewModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(
    config,
    getWfAdversarialReviewModelOption(selectedWfAdversarialReviewModelId),
  );
}

function readWfAdversarialReviewConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "wf-adversarialreview",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_WF_ADVERSARIAL_REVIEW_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readActiveWfAdversarialReviewConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readWfAdversarialReviewConfig(cwd);
  currentModelOptions = readWfAdversarialReviewModelOptions(cwd, baseConfig);
  return applyWfAdversarialReviewModelSelection(baseConfig);
}

function reloadWfAdversarialReviewSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveWfAdversarialReviewConfig(cwd);
  registerWfAdversarialReviewProvider(pi, currentConfig);
}

function registerWfAdversarialReviewProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (wf-adversarialreview)",
    providerDisplayName: "Workflow Adversarial Review",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`wf-adversarialreview config ignored: ${lastConfigError}`, "warning");
  }
}

function getSavedStateFromBranch(ctx: ExtensionContext): WfAdversarialReviewSavedState {
  let saved: WfAdversarialReviewSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== WF_ADVERSARIAL_REVIEW_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getWfAdversarialReviewModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readWfAdversarialReviewConfig(ctx.cwd);
  currentModelOptions = readWfAdversarialReviewModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedWfAdversarialReviewModelId = saved.selectedModelId;
  currentConfig = applyWfAdversarialReviewModelSelection(baseConfig);
  registerWfAdversarialReviewProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<WfAdversarialReviewState>(WF_ADVERSARIAL_REVIEW_STATE_ENTRY_TYPE, {
    ...(selectedWfAdversarialReviewModelId
      ? { selectedModelId: selectedWfAdversarialReviewModelId }
      : {}),
  });
}

export async function selectWfAdversarialReviewModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
  options?: { readonly quiet?: boolean },
): Promise<void> {
  reloadWfAdversarialReviewSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findWfAdversarialReviewModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown wf-adversarialreview model "${requested}". Available: ${formatAvailableWfAdversarialReviewModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /wf-adversarialreview model <model>. Available: ${formatAvailableWfAdversarialReviewModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select wf-adversarialreview model", choices);
    if (!choice) {
      ctx.ui.notify("wf-adversarialreview model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No wf-adversarialreview models are available", "warning");
    return;
  }

  selectedWfAdversarialReviewModelId = option.id;
  persistState(pi);
  reloadWfAdversarialReviewSettings(pi, ctx.cwd);
  if (!options?.quiet) {
    ctx.ui.notify(
      `wf-adversarialreview model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
      "info",
    );
  }
}

function buildWfAdversarialReviewTask(options: {
  readonly expectedOutputSchema: string;
  readonly originalPrompt?: string | undefined;
  readonly stageContext?: string | undefined;
  readonly stageId: string;
  readonly stageOutput: string;
  readonly stageReport?: string | undefined;
}): string {
  return [
    "Reviewed stage id:",
    options.stageId,
    "",
    "Original workflow prompt/context:",
    options.originalPrompt?.trim() || "- none supplied",
    "",
    "Stage-specific context:",
    options.stageContext?.trim() || "- none supplied",
    "",
    "Expected reviewedOutput schema/contract:",
    options.expectedOutputSchema,
    "",
    "Stage output JSON to review:",
    options.stageOutput,
    "",
    "Human-readable stage report, if available:",
    options.stageReport?.trim() || "- none supplied",
    "",
    "Review objective:",
    "- Adversarially inspect the stage output before it is shown as final user-facing workflow output.",
    "- Check for mistakes, missing constraints, risky assumptions, contradictions, misleading recommendations, and unclear wording.",
    "- Use readsubagent only for factual repo verification when needed; do not ask it for plans.",
    "- Return a review envelope. If the stage output is acceptable, verdict should be pass and reviewedOutput should preserve the stage output. If corrections are needed, verdict should be revised and reviewedOutput must contain corrected stage output using the expected schema. If the output is too unsafe/invalid to correct, verdict should be blocked and issues should explain why.",
  ].join("\n");
}

function buildWfAdversarialReviewPrompt(task: string): string {
  return [
    "You are running as wf-adversarialreview, a stage-aware review gate in Pi workflow mode.",
    "Your job is adversarial review and correction of another wf-* stage's output before it is displayed as final workflow output.",
    "Use the readsubagent tool for factual inspection of architecture, files, behavior, symbols, docs, configs, or constraints. Do not ask readsubagent for implementation plans, solution proposals, recommendations, or edit strategies.",
    "Do not write code, mutate files, or produce a new implementation plan. Preserve the reviewed stage's expected output schema in reviewedOutput.",
    "Return JSON only. Do not wrap it in markdown. Use exactly this shape:",
    `{"kind":"reviewed_stage","stageId":"wf-stage-id","verdict":"pass|revised|blocked","summary":"short review summary","issues":[{"severity":"info|minor|major|critical","title":"issue title","detail":"issue detail","suggestion":"optional correction"}],"reviewedOutput":{}}`,
    "For pass/revised verdicts, reviewedOutput is required and must match the expected reviewedOutput schema/contract supplied in the task. For blocked verdicts, include reviewedOutput only if a safe corrected version is possible.",
    `Delegated wf-adversarialreview task:\n${task}`,
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

function normalizeVerdict(value: unknown): WfAdversarialReviewDecision["verdict"] {
  if (typeof value !== "string") return "revised";
  const normalized = value.trim().toLowerCase();
  if (normalized === "pass" || normalized === "revised" || normalized === "blocked") return normalized;
  return "revised";
}

function normalizeSeverity(value: unknown): WfAdversarialReviewIssue["severity"] {
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

function normalizeIssues(value: unknown): WfAdversarialReviewIssue[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): WfAdversarialReviewIssue | undefined => {
      if (!isRecord(item)) return undefined;
      const detail = getOptionalString(item, "detail") ?? getOptionalString(item, "description") ?? "";
      if (!detail) return undefined;
      const suggestion = getOptionalString(item, "suggestion");
      return {
        detail,
        severity: normalizeSeverity(item.severity),
        ...(suggestion ? { suggestion } : {}),
        title: getOptionalString(item, "title") ?? `Issue ${index + 1}`,
      };
    })
    .filter((item): item is WfAdversarialReviewIssue => Boolean(item));
}

export function parseWfAdversarialReviewDecision(
  text: string,
): WfAdversarialReviewDecision | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;

  const kind = getOptionalString(parsed, "kind") ?? getOptionalString(parsed, "type") ?? "";
  if (kind && kind !== "reviewed_stage" && kind !== "review") return undefined;

  const stageId = getOptionalString(parsed, "stageId") ?? getOptionalString(parsed, "stage_id");
  if (!stageId) return undefined;

  const reviewedOutput = parsed.reviewedOutput ?? parsed.reviewed_output ?? parsed.correctedOutput;
  const verdict = normalizeVerdict(parsed.verdict);
  const summary = getOptionalString(parsed, "summary");

  return {
    kind: "reviewed_stage",
    issues: normalizeIssues(parsed.issues),
    ...(reviewedOutput !== undefined ? { reviewedOutput } : {}),
    stageId,
    ...(summary ? { summary } : {}),
    verdict,
  };
}

export function stringifyReviewedOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

function formatIssue(issue: WfAdversarialReviewIssue, index: number): string {
  const lines = [`${index + 1}. **${issue.severity}: ${issue.title}**`, `   - ${issue.detail}`];
  if (issue.suggestion) lines.push(`   - Suggestion: ${issue.suggestion}`);
  return lines.join("\n");
}

export function formatWfAdversarialReviewReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfAdversarialReviewDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Workflow adversarial review", ""];
  const { decision } = options;

  if (decision) {
    lines.push(`- Stage: ${decision.stageId}`);
    lines.push(`- Verdict: ${decision.verdict}`);
    if (decision.summary) lines.push(`- Summary: ${decision.summary}`);
    lines.push("");

    if (decision.issues.length > 0) {
      lines.push("## Issues", "", ...decision.issues.map(formatIssue), "");
    } else {
      lines.push("No issues found.", "");
    }
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

export async function runWfAdversarialReviewForStage(options: {
  readonly ctx: ExtensionContext;
  readonly expectedOutputSchema: string;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly originalPrompt?: string | undefined;
  readonly pi: ExtensionAPI;
  readonly stageContext?: string | undefined;
  readonly stageId: string;
  readonly stageOutput: string;
  readonly stageReport?: string | undefined;
}): Promise<WfAdversarialReviewRunResult> {
  const config = readActiveWfAdversarialReviewConfig(options.ctx.cwd);
  registerWfAdversarialReviewProvider(options.pi, config);

  const task = buildWfAdversarialReviewTask(options);
  const result = await runChildPiAgent({
    buildPrompt: buildWfAdversarialReviewPrompt,
    config,
    defaultCwd: options.ctx.cwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    task,
  });
  const decision = parseWfAdversarialReviewDecision(result.output);
  const parseError = decision ? undefined : "wf-adversarialreview did not return parseable review JSON";
  const report = formatWfAdversarialReviewReport({ config, decision, parseError, result });

  return { config, decision, ...(parseError ? { parseError } : {}), report, result };
}

export function sendWfAdversarialReviewReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: WfAdversarialReviewRunResult,
): void {
  sendChildAgentReportMessage({
    config: run.config,
    ctx,
    messageType: WF_ADVERSARIAL_REVIEW_MESSAGE_TYPE,
    pi,
    report: run.report,
    result: run.result,
  });
}

function formatStatus(): string {
  return [
    formatWfAdversarialReviewModelSelection(currentConfig),
    "Commands: /wf-adversarialreview model [model] | config | ask <stage output>. You can also run /wf-adversarialreview <stage output> directly.",
  ].join("\n");
}

export default function wfAdversarialReviewExtension(pi: ExtensionAPI): void {
  reloadWfAdversarialReviewSettings(pi, process.cwd());

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

  pi.registerMessageRenderer(WF_ADVERSARIAL_REVIEW_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "wf-adversarialreview" }),
  );

  pi.registerCommand("wf-adversarialreview", {
    description: "Run the workflow-mode adversarial review gate or select its model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getWfAdversarialReviewModelCompletions(modelPrefix);
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
        reloadWfAdversarialReviewSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadWfAdversarialReviewSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `wf-adversarialreview config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatWfAdversarialReviewModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectWfAdversarialReviewModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const stageOutput = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!stageOutput) {
        ctx.ui.notify(
          "Usage: /wf-adversarialreview model [model] | config | ask <stage output>; or /wf-adversarialreview <stage output>",
          "warning",
        );
        return;
      }

      const config = readActiveWfAdversarialReviewConfig(ctx.cwd);
      registerWfAdversarialReviewProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(stageOutput)}`);

      try {
        const run = await runWfAdversarialReviewForStage({
          ctx,
          expectedOutputSchema:
            "Generic manual review: reviewedOutput may be a corrected version of the supplied content.",
          pi,
          stageId: "manual",
          stageOutput,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        sendWfAdversarialReviewReportMessage(pi, ctx, run);
        const level = run.result.status === "completed" && run.decision ? "info" : "warning";
        ctx.ui.notify(`wf-adversarialreview ${run.result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`wf-adversarialreview failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
