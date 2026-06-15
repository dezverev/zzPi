import {
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

const STATUS_KEY = "git-status";
const CONFIG_FILE_PATH = ".pi/extensions/git-status.config.jsonc";

interface GitStatusConfig {
  readonly autoShowDetailsPane: boolean;
  readonly gitStatusTimeoutMs: number;
  readonly maxFilesPerSection: number;
  readonly maxPathLength: number;
  readonly maxRenderVisualLines: number;
  readonly overlayOrder: number;
  readonly paneMinWidth: number;
  readonly refreshIntervalMs: number;
}

const DEFAULT_CONFIG: GitStatusConfig = {
  autoShowDetailsPane: true,
  gitStatusTimeoutMs: 5_000,
  maxFilesPerSection: 8,
  maxPathLength: 96,
  maxRenderVisualLines: 1_000,
  overlayOrder: 10,
  paneMinWidth: 48,
  refreshIntervalMs: 5_000,
};

let currentConfig: GitStatusConfig = { ...DEFAULT_CONFIG };

type GitFileBucket = "staged" | "modified" | "untracked" | "conflicts";

interface GitFileStatus {
  readonly code: string;
  readonly path: string;
}

interface GitRepoStatus {
  readonly kind: "repo";
  readonly branch: string;
  readonly upstream?: string;
  readonly upstreamGone: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly files: Record<GitFileBucket, GitFileStatus[]>;
}

type GitStatus =
  | GitRepoStatus
  | { readonly kind: "not-repo" }
  | { readonly kind: "error"; readonly message: string };

interface RefreshOptions {
  readonly notify?: boolean;
}

interface HideDetailsPaneOptions {
  readonly disableAutoShow?: boolean;
}

const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight = false;
let detailsVisible = false;
let autoShowDetailsPane = true;
let overlayTiler: RightOverlayPaneClient | undefined;
let lastStatus: GitStatus | undefined;

function loadConfig(ctx: ExtensionContext): void {
  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, ctx.cwd);
    currentConfig = record
      ? {
          autoShowDetailsPane:
            getBooleanField(record, "autoShowDetailsPane") ?? DEFAULT_CONFIG.autoShowDetailsPane,
          gitStatusTimeoutMs:
            getPositiveIntegerField(record, "gitStatusTimeoutMs") ??
            DEFAULT_CONFIG.gitStatusTimeoutMs,
          maxFilesPerSection:
            getPositiveIntegerField(record, "maxFilesPerSection") ??
            DEFAULT_CONFIG.maxFilesPerSection,
          maxPathLength:
            getPositiveIntegerField(record, "maxPathLength") ?? DEFAULT_CONFIG.maxPathLength,
          maxRenderVisualLines:
            getPositiveIntegerField(record, "maxRenderVisualLines") ??
            DEFAULT_CONFIG.maxRenderVisualLines,
          overlayOrder:
            getPositiveIntegerField(record, "overlayOrder") ?? DEFAULT_CONFIG.overlayOrder,
          paneMinWidth:
            getPositiveIntegerField(record, "paneMinWidth") ?? DEFAULT_CONFIG.paneMinWidth,
          refreshIntervalMs:
            getPositiveIntegerField(record, "refreshIntervalMs") ??
            DEFAULT_CONFIG.refreshIntervalMs,
        }
      : { ...DEFAULT_CONFIG };
  } catch (error) {
    currentConfig = { ...DEFAULT_CONFIG };
    ctx.ui.notify(`git-status config ignored: ${getErrorMessage(error)}`, "warning");
  }
}

function emptyFileBuckets(): Record<GitFileBucket, GitFileStatus[]> {
  return {
    staged: [],
    modified: [],
    untracked: [],
    conflicts: [],
  };
}

