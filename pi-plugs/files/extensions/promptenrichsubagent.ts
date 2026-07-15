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
  summarizeToolCalls,
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

const CONFIG_FILE_PATH = ".pi/extensions/promptenrichsubagent.config.jsonc";
const PROMPTENRICH_MESSAGE_TYPE = "promptenrichsubagent-report";
const PROMPTENRICH_STATE_ENTRY_TYPE = "promptenrichsubagent-state";
const STATUS_KEY = "promptenrichsubagent";
const DEFAULT_TOOLS = ["readsubagent"];
const EXCLUDED_CHILD_TOOLS = [
  "promptenrichsubagent",
  "pe",
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

const DEFAULT_PROMPTENRICH_CONFIG: ChildPiAgentConfig = {
  contextWindow: 272_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 128_000,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 20_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are promptenrichsubagent, a standalone prompt-enrichment subagent for Pi. Clarify and enrich a user's prompt before they act on it. Use the readsubagent tool only to gather relevant repo facts, evidence, relationships, constraints, and uncertainty. Do not ask it for implementation plans, solution proposals, recommendations, or edit strategies. The readsubagent tool uses its own configured model; do not try to replace it with raw inspection. Return only the requested JSON decision.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

interface PromptEnrichPromptOption {
  readonly prompt: string;
  readonly rationale?: string;
  readonly title: string;
}

type PromptEnrichDecision =
  | {
      readonly kind: "prompts";
      readonly prompts: readonly PromptEnrichPromptOption[];
      readonly summary?: string;
    }
  | {
      readonly kind: "questions";
      readonly questions: readonly string[];
      readonly summary?: string;
    };

interface PromptEnrichRunResult {
  readonly config: ChildPiAgentConfig;
  readonly decision?: PromptEnrichDecision;
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

type PromptEnrichModelOption = ChildAgentModelOption;

interface PromptEnrichState {
  readonly selectedModelId?: string;
}

interface PromptEnrichSavedState {
  readonly selectedModelId?: string;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_PROMPTENRICH_CONFIG };
let currentModelOptions: readonly PromptEnrichModelOption[] = [
  createPromptEnrichModelOptionFromConfig(DEFAULT_PROMPTENRICH_CONFIG),
];
let lastConfigError: string | undefined;
let selectedPromptEnrichModelId: string | undefined;

function createPromptEnrichModelOptionFromConfig(
  config: ChildPiAgentConfig,
): PromptEnrichModelOption {
  return createChildAgentModelOptionFromConfig(config);
}

function readPromptEnrichModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly PromptEnrichModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "promptenrichsubagent",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getPromptEnrichModelOption(id: string | undefined): PromptEnrichModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findPromptEnrichModelOption(input: string): PromptEnrichModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getPromptEnrichModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailablePromptEnrichModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatPromptEnrichModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedPromptEnrichModelId,
  });
}

function applyPromptEnrichModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(
    config,
    getPromptEnrichModelOption(selectedPromptEnrichModelId),
  );
}

function readPromptEnrichConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "promptenrichsubagent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_PROMPTENRICH_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function readActivePromptEnrichConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readPromptEnrichConfig(cwd);
  currentModelOptions = readPromptEnrichModelOptions(cwd, baseConfig);
  return applyPromptEnrichModelSelection(baseConfig);
}

function registerPromptEnrichProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (promptenrichsubagent)",
    providerDisplayName: "Prompt Enrich Subagent",
  });
}

function reloadPromptEnrichSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActivePromptEnrichConfig(cwd);
  registerPromptEnrichProvider(pi, currentConfig);
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`promptenrichsubagent config ignored: ${lastConfigError}`, "warning");
  }
}

