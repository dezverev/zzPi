export type ImplementationPieceStatus = "completed" | "needs-decomposition" | "blocked";

export const IMPLEMENTATION_CONFIDENCE_THRESHOLD = 80;

export interface ParsedImplementationPieceReport {
  readonly clarificationsNeeded?: string | undefined;
  readonly confidence: number;
  readonly lowConfidenceReason?: string | undefined;
  readonly status: ImplementationPieceStatus;
}

export interface ImplementationConfidenceCheckpoint {
  readonly phase: string;
  readonly score: number;
}

export interface ImplementationConfidenceEvaluation {
  readonly confidenceCheckpointCount: number;
  readonly confidenceEvidenceValid: boolean;
  readonly confidenceGatePassed: boolean;
  readonly minimumObservedConfidence?: number | undefined;
}

export interface ImplementationHandoffState {
  readonly confidenceEvidenceValid: boolean;
  readonly confidenceGatePassed: boolean;
  readonly documentUnchanged: boolean;
  readonly executionStatus: string;
  readonly ledgerUpdated: boolean;
  readonly pieceStatus?: ImplementationPieceStatus | undefined;
}

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

function normalizeLevelTwoHeading(line: string): string | undefined {
  const trimmed = line.trim();
  if (!/^##[ \t]+/.test(trimmed)) return undefined;
  return trimmed
    .slice(2)
    .trim()
    .replace(/[ \t]+#+$/, "")
    .trim()
    .replace(/[ \t]+/g, " ")
    .toLowerCase();
}

function isReservedHeading(line: string, headingName: string): boolean {
  return normalizeLevelTwoHeading(line) === headingName.toLowerCase();
}

export function parseImplementationPieceStatus(markdown: string): ImplementationPieceStatus | undefined {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  if (lines.filter((line) => isReservedHeading(line, "Status")).length !== 1) return undefined;
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

export function parseImplementationPieceConfidence(markdown: string): number | undefined {
  if (!parseImplementationPieceStatus(markdown)) return undefined;
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  if (lines.filter((line) => isReservedHeading(line, "Confidence")).length !== 1) return undefined;
  let confidenceHeading = 2;
  while (confidenceHeading < lines.length && !lines[confidenceHeading]?.trim()) confidenceHeading += 1;
  if (lines[confidenceHeading]?.trim() !== "## Confidence") return undefined;

  const match = /^(0|[1-9]\d?|100)%$/.exec(lines[confidenceHeading + 1]?.trim() ?? "");
  if (!match) return undefined;
  let nextContent = confidenceHeading + 2;
  while (nextContent < lines.length && !lines[nextContent]?.trim()) nextContent += 1;
  const nextLine = lines[nextContent]?.trim() ?? "";
  if (nextContent < lines.length && !nextLine.startsWith("## ")) return undefined;
  return Number(match[1]);
}

function parseRequiredReportSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const matchingHeadings: number[] = [];
  const headingName = heading.replace(/^##[ \t]+/, "");
  for (let index = 0; index < lines.length; index += 1) {
    if (isReservedHeading(lines[index] ?? "", headingName)) matchingHeadings.push(index);
  }
  if (matchingHeadings.length !== 1) return undefined;
  if (lines[matchingHeadings[0]!]?.trim() !== heading) return undefined;

  const bodyStart = matchingHeadings[0]! + 1;
  let bodyEnd = bodyStart;
  while (bodyEnd < lines.length && !lines[bodyEnd]?.trim().startsWith("## ")) bodyEnd += 1;
  const body = lines.slice(bodyStart, bodyEnd).join("\n").trim();
  return body || undefined;
}

function isSubstantiveReportText(
  value: string | undefined,
  kind: "reason" | "clarification",
): value is string {
  if (!value || value.length < 12) return false;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized.split(/\s+/).filter(Boolean).length < 3) return false;
  if (/^(?:n a|none|not applicable|nothing|placeholder|tbd)(?:\b|$)/.test(normalized)) return false;
  if (kind === "reason") {
    if (/^(?:no reason|reason (?:is )?unknown|unknown reason)(?:\b|$)/.test(normalized)) return false;
    return true;
  }
  if (/^(?:no|none|unknown)(?:\b|$)/.test(normalized)) return false;
  return value.includes("?")
    || /\b(?:choose|clarify|confirm|decide|determine|provide|specify)\b/i.test(value);
}

export function parseImplementationPieceReport(markdown: string): ParsedImplementationPieceReport | undefined {
  const status = parseImplementationPieceStatus(markdown);
  const confidence = parseImplementationPieceConfidence(markdown);
  if (!status || confidence === undefined) return undefined;
  if (confidence >= IMPLEMENTATION_CONFIDENCE_THRESHOLD) {
    const lines = markdown.replaceAll("\r\n", "\n").split("\n");
    if (
      status === "completed"
      && lines.some((line) => (
        isReservedHeading(line, "Low-confidence reason")
        || isReservedHeading(line, "Clarifications needed")
      ))
    ) return undefined;
    return { confidence, status };
  }
  if (status === "completed") return undefined;

  const lowConfidenceReason = parseRequiredReportSection(markdown, "## Low-confidence reason");
  const clarificationsNeeded = parseRequiredReportSection(markdown, "## Clarifications needed");
  if (
    !isSubstantiveReportText(lowConfidenceReason, "reason")
    || !isSubstantiveReportText(clarificationsNeeded, "clarification")
  ) return undefined;
  return { clarificationsNeeded, confidence, lowConfidenceReason, status };
}

function isValidConfidenceCheckpointSequence(
  checkpoints: readonly ImplementationConfidenceCheckpoint[],
): boolean {
  if (checkpoints.length < 2) return false;
  if (checkpoints[0]?.phase !== "initial") return false;
  if (checkpoints[checkpoints.length - 1]?.phase !== "final") return false;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (!checkpoint || !Number.isInteger(checkpoint.score) || checkpoint.score < 0 || checkpoint.score > 100) {
      return false;
    }
    if (index > 0 && index < checkpoints.length - 1 && checkpoint.phase !== `milestone-${index}`) {
      return false;
    }
  }
  const firstLowIndex = checkpoints.findIndex(
    (checkpoint) => checkpoint.score < IMPLEMENTATION_CONFIDENCE_THRESHOLD,
  );
  const finalIndex = checkpoints.length - 1;
  if (firstLowIndex >= 0 && firstLowIndex < finalIndex) {
    if (firstLowIndex !== finalIndex - 1) return false;
    if (checkpoints[finalIndex]!.score > checkpoints[firstLowIndex]!.score) return false;
  }
  return true;
}

export function parseImplementationConfidenceCheckpoints(
  ledger: string,
  runId: string,
): readonly ImplementationConfidenceCheckpoint[] | undefined {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(runId)) return undefined;
  const markerPrefix = `<!-- implementationsubagent-confidence:${runId}:`;
  const markerSuffix = "% -->";
  const markerLines = ledger
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => line.toLowerCase().includes(runId.toLowerCase()));
  if (markerLines.length === 0) return undefined;

  const checkpoints: ImplementationConfidenceCheckpoint[] = [];
  for (const markerLine of markerLines) {
    const marker = markerLine.trim();
    if (!marker.startsWith(markerPrefix) || !marker.endsWith(markerSuffix)) return undefined;
    const rawCheckpoint = marker.slice(markerPrefix.length, -markerSuffix.length);
    const match = /^(initial|final|milestone-[1-9]\d*):(0|[1-9]\d?|100)$/.exec(rawCheckpoint);
    if (!match) return undefined;
    checkpoints.push({ phase: match[1]!, score: Number(match[2]) });
  }
  return isValidConfidenceCheckpointSequence(checkpoints) ? checkpoints : undefined;
}

