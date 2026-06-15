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
  normalizeChildPiAgentConfig,
  previewTask,
  renderChildAgentMessage,
  renderChildAgentToolResult,
  runChildPiAgent,
  sendChildAgentReportMessage,
  summarizeToolCalls,
  truncateText,
} from "./zz-lib/child-pi-agent.ts";
import {
  getPositiveIntegerField,
  getStringArrayField,
  getStringField,
  readJsoncConfig,
} from "./zz-lib/jsonc-config.ts";

const CONFIG_FILE_PATH = ".pi/extensions/reviewsubagent.config.jsonc";
const REVIEWSUBAGENT_MESSAGE_TYPE = "reviewsubagent-report";
const STATUS_KEY = "reviewsubagent";
const DEFAULT_TOOLS = ["read", "bash", "grep", "find", "ls"];
const EXCLUDED_CHILD_TOOLS = [
  "readsubagent",
  "explorationsubagent",
  "reviewsubagent",
  "simpletasksubagent",
] as const;
const REVIEWSUBAGENT_EVENT_END = "reviewsubagent:end";
const REVIEWSUBAGENT_EVENT_ERROR = "reviewsubagent:error";
const REVIEWSUBAGENT_EVENT_PROGRESS = "reviewsubagent:progress";
const REVIEWSUBAGENT_EVENT_START = "reviewsubagent:start";

const MAIN_REVIEWSUBAGENT_PROMPT = [
  "<reviewsubagent_code_review>",
  "Use reviewsubagent for code/implementation review when the goal is to evaluate correctness, quality, maintainability, security, type safety, or regression risk.",
  "Do not use readsubagent for code review; readsubagent is for targeted file-inspection answers when review judgment is not needed.",
  "Handle follow-up git operations such as staging, committing, pushing, opening PRs, merging PRs, branch cleanup, or syncing main in the parent session; reviewsubagent is read-only.",
  "Give reviewsubagent the review focus, repo-relative paths, relevant symbols/search terms, expected concerns, and a maxReportChars budget when possible.",
  "Keep direct parent reads/rg for exact edit snippets, precise verification ranges, or small targeted searches where the next action is clear.",
  "</reviewsubagent_code_review>",
].join("\n");

const DEFAULT_REVIEWSUBAGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 400_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "gpt-5.5",
  provider: "openai-codex",
  reportMaxChars: 24_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are a senior code review subagent spawned by Pi. You run on the configured openai-codex/gpt-5.5 model with high reasoning. Review code critically for correctness, regressions, type safety, maintainability, security, edge cases, tests, and API/UX risks. Work read-only: do not edit or write files. Use tools as needed to inspect only relevant files, targeted diffs, call sites, and tests. Bash is allowed only for read-only inspection commands such as rg, find, ls, pwd, git status/log/diff --stat/--name-only/targeted --unified, and test/typecheck commands when explicitly useful. Prefer targeted searches and small reads. Never return raw grep dumps, broad diffs, whole files, or large command transcripts. Return actionable review findings sorted by severity with repo-relative paths and line numbers when possible. If no blocking issues are found, say so clearly and list residual risks or verification gaps.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

interface ReviewFocus {
  readonly maxReportChars?: number | undefined;
  readonly output?: string | undefined;
  readonly searchTerms: readonly string[];
  readonly symbols: readonly string[];
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_REVIEWSUBAGENT_CONFIG };
let lastConfigError: string | undefined;
let reviewSubagentRunCounter = 0;

