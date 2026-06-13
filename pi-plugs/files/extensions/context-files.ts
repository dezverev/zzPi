import { isAbsolute, relative, resolve } from "node:path";

import {
  isEditToolResult,
  isReadToolResult,
  isWriteToolResult,
  truncateToVisualLines,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  getBooleanField,
  getErrorMessage,
  getPositiveIntegerField,
  readJsoncConfig,
} from "./lib/jsonc-config.ts";
import {
  registerRightOverlayPane,
  type RightOverlayPaneClient,
  type RightOverlayRenderState,
} from "./lib/right-overlay-tiler.ts";

const STATUS_KEY = "context-files";
const CONFIG_FILE_PATH = ".pi/extensions/context-files.config.jsonc";

interface ContextFilesConfig {
  readonly autoShowDetailsPane: boolean;
  readonly estimatedCharsPerToken: number;
  readonly maxFilesInPane: number;
  readonly maxPathLength: number;
  readonly maxRecentOperations: number;
  readonly maxRenderVisualLines: number;
  readonly overlayOrder: number;
  readonly paneMinWidth: number;
}

const DEFAULT_CONFIG: ContextFilesConfig = {
  autoShowDetailsPane: false,
  estimatedCharsPerToken: 4,
  maxFilesInPane: 12,
  maxPathLength: 96,
  maxRecentOperations: 5,
  maxRenderVisualLines: 1_000,
  overlayOrder: 20,
  paneMinWidth: 52,
};

let currentConfig: ContextFilesConfig = { ...DEFAULT_CONFIG };

type TrackedToolName = "read" | "write" | "edit";

type ResultContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data?: string; readonly mimeType?: string }
  | { readonly type: string; readonly [key: string]: unknown };

interface ToolCallBlock {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface TruncationDetails {
  readonly truncated?: boolean | undefined;
  readonly totalLines?: number | undefined;
  readonly outputLines?: number | undefined;
  readonly firstLineExceedsLimit?: boolean | undefined;
}

interface ReadDetails {
  readonly truncation?: TruncationDetails;
}

interface FileOperation {
  readonly kind: TrackedToolName;
  readonly lines: number;
  readonly tokens: number;
  readonly summary: string;
  readonly timestamp: number;
}

interface FileStats {
  readonly path: string;
  touches: number;
  reads: number;
  writes: number;
  edits: number;
  actualLines: number;
  estimatedTokens: number;
  readLines: number;
  readTokens: number;
  writeLines: number;
  writeTokens: number;
  editLines: number;
  editTokens: number;
  lastTouchedAt: number;
  recent: FileOperation[];
}

interface Totals {
  readonly files: number;
  readonly touches: number;
  readonly actualLines: number;
  readonly estimatedTokens: number;
}

const fileStats = new Map<string, FileStats>();

let detailsVisible = false;
let autoShowDetailsPane = false;
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
          maxFilesInPane:
            getPositiveIntegerField(record, "maxFilesInPane") ?? DEFAULT_CONFIG.maxFilesInPane,
          maxPathLength:
            getPositiveIntegerField(record, "maxPathLength") ?? DEFAULT_CONFIG.maxPathLength,
          maxRecentOperations:
            getPositiveIntegerField(record, "maxRecentOperations") ??
            DEFAULT_CONFIG.maxRecentOperations,
          maxRenderVisualLines:
            getPositiveIntegerField(record, "maxRenderVisualLines") ??
            DEFAULT_CONFIG.maxRenderVisualLines,
          overlayOrder:
            getPositiveIntegerField(record, "overlayOrder") ?? DEFAULT_CONFIG.overlayOrder,
          paneMinWidth:
            getPositiveIntegerField(record, "paneMinWidth") ?? DEFAULT_CONFIG.paneMinWidth,
        }
      : { ...DEFAULT_CONFIG };
  } catch (error) {
    currentConfig = { ...DEFAULT_CONFIG };
    ctx.ui.notify(`context-files config ignored: ${getErrorMessage(error)}`, "warning");
  }
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

