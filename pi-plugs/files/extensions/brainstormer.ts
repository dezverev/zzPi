import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  type ChildAgentProgress,
  type ChildAgentRunResult,
  type ChildPiAgentConfig,
  isRecord,
} from "./zz-lib/child-pi-agent.ts";
import type { BrainstormerDecision, BrainstormSolution } from "./lib/design-loop-types.ts";
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

const CONFIG_FILE_PATH = ".pi/extensions/brainstormer.config.jsonc";
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
  reportMaxChars: 24_000,
  requestTimeoutMs: 30 * 60 * 1_000,
  systemPrompt: "You are brainstormer, a standalone read-only solution brainstorming agent. Research the problem space and return structured solution options and tradeoffs without designing or implementing them.",
  thinking: "xhigh",
  tools: DEFAULT_TOOLS,
};

function buildPrompt(task: string): string {
  return [
    "You are brainstormer, a standalone solution brainstorming agent.",
    "Research the problem and suggest one to four materially distinct solutions. Prefer two or three when meaningful alternatives exist.",
    "Use readsubagent for factual repository context. Own the solution synthesis yourself.",
    "Stay at the solution/options/tradeoff level. Do not create a detailed design, implementation plan, patch, or file-by-file edit strategy, and never mutate files.",
    "Return JSON only, without markdown, using exactly one of these shapes:",
    `{"kind":"brainstorm","summary":"short synthesis","recommendedSolutionTitle":"optional exact solution title","solutions":[{"title":"Solution title","approach":"strategy-level description","repoTouchpoints":["path/symbol/context"],"pros":["benefit"],"cons":["tradeoff"],"risks":["risk"],"unknowns":["unknown"],"nextSteps":["high-level next step"]}],"questions":["optional question to carry forward"]}`,
    `{"kind":"questions","summary":"why brainstorming is blocked","questions":["material question"]}`,
    "Ask questions only when the answers would materially change the solution space. Make repository touchpoints concrete and keep next steps high-level.",
    `Delegated brainstorming request:\n${task}`,
  ].join("\n\n");
}

function normalizeSolutions(value: unknown): BrainstormSolution[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index): BrainstormSolution | undefined => {
      if (!isRecord(item)) return undefined;
      const approach = getOptionalString(item, "approach") ?? getOptionalString(item, "summary");
      if (!approach) return undefined;
      return {
        approach,
        cons: getStringArray(item.cons ?? item.tradeoffs),
        nextSteps: getStringArray(item.nextSteps ?? item.next_steps),
        pros: getStringArray(item.pros ?? item.benefits),
        repoTouchpoints: getStringArray(item.repoTouchpoints ?? item.repo_touchpoints ?? item.touchpoints),
        risks: getStringArray(item.risks),
        title: getOptionalString(item, "title") ?? `Solution ${index + 1}`,
        unknowns: getStringArray(item.unknowns ?? item.openQuestions),
      };
    })
    .filter((item): item is BrainstormSolution => Boolean(item))
    .slice(0, 4);
}

