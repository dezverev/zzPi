import {
  isReadToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  CHILD_PI_AGENT_ENV,
  type ChildAgentProgress,
  type ChildAgentRunResult,
  type ChildPiAgentConfig,
  formatChildAgentConfig,
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
  textFromContent,
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
import {
  getBooleanField,
  getPositiveIntegerField,
  getStringField,
  readJsoncConfig,
} from "./lib/jsonc-config.ts";

const CONFIG_FILE_PATH = ".pi/extensions/readsubagent.config.jsonc";
const READSUBAGENT_MESSAGE_TYPE = "readsubagent-report";
const READSUBAGENT_STATE_ENTRY_TYPE = "readsubagent-state";
const STATUS_KEY = "readsubagent";
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];

type ReadSubagentModelOption = ChildAgentModelOption;

const EXCLUDED_CHILD_TOOLS = [
  "localagent",
  "refagent",
  "readsubagent",
  "prreview",
  "explorationsubagent",
  "reviewsubagent",
  "gitopsagent",
  "simpletasksubagent",
] as const;
const READSUBAGENT_EVENT_END = "readsubagent:end";
const READSUBAGENT_EVENT_ERROR = "readsubagent:error";
const READSUBAGENT_EVENT_PROGRESS = "readsubagent:progress";
const READSUBAGENT_EVENT_START = "readsubagent:start";
const DIRECT_READ_POLICIES = ["allow", "guard-large", "guard-large-any", "block"] as const;

type DirectReadPolicy = (typeof DIRECT_READ_POLICIES)[number];

interface ReadSubagentState {
  readonly enabled: boolean;
  readonly selectedModelId?: string;
}

interface ReadSubagentSavedState {
  readonly enabled?: boolean;
  readonly selectedModelId?: string;
}

interface ReadSubagentMainConfig {
  readonly directReadMaxChars: number;
  readonly directReadMaxLines: number;
  readonly directReadPolicy: DirectReadPolicy;
  readonly enabledByDefault: boolean;
}

const DEFAULT_READSUBAGENT_MAIN_CONFIG: ReadSubagentMainConfig = {
  directReadMaxChars: 12_000,
  directReadMaxLines: 300,
  directReadPolicy: "guard-large-any",
  enabledByDefault: true,
};

const MAIN_READSUBAGENT_PROMPT = [
  "<readsubagent_mode>",
  "Readsubagent mode is ON. Treat readsubagent as the default for factual file-content retrieval, summarization, symbol lookup, and line-range discovery when exact raw text is not needed in the parent context.",
  "Mandatory boundary: readsubagent is not a reasoning, review, or implementation-analysis agent. Do not use it to judge correctness, identify bugs, validate control flow/type safety, decide whether code is acceptable, or choose an edit strategy.",
  "Mandatory decision rule before any direct read: if the goal is to retrieve/summarize contents, inspect docs/config/logs, find definitions, get descriptive API/flow maps, or learn a file's factual structure, use readsubagent first.",
  "Direct read is only for last-mile exact text: user-visible quotes, exact snippets or oldText for edits, precise small line ranges already identified, image reads, or final verification after an edit.",
  "Do not direct-read documentation or large source files in chunks to learn them. If a file is large or you would need multiple read calls, ask readsubagent for the answer and exact line ranges, then read only the smallest necessary ranges.",
  "If the large-read guard compacts a read, stop and delegate the question to readsubagent. Do not work around the guard with offset/limit chunking unless you already know the exact range needed for an edit, quote, or verification.",
  "Use readsubagent for documentation/config/how-to questions when you need the answer rather than exact text; do not run rg/read in the parent just to answer a usage question.",
  "When working in a known file but you first need to understand its structure, factual flow, or relevant symbols, ask readsubagent for a concise descriptive map and exact line ranges before direct-reading large sections.",
  "Before copying a pattern from another known file or large implementation, ask readsubagent for relevant symbols, descriptive flow, and exact line ranges; then direct-read only those small ranges needed for edits.",
  "Avoid direct-reading large source files just to learn what behavior exists; delegate that summarization to readsubagent unless exact file text is immediately required.",
  "If you would read a file mainly to retrieve facts, summarize/explain/compare documented behavior, inspect docs/config/logs, or find where something is defined, ask readsubagent that factual question instead.",
  "If the task asks for issues, bugs, correctness, regressions, type safety, control-flow problems, maintainability judgment, or whether code is acceptable, do not use readsubagent; use direct reads plus validation or reviewsubagent instead.",
  "Use main-context grep/find/ls only for one-shot low-output discovery with a clear next action, such as rg -l or a single tight rg -n; if the search would branch, require multiple commands, or produce broad output, use explorationsubagent.",
  "For exploratory repo archaeology or broad rg/find/ls work, use explorationsubagent instead of readsubagent or raw parent output.",
  "For code/implementation review, use reviewsubagent instead of readsubagent so review judgment happens in the review-focused model.",
  "For git operations that mutate repo or remote state, use gitopsagent instead of readsubagent or parent-agent bash.",
  "Ask narrow readsubagent questions and include repo-relative paths, symbols, line ranges, search terms, desired output shape, and a maxReportChars budget when possible.",
  "Prefer small readsubagent reports: ask for the direct answer, citations, and only the minimal snippets needed for the next action.",
  "If the readsubagent answer is too vague, incomplete, or lacks needed details, ask readsubagent a narrower follow-up question before using broad direct reads.",
  "</readsubagent_mode>",
].join("\n");

