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

const CONFIG_FILE_PATH = ".pi/extensions/wf-clarifier.config.jsonc";
const WF_CLARIFIER_MESSAGE_TYPE = "wf-clarifier-report";
const WF_CLARIFIER_STATE_ENTRY_TYPE = "wf-clarifier-state";
const STATUS_KEY = "wf-clarifier";
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

const DEFAULT_WF_CLARIFIER_CONFIG: ChildPiAgentConfig = {
  contextWindow: 400_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "gpt-5.5",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 20_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are wf-clarifier, a workflow-mode clarification subagent for Pi. Clarify and enrich the user's initial workflow prompt before any implementation planning begins. Use the readsubagent and explorationsubagent tools only to gather relevant repo facts, evidence, and uncertainty; do not ask them for implementation plans or solution proposals. Return only the requested JSON decision.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

type WfClarifierModelOption = ChildAgentModelOption;

interface WfClarifierState {
  readonly selectedModelId?: string;
}

interface WfClarifierSavedState {
  readonly selectedModelId?: string;
}

export interface WfClarifierPromptOption {
  readonly prompt: string;
  readonly rationale?: string;
  readonly title: string;
}

export type WfClarifierDecision =
  | {
      readonly kind: "prompts";
      readonly prompts: readonly WfClarifierPromptOption[];
      readonly summary?: string;
    }
  | {
      readonly kind: "questions";
      readonly questions: readonly string[];
      readonly summary?: string;
    };

export interface WfClarifierRunResult {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfClarifierDecision;
  readonly parseError?: string;
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

type InputHookResult =
  | { readonly action: "continue" }
  | { readonly action: "handled" }
  | { readonly action: "transform"; readonly text: string };

interface PendingOneShotPromptEnrichment {
  readonly originalPrompt: string;
  readonly questions: readonly string[];
}

type OneShotPromptEnrichmentResult =
  | { readonly kind: "enriched"; readonly prompt: string }
  | { readonly kind: "questions"; readonly questions: readonly string[] }
  | { readonly kind: "unchanged" };

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_WF_CLARIFIER_CONFIG };
let currentModelOptions: readonly WfClarifierModelOption[] = [
  createChildAgentModelOptionFromConfig(DEFAULT_WF_CLARIFIER_CONFIG),
];
let lastConfigError: string | undefined;
let selectedWfClarifierModelId: string | undefined;

function readWfClarifierModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly WfClarifierModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "wf-clarifier",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getWfClarifierModelOption(id: string | undefined): WfClarifierModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findWfClarifierModelOption(input: string): WfClarifierModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getWfClarifierModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableWfClarifierModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatWfClarifierModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedWfClarifierModelId,
  });
}

function applyWfClarifierModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(
    config,
    getWfClarifierModelOption(selectedWfClarifierModelId),
  );
}

function readWfClarifierConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "wf-clarifier",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_WF_CLARIFIER_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readActiveWfClarifierConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readWfClarifierConfig(cwd);
  currentModelOptions = readWfClarifierModelOptions(cwd, baseConfig);
  return applyWfClarifierModelSelection(baseConfig);
}

function reloadWfClarifierSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveWfClarifierConfig(cwd);
  registerWfClarifierProvider(pi, currentConfig);
}

function registerWfClarifierProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (wf-clarifier)",
    providerDisplayName: "Workflow Clarifier",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`wf-clarifier config ignored: ${lastConfigError}`, "warning");
  }
}

function getSavedStateFromBranch(ctx: ExtensionContext): WfClarifierSavedState {
  let saved: WfClarifierSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== WF_CLARIFIER_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getWfClarifierModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readWfClarifierConfig(ctx.cwd);
  currentModelOptions = readWfClarifierModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedWfClarifierModelId = saved.selectedModelId;
  currentConfig = applyWfClarifierModelSelection(baseConfig);
  registerWfClarifierProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<WfClarifierState>(WF_CLARIFIER_STATE_ENTRY_TYPE, {
    ...(selectedWfClarifierModelId ? { selectedModelId: selectedWfClarifierModelId } : {}),
  });
}

