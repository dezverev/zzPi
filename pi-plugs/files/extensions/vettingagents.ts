import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  summarizeToolCalls,
  truncateText,
  type RunStatus,
  type ToolCallSummary,
  type UsageStats,
} from "./zz-lib/child-pi-agent.ts";
import { createAgentMode } from "./lib/agent-mode.ts";
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
const CONFIG_FILE_PATH = ".pi/extensions/vettingagents.config.jsonc";
const VETTINGAGENTS_MESSAGE_TYPE = "vettingagents-report";
const VETTINGAGENTS_STATE_ENTRY_TYPE = "vettingagents-state";
const STATUS_KEY = "vettingagents";
const DEFAULT_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
];
const EXCLUDED_CHILD_TOOLS = [
  "vettingagents",
  "readsubagent",
  "edit",
  "write",
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
  "wftesteragent",
  "wf-testeragent",
  "wffinalreviewagent",
  "wf-finalreviewagent",
] as const;
const VETTINGAGENTS_EVENT_END = "vettingagents:end";
const VETTINGAGENTS_EVENT_ERROR = "vettingagents:error";
const VETTINGAGENTS_EVENT_PROGRESS = "vettingagents:progress";
const VETTINGAGENTS_EVENT_START = "vettingagents:start";
const DEFAULT_VETTING_LENS_TIMEOUT_MS = 6 * 60 * 1_000;