const DEFAULT_READSUBAGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 262_144,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "qwen/qwen3.6-35b-a3b",
  provider: "lm-studio",
  providerRegistration: "none",
  reportMaxChars: 16_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are a read-only file-inspection subagent spawned by Pi. The parent delegates to you instead of reading files directly when it needs factual answers, summaries, extracted snippets, symbol locations, docs/config details, or line ranges without raw contents in the parent context. Use tools as needed to inspect only the requested repo-relative paths and nearby supporting files. Do not edit or write files. Do not create implementation plans, solution proposals, edit strategies, code-review judgments, bug findings, correctness assessments, control-flow/type-safety analysis, or accept/reject recommendations. Your job is factual inspection, evidence, descriptive API/flow maps, and line-range pointers only. If the parent asks for hard logic, review, or whether code is correct/acceptable, state that this is outside readsubagent scope and return only the factual evidence/locations that would support a separate review. Start with the answer, then cite evidence with repo-relative paths and line numbers when possible. Prefer summaries and exact line ranges the parent can read later; include concrete snippets only when necessary and keep them short. Never dump whole files or raw tool output; if the question is too broad, propose a narrower factual follow-up.",
  thinking: "off",
  tools: DEFAULT_TOOLS,
};

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_READSUBAGENT_CONFIG };
let currentMainConfig: ReadSubagentMainConfig = { ...DEFAULT_READSUBAGENT_MAIN_CONFIG };
let currentModelOptions: readonly ReadSubagentModelOption[] = [
  createReadSubagentModelOptionFromConfig(DEFAULT_READSUBAGENT_CONFIG),
];
let lastConfigError: string | undefined;
let lastMainConfigError: string | undefined;
let readSubagentEnabled = false;
let selectedReadSubagentModelId: string | undefined;

function createReadSubagentModelOptionFromConfig(config: ChildPiAgentConfig): ReadSubagentModelOption {
  return createChildAgentModelOptionFromConfig(config);
}

function readReadSubagentModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly ReadSubagentModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "readsubagent",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getReadSubagentModelChoiceLabel(option: ReadSubagentModelOption): string {
  return getChildAgentModelChoiceLabel(option);
}

function getReadSubagentModelOption(id: string | undefined): ReadSubagentModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findReadSubagentModelOption(input: string): ReadSubagentModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getReadSubagentModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableReadSubagentModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatReadSubagentModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedReadSubagentModelId,
  });
}

function applyReadSubagentModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(
    config,
    getReadSubagentModelOption(selectedReadSubagentModelId),
  );
}

function readActiveReadSubagentConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readReadSubagentConfig(cwd);
  currentModelOptions = readReadSubagentModelOptions(cwd, baseConfig);
  return applyReadSubagentModelSelection(baseConfig);
}

function readReadSubagentConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "readsubagent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_READSUBAGENT_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function registerReadSubagentProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  if (config.provider !== "local-readsubagent" || config.providerRegistration === "none") {
    pi.unregisterProvider("local-readsubagent");
  }

  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (readsubagent LM Studio)",
    providerDisplayName: "Local Read Subagent",
  });
}

function isDirectReadPolicy(value: string): value is DirectReadPolicy {
  return DIRECT_READ_POLICIES.includes(value as DirectReadPolicy);
}

function readReadSubagentMainConfig(cwd: string): ReadSubagentMainConfig {
  lastMainConfigError = undefined;

  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, cwd);
    if (!record) return { ...DEFAULT_READSUBAGENT_MAIN_CONFIG };

    const directReadPolicy = getStringField(record, "directReadPolicy");
    if (directReadPolicy !== undefined && !isDirectReadPolicy(directReadPolicy)) {
      throw new Error(`directReadPolicy must be one of: ${DIRECT_READ_POLICIES.join(", ")}.`);
    }

    return {
      directReadMaxChars:
        getPositiveIntegerField(record, "directReadMaxChars") ??
        DEFAULT_READSUBAGENT_MAIN_CONFIG.directReadMaxChars,
      directReadMaxLines:
        getPositiveIntegerField(record, "directReadMaxLines") ??
        DEFAULT_READSUBAGENT_MAIN_CONFIG.directReadMaxLines,
      directReadPolicy: directReadPolicy ?? DEFAULT_READSUBAGENT_MAIN_CONFIG.directReadPolicy,
      enabledByDefault:
        getBooleanField(record, "enabledByDefault") ??
        DEFAULT_READSUBAGENT_MAIN_CONFIG.enabledByDefault,
    };
  } catch (error) {
    lastMainConfigError = getErrorMessage(error);
    return { ...DEFAULT_READSUBAGENT_MAIN_CONFIG };
  }
}

function formatDirectReadPolicy(config: ReadSubagentMainConfig): string {
  switch (config.directReadPolicy) {
    case "allow":
      return "allow (direct read works normally)";
    case "guard-large":
      return `guard-large (compact oversized reads without offset/limit; caps ${config.directReadMaxChars} chars or ${config.directReadMaxLines} lines)`;
    case "guard-large-any":
      return `guard-large-any (compact any oversized read; caps ${config.directReadMaxChars} chars or ${config.directReadMaxLines} lines)`;
    case "block":
      return "block (strict mode; direct read calls are blocked)";
  }
}

function formatReadSubagentMainConfig(config: ReadSubagentMainConfig): string {
  return [
    `enabledByDefault: ${config.enabledByDefault}`,
    `directReadPolicy: ${config.directReadPolicy}`,
    `directReadMaxChars: ${config.directReadMaxChars}`,
    `directReadMaxLines: ${config.directReadMaxLines}`,
  ].join("\n");
}

function reloadReadSubagentSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveReadSubagentConfig(cwd);
  currentMainConfig = readReadSubagentMainConfig(cwd);
  registerReadSubagentProvider(pi, currentConfig);
}

function notifyConfigErrors(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`readsubagent config ignored: ${lastConfigError}`, "warning");
  }
  if (lastMainConfigError && lastMainConfigError !== lastConfigError) {
    ctx.ui.notify(`readsubagent direct-read config ignored: ${lastMainConfigError}`, "warning");
  }
}

function isChildPiAgentProcess(): boolean {
  return (
    process.env[CHILD_PI_AGENT_ENV] === "1" || process.env[LEGACY_LOCALAGENT_CHILD_ENV] === "1"
  );
}

function getSavedStateFromBranch(ctx: ExtensionContext): ReadSubagentSavedState {
  let saved: ReadSubagentSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== READSUBAGENT_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const enabled = typeof entry.data.enabled === "boolean" ? entry.data.enabled : undefined;
    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getReadSubagentModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (enabled === undefined && selectedModelId === undefined) continue;

    saved = {
      ...saved,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(selectedModelId ? { selectedModelId } : {}),
    };
  }

  return saved;
}

function applyStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, readSubagentEnabled ? "readsubagent: on" : undefined);
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readReadSubagentConfig(ctx.cwd);
  currentModelOptions = readReadSubagentModelOptions(ctx.cwd, baseConfig);
  currentMainConfig = readReadSubagentMainConfig(ctx.cwd);

  const saved = getSavedStateFromBranch(ctx);
  readSubagentEnabled = saved.enabled ?? currentMainConfig.enabledByDefault;
  selectedReadSubagentModelId = saved.selectedModelId;
  currentConfig = applyReadSubagentModelSelection(baseConfig);
  registerReadSubagentProvider(pi, currentConfig);
  applyStatus(ctx);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<ReadSubagentState>(READSUBAGENT_STATE_ENTRY_TYPE, {
    enabled: readSubagentEnabled,
    ...(selectedReadSubagentModelId ? { selectedModelId: selectedReadSubagentModelId } : {}),
  });
}

function setEnabled(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): void {
  readSubagentEnabled = enabled;
  persistState(pi);
  applyStatus(ctx);
}

async function selectReadSubagentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  reloadReadSubagentSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findReadSubagentModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown readsubagent model "${requested}". Available: ${formatAvailableReadSubagentModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /readsubagent model <model>. Available: ${formatAvailableReadSubagentModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getReadSubagentModelChoiceLabel);
    const choice = await ctx.ui.select("Select readsubagent model", choices);
    if (!choice) {
      ctx.ui.notify("readsubagent model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No readsubagent models are available", "warning");
    return;
  }

  selectedReadSubagentModelId = option.id;
  persistState(pi);
  reloadReadSubagentSettings(pi, ctx.cwd);
  applyStatus(ctx);
  ctx.ui.notify(
    `readsubagent model selected: ${getReadSubagentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
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

interface ReadSubagentFocus {
  readonly lineRanges: readonly string[];
  readonly maxReportChars?: number | undefined;
  readonly output?: string | undefined;
  readonly searchTerms: readonly string[];
  readonly symbols: readonly string[];
}

function formatDelegatedTask(
  question: string,
  paths: readonly string[],
  focus: ReadSubagentFocus,
): string {
  const output = focus.output?.trim();
  const reportBudget = focus.maxReportChars
    ? `Aim to keep the final parent-visible report under ${Math.floor(focus.maxReportChars).toLocaleString("en-US")} characters.`
    : "Keep the final parent-visible report as short as possible while still answering precisely.";

  return [
    "Question:",
    question,
    "",
    "Target paths:",
    formatListSection(paths),
    "",
    "Target symbols/functions/types/config keys:",
    formatListSection(focus.symbols),
    "",
    "Search terms or regexes:",
    formatListSection(focus.searchTerms),
    "",
    "Specific line ranges:",
    formatListSection(focus.lineRanges),
    "",
    "Desired output:",
    output || "- Direct answer first, then concise evidence and only the shortest useful snippets.",
    "",
    "Report constraints:",
    `- ${reportBudget}`,
    "- Cite repo-relative paths and line numbers when possible.",
    "- Include exact snippets or oldText blocks only when they are needed for the parent agent's next action.",
    "- Avoid dumping whole files, whole functions unrelated to the question, or raw tool output.",
    "- If the question is underspecified, answer what you can and state the narrow follow-up question the parent should ask next.",
  ].join("\n");
}

function buildReadSubagentPrompt(task: string): string {
  return [
    "You are running as the child process for the parent Pi readsubagent tool.",
    "Your job is to answer a targeted factual file-inspection question without sending full file contents back to the parent context.",
    "Use read/search tools as needed to deliver the best factual report. Do not modify files. Treat target paths, symbols, search terms, and line ranges as the intended scope.",
    "Use grep or focused reads so you can cite repo-relative paths and line numbers. Avoid broad repo-wide searches unless the question has no target path and no search terms.",
    "Return the smallest useful report: direct answer first, citations second, and exact short snippets only where useful. Do not create implementation plans, solution proposals, edit strategies, code-review judgments, bug findings, correctness assessments, control-flow/type-safety analysis, or accept/reject recommendations; provide factual repo evidence and line ranges only. If asked for hard logic or review, say that is outside readsubagent scope and provide only factual evidence/locations. If you cannot answer precisely from the supplied scope, state the narrow factual follow-up needed.",
    `Delegated file-inspection task:\n${task}`,
  ].join("\n\n");
}

function getReportMaxChars(config: ChildPiAgentConfig, requested: number | undefined): number {
  if (requested === undefined) return config.reportMaxChars;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error("readsubagent maxReportChars must be a positive number.");
  }

  return Math.min(config.reportMaxChars, Math.floor(requested));
}

function formatReport(
  result: ChildAgentRunResult,
  config: ChildPiAgentConfig,
  requestedMaxReportChars?: number,
): string {
  return truncateText(
    result.output.trim() || "(no output)",
    getReportMaxChars(config, requestedMaxReportChars),
  );
}

function formatStatus(): string {
  return [
    `readsubagent mode: ${readSubagentEnabled ? "on" : "off"}`,
    `enabled by default: ${currentMainConfig.enabledByDefault ? "on" : "off"}`,
    formatReadSubagentModelSelection(currentConfig),
    `direct read policy: ${formatDirectReadPolicy(currentMainConfig)}`,
    "When on, the main agent is instructed to use readsubagent for answers from files when raw contents are not needed, while keeping direct read available for exact contents, ranges, and verification unless the policy is block. A saved /readsubagent on/off state overrides enabledByDefault for that session branch.",
    "Commands: /readsubagent on | off | toggle | status | model [model] | ask <question>. The model subcommand chooses the readsubagent model/endpoint.",
  ].join("\n");
}

function countTextLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function hasExplicitReadRange(input: Record<string, unknown>): boolean {
  return typeof input.offset === "number" || typeof input.limit === "number";
}

function getReadInputPath(input: Record<string, unknown>): string {
  return typeof input.path === "string" ? input.path : "requested file";
}

function formatGuardedReadNotice(options: {
  readonly charCount: number;
  readonly lineCount: number;
  readonly path: string;
  readonly policy: ReadSubagentMainConfig;
}): string {
  return [
    `Direct read of ${options.path} was compacted by readsubagent to protect the main context.`,
    `Omitted result size: ${options.charCount.toLocaleString("en-US")} characters across ${options.lineCount.toLocaleString("en-US")} lines.`,
    `Guard threshold: ${options.policy.directReadMaxChars.toLocaleString("en-US")} characters or ${options.policy.directReadMaxLines.toLocaleString("en-US")} lines (${options.policy.directReadPolicy}).`,
    "",
    "Next step options:",
    `- If the read was for understanding, summarizing, docs/config/how-to, or finding where behavior lives, stop and use readsubagent with path=${JSON.stringify(options.path)}, that question, optional symbols/searchTerms/lineRanges, and a small maxReportChars budget.`,
    `- If exact direct contents are genuinely needed, retry read only for a small known range in ${options.path} needed for an edit, quote, or verification; do not chunk a large file or docs to learn it.`,
    "- If the target file or symbol is still unclear, use explorationsubagent for discovery before any more direct reads.",
    "- If direct full reads are intentional, run /readsubagent off or set directReadPolicy to allow.",
  ].join("\n");
}

function shouldGuardReadResult(options: {
  readonly content: unknown;
  readonly input: Record<string, unknown>;
  readonly policy: ReadSubagentMainConfig;
}): { charCount: number; lineCount: number } | undefined {
  if (
    options.policy.directReadPolicy !== "guard-large" &&
    options.policy.directReadPolicy !== "guard-large-any"
  ) {
    return undefined;
  }

  if (options.policy.directReadPolicy === "guard-large" && hasExplicitReadRange(options.input)) {
    return undefined;
  }

  const text = textFromContent(options.content);
  const charCount = text.length;
  const lineCount = countTextLines(text);
  const tooLarge =
    charCount > options.policy.directReadMaxChars || lineCount > options.policy.directReadMaxLines;

  return tooLarge ? { charCount, lineCount } : undefined;
}

let readSubagentRunCounter = 0;

async function runReadSubagentTask(options: {
  readonly config: ChildPiAgentConfig;
  readonly cwd?: string | undefined;
  readonly defaultCwd: string;
  readonly lineRanges?: readonly string[] | undefined;
  readonly maxReportChars?: number | undefined;
  readonly onProgress?: Parameters<typeof runChildPiAgent>[0]["onProgress"];
  readonly output?: string | undefined;
  readonly paths: readonly string[];
  readonly pi: ExtensionAPI;
  readonly question: string;
  readonly searchTerms?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly symbols?: readonly string[] | undefined;
}): Promise<ChildAgentRunResult> {
  const searchTerms = normalizeStringList(options.searchTerms);
  const symbols = normalizeStringList(options.symbols);
  const lineRanges = normalizeStringList(options.lineRanges);
  const maxReportChars = getReportMaxChars(options.config, options.maxReportChars);
  const task = formatDelegatedTask(options.question, options.paths, {
    lineRanges,
    maxReportChars,
    output: options.output,
    searchTerms,
    symbols,
  });
  const runId = ++readSubagentRunCounter;
  const baseEvent = {
    cwd: options.cwd ?? options.defaultCwd,
    lineRanges,
    maxReportChars,
    model: getModelSelector(options.config),
    output: options.output,
    paths: options.paths,
    question: options.question,
    runId,
    searchTerms,
    symbols,
    task,
  };
  const startedAt = Date.now();

  options.pi.events.emit(READSUBAGENT_EVENT_START, { ...baseEvent, startedAt });

  const onProgress = (progress: ChildAgentProgress) => {
    options.pi.events.emit(READSUBAGENT_EVENT_PROGRESS, {
      ...baseEvent,
      progress,
      startedAt,
      updatedAt: Date.now(),
    });
    options.onProgress?.(progress);
  };

  try {
    const result = await runChildPiAgent({
      buildPrompt: buildReadSubagentPrompt,
      config: options.config,
      cwd: options.cwd,
      defaultCwd: options.defaultCwd,
      excludeTools: EXCLUDED_CHILD_TOOLS,
      onProgress,
      signal: options.signal,
      task,
    });

    options.pi.events.emit(READSUBAGENT_EVENT_END, {
      ...baseEvent,
      endedAt: Date.now(),
      result,
      startedAt,
    });
    return result;
  } catch (error) {
    options.pi.events.emit(READSUBAGENT_EVENT_ERROR, {
      ...baseEvent,
      endedAt: Date.now(),
      errorMessage: getErrorMessage(error),
      startedAt,
    });
    throw error;
  }
}

export default function readSubagentExtension(pi: ExtensionAPI) {
  reloadReadSubagentSettings(pi, process.cwd());

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

  pi.registerMessageRenderer(READSUBAGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "readsubagent" }),
  );

  pi.on("before_agent_start", (event) => {
    if (!readSubagentEnabled || isChildPiAgentProcess()) return undefined;
    if (!pi.getActiveTools().includes("readsubagent")) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${MAIN_READSUBAGENT_PROMPT}\n\nDirect read policy: ${formatDirectReadPolicy(currentMainConfig)}`,
    };
  });

  pi.on("tool_call", (event) => {
    if (!readSubagentEnabled || isChildPiAgentProcess()) return undefined;
    if (event.toolName !== "read") return undefined;
    if (currentMainConfig.directReadPolicy !== "block") return undefined;

    return {
      block: true,
      reason:
        "read blocked: readsubagent directReadPolicy is block. Use readsubagent with a targeted question, run /readsubagent off, or set directReadPolicy to allow/guard-large.",
    };
  });

  pi.on("tool_result", (event) => {
    if (!readSubagentEnabled || isChildPiAgentProcess()) return undefined;
    if (!isReadToolResult(event) || event.isError) return undefined;
    if (event.content.some((block) => block.type === "image")) return undefined;

    const guarded = shouldGuardReadResult({
      content: event.content,
      input: event.input,
      policy: currentMainConfig,
    });
    if (!guarded) return undefined;

    return {
      content: [
        {
          type: "text" as const,
          text: formatGuardedReadNotice({
            charCount: guarded.charCount,
            lineCount: guarded.lineCount,
            path: getReadInputPath(event.input),
            policy: currentMainConfig,
          }),
        },
      ],
      details: {
        readsubagentDirectReadGuard: {
          charCount: guarded.charCount,
          lineCount: guarded.lineCount,
          path: getReadInputPath(event.input),
          policy: currentMainConfig.directReadPolicy,
        },
      },
    };
  });

  pi.registerCommand("readsubagent-config", {
    description: "Show /readsubagent config",
    handler: (_args, ctx) => {
      reloadReadSubagentSettings(pi, ctx.cwd);
      ctx.ui.notify(
        `readsubagent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatReadSubagentModelSelection(currentConfig)}\n${formatReadSubagentMainConfig(currentMainConfig)}`,
        "info",
      );
      notifyConfigErrors(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("readsubagent", {
    description: "Toggle readsubagent mode, select its model, or manually ask a targeted file-inspection question",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getReadSubagentModelCompletions(modelPrefix);
      }

      if (trimmed.includes(" ") || hasTrailingSpace) return null;

      return ["on", "off", "toggle", "status", "model", "ask", "config"]
        .filter((item) => item.startsWith(normalizedFirst))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [command = "status", ...rest] = trimmed.split(/\s+/u);
      const normalized = command.toLowerCase();

      if (!trimmed || normalized === "status") {
        ctx.ui.notify(formatStatus(), "info");
        applyStatus(ctx);
        return;
      }

      if (normalized === "on" || normalized === "off" || normalized === "toggle") {
        const nextEnabled = normalized === "toggle" ? !readSubagentEnabled : normalized === "on";
        setEnabled(pi, ctx, nextEnabled);
        ctx.ui.notify(formatStatus(), "info");
        return;
      }

      if (normalized === "config") {
        reloadReadSubagentSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `readsubagent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatReadSubagentModelSelection(currentConfig)}\n${formatReadSubagentMainConfig(currentMainConfig)}`,
          "info",
        );
        notifyConfigErrors(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectReadSubagentModel(pi, ctx, rest.join(" "));
        notifyConfigErrors(ctx);
        return;
      }

      if (normalized === "endpoint" || normalized === "endpoints") {
        ctx.ui.notify(
          "Readsubagent endpoints are selected through /readsubagent model entries in .pi/extensions/readsubagent.config.jsonc. Use /readsubagent model qwen or /readsubagent model gpt-5.5-xhigh.",
          "info",
        );
        return;
      }

      if (normalized !== "ask") {
        ctx.ui.notify(
          "Usage: /readsubagent on | off | toggle | status | model [model] | ask <question>",
          "warning",
        );
        return;
      }

      const question = rest.join(" ").trim();
      if (!question) {
        ctx.ui.notify("Usage: /readsubagent ask <targeted file question>", "warning");
        return;
      }

      const config = readActiveReadSubagentConfig(ctx.cwd);
      registerReadSubagentProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(question)}`);

      try {
        const result = await runReadSubagentTask({
          config,
          defaultCwd: ctx.cwd,
          paths: [],
          pi,
          question,
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
          messageType: READSUBAGENT_MESSAGE_TYPE,
          pi,
          report,
          result,
        });

        const level = result.status === "completed" ? "info" : "warning";
        ctx.ui.notify(`readsubagent ${result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`readsubagent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        applyStatus(ctx);
      }
    },
  });

  pi.registerTool({
    name: "readsubagent",
    label: "Read Subagent",
    description:
      "Ask a local child Pi process a targeted question about files when the main context needs an answer rather than raw file contents. The child can inspect files read-only and returns a concise cited answer with concrete code examples or exact snippets when useful.",
    promptSnippet:
      "Ask a local child Pi process targeted questions about files when raw contents are not needed",
    promptGuidelines: [
      "Use readsubagent by default when file inspection is for factual content retrieval, summarization, or line-range discovery rather than exact text extraction.",
      "Before any direct read, verify that raw text is needed for a quote, exact edit oldText, precise known range, image inspection, final verification, or parent-side correctness analysis; otherwise ask readsubagent.",
      "If you were about to call read mainly to retrieve/summarize contents, explain documented behavior, compare file contents, inspect docs/config/logs, find definitions, or learn factual file structure, delegate that exact question to readsubagent with relevant paths, symbols, line ranges, and search terms.",
      "Do not read large docs or source files in chunks to learn them; ask readsubagent for the answer and exact line ranges, then direct-read only the smallest necessary ranges.",
      "If a direct read is compacted by the large-read guard, stop and use readsubagent unless you already know the exact small range needed for an edit, quote, or verification.",
      "Use readsubagent for documentation/config/how-to questions when the parent needs the answer rather than exact text; do not run rg/read in the parent just to answer a usage question.",
      "When working in a known file but you first need to understand its structure, descriptive flow, or relevant symbols, ask readsubagent for a concise factual map and exact line ranges before direct-reading large sections.",
      "Before copying a pattern from another known file or large implementation, ask readsubagent for relevant symbols, descriptive flow, and exact line ranges; then direct-read only those small ranges needed for edits.",
      "Give readsubagent repo-relative paths, symbols, line ranges, search terms, the exact question to answer, desired output shape, and maxReportChars when possible.",
      "Use main-context grep/find/ls only for one-shot low-output discovery with a clear next action; if the search would branch, require multiple commands, or produce broad output, use explorationsubagent.",
      "If readsubagent's answer is too vague or missing needed details, ask readsubagent a narrower follow-up question before falling back to direct reads.",
      "Do not use readsubagent for broad repo exploration; use explorationsubagent when discovery requires broad rg/find/ls work.",
      "Do not use readsubagent for hard logic or code review; use direct reads plus validation or reviewsubagent when the goal is to inspect for issues, judge correctness, validate control flow/type safety, quality, maintainability, security, or regression risk.",
      "Do not use readsubagent for git operations that mutate repo or remote state; use gitopsagent for committing, pushing, PR creation/merge, branch cleanup, and main sync.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "Targeted factual question for the child file-inspection agent. Include what to find, summarize, compare, extract, or explain from file contents; do not ask it to judge correctness or perform review.",
      }),
      path: Type.Optional(Type.String({ description: "Single repo-relative path to inspect" })),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Repo-relative file or directory paths to inspect, ordered by relevance",
        }),
      ),
      symbols: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Specific functions, classes, types, config keys, or other symbols to inspect",
        }),
      ),
      searchTerms: Type.Optional(
        Type.Array(Type.String(), {
          description: "Focused search terms or regexes the child should use before reading",
        }),
      ),
      lineRanges: Type.Optional(
        Type.Array(Type.String(), {
          description: "Specific repo-relative line ranges, e.g. src/file.ts:120-180",
        }),
      ),
      output: Type.Optional(
        Type.String({
          description:
            "Desired report shape and level of detail, e.g. concise answer, exact oldText block, or API summary",
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
      const config = readActiveReadSubagentConfig(ctx.cwd);
      registerReadSubagentProvider(pi, config);
      const paths = normalizePathList(params.path, params.paths);
      const result = await runReadSubagentTask({
        config,
        cwd: params.cwd,
        defaultCwd: ctx.cwd,
        lineRanges: params.lineRanges,
        maxReportChars: params.maxReportChars,
        output: params.output,
        paths,
        pi,
        question: params.question,
        searchTerms: params.searchTerms,
        signal,
        symbols: params.symbols,
        onProgress: (progress) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `readsubagent running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
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
      const question = typeof args.question === "string" ? args.question : "";
      const path = typeof args.path === "string" ? args.path : "";
      const pathCount = Array.isArray(args.paths) ? args.paths.length : 0;
      const pathText = path || (pathCount > 0 ? `${pathCount} paths` : "no path");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("readsubagent"))} ${theme.fg("accent", pathText)} ${theme.fg("dim", previewTask(question || "..."))}`,
        0,
        0,
      );
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "readsubagent" });
    },
  });
}
