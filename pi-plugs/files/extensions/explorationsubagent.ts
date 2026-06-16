import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  previewTask,
  readChildPiAgentConfig,
  registerChildAgentProvider,
  renderChildAgentMessage,
  renderChildAgentToolResult,
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

const CONFIG_FILE_PATH = ".pi/extensions/explorationsubagent.config.jsonc";
const EXPLORATIONSUBAGENT_MESSAGE_TYPE = "explorationsubagent-report";
const EXPLORATIONSUBAGENT_STATE_ENTRY_TYPE = "explorationsubagent-state";
const STATUS_KEY = "explorationsubagent";
const DEFAULT_TOOLS = ["read", "bash", "grep", "find", "ls"];
const EXCLUDED_CHILD_TOOLS = [
  "readsubagent",
  "explorationsubagent",
  "reviewsubagent",
  "simpletasksubagent",
  "wfimpplanner",
  "wf-impplanner",
] as const;
const EXPLORATIONSUBAGENT_EVENT_END = "explorationsubagent:end";
const EXPLORATIONSUBAGENT_EVENT_ERROR = "explorationsubagent:error";
const EXPLORATIONSUBAGENT_EVENT_PROGRESS = "explorationsubagent:progress";
const EXPLORATIONSUBAGENT_EVENT_START = "explorationsubagent:start";

const MAIN_EXPLORATIONSUBAGENT_PROMPT = [
  "<explorationsubagent_delegation>",
  "Use explorationsubagent by default for factual exploratory repo discovery: target files/symbols/docs/configs are unclear, a subsystem must be mapped, or more than one rg/find/ls/bash search may be needed.",
  "Mandatory decision rule before parent-side rg/find/ls/bash discovery: if this is not a single precise low-output lookup with a clear next action, delegate to explorationsubagent.",
  "Do not perform a sequence of parent searches to locate behavior, commands, keybindings, config, docs, install logic, or related files. One precise search is the limit; if it branches or target remains unclear, switch to explorationsubagent.",
  "Keep specific parent searches only when target, scope, and next action are clear: rg -l, rg --count, tight scoped rg -n, or rg -n -m with narrow paths/globs.",
  "Delegate exploratory repo archaeology instead of dumping raw search output into the parent context.",
  "Good exploration requests include the factual discovery question, likely scope paths, known symbols, search terms, why the search may be broad, and the desired report shape.",
  "Ask the child for a summarized factual map: relevant files, key symbols, how they connect, searches tried, uncertainty, and possible next factual reads/searches. Do not ask explorationsubagent for hard logic, correctness analysis, code review, implementation plans, solution proposals, edit recommendations, or edit strategies.",
  "Do not use explorationsubagent when direct raw file contents, exact oldText for edits, final verification snippets, code-review judgment, hard logic/correctness analysis, or git mutations are required; use read for exact contents, readsubagent for targeted file facts, reviewsubagent for code review, and handle git/PR operations in the parent session.",
  "</explorationsubagent_delegation>",
].join("\n");

const DEFAULT_EXPLORATIONSUBAGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 127_000,
  endpoint: "http://127.0.0.1:11444",
  maxOutputTokens: 32_768,
  model: "qwen/qwen3.6-35b-a3b",
  provider: "lm-studio",
  providerRegistration: "none",
  reportMaxChars: 16_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are a read-only repo exploration subagent spawned by Pi. The parent delegates exploratory discovery when relevant files/symbols/configs/docs are unclear or broad rg/find/ls/bash searches would waste parent context. Use read-only tools as needed to map likely files, symbols, call sites, configuration, and relationships. You may use bash only for read-only discovery commands such as rg, find, ls, pwd, git status/log/diff --stat/--name-only, and similar inspection commands. Do not edit or write files and do not run destructive commands. Do not create implementation plans, solution proposals, edit strategies, code-review judgments, bug findings, correctness assessments, control-flow/type-safety analysis, or accept/reject recommendations. Your job is factual repo archaeology, relationships, evidence, and uncertainty only. If the parent asks for hard logic, review, or whether code is correct/acceptable, state that this is outside explorationsubagent scope and return only the factual map/evidence that would support a separate review. Prefer context-efficient searches: rg -l, rg --count, rg -n -m, --glob filters, and narrowed paths before reading files. Never return raw grep/find dumps, large command transcripts, whole files, or broad diffs. Return a concise exploration map with direct answer, relevant files, key symbols/patterns, how they connect, searches tried, uncertainty, and possible next factual reads/searches.",
  thinking: "off",
  tools: DEFAULT_TOOLS,
};

interface ExplorationFocus {
  readonly maxReportChars?: number | undefined;
  readonly output?: string | undefined;
  readonly searchTerms: readonly string[];
  readonly symbols: readonly string[];
}

type ExplorationSubagentModelOption = ChildAgentModelOption;

