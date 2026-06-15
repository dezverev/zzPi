import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import {
  getPositiveIntegerField,
  getStringArrayField,
  getStringField,
  readJsoncConfig,
} from "./jsonc-config.ts";

export const CHILD_PI_AGENT_ENV = "PI_CHILD_PI_AGENT";
export const DEFAULT_LOCAL_MODEL_ENDPOINTS_CONFIG_FILE_PATH =
  ".pi/extensions/local-model-endpoints.config.jsonc";
export const LOCAL_MODEL_ENDPOINTS_CONFIG_FILE_PATH = DEFAULT_LOCAL_MODEL_ENDPOINTS_CONFIG_FILE_PATH;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const MAX_STDERR_CHARS = 8_000;
const MAX_STATUS_TASK_CHARS = 70;
const MAX_TOOL_SUMMARY_ITEMS = 30;

type ChildAgentMessage = Parameters<MessageRenderer>[0];
export type ChildAgentTheme = Parameters<MessageRenderer>[2];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type RunStatus = "completed" | "failed" | "aborted" | "timeout";
export type ChildAgentProviderRegistration = "openai-compatible" | "none";

export interface ChildPiAgentConfig {
  readonly contextWindow: number;
  readonly endpoint: string;
  readonly endpointSource?: string;
  readonly maxOutputTokens: number;
  readonly model: string;
  readonly modelSelector?: string;
  readonly provider: string;
  readonly providerRegistration?: ChildAgentProviderRegistration;
  readonly reportMaxChars: number;
  readonly requestTimeoutMs: number;
  readonly systemPrompt: string;
  readonly thinking: ThinkingLevel;
  readonly tools: readonly string[];
}

export interface ChildPiAgentConfigInput extends Omit<
  ChildPiAgentConfig,
  "modelSelector" | "providerRegistration" | "thinking"
> {
  readonly modelSelector?: string | undefined;
  readonly providerRegistration?: string | undefined;
  readonly thinking: string;
}

export interface UsageStats {
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  estimatedInput: number;
  estimatedOutput: number;
  estimatedTotal: number;
  input: number;
  output: number;
  totalTokens: number;
  turns: number;
}

export interface ToolCallSummary {
  args: unknown;
  id: string;
  isError?: boolean;
  name: string;
  status: "running" | "done";
}

interface SharedLocalEndpointSelection {
  readonly contextWindow?: number;
  readonly endpoint: string;
  readonly maxOutputTokens?: number;
  readonly model?: string;
  readonly modelSelector?: string;
  readonly provider?: string;
  readonly providerRegistration?: ChildAgentProviderRegistration;
  readonly source: string;
  readonly thinking?: string;
}

interface StringConfigFieldSelection {
  readonly field: string;
  readonly value: string;
}

interface CapturedMessage {
  content: unknown;
  errorMessage?: string;
  model?: string;
  role: string;
  stopReason?: string;
  usage?: unknown;
}

export interface ChildAgentRunResult {
  durationMs: number;
  errorMessage?: string;
  exitCode: number;
  model?: string;
  output: string;
  rawOutput: string;
  status: RunStatus;
  stderr: string;
  stopReason?: string;
  task: string;
  toolCalls: ToolCallSummary[];
  usage: UsageStats;
}

export interface ChildAgentProgress {
  readonly activeToolCalls?: readonly ToolCallSummary[];
  readonly latestOutputChars: number;
  readonly runningTools: number;
  readonly toolCalls: number;
  readonly turns: number;
}

interface NormalizeConfigOptions {
  readonly agentName: string;
  readonly defaultSystemPrompt: string;
}

export interface ReadChildPiAgentConfigOptions {
  readonly agentName: string;
  readonly configFilePath: string;
  readonly cwd: string;
  readonly defaults: ChildPiAgentConfig;
  readonly localModelEndpointsConfigFilePath?: string;
}

export interface ChildPiAgentConfigReadResult {
  readonly config: ChildPiAgentConfig;
  readonly error?: string;
}

export interface ChildPiAgentProviderOptions {
  readonly modelDisplaySuffix?: string;
  readonly providerDisplayName?: string;
}

export interface RunChildPiAgentOptions {
  readonly buildPrompt?: (task: string) => string;
  readonly childEnv?: Readonly<Record<string, string | undefined>>;
  readonly config: ChildPiAgentConfig;
  readonly cwd?: string | undefined;
  readonly defaultCwd: string;
  readonly excludeTools?: readonly string[];
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly signal?: AbortSignal | undefined;
  readonly task: string;
}

export interface ChildAgentReportOptions {
  readonly title: string;
}

export interface RenderChildAgentOptions {
  readonly agentName: string;
}

