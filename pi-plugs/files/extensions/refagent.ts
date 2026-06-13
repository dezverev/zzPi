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

const CONFIG_FILE_PATH = ".pi/extensions/refagent.config.jsonc";
const IMPORT_DOCS_SCOPE_ENTRY_TYPE = "import-docs-scope";
const IMPORT_DOCS_SCOPE_ENV = "PI_IMPORT_DOCS_ENABLED_REFERENCES";
const REFAGENT_MESSAGE_TYPE = "refagent-report";
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

const MAIN_REFERENCE_DELEGATION_PROMPT = [
  "<refagent_reference_delegation>",
  "Use refagent for targeted questions about enabled imported references under repo-relative reference/ instead of reading/searching those docs in the main context.",
  "When delegating, include the enabled reference name/path, exact question, targeted search terms or files, and requested citation format.",
  "Do not use refagent for disabled references; ask the user to /import-docs enable the needed reference first.",
  "Good refagent task shape: In enabled reference <name> at <path>, answer <specific question>. Search only targeted docs/source, cite repo-relative file paths/headings, and return a concise answer plus short relevant snippets only when useful.",
  "</refagent_reference_delegation>",
].join("\n");

const DEFAULT_REFAGENT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 262_144,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 32_768,
  model: "qwen3.6-35b-a3b-mlx",
  provider: "local-refagent",
  reportMaxChars: 60_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt:
    "You are a reference-doc/source lookup subagent spawned by Pi. Answer targeted questions about enabled imported references under repo-relative reference/. Respect the import-docs scope exactly: never read, search, list, summarize, or cite disabled references. Work read-only: do not edit files. Prefer targeted searches and short reads. Return a concise answer first, then repo-relative citations and short relevant snippets only when useful.",
  thinking: "off",
  tools: DEFAULT_TOOLS,
};

let currentConfig: ChildPiAgentConfig = { ...DEFAULT_REFAGENT_CONFIG };
let lastConfigError: string | undefined;

function readRefAgentConfig(cwd: string): ChildPiAgentConfig {
  const result = readChildPiAgentConfig({
    agentName: "refagent",
    configFilePath: CONFIG_FILE_PATH,
    cwd,
    defaults: DEFAULT_REFAGENT_CONFIG,
  });
  lastConfigError = result.error;
  return result.config;
}

function registerRefAgentProvider(pi: ExtensionAPI, config: ChildPiAgentConfig): void {
  registerChildAgentProvider(pi, config, {
    modelDisplaySuffix: " (refagent LM Studio)",
    providerDisplayName: "Local Ref Agent",
  });
}

function getEnabledReferenceNamesFromSession(ctx: ExtensionContext): readonly string[] {
  let saved: readonly string[] | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== IMPORT_DOCS_SCOPE_ENTRY_TYPE) continue;
    if (!isRecord(entry.data) || !Array.isArray(entry.data.enabled)) continue;

    saved = entry.data.enabled.filter((value): value is string => typeof value === "string");
  }

  return Array.from(new Set(saved ?? [])).sort();
}

function buildRefAgentPrompt(task: string, enabledReferenceNames: readonly string[]): string {
  const enabled = enabledReferenceNames.length > 0 ? enabledReferenceNames.join(", ") : "none";

  return [
    "You are running as the child process for the parent Pi /refagent command.",
    "Answer the delegated reference-doc/source lookup question using only enabled import-docs reference scope.",
    `Enabled reference names inherited from the parent session: ${enabled}.`,
    "Do not read, search, list, summarize, or cite disabled reference projects. If the needed reference is not enabled, say so instead of trying to inspect it.",
    "Use targeted searches/reads under the enabled reference path, avoid broad reference/ sweeps, cite repo-relative file paths/headings, and keep snippets short.",
    `Delegated reference question:\n${task}`,
  ].join("\n\n");
}

function getReferenceChildEnv(
  enabledReferenceNames: readonly string[],
): Readonly<Record<string, string | undefined>> {
  return {
    [IMPORT_DOCS_SCOPE_ENV]:
      enabledReferenceNames.length > 0 ? enabledReferenceNames.join(",") : undefined,
  };
}

function formatReport(result: ChildAgentRunResult, config: ChildPiAgentConfig): string {
  return formatChildAgentReport(result, config, { title: "Refagent answer" });
}

function isChildPiAgentProcess(): boolean {
  return (
    process.env[CHILD_PI_AGENT_ENV] === "1" || process.env[LEGACY_LOCALAGENT_CHILD_ENV] === "1"
  );
}

