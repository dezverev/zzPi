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
  readonly modelOptionsConfigFilePath: string;
  readonly cwd: string;
}

const PROJECT_MODEL_OPTIONS_CONFIG_FILE_PATH = ".zzpi/zz-agent-models.jsonc";
const RESERVED_PROJECT_PROVIDER_IDS = new Set([
  "anthropic",
  "fireworks",
  "google",
  "openai",
  "openai-codex",
  "zz-agent-local",
  "zz-codex-proxy",
]);

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
  params: Pick<ReadChildAgentModelOptionsParams, "agentName" | "baseConfig" | "modelOptionsConfigFilePath">,
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
          endpoint: normalizeBaseUrl(endpoint, `${params.modelOptionsConfigFilePath} modelOptions.${id}.endpoint`),
          endpointSource: `${params.modelOptionsConfigFilePath} modelOptions.${id}.endpoint`,
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

function validateProjectModelOptionRecord(idFromMap: string | undefined, record: ConfigObject): void {
  const optionId = getStringField(record, "id")?.trim() || idFromMap?.trim() || "<unknown>";
  for (const field of ["model", "provider", "providerRegistration", "thinking"] as const) {
    if (!getStringField(record, field)?.trim()) {
      throw new Error(`modelOptions.${optionId}.${field} must be a non-empty string in the project catalog.`);
    }
  }
  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    if (readOptionalPositiveInteger(record, field, optionId) === undefined) {
      throw new Error(`modelOptions.${optionId}.${field} must be a positive integer in the project catalog.`);
    }
  }
  const registration = normalizeChildAgentProviderRegistration(
    getStringField(record, "providerRegistration")!,
    optionId,
  );
  if (registration === "openai-compatible" && !getFirstStringField(record, ["endpoint", "baseUrl", "url"])) {
    throw new Error(`modelOptions.${optionId}.endpoint is required for an openai-compatible project provider.`);
  }
}

function readModelOptionsCatalog(
  record: ConfigObject,
  params: ReadChildAgentModelOptionsParams,
  modelOptionsConfigFilePath: string,
  projectCatalog = false,
): ChildAgentModelOption[] {
  if (record.version !== 1) {
    throw new Error(`${modelOptionsConfigFilePath} has unsupported version ${String(record.version)}.`);
  }
  const rawOptions = record.modelOptions;
  if (rawOptions === undefined) {
    throw new Error(`${modelOptionsConfigFilePath} must define modelOptions.`);
  }

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
  return entries.map(({ idFromMap, record: optionRecord }) => {
    if (projectCatalog) validateProjectModelOptionRecord(idFromMap, optionRecord);
    const option = readChildAgentModelOption(idFromMap, optionRecord, {
      ...params,
      modelOptionsConfigFilePath,
    });
    if (seen.has(option.id)) throw new Error(`modelOptions contains duplicate id "${option.id}".`);
    seen.add(option.id);
    return option;
  });
}

export function readChildAgentModelOptions(
  params: ReadChildAgentModelOptionsParams,
): ChildAgentModelOptionsResult {
  const fallbackOptions = [createChildAgentModelOptionFromConfig(params.baseConfig)];
  let packagedOptions: ChildAgentModelOption[];

  try {
    const record = readJsoncConfig(params.modelOptionsConfigFilePath, params.cwd);
    if (!record) throw new Error(`${params.modelOptionsConfigFilePath} is missing.`);
    packagedOptions = readModelOptionsCatalog(record, params, params.modelOptionsConfigFilePath);
  } catch (error) {
    return { error: getErrorMessage(error), options: fallbackOptions };
  }

  try {
    const projectRecord = readJsoncConfig(PROJECT_MODEL_OPTIONS_CONFIG_FILE_PATH, params.cwd);
    if (!projectRecord) return { options: packagedOptions };

    const projectOptions = readModelOptionsCatalog(
      projectRecord,
      params,
      PROJECT_MODEL_OPTIONS_CONFIG_FILE_PATH,
      true,
    );
    const packagedIds = new Set(packagedOptions.map((option) => option.id));
    const selfRegisteringProviders = new Set<string>();
    for (const option of projectOptions) {
      if (packagedIds.has(option.id)) {
        throw new Error(`${PROJECT_MODEL_OPTIONS_CONFIG_FILE_PATH} model option id "${option.id}" collides with the packaged catalog.`);
      }
      if (option.providerRegistration === "openai-compatible") {
        const normalizedProvider = option.provider.toLowerCase();
        if (RESERVED_PROJECT_PROVIDER_IDS.has(normalizedProvider)) {
          throw new Error(`${PROJECT_MODEL_OPTIONS_CONFIG_FILE_PATH} modelOptions.${option.id}.provider "${option.provider}" is reserved.`);
        }
        if (selfRegisteringProviders.has(normalizedProvider)) {
          throw new Error(`${PROJECT_MODEL_OPTIONS_CONFIG_FILE_PATH} self-registering provider "${option.provider}" is used by more than one model option.`);
        }
        selfRegisteringProviders.add(normalizedProvider);
      }
    }

    return { options: [...packagedOptions, ...projectOptions] };
  } catch (error) {
    return { error: getErrorMessage(error), options: packagedOptions };
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
  // Preserve a usable operational fallback when the central catalog is unavailable.
  // Retain the legacy GPT default normalization for old standalone config shapes.
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
    // Tools are agent operational policy, not model metadata. Keep the base
    // allowlist so a central or project model option cannot erase capabilities.
  };
}
