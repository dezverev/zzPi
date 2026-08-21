import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  type ConfigObject,
  getBooleanField,
  getPositiveIntegerField,
  getStringField,
  readJsoncConfig,
} from "./zz-lib/jsonc-config.ts";

const CONFIG_FILE_PATH = ".pi/extensions/zzCodexProxy.config.jsonc";
const DEFAULT_PROVIDER = "zz-codex-proxy";
const DEFAULT_MODEL = "gpt-5.6-sol";

interface ZzCodexProxyConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly contextWindow: number;
  readonly enabled: boolean;
  readonly maxTokens: number;
  readonly model: string;
  readonly name: string;
  readonly provider: string;
}

const DEFAULT_CONFIG: ZzCodexProxyConfig = {
  apiKey: "$ZZ_CODEX_PROXY_KEY",
  baseUrl: "http://127.0.0.1/codex/pi/v1",
  contextWindow: 272_000,
  enabled: true,
  maxTokens: 128_000,
  model: DEFAULT_MODEL,
  name: "OpenAI Codex via zz proxy",
  provider: DEFAULT_PROVIDER,
};

let lastConfigError: string | undefined;
let lastProvider = DEFAULT_PROVIDER;

function nonEmpty(value: string | undefined, fallback: string, label: string): string {
  const candidate = value?.trim() || fallback;
  if (!candidate) throw new Error(`${label} cannot be empty.`);
  return candidate;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("zzCodexProxy baseUrl must start with http:// or https://.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("zzCodexProxy baseUrl must not include a query string or hash.");
  }
  if (trimmed.endsWith("/responses")) return trimmed.slice(0, -"/responses".length);
  return trimmed;
}

function validateFieldTypes(record: ConfigObject): void {
  for (const key of ["apiKey", "baseUrl", "model", "name", "provider"] as const) {
    if (Object.hasOwn(record, key) && typeof record[key] !== "string") {
      throw new Error(`zzCodexProxy ${key} must be a string.`);
    }
  }
  if (Object.hasOwn(record, "enabled") && typeof record.enabled !== "boolean") {
    throw new Error("zzCodexProxy enabled must be a boolean.");
  }
  for (const key of ["contextWindow", "maxTokens"] as const) {
    if (
      Object.hasOwn(record, key)
      && (typeof record[key] !== "number" || !Number.isSafeInteger(record[key]) || record[key] <= 0)
    ) {
      throw new Error(`zzCodexProxy ${key} must be a positive safe integer.`);
    }
  }
}

function readConfig(cwd: string): ZzCodexProxyConfig {
  lastConfigError = undefined;
  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, cwd);
    if (!record) return DEFAULT_CONFIG;
    validateFieldTypes(record);
    return {
      apiKey: nonEmpty(getStringField(record, "apiKey"), DEFAULT_CONFIG.apiKey, "zzCodexProxy apiKey"),
      baseUrl: normalizeBaseUrl(
        nonEmpty(getStringField(record, "baseUrl"), DEFAULT_CONFIG.baseUrl, "zzCodexProxy baseUrl"),
      ),
      contextWindow: getPositiveIntegerField(record, "contextWindow") ?? DEFAULT_CONFIG.contextWindow,
      enabled: getBooleanField(record, "enabled") ?? DEFAULT_CONFIG.enabled,
      maxTokens: getPositiveIntegerField(record, "maxTokens") ?? DEFAULT_CONFIG.maxTokens,
      model: nonEmpty(getStringField(record, "model"), DEFAULT_CONFIG.model, "zzCodexProxy model"),
      name: nonEmpty(getStringField(record, "name"), DEFAULT_CONFIG.name, "zzCodexProxy name"),
      provider: nonEmpty(
        getStringField(record, "provider"),
        DEFAULT_CONFIG.provider,
        "zzCodexProxy provider",
      ),
    };
  } catch (error) {
    lastConfigError = error instanceof Error ? error.message : String(error);
    return { ...DEFAULT_CONFIG, enabled: false };
  }
}

function registerProvider(pi: ExtensionAPI, config: ZzCodexProxyConfig): void {
  if (lastProvider !== config.provider) pi.unregisterProvider(lastProvider);
  lastProvider = config.provider;
  if (!config.enabled) {
    pi.unregisterProvider(config.provider);
    return;
  }

  pi.registerProvider(config.provider, {
    name: config.name,
    baseUrl: config.baseUrl,
    api: "openai-responses",
    apiKey: config.apiKey,
    authHeader: true,
    models: [
      {
        id: config.model,
        name: `${config.model} through zz Codex proxy`,
        reasoning: true,
        thinkingLevelMap: {
          off: "medium",
          minimal: "medium",
          low: "medium",
          medium: "medium",
          high: "medium",
          xhigh: "medium",
          max: "medium",
        },
        input: ["text", "image"],
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsDeveloperRole: true,
          supportsReasoningEffort: true,
          supportsStore: true,
          supportsStrictMode: false,
          sessionAffinityFormat: "openai",
        },
      },
    ],
  });
}

function reload(pi: ExtensionAPI, ctx?: ExtensionContext): void {
  registerProvider(pi, readConfig(ctx?.cwd ?? process.cwd()));
  if (ctx && lastConfigError) {
    ctx.ui.notify(`zzCodexProxy config ignored: ${lastConfigError}`, "warning");
  }
}

export default function zzCodexProxyExtension(pi: ExtensionAPI): void {
  reload(pi);
  pi.on("session_start", (_event, ctx) => reload(pi, ctx));
  pi.on("session_tree", (_event, ctx) => reload(pi, ctx));
}
