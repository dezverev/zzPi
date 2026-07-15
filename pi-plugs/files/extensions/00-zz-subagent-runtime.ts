import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isConfigObject, parseJsonc } from "./zz-lib/jsonc-config.ts";

/**
 * Internal marker extension for the shared child-Pi subagent runtime.
 *
 * Installing this plug places the pi-plugs model-option helper/config under:
 * - .pi/extensions/lib/child-agent-model-options.ts
 * - .pi/extensions/local-model-endpoints.config.jsonc
 *
 * The shared child-Pi agent and JSONC helpers come from zz-lib under:
 * - .pi/extensions/zz-lib/child-pi-agent.ts
 * - .pi/extensions/zz-lib/jsonc-config.ts
 *
 * Repo-local custom subagent extensions can then import:
 *
 *   import { runChildPiAgent } from "./zz-lib/child-pi-agent.ts";
 *   import { readChildAgentModelOptions } from "./lib/child-agent-model-options.ts";
 *
 * This runtime also provides /zz-model-setup so users can point project-local
 * configs at their own LM Studio/OpenAI-compatible endpoint.
 */

interface LocalModelSetup {
  readonly contextWindow: number;
  readonly endpoint: string;
  readonly maxOutputTokens: number;
  readonly modelId: string;
  readonly modelName: string;
  readonly provider: string;
  readonly providerName: string;
  readonly reasoning: boolean;
}

interface SetupResult {
  readonly filesUpdated: readonly string[];
  readonly warnings: readonly string[];
}

const DEFAULT_SETUP: LocalModelSetup = {
  contextWindow: 127_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  modelId: "qwen/qwen3.6-35b-a3b",
  modelName: "Qwen 3.6 35B A3B (LM Studio)",
  provider: "lm-studio",
  providerName: "LM Studio",
  reasoning: true,
};

const ZZ_LOCAL_MODELS_CONFIG = "zzLocalModels.config.jsonc";
const LOCAL_MODEL_ENDPOINTS_CONFIG = "local-model-endpoints.config.jsonc";
const CHILD_AGENT_CONFIGS = [
  "readsubagent.config.jsonc",
  "wf-clarifier.config.jsonc",
  "wf-brainstormer.config.jsonc",
  "wf-adversarialreview.config.jsonc",
  "wf-designplan.config.jsonc",
  "wf-impplanner.config.jsonc",
  "wf-implementeragent.config.jsonc",
  "wf-revieweragent.config.jsonc",
  "wf-finalreviewagent.config.jsonc",
  "wf-testeragent.config.jsonc",
] as const;

function extensionConfigPath(cwd: string, filename: string): string {
  return resolve(cwd, ".pi", "extensions", filename);
}

function getStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function getNumberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getBooleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === "boolean" ? value : undefined;
}

function cloneConfigObject(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/u, "");
  if (!trimmed) throw new Error("endpoint cannot be empty");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`endpoint is not a valid URL: ${endpoint}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("endpoint must start with http:// or https://");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("endpoint must not include a query string or hash");
  }

  return trimmed;
}

function endpointHostLabel(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function readConfigFile(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  const parsed = parseJsonc(await readFile(path, "utf8"), path);
  if (!isConfigObject(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

async function writeConfigFile(path: string, record: Record<string, unknown>, note: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `// ${note}\n// Re-run /zz-model-setup to change the local model endpoint or model.\n${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

function firstConfiguredModel(record: Record<string, unknown>): { id?: string; name?: string } {
  const models = record.models;
  if (!Array.isArray(models)) return {};
  for (const model of models) {
    if (!isConfigObject(model)) continue;
    const id = getStringField(model, "id");
    const name = getStringField(model, "name");
    if (id || name) return { ...(id ? { id } : {}), ...(name ? { name } : {}) };
  }
  return {};
}

