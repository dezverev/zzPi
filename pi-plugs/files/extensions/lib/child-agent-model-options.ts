import type { ChildPiAgentConfig } from "../zz-lib/child-pi-agent.ts";
import {
  getErrorMessage,
  getModelSelector,
  normalizeBaseUrl,
  normalizeThinking,
} from "../zz-lib/child-pi-agent.ts";
import {
  type ConfigObject,
  getPositiveIntegerField,
  getStringArrayField,
  getStringField,
  isConfigObject,
  readJsoncConfig,
} from "../zz-lib/jsonc-config.ts";

export interface ChildAgentModelOption {
  readonly contextWindow?: number;
  readonly endpoint?: string;
  readonly endpointSource?: string;
  readonly id: string;
  readonly label: string;
  readonly maxOutputTokens?: number;
  readonly model: string;
  readonly modelSelector?: string;
  readonly provider: string;
  readonly providerRegistration?: ChildPiAgentConfig["providerRegistration"];
  readonly reportMaxChars?: number;
  readonly requestTimeoutMs?: number;
  readonly systemPrompt?: string;
  readonly thinking?: ChildPiAgentConfig["thinking"];
  readonly tools?: readonly string[];
}

export interface ChildAgentModelOptionsResult {
  readonly error?: string;
  readonly options: readonly ChildAgentModelOption[];
}

export interface ReadChildAgentModelOptionsParams {
  readonly agentName: string;
  readonly baseConfig: ChildPiAgentConfig;
  readonly configFilePath: string;
  readonly cwd: string;
}

export function sanitizeModelOptionId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "default";
}

function getFirstStringField(record: ConfigObject, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = getStringField(record, field)?.trim();
    if (value) return value;
  }

  return undefined;
}

export function createChildAgentModelOptionFromConfig(
  config: ChildPiAgentConfig,
): ChildAgentModelOption {
  return {
    id: sanitizeModelOptionId(config.model),
    label: config.model,
    endpoint: config.endpoint,
    ...(config.endpointSource ? { endpointSource: config.endpointSource } : {}),
    model: config.model,
    ...(config.modelSelector ? { modelSelector: config.modelSelector } : {}),
    provider: config.provider,
    ...(config.providerRegistration ? { providerRegistration: config.providerRegistration } : {}),
  };
}

function readOptionalPositiveInteger(
  record: ConfigObject,
  field: string,
  modelOptionId: string,
): number | undefined {
  try {
    return getPositiveIntegerField(record, field);
  } catch (error) {
    throw new Error(`modelOptions.${modelOptionId}.${getErrorMessage(error)}`);
  }
}

function normalizeChildAgentProviderRegistration(
  value: string,
  modelOptionId: string,
): ChildPiAgentConfig["providerRegistration"] {
  const normalized = value.trim().toLowerCase();
  if (["openai-compatible", "openai", "local", "register"].includes(normalized)) {
    return "openai-compatible";
  }
  if (["none", "skip", "existing"].includes(normalized)) return "none";
  throw new Error(`modelOptions.${modelOptionId}.providerRegistration must be "openai-compatible" or "none".`);
}

