import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  loadCustomPlugModule,
  type CustomPlugModuleLoaderOptions,
} from "./custom-plug-module-loader.ts";
import type {
  CustomPlugChildAgentDefinitionV1,
  CustomPlugCommandDefinitionV1,
  CustomPlugDefinitionsV1,
  CustomPlugRegisterV1,
  CustomPlugRegistrarV1,
} from "./custom-plug-types.ts";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENTRY_EXTENSIONS = new Set([".js", ".mjs", ".mts", ".ts"]);
const MANIFEST_FILE = "zz-plug.json";

export interface CustomPlugManifestV1 {
  readonly apiVersion: 1;
  readonly id: string;
  readonly entry: string;
  readonly title?: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

export interface DiscoveredCustomPlugV1 {
  readonly directory: string;
  readonly entryPath: string;
  readonly manifest: CustomPlugManifestV1;
  readonly manifestPath: string;
}

export type CustomPlugDiagnosticStage =
  | "discovery"
  | "manifest"
  | "import"
  | "registration";

export interface CustomPlugDiagnostic {
  readonly stage: CustomPlugDiagnosticStage;
  readonly pluginDirectory: string;
  readonly manifestPath: string;
  readonly pluginId?: string;
  readonly message: string;
}

export interface CollectedCustomPlugV1 extends DiscoveredCustomPlugV1 {
  readonly definitions: CustomPlugDefinitionsV1;
}

export interface DiscoverCustomPlugsResult {
  readonly plugins: readonly DiscoveredCustomPlugV1[];
  readonly diagnostics: readonly CustomPlugDiagnostic[];
}

export type CustomPlugInventoryState = "active" | "disabled";

export interface CustomPlugInventoryRow {
  readonly state: CustomPlugInventoryState;
  readonly root: string;
  readonly directoryName: string;
  readonly directoryPath: string;
  readonly manifestPath: string;
  readonly manifest?: CustomPlugManifestV1;
  readonly entryPath?: string;
  readonly diagnostics: readonly CustomPlugDiagnostic[];
  readonly activatable: boolean;
}

export interface CustomPlugInventoryResult {
  readonly rows: readonly CustomPlugInventoryRow[];
  readonly diagnostics: readonly CustomPlugDiagnostic[];
}

export interface LoadCustomPlugsOptions extends CustomPlugModuleLoaderOptions {
  readonly importModule?: (
    entryPath: string,
    options: CustomPlugModuleLoaderOptions,
  ) => Promise<unknown>;
  readonly reservedCommandNames?: readonly string[];
}

export interface LoadCustomPlugsResult {
  readonly plugins: readonly CollectedCustomPlugV1[];
  readonly diagnostics: readonly CustomPlugDiagnostic[];
}

function diagnostic(
  stage: CustomPlugDiagnosticStage,
  directory: string,
  message: string,
  pluginId?: string,
): CustomPlugDiagnostic {
  return {
    stage,
    pluginDirectory: directory,
    manifestPath: join(directory, MANIFEST_FILE),
    ...(pluginId === undefined ? {} : { pluginId }),
    message,
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function validateManifest(value: unknown): CustomPlugManifestV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("manifest must be a JSON object");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.apiVersion !== 1) {
    throw new TypeError("apiVersion must be 1");
  }
  const id = requireNonEmptyString(manifest.id, "id");
  if (!ID_PATTERN.test(id)) {
    throw new TypeError("id must contain lowercase letters, digits, and single hyphens and start and end alphanumerically");
  }
  const entry = requireNonEmptyString(manifest.entry, "entry");
  if (manifest.title !== undefined && typeof manifest.title !== "string") {
    throw new TypeError("title must be a string when provided");
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") {
    throw new TypeError("description must be a string when provided");
  }
  return manifest as unknown as CustomPlugManifestV1;
}

function isContained(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent);
}

type DiscoveryDirectoryValidation =
  | { readonly status: "ready" }
  | { readonly status: "missing" }
  | { readonly status: "unsafe"; readonly message: string };