async function selectWfClarifierModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  reloadWfClarifierSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findWfClarifierModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown wf-clarifier model "${requested}". Available: ${formatAvailableWfClarifierModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /wf-clarifier model <model>. Available: ${formatAvailableWfClarifierModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select wf-clarifier model", choices);
    if (!choice) {
      ctx.ui.notify("wf-clarifier model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No wf-clarifier models are available", "warning");
    return;
  }

  selectedWfClarifierModelId = option.id;
  persistState(pi);
  reloadWfClarifierSettings(pi, ctx.cwd);
  ctx.ui.notify(
    `wf-clarifier model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
    "info",
  );
}

function buildWfClarifierTask(options: {
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
  readonly userPrompt: string;
}): string {
  const priorQuestions = options.priorQuestions?.length
    ? options.priorQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n")
    : "- none";
  const priorAnswers = options.priorAnswers?.trim() || "- none";

  return [
    "User's original workflow prompt:",
    options.userPrompt,
    "",
    "Previous clarification questions, if any:",
    priorQuestions,
    "",
    "User's answers to those questions, if any:",
    priorAnswers,
    "",
    "Clarification objective:",
    "- Determine whether the ask is clear enough to start the workflow process.",
    "- Compare the ask against relevant repo facts using the readsubagent and explorationsubagent tools when repo context could affect interpretation.",
    "- Produce an enriched user prompt, not a detailed implementation plan.",
    "- If the ask is clear, return exactly one enriched prompt.",
    "- If there are a few plausible interpretations or tradeoffs, return two or three enriched prompt options for the user to choose from.",
    "- If essential intent, scope, constraints, or acceptance criteria are missing, return concise questions instead of prompts.",
  ].join("\n");
}

function buildWfClarifierPrompt(task: string): string {
  return [
    "You are running as wf-clarifier, the first subagent in Pi workflow mode.",
    "Your job is clarification and prompt enrichment only. Do not produce an implementation plan, todo list, code, patch, or execution strategy.",
    "Use the explorationsubagent tool for broad repo discovery when relevant files, architecture, conventions, commands, or existing behavior are unclear.",
    "Use the readsubagent tool for targeted inspection of files, docs, configs, or symbols surfaced by the prompt or by exploration.",
    "When calling readsubagent or explorationsubagent, ask only for factual repo findings, evidence, relationships, constraints, and uncertainty. Do not ask those tools for implementation plans, solution proposals, recommendations, or edit strategies; planning is the responsibility of later workflow agents.",
    "The readsubagent and explorationsubagent tools have their own configured Qwen models; rely on them for repo investigation instead of doing raw inspection yourself.",
    "Prefer at least one exploration/read delegation for repo-specific asks. Skip delegation only if the prompt is clearly repo-independent or the available context is already sufficient.",
    "An enriched prompt should preserve the user's intent while adding repo-specific context, relevant paths/symbols, constraints, assumptions, and known unknowns. It should be ready for the next workflow step, but it must not prescribe a detailed implementation plan.",
    "Return JSON only. Do not wrap it in markdown. Use exactly one of these shapes:",
    `{"kind":"prompts","summary":"short reason this is clear enough","prompts":[{"title":"Option title","rationale":"why this option","prompt":"enriched prompt text"}]}`,
    `{"kind":"questions","summary":"why clarification is needed","questions":["question 1","question 2"]}`,
    "Prompt rules: return 1 prompt when the ask is clear, 2-3 prompts when there is meaningful nuance, never more than 3 prompts.",
    "Question rules: ask only questions whose answers would materially change the enriched prompt; keep the list concise.",
    `Delegated wf-clarifier task:\n${task}`,
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

function normalizePromptOptions(value: unknown): WfClarifierPromptOption[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): WfClarifierPromptOption | undefined => {
      if (typeof item === "string") {
        const prompt = item.trim();
        return prompt ? { prompt, title: `Option ${index + 1}` } : undefined;
      }

      if (!isRecord(item)) return undefined;
      const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
      if (!prompt) return undefined;

      const title =
        typeof item.title === "string" && item.title.trim()
          ? item.title.trim()
          : `Option ${index + 1}`;
      const rationale =
        typeof item.rationale === "string" && item.rationale.trim()
          ? item.rationale.trim()
          : undefined;

      return { prompt, ...(rationale ? { rationale } : {}), title };
    })
    .filter((item): item is WfClarifierPromptOption => Boolean(item))
    .slice(0, 3);
}

export function parseWfClarifierDecision(text: string): WfClarifierDecision | undefined {
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
  const summary = typeof parsed.summary === "string" && parsed.summary.trim()
    ? parsed.summary.trim()
    : undefined;

  if (kindValue === "questions" || kindValue === "question") {
    const questions = getStringArray(parsed.questions);
    return questions.length > 0 ? { kind: "questions", questions, ...(summary ? { summary } : {}) } : undefined;
  }

  const promptSource = parsed.prompts ?? parsed.enrichedPrompts ?? parsed.options;
  const prompts = normalizePromptOptions(promptSource);
  if (prompts.length > 0) {
    return { kind: "prompts", prompts, ...(summary ? { summary } : {}) };
  }

  return undefined;
}

export function formatWfClarifierDecisionReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: WfClarifierDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Workflow clarifier", ""];
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
  } else if (decision?.kind === "prompts") {
    lines.push("## Enriched prompt option(s)", "");
    decision.prompts.forEach((option, index) => {
      lines.push(`### ${index + 1}. ${option.title}`, "");
      if (option.rationale) lines.push(option.rationale, "");
      lines.push("```text", option.prompt, "```", "");
    });
  } else {
    lines.push("## Raw clarifier output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }

  lines.push("## Run info", "");
  lines.push(`- Status: ${options.result.status}`);
  lines.push(`- Model: ${options.result.model ?? getModelSelector(options.config)}`);
  lines.push(`- Tools: ${options.result.toolCalls.map((call) => call.name).join(", ") || "none"}`);
  if (options.result.errorMessage) lines.push(`- Error: ${options.result.errorMessage}`);

  return truncateText(lines.join("\n"), options.config.reportMaxChars);
}

export async function runWfClarifierForPrompt(options: {
  readonly ctx: ExtensionContext;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
  readonly userPrompt: string;
}): Promise<WfClarifierRunResult> {
  const config = readActiveWfClarifierConfig(options.ctx.cwd);
  registerWfClarifierProvider(options.pi, config);

  const task = buildWfClarifierTask({
    priorAnswers: options.priorAnswers,
    priorQuestions: options.priorQuestions,
    userPrompt: options.userPrompt,
  });
  const result = await runChildPiAgent({
    buildPrompt: buildWfClarifierPrompt,
    config,
    defaultCwd: options.ctx.cwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    task,
  });
  const decision = parseWfClarifierDecision(result.output);
  const parseError = decision ? undefined : "wf-clarifier did not return parseable decision JSON";
  const report = formatWfClarifierDecisionReport({ config, decision, parseError, result });

  return { config, decision, ...(parseError ? { parseError } : {}), report, result };
}

export function sendWfClarifierReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: WfClarifierRunResult,
): void {
  sendChildAgentReportMessage({
    config: run.config,
    ctx,
    messageType: WF_CLARIFIER_MESSAGE_TYPE,
    pi,
    report: run.report,
    result: run.result,
  });
}

