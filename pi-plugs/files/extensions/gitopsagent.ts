import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  CHILD_PI_AGENT_ENV,
  type ChildAgentProgress,
  type ChildAgentRunResult,
  type ChildPiAgentConfig,
  getChildAgentResultDetails,
  getErrorMessage,
  getModelSelector,
  isRecord,
  LEGACY_LOCALAGENT_CHILD_ENV,
  normalizeChildPiAgentConfig,
  previewTask,
  renderChildAgentMessage,
  renderChildAgentToolResult,
  runChildPiAgent,
  sendChildAgentReportMessage,
  summarizeToolCalls,
  truncateText,
} from "./lib/child-pi-agent.ts";
import {
  getPositiveIntegerField,
  getStringArrayField,
  getStringField,
  readJsoncConfig,
} from "./lib/jsonc-config.ts";

const CONFIG_FILE_PATH = ".pi/extensions/gitopsagent.config.jsonc";
const GITOPSAGENT_MESSAGE_TYPE = "gitopsagent-report";
const STATUS_KEY = "gitopsagent";
const DEFAULT_TOOLS = ["read", "bash", "grep", "find", "ls"];
const EXCLUDED_CHILD_TOOLS = [
  "localagent",
  "refagent",
  "readsubagent",
  "prreview",
  "explorationsubagent",
  "reviewsubagent",
  "gitopsagent",
  "simpletasksubagent",
] as const;
const GITOPSAGENT_EVENT_END = "gitopsagent:end";
const GITOPSAGENT_EVENT_ERROR = "gitopsagent:error";
const GITOPSAGENT_EVENT_PROGRESS = "gitopsagent:progress";
const GITOPSAGENT_EVENT_START = "gitopsagent:start";
const DEFAULT_BASE_REF = "repository default branch";
const DEFAULT_REMOTE = "origin";

const MAIN_GITOPSAGENT_PROMPT = [
  "<gitopsagent_delegation>",
  "Use gitopsagent for git workflows that mutate repository or remote state: creating branches, staging files, committing, pushing, opening PRs, merging PRs, deleting branches, or syncing the target base/default branch after PR merge.",
  "Keep read-only git inspection in the parent when it is small and directly useful: git status --short, git log --oneline -n, git diff --stat, git diff --name-only, or git diff --check.",
  "Do not perform direct parent-agent merges to the target base/default branch. All merges to the base/default branch must go through a Pull Request, and gitopsagent should enforce that rule.",
  "Delegate commit/PR/merge operations with explicit task, target files, base branch if known, remote, PR title/body if known, and whether the PR should be merged after creation.",
  "When the base branch is not specified, gitopsagent should determine the repository's remote default branch before creating or merging a PR instead of assuming main.",
  "Use prreview for PR readiness review without mutation; use gitopsagent for actually committing, pushing, creating, merging, and syncing PR branches.",
  "</gitopsagent_delegation>",
].join("\n");

const DEFAULT_GITOPSAGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 400_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "gpt-5.5",
  provider: "openai-codex",
  reportMaxChars: 24_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are a senior git and GitHub Pull Request operations subagent spawned by Pi. You run on the configured openai-codex/gpt-5.5 model with xhigh reasoning. Your job is to perform requested git workflows safely and report back: branch creation/switching, staging explicit files, committing, pushing, opening PRs, merging PRs through GitHub, cleaning up branches, and syncing the local base/default branch after remote PR merges. You may mutate git state and remote GitHub state only when the delegated task explicitly requires it. Work carefully: check status before mutations, preserve unrelated work, never stage unrelated files, never rewrite history unless explicitly requested, and stop if the requested operation is ambiguous or unsafe. All merges to the target base/default branch must be done through a Pull Request; never directly merge a feature branch into the local or remote base/default branch. Do not edit source files. Bash is allowed for git/gh operations, read-only inspection commands, and non-mutating verification commands. Verify the repository default branch and GitHub CLI/auth state before PR operations when the task does not provide them. Return concise results with commands run, files staged, commit hashes, PR URLs, merge status, final branch/status, and any blockers or follow-up needed.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

interface GitOpsFocus {
  readonly branch?: string | undefined;
  readonly maxReportChars?: number | undefined;
  readonly output?: string | undefined;
  readonly prBody?: string | undefined;
  readonly prTitle?: string | undefined;
  readonly remote: string;
  readonly targetBase: string;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_GITOPSAGENT_CONFIG };
