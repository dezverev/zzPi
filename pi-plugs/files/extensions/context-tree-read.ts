import {
  truncateToVisualLines,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  type ChildAgentProgress,
  type ChildAgentRunResult,
  type ToolCallSummary,
} from "./lib/child-pi-agent.ts";
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

const CONFIG_FILE_PATH = ".pi/extensions/context-tree-read.config.jsonc";
const PANE_ID = "context-tree-read";
const STATUS_KEY = "context-tree-read";

const READSUBAGENT_EVENT_END = "readsubagent:end";
const READSUBAGENT_EVENT_ERROR = "readsubagent:error";
const READSUBAGENT_EVENT_PROGRESS = "readsubagent:progress";
const READSUBAGENT_EVENT_START = "readsubagent:start";

const COMMAND_OPTIONS = ["show", "hide", "toggle", "status", "clear"] as const;
const TREE_CHILD = "├─";
const TREE_LAST = "└─";
const TREE_PIPE = "│  ";
const TREE_SPACE = "   ";

type CommandAction = (typeof COMMAND_OPTIONS)[number];
type ReadRunStatus = "completed" | "failed" | "running";

interface ContextTreeReadConfig {
  readonly autoShowDetailsPane: boolean;
  readonly maxArgumentPreviewChars: number;
  readonly maxRenderVisualLines: number;
  readonly overlayOrder: number;
  readonly paneMinWidth: number;
}

interface ReadSubagentBaseEvent {
  readonly cwd: string;
  readonly model: string;
  readonly paths: readonly string[];
  readonly question: string;
  readonly runId: number;
  readonly startedAt: number;
  readonly task: string;
}

interface ReadSubagentProgressEvent extends ReadSubagentBaseEvent {
  readonly progress: ChildAgentProgress;
  readonly updatedAt: number;
}

interface ReadSubagentEndEvent extends ReadSubagentBaseEvent {
  readonly endedAt: number;
  readonly result: ChildAgentRunResult;
}

interface ReadSubagentErrorEvent extends ReadSubagentBaseEvent {
  readonly endedAt: number;
  readonly errorMessage: string;
}

interface ReadTreeSnapshot extends ReadSubagentBaseEvent {
  readonly endedAt?: number;
  readonly errorMessage?: string;
  readonly progress?: ChildAgentProgress;
  readonly result?: ChildAgentRunResult;
  readonly status: ReadRunStatus;
  readonly updatedAt: number;
}

const DEFAULT_CONFIG: ContextTreeReadConfig = {
  autoShowDetailsPane: true,
  maxArgumentPreviewChars: 256,
  maxRenderVisualLines: 1_000,
  overlayOrder: 22,
  paneMinWidth: 52,
};

let autoShowSuppressed = false;
let currentConfig: ContextTreeReadConfig = { ...DEFAULT_CONFIG };
let currentSnapshot: ReadTreeSnapshot | undefined;
let detailsVisible = false;
let lastContext: ExtensionContext | undefined;
let overlayTiler: RightOverlayPaneClient | undefined;

function loadConfig(ctx: ExtensionContext): void {
  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, ctx.cwd);
    currentConfig = record
      ? {
          autoShowDetailsPane:
            getBooleanField(record, "autoShowDetailsPane") ?? DEFAULT_CONFIG.autoShowDetailsPane,
          maxArgumentPreviewChars:
            getPositiveIntegerField(record, "maxArgumentPreviewChars") ??
            DEFAULT_CONFIG.maxArgumentPreviewChars,
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
    ctx.ui.notify(`context-tree-read config ignored: ${getErrorMessage(error)}`, "warning");
  }
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