function localEndpointFromRecord(record: Record<string, unknown>): string | undefined {
  const active = (getStringField(record, "active") ?? "remoteLocal").trim().toLowerCase();
  if (["truelocal", "true-local", "true_local", "localhost", "loopback"].includes(active)) {
    return getStringField(record, "trueLocalEndpoint") ?? getStringField(record, "localEndpoint");
  }
  return (
    getStringField(record, "remoteLocalEndpoint") ??
    getStringField(record, "lanEndpoint") ??
    getStringField(record, "localNetworkEndpoint") ??
    getStringField(record, "remoteEndpoint")
  );
}

async function readExistingSetup(cwd: string): Promise<LocalModelSetup> {
  const setup: LocalModelSetup = { ...DEFAULT_SETUP };

  const zzLocalModels = await readConfigFile(extensionConfigPath(cwd, ZZ_LOCAL_MODELS_CONFIG));
  if (zzLocalModels) {
    const configuredModel = firstConfiguredModel(zzLocalModels);
    return {
      contextWindow: getNumberField(zzLocalModels, "contextWindow") ?? setup.contextWindow,
      endpoint:
        getStringField(zzLocalModels, "endpoint") ??
        getStringField(zzLocalModels, "baseUrl") ??
        getStringField(zzLocalModels, "url") ??
        setup.endpoint,
      maxOutputTokens: getNumberField(zzLocalModels, "maxTokens") ?? setup.maxOutputTokens,
      modelId: configuredModel.id ?? setup.modelId,
      modelName: configuredModel.name ?? configuredModel.id ?? setup.modelName,
      provider: getStringField(zzLocalModels, "provider") ?? setup.provider,
      providerName: getStringField(zzLocalModels, "name") ?? setup.providerName,
      reasoning: getBooleanField(zzLocalModels, "reasoning") ?? setup.reasoning,
    };
  }

  const localEndpoints = await readConfigFile(extensionConfigPath(cwd, LOCAL_MODEL_ENDPOINTS_CONFIG));
  if (localEndpoints) {
    const endpoint = localEndpointFromRecord(localEndpoints);
    return { ...setup, ...(endpoint ? { endpoint } : {}) };
  }

  for (const filename of CHILD_AGENT_CONFIGS) {
    const config = await readConfigFile(extensionConfigPath(cwd, filename));
    if (!config) continue;
    const endpoint = getStringField(config, "endpoint") ?? getStringField(config, "baseUrl") ?? getStringField(config, "url");
    const modelId = getStringField(config, "model");
    const provider = getStringField(config, "provider");
    return {
      ...setup,
      ...(endpoint ? { endpoint } : {}),
      ...(modelId ? { modelId, modelName: modelId } : {}),
      ...(provider ? { provider } : {}),
    };
  }

  return setup;
}

function mergeZzLocalModelsConfig(
  existing: Record<string, unknown> | undefined,
  setup: LocalModelSetup,
): Record<string, unknown> {
  const next = existing ? cloneConfigObject(existing) : {};
  next.enabled = true;
  next.provider = setup.provider;
  next.name = setup.providerName;
  next.endpoint = setup.endpoint;
  next.apiKey = getStringField(next, "apiKey") ?? "lm-studio";
  next.contextWindow = setup.contextWindow;
  next.maxTokens = setup.maxOutputTokens;
  next.reasoning = setup.reasoning;

  const existingModels = Array.isArray(next.models) ? next.models.filter(isConfigObject).map(cloneConfigObject) : [];
  const modelIndex = existingModels.findIndex((model) => getStringField(model, "id") === setup.modelId);
  const modelRecord = {
    id: setup.modelId,
    name: setup.modelName,
    contextWindow: setup.contextWindow,
    maxTokens: setup.maxOutputTokens,
    reasoning: setup.reasoning,
  };
  if (modelIndex >= 0) existingModels[modelIndex] = { ...existingModels[modelIndex], ...modelRecord };
  else existingModels.unshift(modelRecord);
  next.models = existingModels;

  return next;
}