async function validateDiscoveryDirectory(
  canonicalProject: string,
  directory: string,
): Promise<DiscoveryDirectoryValidation> {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return {
      status: "unsafe",
      message: `cannot validate custom plug root: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (metadata.isSymbolicLink()) {
    return { status: "unsafe", message: `custom plug root must be a real directory, not a symbolic link: ${directory}` };
  }
  if (!metadata.isDirectory()) {
    return { status: "unsafe", message: `custom plug root must be a directory: ${directory}` };
  }
  try {
    const resolvedDirectory = await realpath(directory);
    if (!isContained(canonicalProject, resolvedDirectory)) {
      return {
        status: "unsafe",
        message: `custom plug root resolves outside the canonical project: ${resolvedDirectory}`,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return {
      status: "unsafe",
      message: `cannot resolve custom plug root: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { status: "ready" };
}

async function validateDiscoveryParent(
  cwd: string,
): Promise<{ readonly canonicalProject?: string; readonly diagnostic?: CustomPlugDiagnostic }> {
  const zzpiRoot = join(cwd, ".zzpi");
  let canonicalProject: string;
  try {
    canonicalProject = await realpath(cwd);
  } catch (error) {
    return { diagnostic: diagnostic("discovery", zzpiRoot, `cannot resolve canonical project: ${error instanceof Error ? error.message : String(error)}`) };
  }
  const validation = await validateDiscoveryDirectory(canonicalProject, zzpiRoot);
  if (validation.status === "missing") return {};
  if (validation.status === "unsafe") {
    return { diagnostic: diagnostic("discovery", zzpiRoot, validation.message) };
  }
  return { canonicalProject };
}

async function readCandidate(directory: string): Promise<DiscoveredCustomPlugV1> {
  const manifestPath = join(directory, MANIFEST_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read valid ${MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = validateManifest(parsed);
  if (isAbsolute(manifest.entry)) {
    throw new Error("entry must be a relative path");
  }
  if (!ENTRY_EXTENSIONS.has(extname(manifest.entry).toLowerCase())) {
    throw new Error("entry must use .ts, .mts, .js, or .mjs");
  }

  const directoryRealPath = await realpath(directory);
  const entryPath = resolve(directoryRealPath, manifest.entry);
  if (!isContained(directoryRealPath, entryPath)) {
    throw new Error("entry escapes the plugin directory");
  }
  let entryRealPath: string;
  try {
    entryRealPath = await realpath(entryPath);
    if (!(await stat(entryRealPath)).isFile()) {
      throw new Error("entry is not a file");
    }
  } catch (error) {
    throw new Error(`entry is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isContained(directoryRealPath, entryRealPath)) {
    throw new Error("entry resolves outside the plugin directory");
  }

  return { directory, entryPath: entryRealPath, manifest, manifestPath };
}

export async function inventoryCustomPlugs(cwd: string): Promise<CustomPlugInventoryResult> {
  const roots: readonly [CustomPlugInventoryState, string][] = [
    ["active", join(cwd, ".zzpi", "custom-plugs")],
    ["disabled", join(cwd, ".zzpi", "custom-plugs-disabled")],
  ];
  const mutableRows: Array<{
    state: CustomPlugInventoryState;
    root: string;
    directoryName: string;
    directoryPath: string;
    manifestPath: string;
    manifest?: CustomPlugManifestV1;
    entryPath?: string;
    diagnostics: CustomPlugDiagnostic[];
  }> = [];
  const diagnostics: CustomPlugDiagnostic[] = [];
  const parent = await validateDiscoveryParent(cwd);
  if (parent.diagnostic !== undefined) return { rows: [], diagnostics: [parent.diagnostic] };
  if (parent.canonicalProject === undefined) return { rows: [], diagnostics: [] };

  const validatedRoots: Array<readonly [CustomPlugInventoryState, string]> = [];
  for (const [state, root] of roots) {
    const validation = await validateDiscoveryDirectory(parent.canonicalProject, root);
    if (validation.status === "ready") validatedRoots.push([state, root]);
    if (validation.status === "unsafe") diagnostics.push(diagnostic("discovery", root, validation.message));
  }

  for (const [state, root] of validatedRoots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      diagnostics.push(diagnostic("discovery", root, error instanceof Error ? error.message : String(error)));
      continue;
    }
    const directoryNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const directoryName of directoryNames) {
      const directoryPath = join(root, directoryName);
      const row = {
        state,
        root,
        directoryName,
        directoryPath,
        manifestPath: join(directoryPath, MANIFEST_FILE),
        diagnostics: [] as CustomPlugDiagnostic[],
      };
      try {
        const candidate = await readCandidate(directoryPath);
        mutableRows.push({ ...row, manifest: candidate.manifest, entryPath: candidate.entryPath });
      } catch (error) {
        const item = diagnostic("manifest", directoryPath, error instanceof Error ? error.message : String(error));
        row.diagnostics.push(item);
        diagnostics.push(item);
        mutableRows.push(row);
      }
    }
  }

  const directoryCounts = new Map<string, number>();
  const idCounts = new Map<string, number>();
  for (const row of mutableRows) {
    directoryCounts.set(row.directoryName, (directoryCounts.get(row.directoryName) ?? 0) + 1);
    if (row.manifest !== undefined) {
      idCounts.set(row.manifest.id, (idCounts.get(row.manifest.id) ?? 0) + 1);
    }
  }
  for (const row of mutableRows) {
    if (directoryCounts.get(row.directoryName)! > 1) {
      const item = diagnostic("discovery", row.directoryPath, `duplicate directory name across custom plug roots: ${row.directoryName}`, row.manifest?.id);
      row.diagnostics.push(item);
      diagnostics.push(item);
    }
    if (row.manifest !== undefined && idCounts.get(row.manifest.id)! > 1) {
      const item = diagnostic("manifest", row.directoryPath, `duplicate plugin id: ${row.manifest.id}`, row.manifest.id);
      row.diagnostics.push(item);
      diagnostics.push(item);
    }
  }

  const rows: CustomPlugInventoryRow[] = mutableRows.map((row) => ({
    ...row,
    activatable: row.state === "disabled" && row.manifest !== undefined && row.diagnostics.length === 0,
  }));
  return { rows, diagnostics };
}

export async function discoverCustomPlugs(cwd: string): Promise<DiscoverCustomPlugsResult> {
  const root = join(cwd, ".zzpi", "custom-plugs");
  const parent = await validateDiscoveryParent(cwd);
  if (parent.diagnostic !== undefined) return { plugins: [], diagnostics: [parent.diagnostic] };
  if (parent.canonicalProject === undefined) return { plugins: [], diagnostics: [] };
  const validation = await validateDiscoveryDirectory(parent.canonicalProject, root);
  if (validation.status === "missing") return { plugins: [], diagnostics: [] };
  if (validation.status === "unsafe") {
    return { plugins: [], diagnostics: [diagnostic("discovery", root, validation.message)] };
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { plugins: [], diagnostics: [] };
    }
    return { plugins: [], diagnostics: [diagnostic("discovery", root, error instanceof Error ? error.message : String(error))] };
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const diagnostics: CustomPlugDiagnostic[] = [];
  const valid: DiscoveredCustomPlugV1[] = [];
  for (const directory of candidates) {
    try {
      valid.push(await readCandidate(directory));
    } catch (error) {
      diagnostics.push(diagnostic("manifest", directory, error instanceof Error ? error.message : String(error)));
    }
  }

  const idCounts = new Map<string, number>();
  for (const plugin of valid) {
    idCounts.set(plugin.manifest.id, (idCounts.get(plugin.manifest.id) ?? 0) + 1);
  }
  const plugins = valid.filter((plugin) => {
    if (idCounts.get(plugin.manifest.id) === 1) return true;
    diagnostics.push(diagnostic("manifest", plugin.directory, `duplicate plugin id: ${plugin.manifest.id}`, plugin.manifest.id));
    return false;
  });
  return { plugins, diagnostics };
}

function validateDefinitionName(value: unknown, field: string): asserts value is string {
  const name = requireNonEmptyString(value, field);
  if (!ID_PATTERN.test(name)) throw new TypeError(`${field} must use lowercase letters, digits, and single hyphens`);
}

function validateStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
}

function validateChildAgent(definition: CustomPlugChildAgentDefinitionV1): void {
  if (!definition || typeof definition !== "object") throw new TypeError("child-agent definition must be an object");
  validateDefinitionName(definition.id, "child-agent id");
  requireNonEmptyString(definition.description, "child-agent description");
  if (!definition.config || typeof definition.config !== "object") throw new TypeError("child-agent config must be an object");
  const config = definition.config as unknown as Record<string, unknown>;
  for (const field of ["endpoint", "model", "provider", "systemPrompt", "thinking"] as const) requireNonEmptyString(config[field], `config.${field}`);
  for (const field of ["endpointSource", "modelSelector"] as const) {
    if (config[field] !== undefined) requireNonEmptyString(config[field], `config.${field}`);
  }
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.thinking as string)) throw new TypeError("config.thinking is unsupported");
  if (config.providerRegistration !== undefined && !["openai-compatible", "none"].includes(config.providerRegistration as string)) throw new TypeError("config.providerRegistration is unsupported");
  for (const field of ["contextWindow", "maxOutputTokens", "reportMaxChars", "requestTimeoutMs"] as const) {
    if (typeof config[field] !== "number" || !Number.isInteger(config[field]) || config[field] <= 0) throw new TypeError(`config.${field} must be a positive integer`);
  }
  validateStringArray(config.tools, "config.tools");
  if (definition.excludeTools !== undefined) validateStringArray(definition.excludeTools, "excludeTools");
  if (definition.buildPrompt !== undefined && typeof definition.buildPrompt !== "function") throw new TypeError("buildPrompt must be a function");
  if (definition.command !== undefined) {
    validateDefinitionName(definition.command.name, "generated command name");
    if (definition.command.description !== undefined) requireNonEmptyString(definition.command.description, "generated command description");
    if (definition.command.usage !== undefined) requireNonEmptyString(definition.command.usage, "generated command usage");
  }
}

function validateCommand(definition: CustomPlugCommandDefinitionV1): void {
  if (!definition || typeof definition !== "object") throw new TypeError("command definition must be an object");
  validateDefinitionName(definition.name, "command name");
  requireNonEmptyString(definition.description, "command description");
  if (definition.usage !== undefined) requireNonEmptyString(definition.usage, "command usage");
  if (typeof definition.handler !== "function") throw new TypeError("command handler must be a function");
}

function snapshotChildAgent(definition: CustomPlugChildAgentDefinitionV1): CustomPlugChildAgentDefinitionV1 {
  const config = Object.freeze({
    ...definition.config,
    tools: Object.freeze([...definition.config.tools]),
  });
  return Object.freeze({
    ...definition,
    config,
    ...(definition.excludeTools === undefined
      ? {}
      : { excludeTools: Object.freeze([...definition.excludeTools]) }),
    ...(definition.command === undefined
      ? {}
      : { command: Object.freeze({ ...definition.command }) }),
  });
}

export function createCustomPlugCollector(): {
  readonly registrar: CustomPlugRegistrarV1;
  finish(): CustomPlugDefinitionsV1;
} {
  const childAgents: CustomPlugChildAgentDefinitionV1[] = [];
  const commands: CustomPlugCommandDefinitionV1[] = [];
  const childIds = new Set<string>();
  const commandNames = new Set<string>();
  let finished = false;
  const assertOpen = () => {
    if (finished) throw new Error("custom-plug collector is already finished");
  };

  const registrar: CustomPlugRegistrarV1 = Object.freeze({
    registerChildAgent(definition: CustomPlugChildAgentDefinitionV1): void {
      assertOpen();
      validateChildAgent(definition);
      if (childIds.has(definition.id)) throw new Error(`duplicate child-agent id: ${definition.id}`);
      if (definition.command && commandNames.has(definition.command.name)) throw new Error(`duplicate command name: ${definition.command.name}`);
      childIds.add(definition.id);
      if (definition.command) commandNames.add(definition.command.name);
      childAgents.push(snapshotChildAgent(definition));
    },
    registerCommand(definition: CustomPlugCommandDefinitionV1): void {
      assertOpen();
      validateCommand(definition);
      if (commandNames.has(definition.name)) throw new Error(`duplicate command name: ${definition.name}`);
      commandNames.add(definition.name);
      commands.push(Object.freeze({ ...definition }));
    },
  });

  return {
    registrar,
    finish(): CustomPlugDefinitionsV1 {
      assertOpen();
      finished = true;
      return Object.freeze({ childAgents: Object.freeze([...childAgents]), commands: Object.freeze([...commands]) });
    },
  };
}

async function revalidateEntryForImport(plugin: DiscoveredCustomPlugV1): Promise<string> {
  const directoryRealPath = await realpath(plugin.directory);
  const entryPath = resolve(directoryRealPath, plugin.manifest.entry);
  if (!isContained(directoryRealPath, entryPath)) {
    throw new Error("entry escapes the plugin directory");
  }
  const entryRealPath = await realpath(entryPath);
  if (!isContained(directoryRealPath, entryRealPath)) {
    throw new Error("entry resolves outside the plugin directory");
  }
  if (!(await stat(entryRealPath)).isFile()) {
    throw new Error("entry is not a file");
  }
  await access(entryRealPath, constants.R_OK);
  return entryRealPath;
}

function getRegistration(moduleValue: unknown): CustomPlugRegisterV1 {
  if (moduleValue === null || typeof moduleValue !== "object") throw new TypeError("entry module must default-export a registration function");
  const register = (moduleValue as { default?: unknown }).default;
  if (typeof register !== "function") throw new TypeError("entry module must default-export a registration function");
  return register as CustomPlugRegisterV1;
}

export async function loadCustomPlugs(cwd: string, options: LoadCustomPlugsOptions = {}): Promise<LoadCustomPlugsResult> {
  const discovered = await discoverCustomPlugs(cwd);
  const diagnostics = [...discovered.diagnostics];
  const plugins: CollectedCustomPlugV1[] = [];
  const importModule = options.importModule ?? loadCustomPlugModule;

  for (const plugin of discovered.plugins) {
    let register: CustomPlugRegisterV1;
    try {
      const entryPath = await revalidateEntryForImport(plugin);
      register = getRegistration(await importModule(entryPath, options));
    } catch (error) {
      diagnostics.push(diagnostic("import", plugin.directory, error instanceof Error ? error.message : String(error), plugin.manifest.id));
      continue;
    }
    const collector = createCustomPlugCollector();
    try {
      await register(collector.registrar);
      plugins.push({ ...plugin, definitions: collector.finish() });
    } catch (error) {
      diagnostics.push(diagnostic("registration", plugin.directory, error instanceof Error ? error.message : String(error), plugin.manifest.id));
    }
  }

  const childOwners = new Map<string, CollectedCustomPlugV1[]>();
  const commandOwners = new Map<string, CollectedCustomPlugV1[]>();
  const addOwner = (owners: Map<string, CollectedCustomPlugV1[]>, name: string, plugin: CollectedCustomPlugV1) => {
    const entries = owners.get(name) ?? [];
    entries.push(plugin);
    owners.set(name, entries);
  };
  for (const plugin of plugins) {
    for (const child of plugin.definitions.childAgents) {
      addOwner(childOwners, child.id, plugin);
      if (child.command) addOwner(commandOwners, child.command.name, plugin);
    }
    for (const command of plugin.definitions.commands) addOwner(commandOwners, command.name, plugin);
  }

  const collisionMessages = new Map<CollectedCustomPlugV1, string[]>();
  const recordCollisions = (owners: Map<string, CollectedCustomPlugV1[]>, namespace: string) => {
    for (const [name, participants] of owners) {
      if (participants.length < 2) continue;
      for (const plugin of participants) {
        const messages = collisionMessages.get(plugin) ?? [];
        messages.push(`duplicate ${namespace}: ${name}`);
        collisionMessages.set(plugin, messages);
      }
    }
  };
  recordCollisions(childOwners, "child-agent id");
  recordCollisions(commandOwners, "command name");
  for (const name of options.reservedCommandNames ?? []) {
    for (const plugin of commandOwners.get(name) ?? []) {
      const messages = collisionMessages.get(plugin) ?? [];
      messages.push(`reserved command name: ${name}`);
      collisionMessages.set(plugin, messages);
    }
  }
  for (const [plugin, messages] of collisionMessages) {
    diagnostics.push(diagnostic("registration", plugin.directory, messages.join("; "), plugin.manifest.id));
  }

  return { plugins: plugins.filter((plugin) => !collisionMessages.has(plugin)), diagnostics };
}