function formatOneShotQuestionList(questions: readonly string[]): string {
  return questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
}

function buildOneShotClarificationFallbackPrompt(options: {
  readonly originalPrompt: string;
  readonly priorAnswers: string;
  readonly priorQuestions: readonly string[];
}): string {
  return [
    "Original prompt:",
    options.originalPrompt,
    "",
    "Clarifying questions:",
    formatOneShotQuestionList(options.priorQuestions),
    "",
    "User answers:",
    options.priorAnswers,
  ].join("\n");
}

async function selectOneShotPromptOption(
  options: readonly WfClarifierPromptOption[],
  ctx: ExtensionContext,
): Promise<WfClarifierPromptOption | undefined> {
  const firstOption = options[0];
  if (!firstOption) return undefined;
  if (options.length === 1) return firstOption;

  if (!ctx.hasUI) {
    ctx.ui.notify(
      `wf-clarifier received ${options.length} enriched prompts but no interactive UI is available; using option 1: ${firstOption.title}`,
      "warning",
    );
    return firstOption;
  }

  const labels = options.map((option, index) => `${index + 1}. ${option.title}`);
  const choice = await ctx.ui.select("Choose enriched prompt", labels);
  if (!choice) return undefined;

  const choiceIndex = labels.indexOf(choice);
  return choiceIndex >= 0 ? options[choiceIndex] : undefined;
}