let lastConfigError: string | undefined;
let gitOpsAgentRunCounter = 0;

function readGitOpsAgentConfig(cwd: string): ChildPiAgentConfig {
  const normalizeOptions = {
    agentName: "gitopsagent",
    defaultSystemPrompt: DEFAULT_GITOPSAGENT_CONFIG.systemPrompt,
  };

  lastConfigError = undefined;

  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, cwd);
    if (!record) {
      return normalizeChildPiAgentConfig({ ...DEFAULT_GITOPSAGENT_CONFIG }, normalizeOptions);
    }

    return normalizeChildPiAgentConfig(
      {
        contextWindow:
          getPositiveIntegerField(record, "contextWindow") ??
          DEFAULT_GITOPSAGENT_CONFIG.contextWindow,
        endpoint: getStringField(record, "endpoint") ?? DEFAULT_GITOPSAGENT_CONFIG.endpoint,
        maxOutputTokens:
          getPositiveIntegerField(record, "maxOutputTokens") ??
          DEFAULT_GITOPSAGENT_CONFIG.maxOutputTokens,
        model: getStringField(record, "model") ?? DEFAULT_GITOPSAGENT_CONFIG.model,
        modelSelector: getStringField(record, "modelSelector"),
        provider: getStringField(record, "provider") ?? DEFAULT_GITOPSAGENT_CONFIG.provider,
        reportMaxChars:
          getPositiveIntegerField(record, "reportMaxChars") ??
          DEFAULT_GITOPSAGENT_CONFIG.reportMaxChars,
        requestTimeoutMs:
          getPositiveIntegerField(record, "requestTimeoutMs") ??
          DEFAULT_GITOPSAGENT_CONFIG.requestTimeoutMs,
        systemPrompt:
          getStringField(record, "systemPrompt") ?? DEFAULT_GITOPSAGENT_CONFIG.systemPrompt,
        thinking: getStringField(record, "thinking") ?? DEFAULT_GITOPSAGENT_CONFIG.thinking,
        tools: getStringArrayField(record, "tools") ?? DEFAULT_GITOPSAGENT_CONFIG.tools,
      },
      normalizeOptions,
    );
  } catch (error) {
    lastConfigError = getErrorMessage(error);
    return normalizeChildPiAgentConfig({ ...DEFAULT_GITOPSAGENT_CONFIG }, normalizeOptions);
  }
}

function formatGitOpsAgentConfig(config: ChildPiAgentConfig): string {
  return [
    `config file: ${CONFIG_FILE_PATH}`,
    "provider registration: none (uses Pi's configured provider/auth)",
    `provider: ${config.provider}`,
    `model: ${config.model}`,
    `child model selector: ${getModelSelector(config)}`,
    `tools: ${config.tools.join(", ") || "Pi defaults"}`,
    `limits: timeout ${config.requestTimeoutMs}ms, report ${config.reportMaxChars} chars`,
    `thinking: ${config.thinking}`,
  ].join("\n");
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`gitopsagent config ignored: ${lastConfigError}`, "warning");
  }
}

function isChildPiAgentProcess(): boolean {
  return (
    process.env[CHILD_PI_AGENT_ENV] === "1" || process.env[LEGACY_LOCALAGENT_CHILD_ENV] === "1"
  );
}

function normalizeStringList(items: readonly string[] | undefined): string[] {
  return Array.from(new Set((items ?? []).map((item) => item.trim()).filter(Boolean)));
}

function formatListSection(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none specified";
}

function normalizeRef(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function getReportMaxChars(config: ChildPiAgentConfig, requested: number | undefined): number {
  if (requested === undefined) return config.reportMaxChars;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error("gitopsagent maxReportChars must be a positive number.");
  }

  return Math.min(config.reportMaxChars, Math.floor(requested));
}