function asResultContentBlocks(value: unknown): ResultContentBlock[] {
  return Array.isArray(value) ? (value.filter(isRecord) as ResultContentBlock[]) : [];
}

function stripPathPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function normalizePath(rawPath: string, ctx: ExtensionContext): string {
  const stripped = stripPathPrefix(rawPath);
  const absolutePath = isAbsolute(stripped) ? stripped : resolve(ctx.cwd, stripped);
  const relativePath = relative(ctx.cwd, absolutePath);

  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return absolutePath;
  }

  return relativePath;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(0, maxLength - 1);
  return `…${value.slice(value.length - keep)}`;
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

function formatActualLineCount(value: number): string {
  return `${compactNumber(value)} actual line${value === 1 ? "" : "s"}`;
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

function collectText(content: readonly ResultContentBlock[]): string {
  return content
    .filter((block): block is { readonly type: "text"; readonly text: string } => {
      return block.type === "text" && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

function stripReadContinuationNotice(text: string): string {
  return text.replace(
    /\n\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^)]+\))?\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]$/u,
    "",
  );
}

function getReadFileText(
  text: string,
  images: number,
  readDetails: ReadDetails | undefined,
  hasUserLimit: boolean,
): string {
  if (images > 0) return "";
  if (readDetails?.truncation?.firstLineExceedsLimit === true) return "";

  const hasContinuationNotice = readDetails?.truncation?.truncated === true || hasUserLimit;
  return hasContinuationNotice ? stripReadContinuationNotice(text) : text;
}

