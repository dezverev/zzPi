import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type ChildAgentProgress,
  type ChildAgentRunResult,
  type ChildPiAgentConfig,
  type RunChildPiAgentOptions,
  formatChildAgentReport,
  getChildAgentResultDetails,
  registerChildAgentProvider,
  runChildPiAgent,
} from "../zz-lib/child-pi-agent.ts";
import type { CollectedCustomPlugV1 } from "./custom-plug-loader.ts";
import type { CustomPlugChildAgentDefinitionV1 } from "./custom-plug-types.ts";

interface CustomPlugChildRuntime {
  readonly registerProvider: (pi: ExtensionAPI, config: ChildPiAgentConfig) => void;
  readonly run: (options: RunChildPiAgentOptions) => Promise<ChildAgentRunResult>;
}

export interface CustomPlugBindingDiagnostic {
  readonly pluginId: string;
  readonly manifestPath: string;
  readonly message: string;
}

const NON_ABORTING_SIGNAL = new AbortController().signal;

function sourceLabel(plugin: CollectedCustomPlugV1): string {
  return `custom plug "${plugin.manifest.id}" (${plugin.manifestPath})`;
}

function progressText(agentId: string, progress: ChildAgentProgress): string {
  return `${agentId} running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars`;
}

function preflight(plugins: readonly CollectedCustomPlugV1[]): void {
  const tools = new Map<string, CollectedCustomPlugV1>();
  const commands = new Map<string, CollectedCustomPlugV1>();

  const claim = (
    namespace: "tool" | "command",
    name: string,
    plugin: CollectedCustomPlugV1,
    claimed: Map<string, CollectedCustomPlugV1>,
  ): void => {
    const previous = claimed.get(name);
    if (previous) {
      throw new Error(
        `${sourceLabel(plugin)} cannot bind ${namespace} "${name}": it collides with ${sourceLabel(previous)}.`,
      );
    }
    claimed.set(name, plugin);
  };

  for (const plugin of plugins) {
    for (const child of plugin.definitions.childAgents) {
      claim("tool", child.id, plugin, tools);
      if (child.command) claim("command", child.command.name, plugin, commands);
    }
    for (const command of plugin.definitions.commands) {
      claim("command", command.name, plugin, commands);
    }
  }
}

function commandStatusKey(plugin: CollectedCustomPlugV1, agentId: string): string {
  return `custom-plug:${plugin.manifest.id}:${agentId}`;
}

async function runDefinition(
  pi: ExtensionAPI,
  runtime: CustomPlugChildRuntime,
  definition: CustomPlugChildAgentDefinitionV1,
  defaultCwd: string,
  cwd: string,
  task: string,
  signal: AbortSignal,
  onProgress: (progress: ChildAgentProgress) => void,
): Promise<ChildAgentRunResult> {
  const prompt = definition.buildPrompt
    ? await definition.buildPrompt({ cwd, task })
    : undefined;
  runtime.registerProvider(pi, definition.config);
  return runtime.run({
    ...(prompt === undefined ? {} : { buildPrompt: () => prompt }),
    config: definition.config,
    cwd,
    defaultCwd,
    excludeTools: definition.excludeTools,
    onProgress,
    signal,
    task,
  });
}

function reportFor(
  plugin: CollectedCustomPlugV1,
  definition: CustomPlugChildAgentDefinitionV1,
  result: ChildAgentRunResult,
): string {
  return formatChildAgentReport(result, definition.config, {
    title: `${plugin.manifest.id}/${definition.id}`,
  });
}

function childSucceeded(result: ChildAgentRunResult): boolean {
  return result.status === "completed" && !result.toolCalls.some((call) => call.isError === true);
}

function notifyReport(ctx: ExtensionContext, report: string, result: ChildAgentRunResult): void {
  ctx.ui.notify(report, childSucceeded(result) ? "info" : "error");
}

function childFailure(
  plugin: CollectedCustomPlugV1,
  definition: CustomPlugChildAgentDefinitionV1,
  result: ChildAgentRunResult,
  report = reportFor(plugin, definition, result),
): Error {
  const failedToolCalls = result.toolCalls.filter((call) => call.isError === true);
  const outcome = failedToolCalls.length > 0
    ? `${result.status} with ${failedToolCalls.length} failed tool call(s)`
    : result.status;
  return new Error(
    `${plugin.manifest.id}/${definition.id} child run ${outcome}.\n\n${report}`,
  );
}

/** Commit already-collected v1 definitions using the production child runtime. */
export function commitCustomPlugsToPi(
  pi: ExtensionAPI,
  plugins: readonly CollectedCustomPlugV1[],
  defaultCwd: string,
): readonly CustomPlugBindingDiagnostic[] {
  return commitCustomPlugsToPiWithRuntime(pi, plugins, defaultCwd, {
    registerProvider: registerChildAgentProvider,
    run: runChildPiAgent,
  });
}

/** @internal Test-only seam. Production callers must use commitCustomPlugsToPi. */
export function __commitCustomPlugsToPiForTests(
  pi: ExtensionAPI,
  plugins: readonly CollectedCustomPlugV1[],
  defaultCwd: string,
  runtime: CustomPlugChildRuntime,
): readonly CustomPlugBindingDiagnostic[] {
  return commitCustomPlugsToPiWithRuntime(pi, plugins, defaultCwd, runtime);
}

