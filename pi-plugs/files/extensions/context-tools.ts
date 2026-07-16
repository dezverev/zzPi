import {
  buildSessionContext,
  truncateToVisualLines,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  getBooleanField,
  getErrorMessage,
  getPositiveIntegerField,
  readJsoncConfig,
} from "./zz-lib/jsonc-config.ts";
import {
  registerRightOverlayPane,
  type RightOverlayPaneClient,
  type RightOverlayRenderState,
} from "./lib/right-overlay-tiler.ts";

const PANE_ID = "context-tools";
const CONFIG_FILE_PATH = ".pi/extensions/context-tools.config.jsonc";

interface ContextToolsConfig {
  readonly autoShowDetailsPane: boolean;
  readonly estimatedCharsPerToken: number;
  readonly estimatedImageChars: number;
  readonly maxBashCommands: number;
  readonly maxChildrenPerBucket: number;
  readonly maxLabelLength: number;
  readonly maxRecentOperations: number;
  readonly maxRenderVisualLines: number;
  readonly maxTreeDepth: number;
  readonly overlayOrder: number;
  readonly paneMinWidth: number;
}

const DEFAULT_CONFIG: ContextToolsConfig = {
  autoShowDetailsPane: true,
  estimatedCharsPerToken: 4,
  estimatedImageChars: 4_800,
  maxBashCommands: 8,
  maxChildrenPerBucket: 8,
  maxLabelLength: 72,
  maxRecentOperations: 4,
  maxRenderVisualLines: 1_000,
  maxTreeDepth: 3,
  overlayOrder: 21,
  paneMinWidth: 52,
};

let currentConfig: ContextToolsConfig = { ...DEFAULT_CONFIG };

type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | { readonly type: "image"; readonly data?: string; readonly mimeType?: string }
  | ToolCallBlock
  | { readonly type: string; readonly [key: string]: unknown };

interface ToolCallBlock {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface ToolCallInfo {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

interface ContentMeasurement {
  readonly tokens: number;
  readonly lines: number;
  readonly images: number;
}

interface BucketDescriptor {
  readonly key: string;
  readonly label: string;
}

interface ContextBucket {
  readonly key: string;
  readonly label: string;
  tokens: number;
  lines: number;
  items: number;
  calls: number;
  results: number;
  errors: number;
  argumentTokens: number;
  resultTokens: number;
  lastTouchedAt: number;
  recent: string[];
  children: Map<string, ContextBucket>;
}

interface Measurement {
  readonly tokens?: number;
  readonly lines?: number;
  readonly items?: number;
  readonly calls?: number;
  readonly results?: number;
  readonly errors?: number;
  readonly argumentTokens?: number;
  readonly resultTokens?: number;
  readonly timestamp?: number | undefined;
  readonly recent?: string;
}

interface ContextUsageSnapshot {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

interface ContextTreeState {
  readonly root: ContextBucket;
  usage: ContextUsageSnapshot | undefined;
  knownTokens: number;
  estimateDelta: number | undefined;
  updatedAt: number;
}

const PROMPT_BUCKET: BucketDescriptor = { key: "prompt", label: "Prompt & overhead" };
const CONVERSATION_BUCKET: BucketDescriptor = { key: "conversation", label: "Conversation" };
const TOOL_BUCKET: BucketDescriptor = { key: "tools", label: "Tool calls & results" };

let contextTree = createContextTreeState();
let detailsVisible = false;
let autoShowDetailsPane = true;
let lastContext: ExtensionContext | undefined;
let overlayTiler: RightOverlayPaneClient | undefined;

function loadConfig(ctx: ExtensionContext): void {
  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, ctx.cwd);
    currentConfig = record
      ? {
          autoShowDetailsPane:
            getBooleanField(record, "autoShowDetailsPane") ?? DEFAULT_CONFIG.autoShowDetailsPane,
          estimatedCharsPerToken:
            getPositiveIntegerField(record, "estimatedCharsPerToken") ??
            DEFAULT_CONFIG.estimatedCharsPerToken,
          estimatedImageChars:
            getPositiveIntegerField(record, "estimatedImageChars") ??
            DEFAULT_CONFIG.estimatedImageChars,
          maxBashCommands:
            getPositiveIntegerField(record, "maxBashCommands") ?? DEFAULT_CONFIG.maxBashCommands,
          maxChildrenPerBucket:
            getPositiveIntegerField(record, "maxChildrenPerBucket") ??
            DEFAULT_CONFIG.maxChildrenPerBucket,
          maxLabelLength:
            getPositiveIntegerField(record, "maxLabelLength") ?? DEFAULT_CONFIG.maxLabelLength,
          maxRecentOperations:
            getPositiveIntegerField(record, "maxRecentOperations") ??
            DEFAULT_CONFIG.maxRecentOperations,
          maxRenderVisualLines:
            getPositiveIntegerField(record, "maxRenderVisualLines") ??
            DEFAULT_CONFIG.maxRenderVisualLines,
          maxTreeDepth:
            getPositiveIntegerField(record, "maxTreeDepth") ?? DEFAULT_CONFIG.maxTreeDepth,
          overlayOrder:
            getPositiveIntegerField(record, "overlayOrder") ?? DEFAULT_CONFIG.overlayOrder,
          paneMinWidth:
            getPositiveIntegerField(record, "paneMinWidth") ?? DEFAULT_CONFIG.paneMinWidth,
        }
      : { ...DEFAULT_CONFIG };
  } catch (error) {
    currentConfig = { ...DEFAULT_CONFIG };
    ctx.ui.notify(`context-tools config ignored: ${getErrorMessage(error)}`, "warning");
  }
}

function estimatedImageTokens(): number {
  return Math.ceil(currentConfig.estimatedImageChars / currentConfig.estimatedCharsPerToken);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToolCallBlock(value: unknown): value is ToolCallBlock {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.arguments)
  );
}