function formatDelegatedTask(task: string, paths: readonly string[], focus: GitOpsFocus): string {
  const output = focus.output?.trim();
  const branch = focus.branch?.trim();
  const prTitle = focus.prTitle?.trim();
  const prBody = focus.prBody?.trim();
  const reportBudget = focus.maxReportChars
    ? `Aim to keep the final parent-visible report under ${Math.floor(focus.maxReportChars).toLocaleString("en-US")} characters.`
    : "Keep the final parent-visible report concise while still listing material git/PR results.";

  return [
    "Git/PR operations task:",
    task,
    "",
    "Target files/directories to consider for staging or inspection:",
    formatListSection(paths),
    "",
    "Branch/remote/base hints:",
    `- desired/current feature branch: ${branch || "not specified"}`,
    `- remote: ${focus.remote}`,
    `- target base branch: ${focus.targetBase}`,
    "",
    "PR metadata hints:",
    `- title: ${prTitle || "not specified"}`,
    `- body: ${prBody || "not specified"}`,
    "",
    "Desired output:",
    output ||
      "- Summary, commands run, files staged, commit hashes, pushed branch, PR URL, merge status, final branch/status, blockers/follow-up.",
    "",
    "Safety constraints:",
    "- Start with git status --short --branch --untracked-files=all.",
    "- Preserve unrelated user work; stage only explicit files or files clearly in scope.",
    "- If the target base branch is not specified, determine the repository's remote default branch before creating or merging a PR instead of assuming main.",
    "- If on the target base/default branch and a commit is needed, create or switch to a feature branch before committing unless the task explicitly says otherwise and it is not targeting the base branch.",
    "- All merges to the target base/default branch must go through a Pull Request; never use git merge to merge a feature branch directly into the local base branch.",
    "- If asked to merge to the target base/default branch, create/find the PR and use gh pr merge or equivalent PR workflow, then sync the local base branch with the remote using fast-forward pull/fetch.",
    "- Before committing or pushing, run git diff --check or git diff --cached --check on in-scope changes when practical; report validation blockers.",
    "- Never rewrite history, force-push, reset, clean, stash, delete branches, or close PRs unless explicitly requested and clearly safe.",
    "- Do not edit source files; this agent is for git and GitHub operations, not code changes.",
    "",
    "Report constraints:",
    `- ${reportBudget}`,
    "- Do not paste raw diffs, broad command output, or secrets/tokens.",
    "- Include exact commands only when useful to explain what happened or what remains blocked.",
  ].join("\n");
}

function buildGitOpsAgentPrompt(task: string): string {
  return [
    "You are running as the child process for the parent Pi gitopsagent tool.",
    "Your purpose is expert git and GitHub PR operations outside the parent model context, using the configured openai-codex/gpt-5.5 model with xhigh thinking.",
    "You may mutate git state and GitHub PR state only as required by the delegated task. You must not edit source files.",
    "Always begin by inspecting status/branch/remotes. Use git status --short --branch --untracked-files=all, git branch --show-current, and targeted git diff --stat/--name-only/--check as needed.",
    "For commits: stage only requested/in-scope files, run git diff --cached --check when useful, commit with an appropriate message, and report the commit hash.",
    "For PRs: push the feature branch, determine the remote default base branch when no base is provided (for example with gh repo view --json defaultBranchRef or origin/HEAD), verify gh CLI/auth when using gh, create or update the PR, report the PR URL, and do not merge unless the task explicitly asks you to merge.",
    "For merges to the target base/default branch: never direct-merge locally. Use a Pull Request merge command/workflow, then fetch/pull the remote base branch with --ff-only and report final status.",
    "Stop and report blockers instead of guessing when credentials, branch state, conflicts, checks, or unrelated working-tree changes make the operation unsafe.",
    "Finish by checking git status --short --branch and include whether the final working tree is clean or what remains dirty.",
    "Final report format: Summary, Commands/operations, Files staged, Commits, PRs, Merge/sync status, Final status, Blockers/follow-up.",
    `Delegated git/PR task:\n${task}`,
  ].join("\n\n");
}

function formatReport(
  result: ChildAgentRunResult,
  config: ChildPiAgentConfig,
  requestedMaxReportChars?: number,
): string {
  return truncateText(
    result.output.trim() || "(no output)",
    getReportMaxChars(config, requestedMaxReportChars),
  );
}