function imageCount(content: readonly ResultContentBlock[]): number {
  return content.filter((block) => block.type === "image").length;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ensureFileStats(path: string): FileStats {
  const existing = fileStats.get(path);
  if (existing) return existing;

  const created: FileStats = {
    path,
    touches: 0,
    reads: 0,
    writes: 0,
    edits: 0,
    actualLines: 0,
    estimatedTokens: 0,
    readLines: 0,
    readTokens: 0,
    writeLines: 0,
    writeTokens: 0,
    editLines: 0,
    editTokens: 0,
    lastTouchedAt: 0,
    recent: [],
  };
  fileStats.set(path, created);
  return created;
}

function addOperation(path: string, operation: FileOperation): void {
  const stats = ensureFileStats(path);

  stats.touches += 1;
  stats.actualLines += operation.lines;
  stats.estimatedTokens += operation.tokens;
  stats.lastTouchedAt = operation.timestamp;

  if (operation.kind === "read") {
    stats.reads += 1;
    stats.readLines += operation.lines;
    stats.readTokens += operation.tokens;
  } else if (operation.kind === "write") {
    stats.writes += 1;
    stats.writeLines += operation.lines;
    stats.writeTokens += operation.tokens;
  } else {
    stats.edits += 1;
    stats.editLines += operation.lines;
    stats.editTokens += operation.tokens;
  }

  stats.recent.unshift(operation);
  if (stats.recent.length > currentConfig.maxRecentOperations) {
    stats.recent.length = currentConfig.maxRecentOperations;
  }
}

function getReadDetails(details: unknown): ReadDetails | undefined {
  if (!isRecord(details)) return undefined;
  const truncation = details.truncation;
  if (!isRecord(truncation)) return {};

  return {
    truncation: {
      truncated: typeof truncation.truncated === "boolean" ? truncation.truncated : undefined,
      totalLines: getNumber(truncation.totalLines),
      outputLines: getNumber(truncation.outputLines),
      firstLineExceedsLimit:
        typeof truncation.firstLineExceedsLimit === "boolean"
          ? truncation.firstLineExceedsLimit
          : undefined,
    },
  };
}

function recordRead(
  input: Record<string, unknown>,
  content: readonly ResultContentBlock[],
  details: unknown,
  ctx: ExtensionContext,
  timestamp: number,
): void {
  const rawPath = getString(input.path);
  if (!rawPath) return;

  const text = collectText(content);
  const images = imageCount(content);
  const readDetails = getReadDetails(details);
  const fileText = getReadFileText(text, images, readDetails, getNumber(input.limit) !== undefined);
  const lines =
    readDetails?.truncation?.firstLineExceedsLimit === true
      ? 0
      : (readDetails?.truncation?.outputLines ?? lineCount(fileText));
  const tokens = estimateTokensFromText(fileText);
  const totalLines = readDetails?.truncation?.totalLines;
  const truncated = readDetails?.truncation?.truncated === true;
  const offset = Math.max(1, Math.floor(getNumber(input.offset) ?? 1));
  const endLine = lines > 0 ? offset + lines - 1 : offset;
  const range = lines > 0 ? ` @ ${offset}-${endLine}` : "";
  const imageSuffix = images > 0 ? ` + ${images} image${images === 1 ? "" : "s"}` : "";
  const summary =
    images > 0 && lines === 0
      ? `read ${images} image${images === 1 ? "" : "s"}`
      : truncated && totalLines !== undefined
        ? `read ${compactNumber(lines)} of ${formatActualLineCount(totalLines)} (${formatTokenEstimate(tokens)})${range}${imageSuffix}`
        : `read ${formatActualLineCount(lines)} (${formatTokenEstimate(tokens)})${range}${imageSuffix}`;

  addOperation(normalizePath(rawPath, ctx), {
    kind: "read",
    lines,
    tokens,
    summary,
    timestamp,
  });
}

function recordWrite(
  input: Record<string, unknown>,
  ctx: ExtensionContext,
  timestamp: number,
): void {
  const rawPath = getString(input.path);
  const content = getString(input.content);
  if (!rawPath || content === undefined) return;

  const lines = lineCount(content);
  const tokens = estimateTokensFromText(content);
  addOperation(normalizePath(rawPath, ctx), {
    kind: "write",
    lines,
    tokens,
    summary: `write ${formatActualLineCount(lines)} (${formatTokenEstimate(tokens)})`,
    timestamp,
  });
}

function recordEdit(
  input: Record<string, unknown>,
  ctx: ExtensionContext,
  timestamp: number,
): void {
  const rawPath = getString(input.path);
  if (!rawPath) return;

  const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [];
  let lines = 0;
  let tokens = 0;

  for (const edit of edits) {
    const oldText = getString(edit.oldText) ?? "";
    const newText = getString(edit.newText) ?? "";
    lines += lineCount(oldText) + lineCount(newText);
    tokens += estimateTokensFromText(oldText) + estimateTokensFromText(newText);
  }

  addOperation(normalizePath(rawPath, ctx), {
    kind: "edit",
    lines,
    tokens,
    summary: `edit ${formatActualLineCount(lines)} (${formatTokenEstimate(tokens)}) old+new in ${edits.length} block${edits.length === 1 ? "" : "s"}`,
    timestamp,
  });
}

function recordToolResult(
  toolName: string,
  input: Record<string, unknown>,
  content: readonly ResultContentBlock[],
  details: unknown,
  isError: boolean,
  ctx: ExtensionContext,
  timestamp = Date.now(),
): void {
  if (isError) return;

  if (toolName === "read") {
    recordRead(input, content, details, ctx, timestamp);
  } else if (toolName === "write") {
    recordWrite(input, ctx, timestamp);
  } else if (toolName === "edit") {
    recordEdit(input, ctx, timestamp);
  }
}

function rebuildFromSession(ctx: ExtensionContext): void {
  fileStats.clear();

  const toolCalls = new Map<
    string,
    { readonly name: string; readonly args: Record<string, unknown> }
  >();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;

    const message = entry.message as {
      readonly role?: string;
      readonly content?: unknown;
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly details?: unknown;
      readonly isError?: boolean;
      readonly timestamp?: number;
    };

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isToolCallBlock(block)) {
          toolCalls.set(block.id, { name: block.name, args: block.arguments });
        }
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") continue;

    const call = toolCalls.get(message.toolCallId);
    const input = call?.args ?? {};
    const timestamp =
      typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
    recordToolResult(
      message.toolName,
      input,
      asResultContentBlocks(message.content),
      message.details,
      message.isError === true,
      ctx,
      Number.isFinite(timestamp) ? timestamp : Date.now(),
    );
  }
}