function asContentBlocks(value: unknown): ContentBlock[] {
  return Array.isArray(value) ? (value.filter(isRecord) as ContentBlock[]) : [];
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function estimateTokensFromText(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / currentConfig.estimatedCharsPerToken);
}

function compactNumber(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatOutputLineCount(value: number): string {
  return `${compactNumber(value)} output line${value === 1 ? "" : "s"}`;
}

function formatTokenCount(value: number): string {
  return `${compactNumber(value)} token${value === 1 ? "" : "s"}`;
}

function formatTokenEstimate(value: number): string {
  return `~${formatTokenCount(value)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "…";
  return `${value.slice(0, maxLength - 1)}…`;
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function createBucket(key: string, label: string): ContextBucket {
  return {
    key,
    label,
    tokens: 0,
    lines: 0,
    items: 0,
    calls: 0,
    results: 0,
    errors: 0,
    argumentTokens: 0,
    resultTokens: 0,
    lastTouchedAt: 0,
    recent: [],
    children: new Map<string, ContextBucket>(),
  };
}

function createContextTreeState(): ContextTreeState {
  return {
    root: createBucket("root", "Active context"),
    usage: undefined,
    knownTokens: 0,
    estimateDelta: undefined,
    updatedAt: Date.now(),
  };
}

function getChildBucket(parent: ContextBucket, descriptor: BucketDescriptor): ContextBucket {
  const existing = parent.children.get(descriptor.key);
  if (existing) return existing;

  const created = createBucket(descriptor.key, descriptor.label);
  parent.children.set(descriptor.key, created);
  return created;
}

function addToBucket(bucket: ContextBucket, measurement: Measurement): void {
  bucket.tokens += measurement.tokens ?? 0;
  bucket.lines += measurement.lines ?? 0;
  bucket.items += measurement.items ?? 0;
  bucket.calls += measurement.calls ?? 0;
  bucket.results += measurement.results ?? 0;
  bucket.errors += measurement.errors ?? 0;
  bucket.argumentTokens += measurement.argumentTokens ?? 0;
  bucket.resultTokens += measurement.resultTokens ?? 0;

  if (measurement.timestamp !== undefined) {
    bucket.lastTouchedAt = Math.max(bucket.lastTouchedAt, measurement.timestamp);
  }
}

function addMeasurement(
  root: ContextBucket,
  path: readonly BucketDescriptor[],
  measurement: Measurement,
): void {
  const buckets = [root];
  let current = root;

  for (const descriptor of path) {
    current = getChildBucket(current, descriptor);
    buckets.push(current);
  }

  for (const bucket of buckets) {
    addToBucket(bucket, measurement);
  }

  if (measurement.recent) {
    current.recent.unshift(measurement.recent);
    if (current.recent.length > currentConfig.maxRecentOperations) {
      current.recent.length = currentConfig.maxRecentOperations;
    }
  }
}

function measureText(text: string): ContentMeasurement {
  return {
    tokens: estimateTokensFromText(text),
    lines: lineCount(text),
    images: 0,
  };
}

function measureStringOrContent(value: unknown): ContentMeasurement {
  if (typeof value === "string") return measureText(value);

  let tokens = 0;
  let lines = 0;
  let images = 0;

  for (const block of asContentBlocks(value)) {
    if (block.type === "text" && typeof block.text === "string") {
      const measured = measureText(block.text);
      tokens += measured.tokens;
      lines += measured.lines;
    } else if (block.type === "image") {
      tokens += estimatedImageTokens();
      lines += 1;
      images += 1;
    }
  }

  return { tokens, lines, images };
}

function collectText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is { readonly type: "text"; readonly text: string } => {
      return block.type === "text" && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

function imageCount(content: readonly ContentBlock[]): number {
  return content.filter((block) => block.type === "image").length;
}

function measureToolResultContent(value: unknown): ContentMeasurement {
  const blocks = asContentBlocks(value);
  const text = collectText(blocks);
  const images = imageCount(blocks);
  return {
    tokens: estimateTokensFromText(text) + images * estimatedImageTokens(),
    lines: lineCount(text) + images,
    images,
  };
}

function toolFamily(toolName: string): BucketDescriptor {
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    return { key: "file", label: "File tools" };
  }

  if (toolName === "bash") return { key: "bash", label: "Bash commands" };

  return { key: "other", label: "Other tools" };
}

function getBashCommand(input: Record<string, unknown>): string {
  return normalizeInline(getString(input.command) ?? "") || "<empty command>";
}

function buildInputLabel(toolName: string, input: Record<string, unknown>): string {
  let label: string;

  if (toolName === "bash") {
    label = `$ ${getBashCommand(input)}`;
  } else if (toolName === "read") {
    label = `read ${getString(input.path) ?? "<path>"}`;
  } else if (toolName === "write") {
    label = `write ${getString(input.path) ?? "<path>"}`;
  } else if (toolName === "edit") {
    label = `edit ${getString(input.path) ?? "<path>"}`;
  } else if (toolName === "grep") {
    const pattern = getString(input.pattern) ?? "<pattern>";
    const path = getString(input.path) ?? ".";
    const glob = getString(input.glob);
    label = glob ? `grep ${pattern} in ${path} (${glob})` : `grep ${pattern} in ${path}`;
  } else if (toolName === "find") {
    const pattern = getString(input.pattern) ?? "<pattern>";
    const path = getString(input.path) ?? ".";
    label = `find ${pattern} in ${path}`;
  } else if (toolName === "ls") {
    label = `ls ${getString(input.path) ?? "."}`;
  } else {
    label = toolName;
  }

  return truncateEnd(normalizeInline(label), currentConfig.maxLabelLength);
}

function toolPath(toolName: string, input: Record<string, unknown>): BucketDescriptor[] {
  const family = toolFamily(toolName);

  if (family.key === "bash") {
    const command = getBashCommand(input);
    return [TOOL_BUCKET, family, { key: `bash:${command}`, label: `$ ${command}` }];
  }

  if (family.key === "file") {
    return [TOOL_BUCKET, family, { key: `file:${toolName}`, label: toolName }];
  }

  return [TOOL_BUCKET, family, { key: `other:${toolName}`, label: toolName }];
}

function recordSystemPrompt(root: ContextBucket, systemPrompt: string): void {
  const measured = measureText(systemPrompt);
  if (measured.tokens === 0) return;

  addMeasurement(root, [PROMPT_BUCKET, { key: "system", label: "System prompt" }], {
    tokens: measured.tokens,
    lines: measured.lines,
    items: 1,
    recent: `${formatTokenEstimate(measured.tokens)} system prompt`,
  });
}

function recordActiveToolDefinitions(root: ContextBucket, pi: ExtensionAPI): void {
  const activeNames = new Set(pi.getActiveTools());
  const activeTools = pi
    .getAllTools()
    .filter((tool) => activeNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      promptGuidelines: tool.promptGuidelines,
    }));

  if (activeTools.length === 0) return;

  const serialized = serializeJson(activeTools);
  const measured = measureText(serialized);
  if (measured.tokens === 0) return;

  addMeasurement(
    root,
    [PROMPT_BUCKET, { key: "tool-definitions", label: "Active tool definitions" }],
    {
      tokens: measured.tokens,
      lines: measured.lines,
      items: activeTools.length,
      recent: `${activeTools.length} active tool definition${activeTools.length === 1 ? "" : "s"}`,
    },
  );
}

function recordResidualOverhead(root: ContextBucket, residualTokens: number): void {
  if (residualTokens <= 0) return;

  addMeasurement(
    root,
    [PROMPT_BUCKET, { key: "residual", label: "Provider overhead / tokenizer drift" }],
    {
      tokens: residualTokens,
      items: 1,
      recent: `${formatTokenEstimate(residualTokens)} unattributed by estimates`,
    },
  );
}

function recordUserMessage(root: ContextBucket, message: Record<string, unknown>): void {
  const measured = measureStringOrContent(message.content);
  if (measured.tokens === 0 && measured.images === 0) return;

  const imageSuffix =
    measured.images > 0 ? ` + ${measured.images} image${measured.images === 1 ? "" : "s"}` : "";
  addMeasurement(root, [CONVERSATION_BUCKET, { key: "user", label: "User prompts" }], {
    tokens: measured.tokens,
    lines: measured.lines,
    items: 1,
    timestamp: getNumber(message.timestamp),
    recent: `user prompt · ${formatTokenEstimate(measured.tokens)}${imageSuffix}`,
  });
}

function recordAssistantBlock(
  root: ContextBucket,
  label: BucketDescriptor,
  text: string,
  timestamp: number | undefined,
): void {
  const measured = measureText(text);
  if (measured.tokens === 0) return;

  addMeasurement(
    root,
    [CONVERSATION_BUCKET, { key: "assistant", label: "Agent responses" }, label],
    {
      tokens: measured.tokens,
      lines: measured.lines,
      items: 1,
      timestamp,
      recent: `${label.label} · ${formatTokenEstimate(measured.tokens)}`,
    },
  );
}

function recordToolCall(
  root: ContextBucket,
  block: ToolCallBlock,
  toolCalls: Map<string, ToolCallInfo>,
  timestamp: number | undefined,
): void {
  toolCalls.set(block.id, { toolName: block.name, input: block.arguments });

  const serializedArguments = serializeJson(block.arguments);
  const argumentText = `${block.name} ${serializedArguments}`;
  const measured = measureText(argumentText);
  const label = buildInputLabel(block.name, block.arguments);

  addMeasurement(root, toolPath(block.name, block.arguments), {
    tokens: measured.tokens,
    lines: measured.lines,
    calls: 1,
    argumentTokens: measured.tokens,
    timestamp,
    recent: `${label} · call args ${formatTokenEstimate(measured.tokens)}`,
  });
}

function recordAssistantMessage(
  root: ContextBucket,
  message: Record<string, unknown>,
  toolCalls: Map<string, ToolCallInfo>,
): void {
  const timestamp = getNumber(message.timestamp);

  for (const block of asContentBlocks(message.content)) {
    if (block.type === "text" && typeof block.text === "string") {
      recordAssistantBlock(root, { key: "text", label: "Response text" }, block.text, timestamp);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      recordAssistantBlock(root, { key: "thinking", label: "Thinking" }, block.thinking, timestamp);
    } else if (isToolCallBlock(block)) {
      recordToolCall(root, block, toolCalls, timestamp);
    }
  }
}

function recordToolResultMessage(
  root: ContextBucket,
  message: Record<string, unknown>,
  toolCalls: ReadonlyMap<string, ToolCallInfo>,
): void {
  const toolName = getString(message.toolName);
  const toolCallId = getString(message.toolCallId);
  if (!toolName) return;

  const call = toolCallId ? toolCalls.get(toolCallId) : undefined;
  const input = call?.input ?? {};
  const measured = measureToolResultContent(message.content);
  const isError = message.isError === true;
  const label = buildInputLabel(toolName, input);
  const imageSuffix =
    measured.images > 0 ? ` + ${measured.images} image${measured.images === 1 ? "" : "s"}` : "";

  addMeasurement(root, toolPath(toolName, input), {
    tokens: measured.tokens,
    lines: measured.lines,
    results: 1,
    errors: isError ? 1 : 0,
    resultTokens: measured.tokens,
    timestamp: getNumber(message.timestamp),
    recent: `${label} · ${isError ? "error · " : ""}${formatOutputLineCount(measured.lines)}${imageSuffix} · result ${formatTokenEstimate(measured.tokens)}`,
  });
}

function recordCustomMessage(root: ContextBucket, message: Record<string, unknown>): void {
  const customType = getString(message.customType) ?? "custom";
  const measured = measureStringOrContent(message.content);
  if (measured.tokens === 0 && measured.images === 0) return;

  addMeasurement(
    root,
    [
      CONVERSATION_BUCKET,
      { key: "custom", label: "Custom context messages" },
      { key: customType, label: customType },
    ],
    {
      tokens: measured.tokens,
      lines: measured.lines,
      items: 1,
      timestamp: getNumber(message.timestamp),
      recent: `${customType} · ${formatTokenEstimate(measured.tokens)}`,
    },
  );
}

function recordSummaryMessage(
  root: ContextBucket,
  message: Record<string, unknown>,
  summaryKind: "branch" | "compaction",
): void {
  const summary = getString(message.summary) ?? "";
  const label = summaryKind === "branch" ? "Branch summaries" : "Compaction summaries";
  const measured = measureText(summary);
  if (measured.tokens === 0) return;

  const tokensBefore = getNumber(message.tokensBefore);
  const beforeSuffix = tokensBefore ? ` from ${formatTokenEstimate(tokensBefore)}` : "";

  addMeasurement(
    root,
    [CONVERSATION_BUCKET, { key: "summaries", label: "Summaries" }, { key: summaryKind, label }],
    {
      tokens: measured.tokens,
      lines: measured.lines,
      items: 1,
      timestamp: getNumber(message.timestamp),
      recent: `${label} · ${formatTokenEstimate(measured.tokens)}${beforeSuffix}`,
    },
  );
}

function bashExecutionText(message: Record<string, unknown>): string {
  const command = getString(message.command) ?? "";
  const output = getString(message.output) ?? "";
  let text = `Ran \`${command}\`\n`;

  if (output) {
    text += `\`\`\`\n${output}\n\`\`\``;
  } else {
    text += "(no output)";
  }

  if (message.cancelled === true) {
    text += "\n\n(command cancelled)";
  } else {
    const exitCode = getNumber(message.exitCode);
    if (exitCode !== undefined && exitCode !== 0) {
      text += `\n\nCommand exited with code ${exitCode}`;
    }
  }

  if (message.truncated === true && typeof message.fullOutputPath === "string") {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }

  return text;
}

function recordBashExecutionMessage(root: ContextBucket, message: Record<string, unknown>): void {
  if (message.excludeFromContext === true) return;

  const command = normalizeInline(getString(message.command) ?? "") || "<empty command>";
  const measured = measureText(bashExecutionText(message));
  const exitCode = getNumber(message.exitCode);
  const isError = message.cancelled === true || (exitCode !== undefined && exitCode !== 0);

  addMeasurement(
    root,
    [
      CONVERSATION_BUCKET,
      { key: "user-bash", label: "User shell (!)" },
      { key: `user-bash:${command}`, label: `! ${command}` },
    ],
    {
      tokens: measured.tokens,
      lines: measured.lines,
      items: 1,
      errors: isError ? 1 : 0,
      timestamp: getNumber(message.timestamp),
      recent: `! ${command} · ${formatTokenEstimate(measured.tokens)}`,
    },
  );
}

function recordContextMessages(root: ContextBucket, messages: readonly unknown[]): void {
  const toolCalls = new Map<string, ToolCallInfo>();

  for (const rawMessage of messages) {
    if (!isRecord(rawMessage)) continue;

    if (rawMessage.role === "user") {
      recordUserMessage(root, rawMessage);
    } else if (rawMessage.role === "assistant") {
      recordAssistantMessage(root, rawMessage, toolCalls);
    } else if (rawMessage.role === "toolResult") {
      recordToolResultMessage(root, rawMessage, toolCalls);
    } else if (rawMessage.role === "custom") {
      recordCustomMessage(root, rawMessage);
    } else if (rawMessage.role === "branchSummary") {
      recordSummaryMessage(root, rawMessage, "branch");
    } else if (rawMessage.role === "compactionSummary") {
      recordSummaryMessage(root, rawMessage, "compaction");
    } else if (rawMessage.role === "bashExecution") {
      recordBashExecutionMessage(root, rawMessage);
    }
  }
}

function getContextMessages(
  ctx: ExtensionContext,
  messagesOverride?: readonly unknown[],
): readonly unknown[] {
  if (messagesOverride) return messagesOverride;

  return buildSessionContext(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId())
    .messages;
}

function rebuildContextTree(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  options: {
    readonly systemPrompt?: string | undefined;
    readonly messages?: readonly unknown[] | undefined;
  } = {},
): void {
  const next = createContextTreeState();

  recordSystemPrompt(next.root, options.systemPrompt ?? ctx.getSystemPrompt());
  recordActiveToolDefinitions(next.root, pi);
  recordContextMessages(next.root, getContextMessages(ctx, options.messages));

  next.knownTokens = next.root.tokens;
  const usage = ctx.getContextUsage();
  next.usage = usage
    ? {
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        percent: usage.percent,
      }
    : undefined;

  if (usage?.tokens !== null && usage?.tokens !== undefined) {
    next.estimateDelta = usage.tokens - next.root.tokens;
    recordResidualOverhead(next.root, next.estimateDelta);
  }

  next.updatedAt = Date.now();
  contextTree = next;
}

function sortedChildren(bucket: ContextBucket): ContextBucket[] {
  return [...bucket.children.values()].sort((left, right) => {
    const byTokens = right.tokens - left.tokens;
    if (byTokens !== 0) return byTokens;

    const byCalls = right.calls - left.calls;
    if (byCalls !== 0) return byCalls;

    const byResults = right.results - left.results;
    if (byResults !== 0) return byResults;

    const byItems = right.items - left.items;
    if (byItems !== 0) return byItems;

    return right.lastTouchedAt - left.lastTouchedAt;
  });
}

function maxChildrenForBucket(bucket: ContextBucket): number {
  if (bucket.key === "bash") return currentConfig.maxBashCommands;
  return currentConfig.maxChildrenPerBucket;
}

function hasVisibleContext(bucket: ContextBucket): boolean {
  return (
    bucket.tokens > 0 ||
    bucket.lines > 0 ||
    bucket.items > 0 ||
    bucket.calls > 0 ||
    bucket.results > 0 ||
    bucket.errors > 0
  );
}

function formatShare(tokens: number, totalTokens: number): string | undefined {
  if (tokens <= 0 || totalTokens <= 0) return undefined;
  return formatPercent((tokens / totalTokens) * 100);
}

function formatBucketStats(bucket: ContextBucket, totalTokens: number): string {
  const parts = [formatTokenEstimate(bucket.tokens)];
  const share = formatShare(bucket.tokens, totalTokens);
  if (share) parts.push(share);
  if (bucket.lines > 0)
    parts.push(`${compactNumber(bucket.lines)} line${bucket.lines === 1 ? "" : "s"}`);

  if (bucket.calls > 0) {
    parts.push(`${compactNumber(bucket.calls)} call${bucket.calls === 1 ? "" : "s"}`);
  } else if (bucket.items > 0) {
    parts.push(`${compactNumber(bucket.items)} item${bucket.items === 1 ? "" : "s"}`);
  }

  if (bucket.results > 0 && bucket.results !== bucket.calls) {
    parts.push(`${compactNumber(bucket.results)} result${bucket.results === 1 ? "" : "s"}`);
  }

  if (bucket.argumentTokens > 0 || bucket.resultTokens > 0) {
    parts.push(
      `args ${formatTokenEstimate(bucket.argumentTokens)} · results ${formatTokenEstimate(bucket.resultTokens)}`,
    );
  }

  if (bucket.errors > 0) {
    parts.push(`${compactNumber(bucket.errors)} error${bucket.errors === 1 ? "" : "s"}`);
  }

  return parts.join(" · ");
}

function formatContextUsageLine(ctx: ExtensionContext): string | undefined {
  const usage = contextTree.usage ?? ctx.getContextUsage();
  if (!usage) return undefined;

  const theme = ctx.ui.theme;
  const tokens = usage.tokens === null ? "unknown tokens" : formatTokenEstimate(usage.tokens);
  const percent = usage.percent === null ? "" : ` (${formatPercent(usage.percent)})`;

  return `${theme.fg("accent", "Pi context")} ${theme.fg(
    "dim",
    `· ${tokens} / ${formatTokenCount(usage.contextWindow)}${percent}`,
  )}`;
}

function formatEstimateLine(ctx: ExtensionContext): string {
  const theme = ctx.ui.theme;
  const residual = Math.max(0, contextTree.root.tokens - contextTree.knownTokens);
  const parts = [`known buckets ${formatTokenEstimate(contextTree.knownTokens)}`];

  if (residual > 0) parts.push(`residual ${formatTokenEstimate(residual)}`);

  if (contextTree.estimateDelta !== undefined && contextTree.estimateDelta < 0) {
    parts.push(`estimate over Pi by ${formatTokenEstimate(Math.abs(contextTree.estimateDelta))}`);
  }

  return theme.fg("dim", parts.join(" · "));
}

function styleBucketLabel(bucket: ContextBucket, depth: number, ctx: ExtensionContext): string {
  const theme = ctx.ui.theme;
  const label = truncateEnd(bucket.label, currentConfig.maxLabelLength);

  if (bucket.errors > 0) return theme.fg("warning", label);
  if (depth <= 1) return theme.fg("accent", label);
  if (depth === 2) return theme.fg("muted", label);
  return label;
}

function appendBucketLines(
  lines: string[],
  bucket: ContextBucket,
  ctx: ExtensionContext,
  prefix: string,
  isLast: boolean,
  depth: number,
  totalTokens: number,
): void {
  const theme = ctx.ui.theme;
  const connector = `${prefix}${isLast ? "└─" : "├─"}`;
  const nextPrefix = `${prefix}${isLast ? "  " : "│ "}`;
  const label = styleBucketLabel(bucket, depth, ctx);
  const stats = theme.fg("dim", formatBucketStats(bucket, totalTokens));

  lines.push(`${connector} ${label} ${stats}`);

  if (depth >= currentConfig.maxTreeDepth) return;

  const children = sortedChildren(bucket).filter(hasVisibleContext);
  const maxChildren = maxChildrenForBucket(bucket);
  const shown = children.slice(0, maxChildren);
  const hidden = children.length - shown.length;

  shown.forEach((child, index) => {
    appendBucketLines(
      lines,
      child,
      ctx,
      nextPrefix,
      index === shown.length - 1 && hidden === 0,
      depth + 1,
      totalTokens,
    );
  });

  if (hidden > 0) {
    lines.push(
      `${nextPrefix}${theme.fg("dim", `└─ … ${hidden} more item${hidden === 1 ? "" : "s"}`)}`,
    );
  }
}

function buildDetailsLines(ctx: ExtensionContext): string[] {
  const theme = ctx.ui.theme;
  const usageLine = formatContextUsageLine(ctx);

  if (contextTree.root.tokens === 0) {
    return [
      ...(usageLine ? [usageLine] : []),
      theme.fg("dim", "No context tree data tracked yet."),
      theme.fg(
        "dim",
        "The pane rebuilds from active system prompt, messages, tool calls, and tool results.",
      ),
    ];
  }

  const lines = [
    `${theme.fg("accent", "Active context tree")} ${theme.fg(
      "dim",
      `· ${formatTokenEstimate(contextTree.root.tokens)} estimated`,
    )}`,
    ...(usageLine ? [usageLine] : []),
    formatEstimateLine(ctx),
    theme.fg(
      "dim",
      "Estimates use 4 chars/token; residual covers provider/tool-schema overhead and tokenizer drift.",
    ),
  ];

  const children = sortedChildren(contextTree.root).filter(hasVisibleContext);
  children.forEach((child, index) => {
    appendBucketLines(
      lines,
      child,
      ctx,
      "",
      index === children.length - 1,
      1,
      contextTree.root.tokens,
    );
  });

  return lines;
}

function ansiSequenceLength(value: string, index: number): number {
  if (value.charCodeAt(index) !== 0x1b || value[index + 1] !== "[") return 0;

  for (let cursor = index + 2; cursor < value.length; cursor++) {
    const code = value.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) {
      return cursor - index + 1;
    }
  }

  return 0;
}

