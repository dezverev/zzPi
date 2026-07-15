import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  type ConfigObject,
  getBooleanField,
  getObjectArrayField,
  getPositiveIntegerField,
  getStringField,
  readJsoncConfig,
} from "./zz-lib/jsonc-config.ts";

const CONFIG_FILE_PATH = ".pi/extensions/zzLocalModels.config.jsonc";

interface ZzLocalModelConfig {
  readonly contextWindow: number;
  readonly id: string;
  readonly maxTokens: number;
  readonly name: string;
  readonly reasoning: boolean;
}

interface ZzLocalModelsConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly models: readonly ZzLocalModelConfig[];
  readonly name: string;
  readonly provider: string;
}

const DEFAULT_CONTEXT_WINDOW = 127_000;
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_MODELS: readonly ZzLocalModelConfig[] = [
  {
    contextWindow: 250_000,
    id: "qwen/qwen3.6-35b-a3b",
    maxTokens: DEFAULT_MAX_TOKENS,
    name: "Qwen 3.6 35B A3B (LM Studio default long context)",
    reasoning: true,
  },
  {
    contextWindow: 250_000,
    id: "qwen/qwen3.6-27b",
    maxTokens: DEFAULT_MAX_TOKENS,
    name: "Qwen 3.6 27B (LM Studio .48 long context)",
    reasoning: true,
  },
  {
    contextWindow: 120_000,
    id: "qwen3.6-27b-rust-v1.mlx",
    maxTokens: DEFAULT_MAX_TOKENS,
    name: "Qwen 3.6 27B Rust v1 MLX (LM Studio .48 via proxy)",
    reasoning: false,
  },
];
const DEFAULT_CONFIG: ZzLocalModelsConfig = {
  apiKey: "lm-studio",
  baseUrl: "http://127.0.0.1:1234/v1",
  enabled: true,
  models: DEFAULT_MODELS,
  name: "LM Studio",
  provider: "lm-studio",
};

let lastConfigError: string | undefined;
let lastProvider = DEFAULT_CONFIG.provider;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeNonEmpty(value: string | undefined, fallback: string, label: string): string {
  const candidate = value?.trim() || fallback;
  if (!candidate.trim()) throw new Error(`${label} cannot be empty.`);
  return candidate;
}

function normalizeBaseUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/u, "");
  if (!trimmed) throw new Error("zzLocalModels endpoint cannot be empty.");

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("zzLocalModels endpoint must start with http:// or https://.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("zzLocalModels endpoint must not include a query string or hash.");
  }

  if (trimmed.endsWith("/v1/chat/completions")) {
    return trimmed.slice(0, -"/chat/completions".length);
  }
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

function readModelConfig(
  record: ConfigObject,
  defaults: Pick<ZzLocalModelConfig, "contextWindow" | "maxTokens" | "reasoning">,
): ZzLocalModelConfig {
  const id = getStringField(record, "id")?.trim();
  if (!id) throw new Error("zzLocalModels model entries must define a non-empty id.");

  return {
    contextWindow: getPositiveIntegerField(record, "contextWindow") ?? defaults.contextWindow,
    id,
    maxTokens: getPositiveIntegerField(record, "maxTokens") ?? defaults.maxTokens,
    name: getStringField(record, "name")?.trim() || id,
    reasoning: getBooleanField(record, "reasoning") ?? defaults.reasoning,
  };
}

function readZzLocalModelsConfig(cwd: string): ZzLocalModelsConfig {
  lastConfigError = undefined;

  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, cwd);
    if (!record) return { ...DEFAULT_CONFIG, models: [...DEFAULT_MODELS] };

    const defaultModelFields = {
      contextWindow: getPositiveIntegerField(record, "contextWindow") ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: getPositiveIntegerField(record, "maxTokens") ?? DEFAULT_MAX_TOKENS,
      reasoning: getBooleanField(record, "reasoning") ?? true,
    };
    const modelRecords = getObjectArrayField(record, "models");
    const models = modelRecords?.map((modelRecord) => readModelConfig(modelRecord, defaultModelFields));

    return {
      apiKey: normalizeNonEmpty(getStringField(record, "apiKey"), DEFAULT_CONFIG.apiKey, "zzLocalModels apiKey"),
      baseUrl: normalizeBaseUrl(
        getStringField(record, "baseUrl") ??
          getStringField(record, "endpoint") ??
          getStringField(record, "url") ??
          DEFAULT_CONFIG.baseUrl,
      ),
      enabled: getBooleanField(record, "enabled") ?? true,
      models: models?.length ? models : DEFAULT_MODELS,
      name: normalizeNonEmpty(getStringField(record, "name"), DEFAULT_CONFIG.name, "zzLocalModels name"),
      provider: normalizeNonEmpty(
        getStringField(record, "provider"),
        DEFAULT_CONFIG.provider,
        "zzLocalModels provider",
      ),
    };
  } catch (error) {
    lastConfigError = getErrorMessage(error);
    return { ...DEFAULT_CONFIG, models: [...DEFAULT_MODELS] };
  }
}

function registerZzLocalModels(pi: ExtensionAPI, config: ZzLocalModelsConfig): void {
  if (lastProvider !== config.provider) pi.unregisterProvider(lastProvider);
  lastProvider = config.provider;

  if (!config.enabled) {
    pi.unregisterProvider(config.provider);
    return;
  }

  pi.registerProvider(config.provider, {
    name: config.name,
    baseUrl: config.baseUrl,
    api: "openai-completions",
    apiKey: config.apiKey,
    models: config.models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: ["text"],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        thinkingFormat: "qwen-chat-template",
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
      },
    })),
  });
}

function reloadZzLocalModels(pi: ExtensionAPI, ctx?: ExtensionContext): void {
  const config = readZzLocalModelsConfig(ctx?.cwd ?? process.cwd());
  registerZzLocalModels(pi, config);

  if (ctx && lastConfigError) {
    ctx.ui.notify(`zzLocalModels config ignored: ${lastConfigError}`, "warning");
  }
}

export default function zzLocalModelsExtension(pi: ExtensionAPI): void {
  reloadZzLocalModels(pi);

  pi.on("session_start", (_event, ctx) => reloadZzLocalModels(pi, ctx));
  pi.on("session_tree", (_event, ctx) => reloadZzLocalModels(pi, ctx));
}