function mergeLocalModelEndpointsConfig(
  existing: Record<string, unknown> | undefined,
  setup: LocalModelSetup,
): Record<string, unknown> {
  const next = existing ? cloneConfigObject(existing) : {};
  const loopback = isLoopbackEndpoint(setup.endpoint);
  next.active = loopback ? "trueLocal" : "remoteLocal";
  if (loopback) {
    next.trueLocalEndpoint = setup.endpoint;
    next.remoteLocalEndpoint = getStringField(next, "remoteLocalEndpoint") ?? setup.endpoint;
  } else {
    next.remoteLocalEndpoint = setup.endpoint;
    next.trueLocalEndpoint = getStringField(next, "trueLocalEndpoint") ?? "http://127.0.0.1:1234";
  }
  next.trueRemoteProvider = getStringField(next, "trueRemoteProvider") ?? "openai-codex";
  next.trueRemoteModel = getStringField(next, "trueRemoteModel") ?? "gpt-5.6-sol";
  next.trueRemoteThinking = getStringField(next, "trueRemoteThinking") ?? "xhigh";
  next.trueRemoteContextWindow = getNumberField(next, "trueRemoteContextWindow") ?? 272_000;
  next.trueRemoteMaxOutputTokens = getNumberField(next, "trueRemoteMaxOutputTokens") ?? 128_000;
  return next;
}

function isLocalModelOption(option: Record<string, unknown>, setup: LocalModelSetup): boolean {
  const provider = (getStringField(option, "provider") ?? "").trim().toLowerCase();
  const label = (getStringField(option, "label") ?? "").toLowerCase();
  const endpoint = getStringField(option, "endpoint") ?? getStringField(option, "baseUrl") ?? getStringField(option, "url");

  if (provider === setup.provider.toLowerCase()) return true;
  if (["lm-studio", "lmstudio", "local"].includes(provider)) return true;
  if (provider && ["openai-codex", "anthropic", "google", "openai"].includes(provider)) return false;
  return Boolean(endpoint) && label.includes("lm studio");
}

function updateLocalChildModelOption(option: Record<string, unknown>, setup: LocalModelSetup): void {
  option.label = `${setup.modelName} @ ${endpointHostLabel(setup.endpoint)} (${setup.providerName})`;
  option.provider = setup.provider;
  option.providerRegistration = "openai-compatible";
  option.endpoint = setup.endpoint;
  option.model = setup.modelId;
  option.contextWindow = getNumberField(option, "contextWindow") ?? setup.contextWindow;
  option.maxOutputTokens = getNumberField(option, "maxOutputTokens") ?? setup.maxOutputTokens;
  option.thinking = getStringField(option, "thinking") ?? (setup.reasoning ? "off" : "off");
}

function mergeChildAgentConfig(
  existing: Record<string, unknown>,
  setup: LocalModelSetup,
): { changed: boolean; next: Record<string, unknown> } {
  const next = cloneConfigObject(existing);
  let changed = false;

  const topLevelProvider = (getStringField(next, "provider") ?? "").trim().toLowerCase();
  const topLevelEndpoint = getStringField(next, "endpoint") ?? getStringField(next, "baseUrl") ?? getStringField(next, "url");
  if (topLevelProvider === setup.provider.toLowerCase() || topLevelProvider === "lm-studio" || topLevelProvider === "lmstudio") {
    next.provider = setup.provider;
    next.providerRegistration = "openai-compatible";
    next.endpoint = setup.endpoint;
    next.model = setup.modelId;
    next.contextWindow = setup.contextWindow;
    next.maxOutputTokens = setup.maxOutputTokens;
    changed = true;
  } else if (!topLevelProvider && topLevelEndpoint) {
    next.provider = setup.provider;
    next.providerRegistration = "openai-compatible";
    next.endpoint = setup.endpoint;
    next.model = setup.modelId;
    changed = true;
  }

  const modelOptions = next.modelOptions;
  if (isConfigObject(modelOptions)) {
    for (const option of Object.values(modelOptions)) {
      if (!isConfigObject(option) || !isLocalModelOption(option, setup)) continue;
      updateLocalChildModelOption(option, setup);
      changed = true;
    }
  }

  return { changed, next };
}