function readChildAgentModelOption(
  idFromMap: string | undefined,
  record: ConfigObject,
  params: Pick<ReadChildAgentModelOptionsParams, "agentName" | "baseConfig" | "configFilePath">,
): ChildAgentModelOption {
  const model = getStringField(record, "model")?.trim() || idFromMap?.trim();
  if (!model) throw new Error("modelOptions entries must define a non-empty model.");

  const id = getStringField(record, "id")?.trim() || idFromMap?.trim() || sanitizeModelOptionId(model);
  if (!id) throw new Error(`modelOptions.${model} must define a non-empty id.`);

  const modelSelector = getStringField(record, "modelSelector")?.trim() || undefined;
  const provider = getStringField(record, "provider")?.trim() || params.baseConfig.provider;
  const providerRegistrationValue = getStringField(record, "providerRegistration")?.trim();
  const endpoint = getFirstStringField(record, ["endpoint", "baseUrl", "url"]);
  const contextWindow = readOptionalPositiveInteger(record, "contextWindow", id);
  const maxOutputTokens = readOptionalPositiveInteger(record, "maxOutputTokens", id);
  const reportMaxChars = readOptionalPositiveInteger(record, "reportMaxChars", id);
  const requestTimeoutMs = readOptionalPositiveInteger(record, "requestTimeoutMs", id);
  const systemPrompt = getStringField(record, "systemPrompt");
  const thinkingValue = getStringField(record, "thinking")?.trim();
  const tools = getStringArrayField(record, "tools");

  if (record.tools !== undefined && tools === undefined) {
    throw new Error(`modelOptions.${id}.tools must be an array of strings.`);
  }

  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(endpoint
      ? {
          endpoint: normalizeBaseUrl(endpoint, `${params.configFilePath} modelOptions.${id}.endpoint`),
          endpointSource: `${params.configFilePath} modelOptions.${id}.endpoint`,
        }
      : {}),
    id,
    label: getStringField(record, "label")?.trim() || model,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    model,
    ...(modelSelector ? { modelSelector } : {}),
    provider,
    ...(providerRegistrationValue
      ? { providerRegistration: normalizeChildAgentProviderRegistration(providerRegistrationValue, id) }
      : {}),
    ...(reportMaxChars ? { reportMaxChars } : {}),
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(thinkingValue ? { thinking: normalizeThinking(thinkingValue, `${params.agentName} modelOptions.${id}`) } : {}),
    ...(tools ? { tools } : {}),
  };
}

export function readChildAgentModelOptions(
  params: ReadChildAgentModelOptionsParams,
): ChildAgentModelOptionsResult {
  const fallbackOptions = [createChildAgentModelOptionFromConfig(params.baseConfig)];

  try {
    const record = readJsoncConfig(params.configFilePath, params.cwd);
    const rawOptions = record?.modelOptions;
    if (rawOptions === undefined) return { options: fallbackOptions };

    const entries: Array<{ idFromMap?: string; record: ConfigObject }> = [];
    if (Array.isArray(rawOptions)) {
      rawOptions.forEach((item, index) => {
        if (!isConfigObject(item)) throw new Error(`modelOptions[${index}] must be an object.`);
        entries.push({ record: item });
      });
    } else if (isConfigObject(rawOptions)) {
      for (const [idFromMap, item] of Object.entries(rawOptions)) {
        if (!isConfigObject(item)) throw new Error(`modelOptions.${idFromMap} must be an object.`);
        entries.push({ idFromMap, record: item });
      }
    } else {
      throw new Error("modelOptions must be an object mapping ids to model configs or an array of model config objects.");
    }

    if (entries.length === 0) throw new Error("modelOptions must define at least one model.");

    const seen = new Set<string>();
    return {
      options: entries.map(({ idFromMap, record }) => {
        const option = readChildAgentModelOption(idFromMap, record, params);
        if (seen.has(option.id)) throw new Error(`modelOptions contains duplicate id "${option.id}".`);
        seen.add(option.id);
        return option;
      }),
    };
  } catch (error) {
    return { error: getErrorMessage(error), options: fallbackOptions };
  }
}

export function getChildAgentModelSelector(option: ChildAgentModelOption): string {
  return option.modelSelector ?? `${option.provider}/${option.model}`;
}

export function getChildAgentModelChoiceLabel(option: ChildAgentModelOption): string {
  const targetText = option.providerRegistration === "none"
    ? " via Pi provider/auth"
    : option.endpoint
      ? ` @ ${option.endpoint}`
      : "";
  const thinkingText = option.thinking && option.thinking !== "off" ? ` thinking=${option.thinking}` : "";
  return `${option.label} (${getChildAgentModelSelector(option)}${targetText}${thinkingText})`;
}

export function getChildAgentModelOption(
  options: readonly ChildAgentModelOption[],
  id: string | undefined,
): ChildAgentModelOption | undefined {
  if (!id) return undefined;
  return options.find((option) => option.id === id);
}

export function findChildAgentModelOption(
  options: readonly ChildAgentModelOption[],
  input: string,
): ChildAgentModelOption | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;

  return options.find((option) =>
    [
      option.id,
      option.label,
      option.model,
      getChildAgentModelSelector(option),
      getChildAgentModelChoiceLabel(option),
    ].some((candidate) => candidate.toLowerCase() === normalized),
  );
}

