import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  type ChildAgentProgress,
  type ChildAgentRunResult,
  type ChildPiAgentConfig,
  isRecord,
} from "./zz-lib/child-pi-agent.ts";
import type {
  BrainstormSolution,
  DesignplannerDecision,
  DesignPlanStep,
} from "./lib/design-loop-types.ts";
import {
  appendRunInfo,
  createStandaloneChildAgent,
  getOptionalString,
  getStringArray,
  parseJsonRecord,
  pushList,
  STANDALONE_AGENT_EXCLUDED_TOOLS,
  truncateReport,
  type StandaloneAgentRunResult,
} from "./lib/standalone-agent-common.ts";

const CONFIG_FILE_PATH = ".pi/extensions/designplanner.config.jsonc";
const DEFAULT_TOOLS = ["readsubagent"] as const;
const EXCLUDED_TOOLS = [
  ...STANDALONE_AGENT_EXCLUDED_TOOLS,
  "bash", "edit", "write",
] as const;

const DEFAULT_CONFIG: ChildPiAgentConfig = {
  contextWindow: 272_000,
  endpoint: "http://127.0.0.1:1234",
  maxOutputTokens: 128_000,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  providerRegistration: "none",
  reportMaxChars: 28_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt: "You are designplanner, a standalone read-only technical design agent. Turn exactly one selected brainstorm solution into a staged, implementation-ready design without writing code or mutating files.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

function buildPrompt(task: string): string {
  return [
    "You are designplanner, a standalone technical design agent.",
    "Consume exactly one explicitly selected brainstorm solution and turn only that solution into a detailed staged technical design.",
    "Use readsubagent for factual repository context. Own the design synthesis yourself.",
    "Ground the architecture, boundaries, sequence, touchpoints, risks, acceptance criteria, and validation in repository evidence and the selected solution.",
    "Do not reconsider or replace the selected solution, compare alternatives, write code, mutate files, produce patches, or provide low-level edit instructions.",
    "Return JSON only, without markdown, using exactly one of these shapes:",
    `{"kind":"design_plan","summary":"short synthesis","selectedSolutionTitle":"exact selected solution title","objective":"what the design accomplishes","architecture":"design-level architecture, boundaries, data flow, and sequencing rationale","steps":[{"title":"Stage title","details":"what this stage establishes, dependencies, and completion state","touchpoints":["path/symbol/context"],"risks":["risk"],"validation":["validation idea"]}],"risks":["cross-cutting risk"],"unknowns":["unknown"],"acceptanceCriteria":["observable criterion"],"validation":["overall validation"],"questions":["optional question to carry forward"],"handoffPrompt":"optional concise implementation-planning handoff"}`,
    `{"kind":"questions","summary":"why design is blocked","questions":["material question"]}`,
    "The selectedSolutionTitle must exactly match the supplied selected solution title. Ask questions instead of inventing facts when missing information would materially change the design.",
    `Delegated selected-solution design request:\n${task}`,
  ].join("\n\n");
}

function normalizeSteps(value: unknown): DesignPlanStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index): DesignPlanStep | undefined => {
      if (!isRecord(item)) return undefined;
      const details = getOptionalString(item, "details") ?? getOptionalString(item, "description");
      if (!details) return undefined;
      return {
        details,
        risks: getStringArray(item.risks),
        title: getOptionalString(item, "title") ?? `Stage ${index + 1}`,
        touchpoints: getStringArray(item.touchpoints ?? item.repoTouchpoints ?? item.files),
        validation: getStringArray(item.validation ?? item.tests),
      };
    })
    .filter((item): item is DesignPlanStep => Boolean(item));
}

export function parseDesignplannerDecision(text: string): DesignplannerDecision | undefined {
  const parsed = parseJsonRecord(text);
  if (!parsed) return undefined;
  const kind = getOptionalString(parsed, "kind")?.toLowerCase();
  const summary = getOptionalString(parsed, "summary");
  if (kind === "questions" || kind === "question") {
    const questions = getStringArray(parsed.questions);
    return questions.length > 0 ? { kind: "questions", questions, ...(summary ? { summary } : {}) } : undefined;
  }
  if (kind && kind !== "design_plan" && kind !== "designplan" && kind !== "design") return undefined;
  const architecture = getOptionalString(parsed, "architecture") ?? getOptionalString(parsed, "approach");
  const selectedSolutionTitle = getOptionalString(parsed, "selectedSolutionTitle") ?? getOptionalString(parsed, "selectedOptionTitle");
  const steps = normalizeSteps(parsed.steps ?? parsed.stages ?? parsed.plan);
  if (!architecture || !selectedSolutionTitle || steps.length === 0) return undefined;
  const questions = getStringArray(parsed.questions);
  const handoffPrompt = getOptionalString(parsed, "handoffPrompt") ?? getOptionalString(parsed, "handoff_prompt");
  return {
    acceptanceCriteria: getStringArray(parsed.acceptanceCriteria ?? parsed.acceptance_criteria),
    architecture,
    ...(handoffPrompt ? { handoffPrompt } : {}),
    kind: "design_plan",
    objective: getOptionalString(parsed, "objective") ?? summary ?? "Technical design",
    ...(questions.length > 0 ? { questions } : {}),
    risks: getStringArray(parsed.risks),
    selectedSolutionTitle,
    steps,
    ...(summary ? { summary } : {}),
    unknowns: getStringArray(parsed.unknowns),
    validation: getStringArray(parsed.validation ?? parsed.tests),
  };
}

function formatReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: DesignplannerDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Standalone design planner", ""];
  const { decision } = options;
  if (decision?.summary) lines.push(decision.summary, "");
  if (decision?.kind === "questions") {
    pushList(lines, "Questions for the user", decision.questions);
  } else if (decision?.kind === "design_plan") {
    lines.push("## Selected solution", "", decision.selectedSolutionTitle, "");
    lines.push("## Objective", "", decision.objective, "");
    lines.push("## Architecture", "", decision.architecture, "");
    lines.push("## Design stages", "");
    decision.steps.forEach((step, index) => {
      lines.push(`### ${index + 1}. ${step.title}`, "", step.details, "");
      pushList(lines, "Touchpoints", step.touchpoints);
      pushList(lines, "Risks", step.risks);
      pushList(lines, "Validation", step.validation);
    });
    pushList(lines, "Acceptance criteria", decision.acceptanceCriteria);
    pushList(lines, "Overall validation", decision.validation);
    pushList(lines, "Cross-cutting risks", decision.risks);
    pushList(lines, "Unknowns", decision.unknowns);
    pushList(lines, "Questions to carry forward", decision.questions);
    if (decision.handoffPrompt) lines.push("## Handoff prompt", "", "```text", decision.handoffPrompt, "```", "");
  } else {
    lines.push("## Raw design-planner output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }
  appendRunInfo(lines, options);
  return truncateReport(lines, options.config);
}

const designplannerAgent = createStandaloneChildAgent<DesignplannerDecision>({
  agentName: "designplanner",
  buildPrompt,
  commandDescription: "Run/configure the standalone selected-solution technical design agent.",
  commandUsage: "/designplanner model [model|default] | config | status | ask <selected-solution design task>",
  configFilePath: CONFIG_FILE_PATH,
  defaultConfig: DEFAULT_CONFIG,
  displayName: "Standalone selected-solution design planner",
  excludeTools: EXCLUDED_TOOLS,
  formatReport,
  messageType: "designplanner-report",
  modelDisplaySuffix: " (designplanner)",
  parseDecision: parseDesignplannerDecision,
  parseErrorMessage: "designplanner did not return a valid selected-solution design decision",
  providerDisplayName: "Design Planner",
  stateEntryType: "designplanner-state",
});

export async function runDesignplannerForSolution(options: {
  readonly constraints?: readonly string[] | undefined;
  readonly context?: string | undefined;
  readonly ctx: ExtensionContext;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly problem: string;
  readonly selectedSolution: BrainstormSolution;
  readonly signal?: AbortSignal | undefined;
}): Promise<StandaloneAgentRunResult<DesignplannerDecision>> {
  const task = [
    `Original problem: ${options.problem}`,
    "Selected solution (exactly one):",
    JSON.stringify(options.selectedSolution, null, 2),
    options.context?.trim() ? `Additional context:\n${options.context.trim()}` : "",
    options.constraints?.length ? `Constraints:\n${options.constraints.map((constraint) => `- ${constraint}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const run = await designplannerAgent.run({ ctx: options.ctx, onProgress: options.onProgress, pi: options.pi, signal: options.signal, task });
  if (run.decision?.kind !== "design_plan" || run.decision.selectedSolutionTitle === options.selectedSolution.title) return run;
  const parseError = `designplanner changed the selected solution title; expected exactly ${JSON.stringify(options.selectedSolution.title)}`;
  return {
    ...run,
    decision: undefined,
    parseError,
    report: formatReport({ config: run.config, parseError, result: run.result }),
  };
}

export function getDesignplannerModelSelector(cwd?: string): string {
  return designplannerAgent.getActiveModelSelector(cwd);
}

export function selectDesignplannerModel(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<void> {
  return designplannerAgent.selectModel(pi, ctx, args);
}

export default function designplannerExtension(pi: ExtensionAPI): void {
  designplannerAgent.register(pi);
}