export interface SendChildAgentReportMessageOptions {
  readonly config: ChildPiAgentConfig;
  readonly ctx: ExtensionContext;
  readonly messageType: string;
  readonly pi: ExtensionAPI;
  readonly report: string;
  readonly result: ChildAgentRunResult;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeBaseUrl(baseUrl: string, agentName: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  if (!trimmed) throw new Error(`${agentName} endpoint cannot be empty.`);

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${agentName} endpoint is invalid: ${baseUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${agentName} endpoint must start with http:// or https://.`);
  }

  if (parsed.search || parsed.hash) {
    throw new Error(`${agentName} endpoint must not include a query string or hash.`);
  }

  return trimmed;
}

export function getOpenAiBaseUrl(endpoint: string): string {
  if (endpoint.endsWith("/v1/chat/completions")) {
    return endpoint.slice(0, -"/chat/completions".length);
  }

  if (endpoint.endsWith("/v1")) return endpoint;
  return `${endpoint}/v1`;
}

function getFirstStringConfigField(
  record: Record<string, unknown>,
  fields: readonly string[],
): StringConfigFieldSelection | undefined {
  for (const field of fields) {
    const value = getStringField(record, field);
    if (value !== undefined) return { field, value };
  }

  return undefined;
}

type SharedLocalEndpointMode = "remoteLocal" | "trueLocal" | "trueRemote";

function normalizeLocalEndpointMode(
  rawMode: string,
  localModelEndpointsConfigFilePath: string,
): SharedLocalEndpointMode {
  const mode = rawMode.trim().toLowerCase();
  if (
    mode === "truelocal" ||
    mode === "true-local" ||
    mode === "true_local" ||
    mode === "localhost" ||
    mode === "loopback"
  ) {
    return "trueLocal";
  }

  if (
    mode === "remotelocal" ||
    mode === "remote-local" ||
    mode === "remote_local" ||
    mode === "local" ||
    mode === "localnetwork" ||
    mode === "local-network" ||
    mode === "lan"
  ) {
    return "remoteLocal";
  }

  if (
    mode === "trueremote" ||
    mode === "true-remote" ||
    mode === "true_remote" ||
    mode === "remote" ||
    mode === "cloud"
  ) {
    return "trueRemote";
  }

  throw new Error(
    `${localModelEndpointsConfigFilePath} active must be "remoteLocal", "trueLocal", or "trueRemote".`,
  );
}

function getRemoteModelSelector(record: Record<string, unknown>): StringConfigFieldSelection | undefined {
  return getFirstStringConfigField(record, ["trueRemoteModelSelector", "remoteModelSelector"]);
}

function readSharedLocalEndpointSelection(
  cwd: string,
  defaults: ChildPiAgentConfig,
  localModelEndpointsConfigFilePath: string,
): SharedLocalEndpointSelection | undefined {
  const record = readJsoncConfig(localModelEndpointsConfigFilePath, cwd);
  if (!record) return undefined;

  const rawMode =
    getFirstStringConfigField(record, ["active", "mode", "current", "endpointMode"])?.value ??
    "remoteLocal";
  const mode = normalizeLocalEndpointMode(rawMode, localModelEndpointsConfigFilePath);

  if (mode === "trueRemote") {
    const provider = getFirstStringConfigField(record, ["trueRemoteProvider", "remoteProvider"]);
    const model = getFirstStringConfigField(record, ["trueRemoteModel", "remoteModel"]);
    const modelSelector = getRemoteModelSelector(record);
    const contextWindow =
      getPositiveIntegerField(record, "trueRemoteContextWindow") ??
      getPositiveIntegerField(record, "remoteContextWindow");
    const maxOutputTokens =
      getPositiveIntegerField(record, "trueRemoteMaxOutputTokens") ??
      getPositiveIntegerField(record, "remoteMaxOutputTokens");

    return {
      ...(contextWindow ? { contextWindow } : {}),
      endpoint: defaults.endpoint,
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      model: model?.value ?? defaults.model,
      ...(modelSelector?.value ? { modelSelector: modelSelector.value } : {}),
      provider: provider?.value ?? defaults.provider,
      providerRegistration: "none",
      source: `${localModelEndpointsConfigFilePath} active=${mode} remote model`,
      thinking:
        getFirstStringConfigField(record, ["trueRemoteThinking", "remoteThinking"])?.value ??
        defaults.thinking,
    };
  }

  const endpointField = getFirstStringConfigField(
    record,
    mode === "trueLocal"
      ? ["trueLocalEndpoint", "localEndpoint"]
      : ["remoteLocalEndpoint", "lanEndpoint", "localNetworkEndpoint", "remoteEndpoint"],
  );

  if (!endpointField) {
    const expected =
      mode === "trueLocal"
        ? "trueLocalEndpoint/localEndpoint"
        : "remoteLocalEndpoint/lanEndpoint/localNetworkEndpoint/remoteEndpoint";
    throw new Error(`${localModelEndpointsConfigFilePath} must define ${expected}.`);
  }

  return {
    endpoint: normalizeBaseUrl(
      endpointField.value,
      `${localModelEndpointsConfigFilePath} ${endpointField.field}`,
    ),
    source: `${localModelEndpointsConfigFilePath} active=${mode} field=${endpointField.field}`,
  };
}

function getDefaultEndpointSelection(
  options: ReadChildPiAgentConfigOptions,
): SharedLocalEndpointSelection {
  const localModelEndpointsConfigFilePath =
    options.localModelEndpointsConfigFilePath ?? LOCAL_MODEL_ENDPOINTS_CONFIG_FILE_PATH;
  return (
    readSharedLocalEndpointSelection(
      options.cwd,
      options.defaults,
      localModelEndpointsConfigFilePath,
    ) ?? {
      endpoint: options.defaults.endpoint,
      source: "agent default",
    }
  );
}

function getEndpointOverride(
  record: Record<string, unknown>,
): StringConfigFieldSelection | undefined {
  return getFirstStringConfigField(record, ["endpoint", "baseUrl", "url"]);
}

export function normalizeNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty.`);
  return trimmed;
}

export function normalizeThinking(value: string, agentName: string): ThinkingLevel {
  const trimmed = value.trim().toLowerCase();
  if (THINKING_LEVELS.includes(trimmed as ThinkingLevel)) return trimmed as ThinkingLevel;
  throw new Error(`${agentName} thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
}