function parseBranchHeader(header: string): Omit<GitRepoStatus, "kind" | "files"> {
  let branchAndUpstream = header.trim();
  let ahead = 0;
  let behind = 0;
  let upstreamGone = false;

  const bracketIndex = branchAndUpstream.lastIndexOf(" [");
  if (bracketIndex >= 0 && branchAndUpstream.endsWith("]")) {
    const metadata = branchAndUpstream.slice(bracketIndex + 2, -1);
    branchAndUpstream = branchAndUpstream.slice(0, bracketIndex);

    for (const part of metadata.split(",")) {
      const trimmed = part.trim();
      const aheadMatch = /^ahead (\d+)$/.exec(trimmed);
      const behindMatch = /^behind (\d+)$/.exec(trimmed);

      if (aheadMatch) ahead = Number(aheadMatch[1]);
      if (behindMatch) behind = Number(behindMatch[1]);
      if (trimmed === "gone") upstreamGone = true;
    }
  }

  let branch = branchAndUpstream;
  let upstream: string | undefined;
  const upstreamSeparator = branchAndUpstream.indexOf("...");
  if (upstreamSeparator >= 0) {
    branch = branchAndUpstream.slice(0, upstreamSeparator);
    upstream = branchAndUpstream.slice(upstreamSeparator + 3) || undefined;
  }

  if (branch.startsWith("No commits yet on ")) {
    branch = branch.slice("No commits yet on ".length);
  }

  if (branch === "HEAD (no branch)") {
    branch = "detached";
  }

  return upstream === undefined
    ? { branch, upstreamGone, ahead, behind }
    : { branch, upstream, upstreamGone, ahead, behind };
}

