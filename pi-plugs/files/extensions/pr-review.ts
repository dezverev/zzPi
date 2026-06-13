import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  CHILD_PI_AGENT_ENV,
  type ChildAgentRunResult,
  type ChildPiAgentConfig,
  formatChildAgentConfig,
  formatChildAgentReport,
  getChildAgentResultDetails,
  getErrorMessage,
  getModelSelector,
  isRecord,
  LEGACY_LOCALAGENT_CHILD_ENV,
  previewTask,
  readChildPiAgentConfig,
  registerChildAgentProvider,
  renderChildAgentMessage,
  renderChildAgentToolResult,
  runChildPiAgent,
  sendChildAgentReportMessage,
} from "./lib/child-pi-agent.ts";

const CONFIG_FILE_PATH = ".pi/extensions/pr-review.config.jsonc";
const PR_REVIEW_MESSAGE_TYPE = "pr-review-report";
const STATUS_KEY = "pr-review";
const DEFAULT_BASE_REF = "origin/main";
const DEFAULT_HEAD_REF = "HEAD";
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

const MAIN_PR_REVIEW_PROMPT = [
  "<prreview_delegation>",
  "Use prreview before opening or updating a PR when the task needs a PR-readiness summary, changed-file summary, risk/issues review, suggested PR title/body, or verification notes.",
  "Use prreview to keep raw git diff/log/status output out of the parent context; the child should inspect git status, log, diff --stat, diff --name-only, diff --check, and only targeted small patches when needed.",
  "Provide base/head refs and focus when useful. Default comparison is origin/main...HEAD.",
  "Use reviewsubagent instead for focused code/implementation review judgment. Use gitopsagent instead for staging, committing, pushing, PR creation/merge, branch cleanup, or syncing main.",
  "</prreview_delegation>",
].join("\n");

const DEFAULT_PR_REVIEW_CONFIG: ChildPiAgentConfig = {
  contextWindow: 262_144,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "qwen3.6-35b-a3b-mlx",
  provider: "local-prreview",
  reportMaxChars: 16_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are a PR review subagent spawned by Pi. Review git status, log, and diffs inside your isolated child context so the parent agent does not need raw patch output. Work read-only: do not edit or write files. Prefer git diff --stat, --name-only, and --check before reading patches. Inspect patches only with targeted paths and small unified context when needed. Never include full diffs or large file dumps in your final answer. Return a concise PR-readiness report with changed-files summary, risks/issues, suggested PR title/body, and verification notes.",
  thinking: "off",
  tools: DEFAULT_TOOLS,
};

interface PrReviewOptions {
  readonly base: string;
  readonly focus?: string | undefined;
  readonly head: string;
}

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_PR_REVIEW_CONFIG };
let lastConfigError: string | undefined;

function readPrReviewConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "prreview",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_PR_REVIEW_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function registerPrReviewProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (PR review LM Studio)",
    providerDisplayName: "Local PR Review Agent",
  });
}

function normalizeRef(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function parseCommandOptions(args: string): PrReviewOptions {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const focusTokens: string[] = [];
  let base = DEFAULT_BASE_REF;
  let head = DEFAULT_HEAD_REF;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    const next = tokens[index + 1];

    if (token === "--base" && next) {
      base = next;
      index += 1;
      continue;
    }

    if (token.startsWith("--base=")) {
      base = token.slice("--base=".length);
      continue;
    }

    if (token === "--head" && next) {
      head = next;
      index += 1;
      continue;
    }

    if (token.startsWith("--head=")) {
      head = token.slice("--head=".length);
      continue;
    }

    focusTokens.push(token);
  }

  const focus = focusTokens.join(" ").trim();
  return {
    base: normalizeRef(base, DEFAULT_BASE_REF),
    ...(focus ? { focus } : {}),
    head: normalizeRef(head, DEFAULT_HEAD_REF),
  };
}

function buildPrReviewTask(options: PrReviewOptions): string {
  return [
    "Review the current branch for PR readiness without returning raw diffs to the parent context.",
    `Comparison: ${options.base}...${options.head}`,
    options.focus
      ? `Additional focus: ${options.focus}`
      : "Additional focus: general PR summary and risk review.",
  ].join("\n");
}

function buildPrReviewPrompt(task: string, options: PrReviewOptions): string {
  const diffRange = `${options.base}...${options.head}`;
  const logRange = `${options.base}..${options.head}`;

  return [
    "You are running as the child process for the parent Pi /pr-review command and prreview tool.",
    "Your purpose is to inspect git changes outside the parent model context and return only a concise report.",
    "Use repo-local git commands first, especially:",
    "- git status --short --branch --untracked-files=all",
    `- git log --oneline ${logRange}`,
    `- git diff --stat ${diffRange}`,
    `- git diff --name-only ${diffRange}`,
    `- git diff --check ${diffRange}`,
    `Read targeted files or targeted patches only when needed to assess risk; use git diff --unified=3 ${diffRange} -- <path> rather than broad diffs.`,
    "Do not paste full diffs, large TypeScript/source dumps, or raw command output in the final answer. Summarize findings and cite changed repo-relative paths.",
    "If a base ref is missing or stale, say so and suggest the exact fetch/update command instead of guessing.",
    "Final report format: Ready?, Summary, Changed files, Issues/Risks, Suggested PR title, Suggested PR body, Verification.",
    `Delegated PR review task:\n${task}`,
  ].join("\n\n");
}

