export type StandaloneParseErrorMessage = string | ((text: string) => string);

export function resolveStandaloneParseErrorMessage(
  source: StandaloneParseErrorMessage,
  text: string,
  fallback: string,
): string {
  const normalizedFallback = fallback.trim() || "child agent output could not be parsed";
  if (typeof source === "string") return source.trim() || normalizedFallback;
  try {
    return source(text).trim() || normalizedFallback;
  } catch {
    return normalizedFallback;
  }
}