function normalizePorcelainPath(rawPath: string): string {
  const renameSeparator = " -> ";
  const renameIndex = rawPath.indexOf(renameSeparator);
  const path = renameIndex >= 0 ? rawPath.slice(renameIndex + renameSeparator.length) : rawPath;

  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function parseGitStatus(stdout: string): GitStatus {
  const lines = stdout.replaceAll("\r\n", "\n").split("\n").filter(Boolean);
  const headerLine = lines[0];

  if (!headerLine?.startsWith("## ")) {
    return { kind: "error", message: "git status output did not include a branch header" };
  }

  const files = emptyFileBuckets();

  for (const line of lines.slice(1)) {
    if (line.length < 3) continue;

    const code = line.slice(0, 2);
    const path = normalizePorcelainPath(line.slice(3));
    const fileStatus: GitFileStatus = { code, path };

    if (code === "??") {
      files.untracked.push(fileStatus);
      continue;
    }

    if (conflictCodes.has(code)) {
      files.conflicts.push(fileStatus);
      continue;
    }

    const indexStatus = code[0];
    const worktreeStatus = code[1];

    if (indexStatus !== " " && indexStatus !== "!" && indexStatus !== "?") {
      files.staged.push(fileStatus);
    }

    if (worktreeStatus !== " " && worktreeStatus !== "!" && worktreeStatus !== "?") {
      files.modified.push(fileStatus);
    }
  }

  return {
    kind: "repo",
    ...parseBranchHeader(headerLine.slice(3)),
    files,
  };
}

function fileCount(status: GitRepoStatus, bucket: GitFileBucket): number {
  return status.files[bucket].length;
}

function hasChanges(status: GitRepoStatus): boolean {
  return (
    fileCount(status, "staged") > 0 ||
    fileCount(status, "modified") > 0 ||
    fileCount(status, "untracked") > 0 ||
    fileCount(status, "conflicts") > 0
  );
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(0, maxLength - 1);
  return `…${value.slice(value.length - keep)}`;
}

function formatStatusLine(status: GitStatus, ctx: ExtensionContext): string | undefined {
  const theme = ctx.ui.theme;

  if (status.kind === "not-repo") return undefined;
  if (status.kind === "error") return theme.fg("error", "git: error");

  const parts = [theme.fg("accent", ` ${status.branch}`)];

  if (status.upstreamGone) parts.push(theme.fg("warning", "upstream gone"));
  if (status.ahead > 0) parts.push(theme.fg("dim", `↑${status.ahead}`));
  if (status.behind > 0) parts.push(theme.fg("dim", `↓${status.behind}`));

  const conflictCount = fileCount(status, "conflicts");
  const stagedCount = fileCount(status, "staged");
  const modifiedCount = fileCount(status, "modified");
  const untrackedCount = fileCount(status, "untracked");

  if (conflictCount > 0) parts.push(theme.fg("error", `!${conflictCount}`));
  if (stagedCount > 0) parts.push(theme.fg("success", `+${stagedCount}`));
  if (modifiedCount > 0) parts.push(theme.fg("warning", `~${modifiedCount}`));
  if (untrackedCount > 0) parts.push(theme.fg("muted", `?${untrackedCount}`));
  if (!hasChanges(status)) parts.push(theme.fg("success", "✓"));

  return parts.join(" ");
}

function buildSummaryLine(status: GitRepoStatus, ctx: ExtensionContext): string {
  const theme = ctx.ui.theme;
  const upstream = status.upstream ? theme.fg("dim", ` ⇄ ${status.upstream}`) : "";
  const sync = [
    status.ahead > 0 ? theme.fg("dim", `↑${status.ahead}`) : undefined,
    status.behind > 0 ? theme.fg("dim", `↓${status.behind}`) : undefined,
    status.upstreamGone ? theme.fg("warning", "upstream gone") : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return `${theme.fg("accent", ` ${status.branch}`)}${upstream}${sync ? ` ${sync}` : ""}`;
}

function appendFileSection(
  lines: string[],
  title: string,
  files: readonly GitFileStatus[],
  color: (value: string) => string,
): void {
  if (files.length === 0) return;

  lines.push(color(`${title} (${files.length})`));

  for (const file of files.slice(0, currentConfig.maxFilesPerSection)) {
    lines.push(`  ${file.code} ${truncateMiddle(file.path, currentConfig.maxPathLength)}`);
  }

  const remaining = files.length - currentConfig.maxFilesPerSection;
  if (remaining > 0) {
    lines.push(`  … ${remaining} more`);
  }
}

function buildDetailsLines(status: GitStatus, ctx: ExtensionContext): string[] {
  const theme = ctx.ui.theme;

  if (status.kind === "not-repo") {
    return [theme.fg("dim", "No Git repository detected")];
  }

  if (status.kind === "error") {
    return [theme.fg("error", `Git status failed: ${status.message}`)];
  }

  const lines = [buildSummaryLine(status, ctx)];

  if (!hasChanges(status)) {
    lines.push(theme.fg("success", "✓ working tree clean"));
    return lines;
  }

  appendFileSection(lines, "Conflicts", status.files.conflicts, (value) =>
    theme.fg("error", value),
  );
  appendFileSection(lines, "Staged", status.files.staged, (value) => theme.fg("success", value));
  appendFileSection(lines, "Modified", status.files.modified, (value) =>
    theme.fg("warning", value),
  );
  appendFileSection(lines, "Untracked", status.files.untracked, (value) =>
    theme.fg("muted", value),
  );

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
  status: GitStatus | undefined,
  ctx: ExtensionContext,
  width: number,
  state: RightOverlayRenderState,
): string[] {
  const theme = ctx.ui.theme;
  const border = (value: string) => theme.fg(state.focused ? "borderAccent" : "borderMuted", value);
  const content = status
    ? buildDetailsLines(status, ctx)
    : [theme.fg("dim", "Loading Git status…")];
  const body = content;

  const wrapped = truncateToVisualLines(
    body.join("\n"),
    currentConfig.maxRenderVisualLines,
    Math.max(8, width - 4),
    0,
  ).visualLines;

  return [
    panelBorder("Git Status", width, border),
    ...wrapped.map((line) => panelLine(line, width, border)),
    panelBorder(undefined, width, border),
  ];
}

function refreshDetailsPane(): void {
  overlayTiler?.requestRender();
}

function applyGitStatus(status: GitStatus, ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, formatStatusLine(status, ctx));
  refreshDetailsPane();
}

function maybeShowDefaultDetailsPane(status: GitStatus, ctx: ExtensionContext): void {
  if (autoShowDetailsPane && status.kind === "repo") {
    showDetailsPane(ctx);
  }
}

async function readGitStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<GitStatus> {
  const execOptions: { cwd: string; signal?: AbortSignal; timeout: number } = {
    cwd: ctx.cwd,
    timeout: currentConfig.gitStatusTimeoutMs,
  };
  if (ctx.signal) execOptions.signal = ctx.signal;

  const result = await pi.exec(
    "git",
    ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
    execOptions,
  );

  if (result.code !== 0) {
    const message = (result.stderr || result.stdout).trim();
    if (message.includes("not a git repository")) return { kind: "not-repo" };

    return { kind: "error", message: message || `git exited with code ${result.code}` };
  }

  return parseGitStatus(result.stdout);
}

async function refreshGitStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: RefreshOptions = {},
): Promise<void> {
  if (!ctx.hasUI || refreshInFlight) return;

  refreshInFlight = true;
  try {
    const status = await readGitStatus(pi, ctx);
    lastStatus = status;
    applyGitStatus(status, ctx);
    maybeShowDefaultDetailsPane(status, ctx);

    if (options.notify) {
      if (status.kind === "repo") {
        ctx.ui.notify("Git status updated", "info");
      } else if (status.kind === "not-repo") {
        ctx.ui.notify("No Git repository detected", "warning");
      } else {
        ctx.ui.notify(`Git status failed: ${status.message}`, "error");
      }
    }
  } finally {
    refreshInFlight = false;
  }
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
  refreshDetailsPane();
}