function visibleLength(value: string): number {
  let visible = 0;
  for (let index = 0; index < value.length; ) {
    const ansiLength = ansiSequenceLength(value, index);
    if (ansiLength > 0) {
      index += ansiLength;
      continue;
    }

    const char = Array.from(value.slice(index))[0];
    if (!char) break;
    visible += 1;
    index += char.length;
  }

  return visible;
}

function truncateAnsi(value: string, maxWidth: number): string {
  if (visibleLength(value) <= maxWidth) return value;
  if (maxWidth <= 1) return "…";

  let output = "";
  let visible = 0;
  for (let index = 0; index < value.length; ) {
    const ansiLength = ansiSequenceLength(value, index);
    if (ansiLength > 0) {
      output += value.slice(index, index + ansiLength);
      index += ansiLength;
      continue;
    }

    const char = Array.from(value.slice(index))[0];
    if (!char || visible >= maxWidth - 1) break;
    output += char;
    visible += 1;
    index += char.length;
  }

  return `${output}…`;
}

function padAnsi(value: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(value));
  return `${value}${" ".repeat(padding)}`;
}

function panelLine(content: string, width: number, border: (value: string) => string): string {
  if (width < 8) return truncateAnsi(content, width);

  const innerWidth = width - 4;
  const truncated = truncateAnsi(content, innerWidth);
  return `${border("│")} ${padAnsi(truncated, innerWidth)} ${border("│")}`;
}