function commitCustomPlugsToPiWithRuntime(
  pi: ExtensionAPI,
  plugins: readonly CollectedCustomPlugV1[],
  defaultCwd: string,
  runtime: CustomPlugChildRuntime,
): readonly CustomPlugBindingDiagnostic[] {
  preflight(plugins);
  const agents = new Map<string, {
    readonly definition: CustomPlugChildAgentDefinitionV1;
    readonly plugin: CollectedCustomPlugV1;
  }>();
  for (const plugin of plugins) {
    for (const definition of plugin.definitions.childAgents) {
      agents.set(definition.id, { definition, plugin });
    }
  }

  const bind = (plugin: CollectedCustomPlugV1, kind: "tool" | "command", name: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${sourceLabel(plugin)} failed to bind ${kind} "${name}": ${message}`, { cause: error });
    }
  };

  const bindPlugin = (plugin: CollectedCustomPlugV1): void => {
    for (const definition of plugin.definitions.childAgents) {
      bind(plugin, "tool", definition.id, () => {
        pi.registerTool({
          name: definition.id,
          label: definition.id,
          description: definition.description,
          parameters: Type.Object({
            task: Type.String({ minLength: 1, description: "Task to delegate to the child agent" }),
          }),
          async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const result = await runDefinition(
              pi,
              runtime,
              definition,
              defaultCwd,
              ctx.cwd,
              params.task,
              signal ?? NON_ABORTING_SIGNAL,
              (progress) => onUpdate?.({
                content: [{ type: "text", text: progressText(definition.id, progress) }],
                details: progress,
              }),
            );
            const report = reportFor(plugin, definition, result);
            if (!childSucceeded(result)) {
              throw childFailure(plugin, definition, result, report);
            }
            return {
              content: [{ type: "text", text: report }],
              details: getChildAgentResultDetails(result, definition.config),
            };
          },
        });
      });

      if (definition.command) {
        const command = definition.command;
        bind(plugin, "command", command.name, () => {
          pi.registerCommand(command.name, {
            description: command.description ?? definition.description,
            handler: async (args, ctx) => {
              const statusKey = commandStatusKey(plugin, definition.id);
              const signal = ctx.signal ?? NON_ABORTING_SIGNAL;
              try {
                const result = await runDefinition(
                  pi,
                  runtime,
                  definition,
                  defaultCwd,
                  ctx.cwd,
                  args,
                  signal,
                  (progress) => ctx.ui.setStatus(statusKey, progressText(definition.id, progress)),
                );
                const report = reportFor(plugin, definition, result);
                notifyReport(ctx, report, result);
                if (!childSucceeded(result)) {
                  throw childFailure(plugin, definition, result, report);
                }
              } finally {
                ctx.ui.setStatus(statusKey, undefined);
              }
            },
          });
        });
      }
    }

    for (const command of plugin.definitions.commands) {
      bind(plugin, "command", command.name, () => {
        pi.registerCommand(command.name, {
          description: command.description,
          handler: async (args, ctx) => {
            const statusKey = commandStatusKey(plugin, command.name);
            const signal = ctx.signal ?? NON_ABORTING_SIGNAL;
            const failures: Array<{
              readonly error: Error;
              readonly report: string;
            }> = [];
            try {
              let handlerError: unknown;
              try {
                await command.handler(args, {
                  cwd: ctx.cwd,
                  signal,
                  report: (text) => ctx.ui.notify(text, "info"),
                  progress: (text) => ctx.ui.setStatus(statusKey, text),
                  runChildAgent: async (agentId, task) => {
                    const agent = agents.get(agentId);
                    if (!agent) {
                      throw new Error(`${sourceLabel(plugin)} has no registered child agent "${agentId}".`);
                    }
                    const result = await runDefinition(
                      pi,
                      runtime,
                      agent.definition,
                      defaultCwd,
                      ctx.cwd,
                      task,
                      signal,
                      (progress) => ctx.ui.setStatus(statusKey, progressText(agentId, progress)),
                    );
                    if (!childSucceeded(result)) {
                      const report = reportFor(agent.plugin, agent.definition, result);
                      const error = childFailure(agent.plugin, agent.definition, result, report);
                      failures.push({ error, report });
                      throw error;
                    }
                    return result.output;
                  },
                });
              } catch (error) {
                handlerError = error;
              }

              if (failures.length > 0) {
                for (const failure of failures) ctx.ui.notify(failure.report, "error");
                throw new Error(
                  failures.map(({ error }) => error.message).join("\n\n"),
                  handlerError === undefined ? undefined : { cause: handlerError },
                );
              }
              if (handlerError !== undefined) throw handlerError;
            } finally {
              ctx.ui.setStatus(statusKey, undefined);
            }
          },
        });
      });
    }
  };

  const diagnostics: CustomPlugBindingDiagnostic[] = [];
  for (const plugin of plugins) {
    try {
      bindPlugin(plugin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        pluginId: plugin.manifest.id,
        manifestPath: plugin.manifestPath,
        message: `${message} Remaining definitions from this plugin were skipped. Pi has no unregister API, so this plugin may be partially bound.`,
      });
    }
  }
  return diagnostics;
}