interface ExplorationSubagentState {
  readonly selectedModelId?: string;
}

interface ExplorationSubagentSavedState {
  readonly selectedModelId?: string;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_EXPLORATIONSUBAGENT_CONFIG };
let currentModelOptions: readonly ExplorationSubagentModelOption[] = [
  createExplorationSubagentModelOptionFromConfig(DEFAULT_EXPLORATIONSUBAGENT_CONFIG),
];
let lastConfigError: string | undefined;
let selectedExplorationSubagentModelId: string | undefined;
let explorationSubagentRunCounter = 0;

function createExplorationSubagentModelOptionFromConfig(
  config: ChildPiAgentConfig,
): ExplorationSubagentModelOption {
  return createChildAgentModelOptionFromConfig(config);
}

function readExplorationSubagentModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly ExplorationSubagentModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "explorationsubagent",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getExplorationSubagentModelChoiceLabel(option: ExplorationSubagentModelOption): string {
  return getChildAgentModelChoiceLabel(option);
}

function getExplorationSubagentModelOption(
  id: string | undefined,
): ExplorationSubagentModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findExplorationSubagentModelOption(
  input: string,
): ExplorationSubagentModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getExplorationSubagentModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableExplorationSubagentModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatExplorationSubagentModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedExplorationSubagentModelId,
  });
}

function applyExplorationSubagentModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(
    config,
    getExplorationSubagentModelOption(selectedExplorationSubagentModelId),
  );
}

function readActiveExplorationSubagentConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readExplorationSubagentConfig(cwd);
  currentModelOptions = readExplorationSubagentModelOptions(cwd, baseConfig);
  return applyExplorationSubagentModelSelection(baseConfig);
}

function reloadExplorationSubagentSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveExplorationSubagentConfig(cwd);
  registerExplorationSubagentProvider(pi, currentConfig);
}

function readExplorationSubagentConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "explorationsubagent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_EXPLORATIONSUBAGENT_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function registerExplorationSubagentProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  if (config.provider !== "local-explorationsubagent" || config.providerRegistration === "none") {
    pi.unregisterProvider("local-explorationsubagent");
  }

  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (exploration LM Studio)",
    providerDisplayName: "Local Exploration Subagent",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`explorationsubagent config ignored: ${lastConfigError}`, "warning");
  }
}

function isChildPiAgentProcess(): boolean {
  return (
    process.env[CHILD_PI_AGENT_ENV] === "1"
  );
}

function getSavedStateFromBranch(ctx: ExtensionContext): ExplorationSubagentSavedState {
  let saved: ExplorationSubagentSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== EXPLORATIONSUBAGENT_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getExplorationSubagentModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readExplorationSubagentConfig(ctx.cwd);
  currentModelOptions = readExplorationSubagentModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedExplorationSubagentModelId = saved.selectedModelId;
  currentConfig = applyExplorationSubagentModelSelection(baseConfig);
  registerExplorationSubagentProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<ExplorationSubagentState>(EXPLORATIONSUBAGENT_STATE_ENTRY_TYPE, {
    ...(selectedExplorationSubagentModelId
      ? { selectedModelId: selectedExplorationSubagentModelId }
      : {}),
  });
}