function readReviewSubagentConfig(cwd: string): ChildPiAgentConfig {
  const normalizeOptions = {
    agentName: "reviewsubagent",
    defaultSystemPrompt: DEFAULT_REVIEWSUBAGENT_CONFIG.systemPrompt,
  };

  lastConfigError = undefined;

  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, cwd);
    if (!record) {
      return normalizeChildPiAgentConfig({ ...DEFAULT_REVIEWSUBAGENT_CONFIG }, normalizeOptions);
    }

    return normalizeChildPiAgentConfig(
      {
        contextWindow:
          getPositiveIntegerField(record, "contextWindow") ??
          DEFAULT_REVIEWSUBAGENT_CONFIG.contextWindow,
        endpoint: getStringField(record, "endpoint") ?? DEFAULT_REVIEWSUBAGENT_CONFIG.endpoint,
        maxOutputTokens:
          getPositiveIntegerField(record, "maxOutputTokens") ??
          DEFAULT_REVIEWSUBAGENT_CONFIG.maxOutputTokens,
        model: getStringField(record, "model") ?? DEFAULT_REVIEWSUBAGENT_CONFIG.model,
        modelSelector: getStringField(record, "modelSelector"),
        provider: getStringField(record, "provider") ?? DEFAULT_REVIEWSUBAGENT_CONFIG.provider,
        reportMaxChars:
          getPositiveIntegerField(record, "reportMaxChars") ??
          DEFAULT_REVIEWSUBAGENT_CONFIG.reportMaxChars,
        requestTimeoutMs:
          getPositiveIntegerField(record, "requestTimeoutMs") ??
          DEFAULT_REVIEWSUBAGENT_CONFIG.requestTimeoutMs,
        systemPrompt:
          getStringField(record, "systemPrompt") ?? DEFAULT_REVIEWSUBAGENT_CONFIG.systemPrompt,
        thinking: getStringField(record, "thinking") ?? DEFAULT_REVIEWSUBAGENT_CONFIG.thinking,
        tools: getStringArrayField(record, "tools") ?? DEFAULT_REVIEWSUBAGENT_CONFIG.tools,
      },
      normalizeOptions,
    );
  } catch (error) {
    lastConfigError = getErrorMessage(error);
    return normalizeChildPiAgentConfig({ ...DEFAULT_REVIEWSUBAGENT_CONFIG }, normalizeOptions);
  }
}

function formatReviewSubagentConfig(config: ChildPiAgentConfig): string {
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
    ctx.ui.notify(`reviewsubagent config ignored: ${lastConfigError}`, "warning");
  }
}

function isChildPiAgentProcess(): boolean {
  return (
    process.env[CHILD_PI_AGENT_ENV] === "1"
  );
}

function normalizeStringList(items: readonly string[] | undefined): string[] {
  return Array.from(new Set((items ?? []).map((item) => item.trim()).filter(Boolean)));
}

function normalizePathList(
  path: string | undefined,
  paths: readonly string[] | undefined,
): string[] {
  return normalizeStringList([...(paths ?? []), ...(path ? [path] : [])]);
}

function formatListSection(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none specified";
}

function getReportMaxChars(config: ChildPiAgentConfig, requested: number | undefined): number {
  if (requested === undefined) return config.reportMaxChars;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error("reviewsubagent maxReportChars must be a positive number.");
  }

  return Math.min(config.reportMaxChars, Math.floor(requested));
}

function formatDelegatedTask(task: string, paths: readonly string[], focus: ReviewFocus): string {
  const output = focus.output?.trim();
  const reportBudget = focus.maxReportChars
    ? `Aim to keep the final parent-visible report under ${Math.floor(focus.maxReportChars).toLocaleString("en-US")} characters.`
    : "Keep the final parent-visible report concise while still including all material findings.";

  return [
    "Code review task/focus:",
    task,
    "",
    "Files/directories/diffs to review:",
    formatListSection(paths),
    "",
    "Known symbols/functions/types/config keys:",
    formatListSection(focus.symbols),
    "",
    "Search terms or regexes to seed review:",
    formatListSection(focus.searchTerms),
    "",
    "Desired output:",
    output ||
      "- Findings first, sorted by severity. For each finding: severity, repo-relative path/line, issue, why it matters, and suggested fix. Then include residual risks/verification gaps. If no material issues, say so clearly.",
    "",
    "Report constraints:",
    `- ${reportBudget}`,
    "- Be critical and specific; avoid generic advice.",
    "- Cite repo-relative paths and line numbers whenever possible.",
    "- Do not paste raw rg/find/grep dumps, broad diffs, whole files, or large command output.",
    "- Include short targeted snippets only when they are necessary to explain a finding.",
    "- If the review scope is underspecified, inspect likely relevant files/diffs and state any uncertainty.",
  ].join("\n");
}