function sortedFiles(): FileStats[] {
  return [...fileStats.values()].sort((left, right) => {
    const byTokens = right.estimatedTokens - left.estimatedTokens;
    if (byTokens !== 0) return byTokens;

    const byLines = right.actualLines - left.actualLines;
    if (byLines !== 0) return byLines;

    const byTouches = right.touches - left.touches;
    if (byTouches !== 0) return byTouches;

    return right.lastTouchedAt - left.lastTouchedAt;
  });
}

function getTotals(): Totals {
  let touches = 0;
  let actualLines = 0;
  let estimatedTokens = 0;

  for (const stats of fileStats.values()) {
    touches += stats.touches;
    actualLines += stats.actualLines;
    estimatedTokens += stats.estimatedTokens;
  }

  return {
    files: fileStats.size,
    touches,
    actualLines,
    estimatedTokens,
  };
}

function formatStatusLine(ctx: ExtensionContext): string | undefined {
  if (fileStats.size === 0) return undefined;

  const totals = getTotals();
  const theme = ctx.ui.theme;
  return [
    theme.fg("accent", "ctx"),
    theme.fg("dim", `${compactNumber(totals.files)}f`),
    theme.fg("dim", `${compactNumber(totals.touches)}×`),
    theme.fg("muted", formatActualLineCount(totals.actualLines)),
    theme.fg("muted", formatTokenEstimate(totals.estimatedTokens)),
  ].join(" ");
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function buildContextUsageLine(ctx: ExtensionContext): string | undefined {
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;

  const theme = ctx.ui.theme;
  const tokens = usage.tokens === null ? "unknown tokens" : formatTokenEstimate(usage.tokens);
  const percent = usage.percent === null ? "" : ` (${formatPercent(usage.percent)})`;

  return `${theme.fg("accent", "Total context")} ${theme.fg(
    "dim",
    `· ${tokens} / ${formatTokenCount(usage.contextWindow)}${percent}`,
  )}`;
}

function buildStatsLine(stats: FileStats, ctx: ExtensionContext): string {
  const theme = ctx.ui.theme;
  const parts = [
    theme.fg(
      "muted",
      `${formatActualLineCount(stats.actualLines)} · ${formatTokenEstimate(stats.estimatedTokens)}`,
    ),
    theme.fg("dim", `${compactNumber(stats.touches)} touch${stats.touches === 1 ? "" : "es"}`),
  ];

  if (stats.reads > 0)
    parts.push(
      theme.fg(
        "accent",
        `read ${stats.reads}×: ${formatActualLineCount(stats.readLines)}, ${formatTokenEstimate(stats.readTokens)}`,
      ),
    );
  if (stats.writes > 0)
    parts.push(
      theme.fg(
        "success",
        `write ${stats.writes}×: ${formatActualLineCount(stats.writeLines)}, ${formatTokenEstimate(stats.writeTokens)}`,
      ),
    );
  if (stats.edits > 0)
    parts.push(
      theme.fg(
        "warning",
        `edit ${stats.edits}×: ${formatActualLineCount(stats.editLines)}, ${formatTokenEstimate(stats.editTokens)}`,
      ),
    );

  return parts.join(" · ");
}

function buildDetailsLines(ctx: ExtensionContext): string[] {
  const theme = ctx.ui.theme;
  const totals = getTotals();
  const contextUsageLine = buildContextUsageLine(ctx);

  if (totals.files === 0) {
    return [
      ...(contextUsageLine ? [contextUsageLine] : []),
      theme.fg("dim", "No read/write/edit actual file lines tracked yet."),
      theme.fg("dim", "The pane updates after read, write, or edit tool results."),
    ];
  }

  const lines = [
    `${theme.fg("accent", `${totals.files} files`)} ${theme.fg(
      "dim",
      `· ${compactNumber(totals.touches)} touches · ${formatActualLineCount(totals.actualLines)} · ${formatTokenEstimate(totals.estimatedTokens)}`,
    )}`,
    ...(contextUsageLine ? [contextUsageLine] : []),
    theme.fg("dim", "Sorted by estimated tokens, then actual lines and touches."),
  ];

  for (const [index, stats] of sortedFiles().slice(0, currentConfig.maxFilesInPane).entries()) {
    const label = theme.fg("accent", `${index + 1}.`);
    lines.push(`${label} ${truncateMiddle(stats.path, currentConfig.maxPathLength)}`);
    lines.push(`   ${buildStatsLine(stats, ctx)}`);

    const last = stats.recent[0];
    if (last) {
      lines.push(`   ${theme.fg("dim", `${formatTime(last.timestamp)} `)}${last.summary}`);
    }
  }

  const hidden = totals.files - currentConfig.maxFilesInPane;
  if (hidden > 0) {
    lines.push(theme.fg("dim", `… ${hidden} more file${hidden === 1 ? "" : "s"}`));
  }

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
    panelBorder("Context Files", width, border),
    ...wrapped.map((line) => panelLine(line, width, border)),
    panelBorder(undefined, width, border),
  ];
}