async function runGitOpsAgentTask(options: {
  readonly branch?: string | undefined;
  readonly config: ChildPiAgentConfig;
  readonly cwd?: string | undefined;
  readonly defaultCwd: string;
  readonly maxReportChars?: number | undefined;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly output?: string | undefined;
  readonly paths: readonly string[];
  readonly pi: ExtensionAPI;
  readonly prBody?: string | undefined;
  readonly prTitle?: string | undefined;
  readonly remote?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly targetBase?: string | undefined;
  readonly task: string;
}): Promise<ChildAgentRunResult> {
  const maxReportChars = getReportMaxChars(options.config, options.maxReportChars);
  const task = formatDelegatedTask(options.task, options.paths, {
    branch: options.branch,
    maxReportChars,
    output: options.output,
    prBody: options.prBody,
    prTitle: options.prTitle,
    remote: normalizeRef(options.remote, DEFAULT_REMOTE),
    targetBase: normalizeRef(options.targetBase, DEFAULT_BASE_REF),
  });
  const runId = ++gitOpsAgentRunCounter;
  const baseEvent = {
    branch: options.branch,
    cwd: options.cwd ?? options.defaultCwd,
    maxReportChars,
    model: getModelSelector(options.config),
    output: options.output,
    paths: options.paths,
    prBody: options.prBody,
    prTitle: options.prTitle,
    remote: normalizeRef(options.remote, DEFAULT_REMOTE),
    runId,
    targetBase: normalizeRef(options.targetBase, DEFAULT_BASE_REF),
    task,
  };
  const startedAt = Date.now();

  options.pi.events.emit(GITOPSAGENT_EVENT_START, { ...baseEvent, startedAt });

  const onProgress = (progress: ChildAgentProgress) => {
    options.pi.events.emit(GITOPSAGENT_EVENT_PROGRESS, {
      ...baseEvent,
      progress,
      startedAt,
      updatedAt: Date.now(),
    });
    options.onProgress?.(progress);
  };

  try {
    const result = await runChildPiAgent({
      buildPrompt: buildGitOpsAgentPrompt,
      config: options.config,
      cwd: options.cwd,
      defaultCwd: options.defaultCwd,
      excludeTools: EXCLUDED_CHILD_TOOLS,
      onProgress,
      signal: options.signal,
      task,
    });

    options.pi.events.emit(GITOPSAGENT_EVENT_END, {
      ...baseEvent,
      endedAt: Date.now(),
      result,
      startedAt,
    });
    return result;
  } catch (error) {
    options.pi.events.emit(GITOPSAGENT_EVENT_ERROR, {
      ...baseEvent,
      endedAt: Date.now(),
      errorMessage: getErrorMessage(error),
      startedAt,
    });
    throw error;
  }
}