export function normalizeTools(tools: readonly string[]): readonly string[] {
  return Array.from(new Set(tools.map((tool) => tool.trim()).filter(Boolean)));
}

function normalizeProviderRegistration(
  value: string | undefined,
  agentName: string,
): ChildAgentProviderRegistration {
  const normalized = (value ?? "openai-compatible").trim().toLowerCase();
  if (
    normalized === "openai-compatible" ||
    normalized === "openai" ||
    normalized === "local" ||
    normalized === "register"
  ) {
    return "openai-compatible";
  }
  if (normalized === "none" || normalized === "skip" || normalized === "existing") return "none";
  throw new Error(`${agentName} providerRegistration must be "openai-compatible" or "none".`);
}

export function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

export function normalizeChildPiAgentConfig(
  config: ChildPiAgentConfigInput,
  options: NormalizeConfigOptions,
): ChildPiAgentConfig {
  const endpoint = normalizeBaseUrl(config.endpoint, options.agentName);
  const endpointSource = config.endpointSource?.trim();
  const modelSelector = config.modelSelector?.trim();
  const providerRegistration = normalizeProviderRegistration(
    config.providerRegistration,
    options.agentName,
  );

  return {
    contextWindow: normalizePositiveInteger(
      config.contextWindow,
      `${options.agentName} contextWindow`,
    ),
    endpoint,
    ...(endpointSource ? { endpointSource } : {}),
    maxOutputTokens: normalizePositiveInteger(
      config.maxOutputTokens,
      `${options.agentName} maxOutputTokens`,
    ),
    model: normalizeNonEmpty(config.model, `${options.agentName} model`),
    ...(modelSelector ? { modelSelector } : {}),
    provider: normalizeNonEmpty(config.provider, `${options.agentName} provider`),
    providerRegistration,
    reportMaxChars: normalizePositiveInteger(
      config.reportMaxChars,
      `${options.agentName} reportMaxChars`,
    ),
    requestTimeoutMs: normalizePositiveInteger(
      config.requestTimeoutMs,
      `${options.agentName} requestTimeoutMs`,
    ),
    systemPrompt: config.systemPrompt.trim() || options.defaultSystemPrompt,
    thinking: normalizeThinking(config.thinking, options.agentName),
    tools: normalizeTools(config.tools),
  };
}

