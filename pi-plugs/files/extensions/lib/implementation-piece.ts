export type ImplementationPieceStatus = "completed" | "needs-decomposition" | "blocked";

export const IMPLEMENTATION_CONFIDENCE_THRESHOLD = 80;

export interface ParsedImplementationPieceReport {
  readonly clarificationsNeeded?: string | undefined;
  readonly confidence: number;
  readonly lowConfidenceReason?: string | undefined;
  readonly status: ImplementationPieceStatus;
}

export type ImplementationPieceReportParseFailureKind = "format" | "semantic";

export type ImplementationPieceReportParseFailureCode =
  | "empty-report"
  | "status-heading-missing"
  | "status-heading-duplicate"
  | "status-not-first"
  | "status-heading-format"
  | "status-value-invalid"
  | "status-extra-content"
  | "confidence-heading-missing"
  | "confidence-heading-duplicate"
  | "confidence-not-after-status"
  | "confidence-heading-format"
  | "confidence-value-format"
  | "confidence-extra-content"
  | "completed-below-threshold"
  | "completed-has-low-confidence-sections"
  | "low-confidence-reason-missing"
  | "low-confidence-reason-duplicate"
  | "low-confidence-reason-heading-format"
  | "low-confidence-reason-empty"
  | "low-confidence-reason-not-substantive"
  | "clarifications-missing"
  | "clarifications-duplicate"
  | "clarifications-heading-format"
  | "clarifications-empty"
  | "clarifications-not-actionable";

export interface ImplementationPieceReportParseFailure {
  readonly code: ImplementationPieceReportParseFailureCode;
  readonly kind: ImplementationPieceReportParseFailureKind;
  readonly message: string;
  readonly ok: false;
}

export type ImplementationPieceReportParseResult =
  | { readonly ok: true; readonly report: ParsedImplementationPieceReport }
  | ImplementationPieceReportParseFailure;

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

function parseFailure(
  kind: ImplementationPieceReportParseFailureKind,
  code: ImplementationPieceReportParseFailureCode,
  message: string,
): ImplementationPieceReportParseFailure {
  return { code, kind, message, ok: false };
}

function reportLines(markdown: string): string[] {
  return markdown.replaceAll("\r\n", "\n").split("\n");
}

function headingIndices(lines: readonly string[], headingName: string): number[] {
  const indices: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isReservedHeading(lines[index] ?? "", headingName)) indices.push(index);
  }
  return indices;
}

interface ParsedStatusStage {
  readonly lines: readonly string[];
  readonly status: ImplementationPieceStatus;
}

interface ParsedConfidenceStage extends ParsedStatusStage {
  readonly confidence: number;
}

type StageResult<T> = { readonly ok: true; readonly value: T } | ImplementationPieceReportParseFailure;

function parseStatusStage(markdown: string): StageResult<ParsedStatusStage> {
  const lines = reportLines(markdown);
  const indices = headingIndices(lines, "Status");
  if (indices.length === 0) {
    return parseFailure("format", "status-heading-missing", "Report must contain exactly one `## Status` heading.");
  }
  if (indices.length > 1) {
    return parseFailure("format", "status-heading-duplicate", "Report contains more than one Status heading.");
  }
  const statusHeading = indices[0]!;
  if (statusHeading !== 0) {
    return parseFailure("format", "status-not-first", "`## Status` must be the first line of the report.");
  }
  if (lines[statusHeading]?.trim() !== "## Status") {
    return parseFailure("format", "status-heading-format", "Status heading must be exactly `## Status`.");
  }
  const status = lines[statusHeading + 1]?.trim();
  if (status !== "completed" && status !== "needs-decomposition" && status !== "blocked") {
    return parseFailure(
      "format",
      "status-value-invalid",
      "Status must be exactly `completed`, `needs-decomposition`, or `blocked` on the next line.",
    );
  }
  let nextContent = statusHeading + 2;
  while (nextContent < lines.length && !lines[nextContent]?.trim()) nextContent += 1;
  if (nextContent < lines.length && normalizeLevelTwoHeading(lines[nextContent] ?? "") === undefined) {
    return parseFailure("format", "status-extra-content", "Status value must be followed by a level-two section heading.");
  }
  return { ok: true, value: { lines, status } };
}

