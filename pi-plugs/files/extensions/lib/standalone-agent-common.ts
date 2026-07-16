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
} from "../zz-lib/child-pi-agent.ts";
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
} from "./child-agent-model-options.ts";

export interface StandaloneAgentRunResult<Decision> {
  readonly config: ChildPiAgentConfig;
  readonly decision?: Decision | undefined;
  readonly parseError?: string | undefined;
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

interface StandaloneAgentSavedState {
  readonly selectedModelId?: string;
}

interface StandaloneAgentDefinition<Decision> {
  readonly agentName: string;
  readonly allowCommandRun?: boolean | undefined;
  readonly buildPrompt: (task: string) => string;
  readonly commandDescription: string;
  readonly commandUsage: string;
  readonly configFilePath: string;
  readonly defaultConfig: ChildPiAgentConfig;
  readonly displayName: string;
  readonly excludeTools: readonly string[];
  readonly formatReport: (options: {
    readonly config: ChildPiAgentConfig;
    readonly decision?: Decision | undefined;
    readonly parseError?: string | undefined;
    readonly result: ChildAgentRunResult;
  }) => string;
  readonly messageType: string;
  readonly modelDisplaySuffix: string;
  readonly parseDecision: (text: string) => Decision | undefined;
  readonly parseErrorMessage: string;
  readonly providerDisplayName: string;
  readonly stateEntryType: string;
}

export interface StandaloneChildAgent<Decision> {
  readonly formatModelSelection: () => string;
  readonly getActiveModelSelector: (cwd?: string | undefined) => string;
  readonly readActiveConfig: (cwd: string) => ChildPiAgentConfig;
  readonly register: (pi: ExtensionAPI) => void;
  readonly registerProvider: (pi: ExtensionAPI, config: ChildPiAgentConfig) => void;
  readonly reloadSettings: (pi: ExtensionAPI, cwd: string) => void;
  readonly run: (options: {
    readonly ctx: ExtensionContext;
    readonly onProgress?: (progress: ChildAgentProgress) => void;
    readonly pi: ExtensionAPI;
    readonly signal?: AbortSignal | undefined;
    readonly task: string;
    readonly tools?: readonly string[] | undefined;
  }) => Promise<StandaloneAgentRunResult<Decision>>;
  readonly selectModel: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    args: string,
    options?: { readonly quiet?: boolean },
  ) => Promise<void>;
  readonly sendReportMessage: (pi: ExtensionAPI, ctx: ExtensionContext, run: StandaloneAgentRunResult<Decision>) => void;
}

export const STANDALONE_AGENT_EXCLUDED_TOOLS = [
  "design-loop",
  "brainstormer", "designplanner",
  "vettingagents", "debuggersubagent", "promptenrichsubagent",
] as const;

export function extractJsonCandidate(text: string): string | undefined {
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

export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }

  return isRecord(parsed) ? parsed : undefined;
}

export function normalizeKind(value: string | undefined, fallback: string): string {
  return (value ?? fallback).toLowerCase().replace(/[\s-]+/gu, "_");
}

export function getOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "pass", "passed", "green", "verified"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "fail", "failed", "red"].includes(normalized)) return false;
  return undefined;
}

export function getStringArray(value: unknown): readonly string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

export function getRecordArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

export function getOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function pushList(lines: string[], title: string, items: readonly string[] | undefined): void {
  if (!items || items.length === 0) return;
  lines.push(`## ${title}`, "");
  items.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
}

export function pushJson(lines: string[], title: string, value: unknown): void {
  if (value === undefined) return;
  lines.push(`## ${title}`, "", "```json", JSON.stringify(value, null, 2), "```", "");
}

export function appendRunInfo(lines: string[], options: {
  readonly config: ChildPiAgentConfig;
  readonly result: ChildAgentRunResult;
}): void {
  lines.push("## Run info", "");
  lines.push(`- Status: ${options.result.status}`);
  lines.push(`- Model: ${options.result.model ?? getModelSelector(options.config)}`);
  lines.push(`- Duration: ${(options.result.durationMs / 1_000).toFixed(1)}s`);
  lines.push(`- Tools: ${options.result.toolCalls.map((call) => call.name).join(", ") || "none"}`);
  if (options.result.stopReason) lines.push(`- Stop reason: ${options.result.stopReason}`);
  if (options.result.exitCode !== 0) lines.push(`- Exit code: ${options.result.exitCode}`);
  if (options.result.errorMessage) lines.push(`- Error: ${options.result.errorMessage}`);
}