export default function refAgentExtension(pi: ExtensionAPI) {
  currentConfig = readRefAgentConfig(process.cwd());
  registerRefAgentProvider(pi, currentConfig);

  pi.on("session_start", (_event, ctx) => {
    currentConfig = readRefAgentConfig(ctx.cwd);
    registerRefAgentProvider(pi, currentConfig);

    if (lastConfigError) {
      ctx.ui.notify(`refagent config ignored: ${lastConfigError}`, "warning");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("refagent", undefined);
  });

  pi.registerMessageRenderer(REFAGENT_MESSAGE_TYPE, (message, options, theme) =>
    renderChildAgentMessage(message, options.expanded, theme, { agentName: "refagent" }),
  );

  pi.on("before_agent_start", (event) => {
    if (isChildPiAgentProcess()) return undefined;
    if (!pi.getActiveTools().includes("refagent")) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${MAIN_REFERENCE_DELEGATION_PROMPT}`,
    };
  });

  pi.registerCommand("refagent-config", {
    description: "Show /refagent config",
    handler: (_args, ctx) => {
      currentConfig = readRefAgentConfig(ctx.cwd);
      registerRefAgentProvider(pi, currentConfig);
      ctx.ui.notify(
        `refagent config:\n${formatChildAgentConfig(currentConfig, CONFIG_FILE_PATH)}`,
        "info",
      );
      if (lastConfigError) {
        ctx.ui.notify(`refagent config ignored: ${lastConfigError}`, "warning");
      }
      return Promise.resolve();
    },
  });

  pi.registerCommand("refagent", {
    description: "Ask a child Pi process a targeted question about enabled imported references",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /refagent <prompt>", "warning");
        return;
      }

      const config = readRefAgentConfig(ctx.cwd);
      registerRefAgentProvider(pi, config);
      const enabledReferenceNames = getEnabledReferenceNamesFromSession(ctx);
      const model = getModelSelector(config);
      ctx.ui.setStatus("refagent", `running ${model}: ${previewTask(task)}`);

      try {
        const result = await runChildPiAgent({
          buildPrompt: (promptTask) => buildRefAgentPrompt(promptTask, enabledReferenceNames),
          childEnv: getReferenceChildEnv(enabledReferenceNames),
          config,
          defaultCwd: ctx.cwd,
          excludeTools: EXCLUDED_CHILD_TOOLS,
          task,
          onProgress: (progress) => {
            const toolText = progress.toolCalls > 0 ? `, ${progress.toolCalls} tool` : "";
            ctx.ui.setStatus(
              "refagent",
              `running ${model}: ${progress.turns} turn${progress.turns === 1 ? "" : "s"}${toolText}`,
            );
          },
        });
        const report = formatReport(result, config);
        sendChildAgentReportMessage({
          config,
          ctx,
          messageType: REFAGENT_MESSAGE_TYPE,
          pi,
          report,
          result,
        });

        const level = result.status === "completed" ? "info" : "warning";
        ctx.ui.notify(`refagent ${result.status}; report added to main context`, level);
      } catch (error) {
        ctx.ui.notify(`refagent failed: ${getErrorMessage(error)}`, "error");
      } finally {
        ctx.ui.setStatus("refagent", undefined);
      }
    },
  });

  pi.registerTool({
    name: "refagent",
    label: "Reference Agent",
    description:
      "Delegate a targeted lookup question about enabled imported references under reference/ to a separate Pi child process. The child inherits the parent import-docs scope and returns a concise cited report.",
    promptSnippet: "Ask a child Pi process about enabled imported references under reference/",
    promptGuidelines: [
      "Use refagent for targeted questions about enabled imported references under reference/ instead of reading/searching those docs in the main context.",
      "When delegating, include the enabled reference name/path, exact question, targeted search terms/files, and requested citation format.",
      "Do not use refagent for disabled references; ask the user to /import-docs enable the needed reference first.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description:
          "Targeted reference lookup task. Include enabled reference name/path, exact question, search terms/files, and desired citation format.",
      }),
      cwd: Type.Optional(
        Type.String({ description: "Optional working directory for the child process" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = readRefAgentConfig(ctx.cwd);
      registerRefAgentProvider(pi, config);
      const enabledReferenceNames = getEnabledReferenceNamesFromSession(ctx);
      const result = await runChildPiAgent({
        buildPrompt: (task) => buildRefAgentPrompt(task, enabledReferenceNames),
        childEnv: getReferenceChildEnv(enabledReferenceNames),
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
                text: `refagent running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`,
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
        `${theme.fg("toolTitle", theme.bold("refagent"))} ${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },

    renderResult(result, state, theme) {
      return renderChildAgentToolResult(result, state, theme, { agentName: "refagent" });
    },
  });
}