function truncatePlain(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return "…";
  return `${value.slice(0, maxChars - 1)}…`;
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStringArrayField(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

function getStringListField(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const strings = getStringArrayField(record, key);
  return strings && strings.length > 0 ? strings : undefined;
}

function previewJson(value: unknown): string {
  if (value === undefined) return "";

  try {
    const serialized = JSON.stringify(value);
    return serialized ? truncatePlain(serialized, currentConfig.maxArgumentPreviewChars) : "";
  } catch {
    return "[unserializable args]";
  }
}

function previewToolArgs(args: unknown): string {
  if (!isRecord(args)) return previewJson(args);

  const command = getStringField(args, "command");
  if (command) return truncatePlain(command, currentConfig.maxArgumentPreviewChars);

  const path = getStringField(args, "path");
  const paths = getStringListField(args, "paths");
  const pattern = getStringField(args, "pattern");
  const query = getStringField(args, "query");
  const cwd = getStringField(args, "cwd");
  const offset = getNumberField(args, "offset");
  const limit = getNumberField(args, "limit");
  const parts: string[] = [];

  if (pattern) parts.push(`pattern=${pattern}`);
  if (query) parts.push(`query=${query}`);
  if (path) parts.push(path);
  if (paths) parts.push(paths.join(", "));
  if (cwd) parts.push(`cwd=${cwd}`);
  if (offset !== undefined || limit !== undefined) {
    const start = offset === undefined ? "?" : String(offset);
    const end = limit === undefined ? "?" : String(limit);
    parts.push(`lines=${start}+${end}`);
  }

  return parts.length > 0
    ? truncatePlain(parts.join(" · "), currentConfig.maxArgumentPreviewChars)
    : previewJson(args);
}

function getToolCalls(snapshot: ReadTreeSnapshot): readonly ToolCallSummary[] {
  return snapshot.result?.toolCalls ?? snapshot.progress?.activeToolCalls ?? [];
}

function formatStatusIcon(status: ReadRunStatus): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  return "…";
}

function getSnapshotDuration(snapshot: ReadTreeSnapshot): number {
  if (snapshot.result) return snapshot.result.durationMs;
  const end = snapshot.endedAt ?? snapshot.updatedAt;
  return Math.max(0, end - snapshot.startedAt);
}

function getTurnCount(snapshot: ReadTreeSnapshot): number {
  return snapshot.progress?.turns ?? snapshot.result?.usage.turns ?? 0;
}

function getOutputChars(snapshot: ReadTreeSnapshot): number {
  return snapshot.progress?.latestOutputChars ?? snapshot.result?.output.length ?? 0;
}

function getRunningTools(snapshot: ReadTreeSnapshot): number {
  if (snapshot.status !== "running") return 0;
  return (
    snapshot.progress?.runningTools ??
    getToolCalls(snapshot).filter((call) => call.status === "running").length
  );
}

function formatToolCall(ctx: ExtensionContext, call: ToolCallSummary): string {
  const theme = ctx.ui.theme;
  const isRunning = call.status === "running";
  const marker = call.isError
    ? theme.fg("error", "✗")
    : isRunning
      ? theme.fg("warning", "…")
      : theme.fg("success", "✓");
  const name = theme.fg("toolTitle", call.name);
  const preview = previewToolArgs(call.args);
  const status = isRunning
    ? theme.fg("warning", "running")
    : call.isError
      ? theme.fg("error", "error")
      : theme.fg("success", "done");

  return preview
    ? `${marker} ${name} ${theme.fg("muted", preview)} ${theme.fg("muted", `(${status})`)}`
    : `${marker} ${name} ${theme.fg("muted", `(${status})`)}`;
}

function formatPaths(paths: readonly string[]): string {
  if (paths.length === 0) return "all repo paths allowed by task";
  return paths.join(", ");
}

function buildDetailsLines(ctx: ExtensionContext): string[] {
  const theme = ctx.ui.theme;
  const snapshot = currentSnapshot;

  if (!snapshot) {
    return [
      theme.fg("muted", "No readsubagent run captured yet."),
      theme.fg("muted", "Run /readsubagent ask, or let the agent call the readsubagent tool."),
    ];
  }

  const toolCalls = getToolCalls(snapshot);
  const statusColor =
    snapshot.status === "failed" ? "error" : snapshot.status === "running" ? "warning" : "success";
  const status = theme.fg(statusColor, `${formatStatusIcon(snapshot.status)} ${snapshot.status}`);
  const duration = formatDurationMs(getSnapshotDuration(snapshot));
  const progressText = [
    `${getTurnCount(snapshot)} turn${getTurnCount(snapshot) === 1 ? "" : "s"}`,
    `${toolCalls.length} tool${toolCalls.length === 1 ? "" : "s"}`,
    `${getRunningTools(snapshot)} running`,
    `${getOutputChars(snapshot)} chars`,
  ].join(" · ");
  const lines = [
    `${theme.fg("accent", "readsubagent context tree")} ${status} ${theme.fg(
      "muted",
      `#${snapshot.runId} · ${duration}`,
    )}`,
    `${TREE_CHILD} question ${theme.fg("text", truncatePlain(snapshot.question, currentConfig.maxArgumentPreviewChars))}`,
    `${TREE_CHILD} scope ${theme.fg("muted", formatPaths(snapshot.paths))}`,
    `${TREE_CHILD} cwd ${theme.fg("muted", snapshot.cwd)}`,
    `${TREE_CHILD} model ${theme.fg("muted", snapshot.model)}`,
    `${TREE_CHILD} progress ${theme.fg("muted", progressText)}`,
  ];

  const hasTerminalLine = Boolean(snapshot.errorMessage ?? snapshot.result);
  const toolBranch = hasTerminalLine ? TREE_CHILD : TREE_LAST;
  const toolPrefix = hasTerminalLine ? TREE_PIPE : TREE_SPACE;
  lines.push(`${toolBranch} child tools ${theme.fg("muted", `(${toolCalls.length})`)}`);

  if (toolCalls.length === 0) {
    lines.push(`${toolPrefix}${TREE_LAST} ${theme.fg("muted", "waiting for child tool calls")}`);
  } else {
    toolCalls.forEach((call, index) => {
      const connector = index === toolCalls.length - 1 ? TREE_LAST : TREE_CHILD;
      lines.push(`${toolPrefix}${connector} ${formatToolCall(ctx, call)}`);
    });
  }

  if (snapshot.errorMessage) {
    lines.push(`${TREE_LAST} error ${theme.fg("error", snapshot.errorMessage)}`);
  } else if (snapshot.result) {
    const summary = [
      `exit ${snapshot.result.exitCode}`,
      snapshot.result.stopReason ? `stop ${snapshot.result.stopReason}` : undefined,
      snapshot.result.output ? `${snapshot.result.output.length} chars` : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(" · ");
    lines.push(`${TREE_LAST} result ${theme.fg("muted", summary || snapshot.result.status)}`);
  }

  return lines;
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
    panelBorder("Context Tree · Read", width, border),
    ...wrapped.map((line) => panelLine(line, width, border)),
    panelBorder(undefined, width, border),
  ];
}

function formatStatusLine(ctx: ExtensionContext): string | undefined {
  const theme = ctx.ui.theme;
  const snapshot = currentSnapshot;
  if (!snapshot) return detailsVisible ? theme.fg("muted", "read tree idle") : undefined;

  const toolCalls = getToolCalls(snapshot);
  const statusColor =
    snapshot.status === "failed" ? "error" : snapshot.status === "running" ? "warning" : "success";
  return [
    theme.fg("accent", "read tree"),
    theme.fg(statusColor, snapshot.status),
    theme.fg("muted", `${getTurnCount(snapshot)}t/${toolCalls.length} tools`),
  ].join(" ");
}

function applyState(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, formatStatusLine(ctx));
  overlayTiler?.requestRender();
}

function applyLastState(): void {
  if (lastContext) {
    applyState(lastContext);
    return;
  }

  overlayTiler?.requestRender();
}

function showDetailsPane(
  ctx: ExtensionContext | undefined,
  options: { preserveAutoShow?: boolean } = {},
): void {
  if (!options.preserveAutoShow) autoShowSuppressed = false;
  detailsVisible = true;
  overlayTiler?.setVisible(true);
  if (ctx) applyState(ctx);
}

function hideDetailsPane(
  ctx: ExtensionContext | undefined,
  options: { suppressAutoShow?: boolean } = {},
): void {
  if (options.suppressAutoShow) autoShowSuppressed = true;
  detailsVisible = false;
  overlayTiler?.setVisible(false);
  if (ctx) applyState(ctx);
}

function clearSnapshot(ctx: ExtensionContext): void {
  currentSnapshot = undefined;
  applyState(ctx);
}

function shouldAcceptRun(runId: number): boolean {
  return !currentSnapshot || currentSnapshot.runId === runId;
}

function isToolCallSummary(value: unknown): value is ToolCallSummary {
  if (!isRecord(value)) return false;
  const status = value.status;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (status === "done" || status === "running") &&
    (value.isError === undefined || typeof value.isError === "boolean")
  );
}

function isChildAgentProgress(value: unknown): value is ChildAgentProgress {
  if (!isRecord(value)) return false;
  const activeToolCalls = value.activeToolCalls;
  return (
    getNumberField(value, "latestOutputChars") !== undefined &&
    getNumberField(value, "runningTools") !== undefined &&
    getNumberField(value, "toolCalls") !== undefined &&
    getNumberField(value, "turns") !== undefined &&
    (activeToolCalls === undefined ||
      (Array.isArray(activeToolCalls) && activeToolCalls.every(isToolCallSummary)))
  );
}

function isChildAgentRunResult(value: unknown): value is ChildAgentRunResult {
  if (!isRecord(value)) return false;
  const status = value.status;
  const toolCalls = value.toolCalls;
  const usage = value.usage;
  return (
    getNumberField(value, "durationMs") !== undefined &&
    getNumberField(value, "exitCode") !== undefined &&
    typeof value.output === "string" &&
    typeof value.rawOutput === "string" &&
    typeof value.stderr === "string" &&
    typeof value.task === "string" &&
    (status === "aborted" ||
      status === "completed" ||
      status === "failed" ||
      status === "timeout") &&
    Array.isArray(toolCalls) &&
    toolCalls.every(isToolCallSummary) &&
    isRecord(usage) &&
    getNumberField(usage, "turns") !== undefined
  );
}

function readBaseEvent(value: unknown): ReadSubagentBaseEvent | undefined {
  if (!isRecord(value)) return undefined;
  const cwd = getStringField(value, "cwd");
  const model = getStringField(value, "model");
  const paths = getStringArrayField(value, "paths");
  const question = getStringField(value, "question");
  const runId = getNumberField(value, "runId");
  const startedAt = getNumberField(value, "startedAt");
  const task = getStringField(value, "task");

  if (
    !cwd ||
    !model ||
    !paths ||
    !question ||
    runId === undefined ||
    startedAt === undefined ||
    !task
  ) {
    return undefined;
  }

  return { cwd, model, paths, question, runId, startedAt, task };
}

function readProgressEvent(value: unknown): ReadSubagentProgressEvent | undefined {
  if (!isRecord(value)) return undefined;
  const base = readBaseEvent(value);
  const updatedAt = getNumberField(value, "updatedAt");
  const progress = value.progress;
  if (!base || updatedAt === undefined || !isChildAgentProgress(progress)) return undefined;
  return { ...base, progress, updatedAt };
}

function readEndEvent(value: unknown): ReadSubagentEndEvent | undefined {
  if (!isRecord(value)) return undefined;
  const base = readBaseEvent(value);
  const endedAt = getNumberField(value, "endedAt");
  const result = value.result;
  if (!base || endedAt === undefined || !isChildAgentRunResult(result)) return undefined;
  return { ...base, endedAt, result };
}

function readErrorEvent(value: unknown): ReadSubagentErrorEvent | undefined {
  if (!isRecord(value)) return undefined;
  const base = readBaseEvent(value);
  const endedAt = getNumberField(value, "endedAt");
  const errorMessage = getStringField(value, "errorMessage");
  if (!base || endedAt === undefined || !errorMessage) return undefined;
  return { ...base, endedAt, errorMessage };
}

function handleRunStart(data: unknown): void {
  const event = readBaseEvent(data);
  if (!event) return;

  currentSnapshot = {
    ...event,
    status: "running",
    updatedAt: event.startedAt,
  };

  if (detailsVisible || (currentConfig.autoShowDetailsPane && !autoShowSuppressed)) {
    showDetailsPane(lastContext, { preserveAutoShow: true });
  }
  applyLastState();
}

function handleRunProgress(data: unknown): void {
  const event = readProgressEvent(data);
  if (!event || !shouldAcceptRun(event.runId)) return;

  currentSnapshot = {
    ...(currentSnapshot ?? event),
    progress: event.progress,
    status: "running",
    updatedAt: event.updatedAt,
  };
  applyLastState();
}

function handleRunEnd(data: unknown): void {
  const event = readEndEvent(data);
  if (!event || !shouldAcceptRun(event.runId)) return;

  currentSnapshot = {
    ...(currentSnapshot ?? event),
    endedAt: event.endedAt,
    result: event.result,
    status: event.result.status === "completed" ? "completed" : "failed",
    updatedAt: event.endedAt,
  };
  applyLastState();
}

function handleRunError(data: unknown): void {
  const event = readErrorEvent(data);
  if (!event || !shouldAcceptRun(event.runId)) return;

  currentSnapshot = {
    ...(currentSnapshot ?? event),
    endedAt: event.endedAt,
    errorMessage: event.errorMessage,
    status: "failed",
    updatedAt: event.endedAt,
  };
  applyLastState();
}

function isCommandAction(value: string): value is CommandAction {
  return COMMAND_OPTIONS.some((option) => option === value);
}

function notifyStatus(ctx: ExtensionContext): void {
  const snapshot = currentSnapshot;
  if (!snapshot) {
    ctx.ui.notify("context-tree-read: no readsubagent run captured yet", "info");
    return;
  }

  ctx.ui.notify(
    `context-tree-read: ${snapshot.status}, ${getTurnCount(snapshot)} turn(s), ${getToolCalls(snapshot).length} tool(s)`,
    snapshot.status === "failed" ? "warning" : "info",
  );
}

export default function contextTreeReadExtension(pi: ExtensionAPI): void {
  pi.events.on(READSUBAGENT_EVENT_START, handleRunStart);
  pi.events.on(READSUBAGENT_EVENT_PROGRESS, handleRunProgress);
  pi.events.on(READSUBAGENT_EVENT_END, handleRunEnd);
  pi.events.on(READSUBAGENT_EVENT_ERROR, handleRunError);

  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    loadConfig(ctx);
    currentSnapshot = undefined;
    detailsVisible = false;
    autoShowSuppressed = false;
    overlayTiler ??= registerRightOverlayPane(pi, {
      id: PANE_ID,
      order: currentConfig.overlayOrder,
      minWidth: currentConfig.paneMinWidth,
      render: (width, state) => buildDetailsPaneLines(lastContext ?? ctx, width, state),
    });
    applyState(ctx);
  });

  pi.on("session_shutdown", () => {
    currentSnapshot = undefined;
    detailsVisible = false;
    lastContext = undefined;
    overlayTiler?.dispose();
    overlayTiler = undefined;
  });

  pi.registerCommand("context-tree-read", {
    description: "Toggle the readsubagent context tree pane, or use: show, hide, status, clear",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim().toLowerCase();
      return COMMAND_OPTIONS.filter((option) => option.startsWith(trimmed)).map((option) => ({
        label: option,
        value: option,
      }));
    },
    handler: (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && !isCommandAction(action)) {
        ctx.ui.notify(`Unknown context-tree-read action: ${action}`, "warning");
        return Promise.resolve();
      }

      if (action === "status") {
        notifyStatus(ctx);
        applyState(ctx);
        return Promise.resolve();
      }

      if (action === "clear") {
        clearSnapshot(ctx);
        showDetailsPane(ctx);
        ctx.ui.notify("context-tree-read cleared", "info");
        return Promise.resolve();
      }

      if (action === "hide" || ((action === "" || action === "toggle") && detailsVisible)) {
        hideDetailsPane(ctx, { suppressAutoShow: true });
        ctx.ui.notify("context-tree-read hidden", "info");
        return Promise.resolve();
      }

      showDetailsPane(ctx);
      if (action === "show" || action === "toggle") {
        ctx.ui.notify("context-tree-read shown", "info");
      }
      return Promise.resolve();
    },
  });
}