async function selectExplorationSubagentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  reloadExplorationSubagentSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findExplorationSubagentModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown explorationsubagent model "${requested}". Available: ${formatAvailableExplorationSubagentModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /explorationsubagent model <model>. Available: ${formatAvailableExplorationSubagentModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getExplorationSubagentModelChoiceLabel);
    const choice = await ctx.ui.select("Select explorationsubagent model", choices);
    if (!choice) {
      ctx.ui.notify("explorationsubagent model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No explorationsubagent models are available", "warning");
    return;
  }

  selectedExplorationSubagentModelId = option.id;
  persistState(pi);
  reloadExplorationSubagentSettings(pi, ctx.cwd);
  ctx.ui.notify(
    `explorationsubagent model selected: ${getExplorationSubagentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
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

function getReportMaxChars(config: ChildPiAgentConfig, requested: number | undefined): number {
  if (requested === undefined) return config.reportMaxChars;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error("explorationsubagent maxReportChars must be a positive number.");
  }

  return Math.min(config.reportMaxChars, Math.floor(requested));
}

function formatDelegatedTask(
  question: string,
  paths: readonly string[],
  focus: ExplorationFocus,
): string {
  const output = focus.output?.trim();
  const reportBudget = focus.maxReportChars
    ? `Aim to keep the final parent-visible report under ${Math.floor(focus.maxReportChars).toLocaleString("en-US")} characters.`
    : "Keep the final parent-visible report as short as possible while still giving the parent a useful map.";

  return [
    "Exploration question:",
    question,
    "",
    "Starting paths/directories/files:",
    formatListSection(paths),
    "",
    "Known symbols/functions/types/config keys:",
    formatListSection(focus.symbols),
    "",
    "Candidate search terms or regexes:",
    formatListSection(focus.searchTerms),
    "",
    "Desired output:",
    output ||
      "- Concise factual exploration map: direct answer, relevant files, key symbols/patterns, how they connect, searches tried, uncertainty, and possible next factual reads/searches.",
    "",
    "Report constraints:",
    `- ${reportBudget}`,
    "- Summarize findings; do not paste raw rg/find/grep dumps, broad command output, whole files, or broad diffs.",
    "- Cite repo-relative paths and line numbers when possible.",
    "- Prefer filenames, counts, and short targeted snippets only when they materially help the parent's next action.",
    "- State what you searched and any important uncertainty or dead ends.",
    "- Do not produce hard logic, correctness analysis, code review, bug findings, implementation plans, solution proposals, edit recommendations, or edit strategies; those belong to the caller or a review-focused agent. If useful, end with possible next factual reads/searches only.",
  ].join("\n");
}

function buildExplorationSubagentPrompt(task: string): string {
  return [
    "You are running as the child process for the parent Pi explorationsubagent tool.",
    "Your purpose is factual exploratory repo discovery that would otherwise spend parent context on broad rg/find/ls/bash output.",
    "Use read-only tools as needed. Bash is allowed only for inspection commands such as rg, find, ls, pwd, git status/log/diff --stat/--name-only, and similarly safe discovery commands.",
    "Search efficiently: start with scoped paths when supplied, prefer rg -l/--count/-m, use glob filters, and narrow before reading files. If output is large, rerun a narrower command instead of carrying it forward.",
    "Never modify files, never run destructive commands, and never return raw search dumps, whole files, large snippets, or broad diffs.",
    "Final report format: direct answer, relevant files with why, key symbols/patterns, how they connect, searches tried, uncertainty/dead ends, and possible next factual reads/searches. Do not include hard logic, correctness analysis, code review, bug findings, implementation plans, solution proposals, edit recommendations, or edit strategies; if asked for those, say they are outside explorationsubagent scope and provide only factual evidence/locations.",
    `Delegated exploration task:\n${task}`,
  ].join("\n\n");
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
    formatExplorationSubagentModelSelection(currentConfig),
    "Commands: /explorationsubagent model [model] | config | ask <question>. You can also run /explorationsubagent <question> directly.",
  ].join("\n");
}

async function runExplorationSubagentTask(options: {
  readonly config: ChildPiAgentConfig;
  readonly cwd?: string | undefined;
  readonly defaultCwd: string;
  readonly maxReportChars?: number | undefined;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
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
  const maxReportChars = getReportMaxChars(options.config, options.maxReportChars);
  const task = formatDelegatedTask(options.question, options.paths, {
    maxReportChars,
    output: options.output,
    searchTerms,
    symbols,
  });
  const runId = ++explorationSubagentRunCounter;
  const baseEvent = {
    cwd: options.cwd ?? options.defaultCwd,
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

  options.pi.events.emit(EXPLORATIONSUBAGENT_EVENT_START, { ...baseEvent, startedAt });

  const onProgress = (progress: ChildAgentProgress) => {
    options.pi.events.emit(EXPLORATIONSUBAGENT_EVENT_PROGRESS, {
      ...baseEvent,
      progress,
      startedAt,
      updatedAt: Date.now(),
    });
    options.onProgress?.(progress);
  };

  try {
    const result = await runChildPiAgent({
      buildPrompt: buildExplorationSubagentPrompt,
      config: options.config,
      cwd: options.cwd,
      defaultCwd: options.defaultCwd,
      excludeTools: EXCLUDED_CHILD_TOOLS,
      onProgress,
      signal: options.signal,
      task,
    });

    options.pi.events.emit(EXPLORATIONSUBAGENT_EVENT_END, {
      ...baseEvent,
      endedAt: Date.now(),
      result,
      startedAt,
    });
    return result;
  } catch (error) {
    options.pi.events.emit(EXPLORATIONSUBAGENT_EVENT_ERROR, {
      ...baseEvent,
      endedAt: Date.now(),
      errorMessage: getErrorMessage(error),
      startedAt,
    });
    throw error;
  }
}

export default function explorationSubagentExtension(pi: ExtensionAPI) {
  reloadExplorationSubagentSettings(pi, process.cwd());

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

  pi.registerMessageRenderer(EXPLORATIONSUBAGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "explorationsubagent" }),
  );

  pi.on("before_agent_start", (event) => {
    if (isChildPiAgentProcess()) return undefined;
    if (!pi.getActiveTools().includes("explorationsubagent")) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${MAIN_EXPLORATIONSUBAGENT_PROMPT}`,
    };
  });

  pi.registerCommand("explorationsubagent-config", {
    description: "Show /explorationsubagent config",
    handler: (_args, ctx) => {
      reloadExplorationSubagentSettings(pi, ctx.cwd);
      ctx.ui.notify(
        `explorationsubagent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatExplorationSubagentModelSelection(currentConfig)}`,
        "info",
      );
      notifyConfigErrorIfNeeded(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("explorationsubagent", {
    description: "Run exploratory repo discovery in a child Pi process or select its model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getExplorationSubagentModelCompletions(modelPrefix);
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
        reloadExplorationSubagentSettings(pi, ctx.cwd);
        ctx.ui.notify(formatStatus(), "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadExplorationSubagentSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `explorationsubagent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatExplorationSubagentModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectExplorationSubagentModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const question = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!question) {
        ctx.ui.notify(
          "Usage: /explorationsubagent model [model] | config | ask <question>; or /explorationsubagent <exploration question>",
          "warning",
        );
        return;
      }

      const config = readActiveExplorationSubagentConfig(ctx.cwd);
      registerExplorationSubagentProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(question)}`);

      try {
        const result = await runExplorationSubagentTask({
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
          messageType: EXPLORATIONSUBAGENT_MESSAGE_TYPE,
          pi,
          report,
          result,
        });

        const level = result.status === "completed" ? "info" : "warning";
        ctx.ui.notify(`explorationsubagent ${result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`explorationsubagent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });

  pi.registerTool({
    name: "explorationsubagent",
    label: "Exploration Subagent",
    description:
      "Delegate exploratory repo discovery to a local child Pi process when relevant files or symbols are unclear and broad rg/find/ls/bash searches would spend too much parent context. The child returns a concise exploration map instead of raw search output.",
    promptSnippet:
      "Delegate broad repo exploration/search archaeology to a child Pi process and get a summarized map",
    promptGuidelines: [
      "Use explorationsubagent by default when the task is factual exploration: finding where behavior lives, mapping a subsystem, discovering relevant files, or running multiple rg/find/ls searches.",
      "Before parent-side rg/find/ls/bash discovery, verify this is a single precise low-output lookup with a clear next action; otherwise delegate to explorationsubagent.",
      "Do not run a sequence of parent searches to locate commands, keybindings, config, docs, behavior, install logic, or related files; use explorationsubagent instead.",
      "Keep precise searches in the parent only when target, scope, and next action are clear, especially rg -l/--count or tightly scoped rg -n with small output.",
      "Do not dump broad rg/find/bash output in the parent context; ask explorationsubagent for relevant files, key symbols, relationships, searches tried, uncertainty, and possible next factual reads/searches.",
      "Provide starting paths, known symbols, search terms, the factual discovery goal, and a maxReportChars budget when possible.",
      "Use direct read, not explorationsubagent, when raw file contents, exact oldText for edits, precise ranges, or final verification snippets are required.",
      "Use readsubagent, not explorationsubagent, when target files are known and the parent needs a targeted answer rather than broad discovery.",
      "Use reviewsubagent, not explorationsubagent, when the goal is code review judgment, bug finding, correctness analysis, control-flow/type-safety validation, or deciding whether code is acceptable rather than factual discovery.",
      "Do not use explorationsubagent when the task is committing, pushing, creating or merging PRs, branch cleanup, or syncing main; handle those git operations in the parent session.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "Factual exploratory repo question or discovery task. Include what you are trying to find/map and why the search may be broad; do not ask for correctness judgments or edit recommendations.",
      }),
      path: Type.Optional(
        Type.String({ description: "Single repo-relative path or directory to start exploring" }),
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Repo-relative files or directories to use as the starting scope, ordered by relevance",
        }),
      ),
      symbols: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Known functions, classes, types, config keys, route names, or other symbols to seed the exploration",
        }),
      ),
      searchTerms: Type.Optional(
        Type.Array(Type.String(), {
          description: "Candidate search terms or regexes the child should try during exploration",
        }),
      ),
      output: Type.Optional(
        Type.String({
          description:
            "Desired report shape and level of detail, e.g. file map, subsystem overview, call-site inventory, or next factual reads/searches",
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
      const config = readActiveExplorationSubagentConfig(ctx.cwd);
      registerExplorationSubagentProvider(pi, config);
      const paths = normalizePathList(params.path, params.paths);
      const result = await runExplorationSubagentTask({
        config,
        cwd: params.cwd,
        defaultCwd: ctx.cwd,
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
                text: `explorationsubagent running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
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
      const pathText = path || (pathCount > 0 ? `${pathCount} paths` : "repo");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("explorationsubagent"))} ${theme.fg("accent", pathText)} ${theme.fg("dim", previewTask(question || "..."))}`,
        0,
        0,
      );
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "explorationsubagent" });
    },
  });
}