function buildReviewSubagentPrompt(task: string): string {
  return [
    "You are running as the child process for the parent Pi reviewsubagent tool.",
    "Your purpose is high-quality code review outside the parent model context, using the configured openai-codex/gpt-5.5 model with xhigh thinking.",
    "Work read-only. Do not edit or write files. Bash is allowed only for inspection and verification commands that do not mutate the repo.",
    "If reviewing local changes, prefer git status --short, git diff --stat, git diff --name-only, and targeted git diff --unified=3 -- <path> before reading files. Do not return raw diffs.",
    "If reviewing files, inspect relevant call sites, tests, config, and types as needed, but keep tool output targeted and context-efficient.",
    "Focus on actionable correctness, regression, security, type-safety, maintainability, test, and edge-case issues. Avoid nitpicks unless they hide real risk.",
    "Final report format: Summary, Findings sorted by severity, Suggested fixes, Verification gaps/residual risks. If no material findings, say so explicitly.",
    `Delegated code review task:\n${task}`,
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

async function runReviewSubagentTask(options: {
  readonly config: ChildPiAgentConfig;
  readonly cwd?: string | undefined;
  readonly defaultCwd: string;
  readonly maxReportChars?: number | undefined;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly output?: string | undefined;
  readonly paths: readonly string[];
  readonly pi: ExtensionAPI;
  readonly searchTerms?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly symbols?: readonly string[] | undefined;
  readonly task: string;
}): Promise<ChildAgentRunResult> {
  const searchTerms = normalizeStringList(options.searchTerms);
  const symbols = normalizeStringList(options.symbols);
  const maxReportChars = getReportMaxChars(options.config, options.maxReportChars);
  const task = formatDelegatedTask(options.task, options.paths, {
    maxReportChars,
    output: options.output,
    searchTerms,
    symbols,
  });
  const runId = ++reviewSubagentRunCounter;
  const baseEvent = {
    cwd: options.cwd ?? options.defaultCwd,
    maxReportChars,
    model: getModelSelector(options.config),
    output: options.output,
    paths: options.paths,
    runId,
    searchTerms,
    symbols,
    task,
  };
  const startedAt = Date.now();

  options.pi.events.emit(REVIEWSUBAGENT_EVENT_START, { ...baseEvent, startedAt });

  const onProgress = (progress: ChildAgentProgress) => {
    options.pi.events.emit(REVIEWSUBAGENT_EVENT_PROGRESS, {
      ...baseEvent,
      progress,
      startedAt,
      updatedAt: Date.now(),
    });
    options.onProgress?.(progress);
  };

  try {
    const result = await runChildPiAgent({
      buildPrompt: buildReviewSubagentPrompt,
      config: options.config,
      cwd: options.cwd,
      defaultCwd: options.defaultCwd,
      excludeTools: EXCLUDED_CHILD_TOOLS,
      onProgress,
      signal: options.signal,
      task,
    });

    options.pi.events.emit(REVIEWSUBAGENT_EVENT_END, {
      ...baseEvent,
      endedAt: Date.now(),
      result,
      startedAt,
    });
    return result;
  } catch (error) {
    options.pi.events.emit(REVIEWSUBAGENT_EVENT_ERROR, {
      ...baseEvent,
      endedAt: Date.now(),
      errorMessage: getErrorMessage(error),
      startedAt,
    });
    throw error;
  }
}

export default function reviewSubagentExtension(pi: ExtensionAPI) {
  currentConfig = readReviewSubagentConfig(process.cwd());

  pi.on("session_start", (_event, ctx) => {
    currentConfig = readReviewSubagentConfig(ctx.cwd);
    notifyConfigErrorIfNeeded(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerMessageRenderer(REVIEWSUBAGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "reviewsubagent" }),
  );

  pi.on("before_agent_start", (event) => {
    if (isChildPiAgentProcess()) return undefined;
    if (!pi.getActiveTools().includes("reviewsubagent")) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${MAIN_REVIEWSUBAGENT_PROMPT}`,
    };
  });

  pi.registerCommand("reviewsubagent-config", {
    description: "Show /reviewsubagent config",
    handler: (_args, ctx) => {
      currentConfig = readReviewSubagentConfig(ctx.cwd);
      ctx.ui.notify(`reviewsubagent config:\n${formatReviewSubagentConfig(currentConfig)}`, "info");
      notifyConfigErrorIfNeeded(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("reviewsubagent", {
    description: "Run a high-reasoning code review in a child Pi process",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /reviewsubagent <code review request>", "warning");
        return;
      }

      const config = readReviewSubagentConfig(ctx.cwd);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(task)}`);

      try {
        const result = await runReviewSubagentTask({
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
          messageType: REVIEWSUBAGENT_MESSAGE_TYPE,
          pi,
          report,
          result,
        });

        const level = result.status === "completed" ? "info" : "warning";
        ctx.ui.notify(
          `reviewsubagent ${result.status}; report added to main context (${summarizeToolCalls(result.toolCalls)})`,
          level,
        );
      } catch (error) {
        ctx.ui.notify(`reviewsubagent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });

  pi.registerTool({
    name: "reviewsubagent",
    label: "Review Subagent",
    description:
      "Run a high-reasoning code review in a child Pi process using the configured openai-codex/gpt-5.5 model with xhigh thinking. The child works read-only and returns actionable review findings instead of raw file or diff output.",
    promptSnippet:
      "Delegate code review to openai-codex/gpt-5.5 with xhigh thinking and get actionable findings",
    promptGuidelines: [
      "Use reviewsubagent for code/implementation review when the goal is to evaluate correctness, quality, maintainability, security, type safety, or regression risk.",
      "Do not use readsubagent for code review; readsubagent is for targeted file-inspection answers when review judgment is not needed.",
      "Handle follow-up git operations such as staging, committing, pushing, opening PRs, merging PRs, branch cleanup, or syncing main in the parent session; reviewsubagent is read-only.",
      "Provide repo-relative paths, relevant symbols/search terms, review focus, expected concerns, and maxReportChars when possible.",
      "Use direct read/grep instead when you need exact snippets for edits, precise line ranges, or final verification rather than review judgment.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description:
          "Code review task or focus. Include what changed, what risks to evaluate, and what output format you need.",
      }),
      path: Type.Optional(
        Type.String({ description: "Single repo-relative file or directory to review" }),
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Repo-relative files or directories to review, ordered by relevance. Use paths instead of broad repo review when possible.",
        }),
      ),
      symbols: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Specific functions, classes, types, config keys, route names, or other symbols to inspect during review",
        }),
      ),
      searchTerms: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Focused search terms or regexes the child should use to find call sites or related behavior",
        }),
      ),
      output: Type.Optional(
        Type.String({
          description:
            "Desired report shape and level of detail, e.g. blocking findings only, severity table, or fix recommendations",
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
      const config = readReviewSubagentConfig(ctx.cwd);
      const paths = normalizePathList(params.path, params.paths);
      const result = await runReviewSubagentTask({
        config,
        cwd: params.cwd,
        defaultCwd: ctx.cwd,
        maxReportChars: params.maxReportChars,
        output: params.output,
        paths,
        pi,
        searchTerms: params.searchTerms,
        signal,
        symbols: params.symbols,
        task: params.task,
        onProgress: (progress) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `reviewsubagent running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
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
      const path = typeof args.path === "string" ? args.path : "";
      const pathCount = Array.isArray(args.paths) ? args.paths.length : 0;
      const pathText = path || (pathCount > 0 ? `${pathCount} paths` : "code");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("reviewsubagent"))} ${theme.fg("accent", pathText)} ${theme.fg("dim", previewTask(task || "..."))}`,
        0,
        0,
      );
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "reviewsubagent" });
    },
  });
}