function getVettingLensTimeoutMs(): number {
  const configured = Number.parseInt(process.env.PI_VETTING_LENS_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_VETTING_LENS_TIMEOUT_MS;
}

const MAIN_VETTINGAGENTS_PROMPT = [
  "<vettingagents>",
  "Use vettingagents for adversarial verification of high-value docs, plans, implementation results, diffs, and code review targets.",
  "vettingagents runs three independent child Pi agents through separate lenses: research/grounding, feasibility against the live tree, and consistency/severity.",
  "Provide vettingagents the artifact path(s), the claim or plan to verify, relevant symbols/search terms, known concerns, and a maxReportChars budget when possible.",
  "Use the returned blockers and major findings to decide what must be fixed before relying on the document or plan.",
  "Use vettingagents for read-only implementation review, but never for code edits, git mutations, or implementation work.",
  "</vettingagents>",
].join("\n");

const DEFAULT_VETTINGAGENTS_CONFIG: ChildPiAgentConfig = {
  contextWindow: 272_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 128_000,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 36_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are a read-only adversarial vetting subagent spawned by Pi. Verify high-value documents, plans, implementation results, diffs, and code review targets without implementing changes. Be skeptical, evidence-driven, and specific. Inspect assigned evidence directly with your own read-only repo tools and model thread; do not delegate to other subagents. Do not edit or write files, do not run destructive commands, and do not perform git or PR operations. Return structured findings with blockers, major issues, evidence, uncertainty, and severity.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

interface VettingFocus {
  readonly criteria: readonly string[];
  readonly maxReportChars?: number | undefined;
  readonly output?: string | undefined;
  readonly searchTerms: readonly string[];
  readonly symbols: readonly string[];
}

interface VettingLens {
  readonly id: string;
  readonly label: string;
  readonly instructions: readonly string[];
}

interface VettingLensRunResult {
  readonly lens: VettingLens;
  readonly result: ChildAgentRunResult;
}

interface VettingAgentsRunResult {
  readonly lensResults: readonly VettingLensRunResult[];
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

type VettingAgentsModelOption = ChildAgentModelOption;

interface VettingAgentsState {
  readonly selectedModelId?: string;
}

interface VettingAgentsSavedState {
  readonly selectedModelId?: string;
}

const VETTING_LENSES: readonly VettingLens[] = [
  {
    id: "research-grounding",
    label: "Research / grounding",
    instructions: [
      "Verify factual claims against supplied artifacts, implementation outputs, diffs, repo files, cited docs, APIs, schemas, paths, command outputs, tests, and observable evidence.",
      "Look for unsupported assertions, stale references, missing citations, ambiguous terms, invented capabilities, unverified completion claims, or test evidence that cannot be grounded in the current workspace.",
      "Inspect targeted files and broader repository evidence directly with the tools assigned to this lens; do not rely on memory when evidence can be checked.",
    ],
  },
  {
    id: "feasibility-live-tree",
    label: "Feasibility against the live tree",
    instructions: [
      "Test whether the proposed design/plan or implemented result works against the current repository tree, available files, APIs, dependencies, commands, configs, call paths, and integration points.",
      "Surface blockers caused by missing files, nonexistent symbols, incompatible interfaces, migration gaps, broken control flow, incomplete wiring, unavailable tooling, regressions, or capabilities not present in the live tree.",
      "Use concrete repo evidence. When feasibility depends on an unverified assumption, mark it as a risk or verification gap rather than treating it as true.",
    ],
  },
  {
    id: "consistency-severity",
    label: "Consistency and severity",
    instructions: [
      "Check consistency across the target: goals vs scope, requirements vs implementation, claims vs code and tests, assumptions vs constraints, risks vs mitigations, interfaces, failure behavior, and acceptance criteria.",
      "Calibrate severity. Distinguish blockers from major issues, minor issues, and open questions; prioritize correctness, security, data-loss, regression, and maintainability impact without inflating severity.",
      "Look for contradictions, missing or duplicated behavior, unresolved TODOs, unsafe edge cases, weak error handling, type/control-flow gaps, and findings whose severity does not match impact or evidence.",
    ],
  },
];

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_VETTINGAGENTS_CONFIG };
let currentModelOptions: readonly VettingAgentsModelOption[] = [
  createVettingAgentsModelOptionFromConfig(DEFAULT_VETTINGAGENTS_CONFIG),
];
let lastConfigError: string | undefined;
let selectedVettingAgentsModelId: string | undefined;
let vettingAgentsRunCounter = 0;

function createVettingAgentsModelOptionFromConfig(
  config: ChildPiAgentConfig,
): VettingAgentsModelOption {
  return createChildAgentModelOptionFromConfig(config);
}

function readVettingAgentsModelOptions(
  cwd: string,
  baseConfig: ChildPiAgentConfig,
): readonly VettingAgentsModelOption[] {
  const result = readChildAgentModelOptions({
    agentName: "vettingagents",
    baseConfig,
    configFilePath: CONFIG_FILE_PATH,
    cwd,
  });
  if (result.error) {
    lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
  }
  return result.options;
}

function getVettingAgentsModelChoiceLabel(option: VettingAgentsModelOption): string {
  return getChildAgentModelChoiceLabel(option);
}

function getVettingAgentsModelOption(id: string | undefined): VettingAgentsModelOption | undefined {
  return getChildAgentModelOption(currentModelOptions, id);
}

function findVettingAgentsModelOption(input: string): VettingAgentsModelOption | undefined {
  return findChildAgentModelOption(currentModelOptions, input);
}

function getVettingAgentsModelCompletions(prefix: string) {
  return getChildAgentModelCompletions(currentModelOptions, prefix);
}

function formatAvailableVettingAgentsModels(): string {
  return formatAvailableChildAgentModels(currentModelOptions);
}

function formatVettingAgentsModelSelection(config: ChildPiAgentConfig): string {
  return formatChildAgentModelSelection({
    config,
    modelOptions: currentModelOptions,
    selectedModelId: selectedVettingAgentsModelId,
  });
}

function applyVettingAgentsModelSelection(config: ChildPiAgentConfig): ChildPiAgentConfig {
  return applyChildAgentModelSelection(config, getVettingAgentsModelOption(selectedVettingAgentsModelId));
}

function readActiveVettingAgentsConfig(cwd: string): ChildPiAgentConfig {
  const baseConfig = readVettingAgentsConfig(cwd);
  currentModelOptions = readVettingAgentsModelOptions(cwd, baseConfig);
  return applyVettingAgentsModelSelection(baseConfig);
}

function reloadVettingAgentsSettings(pi: ExtensionAPI, cwd: string): void {
  currentConfig = readActiveVettingAgentsConfig(cwd);
  registerVettingAgentsProvider(pi, currentConfig);
}

function readVettingAgentsConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "vettingagents",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_VETTINGAGENTS_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function registerVettingAgentsProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (vettingagents)",
    providerDisplayName: "Vetting Agents",
  });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`vettingagents config ignored: ${lastConfigError}`, "warning");
  }
}

