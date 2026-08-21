import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_PROVIDER_CONFIG_ENV = "PI_CHILD_AGENT_PROVIDER_CONFIG";

interface ChildProviderBootstrapConfig {
  readonly baseUrl: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly model: string;
  readonly provider: string;
}

function readBootstrapConfig(): ChildProviderBootstrapConfig {
  const serialized = process.env[CHILD_PROVIDER_CONFIG_ENV];
  if (!serialized) throw new Error(`${CHILD_PROVIDER_CONFIG_ENV} is required.`);

  const value = JSON.parse(serialized) as Partial<ChildProviderBootstrapConfig>;
  if (
    typeof value.provider !== "string" ||
    !value.provider ||
    typeof value.baseUrl !== "string" ||
    !value.baseUrl ||
    typeof value.model !== "string" ||
    !value.model ||
    !Number.isSafeInteger(value.contextWindow) ||
    (value.contextWindow ?? 0) <= 0 ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    (value.maxOutputTokens ?? 0) <= 0
  ) {
    throw new Error(`${CHILD_PROVIDER_CONFIG_ENV} contains invalid provider metadata.`);
  }

  return value as ChildProviderBootstrapConfig;
}

export default function childProviderBootstrap(pi: ExtensionAPI): void {
  const config = readBootstrapConfig();
  pi.registerProvider(config.provider, {
    name: config.provider,
    baseUrl: config.baseUrl,
    api: "openai-completions",
    apiKey: "lm-studio",
    models: [
      {
        id: config.model,
        name: config.model,
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
