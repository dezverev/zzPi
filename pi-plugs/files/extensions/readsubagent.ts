import {
  isReadToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
  previewTask,
  readChildPiAgentConfig,
  registerChildAgentProvider,
  renderChildAgentMessage,
  renderChildAgentToolCall,
  renderChildAgentToolResult,
  runChildPiAgent,
  sendChildAgentReportMessage,
  textFromContent,
  truncateText,
} from "./zz-lib/child-pi-agent.ts";
import { createAgentMode, type AgentModeController } from "./lib/agent-mode.ts";
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
  CONFIG_DEFAULT_MODEL_CHOICE,
  isSubagentModelPreferenceReset,
  readSubagentModelPreference,
  resolveSubagentModelPreference,
  writeSubagentModelPreference,
} from "./lib/subagent-model-preferences.ts";
import {
  getBooleanField,
  getPositiveIntegerField,
  getStringField,
  readJsoncConfig,
} from "./zz-lib/jsonc-config.ts";

const CONFIG_FILE_PATH = ".pi/extensions/readsubagent.config.jsonc";
const DEFAULT_MODEL_OPTION_ID = "qwen-35b-a3b";
const MODEL_OPTIONS_CONFIG_FILE_PATH = ".pi/extensions/zz-agent-models.config.jsonc";
const READSUBAGENT_MESSAGE_TYPE = "readsubagent-report";
const READSUBAGENT_STATE_ENTRY_TYPE = "readsubagent-state";
const STATUS_KEY = "readsubagent";
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];

type ReadSubagentModelOption = ChildAgentModelOption;