function toggleDetailsPane(_pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (detailsVisible) {
    hideDetailsPane({ disableAutoShow: true });
  } else {
    showDetailsPane(ctx);
  }
}

function clearGitStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, undefined);
  hideDetailsPane();
}

function restartRefreshTimer(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (refreshTimer) clearInterval(refreshTimer);

  refreshTimer = setInterval(() => {
    void refreshGitStatus(pi, ctx);
  }, currentConfig.refreshIntervalMs);
}

export default function gitStatusExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    loadConfig(ctx);
    if (!ctx.hasUI) return;

    overlayTiler ??= registerRightOverlayPane(pi, {
      id: STATUS_KEY,
      order: currentConfig.overlayOrder,
      minWidth: currentConfig.paneMinWidth,
      render: (width, state) => buildDetailsPaneLines(lastStatus, ctx, width, state),
    });
    detailsVisible = false;
    autoShowDetailsPane = currentConfig.autoShowDetailsPane;
    clearGitStatus(ctx);
    await refreshGitStatus(pi, ctx);
    restartRefreshTimer(pi, ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (["bash", "edit", "write"].includes(event.toolName)) {
      await refreshGitStatus(pi, ctx);
    }
  });

  pi.on("user_bash", async (_event, ctx) => {
    await refreshGitStatus(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    refreshInFlight = false;
    detailsVisible = false;
    clearGitStatus(ctx);
    overlayTiler?.dispose();
    overlayTiler = undefined;
  });

  pi.registerCommand("git-status", {
    description: "Toggle a right-side Git branch/change details pane, or use: show, hide, refresh",
    getArgumentCompletions: (prefix) => {
      const options = ["show", "hide", "refresh"];
      return options
        .filter((option) => option.startsWith(prefix.trim()))
        .map((option) => ({ value: option, label: option }));
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "hide" || (action === "" && detailsVisible)) {
        hideDetailsPane({ disableAutoShow: true });
        ctx.ui.notify("Git status details hidden", "info");
        await refreshGitStatus(pi, ctx);
        return;
      }

      if (action === "refresh") {
        await refreshGitStatus(pi, ctx, { notify: true });
        return;
      }

      showDetailsPane(ctx);
      await refreshGitStatus(pi, ctx, { notify: action === "show" });
    },
  });

  pi.registerShortcut("ctrl+shift+g", {
    description: "Toggle Git status details pane",
    handler: async (ctx) => {
      toggleDetailsPane(pi, ctx);
      await refreshGitStatus(pi, ctx);
    },
  });
}
