export type ImplementationPieceStatus = "completed" | "needs-decomposition" | "blocked";

export interface NormalizedImplementationPiece {
  readonly acceptanceCriteria: readonly string[];
  readonly focusedValidation: readonly string[];
  readonly task: string;
}

function normalizeRequiredList(
  value: unknown,
  label: string,
  minimumItemLength: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`implementation piece must include at least one ${label}`);
  }
  const normalized = value.map((item) => typeof item === "string" ? item.trim() : "");
  if (normalized.some((item) => item.length < minimumItemLength)) {
    throw new Error(
      `implementation piece ${label} must each contain at least ${minimumItemLength} non-whitespace characters`,
    );
  }
  return normalized;
}

export function parseImplementationPieceStatus(markdown: string): ImplementationPieceStatus | undefined {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "## Status") return undefined;
  const status = lines[1]?.trim();
  if (status !== "completed" && status !== "needs-decomposition" && status !== "blocked") {
    return undefined;
  }
  let nextContent = 2;
  while (nextContent < lines.length && !lines[nextContent]?.trim()) nextContent += 1;
  const nextLine = lines[nextContent]?.trim() ?? "";
  if (nextContent < lines.length && !nextLine.startsWith("## ")) return undefined;
  return status;
}

export function normalizeImplementationPiece(
  task: unknown,
  acceptanceCriteria: unknown,
  focusedValidation: unknown,
): NormalizedImplementationPiece {
  const normalizedTask = typeof task === "string" ? task.trim() : "";
  if (normalizedTask.length < 12) {
    throw new Error("implementation task must contain at least 12 non-whitespace characters");
  }
  return {
    task: normalizedTask,
    acceptanceCriteria: normalizeRequiredList(acceptanceCriteria, "acceptance criterion", 12),
    focusedValidation: normalizeRequiredList(focusedValidation, "focused validation step", 8),
  };
}
