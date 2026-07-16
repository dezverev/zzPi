import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getBrainstormerModelSelector, runBrainstormerForProblem } from "./brainstormer.ts";
import { getDesignplannerModelSelector, runDesignplannerForSolution } from "./designplanner.ts";
import { createAgentMode } from "./lib/agent-mode.ts";
import { persistDesignArtifact } from "./lib/design-artifacts.ts";
import {
  CHILD_PI_AGENT_ENV,
  getChildAgentResultDetails,
  isRecord,
  renderChildAgentToolCall,
} from "./zz-lib/child-pi-agent.ts";

const PARENT_PROMPT = [
  "<design_loop>",
  "Use the design-loop tools when a task needs explicit solution exploration followed by technical design.",
  "Call brainstormer first to research and present materially distinct solutions and tradeoffs.",
  "Before calling designplanner, the user must select exactly one brainstormed solution. Do not silently treat the brainstormer's recommendation as user selection. If the user already named one solution explicitly, that counts as selection.",
  "Call designplanner with that one complete selectedSolution object. It designs only the selected solution; it does not compare alternatives, implement code, or mutate files.",
  "Keep brainstorming and design separate from implementation. When implementation is requested, continue through normal parent-agent work, use implementationsubagent for parent-decomposed bounded pieces, or use workflowmode for the full staged workflow.",
  "</design_loop>",
].join("\n");

const solutionSchema = Type.Object({
  title: Type.String({ description: "Exact title of the selected brainstormer solution." }),
  approach: Type.String({ description: "Strategy-level solution description returned by brainstormer." }),
  repoTouchpoints: Type.Array(Type.String()),
  pros: Type.Array(Type.String()),
  cons: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
  unknowns: Type.Array(Type.String()),
  nextSteps: Type.Array(Type.String()),
}, { additionalProperties: false });

function progressUpdate(agentName: string, progress: { readonly turns: number; readonly toolCalls: number; readonly latestOutputChars: number }) {
  return {
    content: [{ type: "text" as const, text: `${agentName} running: ${progress.turns} turn(s), ${progress.toolCalls} tool call(s), ${progress.latestOutputChars} output chars` }],
    details: progress,
  };
}

function structuredToolText(run: { readonly decision?: unknown; readonly report: string }): string {
  return run.decision === undefined ? run.report : JSON.stringify(run.decision, null, 2);
}

export default function designLoopExtension(pi: ExtensionAPI): void {
  if (process.env[CHILD_PI_AGENT_ENV] === "1") return;

  const mode = createAgentMode(pi, {
    id: "design-loop",
    label: "design",
    tools: ["brainstormer", "designplanner"],
    enabledByDefault: () => true,
    shortcut: "ctrl+alt+d",
  });

  pi.on("session_start", (_event, ctx) => mode.restore(ctx));
  pi.on("session_tree", (_event, ctx) => mode.restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => mode.clearStatus(ctx));

  pi.on("before_agent_start", (event) => {
    const active = pi.getActiveTools();
    if (!mode.isEnabled() || (!active.includes("brainstormer") && !active.includes("designplanner"))) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${PARENT_PROMPT}` };
  });

  pi.registerTool({
    name: "brainstormer",
    label: "Solution brainstormer",
    description: "Research a problem and return structured solution options, tradeoffs, repository touchpoints, risks, and a recommendation. This is pre-design and read-only.",
    parameters: Type.Object({
      problem: Type.String({ description: "Problem or opportunity whose solution space should be explored." }),
      context: Type.Optional(Type.String({ description: "Relevant product, technical, or prior-discussion context." })),
      relevantPaths: Type.Optional(Type.Array(Type.String(), { description: "Likely relevant repository paths." })),
      constraints: Type.Optional(Type.Array(Type.String(), { description: "Requirements or constraints every solution must respect." })),
    }, { additionalProperties: false }),
    renderCall(rawArgs: unknown, theme, context) {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const problem = typeof args.problem === "string" ? args.problem : "";
      return renderChildAgentToolCall(theme, {
        agentName: "brainstormer",
        model: getBrainstormerModelSelector(context.cwd),
        task: problem || "...",
      });
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const run = await runBrainstormerForProblem({
        constraints: params.constraints,
        context: params.context,
        ctx,
        onProgress: (progress) => onUpdate?.(progressUpdate("brainstormer", progress)),
        pi,
        problem: params.problem,
        relevantPaths: params.relevantPaths,
        signal,
      });
      return {
        content: [{ type: "text", text: structuredToolText(run) }],
        details: getChildAgentResultDetails(run.result, run.config),
      };
    },
  });

  pi.registerTool({
    name: "designplanner",
    label: "Selected-solution design planner",
    description: "Turn exactly one user-selected brainstormer solution into a grounded staged technical design. This is pre-implementation and read-only.",
    parameters: Type.Object({
      problem: Type.String({ description: "Original problem that the selected solution addresses." }),
      selectedSolution: solutionSchema,
      context: Type.Optional(Type.String({ description: "Additional context, including answers to carried-forward questions." })),
      constraints: Type.Optional(Type.Array(Type.String(), { description: "Requirements or constraints the design must respect." })),
    }, { additionalProperties: false }),
    renderCall(rawArgs: unknown, theme, context) {
      const args = isRecord(rawArgs) ? rawArgs : {};
      const problem = typeof args.problem === "string" ? args.problem : "";
      const selectedSolution = isRecord(args.selectedSolution) ? args.selectedSolution : {};
      const title = typeof selectedSolution.title === "string" ? selectedSolution.title : "selected solution";
      return renderChildAgentToolCall(theme, {
        agentName: "designplanner",
        model: getDesignplannerModelSelector(context.cwd),
        scope: title,
        task: problem || "...",
      });
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const run = await runDesignplannerForSolution({
        constraints: params.constraints,
        context: params.context,
        ctx,
        onProgress: (progress) => onUpdate?.(progressUpdate("designplanner", progress)),
        pi,
        problem: params.problem,
        selectedSolution: params.selectedSolution,
        signal,
      });
      const artifact = run.decision?.kind === "design_plan"
        ? await persistDesignArtifact({ workspaceRoot: ctx.cwd, design: run.decision })
        : undefined;
      return {
        content: [{
          type: "text",
          text: artifact
            ? `${artifact.markdown}\nSaved design artifact: ${artifact.artifactPath}`
            : structuredToolText(run),
        }],
        details: {
          ...getChildAgentResultDetails(run.result, run.config),
          ...(artifact ? { artifactPath: artifact.artifactPath } : {}),
        },
      };
    },
  });

  pi.registerCommand("design-loop", {
    description: "Enable, disable, toggle, or inspect design-loop mode.",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (mode.handleAction(action, ctx)) return;
      ctx.ui.notify("Usage: /design-loop on|off|toggle|status", "warning");
    },
  });
}