function panelBorder(
  title: string | undefined,
  width: number,
  border: (value: string) => string,
): string {
  if (width < 8) return border("─".repeat(Math.max(1, width)));
  if (!title) return border(`╰${"─".repeat(width - 2)}╯`);

  const label = ` ${title} `;
  const remaining = Math.max(0, width - 2 - visibleLength(label));
  return border(`╭${label}${"─".repeat(remaining)}╮`);
}

function buildDetailsPaneLines(
  ctx: ExtensionContext,
  width: number,
  state: RightOverlayRenderState,
): string[] {
  const theme = ctx.ui.theme;
  const border = (value: string) => theme.fg(state.focused ? "borderAccent" : "borderMuted", value);
  const wrapped = truncateToVisualLines(
    buildDetailsLines(ctx).join("\n"),
    currentConfig.maxRenderVisualLines,
    Math.max(8, width - 4),
    0,
  ).visualLines;

  return [
    panelBorder("Context Tree", width, border),
    ...wrapped.map((line) => panelLine(line, width, border)),
    panelBorder(undefined, width, border),
  ];
}

function getEffectiveContext(ctx?: ExtensionContext): ExtensionContext | undefined {
  return ctx ?? lastContext;
}

function isDetailsPaneActuallyVisible(ctx?: ExtensionContext): boolean {
  const effectiveContext = getEffectiveContext(ctx);
  return (effectiveContext?.hasUI ?? true) && detailsVisible;
}