export function getChildAgentModelCompletions(
  options: readonly ChildAgentModelOption[],
  prefix: string,
) {
  const normalized = prefix.trim().toLowerCase();
  const modelCompletions = options
    .filter((option) =>
      [option.id, option.label, option.model, getChildAgentModelSelector(option)].some(
        (candidate) => candidate.toLowerCase().startsWith(normalized),
      ),
    )
    .map((option) => ({ value: option.id, label: getChildAgentModelChoiceLabel(option) }));
  const resetCompletions = [
    { value: "default", label: "default (clear persistent model override)" },
    { value: "reset", label: "reset (clear persistent model override)" },
  ].filter((completion) => completion.value.startsWith(normalized));
  return Array.from(
    new Map([...modelCompletions, ...resetCompletions].map((completion) => [completion.value, completion])).values(),
  );
}

export function formatAvailableChildAgentModels(options: readonly ChildAgentModelOption[]): string {
  return options
    .map((option) => `${option.id}: ${getChildAgentModelChoiceLabel(option)}`)
    .join(", ");
}

export function formatChildAgentModelSelection(options: {
  readonly config: ChildPiAgentConfig;
  readonly modelOptions: readonly ChildAgentModelOption[];
  readonly selectedModelId?: string | undefined;
}): string {
  const selectedOption = getChildAgentModelOption(options.modelOptions, options.selectedModelId);
  const selectedText = selectedOption
    ? `workspace-persistent override: ${selectedOption.label} (${selectedOption.id})`
    : "config default (no persistent override)";
  const endpointText = options.config.providerRegistration === "none"
    ? "active endpoint: (none; using Pi's configured provider/auth)"
    : `active endpoint: ${options.config.endpoint}`;

  return [
    `model selection: ${selectedText}`,
    `active child model selector: ${getModelSelector(options.config)}`,
    endpointText,
    ...(options.config.providerRegistration !== "none" && options.config.endpointSource
      ? [`active endpoint source: ${options.config.endpointSource}`]
      : []),
    `available models: ${formatAvailableChildAgentModels(options.modelOptions)}`,
  ].join("\n");
}

function migrateLegacyGptDefault(config: ChildPiAgentConfig): ChildPiAgentConfig {
  if (config.provider !== "openai-codex" || config.model !== "gpt-5.5" || config.thinking !== "xhigh") {
    return config;
  }
  const { modelSelector: _modelSelector, ...baseConfig } = config;
  void _modelSelector;
  return {
    ...baseConfig,
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    model: "gpt-5.6-sol",
  };
}

export function applyChildAgentModelSelection(
  config: ChildPiAgentConfig,
  selectedOption: ChildAgentModelOption | undefined,
): ChildPiAgentConfig {
  // Installed config files are intentionally preserved across plug updates. Migrate
  // the former automatic default in memory while retaining explicit model choices.
  if (!selectedOption) return migrateLegacyGptDefault(config);

  const { modelSelector: _modelSelector, ...baseConfig } = config;
  void _modelSelector;

  return {
    ...baseConfig,
    ...(selectedOption.contextWindow ? { contextWindow: selectedOption.contextWindow } : {}),
    ...(selectedOption.endpoint
      ? {
          endpoint: selectedOption.endpoint,
          ...(selectedOption.endpointSource ? { endpointSource: selectedOption.endpointSource } : {}),
        }
      : {}),
    ...(selectedOption.maxOutputTokens ? { maxOutputTokens: selectedOption.maxOutputTokens } : {}),
    model: selectedOption.model,
    ...(selectedOption.modelSelector ? { modelSelector: selectedOption.modelSelector } : {}),
    provider: selectedOption.provider,
    ...(selectedOption.providerRegistration
      ? { providerRegistration: selectedOption.providerRegistration }
      : {}),
    ...(selectedOption.reportMaxChars ? { reportMaxChars: selectedOption.reportMaxChars } : {}),
    ...(selectedOption.requestTimeoutMs ? { requestTimeoutMs: selectedOption.requestTimeoutMs } : {}),
    ...(selectedOption.systemPrompt !== undefined ? { systemPrompt: selectedOption.systemPrompt } : {}),
    ...(selectedOption.thinking ? { thinking: selectedOption.thinking } : {}),
    ...(selectedOption.tools ? { tools: selectedOption.tools } : {}),
  };
}