const EXCLUDED_CHILD_TOOLS = [
  "readsubagent",
  "explorationsubagent",
] as const;
const READSUBAGENT_EVENT_END = "readsubagent:end";
const READSUBAGENT_EVENT_ERROR = "readsubagent:error";
const READSUBAGENT_EVENT_PROGRESS = "readsubagent:progress";
const READSUBAGENT_EVENT_START = "readsubagent:start";
const DIRECT_READ_POLICIES = ["allow", "guard-large", "guard-large-any", "block"] as const;
const DIRECT_DEBUG_COMMAND_PATTERN = /\b(?:debug|diagnose|troubleshoot)\b(?!\s+(?:command|function|implementation|option|flag|configuration|config|mode|logging|logger)\b)/iu;
const EXPLICIT_DEBUG_REQUEST_PATTERN = /\b(?:debug|diagnos(?:e|ing)|troubleshoot|investigat(?:e|ing)|analy[sz]e|examine|inspect|review|look\s+(?:into|over)|figure\s+out|fix|find|identify|help\s+me\s+(?:find|understand)|tell\s+me|what\s+caused|what\s+went\s+wrong|why)\b.{0,120}\b(?:bug|fail(?:s|ed|ing|ure)?|error|regression|flaky[-\s]+test|incident|crash(?:es|ed|ing)?|timeouts?|timed\s+out|logs?|stack\s+traces?|failure\s+output|unexpected[-\s]+runtime(?:\s+behavior)?)\b/imu;
const STRONG_DEBUG_REQUEST_PATTERN = /\b(?:debug|diagnos(?:e|ing)|troubleshoot|investigat(?:e|ing)|look\s+(?:into|over)|figure\s+out|fix|find|identify|what\s+caused|what\s+went\s+wrong|why)\b.{0,120}\b(?:bug|fail(?:s|ed|ing)?|error|crash(?:es|ed|ing)?|timeouts?|timed\s+out|root[-\s]+cause)\b/imu;
const DIAGNOSTIC_ARTIFACT_PATTERN = /\b(?:logs|log\s+(?:file|output|excerpt|entries)|stack\s+traces?|crash\s+reports?|core\s+dumps?|test\s+failure\s+output|failure\s+output|execution\s+traces?|profiler\s+output|runtime\s+captures?|diagnostic\s+screenshots?)\b|\b\S+\.log\b/iu;
const CONCRETE_DIAGNOSTIC_EVIDENCE_PATTERN = /(?:^|[\s"'(])(?:[A-Za-z]:\\)?(?:[\w.-]+[\\/])*[\w-][\w.-]*\.log(?:$|[\s"')])|\b(?:this|these|attached)\s+(?:logs?|stack\s+traces?|failure\s+output|crash\s+reports?)\b|\b(?:logs?|log\s+output|stack\s+traces?|failure\s+output)\s+from\s+(?:runtime|production|staging|the\s+server|the\s+request|the\s+test\s+run)\b/imu;
const ORDINARY_TOOLING_TOPIC_PATTERN = /(?:\b(?:stack\s+traces?|logs?|log\s+output|failures?)|\.log\s+files?)\s+(?:parser|parsing|format(?:ter|ting)?|configuration|config|option|schema|extension(?:\s+handling)?|implementation|handler|handling|type|class|module)\b|\b(?:parses?|handles?|formats?|configures?|implements?)\s+(?:stack\s+traces?|logs?|log\s+output|\.log\s+files?|failures?)\b/iu;
const DIAGNOSTIC_INSPECTION_PATTERN = /\b(?:debug|diagnos(?:e|ing)|troubleshoot|investigat(?:e|ing)|inspect|examine|analy[sz]e|summari[sz]e|review|read|explain|interpret|extract|check|scan|parse|look\s+at|tell\s+me|what\s+(?:does|is|happened)|why)\b/iu;
const PROHIBITED_REQUEST_MESSAGE = "readsubagent refused this explicit debugging or diagnostic-artifact request before child launch. Inspect source and diagnostic evidence directly in the parent, or use debuggersubagent for root-cause diagnosis.";

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
  directReadPolicy: "allow",
  enabledByDefault: true,
};

const MAIN_READSUBAGENT_PROMPT = [
  "<readsubagent_mode>",
  "Readsubagent mode is ON. Evaluate task context before file type or factuality: never use readsubagent for debugging, failure diagnosis, regression or flaky-test investigation, incident response, or unexpected-runtime investigation.",
  "During those workflows, the main agent or debuggersubagent must inspect source, config, documentation, and all diagnostic evidence directly. Readsubagent must not scout the debug path, suggest diagnostic evidence, summarize it, or gather root-cause evidence.",
  "Never send readsubagent logs, stack traces, crash reports, core dumps, test failure output, traces, profiler output, runtime captures, diagnostic screenshots, or similar artifacts. Directly inspect them in the parent or use debuggersubagent.",
  "Outside debugging, use readsubagent primarily as a read-only codebase scout and read planner for unfamiliar repository areas. Ask for a short subsystem map, candidate files, search/symbol/line anchors, the smallest focused read list, avoid-for-now areas, and explicit uncertainty.",
  "Focused non-debug factual answers about ordinary code, config, documentation, and how-to material remain supported when the parent needs an answer rather than raw text.",
  "Mandatory boundary: readsubagent is not a reasoning, review, design, or implementation-analysis agent. Do not use it to judge correctness, identify bugs, validate control flow/type safety, decide whether code is acceptable, or choose an edit strategy.",
  "Direct read remains appropriate for debugging; user-visible quotes; exact snippets or oldText for edits; precise small line ranges already identified; image inspection; final verification; and parent-side correctness analysis.",
  "Outside debugging, do not direct-read documentation or large source files in chunks merely to learn them. Ask readsubagent for a bounded map and exact line ranges, then read only the smallest necessary ranges.",
  "If the large-read guard compacts a non-debug read, stop and delegate a scoped scout/read-planning question. Do not work around the guard with offset/limit chunking unless you already know the exact range needed for an edit, quote, or verification.",
  "Use main-context grep/find/ls for one-shot low-output discovery with a clear next action. If non-debug discovery would branch or produce broad output, ask readsubagent for a bounded factual read plan before broader parent discovery.",
  "Ask narrow questions with repo-relative paths, symbols, line ranges, search terms, desired output shape, and a maxReportChars budget. If an answer is vague, ask a narrower non-debug follow-up.",
  "For git operations that mutate repo or remote state, handle them in the parent session rather than readsubagent.",
  "</readsubagent_mode>",
].join("\n");

const DEFAULT_READSUBAGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 127_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "qwen/qwen3.6-35b-a3b",
  provider: "zz-agent-local",
  providerRegistration: "openai-compatible",
  reportMaxChars: 16_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are a read-only, non-debug codebase scout and read-planning subagent spawned by Pi. Evaluate task context first. Refuse every request involving debugging, failure diagnosis, regression or flaky-test investigation, incident response, or unexpected-runtime investigation. Never inspect or analyze logs, stack traces, crash reports, core dumps, test failure output, traces, profiler output, runtime captures, diagnostic screenshots, or similar diagnostic artifacts. Direct the parent to inspect source, config, documentation, and diagnostic evidence directly or use debuggersubagent; do not provide partial diagnostic analysis, scout the debug path, suggest diagnostic evidence, or gather root-cause evidence. Outside debugging, inspect only requested repo-relative paths and nearby supporting files. Prefer a short subsystem map, candidate files, search/symbol/line anchors, the smallest focused read list, avoid-for-now areas, and explicit uncertainty. Focused factual answers about ordinary code, config, documentation, and how-to material remain supported. Do not edit or write files. Do not create implementation plans, solution proposals, edit strategies, code-review judgments, bug findings, correctness assessments, control-flow/type-safety analysis, design advice, or accept/reject recommendations. Start with the answer or read plan, then cite repo-relative paths and line numbers. Keep snippets short, never dump whole files or raw tool output, and ask for a narrower non-debug question when the request is too broad.",
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
let lastModelPreferenceError: string | undefined;
let readSubagentEnabled = false;
let readSubagentMode: AgentModeController;
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
    modelOptionsConfigFilePath: MODEL_OPTIONS_CONFIG_FILE_PATH,
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
    getReadSubagentModelOption(selectedReadSubagentModelId ?? DEFAULT_MODEL_OPTION_ID),
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
      return `guard-large (optional non-debug context guard; direct debugging reads remain direct and must not be redirected to readsubagent; caps ${config.directReadMaxChars} chars or ${config.directReadMaxLines} lines)`;
    case "guard-large-any":
      return `guard-large-any (optional non-debug context guard; direct debugging reads remain direct and must not be redirected to readsubagent; caps ${config.directReadMaxChars} chars or ${config.directReadMaxLines} lines)`;
    case "block":
      return "block (strict optional policy; debugging reads must still remain direct and must not be redirected to readsubagent, so disable this policy during debugging)";
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
  if (lastModelPreferenceError) ctx.ui.notify(lastModelPreferenceError, "warning");
}

