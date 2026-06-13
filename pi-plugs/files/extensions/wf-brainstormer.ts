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

const CONFIG_FILE_PATH = ".pi/extensions/wf-brainstormer.config.jsonc";
const WF_BRAINSTORMER_MESSAGE_TYPE = "wf-brainstormer-report";
const WF_BRAINSTORMER_STATE_ENTRY_TYPE = "wf-brainstormer-state";
const STATUS_KEY = "wf-brainstormer";
const DEFAULT_TOOLS = ["readsubagent", "explorationsubagent"];
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

const DEFAULT_WF_BRAINSTORMER_CONFIG: ChildPiAgentConfig = {
  contextWindow: 400_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "gpt-5.5",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 24_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are wf-brainstormer, a workflow-mode brainstorming subagent for Pi. Research solution options for the clarified workflow prompt before implementation planning begins. Use readsubagent and explorationsubagent only for factual repo context, evidence, constraints, and uncertainty; do not ask them for implementation plans or solution proposals. Return only the requested JSON decision.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

type WfBrainstormerModelOption = ChildAgentModelOption;

interface WfBrainstormerState {
  readonly selectedModelId?: string;
}

interface WfBrainstormerSavedState {
  readonly selectedModelId?: string;
}

export interface WfBrainstormerOption {
  readonly approach: string;
  readonly cons: readonly string[];
  readonly nextSteps: readonly string[];
  readonly pros: readonly string[];
  readonly repoTouchpoints: readonly string[];
  readonly risks: readonly string[];
  readonly title: string;
  readonly unknowns: readonly string[];
}

export type WfBrainstormerDecision =
  | {
      readonly kind: "brainstorm";
      readonly options: readonly WfBrainstormerOption[];
      readonly questions?: readonly string[];
      readonly recommendedOption?: string;
      readonly summary?: string;
    }
  | {
      readonly kind: "questions";
      readonly questions: readonly string[];
      readonly summary?: string;
    };

export interface WfBrainstormerRunResult {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfBrainstormerDecision;
  readonly parseError?: string;
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_WF_BRAINSTORMER_CONFIG };
let currentModelOptions: readonly WfBrainstormerModelOption[] = [
  createChildAgentModelOptionFromConfig(DEFAULT_WF_BRAINSTORMER_CONFIG),
];
let lastConfigError: string | undefined;
let selectedWfBrainstormerModelId: string | undefined;

function readWfBrainstormerModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly WfBrainstormerModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "wf-brainstormer",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getWfBrainstormerModelOption(id: string | undefined): WfBrainstormerModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findWfBrainstormerModelOption(input: string): WfBrainstormerModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getWfBrainstormerModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableWfBrainstormerModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatWfBrainstormerModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedWfBrainstormerModelId,
  });
}

function applyWfBrainstormerModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(
    config,
    getWfBrainstormerModelOption(selectedWfBrainstormerModelId),
  );
}

function readWfBrainstormerConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "wf-brainstormer",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_WF_BRAINSTORMER_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readActiveWfBrainstormerConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readWfBrainstormerConfig(cwd);
  currentModelOptions = readWfBrainstormerModelOptions(cwd, baseConfig);
  return applyWfBrainstormerModelSelection(baseConfig);
}

function reloadWfBrainstormerSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveWfBrainstormerConfig(cwd);
  registerWfBrainstormerProvider(pi, currentConfig);
}

function registerWfBrainstormerProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (wf-brainstormer)",
    providerDisplayName: "Workflow Brainstormer",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`wf-brainstormer config ignored: ${lastConfigError}`, "warning");
  }
}

function getSavedStateFromBranch(ctx: ExtensionContext): WfBrainstormerSavedState {
  let saved: WfBrainstormerSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== WF_BRAINSTORMER_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getWfBrainstormerModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readWfBrainstormerConfig(ctx.cwd);
  currentModelOptions = readWfBrainstormerModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedWfBrainstormerModelId = saved.selectedModelId;
  currentConfig = applyWfBrainstormerModelSelection(baseConfig);
  registerWfBrainstormerProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<WfBrainstormerState>(WF_BRAINSTORMER_STATE_ENTRY_TYPE, {
    ...(selectedWfBrainstormerModelId ? { selectedModelId: selectedWfBrainstormerModelId } : {}),
  });
}