export function evaluateImplementationConfidence(
  reportConfidence: number | undefined,
  checkpoints: readonly ImplementationConfidenceCheckpoint[] | undefined,
  pieceStatus: ImplementationPieceStatus | undefined,
): ImplementationConfidenceEvaluation {
  const confidenceCheckpointCount = checkpoints?.length ?? 0;
  const checkpointsValid = Boolean(checkpoints && isValidConfidenceCheckpointSequence(checkpoints));
  const minimumObservedConfidence = checkpointsValid
    ? Math.min(...checkpoints!.map((checkpoint) => checkpoint.score))
    : undefined;
  const confidenceEvidenceValid = pieceStatus !== undefined
    && reportConfidence !== undefined
    && minimumObservedConfidence !== undefined
    && reportConfidence === minimumObservedConfidence;
  return {
    confidenceCheckpointCount,
    confidenceEvidenceValid,
    confidenceGatePassed: confidenceEvidenceValid
      && (minimumObservedConfidence ?? -1) >= IMPLEMENTATION_CONFIDENCE_THRESHOLD,
    ...(minimumObservedConfidence === undefined ? {} : { minimumObservedConfidence }),
  };
}

export function isImplementationHandoffAccepted(state: ImplementationHandoffState): boolean {
  return state.executionStatus === "completed"
    && state.pieceStatus === "completed"
    && state.confidenceEvidenceValid
    && state.confidenceGatePassed
    && state.documentUnchanged
    && state.ledgerUpdated;
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