async function runOneShotPromptEnrichment(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: {
    readonly priorAnswers?: string | undefined;
    readonly priorQuestions?: readonly string[] | undefined;
    readonly userPrompt: string;
  },
): Promise<OneShotPromptEnrichmentResult> {
  const config = readActiveWfClarifierConfig(ctx.cwd);
  registerWfClarifierProvider(pi, config);
  const model = getModelSelector(config);
  ctx.ui.setStatus(STATUS_KEY, `enriching ${model}: ${previewTask(options.userPrompt)}`);

  try {
    const run = await runWfClarifierForPrompt({
      ctx,
      pi,
      priorAnswers: options.priorAnswers,
      priorQuestions: options.priorQuestions,
      userPrompt: options.userPrompt,
      onProgress: (progress) => {
        const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
        ctx.ui.setStatus(
          STATUS_KEY,
          `enriching ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
        );
      },
    });
    sendWfClarifierReportMessage(pi, ctx, run);

    if (!run.decision) {
      ctx.ui.notify(
        "wf-clarifier could not parse an enriched prompt; continuing without further enrichment.",
        "warning",
      );
      return { kind: "unchanged" };
    }

    if (run.decision.kind === "questions") {
      ctx.ui.notify(
        "wf-clarifier needs answers before it can enrich this prompt. Answer the questions in your next prompt, or press Alt+E to cancel.",
        "warning",
      );
      return { kind: "questions", questions: run.decision.questions };
    }

    const selected = await selectOneShotPromptOption(run.decision.prompts, ctx);
    if (!selected) {
      ctx.ui.notify("wf-clarifier prompt enrichment cancelled; continuing without further enrichment.", "info");
      return { kind: "unchanged" };
    }

    ctx.ui.notify(`wf-clarifier enriched next prompt: ${selected.title}`, "info");
    return { kind: "enriched", prompt: selected.prompt };
  } catch (error) {
    ctx.ui.notify(
      `wf-clarifier prompt enrichment failed: ${getErrorMessage(error)}. Continuing without further enrichment.`,
      "error",
    );
    return { kind: "unchanged" };
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

function formatStatus(): string {
  return [
    formatWfClarifierModelSelection(currentConfig),
    "Commands: /wf-clarifier model [model] | config | ask <prompt>. You can also run /wf-clarifier <prompt> directly. Shortcut: Alt+E enriches the next prompt, asks follow-up questions if needed, then sends the enriched prompt normally.",
  ].join("\n");
}

export default function wfClarifierExtension(pi: ExtensionAPI): void {
  let enrichNextPrompt = false;
  let pendingOneShotPromptEnrichment: PendingOneShotPromptEnrichment | undefined;

  const clearOneShotPromptEnrichment = (ctx: ExtensionContext): void => {
    enrichNextPrompt = false;
    pendingOneShotPromptEnrichment = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const waitForOneShotPromptAnswers = (
    ctx: ExtensionContext,
    originalPrompt: string,
    questions: readonly string[],
  ): void => {
    enrichNextPrompt = false;
    pendingOneShotPromptEnrichment = { originalPrompt, questions };
    ctx.ui.setStatus(STATUS_KEY, "prompt enrichment waiting for answers");
  };

  reloadWfClarifierSettings(pi, process.cwd());

  pi.on("session_start", (_event, ctx) => {
    clearOneShotPromptEnrichment(ctx);
    restoreState(pi, ctx);
    notifyConfigErrorIfNeeded(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    clearOneShotPromptEnrichment(ctx);
    restoreState(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearOneShotPromptEnrichment(ctx);
  });

  pi.registerMessageRenderer(WF_CLARIFIER_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "wf-clarifier" }),
  );

  pi.registerShortcut("alt+e", {
    description: "Enrich the next prompt with wf-clarifier, then send it normally",
    handler: async (ctx) => {
      const wasActive = enrichNextPrompt || pendingOneShotPromptEnrichment !== undefined;
      clearOneShotPromptEnrichment(ctx);

      if (wasActive) {
        ctx.ui.notify("wf-clarifier next-prompt enrichment cancelled.", "info");
        return;
      }

      enrichNextPrompt = true;
      ctx.ui.setStatus(STATUS_KEY, "next prompt enrichment armed");
      ctx.ui.notify(
        "wf-clarifier will enrich the next prompt before sending it normally. If it asks questions, answer them in your following prompt; press Alt+E again to cancel.",
        "info",
      );
    },
  });

  pi.on("input", async (event, ctx): Promise<InputHookResult> => {
    if (event.source === "extension") return { action: "continue" };

    const userPrompt = event.text.trim();
    if (!userPrompt) return { action: "continue" };

    if (pendingOneShotPromptEnrichment) {
      const pending = pendingOneShotPromptEnrichment;
      pendingOneShotPromptEnrichment = undefined;
      const result = await runOneShotPromptEnrichment(pi, ctx, {
        priorAnswers: event.text,
        priorQuestions: pending.questions,
        userPrompt: pending.originalPrompt,
      });

      if (result.kind === "questions") {
        waitForOneShotPromptAnswers(ctx, pending.originalPrompt, result.questions);
        return { action: "handled" };
      }

      if (result.kind === "enriched") return { action: "transform", text: result.prompt };

      ctx.ui.notify("wf-clarifier continuing with the original prompt plus your answers.", "info");
      return {
        action: "transform",
        text: buildOneShotClarificationFallbackPrompt({
          originalPrompt: pending.originalPrompt,
          priorAnswers: event.text,
          priorQuestions: pending.questions,
        }),
      };
    }

    if (!enrichNextPrompt) return { action: "continue" };

    enrichNextPrompt = false;
    const result = await runOneShotPromptEnrichment(pi, ctx, { userPrompt: event.text });

    if (result.kind === "questions") {
      waitForOneShotPromptAnswers(ctx, event.text, result.questions);
      return { action: "handled" };
    }

    if (result.kind === "enriched") return { action: "transform", text: result.prompt };

    return { action: "continue" };
  });

  pi.registerCommand("wf-clarifier", {
    description: "Run the workflow-mode clarification subagent or select its model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getWfClarifierModelCompletions(modelPrefix);
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
        reloadWfClarifierSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadWfClarifierSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `wf-clarifier config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatWfClarifierModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectWfClarifierModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const userPrompt = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!userPrompt) {
        ctx.ui.notify(
          "Usage: /wf-clarifier model [model] | config | ask <prompt>; or /wf-clarifier <prompt>",
          "warning",
        );
        return;
      }

      const config = readActiveWfClarifierConfig(ctx.cwd);
      registerWfClarifierProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(userPrompt)}`);

      try {
        const run = await runWfClarifierForPrompt({
          ctx,
          pi,
          userPrompt,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        sendWfClarifierReportMessage(pi, ctx, run);
        const level = run.result.status === "completed" && run.decision ? "info" : "warning";
        ctx.ui.notify(`wf-clarifier ${run.result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`wf-clarifier failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