function applyContextFiles(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setStatus(STATUS_KEY, formatStatusLine(ctx));
  overlayTiler?.requestRender();
}

interface HideDetailsPaneOptions {
  readonly disableAutoShow?: boolean;
}

function hideDetailsPane(options: HideDetailsPaneOptions = {}): void {
  if (options.disableAutoShow) autoShowDetailsPane = false;

  detailsVisible = false;
  overlayTiler?.setVisible(false);
}

function showDetailsPane(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  detailsVisible = true;
  overlayTiler?.setVisible(true);
  overlayTiler?.requestRender();
}

function toggleDetailsPane(ctx: ExtensionContext): void {
  if (detailsVisible) {
    hideDetailsPane({ disableAutoShow: true });
  } else {
    showDetailsPane(ctx);
  }
}

function clearContextFiles(ctx: ExtensionContext): void {
  fileStats.clear();
  applyContextFiles(ctx);
}

function maybeShowDefaultDetailsPane(ctx: ExtensionContext): void {
  if (autoShowDetailsPane) showDetailsPane(ctx);
}

export default function contextFilesExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    loadConfig(ctx);
    overlayTiler ??= registerRightOverlayPane(pi, {
      id: STATUS_KEY,
      order: currentConfig.overlayOrder,
      minWidth: currentConfig.paneMinWidth,
      render: (width, state) => buildDetailsPaneLines(ctx, width, state),
    });
    detailsVisible = false;
    autoShowDetailsPane = currentConfig.autoShowDetailsPane;

    rebuildFromSession(ctx);
    applyContextFiles(ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    if (isReadToolResult(event) || isWriteToolResult(event) || isEditToolResult(event)) {
      recordToolResult(
        event.toolName,
        event.input,
        event.content,
        event.details,
        event.isError,
        ctx,
      );
      applyContextFiles(ctx);
      maybeShowDefaultDetailsPane(ctx);
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    applyContextFiles(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    applyContextFiles(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    detailsVisible = false;
    clearContextFiles(ctx);
    hideDetailsPane();
    overlayTiler?.dispose();
    overlayTiler = undefined;
  });

  pi.registerCommand("context-files", {
    description: "Toggle a right-side file context pane, or use: show, hide, refresh, clear",
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
        ctx.ui.notify("Context files hidden", "info");
        applyContextFiles(ctx);
        return Promise.resolve();
      }

      if (action === "refresh") {
        rebuildFromSession(ctx);
        applyContextFiles(ctx);
        showDetailsPane(ctx);
        ctx.ui.notify("Context files rebuilt from this session", "info");
        return Promise.resolve();
      }

      if (action === "clear") {
        clearContextFiles(ctx);
        showDetailsPane(ctx);
        ctx.ui.notify("Context files cleared for this runtime", "info");
        return Promise.resolve();
      }

      showDetailsPane(ctx);
      applyContextFiles(ctx);
      if (action === "show") ctx.ui.notify("Context files shown", "info");
      return Promise.resolve();
    },
  });

  pi.registerShortcut("ctrl+shift+f", {
    description: "Toggle context files details pane",
    handler: (ctx) => {
      toggleDetailsPane(ctx);
      applyContextFiles(ctx);
    },
  });
}
