import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const PREFERENCE_VERSION = 1;
const PREFERENCE_DIRECTORY = "subagent-model-overrides";

export const CONFIG_DEFAULT_MODEL_CHOICE = "Config default (clear persistent override)";

export interface SubagentModelPreference {
  readonly error?: string | undefined;
  readonly exists: boolean;
  readonly path: string;
  readonly selectedModelId?: string | undefined;
}

export interface SubagentModelPreferenceParams {
  readonly agentName: string;
  readonly configFilePath: string;
  readonly cwd: string;
}

export interface SubagentModelPreferenceResolution {
  readonly migrateSessionSelection: boolean;
  readonly selectedModelId?: string | undefined;
  readonly warning?: string | undefined;
}

interface StoredSubagentModelPreference {
  readonly selectedModelId: string | null;
  readonly version: typeof PREFERENCE_VERSION;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeAgentName(agentName: string): string {
  const normalized = agentName.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/u.test(normalized)) {
    throw new Error(`invalid subagent name "${agentName}"`);
  }
  return normalized;
}

function resolveConfigPath(cwd: string, relativePath: string): string {
  let currentDir = resolve(cwd);
  let gitRoot: string | undefined;
  let piRoot: string | undefined;

  while (true) {
    const candidate = resolve(currentDir, relativePath);
    if (existsSync(candidate)) return candidate;
    if (!piRoot && existsSync(resolve(currentDir, ".pi"))) piRoot = currentDir;
    if (!gitRoot && existsSync(resolve(currentDir, ".git"))) gitRoot = currentDir;

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return resolve(piRoot ?? gitRoot ?? cwd, relativePath);
    }
    currentDir = parentDir;
  }
}

function findPiDirectory(configPath: string): string {
  let currentDir = dirname(configPath);
  while (true) {
    if (basename(currentDir) === ".pi") return currentDir;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`subagent config path is not under a .pi directory: ${configPath}`);
    }
    currentDir = parentDir;
  }
}

export function resolveSubagentModelPreferencePath(
  params: SubagentModelPreferenceParams,
): string {
  const configPath = resolveConfigPath(params.cwd, params.configFilePath);
  const piDirectory = findPiDirectory(configPath);
  return resolve(
    piDirectory,
    PREFERENCE_DIRECTORY,
    `${normalizeAgentName(params.agentName)}.json`,
  );
}

export function readSubagentModelPreference(
  params: SubagentModelPreferenceParams,
): SubagentModelPreference {
  const path = resolveSubagentModelPreferencePath(params);
  if (!existsSync(path)) return { exists: false, path };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("preference must contain a JSON object");
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== PREFERENCE_VERSION) {
      throw new Error(`unsupported preference version ${String(record.version)}`);
    }
    const selectedModelId = record.selectedModelId;
    if (selectedModelId !== null && (typeof selectedModelId !== "string" || !selectedModelId.trim())) {
      throw new Error("selectedModelId must be a non-empty string or null");
    }
    return {
      exists: true,
      path,
      ...(typeof selectedModelId === "string" ? { selectedModelId } : {}),
    };
  } catch (error) {
    return {
      error: `${path}: ${getErrorMessage(error)}`,
      exists: true,
      path,
    };
  }
}

export function writeSubagentModelPreference(
  params: SubagentModelPreferenceParams,
  selectedModelId: string | undefined,
): SubagentModelPreference {
  const path = resolveSubagentModelPreferencePath(params);
  const stored: StoredSubagentModelPreference = {
    selectedModelId: selectedModelId ?? null,
    version: PREFERENCE_VERSION,
  };
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
    return {
      exists: true,
      path,
      ...(selectedModelId ? { selectedModelId } : {}),
    };
  } catch (error) {
    return {
      error: `${path}: ${getErrorMessage(error)}`,
      exists: existsSync(path),
      path,
      ...(selectedModelId ? { selectedModelId } : {}),
    };
  } finally {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup must not hide the original persistence result.
    }
  }
}

export function resolveSubagentModelPreference(
  agentName: string,
  preference: SubagentModelPreference,
  modelOptions: readonly { readonly id: string }[],
  sessionSelectedModelId?: string | undefined,
): SubagentModelPreferenceResolution {
  if (preference.error) {
    return {
      migrateSessionSelection: false,
      warning: `Could not read the persistent ${agentName} model override: ${preference.error}. Using the config default.`,
    };
  }

  if (preference.exists) {
    if (!preference.selectedModelId) return { migrateSessionSelection: false };
    if (modelOptions.some((option) => option.id === preference.selectedModelId)) {
      return {
        migrateSessionSelection: false,
        selectedModelId: preference.selectedModelId,
      };
    }
    return {
      migrateSessionSelection: false,
      warning: `Persistent ${agentName} model override "${preference.selectedModelId}" is not available. Using the config default until the model option is restored or a new override is selected.`,
    };
  }

  if (sessionSelectedModelId && modelOptions.some((option) => option.id === sessionSelectedModelId)) {
    return {
      migrateSessionSelection: true,
      selectedModelId: sessionSelectedModelId,
    };
  }

  return { migrateSessionSelection: false };
}

export function isSubagentModelPreferenceReset(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "default" || normalized === "reset";
}
