export type CustomPlugThinkingLevelV1 =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Public structural form of the complete ChildPiAgentConfig contract. */
export interface CustomPlugChildAgentConfigV1 {
  readonly contextWindow: number;
  readonly endpoint: string;
  readonly endpointSource?: string;
  readonly maxOutputTokens: number;
  readonly model: string;
  readonly modelSelector?: string;
  readonly provider: string;
  readonly providerRegistration?: "openai-compatible" | "none";
  readonly reportMaxChars: number;
  readonly requestTimeoutMs: number;
  readonly systemPrompt: string;
  readonly thinking: CustomPlugThinkingLevelV1;
  readonly tools: readonly string[];
}

export interface CustomPlugChildAgentPromptContextV1 {
  readonly cwd: string;
  readonly task: string;
}

export type CustomPlugChildAgentPromptBuilderV1 = (
  context: CustomPlugChildAgentPromptContextV1,
) => string | Promise<string>;

export interface CustomPlugGeneratedCommandV1 {
  readonly name: string;
  readonly description?: string;
  readonly usage?: string;
}

export interface CustomPlugChildAgentDefinitionV1 {
  readonly id: string;
  readonly description: string;
  readonly config: CustomPlugChildAgentConfigV1;
  readonly buildPrompt?: CustomPlugChildAgentPromptBuilderV1;
  readonly excludeTools?: readonly string[];
  readonly command?: CustomPlugGeneratedCommandV1;
}

export interface CustomPlugCommandContextV1 {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly report: (text: string) => void;
  readonly progress: (text: string) => void;
  readonly runChildAgent: (agentId: string, task: string) => Promise<string>;
}

export type CustomPlugCommandHandlerV1 = (
  args: string,
  context: CustomPlugCommandContextV1,
) => Promise<void>;

export interface CustomPlugCommandDefinitionV1 {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly handler: CustomPlugCommandHandlerV1;
}

export interface CustomPlugRegistrarV1 {
  registerChildAgent(definition: CustomPlugChildAgentDefinitionV1): void;
  registerCommand(definition: CustomPlugCommandDefinitionV1): void;
}

export type CustomPlugRegisterV1 = (
  registrar: CustomPlugRegistrarV1,
) => void | Promise<void>;

export interface CustomPlugDefinitionsV1 {
  readonly childAgents: readonly CustomPlugChildAgentDefinitionV1[];
  readonly commands: readonly CustomPlugCommandDefinitionV1[];
}