function isChildPiAgentProcess(): boolean {
  return (
    process.env[CHILD_PI_AGENT_ENV] === "1"
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
  readSubagentMode.applyStatus(ctx);
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readReadSubagentConfig(ctx.cwd);
  currentModelOptions = readReadSubagentModelOptions(ctx.cwd, baseConfig);
  currentMainConfig = readReadSubagentMainConfig(ctx.cwd);

  const saved = getSavedStateFromBranch(ctx);
  const preferenceParams = {
    agentName: "readsubagent",
    configFilePath: CONFIG_FILE_PATH,
    cwd: ctx.cwd,
  };
  const preference = readSubagentModelPreference(preferenceParams);
  const resolution = resolveSubagentModelPreference(
    "readsubagent",
    preference,
    currentModelOptions,
    saved.selectedModelId,
  );
  selectedReadSubagentModelId = resolution.selectedModelId;
  lastModelPreferenceError = resolution.warning;
  if (resolution.migrateSessionSelection) {
    const migrated = writeSubagentModelPreference(preferenceParams, selectedReadSubagentModelId);
    if (migrated.error) {
      lastModelPreferenceError = `Could not migrate the readsubagent model override: ${migrated.error}`;
    }
  }
  currentConfig = applyReadSubagentModelSelection(baseConfig);
  registerReadSubagentProvider(pi, currentConfig);
  readSubagentMode.restore(ctx);
}

function persistState(pi: ExtensionAPI, cwd: string): boolean {
  const persisted = writeSubagentModelPreference({
    agentName: "readsubagent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  }, selectedReadSubagentModelId);
  lastModelPreferenceError = persisted.error
    ? `Could not persist the readsubagent model override: ${persisted.error}`
    : undefined;
  if (lastModelPreferenceError) return false;
  pi.appendEntry<ReadSubagentState>(READSUBAGENT_STATE_ENTRY_TYPE, {
    enabled: readSubagentEnabled,
    ...(selectedReadSubagentModelId ? { selectedModelId: selectedReadSubagentModelId } : {}),
  });
  return true;
}

function setEnabled(_pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): void {
  readSubagentMode.setEnabled(enabled, ctx);
}

async function selectReadSubagentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  reloadReadSubagentSettings(pi, ctx.cwd);

  const requested = args.trim();
  let resetToDefault = isSubagentModelPreferenceReset(requested);
  let option = requested && !resetToDefault ? findReadSubagentModelOption(requested) : undefined;

  if (requested && !resetToDefault && !option) {
    ctx.ui.notify(
      `Unknown readsubagent model "${requested}". Available: ${formatAvailableReadSubagentModels()}`,
      "error",
    );
    return;
  }

  if (!requested) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /readsubagent model <model|default>. Available: ${formatAvailableReadSubagentModels()}`,
        "warning",
      );
      return;
    }

    const modelChoices = currentModelOptions.map(getReadSubagentModelChoiceLabel);
    const choices = [CONFIG_DEFAULT_MODEL_CHOICE, ...modelChoices];
    const choice = await ctx.ui.select("Select readsubagent model", choices);
    if (!choice) {
      ctx.ui.notify("readsubagent model selection cancelled", "info");
      return;
    }

    resetToDefault = choice === CONFIG_DEFAULT_MODEL_CHOICE;
    const choiceIndex = modelChoices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (resetToDefault) {
    const previousModelId = selectedReadSubagentModelId;
    selectedReadSubagentModelId = undefined;
    if (!persistState(pi, ctx.cwd)) {
      selectedReadSubagentModelId = previousModelId;
      reloadReadSubagentSettings(pi, ctx.cwd);
      applyStatus(ctx);
      ctx.ui.notify(lastModelPreferenceError ?? "Could not clear the readsubagent model override", "error");
      lastModelPreferenceError = undefined;
      return;
    }
    reloadReadSubagentSettings(pi, ctx.cwd);
    applyStatus(ctx);
    ctx.ui.notify(
      `readsubagent persistent model override cleared; using config default ${getModelSelector(currentConfig)}`,
      "info",
    );
    return;
  }

  if (!option) {
    ctx.ui.notify("No readsubagent models are available", "warning");
    return;
  }

  const previousModelId = selectedReadSubagentModelId;
  selectedReadSubagentModelId = option.id;
  if (!persistState(pi, ctx.cwd)) {
    selectedReadSubagentModelId = previousModelId;
    reloadReadSubagentSettings(pi, ctx.cwd);
    applyStatus(ctx);
    ctx.ui.notify(lastModelPreferenceError ?? "Could not persist the readsubagent model override", "error");
    lastModelPreferenceError = undefined;
    return;
  }
  reloadReadSubagentSettings(pi, ctx.cwd);
  applyStatus(ctx);
  ctx.ui.notify(
    `readsubagent persistent model override selected: ${getReadSubagentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
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

export function isProhibitedReadSubagentRequest(parts: readonly unknown[]): boolean {
  const text = parts
    .flatMap((part) => Array.isArray(part) ? part : [part])
    .filter((part): part is string => typeof part === "string")
    .join("\n");

  if (DIRECT_DEBUG_COMMAND_PATTERN.test(text)) return true;
  if (CONCRETE_DIAGNOSTIC_EVIDENCE_PATTERN.test(text)) return true;
  if (EXPLICIT_DEBUG_REQUEST_PATTERN.test(text)) {
    if (ORDINARY_TOOLING_TOPIC_PATTERN.test(text) && !STRONG_DEBUG_REQUEST_PATTERN.test(text)) return false;
    return true;
  }
  if (!DIAGNOSTIC_ARTIFACT_PATTERN.test(text) || !DIAGNOSTIC_INSPECTION_PATTERN.test(text)) return false;
  return !ORDINARY_TOOLING_TOPIC_PATTERN.test(text);
}

function buildReadSubagentPrompt(task: string): string {
  return [
    "You are running as the child process for the parent Pi readsubagent tool.",
    "First evaluate task context. You are only a non-debug codebase scout/read planner and focused factual file-inspection agent.",
    "Refuse debugging, failure diagnosis, regression or flaky-test investigation, incident response, and unexpected-runtime investigation. Never inspect logs, stack traces, crash reports, core dumps, test failure output, traces, profiler output, runtime captures, diagnostic screenshots, or similar artifacts. Tell the parent to inspect them directly or use debuggersubagent, and do not provide partial diagnostic analysis.",
    "For allowed non-debug work, use read/search tools without modifying files. Treat target paths, symbols, search terms, and line ranges as scope. Prefer a short subsystem map, focused read list, anchors, avoid-for-now areas, and uncertainty; focused factual answers about ordinary code, config, and documentation remain supported.",
    "Use grep or focused reads so you can cite repo-relative paths and line numbers. Avoid broad repo-wide searches unless needed to produce a bounded read plan.",
    "Return the smallest useful report. Do not create implementation plans, solution proposals, edit strategies, code-review judgments, bug findings, correctness assessments, control-flow/type-safety analysis, design advice, or accept/reject recommendations. If the request crosses the boundary, refuse it rather than returning partial evidence. If an allowed question is underspecified, state the narrow non-debug follow-up needed.",
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
    "When on, the main agent may use readsubagent only for non-debug scouting/read planning or focused ordinary facts. Debugging source and diagnostic evidence remain direct parent/debugger reads and must never be redirected to readsubagent, including when an optional guard policy is configured. A saved /readsubagent on/off state overrides enabledByDefault for that session branch.",
    "Commands: /readsubagent on | off | toggle | status | model [model|default] | ask <question>. The model subcommand sets a workspace-persistent model/endpoint override; `model default` (or `model reset`) clears it.",
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
    "Debugging exception: if this is a debugging, failure-investigation, or diagnostic-evidence read, keep inspection direct in the parent or debugger. Do not redirect it to readsubagent; disable the optional guard or retry the required direct range.",
    "Next step options for non-debug work only:",
    `- If this non-debug read was for understanding, summarizing, docs/config/how-to, or finding where behavior lives, stop and use readsubagent with path=${JSON.stringify(options.path)}, that question, optional symbols/searchTerms/lineRanges, and a small maxReportChars budget.`,
    `- If exact direct contents are genuinely needed, retry read only for a small known range in ${options.path} needed for an edit, quote, or verification; do not chunk a large file or docs to learn it.`,
    "- If the target file or symbol is still unclear, ask readsubagent for a focused read-planning pass before any more direct reads.",
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
  if (isProhibitedReadSubagentRequest([
    options.question,
    options.paths,
    options.symbols,
    options.searchTerms,
    options.lineRanges,
    options.output,
  ])) {
    throw new Error(PROHIBITED_REQUEST_MESSAGE);
  }

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
  readSubagentMode = createAgentMode(pi, {
    id: "readsubagent",
    label: "readsubagent",
    stateEntryType: READSUBAGENT_STATE_ENTRY_TYPE,
    statusKey: STATUS_KEY,
    tools: ["readsubagent"],
    enabledByDefault: () => currentMainConfig.enabledByDefault,
    shortcut: "ctrl+alt+r",
    onChange: (enabled) => { readSubagentEnabled = enabled; },
  });

  pi.on("session_start", (_event, ctx) => {
    restoreState(pi, ctx);
    notifyConfigErrors(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreState(pi, ctx);
    notifyConfigErrors(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    readSubagentMode.clearStatus(ctx);
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
        "read blocked by the optional readsubagent directReadPolicy=block. Debugging reads must remain direct and must not be redirected to readsubagent; run /readsubagent off or set directReadPolicy to allow before debugging. For non-debug scouting only, use readsubagent or guard-large.",
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
          `Readsubagent endpoints are selected through /readsubagent model entries in .pi/extensions/readsubagent.config.jsonc. Use /readsubagent model <id>, or /readsubagent model default to clear the workspace override. ${formatAvailableReadSubagentModels()}`,
          "info",
        );
        return;
      }

      if (normalized !== "ask") {
        ctx.ui.notify(
          "Usage: /readsubagent on | off | toggle | status | model [model|default] | ask <question>",
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
      "Ask a local child Pi process for a non-debug codebase scout/read plan or focused factual answer about ordinary code, config, or documentation. Never use it for debugging, failure diagnosis, incidents, regressions, flaky tests, unexpected runtime behavior, or diagnostic artifacts.",
    promptSnippet:
      "Scout unfamiliar repository areas and plan focused non-debug reads before loading raw contents",
    promptGuidelines: [
      "Evaluate task context first: never use readsubagent while debugging, diagnosing failures, investigating regressions or flaky tests, handling incidents, or tracing unexpected runtime behavior.",
      "Never delegate logs, stack traces, crash reports, core dumps, test failure output, traces, profiler output, runtime captures, diagnostic screenshots, or similar artifacts. Inspect them directly in the parent or use debuggersubagent.",
      "During debugging, the parent or debuggersubagent must directly inspect source, config, documentation, and diagnostic evidence; readsubagent must not scout the debug path, suggest evidence, or return partial diagnostic analysis.",
      "Outside debugging, use readsubagent primarily for bounded codebase scouting and read planning in unfamiliar repository areas.",
      "Ask for a short subsystem map, candidate files, search/symbol/line anchors, the smallest focused read list, avoid-for-now areas, and explicit uncertainty.",
      "Focused non-debug factual answers about ordinary code, config, and documentation, including how-to material, remain supported when raw text is not needed.",
      "For allowed work, direct-read only when raw text is needed for a quote, exact edit oldText, precise known range, image inspection, final verification, or parent-side correctness analysis.",
      "If a non-debug direct read is compacted by the large-read guard, stop and ask readsubagent for a bounded read plan unless you already know the exact small range needed.",
      "Give readsubagent repo-relative paths, symbols, line ranges, search terms, the exact question, desired output shape, and maxReportChars when possible.",
      "Use main-context grep/find/ls for one-shot low-output discovery with a clear next action; for broader non-debug discovery, ask readsubagent for a bounded map and smallest next read list.",
      "Do not use readsubagent for hard logic, design, code review, bug finding, correctness, control-flow/type-safety, quality, maintainability, security, regression risk, or edit decisions.",
      "Do not use readsubagent for git operations that mutate repo or remote state; handle committing, pushing, PR creation/merge, branch cleanup, and main sync in the parent session.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "Non-debug scouting/read-planning or focused factual question about ordinary code, config, or documentation. Never include debugging work or diagnostic artifacts; do not ask for judgment, diagnosis, or review.",
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
            "Desired report shape, preferably a subsystem map, focused read list, anchors, avoid-for-now areas, and uncertainty, or a concise non-debug factual answer",
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

    renderCall(rawArgs: unknown, theme, context) {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const question = typeof args.question === "string" ? args.question : "";
      const path = typeof args.path === "string" ? args.path : "";
      const pathCount = Array.isArray(args.paths) ? args.paths.length : 0;
      const pathText = path || (pathCount > 0 ? `${pathCount} paths` : "no path");
      currentConfig = readActiveReadSubagentConfig(context.cwd);
      return renderChildAgentToolCall(theme, {
        agentName: "readsubagent",
        model: getModelSelector(currentConfig),
        scope: pathText,
        task: question || "...",
      });
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "readsubagent" });
    },
  });
}