async function applyLocalModelSetup(cwd: string, setup: LocalModelSetup): Promise<SetupResult> {
  const filesUpdated: string[] = [];
  const warnings: string[] = [];

  const zzLocalModelsPath = extensionConfigPath(cwd, ZZ_LOCAL_MODELS_CONFIG);
  const zzLocalModelsExtensionPath = resolve(cwd, ".pi", "extensions", "zzLocalModels.ts");
  if (existsSync(zzLocalModelsPath) || existsSync(zzLocalModelsExtensionPath)) {
    try {
      const existing = await readConfigFile(zzLocalModelsPath);
      await writeConfigFile(
        zzLocalModelsPath,
        mergeZzLocalModelsConfig(existing, setup),
        "Written by /zz-model-setup for Pi's local model provider.",
      );
      filesUpdated.push(`.pi/extensions/${ZZ_LOCAL_MODELS_CONFIG}`);
    } catch (error) {
      warnings.push(`${ZZ_LOCAL_MODELS_CONFIG}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    warnings.push(`install the zz-local-models plug, then rerun /zz-model-setup to update ${ZZ_LOCAL_MODELS_CONFIG}`);
  }

  const localEndpointsPath = extensionConfigPath(cwd, LOCAL_MODEL_ENDPOINTS_CONFIG);
  try {
    const existing = await readConfigFile(localEndpointsPath);
    await writeConfigFile(
      localEndpointsPath,
      mergeLocalModelEndpointsConfig(existing, setup),
      "Written by /zz-model-setup for shared child-agent local endpoints.",
    );
    filesUpdated.push(`.pi/extensions/${LOCAL_MODEL_ENDPOINTS_CONFIG}`);
  } catch (error) {
    warnings.push(`${LOCAL_MODEL_ENDPOINTS_CONFIG}: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const filename of CHILD_AGENT_CONFIGS) {
    const path = extensionConfigPath(cwd, filename);
    if (!existsSync(path)) continue;
    try {
      const existing = await readConfigFile(path);
      if (!existing) continue;
      const { changed, next } = mergeChildAgentConfig(existing, setup);
      if (!changed) continue;
      await writeConfigFile(path, next, "Updated by /zz-model-setup for local child-agent model options.");
      filesUpdated.push(`.pi/extensions/${filename}`);
    } catch (error) {
      warnings.push(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { filesUpdated, warnings };
}

async function promptForSetup(ctx: ExtensionContext, defaults: LocalModelSetup): Promise<LocalModelSetup | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "zz-model-setup needs interactive UI for the wizard. Use: /zz-model-setup set <endpoint> [model-id] [provider-id]",
      "warning",
    );
    return undefined;
  }

  const endpoint = await ctx.ui.input(
    "LM Studio/OpenAI-compatible endpoint (server root, /v1, or /v1/chat/completions):",
    defaults.endpoint,
  );
  if (endpoint === undefined) return undefined;

  const modelId = await ctx.ui.input("Model id served by that endpoint:", defaults.modelId);
  if (modelId === undefined) return undefined;

  const provider = await ctx.ui.input("Pi provider id:", defaults.provider);
  if (provider === undefined) return undefined;

  const providerName = await ctx.ui.input("Provider display name:", defaults.providerName);
  if (providerName === undefined) return undefined;

  const modelName = await ctx.ui.input("Model display name:", defaults.modelName || modelId);
  if (modelName === undefined) return undefined;

  return {
    ...defaults,
    endpoint: normalizeEndpoint(endpoint || defaults.endpoint),
    modelId: (modelId || defaults.modelId).trim(),
    modelName: (modelName || modelId || defaults.modelName).trim(),
    provider: (provider || defaults.provider).trim(),
    providerName: (providerName || defaults.providerName).trim(),
  };
}

function setupFromSetArgs(args: readonly string[], defaults: LocalModelSetup): LocalModelSetup {
  const [endpoint, modelId, provider] = args;
  if (!endpoint) throw new Error("usage: /zz-model-setup set <endpoint> [model-id] [provider-id]");
  const nextModelId = (modelId || defaults.modelId).trim();
  const nextProvider = (provider || defaults.provider).trim();
  return {
    ...defaults,
    endpoint: normalizeEndpoint(endpoint),
    modelId: nextModelId,
    modelName: modelId ? nextModelId : defaults.modelName,
    provider: nextProvider,
    providerName: provider ? nextProvider : defaults.providerName,
  };
}

async function showSetupStatus(ctx: ExtensionContext): Promise<void> {
  const defaults = await readExistingSetup(ctx.cwd);
  const installedChildConfigs = CHILD_AGENT_CONFIGS.filter((filename) => existsSync(extensionConfigPath(ctx.cwd, filename)));
  const zzLocalModelsInstalled = existsSync(resolve(ctx.cwd, ".pi", "extensions", "zzLocalModels.ts"));

  ctx.ui.notify(
    [
      "zz model setup status:",
      `  endpoint: ${defaults.endpoint}`,
      `  provider: ${defaults.provider}`,
      `  model: ${defaults.modelId}`,
      `  provider config: .pi/extensions/${ZZ_LOCAL_MODELS_CONFIG}${zzLocalModelsInstalled ? "" : " (install zz-local-models to expose it in /model)"}`,
      `  shared endpoint config: .pi/extensions/${LOCAL_MODEL_ENDPOINTS_CONFIG}`,
      `  child-agent configs installed: ${installedChildConfigs.length ? installedChildConfigs.join(", ") : "none"}`,
      "Run /zz-model-setup setup to open the wizard, or /zz-model-setup set <endpoint> [model-id] [provider-id].",
    ].join("\n"),
    "info",
  );
}

function setupSummary(setup: LocalModelSetup, result: SetupResult): string {
  const lines = [
    "zz model setup complete:",
    `  endpoint: ${setup.endpoint}`,
    `  provider: ${setup.provider}`,
    `  model: ${setup.modelId}`,
    `  updated: ${result.filesUpdated.length ? result.filesUpdated.join(", ") : "no files"}`,
  ];
  if (result.warnings.length) {
    lines.push("warnings:", ...result.warnings.map((warning) => `  - ${warning}`));
  }
  lines.push("Run /reload so Pi and child agents pick up the new config.");
  return lines.join("\n");
}

async function runSetupCommand(args: string, ctx: ExtensionContext): Promise<void> {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const subcommand = (tokens.shift() ?? "setup").toLowerCase();

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    ctx.ui.notify(
      [
        "Usage:",
        "  /zz-model-setup setup",
        "  /zz-model-setup status",
        "  /zz-model-setup set <endpoint> [model-id] [provider-id]",
        "",
        "The wizard updates .pi/extensions/zzLocalModels.config.jsonc,",
        ".pi/extensions/local-model-endpoints.config.jsonc, and any installed child-agent configs.",
      ].join("\n"),
      "info",
    );
    return;
  }

  if (subcommand === "status" || subcommand === "config") {
    await showSetupStatus(ctx);
    return;
  }

  const defaults = await readExistingSetup(ctx.cwd);
  let setup: LocalModelSetup | undefined;
  if (subcommand === "set") {
    setup = setupFromSetArgs(tokens, defaults);
  } else if (subcommand === "setup" || subcommand === "wizard") {
    setup = await promptForSetup(ctx, defaults);
  } else {
    const maybeEndpoint = subcommand;
    setup = setupFromSetArgs([maybeEndpoint, ...tokens], defaults);
  }

  if (!setup) {
    ctx.ui.notify("zz model setup cancelled", "info");
    return;
  }
  if (!setup.modelId.trim()) throw new Error("model id cannot be empty");
  if (!setup.provider.trim()) throw new Error("provider id cannot be empty");

  const result = await applyLocalModelSetup(ctx.cwd, setup);
  ctx.ui.notify(setupSummary(setup, result), result.warnings.length ? "warning" : "info");
}

export default function zzSubagentRuntime(pi: ExtensionAPI): void {
  pi.registerCommand("zz-model-setup", {
    description: "Configure project-local LM Studio/OpenAI-compatible endpoint and model settings",
    getArgumentCompletions: (prefix) => {
      const first = prefix.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
      return ["setup", "status", "set", "help"]
        .filter((option) => option.startsWith(first))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => runSetupCommand(args, ctx),
  });
}
