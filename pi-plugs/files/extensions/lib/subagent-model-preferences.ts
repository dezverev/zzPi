import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const PREFERENCE_VERSION = 1;
const LEGACY_PREFERENCE_DIRECTORY = "subagent-model-overrides";
const SHARED_PREFERENCE_DIRECTORY = ".zzpi";
const SHARED_PREFERENCE_FILE = "zz-agent-active-models.json";

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

interface StoredSharedSubagentModelPreferences {
  readonly models: Record<string, unknown>;
  readonly version: typeof PREFERENCE_VERSION;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function resolveLegacySubagentModelPreferencePath(
  params: SubagentModelPreferenceParams,
): string {
  const configPath = resolveConfigPath(params.cwd, params.configFilePath);
  const piDirectory = findPiDirectory(configPath);
  return resolve(
    piDirectory,
    LEGACY_PREFERENCE_DIRECTORY,
    `${normalizeAgentName(params.agentName)}.json`,
  );
}

function readJsonRecord(path: string, description: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`${description} must contain a JSON object`);
  return parsed;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function validateSharedPreferenceLocation(path: string): void {
  const directoryStats = lstatIfPresent(dirname(path));
  if (directoryStats && (directoryStats.isSymbolicLink() || !directoryStats.isDirectory())) {
    throw new Error("shared preference directory must be a real directory, not a symlink");
  }
  const fileStats = lstatIfPresent(path);
  if (fileStats && (fileStats.isSymbolicLink() || !fileStats.isFile())) {
    throw new Error("shared preference file must be a regular file, not a symlink");
  }
}

function readSharedModels(path: string): Record<string, unknown> {
  validateSharedPreferenceLocation(path);
  const record = readJsonRecord(path, "shared model preferences");
  if (record.version !== PREFERENCE_VERSION) {
    throw new Error(`unsupported shared preference version ${String(record.version)}`);
  }
  if (!isRecord(record.models)) {
    throw new Error("shared preference models must contain a JSON object");
  }
  return record.models;
}

function readLegacySubagentModelPreference(path: string): SubagentModelPreference {
  if (!existsSync(path)) return { exists: false, path };

  try {
    const record = readJsonRecord(path, "preference");
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

export function resolveSubagentModelPreferencePath(
  params: SubagentModelPreferenceParams,
): string {
  const configPath = resolveConfigPath(params.cwd, params.configFilePath);
  const piDirectory = findPiDirectory(configPath);
  return resolve(dirname(piDirectory), SHARED_PREFERENCE_DIRECTORY, SHARED_PREFERENCE_FILE);
}

export function readSubagentModelPreference(
  params: SubagentModelPreferenceParams,
): SubagentModelPreference {
  const path = resolveSubagentModelPreferencePath(params);
  try {
    validateSharedPreferenceLocation(path);
  } catch (error) {
    return {
      error: `${path}: ${getErrorMessage(error)}`,
      exists: true,
      path,
    };
  }
  if (existsSync(path)) {
    try {
      const agentName = normalizeAgentName(params.agentName);
      const models = readSharedModels(path);
      if (Object.prototype.hasOwnProperty.call(models, agentName)) {
        const selectedModelId = models[agentName];
        if (selectedModelId !== null && (typeof selectedModelId !== "string" || !selectedModelId.trim())) {
          throw new Error(`shared preference for ${agentName} must be a non-empty string or null`);
        }
        return {
          exists: true,
          path,
          ...(typeof selectedModelId === "string" ? { selectedModelId } : {}),
        };
      }
    } catch (error) {
      return {
        error: `${path}: ${getErrorMessage(error)}`,
        exists: true,
        path,
      };
    }
  }

  const legacyPreference = readLegacySubagentModelPreference(
    resolveLegacySubagentModelPreferencePath(params),
  );
  return legacyPreference.exists ? legacyPreference : { exists: false, path };
}

export function writeSubagentModelPreference(
  params: SubagentModelPreferenceParams,
  selectedModelId: string | undefined,
): SubagentModelPreference {
  const path = resolveSubagentModelPreferencePath(params);
  if (selectedModelId !== undefined && !selectedModelId.trim()) {
    return {
      error: `${path}: selectedModelId must be a non-empty string or undefined`,
      exists: existsSync(path),
      path,
    };
  }

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    validateSharedPreferenceLocation(path);
    const models = existsSync(path) ? readSharedModels(path) : {};
    const stored: StoredSharedSubagentModelPreferences = {
      models: {
        ...models,
        [normalizeAgentName(params.agentName)]: selectedModelId ?? null,
      },
      version: PREFERENCE_VERSION,
    };
    mkdirSync(dirname(path), { recursive: true });
    validateSharedPreferenceLocation(path);
    writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });
    renameSync(temporaryPath, path);
    return {
      exists: true,
      path,
      ...(selectedModelId !== undefined ? { selectedModelId } : {}),
    };
  } catch (error) {
    return {
      error: `${path}: ${getErrorMessage(error)}`,
      exists: existsSync(path),
      path,
      ...(selectedModelId !== undefined ? { selectedModelId } : {}),
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
      migrateSessionSelection: false,
      selectedModelId: sessionSelectedModelId,
    };
  }

  return { migrateSessionSelection: false };
}

export function isSubagentModelPreferenceReset(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "default" || normalized === "reset";
}