function isChildPiAgentProcess(): boolean {
  return process.env[CHILD_PI_AGENT_ENV] === "1";
}

function getSavedStateFromBranch(ctx: ExtensionContext): VettingAgentsSavedState {
  let saved: VettingAgentsSavedState = {};

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== VETTINGAGENTS_STATE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data)) continue;

    const selectedModelId =
      typeof entry.data.selectedModelId === "string" &&
      getVettingAgentsModelOption(entry.data.selectedModelId)
        ? entry.data.selectedModelId
        : undefined;

    if (selectedModelId === undefined) continue;
    saved = { selectedModelId };
  }

  return saved;
}

function restoreState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const baseConfig = readVettingAgentsConfig(ctx.cwd);
  currentModelOptions = readVettingAgentsModelOptions(ctx.cwd, baseConfig);

  const saved = getSavedStateFromBranch(ctx);
  selectedVettingAgentsModelId = saved.selectedModelId;
  currentConfig = applyVettingAgentsModelSelection(baseConfig);
  registerVettingAgentsProvider(pi, currentConfig);
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry<VettingAgentsState>(VETTINGAGENTS_STATE_ENTRY_TYPE, {
    ...(selectedVettingAgentsModelId ? { selectedModelId: selectedVettingAgentsModelId } : {}),
  });
}