export default function gitOpsAgentExtension(pi: ExtensionAPI) {
  currentConfig = readGitOpsAgentConfig(process.cwd());

  pi.on("session_start", (_event, ctx) => {
    currentConfig = readGitOpsAgentConfig(ctx.cwd);
    notifyConfigErrorIfNeeded(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerMessageRenderer(GITOPSAGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "gitopsagent" }),
  );

  pi.on("before_agent_start", (event) => {
    if (isChildPiAgentProcess()) return undefined;
    if (!pi.getActiveTools().includes("gitopsagent")) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${MAIN_GITOPSAGENT_PROMPT}`,
    };
  });

  pi.registerCommand("gitopsagent-config", {
    description: "Show /gitopsagent config",
    handler: (_args, ctx) => {
      currentConfig = readGitOpsAgentConfig(ctx.cwd);
      ctx.ui.notify(`gitopsagent config:\n${formatGitOpsAgentConfig(currentConfig)}`, "info");
      notifyConfigErrorIfNeeded(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("gitopsagent", {
    description: "Run expert git/PR operations in a child Pi process",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /gitopsagent <git or PR operation request>", "warning");
        return;
      }

      const config = readGitOpsAgentConfig(ctx.cwd);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(task)}`);

      try {
        const result = await runGitOpsAgentTask({
          config,
          defaultCwd: ctx.cwd,
          paths: [],
          pi,
          task,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              STATUS_KEY,
              `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        const report = formatReport(result, config);
        sendChildAgentReportMessage({
          config,
          ctx,
          messageType: GITOPSAGENT_MESSAGE_TYPE,
          pi,
          report,
          result,
        });

        const level = result.status === "completed" ? "info" : "warning";
        ctx.ui.notify(
          `gitopsagent ${result.status}; report added to main context (${summarizeToolCalls(result.toolCalls)})`,
          level,
        );
      } catch (error) {
        ctx.ui.notify(`gitopsagent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });

  pi.registerTool({
    name: "gitopsagent",
    label: "GitOps Agent",
    description:
      "Run expert git and GitHub Pull Request operations in a child Pi process using the configured openai-codex/gpt-5.5 model with xhigh thinking. Use for committing, pushing, opening PRs, merging PRs, branch cleanup, and syncing the target base/default branch while preserving unrelated work.",
    promptSnippet:
      "Delegate commit, push, PR creation/merge, branch cleanup, and base-branch sync to a git operations expert subagent",
    promptGuidelines: [
      "Use gitopsagent for git workflows that mutate repository or remote state: branch creation, staging, committing, pushing, opening PRs, merging PRs, deleting branches, or syncing the target base/default branch after a PR merge.",
      "Keep small read-only git inspection in the parent when it is directly useful: git status --short, git log --oneline, git diff --stat/name-only/check.",
      "All merges to the target base/default branch must go through a Pull Request; use gitopsagent for commit/PR/merge workflows instead of direct parent-agent merges.",
      "Provide explicit task, target files, base branch if known, remote, desired branch name, PR title/body, and whether the PR should be merged after creation. If base is omitted, gitopsagent should detect the remote default branch.",
      "Use prreview for PR readiness review without mutation; use gitopsagent for actually committing, pushing, creating, merging, and syncing PR branches.",
      "Do not ask gitopsagent to edit source files; make code changes in the parent or another coding agent, then delegate the git operation.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description:
          "Git or GitHub PR operation request. Include whether to create/switch branch, stage/commit, push, open PR, merge PR, clean up branches, or sync the target base/default branch.",
      }),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Repo-relative files or directories that are in scope for staging, committing, or inspection. Helps avoid staging unrelated changes.",
        }),
      ),
      branch: Type.Optional(
        Type.String({
          description:
            "Desired feature branch or branch expected to contain the work. The child may create/switch to it if the task requires.",
        }),
      ),
      targetBase: Type.Optional(
        Type.String({ description: "Target base branch for PRs. If omitted, gitopsagent should detect the repository default branch." }),
      ),
      remote: Type.Optional(Type.String({ description: "Git remote name. Defaults to origin." })),
      prTitle: Type.Optional(
        Type.String({ description: "Optional PR title to use if creating a PR." }),
      ),
      prBody: Type.Optional(
        Type.String({ description: "Optional PR body to use if creating a PR." }),
      ),
      output: Type.Optional(
        Type.String({
          description:
            "Desired report shape and level of detail, e.g. concise operations log, PR URL only, or full commit/merge summary.",
        }),
      ),
      maxReportChars: Type.Optional(
        Type.Number({
          description:
            "Optional maximum characters to return to the main context. Clamped to the configured reportMaxChars.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Optional working directory for the child process" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = readGitOpsAgentConfig(ctx.cwd);
      const paths = normalizeStringList(params.paths);
      const result = await runGitOpsAgentTask({
        branch: params.branch,
        config,
        cwd: params.cwd,
        defaultCwd: ctx.cwd,
        maxReportChars: params.maxReportChars,
        output: params.output,
        paths,
        pi,
        prBody: params.prBody,
        prTitle: params.prTitle,
        remote: params.remote,
        signal,
        targetBase: params.targetBase,
        task: params.task,
        onProgress: (progress) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `gitopsagent running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
              },
            ],
            details: progress,
          });
        },
      });

      const report = formatReport(result, config, params.maxReportChars);
      return {
        content: [{ type: "text", text: report }],
        details: getChildAgentResultDetails(result, config),
      };
    },

    renderCall(rawArgs: unknown, theme) {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const task = typeof args.task === "string" ? args.task : "";
      const branch = typeof args.branch === "string" ? args.branch : "";
      const pathCount = Array.isArray(args.paths) ? args.paths.length : 0;
      const target = branch || (pathCount > 0 ? `${pathCount} paths` : "git");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("gitopsagent"))} ${theme.fg("accent", target)} ${theme.fg("dim", previewTask(task || "..."))}`,
        0,
        0,
      );
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "gitopsagent" });
    },
  });
}