export function readChildPiAgentConfig(
  options: ReadChildPiAgentConfigOptions,
): ChildPiAgentConfigReadResult {
  const normalizeOptions = {
    agentName: options.agentName,
    defaultSystemPrompt: options.defaults.systemPrompt,
  };

  try {
    const record = readJsoncConfig(options.configFilePath, options.cwd);

    if (!record) {
      const endpointSelection = getDefaultEndpointSelection(options);

      return {
        config: normalizeChildPiAgentConfig(
          {
            ...options.defaults,
            ...(endpointSelection.contextWindow
              ? { contextWindow: endpointSelection.contextWindow }
              : {}),
            endpoint: endpointSelection.endpoint,
            endpointSource: endpointSelection.source,
            ...(endpointSelection.maxOutputTokens
              ? { maxOutputTokens: endpointSelection.maxOutputTokens }
              : {}),
            ...(endpointSelection.model ? { model: endpointSelection.model } : {}),
            ...(endpointSelection.modelSelector
              ? { modelSelector: endpointSelection.modelSelector }
              : {}),
            ...(endpointSelection.provider ? { provider: endpointSelection.provider } : {}),
            ...(endpointSelection.providerRegistration
              ? { providerRegistration: endpointSelection.providerRegistration }
              : {}),
            ...(endpointSelection.thinking ? { thinking: endpointSelection.thinking } : {}),
          },
          normalizeOptions,
        ),
      };
    }

    const endpointOverride = getEndpointOverride(record);
    const endpointSelection = endpointOverride
      ? {
          endpoint: endpointOverride.value,
          source: `${options.configFilePath} ${endpointOverride.field}`,
        }
      : getDefaultEndpointSelection(options);

    return {
      config: normalizeChildPiAgentConfig(
        {
          contextWindow:
            endpointSelection.contextWindow ??
            getPositiveIntegerField(record, "contextWindow") ??
            options.defaults.contextWindow,
          endpoint: endpointSelection.endpoint,
          endpointSource: endpointSelection.source,
          maxOutputTokens:
            endpointSelection.maxOutputTokens ??
            getPositiveIntegerField(record, "maxOutputTokens") ??
            options.defaults.maxOutputTokens,
          model: endpointSelection.model ?? getStringField(record, "model") ?? options.defaults.model,
          modelSelector: endpointSelection.modelSelector ?? getStringField(record, "modelSelector"),
          provider:
            endpointSelection.provider ?? getStringField(record, "provider") ?? options.defaults.provider,
          providerRegistration:
            endpointSelection.providerRegistration ?? getStringField(record, "providerRegistration"),
          reportMaxChars:
            getPositiveIntegerField(record, "reportMaxChars") ?? options.defaults.reportMaxChars,
          requestTimeoutMs:
            getPositiveIntegerField(record, "requestTimeoutMs") ??
            options.defaults.requestTimeoutMs,
          systemPrompt: getStringField(record, "systemPrompt") ?? options.defaults.systemPrompt,
          thinking:
            endpointSelection.thinking ?? getStringField(record, "thinking") ?? options.defaults.thinking,
          tools: getStringArrayField(record, "tools") ?? options.defaults.tools,
        },
        normalizeOptions,
      ),
    };
  } catch (error) {
    return {
      config: normalizeChildPiAgentConfig({ ...options.defaults }, normalizeOptions),
      error: getErrorMessage(error),
    };
  }
}

export function getModelSelector(config: ChildPiAgentConfig): string {
  return config.modelSelector ?? `${config.provider}/${config.model}`;
}

export function registerChildAgentProvider(
  pi: ExtensionAPI,
  config: ChildPiAgentConfig,
  options: ChildPiAgentProviderOptions = {},
): void {
  if (config.providerRegistration === "none") return;

  pi.registerProvider(config.provider, {
    name: options.providerDisplayName ?? config.provider,
    baseUrl: getOpenAiBaseUrl(config.endpoint),
    api: "openai-completions",
    apiKey: "lm-studio",
    models: [
      {
        id: config.model,
        name: `${config.model}${options.modelDisplaySuffix ?? ""}`,
        reasoning: false,
        input: ["text"],
        contextWindow: config.contextWindow,
        maxTokens: config.maxOutputTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStrictMode: false,
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
  });
}

export function getPiInvocation(args: readonly string[]): { args: string[]; command: string } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/u.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args: [...args] };

  return { command: "pi", args: [...args] };
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is { readonly text: string; readonly type: "text" } => {
      return isRecord(block) && block.type === "text" && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

function getMessageFromEvent(event: Record<string, unknown>): CapturedMessage | undefined {
  const { message } = event;
  if (!isRecord(message) || typeof message.role !== "string") return undefined;

  const captured: CapturedMessage = {
    content: message.content,
    role: message.role,
  };

  if (typeof message.model === "string") captured.model = message.model;
  if (typeof message.stopReason === "string") captured.stopReason = message.stopReason;
  if (typeof message.errorMessage === "string") captured.errorMessage = message.errorMessage;
  if (message.usage !== undefined) captured.usage = message.usage;

  return captured;
}

function updateUsage(stats: UsageStats, usage: unknown): void {
  if (!isRecord(usage)) return;

  const input = usage.input;
  const output = usage.output;
  const cacheRead = usage.cacheRead;
  const cacheWrite = usage.cacheWrite;
  const totalTokens = usage.totalTokens;
  const cost = isRecord(usage.cost) ? usage.cost.total : undefined;

  if (typeof input === "number") stats.input += input;
  if (typeof output === "number") stats.output += output;
  if (typeof cacheRead === "number") stats.cacheRead += cacheRead;
  if (typeof cacheWrite === "number") stats.cacheWrite += cacheWrite;
  if (typeof totalTokens === "number") stats.totalTokens = totalTokens;
  if (typeof cost === "number") stats.cost += cost;
}

function stringifyForTokenEstimate(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable value]";
  }
}