async function selectVettingAgentsModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  reloadVettingAgentsSettings(pi, ctx.cwd);

  const requested = args.trim();
  let option = requested ? findVettingAgentsModelOption(requested) : undefined;

  if (requested && !option) {
    ctx.ui.notify(
      `Unknown vettingagents model "${requested}". Available: ${formatAvailableVettingAgentsModels()}`,
      "error",
    );
    return;
  }

  if (!option) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `Usage: /vettingagents model <model>. Available: ${formatAvailableVettingAgentsModels()}`,
        "warning",
      );
      return;
    }

    const choices = currentModelOptions.map(getVettingAgentsModelChoiceLabel);
    const choice = await ctx.ui.select("Select vettingagents model", choices);
    if (!choice) {
      ctx.ui.notify("vettingagents model selection cancelled", "info");
      return;
    }

    const choiceIndex = choices.indexOf(choice);
    option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
  }

  if (!option) {
    ctx.ui.notify("No vettingagents models are available", "warning");
    return;
  }

  selectedVettingAgentsModelId = option.id;
  persistState(pi);
  reloadVettingAgentsSettings(pi, ctx.cwd);
  ctx.ui.notify(
    `vettingagents model selected: ${getVettingAgentsModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
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
    throw new Error("vettingagents maxReportChars must be a positive number.");
  }

  return Math.min(config.reportMaxChars, Math.floor(requested));
}

function getPerLensMaxReportChars(totalMaxReportChars: number): number {
  return Math.max(500, Math.floor(totalMaxReportChars / VETTING_LENSES.length));
}

function formatDelegatedTask(task: string, paths: readonly string[], focus: VettingFocus): string {
  const output = focus.output?.trim();
  const reportBudget = focus.maxReportChars
    ? `Aim to keep this lens report under ${Math.floor(focus.maxReportChars).toLocaleString("en-US")} characters.`
    : "Keep this lens report concise while still including all material blockers and findings.";

  return [
    "Vetting target / question:",
    task,
    "",
    "High-value artifact paths and relevant live-tree scopes:",
    formatListSection(paths),
    "",
    "Known symbols/functions/types/config keys:",
    formatListSection(focus.symbols),
    "",
    "Search terms or regexes to seed verification:",
    formatListSection(focus.searchTerms),
    "",
    "Additional criteria, risks, or concerns to verify:",
    formatListSection(focus.criteria),
    "",
    "Desired output:",
    output ||
      "- Markdown with sections: Verdict, Blockers, Major findings, Other issues, Evidence checked, Verification gaps, and Suggested next checks.",
    "",
    "Report constraints:",
    `- ${reportBudget}`,
    "- Work independently within your assigned lens; do not assume another vetting agent will cover your concerns.",
    "- Be adversarial but evidence-driven. Separate confirmed evidence from plausible risk and unknowns.",
    "- Cite repo-relative paths and line numbers when possible.",
    "- Do not paste raw grep/find/rg dumps, broad diffs, whole files, or large command transcripts.",
    "- Do not edit/write files, mutate git state, or perform PR/branch operations.",
    "- Work only within this lens's own child thread/model and inspect evidence directly; do not delegate to other subagents.",
  ].join("\n");
}

function buildVettingLensPrompt(lens: VettingLens, task: string): string {
  return [
    "You are running as one independent child process for the parent Pi vettingagents tool.",
    "Your purpose is adversarial verification of high-value documents, plans, implementation results, diffs, and code review targets. Work read-only.",
    "Do not coordinate with or reference the other vetting agents. Your report must stand on its own.",
    "Use only evidence you can inspect or clearly label as an assumption. Prefer repo-relative paths and line numbers.",
    "Bash is allowed only for read-only inspection commands such as rg, find, ls, pwd, git status/log/diff --stat/--name-only, and non-mutating checks when explicitly useful.",
    "Inspect files and repository evidence directly with this child thread's read-only tools; do not call or delegate to other subagents.",
    "Never edit/write files, never run destructive commands, and never perform git commits, pushes, branch changes, or PR operations.",
    "",
    `Assigned lens: ${lens.label}`,
    ...lens.instructions.map((item) => `- ${item}`),
    "",
    "Final report format:",
    "## Verdict",
    "- status: pass | concerns | blocked | insufficient-evidence",
    "- confidence: high | medium | low",
    "- one-sentence summary",
    "## Blockers",
    "- [severity: blocker] path:line if known — issue — evidence — why it blocks safe use",
    "## Major findings",
    "- [severity: high|medium] path:line if known — issue — evidence — impact",
    "## Other issues",
    "- [severity: low] path:line if known — issue — evidence — impact",
    "## Evidence checked",
    "- concrete docs/files/commands/tools consulted, summarized briefly",
    "## Verification gaps",
    "- what could not be verified and why it matters",
    "## Suggested next checks",
    "- highest-value follow-up checks or questions",
    "",
    `Delegated vetting task:\n${task}`,
  ].join("\n");
}

function formatStatus(): string {
  return [
    formatVettingAgentsModelSelection(currentConfig),
    "Commands: /vettingagents on|off|toggle|status|model [model] | config | ask <vetting request>. You can also run /vettingagents <request> directly.",
  ].join("\n");
}

function createEmptyUsage(): UsageStats {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    estimatedInput: 0,
    estimatedOutput: 0,
    estimatedTotal: 0,
    input: 0,
    output: 0,
    totalTokens: 0,
    turns: 0,
  };
}

function sumUsage(results: readonly ChildAgentRunResult[]): UsageStats {
  const usage = createEmptyUsage();
  for (const result of results) {
    usage.cacheRead += result.usage.cacheRead;
    usage.cacheWrite += result.usage.cacheWrite;
    usage.cost += result.usage.cost;
    usage.estimatedInput += result.usage.estimatedInput;
    usage.estimatedOutput += result.usage.estimatedOutput;
    usage.estimatedTotal += result.usage.estimatedTotal;
    usage.input += result.usage.input;
    usage.output += result.usage.output;
    usage.totalTokens += result.usage.totalTokens;
    usage.turns += result.usage.turns;
  }
  return usage;
}

function getAggregateStatus(results: readonly ChildAgentRunResult[]): RunStatus {
  if (results.every((result) => result.status === "completed")) return "completed";
  if (results.some((result) => result.status === "aborted")) return "aborted";
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.some((result) => result.status === "timeout")) return "timeout";
  return "failed";
}

function prefixToolCalls(
  lens: VettingLens,
  toolCalls: readonly ToolCallSummary[],
): ToolCallSummary[] {
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    id: `${lens.id}:${toolCall.id}`,
    name: `${lens.id}/${toolCall.name}`,
  }));
}

function formatLensReport(
  lensResult: VettingLensRunResult,
  perLensMaxReportChars: number,
): string {
  const { lens, result } = lensResult;
  const output = result.output.trim() || result.errorMessage || result.stderr || "(no output)";
  const statusLine = [
    `status: ${result.status}`,
    `durationMs: ${result.durationMs}`,
    `turns: ${result.usage.turns}`,
    `toolCalls: ${result.toolCalls.length}`,
  ].join("; ");

  return [
    `## ${lens.label}`,
    statusLine,
    "",
    truncateText(output, perLensMaxReportChars),
  ].join("\n");
}

function formatVettingAgentsReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly lensResults: readonly VettingLensRunResult[];
  readonly maxReportChars: number;
  readonly task: string;
}): string {
  const perLensMaxReportChars = getPerLensMaxReportChars(options.maxReportChars);
  const statuses = options.lensResults.map(({ lens, result }) => {
    const tools = result.toolCalls.length === 1 ? "1 tool" : `${result.toolCalls.length} tools`;
    const turns = result.usage.turns === 1 ? "1 turn" : `${result.usage.turns} turns`;
    return `- ${lens.label}: ${result.status} (${turns}, ${tools})`;
  });
  const blockersHint =
    "Review each lens section for `Blockers` and `Major findings`. Repeated concerns across independent lenses should be treated as higher-confidence signals.";

  const report = [
    "# Vetting agents report",
    "",
    `Model selector: ${getModelSelector(options.config)}`,
    `Target: ${previewTask(options.task)}`,
    "",
    "Three independent child Pi agents vetted the target through separate lenses:",
    ...statuses,
    "",
    `High-signal use: ${blockersHint}`,
    "",
    ...options.lensResults.map((lensResult) => formatLensReport(lensResult, perLensMaxReportChars)),
  ].join("\n");

  return truncateText(report, options.maxReportChars);
}

function createFailedLensRunResult(
  lens: VettingLens,
  error: unknown,
  task: string,
  startedAt: number,
): VettingLensRunResult {
  const message = getErrorMessage(error);
  return {
    lens,
    result: {
      durationMs: Date.now() - startedAt,
      errorMessage: message,
      exitCode: 1,
      output: `${lens.label} failed before producing a report: ${message}`,
      rawOutput: "",
      status: "failed",
      stderr: message,
      task,
      toolCalls: [],
      usage: createEmptyUsage(),
    },
  };
}

function createAggregateResult(options: {
  readonly config: ChildPiAgentConfig;
  readonly lensResults: readonly VettingLensRunResult[];
  readonly report: string;
  readonly startedAt: number;
  readonly task: string;
}): ChildAgentRunResult {
  const results = options.lensResults.map((lensResult) => lensResult.result);
  const status = getAggregateStatus(results);
  const stderr = results
    .map((result, index) => {
      if (!result.stderr.trim()) return undefined;
      return `${options.lensResults[index]?.lens.label ?? "lens"}: ${result.stderr.trim()}`;
    })
    .filter((item): item is string => item !== undefined)
    .join("\n\n");
  const errorMessage = results
    .map((result, index) => {
      if (!result.errorMessage?.trim()) return undefined;
      return `${options.lensResults[index]?.lens.label ?? "lens"}: ${result.errorMessage.trim()}`;
    })
    .filter((item): item is string => item !== undefined)
    .join("\n");

  return {
    durationMs: Date.now() - options.startedAt,
    ...(errorMessage ? { errorMessage } : {}),
    exitCode: status === "completed" ? 0 : 1,
    model: getModelSelector(options.config),
    output: options.report,
    rawOutput: options.report,
    status,
    stderr,
    task: options.task,
    toolCalls: options.lensResults.flatMap(({ lens, result }) => prefixToolCalls(lens, result.toolCalls)),
    usage: sumUsage(results),
  };
}