export function truncateReport(lines: readonly string[], config: ChildPiAgentConfig): string {
  return truncateText(lines.join("\n"), config.reportMaxChars);
}

export function createStandaloneChildAgent<Decision>(definition: StandaloneAgentDefinition<Decision>): StandaloneChildAgent<Decision> {
  let currentConfig: ChildPiAgentConfig = { ...definition.defaultConfig };
  let currentModelOptions: readonly ChildAgentModelOption[] = [
    createChildAgentModelOptionFromConfig(definition.defaultConfig),
  ];
  let lastConfigError: string | undefined;
  let selectedModelId: string | undefined;

  const readModelOptions = (cwd: string, baseConfig: ChildPiAgentConfig): readonly ChildAgentModelOption[] => {
    const result = readChildAgentModelOptions({
      agentName: definition.agentName,
      baseConfig,
      configFilePath: definition.configFilePath,
      cwd,
    });
    if (result.error) lastConfigError = lastConfigError ? `${lastConfigError}\n${result.error}` : result.error;
    return result.options;
  };

  const getModelOption = (id: string | undefined): ChildAgentModelOption | undefined =>
    getChildAgentModelOption(currentModelOptions, id);

  const findModelOption = (input: string): ChildAgentModelOption | undefined =>
    findChildAgentModelOption(currentModelOptions, input);

  const formatAvailableModels = (): string => formatAvailableChildAgentModels(currentModelOptions);

  const formatModelSelection = (): string =>
    formatChildAgentModelSelection({ config: currentConfig, modelOptions: currentModelOptions, selectedModelId });

  const applyModelSelection = (config: ChildPiAgentConfig): ChildPiAgentConfig =>
    applyChildAgentModelSelection(config, getModelOption(selectedModelId));

  const readConfig = (cwd: string): ChildPiAgentConfig => {
    const result = readChildPiAgentConfig({
      agentName: definition.agentName,
      configFilePath: definition.configFilePath,
      cwd,
      defaults: definition.defaultConfig,
    });
    lastConfigError = result.error;
    return result.config;
  };

  const readActiveConfig = (cwd: string): ChildPiAgentConfig => {
    const baseConfig = readConfig(cwd);
    currentModelOptions = readModelOptions(cwd, baseConfig);
    return applyModelSelection(baseConfig);
  };

  const getActiveModelSelector = (cwd?: string): string => {
    if (cwd) currentConfig = readActiveConfig(cwd);
    return getModelSelector(currentConfig);
  };

  const registerProvider = (pi: ExtensionAPI, config: ChildPiAgentConfig): void => {
    registerChildAgentProvider(pi, config, {
      modelDisplaySuffix: definition.modelDisplaySuffix,
      providerDisplayName: definition.providerDisplayName,
    });
  };

  const reloadSettings = (pi: ExtensionAPI, cwd: string): void => {
    currentConfig = readActiveConfig(cwd);
    registerProvider(pi, currentConfig);
  };

  const notifyConfigErrorIfNeeded = (ctx: ExtensionContext): void => {
    if (lastConfigError) ctx.ui.notify(`${definition.agentName} config ignored: ${lastConfigError}`, "warning");
  };

  const getSavedStateFromBranch = (ctx: ExtensionContext): StandaloneAgentSavedState => {
    let saved: StandaloneAgentSavedState = {};

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== definition.stateEntryType) continue;
      if (!isRecord(entry.data)) continue;

      const candidate = typeof entry.data.selectedModelId === "string" ? entry.data.selectedModelId : undefined;
      if (!candidate || !getModelOption(candidate)) continue;
      saved = { selectedModelId: candidate };
    }

    return saved;
  };

  const restoreState = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
    const baseConfig = readConfig(ctx.cwd);
    currentModelOptions = readModelOptions(ctx.cwd, baseConfig);
    const saved = getSavedStateFromBranch(ctx);
    selectedModelId = saved.selectedModelId;
    currentConfig = applyModelSelection(baseConfig);
    registerProvider(pi, currentConfig);
  };

  const persistState = (pi: ExtensionAPI): void => {
    pi.appendEntry<StandaloneAgentSavedState>(definition.stateEntryType, {
      ...(selectedModelId ? { selectedModelId } : {}),
    });
  };

  const selectModel = async (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    args: string,
    options?: { readonly quiet?: boolean },
  ): Promise<void> => {
    reloadSettings(pi, ctx.cwd);

    const requested = args.trim();
    let option = requested ? findModelOption(requested) : undefined;

    if (requested && !option) {
      ctx.ui.notify(`Unknown ${definition.agentName} model "${requested}". Available: ${formatAvailableModels()}`, "error");
      return;
    }

    if (!option) {
      if (!ctx.hasUI) {
        ctx.ui.notify(`Usage: /${definition.agentName} model <model>. Available: ${formatAvailableModels()}`, "warning");
        return;
      }

      const choices = currentModelOptions.map(getChildAgentModelChoiceLabel);
      const choice = await ctx.ui.select(`Select ${definition.agentName} model`, choices);
      if (!choice) {
        ctx.ui.notify(`${definition.agentName} model selection cancelled`, "info");
        return;
      }

      const choiceIndex = choices.indexOf(choice);
      option = choiceIndex >= 0 ? currentModelOptions[choiceIndex] : undefined;
    }

    if (!option) {
      ctx.ui.notify(`No ${definition.agentName} models are available`, "warning");
      return;
    }

    selectedModelId = option.id;
    persistState(pi);
    reloadSettings(pi, ctx.cwd);
    if (!options?.quiet) {
      ctx.ui.notify(
        `${definition.agentName} model selected: ${getChildAgentModelChoiceLabel(option)}\nactive child model selector: ${getModelSelector(currentConfig)}`,
        "info",
      );
    }
  };

  const run = async (options: {
    readonly ctx: ExtensionContext;
    readonly onProgress?: (progress: ChildAgentProgress) => void;
    readonly pi: ExtensionAPI;
    readonly signal?: AbortSignal | undefined;
    readonly task: string;
    readonly tools?: readonly string[] | undefined;
  }): Promise<StandaloneAgentRunResult<Decision>> => {
    if (options.tools !== undefined && options.tools.length === 0) {
      throw new Error(`${definition.agentName} per-run tools override must not be empty`);
    }
    const activeConfig = readActiveConfig(options.ctx.cwd);
    currentConfig = activeConfig;
    const config: ChildPiAgentConfig = options.tools === undefined
      ? activeConfig
      : { ...activeConfig, tools: options.tools };
    registerProvider(options.pi, config);

    const result = await runChildPiAgent({
      buildPrompt: definition.buildPrompt,
      config,
      defaultCwd: options.ctx.cwd,
      excludeTools: definition.excludeTools,
      onProgress: options.onProgress,
      signal: options.signal,
      task: options.task,
    });
    const decision = definition.parseDecision(result.output);
    const parseError = decision ? undefined : definition.parseErrorMessage;
    const report = definition.formatReport({ config, decision, parseError, result });

    return { config, decision, ...(parseError ? { parseError } : {}), report, result };
  };

  const sendReportMessage = (pi: ExtensionAPI, ctx: ExtensionContext, runResult: StandaloneAgentRunResult<Decision>): void => {
    sendChildAgentReportMessage({
      config: runResult.config,
      ctx,
      messageType: definition.messageType,
      pi,
      report: runResult.report,
      result: runResult.result,
    });
  };

  const formatStatus = (): string => [
    definition.displayName,
    `Model: ${getModelSelector(currentConfig)}`,
    `Config: ${formatChildAgentConfig(currentConfig, definition.configFilePath)}`,
    formatModelSelection(),
    `Commands: ${definition.commandUsage}`,
  ].join("\n");

  const register = (pi: ExtensionAPI): void => {
    reloadSettings(pi, process.cwd());

    pi.on("session_start", (_event, ctx) => {
      restoreState(pi, ctx);
      notifyConfigErrorIfNeeded(ctx);
    });

    pi.on("session_tree", (_event, ctx) => {
      restoreState(pi, ctx);
      notifyConfigErrorIfNeeded(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      ctx.ui.setStatus(definition.agentName, undefined);
    });

    pi.registerMessageRenderer(definition.messageType, (message, options, theme) =>
      renderChildAgentMessage(message, options.expanded, theme, { agentName: definition.agentName }),
    );

    pi.registerCommand(definition.agentName, {
      description: definition.commandDescription,
      getArgumentCompletions: (prefix) => {
        const trimmed = prefix.trimStart();
        const hasTrailingSpace = /\s$/u.test(prefix);
        const parts = trimmed ? trimmed.split(/\s+/u) : [];
        const [first = "", ...rest] = parts;
        const normalizedFirst = first.toLowerCase();

        if (normalizedFirst === "model" && (trimmed.includes(" ") || hasTrailingSpace)) {
          const modelPrefix = hasTrailingSpace ? "" : rest.join(" ");
          return getChildAgentModelCompletions(currentModelOptions, modelPrefix);
        }

        if (trimmed.includes(" ") || hasTrailingSpace) return null;

        const commands = definition.allowCommandRun === false
          ? ["model", "config", "status"]
          : ["model", "ask", "config", "status"];
        return commands
          .filter((item) => item.startsWith(normalizedFirst))
          .map((value) => ({ value, label: value }));
      },
      handler: async (args, ctx) => {
        const trimmed = args.trim();
        const [command = "status", ...rest] = trimmed.split(/\s+/u);
        const normalized = command.toLowerCase();

        if (!trimmed || normalized === "status") {
          reloadSettings(pi, ctx.cwd);
          ctx.ui.notify(formatStatus(), "info");
          notifyConfigErrorIfNeeded(ctx);
          return;
        }

        if (normalized === "config") {
          reloadSettings(pi, ctx.cwd);
          ctx.ui.notify(
            `${definition.agentName} config:\n${formatChildAgentConfig(currentConfig, definition.configFilePath)}\n${formatModelSelection()}`,
            "info",
          );
          notifyConfigErrorIfNeeded(ctx);
          return;
        }

        if (normalized === "model" || normalized === "models") {
          await selectModel(pi, ctx, rest.join(" "));
          notifyConfigErrorIfNeeded(ctx);
          return;
        }

        const task = normalized === "ask" ? rest.join(" ").trim() : trimmed;
        if (!task) {
          ctx.ui.notify(`Usage: ${definition.commandUsage}`, "warning");
          return;
        }
        if (definition.allowCommandRun === false) {
          ctx.ui.notify(
            `${definition.displayName} execution is parent-tool only. Provide a validated implementation document through the ${definition.agentName} tool.`,
            "warning",
          );
          return;
        }

        const config = readActiveConfig(ctx.cwd);
        registerProvider(pi, config);
        const model = getModelSelector(config);
        ctx.ui.setStatus(definition.agentName, `running ${model}: ${previewTask(task)}`);

        try {
          const runResult = await run({
            ctx,
            onProgress: (progress) => {
              const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
              ctx.ui.setStatus(
                definition.agentName,
                `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
              );
            },
            pi,
            task,
          });
          sendReportMessage(pi, ctx, runResult);
          const level = runResult.result.status === "completed" && runResult.decision ? "info" : "warning";
          ctx.ui.notify(`${definition.agentName} ${runResult.result.status}; report added to main context`, level);
        } catch (error) {
          ctx.ui.notify(`${definition.agentName} failed: ${getErrorMessage(error)}`, "error");
        } finally {
          ctx.ui.setStatus(definition.agentName, undefined);
        }
      },
    });
  };

  return {
    formatModelSelection,
    getActiveModelSelector,
    readActiveConfig,
    register,
    registerProvider,
    reloadSettings,
    run,
    selectModel,
    sendReportMessage,
  };
}