function getSavedStateFromBranch(ctx: ExtensionContext): PromptEnrichSavedState {
  let saved: PromptEnrichSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== PROMPTENRICH_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getPromptEnrichModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readPromptEnrichConfig(ctx.cwd);
  currentModelOptions = readPromptEnrichModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedPromptEnrichModelId = saved.selectedModelId;
  currentConfig = applyPromptEnrichModelSelection(baseConfig);
  registerPromptEnrichProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<PromptEnrichState>(PROMPTENRICH_STATE_ENTRY_TYPE, {
    ...(selectedPromptEnrichModelId ? { selectedModelId: selectedPromptEnrichModelId } : {}),
  });
}

async function selectPromptEnrichModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  reloadPromptEnrichSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findPromptEnrichModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown promptenrichsubagent model "${requested}". Available: ${formatAvailablePromptEnrichModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /pe-model <model>. Available: ${formatAvailablePromptEnrichModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
    const choice = await ctx.ui.select("Select promptenrichsubagent model", choices);
    if (!choice) {
      ctx.ui.notify("promptenrichsubagent model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No promptenrichsubagent models are available", "warning");
    return;
  }

  selectedPromptEnrichModelId = option.id;
  persistState(pi);
  reloadPromptEnrichSettings(pi, ctx.cwd);
  ctx.ui.notify(
    `promptenrichsubagent model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
    "info",
  );
}

function buildPromptEnrichTask(options: {
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
  readonly userPrompt: string;
}): string {
  const priorQuestions = options.priorQuestions?.length
    ? options.priorQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n")
    : "- none";
  const priorAnswers = options.priorAnswers?.trim() || "- none";

  return [
    "User's original prompt:",
    options.userPrompt,
    "",
    "Previous clarification questions, if any:",
    priorQuestions,
    "",
    "User's answers to those questions, if any:",
    priorAnswers,
    "",
    "Enrichment objective:",
    "- Determine whether the ask is clear enough to act on, or whether it needs clarification or enrichment first.",
    "- Compare the ask against relevant repo facts using the readsubagent tool when repo context could affect interpretation.",
    "- Produce an enriched user prompt, not a detailed implementation plan, todo list, code, patch, or execution strategy.",
    "- If the ask is clear, return exactly one enriched prompt.",
    "- If there are a few plausible interpretations or tradeoffs, return two or three enriched prompt options for the user to choose from.",
    "- If essential intent, scope, constraints, or acceptance criteria are missing, return concise questions instead of prompts.",
  ].join("\n");
}

function buildPromptEnrichPrompt(task: string): string {
  return [
    "You are running as promptenrichsubagent, a standalone prompt-enrichment subagent for Pi.",
    "Your job is clarification and prompt enrichment only. Do not produce an implementation plan, todo list, code, patch, or execution strategy.",
    "Use the readsubagent tool for factual inspection of relevant files, docs, configs, symbols, architecture, conventions, and existing behavior.",
    "When calling readsubagent, ask only for factual repo findings, evidence, relationships, constraints, and uncertainty. Do not ask it for implementation plans, solution proposals, recommendations, or edit strategies.",
    "The readsubagent tool has its own configured model; rely on it for repo investigation instead of doing raw inspection yourself.",
    "Prefer at least one readsubagent delegation for repo-specific asks. Skip delegation only if the prompt is clearly repo-independent or the available context is already sufficient.",
    "An enriched prompt should preserve the user's intent while adding repo-specific context, relevant paths/symbols, constraints, assumptions, and known unknowns. It should be ready to act on, but it must not prescribe a detailed implementation plan.",
    "Return JSON only. Do not wrap it in markdown. Use exactly one of these shapes:",
    `{"kind":"prompts","summary":"short reason this is clear enough","prompts":[{"title":"Option title","rationale":"why this option","prompt":"enriched prompt text"}]}`,
    `{"kind":"questions","summary":"why clarification is needed","questions":["question 1","question 2"]}`,
    "Prompt rules: return 1 prompt when the ask is clear, 2-3 prompts when there is meaningful nuance, never more than 3 prompts.",
    "Question rules: ask only questions whose answers would materially change the enriched prompt; keep the list concise.",
    `Delegated promptenrichsubagent task:\n${task}`,
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

function normalizePromptOptions(value: unknown): PromptEnrichPromptOption[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): PromptEnrichPromptOption | undefined => {
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
    .filter((item): item is PromptEnrichPromptOption => Boolean(item))
    .slice(0, 3);
}

function parsePromptEnrichDecision(text: string): PromptEnrichDecision | undefined {
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
    return questions.length > 0
      ? { kind: "questions", questions, ...(summary ? { summary } : {}) }
      : undefined;
  }

  const promptSource = parsed.prompts ?? parsed.enrichedPrompts ?? parsed.options;
  const prompts = normalizePromptOptions(promptSource);
  if (prompts.length > 0) {
    return { kind: "prompts", prompts, ...(summary ? { summary } : {}) };
  }

  return undefined;
}

function formatPromptEnrichReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: PromptEnrichDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Prompt enrichment", ""];
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
    lines.push("## Raw output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }

  lines.push("## Run info", "");
  lines.push(`- Status: ${options.result.status}`);
  lines.push(`- Model: ${options.result.model ?? getModelSelector(options.config)}`);
  lines.push(
    `- Tools: ${options.result.toolCalls.map((call) => call.name).join(", ") || "none"}`,
  );
  if (options.result.errorMessage) lines.push(`- Error: ${options.result.errorMessage}`);

  return truncateText(lines.join("\n"), options.config.reportMaxChars);
}

async function runPromptEnrichForPrompt(options: {
  readonly ctx: ExtensionContext;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly priorAnswers?: string | undefined;
  readonly priorQuestions?: readonly string[] | undefined;
  readonly userPrompt: string;
}): Promise<PromptEnrichRunResult> {
  const config = readActivePromptEnrichConfig(options.ctx.cwd);
  registerPromptEnrichProvider(options.pi, config);

  const task = buildPromptEnrichTask({
    priorAnswers: options.priorAnswers,
    priorQuestions: options.priorQuestions,
    userPrompt: options.userPrompt,
  });
  const result = await runChildPiAgent({
    buildPrompt: buildPromptEnrichPrompt,
    config,
    defaultCwd: options.ctx.cwd,
    excludeTools: EXCLUDED_CHILD_TOOLS,
    onProgress: options.onProgress,
    task,
  });
  const decision = parsePromptEnrichDecision(result.output);
  const parseError = decision
    ? undefined
    : "promptenrichsubagent did not return parseable decision JSON";
  const report = formatPromptEnrichReport({ config, decision, parseError, result });

  return { config, decision, ...(parseError ? { parseError } : {}), report, result };
}

function sendPromptEnrichReportMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  run: PromptEnrichRunResult,
): void {
  sendChildAgentReportMessage({
    config: run.config,
    ctx,
    messageType: PROMPTENRICH_MESSAGE_TYPE,
    pi,
    report: run.report,
    result: run.result,
  });
}

function formatOneShotQuestionList(questions: readonly string[]): string {
  return questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
}

function buildOneShotEnrichmentFallbackPrompt(options: {
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
  options: readonly PromptEnrichPromptOption[],
  ctx: ExtensionContext,
): Promise<PromptEnrichPromptOption | undefined> {
  const firstOption = options[0];
  if (!firstOption) return undefined;
  if (options.length === 1) return firstOption;

  if (!ctx.hasUI) {
    ctx.ui.notify(
      `promptenrichsubagent received ${options.length} enriched prompts but no interactive UI is available; using option 1: ${firstOption.title}`,
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
  const config = readActivePromptEnrichConfig(ctx.cwd);
  registerPromptEnrichProvider(pi, config);
  const model = getModelSelector(config);
  ctx.ui.setStatus(STATUS_KEY, `enriching ${model}: ${previewTask(options.userPrompt)}`);

  try {
    const run = await runPromptEnrichForPrompt({
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
    sendPromptEnrichReportMessage(pi, ctx, run);

    if (!run.decision) {
      ctx.ui.notify(
        "promptenrichsubagent could not parse an enriched prompt; continuing without further enrichment.",
        "warning",
      );
      return { kind: "unchanged" };
    }

    if (run.decision.kind === "questions") {
      ctx.ui.notify(
        "promptenrichsubagent needs answers before it can enrich this prompt. Answer the questions in your next prompt, or press Alt+E to cancel.",
        "warning",
      );
      return { kind: "questions", questions: run.decision.questions };
    }

    const selected = await selectOneShotPromptOption(run.decision.prompts, ctx);
    if (!selected) {
      ctx.ui.notify("promptenrichsubagent prompt enrichment cancelled; continuing without further enrichment.", "info");
      return { kind: "unchanged" };
    }

    ctx.ui.notify(`promptenrichsubagent enriched next prompt: ${selected.title}`, "info");
    return { kind: "enriched", prompt: selected.prompt };
  } catch (error) {
    ctx.ui.notify(
      `promptenrichsubagent prompt enrichment failed: ${getErrorMessage(error)}. Continuing without further enrichment.`,
      "error",
    );
    return { kind: "unchanged" };
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

export default function promptEnrichSubagentExtension(pi: ExtensionAPI): void {
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

  reloadPromptEnrichSettings(pi, process.cwd());

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

  pi.registerMessageRenderer(PROMPTENRICH_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, {
      agentName: "promptenrichsubagent",
    }),
  );

  pi.registerShortcut("alt+e", {
    description: "Enrich the next prompt with promptenrichsubagent, then send it normally",
    handler: async (ctx) => {
      const wasActive = enrichNextPrompt || pendingOneShotPromptEnrichment !== undefined;
      clearOneShotPromptEnrichment(ctx);

      if (wasActive) {
        ctx.ui.notify("promptenrichsubagent next-prompt enrichment cancelled.", "info");
        return;
      }

      enrichNextPrompt = true;
      ctx.ui.setStatus(STATUS_KEY, "next prompt enrichment armed");
      ctx.ui.notify(
        "promptenrichsubagent will enrich the next prompt before sending it normally. If it asks questions, answer them in your following prompt; press Alt+E again to cancel.",
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

      ctx.ui.notify("promptenrichsubagent continuing with the original prompt plus your answers.", "info");
      return {
        action: "transform",
        text: buildOneShotEnrichmentFallbackPrompt({
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

  pi.registerCommand("pe-config", {
    description: "Show /pe (promptenrichsubagent) config",
    handler: (_args, ctx) => {
      reloadPromptEnrichSettings(pi, ctx.cwd);
      ctx.ui.notify(
        `promptenrichsubagent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatPromptEnrichModelSelection(currentConfig)}`,
        "info",
      );
      notifyConfigErrorIfNeeded(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("pe-model", {
    description: "Show or select the promptenrichsubagent child model",
    getArgumentCompletions: (prefix) => {
      return getPromptEnrichModelCompletions(prefix.trimStart());
    },
    handler: async (args, ctx) => {
      await selectPromptEnrichModel(pi, ctx, args.trim());
      notifyConfigErrorIfNeeded(ctx);
    },
  });

  pi.registerCommand("pe", {
    description:
      "Run the promptenrichsubagent clarification/enrichment pass on a prompt (/pe <prompt>)",
    handler: async (args, ctx) => {
      const userPrompt = args.trim();
      if (!userPrompt) {
        ctx.ui.notify(
          "Usage: /pe <prompt to enrich>. Also: /pe-config, /pe-model [model]. Shortcut: Alt+E enriches the next prompt, asks follow-up questions if needed, then sends the enriched prompt normally.",
          "warning",
        );
        return;
      }

      const config = readActivePromptEnrichConfig(ctx.cwd);
      registerPromptEnrichProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(userPrompt)}`);

      try {
        const run = await runPromptEnrichForPrompt({
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
        sendPromptEnrichReportMessage(pi, ctx, run);
        const level = run.result.status === "completed" && run.decision ? "info" : "warning";
        ctx.ui.notify(
          `promptenrichsubagent ${run.result.status}; report added to main context (${summarizeToolCalls(run.result.toolCalls)})`,
          level,
        );
      } catch (error) {
        ctx.ui.notify(`promptenrichsubagent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