function formatReport(result: ChildAgentRunResult, config: ChildPiAgentConfig): string {
  return formatChildAgentReport(result, config, { title: "PR review report" });
}

function notifyConfigErrorIfNeeded(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`prreview config ignored: ${lastConfigError}`, "warning");
  }
}

function isChildPiAgentProcess(): boolean {
  return (
    process.env[CHILD_PI_AGENT_ENV] === "1" || process.env[LEGACY_LOCALAGENT_CHILD_ENV] === "1"
  );
}

export default function prReviewExtension(pi: ExtensionAPI) {
  currentConfig = readPrReviewConfig(process.cwd());
  registerPrReviewProvider(pi, currentConfig);

  pi.on("session_start", (_event, ctx) => {
    currentConfig = readPrReviewConfig(ctx.cwd);
    registerPrReviewProvider(pi, currentConfig);
    notifyConfigErrorIfNeeded(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerMessageRenderer(PR_REVIEW_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "prreview" }),
  );

  pi.on("before_agent_start", (event) => {
    if (isChildPiAgentProcess()) return undefined;
    if (!pi.getActiveTools().includes("prreview")) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${MAIN_PR_REVIEW_PROMPT}`,
    };
  });

  pi.registerCommand("pr-review-config", {
    description: "Show /pr-review config",
    handler: (_args, ctx) => {
      currentConfig = readPrReviewConfig(ctx.cwd);
      registerPrReviewProvider(pi, currentConfig);
      ctx.ui.notify(
        `prreview config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}`,
        "info",
      );
      notifyConfigErrorIfNeeded(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("pr-review", {
    description: "Run a child-agent PR diff review without loading raw patches into main context",
    handler: async (args, ctx) => {
      const options = parseCommandOptions(args);
      const task = buildPrReviewTask(options);
      const config = readPrReviewConfig(ctx.cwd);
      registerPrReviewProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus(STATUS_KEY, `running ${model}: ${previewTask(task)}`);

      try {
        const result = await runChildPiAgent({
          buildPrompt: (promptTask) => buildPrReviewPrompt(promptTask, options),
          config,
          defaultCwd: ctx.cwd,
          excludeTools: EXCLUDED_CHILD_TOOLS,
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
          messageType: PR_REVIEW_MESSAGE_TYPE,
          pi,
          report,
          result,
        });

        const level = result.status === "completed" ? "info" : "warning";
        ctx.ui.notify(`prreview ${result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`prreview failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });

  pi.registerTool({
    name: "prreview",
    label: "PR Review Agent",
    description:
      "Run a PR-oriented git diff/status/log review in a child Pi process so raw patches stay out of the main context. The child returns a concise readiness report and suggested PR title/body.",
    promptSnippet:
      "Use a child Pi process to review git changes for PR readiness without loading raw diffs",
    promptGuidelines: [
      "Use prreview before opening or updating a PR when reviewing git diff output in the parent would consume significant context.",
      "Let the child inspect git status, log, diff --stat, diff --name-only, diff --check, and targeted small patches; do not dump broad git diffs in the main context.",
      "Provide base/head refs and any review focus; default comparison is origin/main...HEAD.",
      "Use the returned concise report for PR title/body, changed-file summary, risks, and verification notes.",
      "Use reviewsubagent instead when the goal is focused code review judgment rather than PR packaging/readiness.",
      "Use gitopsagent instead when the task is to commit, push, create a PR, merge a PR, clean up branches, or sync main.",
    ],
    parameters: Type.Object({
      task: Type.Optional(
        Type.String({
          description:
            "Optional PR review focus or context, e.g. 'prepare a title/body for this branch' or 'look for risky TypeScript changes'.",
        }),
      ),
      base: Type.Optional(
        Type.String({ description: "Base ref for comparison. Defaults to origin/main." }),
      ),
      head: Type.Optional(
        Type.String({ description: "Head ref for comparison. Defaults to HEAD." }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Optional working directory for the child process" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const options: PrReviewOptions = {
        base: normalizeRef(params.base, DEFAULT_BASE_REF),
        ...(params.task?.trim() ? { focus: params.task.trim() } : {}),
        head: normalizeRef(params.head, DEFAULT_HEAD_REF),
      };
      const task = buildPrReviewTask(options);
      const config = readPrReviewConfig(ctx.cwd);
      registerPrReviewProvider(pi, config);
      const result = await runChildPiAgent({
        buildPrompt: (promptTask) => buildPrReviewPrompt(promptTask, options),
        config,
        cwd: params.cwd,
        defaultCwd: ctx.cwd,
        excludeTools: EXCLUDED_CHILD_TOOLS,
        signal,
        task,
        onProgress: (progress) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `prreview running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
              },
            ],
            details: progress,
          });
        },
      });

      const report = formatReport(result, config);
      return {
        content: [{ type: "text", text: report }],
        details: getChildAgentResultDetails(result, config),
      };
    },

    renderCall(rawArgs: unknown, theme) {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const task = typeof args.task === "string" ? args.task : "origin/main...HEAD";
      const preview = previewTask(task || "origin/main...HEAD");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("prreview"))} ${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "prreview" });
    },
  });
}