export function parseBrainstormerDecision(text: string): BrainstormerDecision | undefined {
  const parsed = parseJsonRecord(text);
  if (!parsed) return undefined;
  const kind = getOptionalString(parsed, "kind")?.toLowerCase();
  const summary = getOptionalString(parsed, "summary");
  if (kind === "questions" || kind === "question") {
    const questions = getStringArray(parsed.questions);
    return questions.length > 0 ? { kind: "questions", questions, ...(summary ? { summary } : {}) } : undefined;
  }
  if (kind && kind !== "brainstorm" && kind !== "solutions") return undefined;
  const solutions = normalizeSolutions(parsed.solutions ?? parsed.options ?? parsed.approaches);
  if (solutions.length === 0) return undefined;
  const questions = getStringArray(parsed.questions);
  const recommendation = getOptionalString(parsed, "recommendedSolutionTitle") ?? getOptionalString(parsed, "recommendedOption") ?? getOptionalString(parsed, "recommendation");
  const recommendedSolutionTitle = recommendation && solutions.some((solution) => solution.title === recommendation) ? recommendation : undefined;
  return {
    kind: "brainstorm",
    solutions,
    ...(recommendedSolutionTitle ? { recommendedSolutionTitle } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...(summary ? { summary } : {}),
  };
}

function formatReport(options: {
  readonly config: ChildPiAgentConfig;
  readonly decision?: BrainstormerDecision | undefined;
  readonly parseError?: string | undefined;
  readonly result: ChildAgentRunResult;
}): string {
  const lines = ["# Standalone brainstormer", ""];
  const { decision } = options;
  if (decision?.summary) lines.push(decision.summary, "");
  if (decision?.kind === "questions") {
    pushList(lines, "Questions for the user", decision.questions);
  } else if (decision?.kind === "brainstorm") {
    if (decision.recommendedSolutionTitle) lines.push(`**Recommended solution:** ${decision.recommendedSolutionTitle}`, "");
    decision.solutions.forEach((solution, index) => {
      lines.push(`## ${index + 1}. ${solution.title}`, "", solution.approach, "");
      pushList(lines, "Repository touchpoints", solution.repoTouchpoints);
      pushList(lines, "Pros", solution.pros);
      pushList(lines, "Cons / tradeoffs", solution.cons);
      pushList(lines, "Risks", solution.risks);
      pushList(lines, "Unknowns", solution.unknowns);
      pushList(lines, "High-level next steps", solution.nextSteps);
    });
    pushList(lines, "Questions to carry forward", decision.questions);
  } else {
    lines.push("## Raw brainstormer output", "", options.result.output.trim() || "(no output)", "");
    if (options.parseError) lines.push(`Parse warning: ${options.parseError}`, "");
  }
  appendRunInfo(lines, options);
  return truncateReport(lines, options.config);
}

const brainstormerAgent = createStandaloneChildAgent<BrainstormerDecision>({
  agentName: "brainstormer",
  buildPrompt,
  commandDescription: "Run/configure the standalone solution brainstorming agent.",
  commandUsage: "/brainstormer model [model] | config | status | ask <problem>",
  configFilePath: CONFIG_FILE_PATH,
  defaultConfig: DEFAULT_CONFIG,
  displayName: "Standalone solution brainstormer",
  excludeTools: EXCLUDED_TOOLS,
  formatReport,
  messageType: "brainstormer-report",
  modelDisplaySuffix: " (brainstormer)",
  parseDecision: parseBrainstormerDecision,
  parseErrorMessage: "brainstormer did not return a valid solution decision",
  providerDisplayName: "Solution Brainstormer",
  stateEntryType: "brainstormer-state",
});

export function runBrainstormerForProblem(options: {
  readonly constraints?: readonly string[] | undefined;
  readonly context?: string | undefined;
  readonly ctx: ExtensionContext;
  readonly onProgress?: (progress: ChildAgentProgress) => void;
  readonly pi: ExtensionAPI;
  readonly problem: string;
  readonly relevantPaths?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<StandaloneAgentRunResult<BrainstormerDecision>> {
  const task = [
    `Problem: ${options.problem}`,
    options.context?.trim() ? `Context:\n${options.context.trim()}` : "",
    options.relevantPaths?.length ? `Relevant paths:\n${options.relevantPaths.map((path) => `- ${path}`).join("\n")}` : "",
    options.constraints?.length ? `Constraints:\n${options.constraints.map((constraint) => `- ${constraint}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return brainstormerAgent.run({ ctx: options.ctx, onProgress: options.onProgress, pi: options.pi, signal: options.signal, task });
}

export function getBrainstormerModelSelector(cwd?: string): string {
  return brainstormerAgent.getActiveModelSelector(cwd);
}

export function selectBrainstormerModel(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<void> {
  return brainstormerAgent.selectModel(pi, ctx, args);
}

export default function brainstormerExtension(pi: ExtensionAPI): void {
  brainstormerAgent.register(pi);
}