function contentForTokenEstimate(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyForTokenEstimate(content);

  return content
    .map((block) => {
      if (!isRecord(block)) return stringifyForTokenEstimate(block);
      if (typeof block.text === "string") return block.text;

      const name = typeof block.name === "string" ? block.name : "";
      const args = stringifyForTokenEstimate(block.arguments);
      const preview = `${name} ${args}`.trim();
      return preview || stringifyForTokenEstimate(block);
    })
    .filter(Boolean)
    .join("\n");
}

function estimateTokenCount(text: string): number {
  const chars = text.trim().length;
  if (chars === 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

function updateEstimatedUsage(
  stats: UsageStats,
  messages: readonly CapturedMessage[],
  prompt: string,
): void {
  let estimatedInput = 0;
  let estimatedOutput = 0;
  let sawUserMessage = false;

  for (const message of messages) {
    const tokens = estimateTokenCount(contentForTokenEstimate(message.content));
    if (message.role === "assistant") {
      estimatedOutput += tokens;
    } else {
      estimatedInput += tokens;
      if (message.role === "user") sawUserMessage = true;
    }
  }

  if (!sawUserMessage) estimatedInput += estimateTokenCount(prompt);

  stats.estimatedInput = estimatedInput;
  stats.estimatedOutput = estimatedOutput;
  stats.estimatedTotal = estimatedInput + estimatedOutput;
}

function getFinalAssistantOutput(messages: readonly CapturedMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      const text = textFromContent(message.content).trim();
      if (text) return text;
    }
  }

  return "";
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const omitted = text.length - maxChars;
  const headChars = Math.max(1, Math.floor(maxChars * 0.65));
  const tailChars = Math.max(1, maxChars - headChars - 120);
  return `${text.slice(0, headChars)}\n\n[… ${omitted} characters omitted …]\n\n${text.slice(-tailChars)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

function formatTokenCount(count: number): string {
  return Math.round(count).toLocaleString("en-US");
}

function hasReportedTokenUsage(usage: UsageStats): boolean {
  return (
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.totalTokens > 0
  );
}

function formatReportedTokenUsage(usage: UsageStats): string {
  const parts: string[] = [];
  if (usage.input > 0) parts.push(`input ${formatTokenCount(usage.input)}`);
  if (usage.output > 0) parts.push(`output ${formatTokenCount(usage.output)}`);
  if (usage.cacheRead > 0) parts.push(`cache read ${formatTokenCount(usage.cacheRead)}`);
  if (usage.cacheWrite > 0) parts.push(`cache write ${formatTokenCount(usage.cacheWrite)}`);
  if (usage.totalTokens > 0) parts.push(`last ctx ${formatTokenCount(usage.totalTokens)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(", ");
}

function formatEstimatedTokenUsage(usage: UsageStats): string {
  if (usage.estimatedTotal <= 0) return "estimate unavailable";

  return `captured exchange estimate ~${formatTokenCount(usage.estimatedTotal)} tokens (input-ish ~${formatTokenCount(usage.estimatedInput)}, output-ish ~${formatTokenCount(usage.estimatedOutput)})`;
}

export function formatUsage(usage: UsageStats): string {
  const parts: string[] = [];
  if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  parts.push(
    hasReportedTokenUsage(usage)
      ? `reported ${formatReportedTokenUsage(usage)}`
      : "reported tokens unavailable",
  );
  parts.push(formatEstimatedTokenUsage(usage));
  return parts.join("; ");
}

export function summarizeToolCalls(toolCalls: readonly ToolCallSummary[]): string {
  if (toolCalls.length === 0) return "none";

  const counts = new Map<string, number>();
  for (const call of toolCalls) {
    const suffix = call.isError ? " failed" : "";
    const key = `${call.name}${suffix}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, count]) => `${name} ×${count}`)
    .join(", ");
}

export function formatToolCallDetails(toolCalls: readonly ToolCallSummary[]): string {
  if (toolCalls.length === 0) return "- none";

  const lines = toolCalls.slice(0, MAX_TOOL_SUMMARY_ITEMS).map((call, index) => {
    const status = call.isError ? "failed" : call.status;
    const args = JSON.stringify(call.args);
    const preview = args && args.length > 180 ? `${args.slice(0, 180)}…` : args;
    return `- ${index + 1}. ${call.name} (${status})${preview ? `: ${preview}` : ""}`;
  });

  if (toolCalls.length > MAX_TOOL_SUMMARY_ITEMS) {
    lines.push(`- … ${toolCalls.length - MAX_TOOL_SUMMARY_ITEMS} more tool call(s)`);
  }

  return lines.join("\n");
}

export function buildDefaultChildPrompt(task: string, commandName: string): string {
  return [
    `You are running as the child process for the parent Pi /${commandName} command.`,
    "Complete the delegated task to the best of your ability, then stop.",
    "If you change files, include exact repo-relative paths in the final report.",
    `Delegated task:\n${task}`,
  ].join("\n\n");
}

function buildChildArgs(
  config: ChildPiAgentConfig,
  prompt: string,
  excludeTools: readonly string[],
): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    getModelSelector(config),
    "--thinking",
    config.thinking,
  ];

  if (excludeTools.length > 0) args.push("--exclude-tools", excludeTools.join(","));
  if (config.tools.length > 0) args.push("--tools", config.tools.join(","));
  if (config.systemPrompt.trim()) args.push("--append-system-prompt", config.systemPrompt);

  args.push(prompt);
  return args;
}

function parseToolCallStart(event: Record<string, unknown>): ToolCallSummary | undefined {
  if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return undefined;

  return {
    args: event.args,
    id: event.toolCallId,
    name: event.toolName,
    status: "running",
  };
}

function applyToolCallEnd(toolCalls: ToolCallSummary[], event: Record<string, unknown>): void {
  if (typeof event.toolCallId !== "string") return;

  const call = toolCalls.find((item) => item.id === event.toolCallId);
  if (!call) return;

  call.status = "done";
  if (typeof event.isError === "boolean") call.isError = event.isError;
}

export async function runChildPiAgent(
  options: RunChildPiAgentOptions,
): Promise<ChildAgentRunResult> {
  const startedAt = Date.now();
  const messages: CapturedMessage[] = [];
  const toolCalls: ToolCallSummary[] = [];
  const usage: UsageStats = {
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
  let stderr = "";
  let stdoutBuffer = "";
  let lastStopReason: string | undefined;
  let lastErrorMessage: string | undefined;
  let model: string | undefined;
  let timedOut = false;
  let aborted = false;
  let spawnError: string | undefined;

  const emitProgress = () => {
    options.onProgress?.({
      activeToolCalls: [...toolCalls],
      latestOutputChars: getFinalAssistantOutput(messages).length,
      runningTools: toolCalls.filter((call) => call.status === "running").length,
      toolCalls: toolCalls.length,
      turns: usage.turns,
    });
  };

  const processLine = (line: string): void => {
    if (!line.trim()) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }

    if (!isRecord(parsed) || typeof parsed.type !== "string") return;

    if (parsed.type === "tool_execution_start") {
      const toolCall = parseToolCallStart(parsed);
      if (toolCall) toolCalls.push(toolCall);
      emitProgress();
      return;
    }

    if (parsed.type === "tool_execution_end") {
      applyToolCallEnd(toolCalls, parsed);
      emitProgress();
      return;
    }

    if (parsed.type !== "message_end") return;

    const message = getMessageFromEvent(parsed);
    if (!message) return;

    messages.push(message);
    if (message.role === "assistant") {
      usage.turns += 1;
      updateUsage(usage, message.usage);
      if (message.model) model = message.model;
      if (message.stopReason) lastStopReason = message.stopReason;
      if (message.errorMessage) lastErrorMessage = message.errorMessage;
    }

    emitProgress();
  };

  const prompt =
    options.buildPrompt?.(options.task) ?? buildDefaultChildPrompt(options.task, "agent");
  const childArgs = buildChildArgs(options.config, prompt, options.excludeTools ?? []);
  const invocation = getPiInvocation(childArgs);

  const exitCode = await new Promise<number>((resolvePromise) => {
    let resolved = false;
    const finish = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolvePromise(code);
    };

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [CHILD_PI_AGENT_ENV]: "1",
    };
    for (const [key, value] of Object.entries(options.childEnv ?? {})) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }

    const proc = spawn(invocation.command, invocation.args, {
      cwd: options.cwd ?? options.defaultCwd,
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killProc = (nextStatus: "aborted" | "timeout") => {
      if (nextStatus === "aborted") aborted = true;
      else timedOut = true;

      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5_000).unref();
    };

    const timeoutId = setTimeout(() => killProc("timeout"), options.config.requestTimeoutMs);
    timeoutId.unref();

    const abortListener = () => killProc("aborted");
    if (options.signal?.aborted) abortListener();
    else options.signal?.addEventListener("abort", abortListener, { once: true });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_STDERR_CHARS * 2) stderr = stderr.slice(-MAX_STDERR_CHARS);
    });

    proc.on("error", (error) => {
      spawnError = getErrorMessage(error);
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abortListener);
      finish(1);
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abortListener);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      finish(code ?? 0);
    });
  });

  updateEstimatedUsage(usage, messages, prompt);

  const rawOutput = getFinalAssistantOutput(messages);
  const output = rawOutput || lastErrorMessage || stderr.trim() || "(no output)";
  const status: RunStatus = timedOut
    ? "timeout"
    : aborted || lastStopReason === "aborted"
      ? "aborted"
      : exitCode === 0 && lastStopReason !== "error" && !spawnError
        ? "completed"
        : "failed";

  const result: ChildAgentRunResult = {
    durationMs: Date.now() - startedAt,
    exitCode,
    output,
    rawOutput,
    status,
    stderr: truncateText(stderr.trim(), MAX_STDERR_CHARS),
    task: options.task,
    toolCalls,
    usage,
  };

  const errorMessage = spawnError ?? lastErrorMessage;
  if (errorMessage) result.errorMessage = errorMessage;
  if (model) result.model = model;
  if (lastStopReason) result.stopReason = lastStopReason;

  return result;
}

export function formatChildAgentReport(
  result: ChildAgentRunResult,
  config: ChildPiAgentConfig,
  options: ChildAgentReportOptions,
): string {
  const model = result.model ?? getModelSelector(config);
  const task = truncateText(result.task, 2_000);
  const outputBudget = Math.max(1_000, config.reportMaxChars - task.length - 2_500);
  const output = truncateText(result.output, outputBudget);

  const lines = [
    `# ${options.title}`,
    "",
    output,
    "",
    "## Run info",
    "",
    `- Status: ${result.status}`,
    `- Model: ${model}`,
    `- Duration: ${formatDuration(result.durationMs)}`,
    `- Tools: ${summarizeToolCalls(result.toolCalls)}`,
  ];

  if (result.stopReason) lines.push(`- Stop reason: ${result.stopReason}`);
  if (result.errorMessage) lines.push(`- Error: ${result.errorMessage}`);
  if (result.exitCode !== 0) lines.push(`- Exit code: ${result.exitCode}`);

  lines.push("", "## Delegated task", "", task);

  if (result.stderr) lines.push("", "## Stderr", "", "```text", result.stderr, "```");

  return truncateText(lines.join("\n"), config.reportMaxChars);
}

export function formatChildAgentConfig(config: ChildPiAgentConfig, configFilePath: string): string {
  return [
    `config file: ${configFilePath}`,
    `endpoint: ${config.endpoint}`,
    ...(config.endpointSource ? [`endpoint source: ${config.endpointSource}`] : []),
    `provider registration: ${config.providerRegistration === "none" ? "none (uses Pi's configured provider/auth)" : `openai-compatible at ${getOpenAiBaseUrl(config.endpoint)}`}`,
    `provider: ${config.provider}`,
    `model: ${config.model}`,
    `child model selector: ${getModelSelector(config)}`,
    `tools: ${config.tools.join(", ") || "Pi defaults"}`,
    `limits: timeout ${config.requestTimeoutMs}ms, context ${config.contextWindow}, max output ${config.maxOutputTokens}, report ${config.reportMaxChars} chars`,
    `thinking: ${config.thinking}`,
  ].join("\n");
}

export function previewTask(task: string): string {
  const compact = task.replace(/\s+/gu, " ").trim();
  if (compact.length <= MAX_STATUS_TASK_CHARS) return compact;
  return `${compact.slice(0, MAX_STATUS_TASK_CHARS)}…`;
}

export function getChildAgentResultDetails(
  result: ChildAgentRunResult,
  config: ChildPiAgentConfig,
): Record<string, unknown> {
  return {
    ...result,
    model: result.model ?? getModelSelector(config),
  };
}

export function sendChildAgentReportMessage(options: SendChildAgentReportMessageOptions): void {
  options.pi.sendMessage(
    {
      customType: options.messageType,
      content: options.report,
      display: true,
      details: getChildAgentResultDetails(options.result, options.config),
    },
    options.ctx.isIdle() ? undefined : { deliverAs: "followUp" },
  );
}

function getContentText(content: unknown): string {
  return textFromContent(content);
}

export function getUsageFromDetails(details: unknown): UsageStats | undefined {
  if (!isRecord(details) || !isRecord(details.usage)) return undefined;

  const usage = details.usage;
  const required = [
    "cacheRead",
    "cacheWrite",
    "cost",
    "estimatedInput",
    "estimatedOutput",
    "estimatedTotal",
    "input",
    "output",
    "totalTokens",
    "turns",
  ];

  if (required.some((key) => typeof usage[key] !== "number")) return undefined;
  return usage as unknown as UsageStats;
}

export function getToolCallsFromDetails(details: unknown): readonly ToolCallSummary[] {
  if (!isRecord(details) || !Array.isArray(details.toolCalls)) return [];

  return details.toolCalls.filter((call): call is ToolCallSummary => {
    return (
      isRecord(call) &&
      typeof call.id === "string" &&
      typeof call.name === "string" &&
      (call.status === "running" || call.status === "done")
    );
  });
}

export function renderStoredToolHistory(
  details: unknown,
  expanded: boolean,
  theme: ChildAgentTheme,
): Container | undefined {
  const toolCalls = getToolCallsFromDetails(details);
  if (toolCalls.length === 0) return undefined;

  const container = new Container();
  container.addChild(
    new Text(
      theme.fg(
        "muted",
        expanded
          ? "stored tool-call history (not included in model-visible response):"
          : `stored tool-call history: ${toolCalls.length} call${toolCalls.length === 1 ? "" : "s"} (Ctrl+O to expand)`,
      ),
      0,
      0,
    ),
  );

  if (expanded) {
    container.addChild(new Text(theme.fg("dim", formatToolCallDetails(toolCalls)), 0, 0));
  }

  return container;
}

export function renderTokenFooter(
  usage: UsageStats | undefined,
  theme: ChildAgentTheme,
): Text | undefined {
  if (!usage) return undefined;
  return new Text(theme.fg("dim", `tokens: ${formatUsage(usage)}`), 0, 0);
}

export function renderChildAgentMessage(
  message: ChildAgentMessage,
  expanded: boolean,
  theme: ChildAgentTheme,
  options: RenderChildAgentOptions,
) {
  const details = isRecord(message.details) ? message.details : undefined;
  const status = typeof details?.status === "string" ? details.status : "completed";
  const model = typeof details?.model === "string" ? details.model : "local model";
  const rawContent = getContentText(message.content).trim() || "(no report)";
  const content = expanded ? rawContent : truncateText(rawContent, 4_000);
  const color = status === "completed" ? "success" : status === "timeout" ? "warning" : "error";
  const header = `${theme.fg(color, status === "completed" ? "✓" : "✗")} ${theme.fg(
    "toolTitle",
    theme.bold(options.agentName),
  )} ${theme.fg("muted", model)}`;

  const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
  const container = new Container();
  container.addChild(new Text(header, 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
  if (!expanded && rawContent.length > content.length) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("muted", `Ctrl+O to expand ${options.agentName} report`), 0, 0),
    );
  }
  const toolHistory = renderStoredToolHistory(details, expanded, theme);
  if (toolHistory) {
    container.addChild(new Spacer(1));
    container.addChild(toolHistory);
  }
  const footer = renderTokenFooter(getUsageFromDetails(details), theme);
  if (footer) {
    container.addChild(new Spacer(1));
    container.addChild(footer);
  }
  box.addChild(container);
  return box;
}