async function selectWfBrainstormerModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  reloadWfBrainstormerSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findWfBrainstormerModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown wf-brainstormer model "${requested}". Available: ${formatAvailableWfBrainstormerModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /wf-brainstormer model <model>. Available: ${formatAvailableWfBrainstormerModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select wf-brainstormer model", choices);
    if (!choice) {
      ctx.ui.notify("wf-brainstormer model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No wf-brainstormer models are available", "warning");
    return;
  }

  selectedWfBrainstormerModelId = option.id;
  persistState(pi);
  reloadWfBrainstormerSettings(pi, ctx.cwd);
  ctx.ui.notify(
    `wf-brainstormer model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
    "info",
  );
}

function buildWfBrainstormerTask(options: {
  readonly clarifiedPrompt: string;
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
}): string {
  const priorQuestions = options.priorQuestions?.length
    ? options.priorQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n")
    : "- none";
  const priorAnswers = options.priorAnswers?.trim() || "- none";

  return [
    "Clarified workflow prompt:",
    options.clarifiedPrompt,
    "",
    "Previous brainstorming questions, if any:",
    priorQuestions,
    "",
    "User's answers to those questions, if any:",
    priorAnswers,
    "",
    "Brainstorming objective:",
    "- Research solution options for the clarified ask using repo context.",
    "- Surface plausible approaches, repo touchpoints, tradeoffs, risks, and open unknowns.",
    "- This is not the implementation plan step. Do not produce patches, detailed task breakdowns, or file-by-file edit instructions.",
    "- If enough is known, return a brainstorm JSON object with one to four options.",
    "- If essential product/technical direction is missing and would materially change the options, return concise questions instead.",
  ].join("\n");
}

function buildWfBrainstormerPrompt(task: string): string {
  return [
    "You are running as wf-brainstormer, the second subagent in Pi workflow mode.",
    "Your job is solution-space brainstorming after clarification and before implementation planning.",
    "Use the explorationsubagent tool for broad repo discovery around existing architecture, conventions, similar code, configuration, and constraints.",
    "Use the readsubagent tool for targeted inspection of files, symbols, docs, or configs surfaced by exploration.",
    "When calling readsubagent or explorationsubagent, ask only for factual repo findings, evidence, relationships, constraints, and uncertainty. Do not ask those tools for implementation plans, solution proposals, recommendations, or edit strategies; wf-brainstormer owns the solution/options synthesis.",
    "The readsubagent and explorationsubagent tools have their own configured Qwen models; rely on them for repo investigation instead of doing raw inspection yourself.",
    "Do not write code, propose patches, mutate files, or produce a detailed implementation plan. Keep the output at the strategy/options/tradeoff level.",
    "Return JSON only. Do not wrap it in markdown. Use exactly one of these shapes:",
    `{"kind":"brainstorm","summary":"short synthesis","recommendedOption":"optional recommendation or leave blank","options":[{"title":"Option title","approach":"strategy-level description","repoTouchpoints":["relevant path/symbol/context"],"pros":["benefit"],"cons":["tradeoff"],"risks":["risk"],"unknowns":["open unknown"],"nextSteps":["high-level next workflow step"]}],"questions":["optional question for later stages"]}`,
    `{"kind":"questions","summary":"why brainstorming is blocked","questions":["question 1","question 2"]}`,
    "Brainstorm rules: return 1-4 options, prefer 2-3 when there are meaningful alternatives, and make repo touchpoints concrete. Keep nextSteps high-level, not an implementation checklist.",
    "Question rules: ask only questions whose answers would materially change the brainstormed options; keep the list concise.",
    `Delegated wf-brainstormer task:\n${task}`,
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

function normalizeBrainstormOptions(value: unknown): WfBrainstormerOption[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): WfBrainstormerOption | undefined => {
      if (!isRecord(item)) return undefined;
      const approach = getOptionalString(item, "approach") ?? getOptionalString(item, "summary") ?? "";
      if (!approach) return undefined;

      return {
        approach,
        cons: getStringArray(item.cons ?? item.tradeoffs),
        nextSteps: getStringArray(item.nextSteps ?? item.next_steps),
        pros: getStringArray(item.pros ?? item.benefits),
        repoTouchpoints: getStringArray(item.repoTouchpoints ?? item.repo_touchpoints ?? item.touchpoints),
        risks: getStringArray(item.risks),
        title: getOptionalString(item, "title") ?? `Option ${index + 1}`,
        unknowns: getStringArray(item.unknowns ?? item.openQuestions),
      };
    })
    .filter((item): item is WfBrainstormerOption => Boolean(item))
    .slice(0, 4);
}

export function parseWfBrainstormerDecision(text: string): WfBrainstormerDecision | undefined {
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

  const options = normalizeBrainstormOptions(parsed.options ?? parsed.solutions ?? parsed.approaches);
  if (options.length > 0) {
    const questions = getStringArray(parsed.questions);
    const recommendedOption = getOptionalString(parsed, "recommendedOption") ?? getOptionalString(parsed, "recommendation");
    return {
      kind: "brainstorm",
      options,
      ...(questions.length > 0 ? { questions } : {}),
      ...(recommendedOption ? { recommendedOption } : {}),
      ...(summary ? { summary } : {}),
    };
  }

  return undefined;
}

function pushList(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push(`**${title}:**`);
  items.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
}

export function formatWfBrainstormerDecisionReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfBrainstormerDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Workflow brainstormer", ""];
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
  } else if (decision?.kind === "brainstorm") {
    lines.push("## Brainstormed solution options", "");
    if (decision.recommendedOption) {
      lines.push(`**Recommended option:** ${decision.recommendedOption}`, "");
    }

    decision.options.forEach((option, index) => {
      lines.push(`### ${index + 1}. ${option.title}`, "", option.approach, "");
      pushList(lines, "Repo touchpoints", option.repoTouchpoints);
      pushList(lines, "Pros", option.pros);
      pushList(lines, "Cons / tradeoffs", option.cons);
      pushList(lines, "Risks", option.risks);
      pushList(lines, "Unknowns", option.unknowns);
      pushList(lines, "High-level next steps", option.nextSteps);
    });

    if (decision.questions?.length) {
      lines.push("## Questions to carry forward", "");
      decision.questions.forEach((question, index) => {
        lines.push(`${index + 1}. ${question}`);
      });
      lines.push("");
    }
  } else {
    lines.push("## Raw brainstormer output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }

  lines.push("## Run info", "");
  lines.push(`- Status: ${options.result.status}`);
  lines.push(`- Model: ${options.result.model ?? getModelSelector(options.config)}`);
  lines.push(`- Tools: ${options.result.toolCalls.map((call) => call.name).join(", ") || "none"}`);
  if (options.result.errorMessage) lines.push(`- Error: ${options.result.errorMessage}`);

  return truncateText(lines.join("\n"), options.config.reportMaxChars);
}

export async function runWfBrainstormerForPrompt(options: {
  readonly clarifiedPrompt: string;
  readonly ctx: ExtensionContext;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
}): Promise<WfBrainstormerRunResult> {
  const config = readActiveWfBrainstormerConfig(options.ctx.cwd);
  registerWfBrainstormerProvider(options.pi, config);

  const task = buildWfBrainstormerTask({
    clarifiedPrompt: options.clarifiedPrompt,
    priorAnswers: options.priorAnswers,
    priorQuestions: options.priorQuestions,
  });
  const result = await runChildPiAgent({
    buildPrompt: buildWfBrainstormerPrompt,
    config,
    defaultCwd: options.ctx.cwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    task,
  });
  const decision = parseWfBrainstormerDecision(result.output);
  const parseError = decision ? undefined : "wf-brainstormer did not return parseable decision JSON";
  const report = formatWfBrainstormerDecisionReport({ config, decision, parseError, result });

  return { config, decision, ...(parseError ? { parseError } : {}), report, result };
}

export function sendWfBrainstormerReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: WfBrainstormerRunResult,
): void {
  sendChildAgentReportMessage({
    config: run.config,
    ctx,
    messageType: WF_BRAINSTORMER_MESSAGE_TYPE,
    pi,
    report: run.report,
    result: run.result,
  });
}

