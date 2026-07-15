import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { DesignplannerDecision } from "./design-loop-types.ts";
import { resolveArtifactPath } from "./planning-artifact-paths.ts";

type DesignPlan = Extract<DesignplannerDecision, { readonly kind: "design_plan" }>;

export interface DesignArtifactWriteResult {
  readonly artifactPath: string;
  readonly markdown: string;
}

function dateStamp(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 72);
  return slug || "design";
}

function headingText(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim() || "Untitled";
}

function bulletList(items: readonly string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None."];
}

export function formatDesignArtifactMarkdown(design: DesignPlan): string {
  const lines = [
    `# Design: ${headingText(design.selectedSolutionTitle)}`,
    "",
    `> Selected solution: ${design.selectedSolutionTitle}`,
    "",
    "## Summary",
    "",
    design.summary?.trim() || design.objective,
    "",
    "## Objective",
    "",
    design.objective,
    "",
    "## Architecture",
    "",
    design.architecture,
    "",
    "## Implementation stages",
  ];

  for (const [index, step] of design.steps.entries()) {
    lines.push(
      "",
      `### ${index + 1}. ${headingText(step.title)}`,
      "",
      step.details,
      "",
      "**Repository touchpoints**",
      "",
      ...bulletList(step.touchpoints),
      "",
      "**Risks**",
      "",
      ...bulletList(step.risks),
      "",
      "**Validation**",
      "",
      ...bulletList(step.validation),
    );
  }

  lines.push(
    "",
    "## Cross-cutting risks",
    "",
    ...bulletList(design.risks),
    "",
    "## Unknowns",
    "",
    ...bulletList(design.unknowns),
    "",
    "## Acceptance criteria",
    "",
    ...bulletList(design.acceptanceCriteria),
    "",
    "## Overall validation",
    "",
    ...bulletList(design.validation),
  );

  if (design.questions?.length) {
    lines.push("", "## Open questions", "", ...bulletList(design.questions));
  }
  if (design.handoffPrompt?.trim()) {
    lines.push("", "## Implementation handoff", "", design.handoffPrompt.trim());
  }

  return `${lines.join("\n").trim()}\n`;
}

async function exclusiveAtomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function persistDesignArtifact(options: {
  readonly workspaceRoot: string;
  readonly design: DesignPlan;
  readonly artifactRoot?: string | undefined;
  readonly date?: Date | undefined;
}): Promise<DesignArtifactWriteResult> {
  const artifactRoot = options.artifactRoot ?? "docs/artifacts";
  const markdown = formatDesignArtifactMarkdown(options.design);
  const unique = randomUUID().replace(/-/gu, "").slice(0, 12);
  const artifactPath = `${artifactRoot}/designs/${dateStamp(options.date ?? new Date())}_${slugify(options.design.selectedSolutionTitle)}_${unique}.design.md`;
  const absolutePath = await resolveArtifactPath(options.workspaceRoot, artifactRoot, artifactPath);
  await exclusiveAtomicWrite(absolutePath, markdown);
  return { artifactPath, markdown };
}