async function runVettingAgentsTask(options: {
  readonly config: ChildPiAgentConfig;
  readonly criteria?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly defaultCwd: string;
  readonly maxReportChars?: number | undefined;
  readonly onProgress?: (lens: VettingLens, progress: ChildAgentProgress) => void;
  readonly output?: string | undefined;
  readonly paths: readonly string[];
  readonly pi: ExtensionAPI;
  readonly searchTerms?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly symbols?: readonly string[] | undefined;
  readonly task: string;
}): Promise<VettingAgentsRunResult> {
  const criteria = normalizeStringList(options.criteria);
  const searchTerms = normalizeStringList(options.searchTerms);
  const symbols = normalizeStringList(options.symbols);
  const maxReportChars = getReportMaxChars(options.config, options.maxReportChars);
  const perLensMaxReportChars = getPerLensMaxReportChars(maxReportChars);
  const task = formatDelegatedTask(options.task, options.paths, {
    criteria,
    maxReportChars: perLensMaxReportChars,
    output: options.output,
    searchTerms,
    symbols,
  });
  const runId = ++vettingAgentsRunCounter;
  const baseEvent = {
    criteria,
    cwd: options.cwd ?? options.defaultCwd,
    maxReportChars,
    model: getModelSelector(options.config),
    output: options.output,
    paths: options.paths,
    runId,
    searchTerms,
    symbols,
    task,
  };
  const startedAt = Date.now();

  options.pi.events.emit(VETTINGAGENTS_EVENT_START, { ...baseEvent, startedAt });

  const runLens = async (lens: VettingLens): Promise<VettingLensRunResult> => {
    const lensStartedAt = Date.now();
    try {
      const result = await runChildPiAgent({
        buildPrompt: (delegatedTask) => buildVettingLensPrompt(lens, delegatedTask),
        config: {
          ...options.config,
          requestTimeoutMs: Math.min(options.config.requestTimeoutMs, getVettingLensTimeoutMs()),
        },
        cwd: options.cwd,
        defaultCwd: options.defaultCwd,
        excludeTools: EXCLUDED_CHILD_TOOLS,
        onProgress: (progress) => {
          options.pi.events.emit(VETTINGAGENTS_EVENT_PROGRESS, {
            ...baseEvent,
            lens: lens.id,
            lensLabel: lens.label,
            progress,
            startedAt,
            updatedAt: Date.now(),
          });
          options.onProgress?.(lens, progress);
        },
        signal: options.signal,
        task,
      });
      return { lens, result };
    } catch (error) {
      return createFailedLensRunResult(lens, error, task, lensStartedAt);
    }
  };

  try {
    const lensResults = await Promise.all(VETTING_LENSES.map(runLens));
    const report = formatVettingAgentsReport({
      config: options.config,
      lensResults,
      maxReportChars,
      task: options.task,
    });
    const result = createAggregateResult({
      config: options.config,
      lensResults,
      report,
      startedAt,
      task,
    });

    options.pi.events.emit(VETTINGAGENTS_EVENT_END, {
      ...baseEvent,
      endedAt: Date.now(),
      lensResults,
      result,
      startedAt,
    });

    return { lensResults, report, result };
  } catch (error) {
    options.pi.events.emit(VETTINGAGENTS_EVENT_ERROR, {
      ...baseEvent,
      endedAt: Date.now(),
      errorMessage: getErrorMessage(error),
      startedAt,
    });
    throw error;
  }
}