function formatStatus(): string {
  return [
    formatWfBrainstormerModelSelection(currentConfig),
    "Commands: /wf-brainstormer model [model] | config | ask <prompt>. You can also run /wf-brainstormer <prompt> directly.",
  ].join("\n");
}

export default function wfBrainstormerExtension(pi: ExtensionAPI): void {
  reloadWfBrainstormerSettings(pi, process.cwd());

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

  pi.registerMessageRenderer(WF_BRAINSTORMER_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "wf-brainstormer" }),
  );

  pi.registerCommand("wf-brainstormer", {
    description: "Run the workflow-mode brainstorming subagent or select its model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getWfBrainstormerModelCompletions(modelPrefix);
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
        reloadWfBrainstormerSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadWfBrainstormerSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `wf-brainstormer config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatWfBrainstormerModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectWfBrainstormerModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const clarifiedPrompt = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!clarifiedPrompt) {
        ctx.ui.notify(
          "Usage: /wf-brainstormer model [model] | config | ask <prompt>; or /wf-brainstormer <prompt>",
          "warning",
        );
        return;
      }

      const config = readActiveWfBrainstormerConfig(ctx.cwd);
      registerWfBrainstormerProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(clarifiedPrompt)}`);

      try {
        const run = await runWfBrainstormerForPrompt({
          clarifiedPrompt,
          ctx,
          pi,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        sendWfBrainstormerReportMessage(pi, ctx, run);
        const level = run.result.status === "completed" && run.decision ? "info" : "warning";
        ctx.ui.notify(`wf-brainstormer ${run.result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`wf-brainstormer failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