function parseConfidenceStage(markdown: string): StageResult<ParsedConfidenceStage> {
  const statusResult = parseStatusStage(markdown);
  if (!statusResult.ok) return statusResult;
  const { lines, status } = statusResult.value;
  const indices = headingIndices(lines, "Confidence");
  if (indices.length === 0) {
    return parseFailure("format", "confidence-heading-missing", "Report must contain exactly one `## Confidence` heading.");
  }
  if (indices.length > 1) {
    return parseFailure("format", "confidence-heading-duplicate", "Report contains more than one Confidence heading.");
  }
  let expectedHeading = 2;
  while (expectedHeading < lines.length && !lines[expectedHeading]?.trim()) expectedHeading += 1;
  const confidenceHeading = indices[0]!;
  if (confidenceHeading !== expectedHeading) {
    return parseFailure("format", "confidence-not-after-status", "`## Confidence` must immediately follow the Status block.");
  }
  if (lines[confidenceHeading]?.trim() !== "## Confidence") {
    return parseFailure("format", "confidence-heading-format", "Confidence heading must be exactly `## Confidence`.");
  }
  const match = /^(0|[1-9]\d?|100)%$/.exec(lines[confidenceHeading + 1]?.trim() ?? "");
  if (!match) {
    return parseFailure("format", "confidence-value-format", "Confidence must be one integer percentage from `0%` through `100%`.");
  }
  let nextContent = confidenceHeading + 2;
  while (nextContent < lines.length && !lines[nextContent]?.trim()) nextContent += 1;
  if (nextContent < lines.length && normalizeLevelTwoHeading(lines[nextContent] ?? "") === undefined) {
    return parseFailure("format", "confidence-extra-content", "Confidence value must be followed by a level-two section heading.");
  }
  return { ok: true, value: { confidence: Number(match[1]), lines, status } };
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

function parseRequiredReportSection(options: {
  readonly emptyCode: ImplementationPieceReportParseFailureCode;
  readonly heading: string;
  readonly headingFormatCode: ImplementationPieceReportParseFailureCode;
  readonly lines: readonly string[];
  readonly missingCode: ImplementationPieceReportParseFailureCode;
  readonly duplicateCode: ImplementationPieceReportParseFailureCode;
}): StageResult<string> {
  const headingName = options.heading.replace(/^##[ \t]+/, "");
  const indices = headingIndices(options.lines, headingName);
  if (indices.length === 0) {
    return parseFailure("semantic", options.missingCode, `Low-confidence report must include ${options.heading}.`);
  }
  if (indices.length > 1) {
    return parseFailure("format", options.duplicateCode, `Report contains more than one ${options.heading} heading.`);
  }
  const headingIndex = indices[0]!;
  if (options.lines[headingIndex]?.trim() !== options.heading) {
    return parseFailure("format", options.headingFormatCode, `Heading must be exactly ${options.heading}.`);
  }
  const bodyStart = headingIndex + 1;
  let bodyEnd = bodyStart;
  while (bodyEnd < options.lines.length && normalizeLevelTwoHeading(options.lines[bodyEnd] ?? "") === undefined) bodyEnd += 1;
  const body = options.lines.slice(bodyStart, bodyEnd).join("\n").trim();
  if (!body) {
    return parseFailure("semantic", options.emptyCode, `${options.heading} must contain substantive text.`);
  }
  return { ok: true, value: body };
}

export function parseImplementationPieceStatus(markdown: string): ImplementationPieceStatus | undefined {
  const result = parseStatusStage(markdown);
  return result.ok ? result.value.status : undefined;
}

export function parseImplementationPieceConfidence(markdown: string): number | undefined {
  const result = parseConfidenceStage(markdown);
  return result.ok ? result.value.confidence : undefined;
}

export function diagnoseImplementationPieceReport(markdown: string): ImplementationPieceReportParseResult {
  if (!markdown.trim()) return parseFailure("format", "empty-report", "Implementation report is empty.");
  const confidenceResult = parseConfidenceStage(markdown);
  if (!confidenceResult.ok) return confidenceResult;
  const { confidence, lines, status } = confidenceResult.value;
  if (confidence >= IMPLEMENTATION_CONFIDENCE_THRESHOLD) {
    if (
      status === "completed"
      && lines.some((line) => (
        isReservedHeading(line, "Low-confidence reason")
        || isReservedHeading(line, "Clarifications needed")
      ))
    ) {
      return parseFailure(
        "semantic",
        "completed-has-low-confidence-sections",
        "A completed report at or above the confidence threshold must not include reserved low-confidence sections.",
      );
    }
    return { ok: true, report: { confidence, status } };
  }
  if (status === "completed") {
    return parseFailure(
      "semantic",
      "completed-below-threshold",
      `A completed report must have confidence of at least ${IMPLEMENTATION_CONFIDENCE_THRESHOLD}%.`,
    );
  }

  const reasonResult = parseRequiredReportSection({
    duplicateCode: "low-confidence-reason-duplicate",
    emptyCode: "low-confidence-reason-empty",
    heading: "## Low-confidence reason",
    headingFormatCode: "low-confidence-reason-heading-format",
    lines,
    missingCode: "low-confidence-reason-missing",
  });
  if (!reasonResult.ok) return reasonResult;
  if (!isSubstantiveReportText(reasonResult.value, "reason")) {
    return parseFailure(
      "semantic",
      "low-confidence-reason-not-substantive",
      "Low-confidence reason must contain specific, substantive evidence rather than boilerplate.",
    );
  }

  const clarificationResult = parseRequiredReportSection({
    duplicateCode: "clarifications-duplicate",
    emptyCode: "clarifications-empty",
    heading: "## Clarifications needed",
    headingFormatCode: "clarifications-heading-format",
    lines,
    missingCode: "clarifications-missing",
  });
  if (!clarificationResult.ok) return clarificationResult;
  if (!isSubstantiveReportText(clarificationResult.value, "clarification")) {
    return parseFailure(
      "semantic",
      "clarifications-not-actionable",
      "Clarifications needed must ask a concrete question or request a specific parent decision.",
    );
  }
  return {
    ok: true,
    report: {
      clarificationsNeeded: clarificationResult.value,
      confidence,
      lowConfidenceReason: reasonResult.value,
      status,
    },
  };
}

export function parseImplementationPieceReport(markdown: string): ParsedImplementationPieceReport | undefined {
  const result = diagnoseImplementationPieceReport(markdown);
  return result.ok ? result.report : undefined;
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