export default function vettingAgentsExtension(pi: ExtensionAPI) {
  reloadVettingAgentsSettings(pi, process.cwd());
  const mode = createAgentMode(pi, {
    id: "vettingagents",
    label: "vetting",
    stateEntryType: VETTINGAGENTS_STATE_ENTRY_TYPE,
    tools: ["vettingagents"],
    enabledByDefault: () => true,
    shortcut: "ctrl+alt+v",
  });

  pi.on("session_start", (_event, ctx) => {
    restoreState(pi, ctx);
    mode.restore(ctx);
    notifyConfigErrorIfNeeded(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreState(pi, ctx);
    mode.restore(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    mode.clearStatus(ctx);
  });

  pi.registerMessageRenderer(VETTINGAGENTS_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "vettingagents" }),
  );

  pi.on("before_agent_start", (event) => {
    if (isChildPiAgentProcess() || !mode.isEnabled()) return undefined;
    if (!pi.getActiveTools().includes("vettingagents")) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${MAIN_VETTINGAGENTS_PROMPT}`,
    };
  });

  pi.registerCommand("vettingagents-config", {
    description: "Show /vettingagents config",
    handler: (_args, ctx) => {
      reloadVettingAgentsSettings(pi, ctx.cwd);
      ctx.ui.notify(
        `vettingagents config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatVettingAgentsModelSelection(currentConfig)}`,
        "info",
      );
      notifyConfigErrorIfNeeded(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("vettingagents", {
    description:
      "Run three independent adversarial vetting agents for docs, plans, or implementation results; or select their model",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const hasTrailingSpace = /\s$/u.test(prefix);
      const parts = trimmed ? trimmed.split(/\s+/u) : [];
      const [first = "", ...rest] = parts;
      const normalizedFirst = first.toLowerCase();

      if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
        const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
        return getVettingAgentsModelCompletions(modelPrefix);
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

      if (["on", "off", "toggle"].includes(normalized) && mode.handleAction(normalized, ctx)) return;

      if (!trimmed || normalized === "status") {
        reloadVettingAgentsSettings(pi, ctx.cwd);
        mode.applyStatus(ctx);
        ctx.ui.notify(`${mode.statusText()}\n${formatStatus()}`, "info");
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "config") {
        reloadVettingAgentsSettings(pi, ctx.cwd);
        ctx.ui.notify(
          `vettingagents config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}\n${formatVettingAgentsModelSelection(currentConfig)}`,
          "info",
        );
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      if (normalized === "model" || normalized === "models") {
        await selectVettingAgentsModel(pi, ctx, rest.join(" "));
        notifyConfigErrorIfNeeded(ctx);
        return;
      }

      const task = normalized === "ask" ? rest.join(" ").trim() : trimmed;
      if (!task) {
        ctx.ui.notify(
          "Usage: /vettingagents on|off|toggle|status|model [model]|config|ask <vetting request>; or /vettingagents <request>",
          "warning",
        );
        return;
      }

      const config = readActiveVettingAgentsConfig(ctx.cwd);
      registerVettingAgentsProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running 3 vetting lenses on ${model}: ${previewTask(task)}`);

      try {
        const run = await runVettingAgentsTask({
          config,
          defaultCwd: ctx.cwd,
          paths: [],
          pi,
          task,
          onProgress: (lens, progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `${lens.label}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        sendChildAgentReportMessage({
          config,
          ctx,
          messageType: VETTINGAGENTS_MESSAGE_TYPE,
          pi,
          report: run.report,
          result: run.result,
        });

        const level = run.result.status === "completed" ? "info" : "warning";
        ctx.ui.notify(
          `vettingagents ${run.result.status}; report added to main context (${summarizeToolCalls(run.result.toolCalls)})`,
          level,
        );
      } catch (error) {
        ctx.ui.notify(`vettingagents failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });

  pi.registerTool({
    name: "vettingagents",
    label: "Vetting Agents",
    description:
      "Run three independent read-only adversarial vetting agents for high-value docs, plans, implementation results, diffs, or code review targets. Each child works directly in its own assigned thread/model without delegating to other subagents.",
    promptSnippet:
      "Run 3 independent adversarial vetting agents over a doc, plan, implementation result, diff, or code target",
    promptGuidelines: [
      "Use vettingagents to verify high-value docs, plans, implementation results, diffs, and code review targets.",
      "Provide artifact paths or live-tree scope, target claims/results, relevant symbols/search terms, expected risks, and a maxReportChars budget when possible.",
      "The tool runs three independent child Pi agents through research/grounding, live-tree feasibility, and consistency/severity lenses.",
      "Use returned blockers and major findings to decide what must change before relying on a document, plan, or implementation result.",
      "Use vettingagents for read-only review only; do not use it for edits, git mutations, or implementation work.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description:
          "Vetting request. Include the document, plan, implementation result, diff, or code target to verify; what claims or behavior matter; and what blockers should be surfaced.",
      }),
      path: Type.Optional(
        Type.String({ description: "Single repo-relative artifact path or live-tree scope to inspect" }),
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Repo-relative artifact paths and relevant live-tree scopes, ordered by relevance",
        }),
      ),
      symbols: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Specific functions, classes, types, config keys, routes, packages, or decisions to verify",
        }),
      ),
      searchTerms: Type.Optional(
        Type.Array(Type.String(), {
          description: "Focused search terms or regexes the child agents should use as verification seeds",
        }),
      ),
      criteria: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Additional acceptance criteria, risks, invariants, assumptions, or concerns each lens should check",
        }),
      ),
      output: Type.Optional(
        Type.String({
          description:
            "Desired report shape and level of detail. Defaults to structured blockers/findings/evidence/gaps per lens.",
        }),
      ),
      maxReportChars: Type.Optional(
        Type.Number({
          description:
            "Optional maximum characters for the combined report. Clamped to the configured reportMaxChars and divided across lens reports.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Optional working directory for the child processes" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = readActiveVettingAgentsConfig(ctx.cwd);
      registerVettingAgentsProvider(pi, config);
      const paths = normalizePathList(params.path, params.paths);
      const run = await runVettingAgentsTask({
        config,
        criteria: params.criteria,
        cwd: params.cwd,
        defaultCwd: ctx.cwd,
        maxReportChars: params.maxReportChars,
        output: params.output,
        paths,
        pi,
        searchTerms: params.searchTerms,
        signal,
        symbols: params.symbols,
        task: params.task,
        onProgress: (lens, progress) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `vettingagents ${lens.label} running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
              },
            ],
            details: { lens: lens.id, progress },
          });
        },
      });

      return {
        content: [{ type: "text", text: run.report }],
        details: {
          ...getChildAgentResultDetails(run.result, config),
          lensResults: run.lensResults.map(({ lens, result }) => ({
            lens: lens.id,
            lensLabel: lens.label,
            status: result.status,
            toolCalls: result.toolCalls.length,
            turns: result.usage.turns,
          })),
        },
      };
    },

    renderCall(rawArgs: unknown, theme, context) {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const task = typeof args.task === "string" ? args.task : "";
      const path = typeof args.path === "string" ? args.path : "";
      const pathCount = Array.isArray(args.paths) ? args.paths.length : 0;
      const pathText = path || (pathCount > 0 ? `${pathCount} paths` : "doc/plan");
      currentConfig = readActiveVettingAgentsConfig(context.cwd);
      return renderChildAgentToolCall(theme, {
        agentName: "vettingagents",
        model: getModelSelector(currentConfig),
        scope: pathText,
        task: task || "...",
      });
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "vettingagents" });
    },
  });
}
