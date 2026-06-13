import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  buildDefaultChildPrompt,
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

const CONFIG_FILE_PATH = ".pi/extensions/localagent.config.jsonc";
const LOCALAGENT_MESSAGE_TYPE = "localagent-report";
const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
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

const MAIN_LOCALAGENT_PROMPT = [
  "<localagent_delegation>",
  "Use localagent only when the user explicitly asks for local LM Studio delegation or when a self-contained isolated local-model pass would materially reduce main-context/tool-call work.",
  "Give localagent complete instructions: repo-relative paths, constraints, acceptance criteria, safety limits, and the exact report format expected back.",
  "Prefer normal parent tools for quick reads/searches/edits. Prefer readsubagent for targeted read-only file questions, explorationsubagent for broad discovery, reviewsubagent for code-review judgment, prreview for PR-readiness summaries, and gitopsagent for git/PR mutations.",
  "Do not use localagent as a vague catch-all; delegate only scoped tasks that can run to completion independently.",
  "</localagent_delegation>",
].join("\n");

const DEFAULT_LOCALAGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 262_144,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "qwen3.6-35b-a3b-mlx",
  provider: "local-lmstudio",
  reportMaxChars: 60_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are a local LM Studio subagent spawned by Pi. Work autonomously on the delegated task, using tools as needed. Follow all repo PI.md/AGENTS.md instructions. Keep the final answer concise and structured with: Completed, Files Changed, Notes, and Follow-up.",
  thinking: "off",
  tools: DEFAULT_TOOLS,
};

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_LOCALAGENT_CONFIG };
let lastConfigError: string | undefined;

function readLocalAgentConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "localagent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_LOCALAGENT_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function registerLocalAgentProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (LM Studio)",
    providerDisplayName: "Local LM Studio",
  });
}

function buildLocalAgentPrompt(task: string): string {
  return buildDefaultChildPrompt(task, "localagent");
}

function formatReport(result: ChildAgentRunResult, config: ChildPiAgentConfig): string {
  return formatChildAgentReport(result, config, { title: "Local agent answer" });
}

function isChildPiAgentProcess(): boolean {
  return (
    process.env[CHILD_PI_AGENT_ENV] === "1" || process.env[LEGACY_LOCALAGENT_CHILD_ENV] === "1"
  );
}

export default function localAgentExtension(pi: ExtensionAPI) {
  currentConfig = readLocalAgentConfig(process.cwd());
  registerLocalAgentProvider(pi, currentConfig);

  pi.on("session_start", (_event, ctx) => {
    currentConfig = readLocalAgentConfig(ctx.cwd);
    registerLocalAgentProvider(pi, currentConfig);

    if (lastConfigError) {
      ctx.ui.notify(`localagent config ignored: ${lastConfigError}`, "warning");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("localagent", undefined);
  });

  pi.registerMessageRenderer(LOCALAGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "localagent" }),
  );

  pi.on("before_agent_start", (event) => {
    if (isChildPiAgentProcess()) return undefined;
    if (!pi.getActiveTools().includes("localagent")) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${MAIN_LOCALAGENT_PROMPT}`,
    };
  });

  pi.registerCommand("localagent-config", {
    description: "Show /localagent config",
    handler: (_args, ctx) => {
      currentConfig = readLocalAgentConfig(ctx.cwd);
      registerLocalAgentProvider(pi, currentConfig);
      ctx.ui.notify(
        `localagent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}`,
        "info",
      );
      if (lastConfigError) {
        ctx.ui.notify(`localagent config ignored: ${lastConfigError}`, "warning");
      }
      return Promise.resolve();
    },
  });

  pi.registerCommand("localagent", {
    description: "Run a delegated task in a child Pi process using the local LM Studio model",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /localagent <prompt>", "warning");
        return;
      }

      const config = readLocalAgentConfig(ctx.cwd);
      registerLocalAgentProvider(pi, config);
      const model = getModelSelector(config);
      ctx.ui.setStatus("localagent", `running ${model}: ${previewTask(task)}`);

      try {
        const result = await runChildPiAgent({
          buildPrompt: buildLocalAgentPrompt,
          config,
          defaultCwd: ctx.cwd,
          excludeTools: EXCLUDED_CHILD_TOOLS,
          task,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              "localagent",
              `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        const report = formatReport(result, config);
        sendChildAgentReportMessage({
          config,
          ctx,
          messageType: LOCALAGENT_MESSAGE_TYPE,
          pi,
          report,
          result,
        });

        const level = result.status === "completed" ? "info" : "warning";
        ctx.ui.notify(`localagent ${result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`localagent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus("localagent", undefined);
      }
    },
  });

  pi.registerTool({
    name: "localagent",
    label: "Local Agent",
    description:
      "Delegate a self-contained coding task to a separate Pi child process using the configured local LM Studio model. The child runs to completion with isolated context and returns a report.",
    promptSnippet:
      "Delegate a self-contained task to a child Pi process backed by the local LM Studio model",
    promptGuidelines: [
      "Use localagent only when the user explicitly asks for local LM Studio delegation or when an isolated local-model pass would reduce main-context/tool-call work.",
      "Give localagent a self-contained task with repo-relative paths, constraints, and the expected report format.",
      "Prefer normal tools for quick reads/searches/edits; use localagent when a separate local-model pass is valuable.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description:
          "Self-contained task for the local child Pi process. Include enough context, exact paths, and desired output.",
      }),
      cwd: Type.Optional(
        Type.String({ description: "Optional working directory for the child process" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = readLocalAgentConfig(ctx.cwd);
      registerLocalAgentProvider(pi, config);
      const result = await runChildPiAgent({
        buildPrompt: buildLocalAgentPrompt,
        config,
        cwd: params.cwd,
        defaultCwd: ctx.cwd,
        excludeTools: EXCLUDED_CHILD_TOOLS,
        signal,
        task: params.task,
        onProgress: (progress) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `localagent running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
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
      const task = typeof args.task === "string" ? args.task : "";
      const preview = previewTask(task || "...");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("localagent"))} ${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "localagent" });
    },
  });
}
