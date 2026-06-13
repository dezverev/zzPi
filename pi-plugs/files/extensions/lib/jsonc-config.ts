import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ConfigObject = Record<string, unknown>;

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1];

    if (inString) {
      output += char;
      if (escaping) escaping = false;
      else if (char === "\\") escaping = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      if (index < text.length) output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function stripJsonTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inString) {
      output += char;
      if (escaping) escaping = false;
      else if (char === "\\") escaping = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let cursor = index + 1;
      while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
      if (text[cursor] === "}" || text[cursor] === "]") continue;
    }

    output += char;
  }

  return output;
}

export function parseJsonc(text: string, path: string): unknown {
  try {
    return JSON.parse(stripJsonTrailingCommas(stripJsonComments(text))) as unknown;
  } catch (error) {
    throw new Error(`${path} is not valid JSONC: ${getErrorMessage(error)}`);
  }
}

export function isConfigObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveConfigPath(cwd: string, relativePath: string): string {
  let currentDir = resolve(cwd);

  while (true) {
    const candidate = resolve(currentDir, relativePath);
    if (existsSync(candidate)) return candidate;

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return resolve(cwd, relativePath);
    currentDir = parentDir;
  }
}

export function readJsoncConfig(relativePath: string, cwd: string): ConfigObject | undefined {
  const configPath = resolveConfigPath(cwd, relativePath);
  if (!existsSync(configPath)) return undefined;

  const parsed = parseJsonc(readFileSync(configPath, "utf8"), relativePath);
  if (!isConfigObject(parsed)) {
    throw new Error(`${relativePath} must contain a JSON object.`);
  }

  return parsed;
}

export function getStringField(record: ConfigObject, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

export function getNumberField(record: ConfigObject, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getBooleanField(record: ConfigObject, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === "boolean" ? value : undefined;
}

export function getStringArrayField(record: ConfigObject, field: string): string[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) return undefined;

  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

export function getObjectArrayField(
  record: ConfigObject,
  field: string,
): ConfigObject[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) return undefined;

  const objects = value.filter(isConfigObject);
  return objects.length === value.length ? objects : undefined;
}

export function getPositiveIntegerField(record: ConfigObject, field: string): number | undefined {
  const value = getNumberField(record, field);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }

  return value;
}

export function getNonNegativeIntegerField(
  record: ConfigObject,
  field: string,
): number | undefined {
  const value = getNumberField(record, field);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }

  return value;
}

export function getPercentField(record: ConfigObject, field: string): number | undefined {
  const value = getNumberField(record, field);
  if (value === undefined) return undefined;
  if (value < 1 || value > 100) {
    throw new Error(`${field} must be between 1 and 100.`);
  }

  return value;
}