export function renderChildAgentToolResult(
  result: { readonly content: unknown; readonly details?: unknown },
  state: { readonly expanded: boolean; readonly isPartial: boolean },
  theme: ChildAgentTheme,
  options: RenderChildAgentOptions,
) {
  const content = textFromContent(result.content).trim() || "(no report)";
  const details = isRecord(result.details) ? result.details : undefined;
  const status = state.isPartial
    ? "running"
    : typeof details?.status === "string"
      ? details.status
      : "completed";
  const color =
    status === "completed"
      ? "success"
      : status === "timeout" || status === "running"
        ? "warning"
        : "error";
  const icon = status === "completed" ? "✓" : status === "running" ? "⏳" : "✗";
  const shown = state.expanded ? content : truncateText(content, 4_000);
  const container = new Container();
  container.addChild(
    new Text(
      `${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(options.agentName))}`,
      0,
      0,
    ),
  );
  container.addChild(new Spacer(1));
  container.addChild(new Markdown(shown, 0, 0, getMarkdownTheme()));
  if (!state.expanded && content.length > shown.length) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("muted", `Ctrl+O to expand ${options.agentName} report`), 0, 0),
    );
  }
  const toolHistory = renderStoredToolHistory(details, state.expanded, theme);
  if (toolHistory) {
    container.addChild(new Spacer(1));
    container.addChild(toolHistory);
  }
  const footer = renderTokenFooter(getUsageFromDetails(details), theme);
  if (footer) {
    container.addChild(new Spacer(1));
    container.addChild(footer);
  }
  return container;
}
