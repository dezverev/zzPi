export const VETTING_LENS_TRUNCATION_MARKER = "\n[… truncated …]\n";

export interface BudgetedReportSection {
  readonly prefix: string;
  readonly body: string;
}

export interface FormatBudgetedReportOptions {
  readonly maxChars: number;
  readonly preamble: string;
  readonly sections: readonly BudgetedReportSection[];
}

export function truncateVettingLensBody(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  if (limit === 0) return "";
  if (limit < VETTING_LENS_TRUNCATION_MARKER.length) return text.slice(0, limit);

  const contentChars = limit - VETTING_LENS_TRUNCATION_MARKER.length;
  const headChars = contentChars < 2
    ? contentChars
    : Math.min(contentChars - 1, Math.ceil(contentChars * 0.65));
  const tailChars = contentChars - headChars;
  return [
    text.slice(0, headChars),
    VETTING_LENS_TRUNCATION_MARKER,
    ...(tailChars > 0 ? [text.slice(-tailChars)] : []),
  ].join("");
}

export function formatBudgetedVettingReport(options: FormatBudgetedReportOptions): string {
  const limit = Math.max(0, Math.floor(options.maxChars));
  if (limit === 0) return "";

  const assemble = (bodies: readonly string[]): string => [
    options.preamble,
    ...options.sections.map((section, index) => `${section.prefix}${bodies[index] ?? ""}`),
  ].join("\n");

  const emptyBodies = options.sections.map(() => "");
  const fixedReport = assemble(emptyBodies);
  if (fixedReport.length > limit) return fixedReport.slice(0, limit);

  const availableBodyChars = limit - fixedReport.length;
  const sectionCount = options.sections.length;
  if (sectionCount === 0) return fixedReport;

  const baseBudget = Math.floor(availableBodyChars / sectionCount);
  const remainder = availableBodyChars % sectionCount;
  const bodies = options.sections.map((section, index) =>
    truncateVettingLensBody(section.body, baseBudget + (index < remainder ? 1 : 0))
  );
  const report = assemble(bodies);

  // Exact accounting should make this branch unreachable unless a future
  // formatting change violates the helper contract. Keep the cap strict.
  return report.length <= limit ? report : report.slice(0, limit);
}