function syncDetailsPaneVisibility(ctx?: ExtensionContext): void {
  const actualVisible = isDetailsPaneActuallyVisible(ctx);
  overlayTiler?.setVisible(actualVisible);
  if (actualVisible) overlayTiler?.requestRender();
}

function applyContextTools(ctx: ExtensionContext): void {
  lastContext = ctx;
  if (!ctx.hasUI) return;
  overlayTiler?.requestRender();
}

interface HideDetailsPaneOptions {
  readonly disableAutoShow?: boolean;
}

function hideDetailsPane(options: HideDetailsPaneOptions = {}): void {
  if (options.disableAutoShow) autoShowDetailsPane = false;

  detailsVisible = false;
  syncDetailsPaneVisibility();
}

function showDetailsPane(ctx: ExtensionContext): void {
  lastContext = ctx;
  if (!ctx.hasUI) return;

  detailsVisible = true;
  syncDetailsPaneVisibility(ctx);
}

function clearContextTools(ctx: ExtensionContext): void {
  contextTree = createContextTreeState();
  applyContextTools(ctx);
}

function maybeShowDefaultDetailsPane(ctx: ExtensionContext): void {
  if (autoShowDetailsPane) showDetailsPane(ctx);
}

export default function contextToolsExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    loadConfig(ctx);
    overlayTiler ??= registerRightOverlayPane(pi, {
      id: PANE_ID,
      order: currentConfig.overlayOrder,
      minWidth: currentConfig.paneMinWidth,
      render: (width, state) => buildDetailsPaneLines(ctx, width, state),
    });
    detailsVisible = false;
    autoShowDetailsPane = currentConfig.autoShowDetailsPane;
    syncDetailsPaneVisibility(ctx);

    rebuildContextTree(ctx, pi);
    applyContextTools(ctx);

    if (!ctx.hasUI) return;
    maybeShowDefaultDetailsPane(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    rebuildContextTree(ctx, pi, { systemPrompt: event.systemPrompt });
    applyContextTools(ctx);
    maybeShowDefaultDetailsPane(ctx);
  });

  pi.on("context", (event, ctx) => {
    rebuildContextTree(ctx, pi, { messages: event.messages });
    applyContextTools(ctx);
    maybeShowDefaultDetailsPane(ctx);
  });

  pi.on("message_end", (_event, ctx) => {
    rebuildContextTree(ctx, pi);
    applyContextTools(ctx);
    maybeShowDefaultDetailsPane(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    rebuildContextTree(ctx, pi);
    applyContextTools(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    rebuildContextTree(ctx, pi);
    applyContextTools(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    rebuildContextTree(ctx, pi);
    applyContextTools(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    rebuildContextTree(ctx, pi);
    applyContextTools(ctx);
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    rebuildContextTree(ctx, pi);
    applyContextTools(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    detailsVisible = false;
    clearContextTools(ctx);
    hideDetailsPane();
    overlayTiler?.dispose();
    overlayTiler = undefined;
    lastContext = undefined;
  });

  pi.registerCommand("context-tools", {
    description: "Toggle the right-side context tree pane, or use: show, hide, refresh, clear",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim().toLowerCase();
      const options = ["show", "hide", "refresh", "clear"];
      return options
        .filter((option) => option.startsWith(trimmed))
        .map((option) => ({ value: option, label: option }));
    },
    handler: (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "hide" || (action === "" && detailsVisible)) {
        hideDetailsPane({ disableAutoShow: true });
        ctx.ui.notify("Context tree hidden", "info");
        applyContextTools(ctx);
        return Promise.resolve();
      }

      if (action === "refresh") {
        rebuildContextTree(ctx, pi);
        applyContextTools(ctx);
        showDetailsPane(ctx);
        ctx.ui.notify("Context tree rebuilt from active session context", "info");
        return Promise.resolve();
      }

      if (action === "clear") {
        clearContextTools(ctx);
        showDetailsPane(ctx);
        ctx.ui.notify("Context tree cleared for this runtime", "info");
        return Promise.resolve();
      }

      showDetailsPane(ctx);
      applyContextTools(ctx);
      if (action === "show") ctx.ui.notify("Context tree shown", "info");
      return Promise.resolve();
    },
  });
}
