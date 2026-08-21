import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import { commitCustomPlugsToPi, type CustomPlugBindingDiagnostic } from "./lib/custom-plug-adapter.ts";
import {
  compensateCustomPlugActivationMoves,
  executeCustomPlugActivationMoves,
  planCustomPlugActivationMoves,
  CustomPlugMoveExecutionError,
  CustomPlugMovePlanError,
  type CustomPlugMove,
  type CustomPlugMoveExecutionResult,
  type CustomPlugMoveFailure,
  type CustomPlugMoveJournalEntry,
} from "./lib/custom-plug-activation.ts";
import {
  inventoryCustomPlugs,
  loadCustomPlugs,
  type CustomPlugDiagnostic,
  type CustomPlugInventoryResult,
  type CustomPlugInventoryRow,
  type CustomPlugInventoryState,
} from "./lib/custom-plug-loader.ts";

const MANAGER_ID = "zz-plug-manager";
const STATE_FILE = ".pi/zz-pi-plugs-manifest.json";
const CONFIG_FILE = ".pi/extensions/zz-plug-manager.config.jsonc";
const DEFAULT_SOURCE_URL = "https://raw.githubusercontent.com/dezverev/zzPi/main/pi-plugs";
const DEFAULT_ZZ_LIB_URL = "https://raw.githubusercontent.com/dezverev/zzPi/main/zz-lib";
const ZZ_LIB_STATE_FILE = ".pi/zz-lib-manifest.json";
const MESSAGE_TYPE = "zz-plugs";

type JsonRecord = Record<string, unknown>;

interface ManagerConfig {
  readonly autoReload: boolean;
  readonly sourceUrl: string;
  readonly zzLibUrl: string;
}

interface PlugManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface SharedDep {
  readonly id: string;
  readonly minVersion: string;
}

interface PlugManifestPlugin {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly entry: string;
  readonly internal: boolean;
  readonly pluginDeps: string[];
  readonly optionalPluginDeps: string[];
  readonly fileDeps: string[];
  readonly configFiles: string[];
  readonly sharedDeps: SharedDep[];
  readonly tags: string[];
}

interface PlugManifest {
  readonly schemaVersion: number;
  readonly updated_at?: string;
  readonly source?: string;
  readonly visiblePlugins: string[];
  readonly commonFiles: string[];
  readonly plugins: PlugManifestPlugin[];
  readonly files: PlugManifestFile[];
}

interface SharedLibManifest {
  readonly schemaVersion: number;
  readonly updated_at?: string;
  readonly source?: string;
  readonly commonFiles: string[];
  readonly files: PlugManifestFile[];
  readonly sharedLib?: { readonly id?: string; readonly version?: string };
  readonly zzLibVersion?: string;
}

interface InstallState {
  readonly installer?: string;
  readonly schemaVersion?: number;
  readonly manifest_updated_at?: string;
  readonly source?: string;
  readonly bundle_url?: string;
  readonly selected_plugins?: string[];
  readonly installed_plugins?: string[];
  readonly auto_required_plugins?: string[];
  readonly required_shared_libs?: SharedDep[];
  readonly owned_files?: Record<string, string[]>;
  readonly config_files?: string[];
  readonly file_hashes?: Record<string, string>;
  readonly files?: PlugManifestFile[];
}

interface ResolvedPlan {
  readonly selected: string[];
  readonly installed: string[];
  readonly autoRequired: string[];
  readonly requiredSharedLibs: SharedDep[];
  readonly ownedFiles: Record<string, string[]>;
  readonly configFiles: Set<string>;
}

interface ApplyOptions {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly resetConfig: boolean;
  readonly reload: boolean;
}

interface ApplyResult {
  readonly ensuredSharedLibs: string[];
  readonly harnessActions: string[];
  readonly mergedConfigs: string[];
  readonly plan: ResolvedPlan;
  readonly preservedConfigs: string[];
  readonly removed: string[];
  readonly warnings: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return isRecord(value) && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function stripUtf8Bom(text: string): string {
  // Windows PowerShell 5.1 writes a BOM for `Set-Content -Encoding UTF8`.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stripJsonc(text: string): string {
  text = stripUtf8Bom(text);
  let output = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inString) {
      output += ch;
      if (ch === "\\") {
        output += next;
        i += 1;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      output += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && !"\r\n".includes(text[i] ?? "")) i += 1;
      output += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    output += ch;
  }
  return output.replace(/,\s*([}\]])/gu, "$1");
}

async function readJson(path: string): Promise<JsonRecord | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(stripJsonc(text));
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJsoncRecord(text: string, label: string): JsonRecord {
  const parsed = JSON.parse(stripJsonc(text)) as unknown;
  if (!isPlainRecord(parsed)) throw new Error(`${label} must contain a JSON object.`);
  return parsed;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function fillMissingConfig(existing: JsonRecord, defaults: JsonRecord): boolean {
  let changed = false;

  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(existing, key)) {
      existing[key] = cloneJson(defaultValue);
      changed = true;
      continue;
    }

    const existingValue = existing[key];
    if (isPlainRecord(existingValue) && isPlainRecord(defaultValue)) {
      changed = fillMissingConfig(existingValue, defaultValue) || changed;
    }
  }

  return changed;
}

async function mergeConfigFile(target: string, defaultText: string, rel: string): Promise<boolean> {
  const existing = parseJsoncRecord(await readFile(target, "utf8"), rel);
  const defaults = parseJsoncRecord(defaultText, rel);
  if (!fillMissingConfig(existing, defaults)) return false;

  await writeFile(
    target,
    `// Updated by zz pi plugs: existing values preserved; missing defaults filled from the latest bundle.\n${JSON.stringify(existing, null, 2)}\n`,
    "utf8",
  );
  return true;
}

function cleanRelPath(path: string): string {
  const rel = path.replace(/\\/gu, "/").replace(/^\/+/, "");
  const parts = rel.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new Error(`Unsafe path in plug manifest: ${path}`);
  return parts.join("/");
}

function safeTarget(base: string, relPath: string): string {
  const rel = cleanRelPath(relPath);
  const basePath = resolve(base);
  const target = resolve(basePath, rel);
  if (target !== basePath && !target.startsWith(basePath + sep)) {
    throw new Error(`Path escapes target .pi: ${relPath}`);
  }
  return target;
}

function splitTokens(value: string): string[] {
  return value.split(/[\s,]+/u).map((part) => part.trim()).filter(Boolean);
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  return hashBuffer(await readFile(path));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function fileUrl(sourceUrl: string, relPath: string): string {
  const encoded = cleanRelPath(relPath).split("/").map(encodeURIComponent).join("/");
  return `${sourceUrl.replace(/\/+$/u, "")}/files/${encoded}`;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

async function fetchFile(sourceUrl: string, relPath: string, expectedSha: string, signal?: AbortSignal): Promise<Buffer> {
  const url = fileUrl(sourceUrl, relPath);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = hashBuffer(buffer);
  if (expectedSha && actual !== expectedSha) {
    throw new Error(`Hash mismatch for ${relPath}: expected ${expectedSha}, got ${actual}`);
  }
  return buffer;
}

function defaultZzLibUrl(sourceUrl: string): string {
  const trimmed = sourceUrl.replace(/\/+$/u, "");
  try {
    const url = new URL(trimmed);
    const parentPath = url.pathname.replace(/\/+$/u, "").replace(/\/[^/]*$/u, "");
    url.pathname = `${parentPath}/zz-lib`;
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return trimmed.replace(/\/[^/]*$/u, "/zz-lib") || DEFAULT_ZZ_LIB_URL;
  }
}

async function loadConfig(cwd: string): Promise<ManagerConfig> {
  const record = await readJson(resolve(cwd, CONFIG_FILE));
  const rawSourceUrl = process.env.ZZ_PI_PLUGS_URL || asString(record?.sourceUrl) || DEFAULT_SOURCE_URL;
  const sourceUrl = rawSourceUrl.replace(/\/+$/u, "");
  const rawZzLibUrl = process.env.ZZ_LIB_URL || asString(record?.zzLibUrl) || defaultZzLibUrl(sourceUrl);
  const autoReload = typeof record?.autoReload === "boolean" ? record.autoReload : true;
  return { sourceUrl, zzLibUrl: rawZzLibUrl.replace(/\/+$/u, ""), autoReload };
}

async function loadManifest(sourceUrl: string, signal?: AbortSignal): Promise<PlugManifest> {
  const manifest = await fetchJson<PlugManifest>(`${sourceUrl.replace(/\/+$/u, "")}/manifest.json`, signal);
  if (!Array.isArray(manifest.plugins) || !Array.isArray(manifest.files)) {
    throw new Error("Bad plug manifest: missing plugins/files arrays");
  }
  return withHarnessIntegrationPlugins(manifest);
}

function pluginMap(manifest: PlugManifest): Map<string, PlugManifestPlugin> {
  return new Map(manifest.plugins.map((plugin) => [plugin.id, plugin]));
}

function visiblePlugins(manifest: PlugManifest): PlugManifestPlugin[] {
  return manifest.plugins.filter((plugin) => !plugin.internal);
}

function visiblePluginIds(manifest: PlugManifest): Set<string> {
  return new Set(visiblePlugins(manifest).map((plugin) => plugin.id));
}

const HARNESS_INTEGRATION_IDS = [
  "codex-readsubagent",
  "claude-readsubagent",
  "copilot-readsubagent",
  "copilot-native-agents",
] as const;
type HarnessIntegrationId = (typeof HARNESS_INTEGRATION_IDS)[number];

function isHarnessIntegrationId(id: string): id is HarnessIntegrationId {
  return (HARNESS_INTEGRATION_IDS as readonly string[]).includes(id);
}

function harnessIntegrationPlugin(id: HarnessIntegrationId): PlugManifestPlugin {
  if (id === "codex-readsubagent") {
    return {
      id,
      title: "Codex readsubagent",
      description: "Installs the Codex readsubagent skill, repo MCP server, and AGENTS.md guidance.",
      entry: "extensions/00-zz-subagent-runtime.ts",
      internal: false,
      pluginDeps: ["zz-subagent-runtime"],
      optionalPluginDeps: [],
      fileDeps: [],
      configFiles: [],
      sharedDeps: [],
      tags: ["skill", "codex", "mcp", "read-only"],
    };
  }

  if (id === "claude-readsubagent") {
    return {
      id,
      title: "Claude readsubagent",
      description: "Installs the Claude Code readsubagent skill, MCP server registration, hooks, and CLAUDE.md guidance.",
      entry: "extensions/00-zz-subagent-runtime.ts",
      internal: false,
      pluginDeps: ["zz-subagent-runtime", "zz-local-models"],
      optionalPluginDeps: [],
      fileDeps: [],
      configFiles: [],
      sharedDeps: [],
      tags: ["skill", "claude", "mcp", "read-only"],
    };
  }

  if (id === "copilot-readsubagent") {
    return {
      id,
      title: "Copilot readsubagent",
      description: "Installs the GitHub Copilot CLI readsubagent skill, hooks, MCP server, and instructions.",
      entry: "extensions/00-zz-subagent-runtime.ts",
      internal: false,
      pluginDeps: ["zz-subagent-runtime", "zz-local-models"],
      optionalPluginDeps: [],
      fileDeps: [],
      configFiles: [],
      sharedDeps: [],
      tags: ["skill", "copilot", "mcp", "read-only"],
    };
  }

  return {
    id,
    title: "Copilot native workflow agents",
    description: "Installs three native Copilot workflow agents, implementer lifecycle hooks, and orchestration guidance alongside Copilot readsubagent.",
    entry: "extensions/00-zz-subagent-runtime.ts",
    internal: false,
    pluginDeps: ["copilot-readsubagent"],
    optionalPluginDeps: [],
    fileDeps: [],
    configFiles: [],
    sharedDeps: [],
    tags: ["agent", "copilot", "workflow", "subagent"],
  };
}

function withHarnessIntegrationPlugins(manifest: PlugManifest): PlugManifest {
  const existing = new Set(manifest.plugins.map((plugin) => plugin.id));
  const plugins = [...manifest.plugins];
  for (const id of HARNESS_INTEGRATION_IDS) {
    if (!existing.has(id)) plugins.push(harnessIntegrationPlugin(id));
  }
  return { ...manifest, plugins, visiblePlugins: visiblePlugins({ ...manifest, plugins }).map((plugin) => plugin.id) };
}

function versionKey(value: string): number[] {
  const parts = value.split(/[^0-9]+/u).filter(Boolean).map((part) => Number(part));
  return parts.length > 0 ? parts : [0];
}

function compareVersions(left: string, right: string): number {
  const a = versionKey(left);
  const b = versionKey(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function normalizeSharedDep(value: unknown, owner: string): SharedDep {
  if (typeof value === "string") return { id: value, minVersion: "0.0.0" };
  if (isRecord(value) && typeof value.id === "string") {
    const rawMinVersion = typeof value.minVersion === "string"
      ? value.minVersion
      : typeof value.min_version === "string"
        ? value.min_version
        : "0.0.0";
    return { id: value.id, minVersion: rawMinVersion };
  }
  throw new Error(`Bad sharedDeps entry for ${owner}`);
}

function requiredSharedLibsForPlugins(
  plugins: Map<string, PlugManifestPlugin>,
  installed: string[],
): SharedDep[] {
  const merged = new Map<string, string>();
  for (const id of installed) {
    const plugin = plugins.get(id);
    if (!plugin) continue;
    for (const rawDep of plugin.sharedDeps ?? []) {
      const dep = normalizeSharedDep(rawDep, id);
      if (dep.id !== "zz-lib") throw new Error(`Unsupported shared dependency for ${id}: ${dep.id}`);
      const current = merged.get(dep.id);
      if (!current || compareVersions(dep.minVersion, current) > 0) merged.set(dep.id, dep.minVersion);
    }
  }
  return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, minVersion]) => ({ id, minVersion }));
}

function normalizeSelectedPlugins(manifest: PlugManifest, ids: string[]): string[] {
  const visibleIds = visiblePluginIds(manifest);
  return uniq(ids.filter((id) => visibleIds.has(id)));
}

function selectedPluginsFromState(manifest: PlugManifest, state: InstallState): string[] {
  if (Array.isArray(state.selected_plugins)) {
    return normalizeSelectedPlugins(manifest, asStringArray(state.selected_plugins));
  }
  return normalizeSelectedPlugins(manifest, asStringArray(state.installed_plugins));
}

function parsePluginRefs(input: string, manifest: PlugManifest, allowInternal = false): string[] {
  const visible = visiblePlugins(manifest);
  const visibleIds = visible.map((plugin) => plugin.id);
  const plugins = pluginMap(manifest);
  const selected: string[] = [];

  for (const token of splitTokens(input)) {
    const lower = token.toLowerCase();
    if (lower === "all") {
      selected.push(...visibleIds);
      continue;
    }
    if (lower === "none" || lower === "empty") continue;

    let id = token;
    if (/^\d+$/u.test(token)) {
      const index = Number(token);
      if (index < 1 || index > visible.length) throw new Error(`Plugin number out of range: ${token}`);
      id = visible[index - 1]?.id ?? "";
    }

    const plugin = plugins.get(id);
    if (!plugin) throw new Error(`Unknown pi plug: ${id}`);
    if (plugin.internal && !allowInternal) throw new Error(`${id} is internal and cannot be selected directly`);
    selected.push(id);
  }

  return uniq(selected);
}

function resolvePlan(manifest: PlugManifest, selectedInput: string[]): ResolvedPlan {
  const plugins = pluginMap(manifest);
  if (!plugins.has(MANAGER_ID)) throw new Error(`Manifest does not contain required ${MANAGER_ID} plugin`);

  const selected = uniq(selectedInput.filter((id) => id !== MANAGER_ID));
  for (const id of selected) {
    const plugin = plugins.get(id);
    if (!plugin) throw new Error(`Unknown pi plug: ${id}`);
    if (plugin.internal) throw new Error(`${id} is internal and cannot be selected directly`);
  }

  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string): void {
    const plugin = plugins.get(id);
    if (!plugin) throw new Error(`Unknown pi plug dependency: ${id}`);
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Plug dependency cycle involving ${id}`);
    visiting.add(id);
    for (const dep of plugin.pluginDeps ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }

  visit(MANAGER_ID);
  for (const id of selected) visit(id);
  const installed = [MANAGER_ID, ...ordered.filter((id) => id !== MANAGER_ID)];
  const selectedSet = new Set(selected);
  const autoRequired = installed.filter((id) => id !== MANAGER_ID && !selectedSet.has(id));
  const ownedFiles: Record<string, string[]> = {};
  const configFiles = new Set<string>();

  function addOwner(path: string, owner: string): void {
    const rel = cleanRelPath(path);
    ownedFiles[rel] ??= [];
    if (!ownedFiles[rel]?.includes(owner)) ownedFiles[rel]?.push(owner);
  }

  for (const path of manifest.commonFiles ?? []) addOwner(path, "__common__");
  for (const id of installed) {
    const plugin = plugins.get(id);
    if (!plugin) continue;
    addOwner(plugin.entry, id);
    for (const path of plugin.fileDeps ?? []) addOwner(path, id);
    for (const path of plugin.configFiles ?? []) {
      const rel = cleanRelPath(path);
      configFiles.add(rel);
      addOwner(rel, id);
    }
  }

  const requiredSharedLibs = requiredSharedLibsForPlugins(plugins, installed);
  return { selected, installed, autoRequired, requiredSharedLibs, ownedFiles, configFiles };
}

async function loadState(cwd: string): Promise<InstallState> {
  const path = resolve(cwd, STATE_FILE);
  const record = await readJson(path);
  return (record ?? {}) as InstallState;
}

function oldOwnedSet(state: InstallState): Set<string> {
  if (isRecord(state.owned_files)) return new Set(Object.keys(state.owned_files));
  return new Set((state.files ?? []).map((file) => cleanRelPath(file.path)).filter(Boolean));
}

function oldConfigSet(state: InstallState, oldOwned: Set<string>): Set<string> {
  if (Array.isArray(state.config_files)) return new Set(state.config_files.map(cleanRelPath));
  return new Set([...oldOwned].filter((path) => path.endsWith(".config.jsonc")));
}

async function loadZzLibManifest(zzLibUrl: string, signal?: AbortSignal): Promise<SharedLibManifest> {
  const manifest = await fetchJson<SharedLibManifest>(`${zzLibUrl.replace(/\/+$/u, "")}/manifest.json`, signal);
  if (!Array.isArray(manifest.commonFiles) || !Array.isArray(manifest.files)) {
    throw new Error("Bad zz-lib manifest: missing commonFiles/files arrays");
  }
  return manifest;
}

function sharedLibVersion(manifest: SharedLibManifest): string {
  return manifest.sharedLib?.version ?? manifest.zzLibVersion ?? "0.0.0";
}

async function ensureZzLib(
  cwd: string,
  zzLibUrl: string,
  dep: SharedDep,
  force: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const manifest = await loadZzLibManifest(zzLibUrl, signal);
  const libId = manifest.sharedLib?.id ?? "zz-lib";
  if (libId !== "zz-lib") throw new Error(`Bad zz-lib manifest: sharedLib.id is ${libId}`);
  const libVersion = sharedLibVersion(manifest);
  if (compareVersions(libVersion, dep.minVersion) < 0) {
    throw new Error(`zz-lib ${libVersion} from ${zzLibUrl} is older than required ${dep.minVersion}`);
  }

  const commonFiles = manifest.commonFiles.map(cleanRelPath);
  if (commonFiles.length === 0) throw new Error("Bad zz-lib manifest: commonFiles is empty");
  const files = new Map(manifest.files.map((file) => [cleanRelPath(file.path), file]));
  for (const rel of commonFiles) {
    if (!files.has(rel)) throw new Error(`zz-lib manifest is missing required file: ${rel}`);
  }

  const piDir = resolve(cwd, ".pi");
  const statePath = resolve(cwd, ZZ_LIB_STATE_FILE);
  const oldState = await readJson(statePath);
  const oldOwnedRaw = oldState?.owned_files;
  const oldOwned = isRecord(oldOwnedRaw) ? new Set(Object.keys(oldOwnedRaw)) : new Set<string>();

  const collisions: string[] = [];
  for (const rel of [...commonFiles].sort()) {
    const target = safeTarget(piDir, rel);
    if ((await fileExists(target)) && !oldOwned.has(rel) && !force) collisions.push(rel);
  }
  if (collisions.length > 0) {
    throw new Error(
      `Refusing to overwrite existing unowned zz-lib files:\n  - ${collisions.join("\n  - ")}\nUse --force if you want zz-lib to claim them.`,
    );
  }

  await mkdir(piDir, { recursive: true });
  for (const rel of [...commonFiles].sort()) {
    const info = files.get(rel);
    if (!info) throw new Error(`zz-lib manifest is missing required file: ${rel}`);
    const buffer = await fetchFile(zzLibUrl, rel, info.sha256, signal);
    const target = safeTarget(piDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer);
  }

  const fileHashes: Record<string, string> = {};
  for (const rel of [...commonFiles].sort()) {
    const target = safeTarget(piDir, rel);
    if (await fileExists(target)) fileHashes[rel] = await hashFile(target);
  }
  const state = {
    installer: "zz-lib",
    schemaVersion: 1,
    zzLibVersion: libVersion,
    manifest_updated_at: manifest.updated_at,
    source: manifest.source,
    bundle_url: zzLibUrl,
    owned_files: Object.fromEntries([...commonFiles].sort().map((rel) => [rel, ["zz-lib"]])),
    file_hashes: fileHashes,
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return `zz-lib ${dep.minVersion} (${commonFiles.length} files)`;
}

async function ensureSharedLibs(
  cwd: string,
  zzLibUrl: string,
  deps: SharedDep[],
  force: boolean,
  signal?: AbortSignal,
): Promise<string[]> {
  const ensured: string[] = [];
  for (const dep of deps) {
    if (dep.id !== "zz-lib") throw new Error(`Unsupported shared dependency: ${dep.id}`);
    ensured.push(await ensureZzLib(cwd, zzLibUrl, dep, force, signal));
  }
  return ensured;
}

const CODEX_OBSOLETE_AGENT_REL = ".codex/agents/readsubagent.toml";
const CODEX_SKILL_REL = ".codex/skills/readsubagent/SKILL.md";
const CODEX_CONFIG_REL = ".codex/config.toml";
const CODEX_MANIFEST_REL = ".codex/zz-codex-readsubagent-manifest.json";
const CLAUDE_OBSOLETE_AGENT_REL = ".claude/agents/readsubagent.md";
const CLAUDE_HOOK_NUDGE_SH_REL = ".claude/hooks/readsubagent-nudge.sh";
const CLAUDE_HOOK_BLOCK_EXPLORE_SH_REL = ".claude/hooks/block-explore-subagent.sh";
const CLAUDE_HOOK_NUDGE_PS1_REL = ".claude/hooks/readsubagent-nudge.ps1";
const CLAUDE_HOOK_BLOCK_EXPLORE_PS1_REL = ".claude/hooks/block-explore-subagent.ps1";
const CLAUDE_SKILL_REL = ".claude/skills/readsubagent/SKILL.md";
const CLAUDE_SETTINGS_REL = ".claude/settings.json";
const CLAUDE_MANIFEST_REL = ".claude/zz-claude-readsubagent-manifest.json";
const COPILOT_OBSOLETE_AGENT_REL = ".github/agents/readsubagent.agent.md";
const COPILOT_SKILL_REL = ".github/skills/readsubagent/SKILL.md";
const COPILOT_HOOK_CONFIG_REL = ".github/hooks/zz-readsubagent.json";
const COPILOT_HOOK_NUDGE_SH_REL = ".github/hooks/readsubagent-nudge.sh";
const COPILOT_HOOK_NUDGE_PS1_REL = ".github/hooks/readsubagent-nudge.ps1";
const COPILOT_HOOK_BLOCK_SH_REL = ".github/hooks/block-explore-subagent.sh";
const COPILOT_HOOK_BLOCK_PS1_REL = ".github/hooks/block-explore-subagent.ps1";
const COPILOT_MANIFEST_REL = ".github/zz-copilot-readsubagent-manifest.json";
const COPILOT_NATIVE_AGENTS_MANIFEST_REL = ".github/zz-copilot-native-agents-manifest.json";
const COPILOT_NATIVE_AGENT_PAYLOADS = [
  [".github/agents/zz-debugger.agent.md", "agents/zz-debugger.agent.md"],
  [".github/agents/zz-implementer.agent.md", "agents/zz-implementer.agent.md"],
  [".github/agents/zz-vetter.agent.md", "agents/zz-vetter.agent.md"],
] as const;
const RETIRED_COPILOT_NATIVE_AGENT_TARGETS = [
  ".github/agents/zz-brainstormer.agent.md",
  ".github/agents/zz-designplanner.agent.md",
] as const;
const COPILOT_IMPLEMENTER_HOOK_REL = ".github/hooks/zz-implementer.json";
const COPILOT_IMPLEMENTER_VERIFIER_REL = ".github/hooks/scripts/verify-implementer.py";
const MCP_ONLY_MANIFEST_REL = ".zz-mcp/zz-readsubagent-mcp-manifest.json";
const READSUBAGENT_SERVER_REL = ".zz-mcp/zz-readsubagent-mcp.py";
const SERVER_NAME = "zz_readsubagent";
const SERVER_ARGS_PATH = ".zz-mcp/zz-readsubagent-mcp.py";
const DEFAULT_LOCAL_PROVIDER_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_LOCAL_MODEL_SELECTOR = "lm-studio/qwen/qwen3.6-35b-a3b";

const CODEX_AGENTS_START = "<!-- zz-codex-readsubagent:start -->";
const CODEX_AGENTS_END = "<!-- zz-codex-readsubagent:end -->";
const CLAUDE_GUIDANCE_START = "<!-- zz-claude-readsubagent:start -->";
const CLAUDE_GUIDANCE_END = "<!-- zz-claude-readsubagent:end -->";
const COPILOT_GUIDANCE_START = "<!-- zz-copilot-readsubagent:start -->";
const COPILOT_GUIDANCE_END = "<!-- zz-copilot-readsubagent:end -->";
const COPILOT_NATIVE_AGENTS_START = "<!-- zz-copilot-agents:start -->";
const COPILOT_NATIVE_AGENTS_END = "<!-- zz-copilot-agents:end -->";
const CODEX_PROVIDER_START = "# zz-codex-readsubagent:start";
const CODEX_PROVIDER_END = "# zz-codex-readsubagent:end";
const CODEX_MCP_START = "# zz-codex-readsubagent-mcp:start";
const CODEX_MCP_END = "# zz-codex-readsubagent-mcp:end";

const CODEX_AGENTS_BLOCK = `${CODEX_AGENTS_START}
## Read Planning

Task context is the first gate, before file type or factuality. Do not use
\`readsubagent\` while debugging, diagnosing a failure, investigating a regression
or flaky test, handling an incident, or investigating unexpected runtime
behavior.

During those tasks, the main agent or debugger inspects source, configuration,
documentation, and diagnostic evidence directly. Do not ask \`readsubagent\` to
scout a debug path, suggest evidence, summarize evidence, or gather root-cause
facts. Diagnostic evidence includes logs, stack traces, crash reports, core
dumps, test failure output, traces, profiler output, runtime captures,
screenshots produced for diagnosis, and similar artifacts.

Outside debugging, use the repo-local \`readsubagent\` skill before focused reads
of unfamiliar repository areas. It calls the direct MCP tool registered in
\`.codex/config.toml\`; do not launch another Codex subagent. Focused ordinary
code, configuration, or documentation facts also remain supported.

Ask for a short subsystem map, candidate files, search/symbol/line anchors, the
smallest focused read list, avoid-for-now areas, and uncertainty. Pass a targeted
factual \`question\` plus \`path\`/\`paths\`, \`symbols\`, \`searchTerms\`, \`lineRanges\`,
\`output\`, and a small \`maxReportChars\` where useful. Ask one narrower follow-up
before broadening. Use at least a ten-minute wait when an explicit timeout is
available.

Do not ask \`readsubagent\` for review, bug finding, correctness or safety
judgments, design, edit strategies, implementation plans, or accept/reject
decisions. A tiny user-requested self-health smoke check may verify that
\`readsubagent\` responds, but it does not permit inspection of application
debugging evidence.

Outside debugging, skip the scout when exact files and lines are already known,
the user requests a direct read, the context is already present, or the tool is
unavailable. Otherwise, if the repository area is unfamiliar or the read path
is ambiguous, ask \`readsubagent\` for a focused read plan before exploratory
manual reads.
${CODEX_AGENTS_END}`;

const CLAUDE_GUIDANCE_BLOCK = `${CLAUDE_GUIDANCE_START}
## Read Planning

Task context is the first gate, before file type or factuality. Do not use
\`readsubagent\` while debugging, diagnosing a failure, investigating a regression
or flaky test, handling an incident, or investigating unexpected runtime
behavior.

During those tasks, the main agent or debugger inspects source, configuration,
documentation, and diagnostic evidence directly. Do not ask \`readsubagent\` to
scout a debug path, suggest evidence, summarize evidence, or gather root-cause
facts. Diagnostic evidence includes logs, stack traces, crash reports, core
dumps, test failure output, traces, profiler output, runtime captures,
screenshots produced for diagnosis, and similar artifacts.

Outside debugging, use the **\`readsubagent\` skill** before focused reads of
unfamiliar repository areas. It calls the direct MCP tool
\`mcp__zz_readsubagent__readsubagent\`, served by
\`.zz-mcp/zz-readsubagent-mcp.py\`; do not launch another Claude subagent. Focused
ordinary code, configuration, or documentation facts also remain supported.

Ask for a short subsystem map, candidate files, search/symbol/line anchors, the
smallest focused read list, avoid-for-now areas, and uncertainty. Pass a targeted
factual \`question\` plus \`path\`/\`paths\`, \`symbols\`, \`searchTerms\`, \`lineRanges\`,
\`output\`, and a small \`maxReportChars\` where useful. The local model can be slow;
allow a long wait and ask one narrower follow-up before broadening.

Do not ask \`readsubagent\` for review, bug finding, correctness or safety
judgments, design, edit strategies, implementation plans, or accept/reject
decisions. A tiny user-requested self-health smoke check may verify that
\`readsubagent\` responds, but it does not permit inspection of application
debugging evidence.
${CLAUDE_GUIDANCE_END}`;

const COPILOT_GUIDANCE_BLOCK = `${COPILOT_GUIDANCE_START}
## Read Planning

Task context is the first gate, before file type or factuality. Do not use
\`readsubagent\` while debugging, diagnosing a failure, investigating a regression
or flaky test, handling an incident, or investigating unexpected runtime
behavior.

During those tasks, the main agent or debugger inspects source, configuration,
documentation, and diagnostic evidence directly. Do not ask \`readsubagent\` to
scout a debug path, suggest evidence, summarize evidence, or gather root-cause
facts. Diagnostic evidence includes logs, stack traces, crash reports, core
dumps, test failure output, traces, profiler output, runtime captures,
screenshots produced for diagnosis, and similar artifacts.

Outside debugging, use the \`readsubagent\` skill before focused reads of
unfamiliar repository areas. It calls the direct
\`zz_readsubagent/readsubagent\` MCP tool; do not launch another Copilot custom
agent. Focused ordinary code, configuration, or documentation facts also remain
supported.

Ask for a short subsystem map, candidate files, search/symbol/line anchors, the
smallest focused read list, avoid-for-now areas, and uncertainty. Pass a targeted
factual \`question\` plus \`path\`/\`paths\`, \`symbols\`, \`searchTerms\`, \`lineRanges\`,
\`output\`, and a small \`maxReportChars\` where useful. The local model can be slow;
allow a long wait and ask one narrower follow-up before broadening.

Do not ask \`readsubagent\` for review, bug finding, correctness or safety
judgments, design, edit strategies, implementation plans, or accept/reject
decisions. A tiny user-requested self-health smoke check may verify that
\`readsubagent\` responds, but it does not permit inspection of application
debugging evidence.
${COPILOT_GUIDANCE_END}`;

interface HarnessDefaults {
  readonly modelSelector: string;
  readonly providerUrl: string;
}

interface ManagedAction {
  readonly action: string;
  readonly managed: boolean;
}

function harnessManifestRel(id: HarnessIntegrationId): string {
  if (id === "codex-readsubagent") return CODEX_MANIFEST_REL;
  if (id === "claude-readsubagent") return CLAUDE_MANIFEST_REL;
  if (id === "copilot-readsubagent") return COPILOT_MANIFEST_REL;
  return COPILOT_NATIVE_AGENTS_MANIFEST_REL;
}

function siblingUrl(sourceUrl: string, siblingPath: string): string {
  const trimmed = sourceUrl.replace(/\/+$/u, "");
  try {
    const url = new URL(trimmed);
    const parent = url.pathname.replace(/\/+$/u, "").replace(/\/[^/]*$/u, "");
    url.pathname = `${parent}/${siblingPath}`.replace(/\/+/gu, "/");
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return trimmed.replace(/\/[^/]*$/u, `/${siblingPath}`);
  }
}

function joinUrl(base: string, rel: string): string {
  return `${base.replace(/\/+$/u, "")}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

async function fetchUrlBytes(url: string, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

function asOpenAiBaseUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/u, "");
  if (trimmed.endsWith("/v1/chat/completions")) return trimmed.slice(0, -"/chat/completions".length);
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

function firstModelId(record: JsonRecord): string | undefined {
  const models = record.models;
  if (!Array.isArray(models)) return undefined;
  for (const model of models) {
    if (!isPlainRecord(model)) continue;
    const id = asString(model.id);
    if (id?.trim()) return id.trim();
  }
  return undefined;
}

async function readHarnessDefaults(cwd: string): Promise<HarnessDefaults> {
  let provider = "lm-studio";
  let model = "qwen/qwen3.6-35b-a3b";
  let endpoint: string | undefined;

  const zzLocalModels = await readJson(resolve(cwd, ".pi", "extensions", "zzLocalModels.config.jsonc"));
  if (zzLocalModels) {
    provider = asString(zzLocalModels.provider)?.trim() || provider;
    model = firstModelId(zzLocalModels) ?? model;
    endpoint = asString(zzLocalModels.endpoint) ?? asString(zzLocalModels.baseUrl) ?? asString(zzLocalModels.url);
  }

  if (!endpoint) {
    const endpoints = await readJson(resolve(cwd, ".pi", "extensions", "local-model-endpoints.config.jsonc"));
    if (endpoints) {
      const active = (asString(endpoints.active) ?? "remoteLocal").trim().toLowerCase();
      endpoint = ["truelocal", "true-local", "true_local", "localhost", "loopback"].includes(active)
        ? asString(endpoints.trueLocalEndpoint) ?? asString(endpoints.localEndpoint)
        : asString(endpoints.remoteLocalEndpoint) ??
          asString(endpoints.lanEndpoint) ??
          asString(endpoints.localNetworkEndpoint) ??
          asString(endpoints.remoteEndpoint);
    }
  }

  return {
    modelSelector: `${provider}/${model}`,
    providerUrl: endpoint ? asOpenAiBaseUrl(endpoint) : DEFAULT_LOCAL_PROVIDER_URL,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceMarkedBlock(text: string, start: string, end: string, block: string): { replaced: boolean; text: string } {
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "u");
  if (pattern.test(text)) return { replaced: true, text: text.replace(pattern, block.trimEnd()) };
  return { replaced: false, text: `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${block.trimEnd()}` };
}

function removeMarkedBlock(text: string, start: string, end: string): { removed: boolean; text: string } {
  const pattern = new RegExp(`\\n*${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n*`, "u");
  if (!pattern.test(text)) return { removed: false, text };
  const next = text.replace(pattern, "\n\n").replace(/\n{3,}/gu, "\n\n").trimEnd();
  return { removed: true, text: next ? `${next}\n` : "" };
}

function manifestOwns(manifest: JsonRecord | undefined, rel: string): boolean {
  const owned = manifest?.owned_files;
  return Array.isArray(owned) && owned.includes(rel);
}

function manifestOwnedFiles(manifest: JsonRecord | undefined): string[] {
  const owned = manifest?.owned_files;
  return Array.isArray(owned) ? owned.filter((item): item is string => typeof item === "string") : [];
}

function manifestManagedBlocks(manifest: JsonRecord | undefined): string[] {
  const blocks = manifest?.managed_blocks;
  return Array.isArray(blocks) ? blocks.filter((item): item is string => typeof item === "string") : [];
}

function manifestManagedServers(manifest: JsonRecord | undefined): string[] {
  const servers = manifest?.managed_servers;
  return Array.isArray(servers) ? servers.filter((item): item is string => typeof item === "string") : [];
}

function manifestManagedSettings(manifest: JsonRecord | undefined): string[] {
  const settings = manifest?.managed_settings;
  return Array.isArray(settings) ? settings.filter((item): item is string => typeof item === "string") : [];
}

function manifestFileHashes(manifest: JsonRecord | undefined): Record<string, string> {
  const hashes = manifest?.file_hashes;
  if (!isPlainRecord(hashes)) return {};
  return Object.fromEntries(Object.entries(hashes).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function manifestManagedBlockHashes(manifest: JsonRecord | undefined): Record<string, string> {
  const hashes = manifest?.managed_block_hashes;
  if (!isPlainRecord(hashes)) return {};
  return Object.fromEntries(Object.entries(hashes).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function readHarnessManifest(cwd: string, rel: string): Promise<JsonRecord | undefined> {
  return readJson(safeTarget(cwd, rel));
}

function expectedHarnessManifestInstaller(rel: string): string | undefined {
  if (rel === CODEX_MANIFEST_REL) return "zz-codex-readsubagent";
  if (rel === CLAUDE_MANIFEST_REL) return "zz-claude-readsubagent";
  if (rel === COPILOT_MANIFEST_REL) return "zz-copilot-readsubagent";
  if (rel === COPILOT_NATIVE_AGENTS_MANIFEST_REL) return "zz-copilot-native-agents";
  if (rel === MCP_ONLY_MANIFEST_REL) return "zz-readsubagent-mcp";
  return undefined;
}

function allowedHarnessManifestOwnedFiles(rel: string): Set<string> {
  if (rel === CODEX_MANIFEST_REL) return new Set([READSUBAGENT_SERVER_REL, CODEX_SKILL_REL]);
  if (rel === CLAUDE_MANIFEST_REL) {
    return new Set([
      READSUBAGENT_SERVER_REL,
      CLAUDE_HOOK_NUDGE_SH_REL,
      CLAUDE_HOOK_BLOCK_EXPLORE_SH_REL,
      CLAUDE_HOOK_NUDGE_PS1_REL,
      CLAUDE_HOOK_BLOCK_EXPLORE_PS1_REL,
      CLAUDE_SKILL_REL,
    ]);
  }
  if (rel === COPILOT_MANIFEST_REL) {
    return new Set([
      READSUBAGENT_SERVER_REL,
      COPILOT_SKILL_REL,
      COPILOT_HOOK_CONFIG_REL,
      COPILOT_HOOK_NUDGE_SH_REL,
      COPILOT_HOOK_NUDGE_PS1_REL,
      COPILOT_HOOK_BLOCK_SH_REL,
      COPILOT_HOOK_BLOCK_PS1_REL,
    ]);
  }
  if (rel === COPILOT_NATIVE_AGENTS_MANIFEST_REL) {
    return new Set([
      ...COPILOT_NATIVE_AGENT_PAYLOADS.map(([target]) => target),
      ...RETIRED_COPILOT_NATIVE_AGENT_TARGETS,
      COPILOT_IMPLEMENTER_HOOK_REL,
      COPILOT_IMPLEMENTER_VERIFIER_REL,
    ]);
  }
  if (rel === MCP_ONLY_MANIFEST_REL) return new Set([READSUBAGENT_SERVER_REL]);
  return new Set();
}

function allowedHarnessManifestBlocks(rel: string): Set<string> {
  if (rel === CODEX_MANIFEST_REL) {
    return new Set([
      "AGENTS.md:zz-codex-readsubagent",
      ".codex/config.toml:zz-codex-readsubagent-mcp",
      "~/.codex/config.toml:zz-codex-readsubagent",
    ]);
  }
  if (rel === CLAUDE_MANIFEST_REL) return new Set(["CLAUDE.md:zz-claude-readsubagent"]);
  if (rel === COPILOT_MANIFEST_REL) return new Set([".github/copilot-instructions.md:zz-copilot-readsubagent"]);
  if (rel === COPILOT_NATIVE_AGENTS_MANIFEST_REL) return new Set([".github/copilot-instructions.md:zz-copilot-agents"]);
  return new Set();
}

function manifestStringArrayIsSubset(manifest: JsonRecord, key: string, allowed: Set<string>): boolean {
  const value = manifest[key];
  return value === undefined
    || (Array.isArray(value) && value.every((item) => typeof item === "string" && allowed.has(item)));
}

function harnessManifestHasSafeFileClaims(rel: string, manifest: JsonRecord | undefined): boolean {
  const expected = expectedHarnessManifestInstaller(rel);
  if (!expected || manifest?.installer !== expected) return false;
  const owned = allowedHarnessManifestOwnedFiles(rel);
  if (!manifestStringArrayIsSubset(manifest, "owned_files", owned)) return false;
  const hashes = manifest.file_hashes;
  return hashes === undefined || (
    isPlainRecord(hashes)
    && Object.entries(hashes).every(
      ([path, hash]) => owned.has(path) && typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash),
    )
  );
}

function recognizedHarnessManifest(rel: string, manifest: JsonRecord | undefined): JsonRecord | undefined {
  if (!manifest || !harnessManifestHasSafeFileClaims(rel, manifest)) return undefined;
  // Strict non-file claim validation applies to the two Copilot integrations
  // that can be discovered after an interrupted combined install.
  if (rel !== COPILOT_MANIFEST_REL && rel !== COPILOT_NATIVE_AGENTS_MANIFEST_REL) return manifest;
  if (manifest?.schemaVersion !== 1) return undefined;
  const owned = allowedHarnessManifestOwnedFiles(rel);
  const blocks = allowedHarnessManifestBlocks(rel);
  const allowedSettings = rel === CLAUDE_MANIFEST_REL
    ? new Set([`${CLAUDE_SETTINGS_REL}:readsubagent-hooks`])
    : new Set<string>();
  const allowedServers = rel === MCP_ONLY_MANIFEST_REL || rel === COPILOT_NATIVE_AGENTS_MANIFEST_REL
    ? new Set<string>()
    : new Set([SERVER_NAME]);
  if (
    !manifestStringArrayIsSubset(manifest, "managed_blocks", blocks)
    || !manifestStringArrayIsSubset(manifest, "managed_settings", allowedSettings)
    || !manifestStringArrayIsSubset(manifest, "managed_servers", allowedServers)
  ) return undefined;
  const hashes = manifest.file_hashes;
  if (hashes !== undefined && (
    !isPlainRecord(hashes)
    || Object.entries(hashes).some(([path, hash]) => !owned.has(path) || typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash))
  )) return undefined;
  const blockHashes = manifest.managed_block_hashes;
  if (blockHashes !== undefined && (
    !isPlainRecord(blockHashes)
    || Object.entries(blockHashes).some(([key, hash]) => !blocks.has(key) || typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash))
  )) return undefined;
  return manifest;
}

async function knownHarnessManifestOwns(cwd: string, rel: string, exceptManifestRel?: string): Promise<boolean> {
  for (const manifestRel of [
    CODEX_MANIFEST_REL,
    CLAUDE_MANIFEST_REL,
    COPILOT_MANIFEST_REL,
    COPILOT_NATIVE_AGENTS_MANIFEST_REL,
    MCP_ONLY_MANIFEST_REL,
  ]) {
    if (manifestRel === exceptManifestRel) continue;
    const manifest = recognizedHarnessManifest(manifestRel, await readHarnessManifest(cwd, manifestRel));
    if (manifestOwns(manifest, rel)) return true;
  }
  return false;
}

async function owningManifestHashes(cwd: string, rel: string, manifestRel: string, manifest: JsonRecord | undefined): Promise<string[]> {
  const hashes: string[] = [];
  for (const candidateRel of [
    CODEX_MANIFEST_REL,
    CLAUDE_MANIFEST_REL,
    COPILOT_MANIFEST_REL,
    COPILOT_NATIVE_AGENTS_MANIFEST_REL,
    MCP_ONLY_MANIFEST_REL,
  ]) {
    const rawCandidate = candidateRel === manifestRel ? manifest : await readHarnessManifest(cwd, candidateRel);
    const candidate = recognizedHarnessManifest(candidateRel, rawCandidate);
    if (!manifestOwns(candidate, rel)) continue;
    const expected = manifestFileHashes(candidate)[rel];
    if (expected) hashes.push(expected);
  }
  return hashes;
}

async function preflightHarnessFile(
  cwd: string,
  rel: string,
  buffer: Buffer,
  manifest: JsonRecord | undefined,
  manifestRel: string,
  force: boolean,
): Promise<boolean> {
  const target = safeTarget(cwd, rel);
  if (!(await fileExists(target)) || force) return false;
  const current = await readFile(target);
  if (current.equals(buffer)) return true;
  const owned = manifestOwns(recognizedHarnessManifest(manifestRel, manifest), rel)
    || (await knownHarnessManifestOwns(cwd, rel, manifestRel));
  if (!owned) throw new Error(`Refusing to overwrite existing unowned ${rel}. Use --force if you want zz-plugs to claim it.`);
  const expectedHashes = await owningManifestHashes(cwd, rel, manifestRel, manifest);
  if (expectedHashes.length === 0) {
    throw new Error(`Cannot verify ownership baseline for managed ${rel}. Use --force to replace it.`);
  }
  const currentHash = createHash("sha256").update(current).digest("hex");
  if (!expectedHashes.includes(currentHash)) {
    throw new Error(`Refusing to overwrite locally modified managed ${rel}. Use --force to replace it.`);
  }
  return false;
}

async function ensureHarnessFile(
  cwd: string,
  rel: string,
  buffer: Buffer,
  manifest: JsonRecord | undefined,
  manifestRel: string,
  force: boolean,
  executable = false,
): Promise<string> {
  const target = safeTarget(cwd, rel);
  if (await preflightHarnessFile(cwd, rel, buffer, manifest, manifestRel, force)) {
    if (executable) await chmod(target, 0o755);
    return `unchanged existing matching ${rel}`;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer);
  if (executable) await chmod(target, 0o755);
  return `installed ${rel}`;
}

async function preflightTargetParent(cwd: string, rel: string): Promise<void> {
  const root = resolve(cwd);
  let parent = dirname(safeTarget(cwd, rel));
  while (parent !== root) {
    if (await fileExists(parent)) {
      if (!(await stat(parent)).isDirectory()) throw new Error(`Refusing to install ${rel} because ${parent} is not a directory.`);
      return;
    }
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}

async function preflightMarkedBlockFile(cwd: string, rel: string, start: string, end: string): Promise<void> {
  await preflightTargetParent(cwd, rel);
  const target = safeTarget(cwd, rel);
  if (!(await fileExists(target))) return;
  const text = await readFile(target, "utf8");
  const starts = text.split(start).length - 1;
  const ends = text.split(end).length - 1;
  if (starts !== ends || starts > 1) {
    throw new Error(`Refusing to edit ${rel} because the managed readsubagent markers are malformed or duplicated.`);
  }
}

function extractMarkedBlock(text: string, start: string, end: string): string | undefined {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) return undefined;
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (endIndex < 0) return undefined;
  return text.slice(startIndex, endIndex + end.length);
}

async function preflightManagedBlockUpdate(
  cwd: string,
  rel: string,
  start: string,
  end: string,
  desiredBlock: string,
  manifest: JsonRecord | undefined,
  manifestKey: string,
  force: boolean,
): Promise<void> {
  await preflightMarkedBlockFile(cwd, rel, start, end);
  const target = safeTarget(cwd, rel);
  if (!(await fileExists(target)) || force) return;
  const existing = extractMarkedBlock(await readFile(target, "utf8"), start, end);
  if (!existing || existing === desiredBlock) return;
  const expected = manifestManagedBlockHashes(manifest)[manifestKey];
  const actual = createHash("sha256").update(existing).digest("hex");
  if (!expected || actual !== expected) {
    throw new Error(`Refusing to overwrite modified managed block ${manifestKey}. Use --force to replace it.`);
  }
}

async function ensureMarkedBlockFile(
  cwd: string,
  rel: string,
  defaultText: string,
  start: string,
  end: string,
  block: string,
): Promise<string> {
  const target = safeTarget(cwd, rel);
  const existing = (await fileExists(target)) ? await readFile(target, "utf8") : defaultText;
  const result = replaceMarkedBlock(existing, start, end, block);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${result.text.trimEnd()}\n`, "utf8");
  return `${result.replaced ? "updated" : "added"} ${rel} read-planning block`;
}

async function removeMarkedBlockFile(cwd: string, rel: string, start: string, end: string): Promise<string | undefined> {
  const target = safeTarget(cwd, rel);
  if (!(await fileExists(target))) return undefined;
  const result = removeMarkedBlock(await readFile(target, "utf8"), start, end);
  if (!result.removed) return undefined;
  await writeFile(target, result.text, "utf8");
  return `removed ${rel} managed block`;
}

interface ClaudeHookSpec {
  readonly event: "PreToolUse" | "UserPromptSubmit";
  readonly entry: JsonRecord;
  readonly markers: string[];
}

function commandHook(command: string, args?: string[]): JsonRecord {
  const hook: JsonRecord = { type: "command", command, timeout: 5 };
  if (args) hook.args = args;
  return hook;
}

function claudeHookEntry(hook: JsonRecord, matcher?: string): JsonRecord {
  const entry: JsonRecord = { hooks: [hook] };
  if (matcher) entry.matcher = matcher;
  return entry;
}

function claudeHookSpecs(): ClaudeHookSpec[] {
  if (process.platform === "win32") {
    const psArgs = (scriptRel: string, arg?: string): string[] => {
      const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `\${CLAUDE_PROJECT_DIR}/${scriptRel}`];
      if (arg) args.push(arg);
      return args;
    };
    return [
      {
        event: "PreToolUse",
        entry: claudeHookEntry(commandHook("powershell.exe", psArgs(CLAUDE_HOOK_NUDGE_PS1_REL, "nudge")), "Read"),
        markers: ["readsubagent-nudge.ps1", "nudge"],
      },
      {
        event: "PreToolUse",
        entry: claudeHookEntry(commandHook("powershell.exe", psArgs(CLAUDE_HOOK_BLOCK_EXPLORE_PS1_REL)), "Agent|Task"),
        markers: ["block-explore-subagent.ps1"],
      },
      {
        event: "UserPromptSubmit",
        entry: claudeHookEntry(commandHook("powershell.exe", psArgs(CLAUDE_HOOK_NUDGE_PS1_REL, "reset"))),
        markers: ["readsubagent-nudge.ps1", "reset"],
      },
    ];
  }
  return [
    {
      event: "PreToolUse",
      entry: claudeHookEntry(commandHook(`"\${CLAUDE_PROJECT_DIR}/${CLAUDE_HOOK_NUDGE_SH_REL}" nudge`), "Read"),
      markers: ["readsubagent-nudge.sh", "nudge"],
    },
    {
      event: "PreToolUse",
      entry: claudeHookEntry(commandHook(`"\${CLAUDE_PROJECT_DIR}/${CLAUDE_HOOK_BLOCK_EXPLORE_SH_REL}"`), "Agent|Task"),
      markers: ["block-explore-subagent.sh"],
    },
    {
      event: "UserPromptSubmit",
      entry: claudeHookEntry(commandHook(`"\${CLAUDE_PROJECT_DIR}/${CLAUDE_HOOK_NUDGE_SH_REL}" reset`)),
      markers: ["readsubagent-nudge.sh", "reset"],
    },
  ];
}

function entryHasMarkers(entry: unknown, markers: string[]): boolean {
  const text = JSON.stringify(entry) ?? "";
  return markers.every((marker) => text.includes(marker));
}

async function readSettingsJson(cwd: string): Promise<JsonRecord> {
  const target = safeTarget(cwd, CLAUDE_SETTINGS_REL);
  if (!(await fileExists(target))) return {};
  const parsed = JSON.parse(stripJsonc(await readFile(target, "utf8")));
  if (!isPlainRecord(parsed)) throw new Error(`Refusing to edit ${CLAUDE_SETTINGS_REL} because root is not an object.`);
  return parsed;
}

async function writeSettingsJson(cwd: string, data: JsonRecord): Promise<void> {
  const target = safeTarget(cwd, CLAUDE_SETTINGS_REL);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function ensureClaudeSettingsHooks(cwd: string): Promise<string> {
  const data = await readSettingsJson(cwd);
  const hooks = data.hooks ?? {};
  if (!isPlainRecord(hooks)) throw new Error(`Refusing to edit ${CLAUDE_SETTINGS_REL} because hooks is not an object.`);
  data.hooks = hooks;
  let changed = false;
  for (const spec of claudeHookSpecs()) {
    const existing = hooks[spec.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`Refusing to edit ${CLAUDE_SETTINGS_REL} because hooks.${spec.event} is not a list.`);
    }
    const entries = Array.isArray(existing) ? [...existing] : [];
    if (!entries.some((entry) => entryHasMarkers(entry, spec.markers))) {
      entries.push(spec.entry);
      changed = true;
    }
    hooks[spec.event] = entries;
  }
  await writeSettingsJson(cwd, data);
  return changed ? `merged readsubagent hooks into ${CLAUDE_SETTINGS_REL}` : `readsubagent hooks already present in ${CLAUDE_SETTINGS_REL}`;
}

function entryHasReadsubagentHook(entry: unknown): boolean {
  const text = JSON.stringify(entry) ?? "";
  return ["readsubagent-nudge.sh", "block-explore-subagent.sh", "readsubagent-nudge.ps1", "block-explore-subagent.ps1"].some((marker) =>
    text.includes(marker),
  );
}

async function removeClaudeSettingsHooks(cwd: string): Promise<string | undefined> {
  const target = safeTarget(cwd, CLAUDE_SETTINGS_REL);
  if (!(await fileExists(target))) return undefined;
  const data = await readSettingsJson(cwd);
  const hooks = data.hooks;
  if (!isPlainRecord(hooks)) return undefined;
  let removed = false;
  for (const event of ["PreToolUse", "UserPromptSubmit"] as const) {
    const existing = hooks[event];
    if (!Array.isArray(existing)) continue;
    const next = existing.filter((entry) => !entryHasReadsubagentHook(entry));
    if (next.length !== existing.length) {
      removed = true;
      if (next.length) hooks[event] = next;
      else delete hooks[event];
    }
  }
  if (!removed) return undefined;
  if (Object.keys(hooks).length === 0) delete data.hooks;
  if (Object.keys(data).length === 0) await unlink(target);
  else await writeSettingsJson(cwd, data);
  return `removed readsubagent hooks from ${CLAUDE_SETTINGS_REL}`;
}

function codexConfigPath(manifest?: JsonRecord): string {
  const provider = manifest?.provider;
  if (isPlainRecord(provider) && typeof provider.config_path === "string") return provider.config_path;
  const codexDir = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : resolve(homedir(), ".codex");
  return resolve(codexDir, "config.toml");
}

async function removeCodexProvider(manifest: JsonRecord | undefined): Promise<string | undefined> {
  const target = codexConfigPath(manifest);
  if (!(await fileExists(target))) return undefined;
  const result = removeMarkedBlock(await readFile(target, "utf8"), CODEX_PROVIDER_START, CODEX_PROVIDER_END);
  if (!result.removed) return undefined;
  await writeFile(target, result.text, "utf8");
  return `removed zz_lmstudio_read provider block from ${target}`;
}

function codexMcpBlock(model: string, piBin: string): string {
  const env = [`ZZ_READSUBAGENT_MODEL = ${JSON.stringify(model)}`];
  if (piBin !== "pi") env.push(`ZZ_READSUBAGENT_PI_BIN = ${JSON.stringify(piBin)}`);
  return `${CODEX_MCP_START}
[mcp_servers.readsubagent]
command = "python3"
args = ["${READSUBAGENT_SERVER_REL}"]
cwd = "."
enabled = true
required = false
startup_timeout_sec = 10
tool_timeout_sec = 1800
enabled_tools = ["readsubagent"]
env = { ${env.join(", ")} }
${CODEX_MCP_END}`;
}

async function ensureCodexMcpConfig(cwd: string, force: boolean, model: string, piBin: string): Promise<ManagedAction> {
  const target = safeTarget(cwd, CODEX_CONFIG_REL);
  const existing = (await fileExists(target)) ? await readFile(target, "utf8") : "";
  const block = codexMcpBlock(model, piBin);
  if (existing.includes(CODEX_MCP_START) && existing.includes(CODEX_MCP_END)) {
    const result = replaceMarkedBlock(existing, CODEX_MCP_START, CODEX_MCP_END, block);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${result.text.trimEnd()}\n`, "utf8");
    return { action: `updated ${CODEX_CONFIG_REL} MCP registration`, managed: true };
  }
  if (/^\[mcp_servers\.readsubagent\]\s*$/mu.test(existing) && !force) {
    return { action: `preserved existing unmanaged readsubagent MCP server in ${CODEX_CONFIG_REL}`, managed: false };
  }
  const result = replaceMarkedBlock(existing, CODEX_MCP_START, CODEX_MCP_END, block);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${result.text.trimEnd()}\n`, "utf8");
  return { action: `added readsubagent MCP server to ${CODEX_CONFIG_REL}`, managed: true };
}

async function removeCodexMcpConfig(cwd: string): Promise<string | undefined> {
  const target = safeTarget(cwd, CODEX_CONFIG_REL);
  if (!(await fileExists(target))) return undefined;
  const result = removeMarkedBlock(await readFile(target, "utf8"), CODEX_MCP_START, CODEX_MCP_END);
  if (!result.removed) return undefined;
  await writeFile(target, result.text, "utf8");
  return `removed readsubagent MCP server block from ${CODEX_CONFIG_REL}`;
}

function serverEntry(model: string, piBin: string, entryType: "stdio" | "local" = "stdio"): JsonRecord {
  const env: JsonRecord = { ZZ_READSUBAGENT_MODEL: model };
  if (piBin !== "pi") env.ZZ_READSUBAGENT_PI_BIN = piBin;
  const entry: JsonRecord = {
    type: entryType,
    command: "python3",
    args: [SERVER_ARGS_PATH],
    env,
  };
  if (entryType === "local") entry.tools = ["readsubagent"];
  return entry;
}

async function readJsonObjectForEdit(path: string, label: string): Promise<JsonRecord> {
  if (!(await fileExists(path))) return {};
  return parseJsoncRecord(await readFile(path, "utf8"), label);
}

async function preflightMcpServer(
  cwd: string,
  rel: string,
  topKey: "mcpServers" | "servers",
  manifest: JsonRecord | undefined,
  force: boolean,
  entryType: "stdio" | "local" = "stdio",
): Promise<{ data: JsonRecord; servers: JsonRecord; managed: boolean }> {
  const target = safeTarget(cwd, rel);
  const data = await readJsonObjectForEdit(target, rel);
  const currentServers = data[topKey];
  if (currentServers !== undefined && !isPlainRecord(currentServers)) {
    throw new Error(`Refusing to edit ${rel} because ${topKey} is not an object.`);
  }
  const servers = isPlainRecord(currentServers) ? currentServers : {};
  const existingPresent = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  const managed = manifestManagedServers(manifest).includes(SERVER_NAME);
  if (managed && !force) {
    const priorServer = manifest?.server;
    if (!isPlainRecord(priorServer) || typeof priorServer.model !== "string") {
      throw new Error(`Cannot verify legacy ownership of ${SERVER_NAME} in ${rel}. Use --force to replace it.`);
    }
    const priorPiBin = typeof priorServer.pi_bin === "string" ? priorServer.pi_bin : "pi";
    if (!existingPresent || JSON.stringify(servers[SERVER_NAME]) !== JSON.stringify(serverEntry(priorServer.model, priorPiBin, entryType))) {
      throw new Error(`Refusing to overwrite locally modified managed ${SERVER_NAME} server in ${rel}. Use --force to replace it.`);
    }
  }
  return { data, servers, managed };
}

async function ensureMcpServer(
  cwd: string,
  rel: string,
  topKey: "mcpServers" | "servers",
  model: string,
  piBin: string,
  manifest: JsonRecord | undefined,
  force: boolean,
  entryType: "stdio" | "local" = "stdio",
): Promise<ManagedAction> {
  const target = safeTarget(cwd, rel);
  const { data, servers, managed } = await preflightMcpServer(cwd, rel, topKey, manifest, force, entryType);
  const existingPresent = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  if (existingPresent && !managed && !force) {
    return { action: `preserved existing unmanaged ${SERVER_NAME} server in ${rel}`, managed: false };
  }
  servers[SERVER_NAME] = serverEntry(model, piBin, entryType);
  data[topKey] = servers;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { action: `registered ${SERVER_NAME} server in ${rel}`, managed: true };
}

async function managedMcpServerMatches(
  cwd: string,
  rel: string,
  topKey: "mcpServers" | "servers",
  manifest: JsonRecord | undefined,
  entryType: "stdio" | "local" = "stdio",
): Promise<boolean> {
  const prior = manifest?.server;
  if (!isPlainRecord(prior) || typeof prior.model !== "string") return false;
  const piBin = typeof prior.pi_bin === "string" ? prior.pi_bin : "pi";
  const data = await readJsonObjectForEdit(safeTarget(cwd, rel), rel);
  const servers = data[topKey];
  return isPlainRecord(servers) && JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(serverEntry(prior.model, piBin, entryType));
}

async function removeMcpServer(cwd: string, rel: string, topKey: "mcpServers" | "servers"): Promise<string | undefined> {
  const target = safeTarget(cwd, rel);
  if (!(await fileExists(target))) return undefined;
  const data = await readJsonObjectForEdit(target, rel);
  const servers = data[topKey];
  if (!isPlainRecord(servers) || !isPlainRecord(servers[SERVER_NAME])) return undefined;
  delete servers[SERVER_NAME];
  if (Object.keys(servers).length === 0) delete data[topKey];
  else data[topKey] = servers;
  if (Object.keys(data).length === 0) await unlink(target);
  else await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return `removed ${SERVER_NAME} server from ${rel}`;
}

async function preflightHarnessManifest(
  cwd: string,
  rel: string,
  manifest: JsonRecord | undefined,
  force: boolean,
): Promise<void> {
  const target = safeTarget(cwd, rel);
  if (!(await fileExists(target)) || force) return;
  if (!recognizedHarnessManifest(rel, manifest)) {
    throw new Error(`Refusing to overwrite unrecognized harness manifest ${rel}. Use --force to replace it.`);
  }
}

async function writeHarnessManifest(cwd: string, rel: string, state: JsonRecord): Promise<void> {
  const target = safeTarget(cwd, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function hashExistingHarnessFiles(cwd: string, rels: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const rel of rels) {
    const target = safeTarget(cwd, rel);
    if (await fileExists(target)) hashes[rel] = await hashFile(target);
  }
  return hashes;
}

async function installCodexIntegration(cwd: string, sourceUrl: string, options: ApplyOptions, signal?: AbortSignal): Promise<string[]> {
  const sourceBase = siblingUrl(sourceUrl, "codex-readsubagent");
  const mcpBase = siblingUrl(sourceUrl, "zz-readsubagent-mcp");
  const manifest = await readHarnessManifest(cwd, CODEX_MANIFEST_REL);
  const defaults = await readHarnessDefaults(cwd);
  const model = process.env.ZZ_CODEX_READSUBAGENT_MODEL || defaults.modelSelector || DEFAULT_LOCAL_MODEL_SELECTOR;
  const piBin = process.env.ZZ_CODEX_READSUBAGENT_PI_BIN || "pi";
  const skipMcp = truthy(process.env.ZZ_CODEX_READSUBAGENT_SKIP_MCP);
  const skipAgentsMd = truthy(process.env.ZZ_CODEX_READSUBAGENT_SKIP_AGENTS_MD);
  const skipSkill = truthy(process.env.ZZ_CODEX_READSUBAGENT_SKIP_SKILL);

  if (options.dryRun) {
    return [
      `would retire ${CODEX_OBSOLETE_AGENT_REL} and its dedicated provider if managed`,
      skipSkill ? "would skip Codex readsubagent skill" : `would install/update ${CODEX_SKILL_REL}`,
      skipMcp ? "would skip repo-local Codex MCP server" : `would install/update ${READSUBAGENT_SERVER_REL} and ${CODEX_CONFIG_REL}`,
      skipAgentsMd ? "would skip AGENTS.md guidance" : "would add/update AGENTS.md guidance",
    ];
  }

  const actions: string[] = [];
  if (manifestOwnedFiles(manifest).includes(CODEX_OBSOLETE_AGENT_REL)) {
    const retired = await removeOwnedHarnessFile(cwd, CODEX_OBSOLETE_AGENT_REL, manifest, CODEX_MANIFEST_REL, options);
    if (retired) actions.push(retired);
  }
  const providerRetired = await removeCodexProvider(manifest);
  if (providerRetired) actions.push(providerRetired);

  const ownedFiles = new Set(manifestOwnedFiles(manifest));
  ownedFiles.delete(CODEX_OBSOLETE_AGENT_REL);
  ownedFiles.delete(CODEX_CONFIG_REL);
  if (skipSkill) actions.push("skipped Codex readsubagent skill");
  else {
    const skill = await fetchUrlBytes(joinUrl(sourceBase, "skills/readsubagent/SKILL.md"), signal);
    actions.push(await ensureHarnessFile(cwd, CODEX_SKILL_REL, skill, manifest, CODEX_MANIFEST_REL, options.force));
    ownedFiles.add(CODEX_SKILL_REL);
  }

  let mcpManaged = false;
  if (skipMcp) actions.push("skipped repo-local Codex MCP server");
  else {
    const server = await fetchUrlBytes(joinUrl(mcpBase, "zz-readsubagent-mcp.py"), signal);
    actions.push(await ensureHarnessFile(cwd, READSUBAGENT_SERVER_REL, server, manifest, CODEX_MANIFEST_REL, options.force));
    const config = await ensureCodexMcpConfig(cwd, options.force, model, piBin);
    mcpManaged = config.managed;
    actions.push(config.action);
    ownedFiles.add(READSUBAGENT_SERVER_REL);
  }

  if (skipAgentsMd) actions.push("skipped AGENTS.md guidance");
  else actions.push(await ensureMarkedBlockFile(cwd, "AGENTS.md", "# Codex Guidance\n", CODEX_AGENTS_START, CODEX_AGENTS_END, CODEX_AGENTS_BLOCK));

  const existingOwnedFiles: string[] = [];
  for (const rel of [...ownedFiles].sort()) if (await fileExists(safeTarget(cwd, rel))) existingOwnedFiles.push(rel);
  const priorBlocks = new Set(manifestManagedBlocks(manifest));
  priorBlocks.delete("~/.codex/config.toml:zz-codex-readsubagent");
  if (!skipAgentsMd) priorBlocks.add("AGENTS.md:zz-codex-readsubagent");
  if (!skipMcp && mcpManaged) priorBlocks.add(".codex/config.toml:zz-codex-readsubagent-mcp");

  await writeHarnessManifest(cwd, CODEX_MANIFEST_REL, {
    installer: "zz-codex-readsubagent",
    schemaVersion: 2,
    source_url: sourceBase,
    mcp_source_url: mcpBase,
    owned_files: existingOwnedFiles,
    managed_blocks: [...priorBlocks].sort(),
    file_hashes: await hashExistingHarnessFiles(cwd, existingOwnedFiles),
    mcp_server: {
      name: "readsubagent",
      config_path: safeTarget(cwd, CODEX_CONFIG_REL),
      server_path: READSUBAGENT_SERVER_REL,
      model,
      pi_bin: piBin,
      managed: priorBlocks.has(".codex/config.toml:zz-codex-readsubagent-mcp"),
    },
  });
  return actions;
}

async function installClaudeIntegration(cwd: string, sourceUrl: string, options: ApplyOptions, signal?: AbortSignal): Promise<string[]> {
  const sourceBase = siblingUrl(sourceUrl, "claude-readsubagent");
  const mcpBase = siblingUrl(sourceUrl, "zz-readsubagent-mcp");
  const manifest = await readHarnessManifest(cwd, CLAUDE_MANIFEST_REL);
  const defaults = await readHarnessDefaults(cwd);
  const model = process.env.ZZ_CLAUDE_READSUBAGENT_MODEL || defaults.modelSelector || DEFAULT_LOCAL_MODEL_SELECTOR;
  const piBin = process.env.ZZ_CLAUDE_READSUBAGENT_PI_BIN || "pi";
  const skipMcp = truthy(process.env.ZZ_CLAUDE_READSUBAGENT_SKIP_MCP);
  const skipClaudeMd = truthy(process.env.ZZ_CLAUDE_READSUBAGENT_SKIP_CLAUDE_MD);
  const skipHooks = truthy(process.env.ZZ_CLAUDE_READSUBAGENT_SKIP_HOOKS);
  const skipSkill = truthy(process.env.ZZ_CLAUDE_READSUBAGENT_SKIP_SKILL);

  if (options.dryRun) {
    return [
      `would retire ${CLAUDE_OBSOLETE_AGENT_REL} if it is still managed`,
      `would install/update ${READSUBAGENT_SERVER_REL}`,
      skipHooks ? "would skip Claude readsubagent hooks" : `would install/update Claude hooks and merge ${CLAUDE_SETTINGS_REL}`,
      skipSkill ? "would skip Claude readsubagent skill" : `would install/update ${CLAUDE_SKILL_REL}`,
      skipMcp ? "would skip .mcp.json registration" : `would register ${SERVER_NAME} in .mcp.json using ${model}`,
      skipClaudeMd ? "would skip CLAUDE.md guidance" : "would add/update CLAUDE.md guidance",
    ];
  }

  const actions: string[] = [];
  const server = await fetchUrlBytes(joinUrl(mcpBase, "zz-readsubagent-mcp.py"), signal);
  if (manifestOwnedFiles(manifest).includes(CLAUDE_OBSOLETE_AGENT_REL)) {
    const retired = await removeOwnedHarnessFile(cwd, CLAUDE_OBSOLETE_AGENT_REL, manifest, CLAUDE_MANIFEST_REL, options);
    if (retired) actions.push(retired);
  }
  actions.push(await ensureHarnessFile(cwd, READSUBAGENT_SERVER_REL, server, manifest, CLAUDE_MANIFEST_REL, options.force));

  const ownedFiles = [READSUBAGENT_SERVER_REL];
  if (skipHooks) actions.push("skipped Claude readsubagent hook files");
  else {
    const hookNudgeSh = await fetchUrlBytes(joinUrl(sourceBase, "hooks/readsubagent-nudge.sh"), signal);
    const hookBlockExploreSh = await fetchUrlBytes(joinUrl(sourceBase, "hooks/block-explore-subagent.sh"), signal);
    const hookNudgePs1 = await fetchUrlBytes(joinUrl(sourceBase, "hooks/readsubagent-nudge.ps1"), signal);
    const hookBlockExplorePs1 = await fetchUrlBytes(joinUrl(sourceBase, "hooks/block-explore-subagent.ps1"), signal);
    actions.push(await ensureHarnessFile(cwd, CLAUDE_HOOK_NUDGE_SH_REL, hookNudgeSh, manifest, CLAUDE_MANIFEST_REL, options.force, true));
    actions.push(await ensureHarnessFile(cwd, CLAUDE_HOOK_BLOCK_EXPLORE_SH_REL, hookBlockExploreSh, manifest, CLAUDE_MANIFEST_REL, options.force, true));
    actions.push(await ensureHarnessFile(cwd, CLAUDE_HOOK_NUDGE_PS1_REL, hookNudgePs1, manifest, CLAUDE_MANIFEST_REL, options.force));
    actions.push(await ensureHarnessFile(cwd, CLAUDE_HOOK_BLOCK_EXPLORE_PS1_REL, hookBlockExplorePs1, manifest, CLAUDE_MANIFEST_REL, options.force));
    actions.push(await ensureClaudeSettingsHooks(cwd));
    ownedFiles.push(CLAUDE_HOOK_NUDGE_SH_REL, CLAUDE_HOOK_BLOCK_EXPLORE_SH_REL, CLAUDE_HOOK_NUDGE_PS1_REL, CLAUDE_HOOK_BLOCK_EXPLORE_PS1_REL);
  }

  if (skipSkill) actions.push("skipped Claude readsubagent skill");
  else {
    const skill = await fetchUrlBytes(joinUrl(sourceBase, "skills/readsubagent/SKILL.md"), signal);
    actions.push(await ensureHarnessFile(cwd, CLAUDE_SKILL_REL, skill, manifest, CLAUDE_MANIFEST_REL, options.force));
    ownedFiles.push(CLAUDE_SKILL_REL);
  }

  let serverManaged = false;
  if (skipMcp) actions.push("skipped .mcp.json registration");
  else {
    const registration = await ensureMcpServer(cwd, ".mcp.json", "mcpServers", model, piBin, manifest, options.force);
    serverManaged = registration.managed;
    actions.push(registration.action);
  }

  if (skipClaudeMd) actions.push("skipped CLAUDE.md guidance");
  else actions.push(await ensureMarkedBlockFile(cwd, "CLAUDE.md", "# Project Guidance\n", CLAUDE_GUIDANCE_START, CLAUDE_GUIDANCE_END, CLAUDE_GUIDANCE_BLOCK));

  await writeHarnessManifest(cwd, CLAUDE_MANIFEST_REL, {
    installer: "zz-claude-readsubagent",
    schemaVersion: 1,
    source_url: sourceBase,
    mcp_source_url: mcpBase,
    owned_files: ownedFiles,
    managed_blocks: skipClaudeMd ? [] : ["CLAUDE.md:zz-claude-readsubagent"],
    managed_settings: skipHooks ? [] : [`${CLAUDE_SETTINGS_REL}:readsubagent-hooks`],
    managed_servers: serverManaged ? [SERVER_NAME] : [],
    file_hashes: await hashExistingHarnessFiles(cwd, ownedFiles),
    server: { name: SERVER_NAME, model, pi_bin: piBin, config_path: safeTarget(cwd, ".mcp.json"), managed: serverManaged },
  });
  return actions;
}

async function installCopilotIntegration(cwd: string, sourceUrl: string, options: ApplyOptions, signal?: AbortSignal): Promise<string[]> {
  const sourceBase = siblingUrl(sourceUrl, "copilot-readsubagent");
  const mcpBase = siblingUrl(sourceUrl, "zz-readsubagent-mcp");
  const manifest = await readHarnessManifest(cwd, COPILOT_MANIFEST_REL);
  const defaults = await readHarnessDefaults(cwd);
  const model = process.env.ZZ_COPILOT_READSUBAGENT_MODEL || defaults.modelSelector || DEFAULT_LOCAL_MODEL_SELECTOR;
  const piBin = process.env.ZZ_COPILOT_READSUBAGENT_PI_BIN || "pi";
  const skipMcp = truthy(process.env.ZZ_COPILOT_READSUBAGENT_SKIP_MCP);
  const skipInstructions = truthy(process.env.ZZ_COPILOT_READSUBAGENT_SKIP_INSTRUCTIONS);
  const skipSkill = truthy(process.env.ZZ_COPILOT_READSUBAGENT_SKIP_SKILL);
  const skipHooks = truthy(process.env.ZZ_COPILOT_READSUBAGENT_SKIP_HOOKS);

  if (options.dryRun) {
    return [
      `would retire ${COPILOT_OBSOLETE_AGENT_REL} if it is still managed`,
      `would install/update ${READSUBAGENT_SERVER_REL}`,
      skipSkill ? "would skip Copilot readsubagent skill" : `would install/update ${COPILOT_SKILL_REL}`,
      skipHooks ? "would skip Copilot CLI hooks" : `would install/update ${COPILOT_HOOK_CONFIG_REL} and hook scripts`,
      skipMcp ? "would skip .mcp.json registration" : `would register ${SERVER_NAME} in .mcp.json using ${model}`,
      skipInstructions ? "would skip Copilot instructions" : "would add/update .github/copilot-instructions.md guidance",
    ];
  }

  const server = await fetchUrlBytes(joinUrl(mcpBase, "zz-readsubagent-mcp.py"), signal);
  const skill = skipSkill ? undefined : await fetchUrlBytes(joinUrl(sourceBase, "skills/readsubagent/SKILL.md"), signal);
  const hookPayloads = skipHooks
    ? []
    : await Promise.all([
        [COPILOT_HOOK_CONFIG_REL, "hooks/zz-readsubagent.json", false] as const,
        [COPILOT_HOOK_NUDGE_SH_REL, "hooks/readsubagent-nudge.sh", true] as const,
        [COPILOT_HOOK_NUDGE_PS1_REL, "hooks/readsubagent-nudge.ps1", false] as const,
        [COPILOT_HOOK_BLOCK_SH_REL, "hooks/block-explore-subagent.sh", true] as const,
        [COPILOT_HOOK_BLOCK_PS1_REL, "hooks/block-explore-subagent.ps1", false] as const,
      ].map(async ([rel, source, executable]) => ({ rel, executable, buffer: await fetchUrlBytes(joinUrl(sourceBase, source), signal) })));

  // Preflight every payload and configuration destination before the first write.
  await preflightHarnessFile(cwd, READSUBAGENT_SERVER_REL, server, manifest, COPILOT_MANIFEST_REL, options.force);
  if (skill) await preflightHarnessFile(cwd, COPILOT_SKILL_REL, skill, manifest, COPILOT_MANIFEST_REL, options.force);
  for (const hook of hookPayloads) await preflightHarnessFile(cwd, hook.rel, hook.buffer, manifest, COPILOT_MANIFEST_REL, options.force);
  for (const rel of [READSUBAGENT_SERVER_REL, COPILOT_MANIFEST_REL]) await preflightTargetParent(cwd, rel);
  if (skill) await preflightTargetParent(cwd, COPILOT_SKILL_REL);
  for (const hook of hookPayloads) await preflightTargetParent(cwd, hook.rel);
  if (!skipMcp) {
    await preflightTargetParent(cwd, ".mcp.json");
    await preflightMcpServer(cwd, ".mcp.json", "mcpServers", manifest, options.force, "local");
  }
  if (!skipInstructions) {
    await preflightMarkedBlockFile(cwd, ".github/copilot-instructions.md", COPILOT_GUIDANCE_START, COPILOT_GUIDANCE_END);
  }

  const actions: string[] = [];
  if (manifestOwnedFiles(manifest).includes(COPILOT_OBSOLETE_AGENT_REL)) {
    const retired = await removeOwnedHarnessFile(cwd, COPILOT_OBSOLETE_AGENT_REL, manifest, COPILOT_MANIFEST_REL, options);
    if (retired) actions.push(retired);
  }
  actions.push(await ensureHarnessFile(cwd, READSUBAGENT_SERVER_REL, server, manifest, COPILOT_MANIFEST_REL, options.force));
  if (skipSkill) actions.push("skipped Copilot readsubagent skill");
  else if (skill) actions.push(await ensureHarnessFile(cwd, COPILOT_SKILL_REL, skill, manifest, COPILOT_MANIFEST_REL, options.force));
  if (skipHooks) actions.push("skipped Copilot CLI readsubagent hooks");
  else for (const hook of hookPayloads) {
    actions.push(await ensureHarnessFile(cwd, hook.rel, hook.buffer, manifest, COPILOT_MANIFEST_REL, options.force, hook.executable));
  }

  let serverManaged = false;
  if (skipMcp) actions.push("skipped .mcp.json registration");
  else {
    const registration = await ensureMcpServer(cwd, ".mcp.json", "mcpServers", model, piBin, manifest, options.force, "local");
    serverManaged = registration.managed;
    actions.push(registration.action);
  }

  if (skipInstructions) actions.push("skipped .github/copilot-instructions.md guidance");
  else {
    actions.push(
      await ensureMarkedBlockFile(
        cwd,
        ".github/copilot-instructions.md",
        "# Copilot Instructions\n",
        COPILOT_GUIDANCE_START,
        COPILOT_GUIDANCE_END,
        COPILOT_GUIDANCE_BLOCK,
      ),
    );
  }

  const ownedFiles = new Set(manifestOwnedFiles(manifest));
  ownedFiles.delete(COPILOT_OBSOLETE_AGENT_REL);
  ownedFiles.add(READSUBAGENT_SERVER_REL);
  if (!skipSkill) ownedFiles.add(COPILOT_SKILL_REL);
  if (!skipHooks) for (const hook of hookPayloads) ownedFiles.add(hook.rel);
  const existingOwnedFiles: string[] = [];
  for (const rel of [...ownedFiles].sort()) if (await fileExists(safeTarget(cwd, rel))) existingOwnedFiles.push(rel);
  const managedBlocks = skipInstructions
    ? manifestManagedBlocks(manifest)
    : [".github/copilot-instructions.md:zz-copilot-readsubagent"];
  const managedServers = skipMcp ? manifestManagedServers(manifest) : serverManaged ? [SERVER_NAME] : [];
  const priorServer = isPlainRecord(manifest?.server) ? manifest.server : undefined;
  const serverModel = skipMcp && typeof priorServer?.model === "string" ? priorServer.model : model;
  const serverPiBin = skipMcp && typeof priorServer?.pi_bin === "string" ? priorServer.pi_bin : piBin;
  const serverConfigPath =
    skipMcp && typeof priorServer?.config_path === "string" ? priorServer.config_path : safeTarget(cwd, ".mcp.json");
  const fileHashes: Record<string, string> = { ...manifestFileHashes(manifest) };
  for (const rel of [
    READSUBAGENT_SERVER_REL,
    ...(skipSkill ? [] : [COPILOT_SKILL_REL]),
    ...hookPayloads.map((hook) => hook.rel),
  ]) fileHashes[rel] = await hashFile(safeTarget(cwd, rel));
  const existingOwnedSet = new Set(existingOwnedFiles);
  for (const rel of Object.keys(fileHashes)) if (!existingOwnedSet.has(rel)) delete fileHashes[rel];

  await writeHarnessManifest(cwd, COPILOT_MANIFEST_REL, {
    installer: "zz-copilot-readsubagent",
    schemaVersion: 1,
    source_url: sourceBase,
    mcp_source_url: mcpBase,
    owned_files: existingOwnedFiles,
    managed_blocks: managedBlocks,
    managed_servers: managedServers,
    file_hashes: fileHashes,
    server: {
      name: SERVER_NAME,
      model: serverModel,
      pi_bin: serverPiBin,
      config_path: serverConfigPath,
      managed: managedServers.includes(SERVER_NAME),
    },
  });
  return actions;
}

async function installCopilotNativeAgentsIntegration(
  cwd: string,
  sourceUrl: string,
  options: ApplyOptions,
  signal?: AbortSignal,
): Promise<string[]> {
  const sourceBase = siblingUrl(sourceUrl, "copilot-native-agents");
  const manifest = await readHarnessManifest(cwd, COPILOT_NATIVE_AGENTS_MANIFEST_REL);
  const managedBlockKey = ".github/copilot-instructions.md:zz-copilot-agents";
  const fileSpecs = [
    ...COPILOT_NATIVE_AGENT_PAYLOADS.map(([rel, source]) => ({ rel, source, executable: false })),
    { rel: COPILOT_IMPLEMENTER_HOOK_REL, source: "hooks/zz-implementer.json", executable: false },
    { rel: COPILOT_IMPLEMENTER_VERIFIER_REL, source: "hooks/scripts/verify-implementer.py", executable: false },
  ];

  if (options.dryRun) {
    return [
      `would install/update ${COPILOT_NATIVE_AGENT_PAYLOADS.length} native Copilot workflow agents`,
      `would install/update ${COPILOT_IMPLEMENTER_HOOK_REL} and verifier`,
      "would add/update .github/copilot-instructions.md workflow guidance",
    ];
  }

  const payloads = await Promise.all(
    fileSpecs.map(async (spec) => ({
      ...spec,
      buffer: await fetchUrlBytes(joinUrl(sourceBase, spec.source), signal),
    })),
  );
  const guidanceBuffer = await fetchUrlBytes(joinUrl(sourceBase, "copilot-instructions.md"), signal);
  const guidance = guidanceBuffer.toString("utf8").trim();
  if (
    !guidance.startsWith(COPILOT_NATIVE_AGENTS_START)
    || !guidance.endsWith(COPILOT_NATIVE_AGENTS_END)
    || guidance.split(COPILOT_NATIVE_AGENTS_START).length !== 2
    || guidance.split(COPILOT_NATIVE_AGENTS_END).length !== 2
  ) {
    throw new Error("Bad copilot-native-agents guidance payload: expected one complete managed block");
  }

  // Preflight every payload and the shared instructions file before the first write.
  await preflightHarnessManifest(
    cwd,
    COPILOT_NATIVE_AGENTS_MANIFEST_REL,
    manifest,
    options.force,
  );
  for (const payload of payloads) {
    await preflightHarnessFile(
      cwd,
      payload.rel,
      payload.buffer,
      manifest,
      COPILOT_NATIVE_AGENTS_MANIFEST_REL,
      options.force,
    );
    await preflightTargetParent(cwd, payload.rel);
  }
  await preflightTargetParent(cwd, COPILOT_NATIVE_AGENTS_MANIFEST_REL);
  await preflightTargetParent(cwd, ".github/copilot-instructions.md");
  await preflightManagedBlockUpdate(
    cwd,
    ".github/copilot-instructions.md",
    COPILOT_NATIVE_AGENTS_START,
    COPILOT_NATIVE_AGENTS_END,
    guidance,
    manifest,
    managedBlockKey,
    options.force,
  );

  const actions: string[] = [];
  const retainedRetiredFiles: string[] = [];
  const previousHashes = manifestFileHashes(manifest);
  const previousOwnedFiles = new Set(manifestOwnedFiles(manifest));
  for (const rel of RETIRED_COPILOT_NATIVE_AGENT_TARGETS) {
    if (!previousOwnedFiles.has(rel)) continue;
    const action = await removeOwnedHarnessFile(
      cwd,
      rel,
      manifest,
      COPILOT_NATIVE_AGENTS_MANIFEST_REL,
      options,
    );
    if (action) actions.push(action);
    if (await fileExists(safeTarget(cwd, rel))) retainedRetiredFiles.push(rel);
  }

  for (const payload of payloads) {
    actions.push(
      await ensureHarnessFile(
        cwd,
        payload.rel,
        payload.buffer,
        manifest,
        COPILOT_NATIVE_AGENTS_MANIFEST_REL,
        options.force,
        payload.executable,
      ),
    );
  }
  actions.push(
    await ensureMarkedBlockFile(
      cwd,
      ".github/copilot-instructions.md",
      "# Copilot Instructions\n",
      COPILOT_NATIVE_AGENTS_START,
      COPILOT_NATIVE_AGENTS_END,
      guidance,
    ),
  );

  const ownedFiles = [...payloads.map((payload) => payload.rel), ...retainedRetiredFiles].sort();
  const fileHashes = await hashExistingHarnessFiles(cwd, payloads.map((payload) => payload.rel));
  for (const rel of retainedRetiredFiles) {
    const previousHash = previousHashes[rel];
    if (previousHash) fileHashes[rel] = previousHash;
  }
  await writeHarnessManifest(cwd, COPILOT_NATIVE_AGENTS_MANIFEST_REL, {
    installer: "zz-copilot-native-agents",
    schemaVersion: 1,
    source_url: sourceBase,
    owned_files: ownedFiles,
    managed_blocks: [managedBlockKey],
    managed_block_hashes: {
      [managedBlockKey]: createHash("sha256").update(guidance).digest("hex"),
    },
    managed_servers: [],
    file_hashes: fileHashes,
  });
  return actions;
}

async function installHarnessIntegration(
  cwd: string,
  sourceUrl: string,
  id: HarnessIntegrationId,
  options: ApplyOptions,
  signal?: AbortSignal,
): Promise<string[]> {
  if (id === "codex-readsubagent") return installCodexIntegration(cwd, sourceUrl, options, signal);
  if (id === "claude-readsubagent") return installClaudeIntegration(cwd, sourceUrl, options, signal);
  if (id === "copilot-readsubagent") return installCopilotIntegration(cwd, sourceUrl, options, signal);
  return installCopilotNativeAgentsIntegration(cwd, sourceUrl, options, signal);
}

async function removeOwnedHarnessFile(
  cwd: string,
  rel: string,
  manifest: JsonRecord | undefined,
  manifestRel: string,
  options: ApplyOptions,
): Promise<string | undefined> {
  const target = safeTarget(cwd, rel);
  if (!(await fileExists(target))) return undefined;
  if (await knownHarnessManifestOwns(cwd, rel, manifestRel)) return `kept ${rel} because another harness integration owns it`;
  if (options.dryRun) return `would remove ${rel}`;
  const previousHash = manifestFileHashes(manifest)[rel];
  if (!options.force && !previousHash) return `kept ${rel} because its ownership baseline is missing`;
  if (!options.force && (await hashFile(target)) !== previousHash) return `kept modified ${rel}`;
  await unlink(target);
  return `removed ${rel}`;
}

async function removeHarnessIntegration(cwd: string, id: HarnessIntegrationId, options: ApplyOptions): Promise<string[]> {
  const manifestRel = harnessManifestRel(id);
  const manifestPath = safeTarget(cwd, manifestRel);
  const rawManifest = await readHarnessManifest(cwd, manifestRel);
  if (!rawManifest) {
    if (await fileExists(manifestPath)) {
      throw new Error(`Refusing to remove ${id}: ${manifestRel} is malformed or unrecognized.`);
    }
    return options.dryRun ? [`would remove ${id} if installed`] : [];
  }
  const manifest = recognizedHarnessManifest(manifestRel, rawManifest);
  if (!manifest) {
    throw new Error(`Refusing to remove ${id}: ${manifestRel} has an unexpected installer or unsupported ownership claims.`);
  }

  const actions: string[] = [];
  let unresolvedManagedBlock = false;
  for (const rel of manifestOwnedFiles(manifest)) {
    const action = await removeOwnedHarnessFile(cwd, rel, manifest, manifestRel, options);
    if (action) actions.push(action);
  }

  if (id === "codex-readsubagent") {
    if (manifestManagedBlocks(manifest).includes("AGENTS.md:zz-codex-readsubagent")) {
      if (options.dryRun) actions.push("would remove AGENTS.md guidance block");
      else {
        const action = await removeMarkedBlockFile(cwd, "AGENTS.md", CODEX_AGENTS_START, CODEX_AGENTS_END);
        if (action) actions.push(action);
      }
    }
    if (manifestManagedBlocks(manifest).includes(".codex/config.toml:zz-codex-readsubagent-mcp")) {
      if (options.dryRun) actions.push("would remove .codex/config.toml MCP registration");
      else {
        const action = await removeCodexMcpConfig(cwd);
        if (action) actions.push(action);
      }
    }
    if (manifestManagedBlocks(manifest).includes("~/.codex/config.toml:zz-codex-readsubagent")) {
      if (options.dryRun) actions.push("would remove Codex provider block");
      else {
        const action = await removeCodexProvider(manifest);
        if (action) actions.push(action);
      }
    }
  }

  if (id === "claude-readsubagent") {
    if (manifestManagedServers(manifest).includes(SERVER_NAME)) {
      if (options.dryRun) actions.push(`would remove ${SERVER_NAME} from .mcp.json`);
      else {
        const action = await removeMcpServer(cwd, ".mcp.json", "mcpServers");
        if (action) actions.push(action);
      }
    }
    if (manifestManagedBlocks(manifest).includes("CLAUDE.md:zz-claude-readsubagent")) {
      if (options.dryRun) actions.push("would remove CLAUDE.md guidance block");
      else {
        const action = await removeMarkedBlockFile(cwd, "CLAUDE.md", CLAUDE_GUIDANCE_START, CLAUDE_GUIDANCE_END);
        if (action) actions.push(action);
      }
    }
    if (manifestManagedSettings(manifest).includes(`${CLAUDE_SETTINGS_REL}:readsubagent-hooks`)) {
      if (options.dryRun) actions.push("would remove readsubagent hooks from .claude/settings.json");
      else {
        const action = await removeClaudeSettingsHooks(cwd);
        if (action) actions.push(action);
      }
    }
  }

  if (id === "copilot-readsubagent") {
    if (manifestManagedServers(manifest).includes(SERVER_NAME)) {
      const unchanged = options.force || (await managedMcpServerMatches(cwd, ".mcp.json", "mcpServers", manifest, "local"));
      if (!unchanged) actions.push(`kept modified ${SERVER_NAME} server in .mcp.json`);
      else if (options.dryRun) actions.push(`would remove ${SERVER_NAME} from .mcp.json`);
      else {
        const action = await removeMcpServer(cwd, ".mcp.json", "mcpServers");
        if (action) actions.push(action);
      }
    }
    if (manifestManagedBlocks(manifest).includes(".github/copilot-instructions.md:zz-copilot-readsubagent")) {
      const instructionsPath = safeTarget(cwd, ".github/copilot-instructions.md");
      const instructions = (await fileExists(instructionsPath)) ? await readFile(instructionsPath, "utf8") : "";
      const block = extractMarkedBlock(instructions, COPILOT_GUIDANCE_START, COPILOT_GUIDANCE_END);
      const unchanged = options.force || instructions.includes(COPILOT_GUIDANCE_BLOCK);
      if (!block && instructions) unresolvedManagedBlock = true;
      else if (!unchanged) {
        unresolvedManagedBlock = true;
        actions.push("kept modified Copilot instructions block");
      }
      else if (options.dryRun) actions.push("would remove Copilot instructions block");
      else {
        const action = await removeMarkedBlockFile(cwd, ".github/copilot-instructions.md", COPILOT_GUIDANCE_START, COPILOT_GUIDANCE_END);
        if (action) actions.push(action);
      }
    }
  }

  if (id === "copilot-native-agents") {
    const managedBlockKey = ".github/copilot-instructions.md:zz-copilot-agents";
    if (manifestManagedBlocks(manifest).includes(managedBlockKey)) {
      const instructionsPath = safeTarget(cwd, ".github/copilot-instructions.md");
      const instructions = (await fileExists(instructionsPath)) ? await readFile(instructionsPath, "utf8") : "";
      const block = extractMarkedBlock(instructions, COPILOT_NATIVE_AGENTS_START, COPILOT_NATIVE_AGENTS_END);
      const expected = manifestManagedBlockHashes(manifest)[managedBlockKey];
      const unchanged = Boolean(
        options.force
        || (block && expected && createHash("sha256").update(block).digest("hex") === expected),
      );
      if (!block && instructions) unresolvedManagedBlock = true;
      else if (block && !unchanged) {
        unresolvedManagedBlock = true;
        actions.push("kept modified Copilot native-agents instructions block");
      }
      else if (block && options.dryRun) actions.push("would remove Copilot native-agents instructions block");
      else if (block) {
        const action = await removeMarkedBlockFile(
          cwd,
          ".github/copilot-instructions.md",
          COPILOT_NATIVE_AGENTS_START,
          COPILOT_NATIVE_AGENTS_END,
        );
        if (action) actions.push(action);
      }
    }
  }

  let retainedManagedArtifacts = unresolvedManagedBlock;
  for (const rel of manifestOwnedFiles(manifest)) {
    if (!(await fileExists(safeTarget(cwd, rel)))) continue;
    if (!(await knownHarnessManifestOwns(cwd, rel, manifestRel))) {
      retainedManagedArtifacts = true;
      break;
    }
  }
  if (id === "copilot-native-agents") {
    const instructionsPath = safeTarget(cwd, ".github/copilot-instructions.md");
    if (await fileExists(instructionsPath)) {
      const instructions = await readFile(instructionsPath, "utf8");
      if (extractMarkedBlock(instructions, COPILOT_NATIVE_AGENTS_START, COPILOT_NATIVE_AGENTS_END)) {
        retainedManagedArtifacts = true;
      }
    }
  }
  if (id === "copilot-readsubagent") {
    const instructionsPath = safeTarget(cwd, ".github/copilot-instructions.md");
    if (await fileExists(instructionsPath)) {
      const instructions = await readFile(instructionsPath, "utf8");
      if (extractMarkedBlock(instructions, COPILOT_GUIDANCE_START, COPILOT_GUIDANCE_END)) {
        retainedManagedArtifacts = true;
      }
    }
    const mcpPath = safeTarget(cwd, ".mcp.json");
    const mcp = await readJson(mcpPath);
    const servers = mcp?.mcpServers;
    if (
      manifestManagedServers(manifest).includes(SERVER_NAME)
      && isPlainRecord(servers)
      && isPlainRecord(servers[SERVER_NAME])
    ) retainedManagedArtifacts = true;
  }

  if (retainedManagedArtifacts) actions.push(`kept ${manifestRel} because managed artifacts remain`);
  else if (options.dryRun) actions.push(`would remove ${manifestRel}`);
  else {
    if (await fileExists(manifestPath)) await unlink(manifestPath);
    actions.push(`removed ${manifestRel}`);
    for (const dir of [".codex", ".claude", ".github", ".zz-mcp"]) {
      await removeEmptyDirs(safeTarget(cwd, dir));
    }
  }
  return actions;
}

async function applyHarnessIntegrations(
  cwd: string,
  sourceUrl: string,
  state: InstallState,
  plan: ResolvedPlan,
  options: ApplyOptions,
  signal?: AbortSignal,
): Promise<string[]> {
  const previousSelected = asStringArray(state.selected_plugins).filter(isHarnessIntegrationId);
  const previousInstalled = asStringArray(state.installed_plugins).filter(isHarnessIntegrationId);
  const manifestInstalled: HarnessIntegrationId[] = [];
  for (const id of ["copilot-readsubagent", "copilot-native-agents"] as const) {
    const manifestRel = harnessManifestRel(id);
    const manifestPath = safeTarget(cwd, manifestRel);
    const rawManifest = await readHarnessManifest(cwd, manifestRel);
    if (!rawManifest) {
      if (await fileExists(manifestPath)) {
        throw new Error(`Refusing harness recovery: ${manifestRel} is malformed or unrecognized.`);
      }
      continue;
    }
    if (!recognizedHarnessManifest(manifestRel, rawManifest)) {
      throw new Error(`Refusing harness recovery: ${manifestRel} has an unexpected installer or unsupported ownership claims.`);
    }
    manifestInstalled.push(id);
  }
  const previous = uniq([...previousSelected, ...previousInstalled, ...manifestInstalled]);
  const next = plan.installed.filter(isHarnessIntegrationId);
  const nextSet = new Set(next);
  const actions: string[] = [];

  for (const id of previous) {
    if (nextSet.has(id)) continue;
    for (const action of await removeHarnessIntegration(cwd, id, options)) actions.push(`${id}: ${action}`);
  }
  for (const id of next) {
    for (const action of await installHarnessIntegration(cwd, sourceUrl, id, options, signal)) actions.push(`${id}: ${action}`);
  }
  return actions;
}

async function removeEmptyDirs(root: string): Promise<void> {
  if (!existsSync(root)) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await removeEmptyDirs(resolve(root, entry.name));
  }
  try {
    await rm(root, { recursive: false });
  } catch {
    // Directory was not empty or cannot be removed; harmless.
  }
}

async function applySelection(
  cwd: string,
  sourceUrl: string,
  zzLibUrl: string,
  manifest: PlugManifest,
  selected: string[],
  options: ApplyOptions,
  signal?: AbortSignal,
): Promise<ApplyResult> {
  const plan = resolvePlan(manifest, selected);
  const piDir = resolve(cwd, ".pi");
  const state = await loadState(cwd);
  const oldOwned = oldOwnedSet(state);
  const previousConfigs = oldConfigSet(state, oldOwned);
  const newOwned = new Set(Object.keys(plan.ownedFiles));
  const files = new Map(manifest.files.map((file) => [cleanRelPath(file.path), file]));

  for (const rel of newOwned) {
    if (!files.has(rel)) throw new Error(`Manifest is missing required file: ${rel}`);
  }

  const collisions: string[] = [];
  for (const rel of [...newOwned].sort()) {
    const target = safeTarget(piDir, rel);
    if ((await fileExists(target)) && !oldOwned.has(rel) && !options.force) collisions.push(rel);
  }
  if (collisions.length > 0) {
    throw new Error(
      `Refusing to overwrite existing unowned .pi files:\n  - ${collisions.join("\n  - ")}\nUse --force if you want zz-plugs to claim them.`,
    );
  }

  if (options.dryRun) {
    const harnessActions = await applyHarnessIntegrations(cwd, sourceUrl, state, plan, options, signal);
    return { ensuredSharedLibs: [], harnessActions, mergedConfigs: [], plan, preservedConfigs: [], removed: [], warnings: [] };
  }

  const ensuredSharedLibs = await ensureSharedLibs(cwd, zzLibUrl, plan.requiredSharedLibs, options.force, signal);

  const removed: string[] = [];
  const warnings: string[] = [];
  const preservedConfigs: string[] = [];
  const mergedConfigs: string[] = [];
  await mkdir(piDir, { recursive: true });

  for (const rel of [...oldOwned].filter((rel) => !newOwned.has(rel)).sort().reverse()) {
    const target = safeTarget(piDir, rel);
    if (!(await fileExists(target))) continue;
    if (previousConfigs.has(rel)) {
      warnings.push(`kept config from removed plug for manual cleanup: ${rel}`);
      preservedConfigs.push(rel);
      continue;
    }
    await unlink(target);
    removed.push(rel);
  }

  await removeEmptyDirs(resolve(piDir, "extensions"));

  for (const rel of [...newOwned].sort()) {
    const target = safeTarget(piDir, rel);
    const info = files.get(rel);
    if (!info) throw new Error(`Manifest is missing required file: ${rel}`);
    await mkdir(dirname(target), { recursive: true });
    if (plan.configFiles.has(rel) && (await fileExists(target)) && !options.resetConfig) {
      const buffer = await fetchFile(sourceUrl, rel, info.sha256, signal);
      try {
        if (await mergeConfigFile(target, buffer.toString("utf8"), rel)) mergedConfigs.push(rel);
        else preservedConfigs.push(rel);
      } catch (error) {
        warnings.push(`preserved config without merging ${rel}: ${error instanceof Error ? error.message : String(error)}`);
        preservedConfigs.push(rel);
      }
      continue;
    }
    const buffer = await fetchFile(sourceUrl, rel, info.sha256, signal);
    await writeFile(target, buffer);
  }

  const harnessActions = await applyHarnessIntegrations(cwd, sourceUrl, state, plan, options, signal);

  const fileHashes: Record<string, string> = {};
  for (const rel of [...newOwned].sort()) {
    const target = safeTarget(piDir, rel);
    if (await fileExists(target)) fileHashes[rel] = await hashFile(target);
  }

  const nextState: InstallState = {
    installer: "zz-pi-plugs",
    schemaVersion: 2,
    manifest_updated_at: manifest.updated_at,
    source: manifest.source,
    bundle_url: sourceUrl,
    selected_plugins: plan.selected,
    installed_plugins: plan.installed,
    auto_required_plugins: plan.autoRequired,
    required_shared_libs: plan.requiredSharedLibs,
    owned_files: Object.fromEntries(Object.keys(plan.ownedFiles).sort().map((rel) => [rel, plan.ownedFiles[rel] ?? []])),
    config_files: [...plan.configFiles].sort(),
    file_hashes: fileHashes,
  };
  await writeFile(resolve(cwd, STATE_FILE), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return { ensuredSharedLibs, harnessActions, mergedConfigs, plan, preservedConfigs, removed, warnings };
}

function parseFlags(parts: string[]): { flags: ApplyOptions; values: string[] } {
  const values: string[] = [];
  let reload = true;
  let dryRun = false;
  let force = false;
  let resetConfig = false;

  for (const part of parts) {
    if (part === "--dry-run") dryRun = true;
    else if (part === "--force") force = true;
    else if (part === "--reset-config") resetConfig = true;
    else if (part === "--no-reload") reload = false;
    else values.push(part);
  }

  return { flags: { dryRun, force, resetConfig, reload }, values };
}

function helpText(): string {
  return [
    "zz plug manager",
    "",
    "Commands:",
    "  /zz-plugs list",
    "  /zz-plugs status",
    "  /zz-plugs select [--dry-run] [--no-reload]  Manage catalog and project custom plugs",
    "  /zz-plugs install <id|number|all> [--force] [--reset-config] [--dry-run]",
    "  /zz-plugs remove <id|number|all> [--dry-run]",
    "  /zz-plugs set <id|number|all|none> [--force] [--reset-config] [--dry-run]",
    "  /zz-plugs update [--force] [--reset-config] [--dry-run]",
    "",
    "Selection --dry-run reports catalog and custom plans without mutation; --no-reload applies selection without requesting reload.",
    "Hard dependencies are installed automatically. Existing config files get missing defaults merged in; --reset-config overwrites them.",
    "Codex/Claude/Copilot harness integrations, including Copilot native workflow agents, appear in list/select and install outside .pi with separate manifests.",
  ].join("\n");
}

function listText(manifest: PlugManifest): string {
  const lines = ["Available pi plugs:"];
  visiblePlugins(manifest).forEach((plugin, index) => {
    const deps = plugin.pluginDeps.length > 0 ? ` (requires: ${plugin.pluginDeps.join(", ")})` : "";
    lines.push(`${String(index + 1).padStart(2, " ")}) ${plugin.id.padEnd(24, " ")} ${plugin.title}${deps}`);
    if (plugin.description) lines.push(`    ${plugin.description}`);
  });
  return lines.join("\n");
}

function statusText(state: InstallState, sourceUrl: string): string {
  const selected = state.selected_plugins ?? [];
  const installed = state.installed_plugins ?? [];
  return [
    "zz plug status:",
    `  source:    ${sourceUrl}`,
    `  selected:  ${selected.length > 0 ? selected.join(", ") : "(none)"}`,
    `  installed: ${installed.length > 0 ? installed.join(", ") : "(internal deps only / unknown)"}`,
    `  files:     ${isRecord(state.owned_files) ? Object.keys(state.owned_files).length : 0}`,
    "",
    "Use /zz-plugs list then /zz-plugs install <id> or /zz-plugs select.",
  ].join("\n");
}

function applyResultText(result: ApplyResult, dryRun: boolean, reloadWillRun = !dryRun): string {
  const lines = [dryRun ? "Dry-run zz plug plan:" : "zz plugs updated:"];
  lines.push(`  selected:  ${result.plan.selected.length > 0 ? result.plan.selected.join(", ") : "(none)"}`);
  if (result.plan.autoRequired.length > 0) lines.push(`  auto deps: ${result.plan.autoRequired.join(", ")}`);
  if (result.plan.requiredSharedLibs.length > 0) {
    lines.push(`  shared:   ${result.plan.requiredSharedLibs.map((dep) => `${dep.id}>=${dep.minVersion}`).join(", ")}`);
  }
  if (result.ensuredSharedLibs.length > 0) lines.push(`  shared libs: ${result.ensuredSharedLibs.join(", ")}`);
  lines.push(`  installed: ${result.plan.installed.join(", ")}`);
  lines.push(`  files:     ${Object.keys(result.plan.ownedFiles).length}`);
  if (result.mergedConfigs.length > 0) lines.push(`  updated configs: ${result.mergedConfigs.length}`);
  if (result.preservedConfigs.length > 0) lines.push(`  preserved configs: ${result.preservedConfigs.length}`);
  if (result.removed.length > 0) lines.push(`  removed stale files: ${result.removed.length}`);
  if (result.harnessActions.length > 0) {
    lines.push("  harness integrations:");
    for (const action of result.harnessActions) lines.push(`    - ${action}`);
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (reloadWillRun) lines.push("", "Reloading pi so changes take effect...");
  return lines.join("\n");
}

interface CustomSelectionActivationOperations {
  readonly plan: typeof planCustomPlugActivationMoves;
  readonly execute: typeof executeCustomPlugActivationMoves;
  readonly compensate: typeof compensateCustomPlugActivationMoves;
}

interface CoordinatedCustomSelectionResult<T> {
  readonly catalogResult: T;
  readonly customPlan: readonly CustomPlugMove[];
  readonly customExecution?: CustomPlugMoveExecutionResult;
}

class CatalogApplyAfterCustomMovesError extends Error {
  readonly catalogError: unknown;
  readonly journal: readonly CustomPlugMoveJournalEntry[];
  readonly rollbackFailures: readonly CustomPlugMoveFailure[];

  constructor(
    catalogError: unknown,
    journal: readonly CustomPlugMoveJournalEntry[],
    rollbackFailures: readonly CustomPlugMoveFailure[],
  ) {
    super(catalogApplyFailureText(catalogError, journal, rollbackFailures), { cause: catalogError });
    this.name = "CatalogApplyAfterCustomMovesError";
    this.catalogError = catalogError;
    this.journal = journal;
    this.rollbackFailures = rollbackFailures;
  }
}

const defaultCustomSelectionActivationOperations: CustomSelectionActivationOperations = {
  plan: planCustomPlugActivationMoves,
  execute: executeCustomPlugActivationMoves,
  compensate: compensateCustomPlugActivationMoves,
};

async function coordinateCustomSelectionApply<T>(
  projectRoot: string,
  inventory: CustomPlugInventoryResult,
  desiredActiveDirectoryNames: readonly string[],
  dryRun: boolean,
  applyCatalog: () => Promise<T>,
  operations: CustomSelectionActivationOperations = defaultCustomSelectionActivationOperations,
): Promise<CoordinatedCustomSelectionResult<T>> {
  const customPlan = await operations.plan(projectRoot, inventory, desiredActiveDirectoryNames);
  if (dryRun) return Object.freeze({ catalogResult: await applyCatalog(), customPlan });

  const customExecution = await operations.execute(customPlan);
  try {
    return Object.freeze({ catalogResult: await applyCatalog(), customPlan, customExecution });
  } catch (catalogError) {
    if (customExecution.journal.length === 0) throw catalogError;
    const compensation = await operations.compensate(customExecution.journal);
    throw new CatalogApplyAfterCustomMovesError(catalogError, customExecution.journal, compensation.rollbackFailures);
  }
}

function moveFailureLine(failure: CustomPlugMoveFailure): string {
  const code = failure.code ? ` (${failure.code})` : "";
  const root = failure.rootPath ? `; root: ${failure.rootPath}` : "";
  return `${failure.identity}: ${failure.source} -> ${failure.destination}; ${failure.stage}${code}: ${failure.message}${root}; final location: ${failure.finalKnownLocation}`;
}

function customMovePlanFailureText(error: CustomPlugMovePlanError): string {
  return ["Custom activation preflight failed:", ...error.issues.map((issue) => {
    const paths = issue.source || issue.destination ? `; ${issue.source ?? "?"} -> ${issue.destination ?? "?"}` : "";
    const code = issue.code ? ` (${issue.code})` : "";
    return `- ${issue.identity}${paths}${code}: ${issue.message}`;
  })].join("\n");
}

function customMoveExecutionFailureText(error: CustomPlugMoveExecutionError): string {
  const lines = [`Custom activation failed: ${moveFailureLine(error.result.failure)}`];
  const rollbackFailureIds = new Set(error.result.rollbackFailures.map((failure) => failure.identity));
  for (const completed of [...error.result.journal].reverse()) {
    if (!rollbackFailureIds.has(completed.identity)) {
      lines.push(`Custom rollback restored ${completed.identity}: ${completed.destination} -> ${completed.source}`);
    }
  }
  for (const failure of error.result.rollbackFailures) lines.push(`Custom rollback failed: ${moveFailureLine(failure)}`);
  return lines.join("\n");
}

function catalogApplyFailureText(
  error: unknown,
  journal: readonly CustomPlugMoveJournalEntry[],
  rollbackFailures: readonly CustomPlugMoveFailure[],
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const lines = [`Catalog apply failed after custom moves: ${detail}`];
  const rollbackFailureIds = new Set(rollbackFailures.map((failure) => failure.identity));
  for (const completed of [...journal].reverse()) {
    if (!rollbackFailureIds.has(completed.identity)) {
      lines.push(`Custom rollback restored ${completed.identity}: ${completed.destination} -> ${completed.source}`);
    }
  }
  for (const failure of rollbackFailures) lines.push(`Custom rollback failed: ${moveFailureLine(failure)}`);
  lines.push("Warning: catalog files or state may be partially mutated; combined catalog/custom apply is not globally atomic.");
  return lines.join("\n");
}

function customSelectionResultText(
  result: CoordinatedCustomSelectionResult<ApplyResult>,
  dryRun: boolean,
  reloadWillRun: boolean,
): string {
  const lines = [applyResultText(result.catalogResult, dryRun, false)];
  if (result.customPlan.length > 0) {
    lines.push("", dryRun ? "Custom sidecar plan:" : "Custom sidecars updated:");
    for (const move of result.customPlan) {
      lines.push(`  ${dryRun ? "would " : ""}${move.direction}: ${move.identity} (${move.source} -> ${move.destination})`);
    }
  }
  if (!dryRun && !reloadWillRun) {
    lines.push("", result.customPlan.length > 0
      ? "Filesystem state changed, but current sidecar bindings persist until manual /reload."
      : "Selection changes were applied, but the current Pi runtime remains stale until manual /reload.");
  }
  if (reloadWillRun) lines.push("", "Reloading pi so changes take effect...");
  return lines.join("\n");
}

async function requestSelectionReload(
  reloadWillRun: boolean,
  reload: () => Promise<void>,
): Promise<string | undefined> {
  if (!reloadWillRun) return undefined;
  try {
    await reload();
    return undefined;
  } catch (error) {
    return `Changes were committed, but reload failed (${error instanceof Error ? error.message : String(error)}). Current sidecar bindings may persist; run /reload manually.`;
  }
}

type ManagerTheme = ExtensionCommandContext["ui"]["theme"];

export type PlugSelectionSource = "catalog" | "custom";
export type PlugSelectionTogglePolicy = "normal" | "disable-only" | "locked";

export interface PlugSelectionRow {
  readonly key: string;
  readonly source: PlugSelectionSource;
  readonly sourceLabel: "[catalog]" | "[custom]";
  readonly qualifiedReference: string;
  readonly displayId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly selected: boolean;
  readonly canSelect: boolean;
  readonly canDeselect: boolean;
  readonly togglePolicy: PlugSelectionTogglePolicy;
  readonly catalogId?: string;
  readonly directoryName?: string;
  readonly customState?: CustomPlugInventoryState;
  readonly manifestId?: string;
  readonly dependencyIds?: readonly string[];
}

type ChecklistResult = string[] | undefined;

function freezeSelectionRow(row: PlugSelectionRow): PlugSelectionRow {
  if (row.dependencyIds) Object.freeze(row.dependencyIds);
  return Object.freeze(row);
}

function buildSelectionRows(
  manifest: PlugManifest,
  currentCatalogIds: readonly string[],
  customInventory: readonly CustomPlugInventoryRow[],
): readonly PlugSelectionRow[] {
  const selectedCatalogIds = new Set(currentCatalogIds);
  const rows: PlugSelectionRow[] = visiblePlugins(manifest).map((plugin) => freezeSelectionRow({
    key: `catalog:${plugin.id}`,
    source: "catalog",
    sourceLabel: "[catalog]",
    qualifiedReference: `[catalog] ${plugin.id}`,
    displayId: plugin.id,
    title: plugin.title,
    description: plugin.description,
    status: "catalog",
    selected: selectedCatalogIds.has(plugin.id),
    canSelect: true,
    canDeselect: true,
    togglePolicy: "normal",
    catalogId: plugin.id,
    dependencyIds: [...plugin.pluginDeps],
  }));

  const directoryGroups = new Map<string, CustomPlugInventoryRow[]>();
  for (const inventoryRow of customInventory) {
    const group = directoryGroups.get(inventoryRow.directoryName) ?? [];
    group.push(inventoryRow);
    directoryGroups.set(inventoryRow.directoryName, group);
  }
  for (const [directoryName, group] of directoryGroups) {
    const inventoryRow = group.find((candidate) => candidate.state === "active") ?? group[0];
    if (!inventoryRow) continue;
    const collision = group.length > 1;
    const valid = inventoryRow.manifest !== undefined && inventoryRow.diagnostics.length === 0 && !collision;
    const selected = inventoryRow.state === "active";
    const canSelect = valid;
    const canDeselect = selected && !collision;
    const togglePolicy: PlugSelectionTogglePolicy = collision
      ? "locked"
      : selected && !valid
        ? "disable-only"
        : valid
          ? "normal"
          : "locked";
    const manifestId = inventoryRow.manifest?.id;
    const diagnostic = collision
      ? "duplicate directory exists in both custom roots"
      : inventoryRow.diagnostics.map((item) => item.message).join("; ");
    rows.push(freezeSelectionRow({
      key: `custom:${directoryName}`,
      source: "custom",
      sourceLabel: "[custom]",
      qualifiedReference: `[custom] ${directoryName}`,
      displayId: directoryName,
      title: inventoryRow.manifest?.title || manifestId || "invalid manifest",
      description: inventoryRow.manifest?.description || diagnostic || "project custom sidecar",
      status: diagnostic ? `${inventoryRow.state}; error: ${diagnostic}` : inventoryRow.state,
      selected,
      canSelect,
      canDeselect,
      togglePolicy,
      directoryName,
      customState: inventoryRow.state,
      ...(manifestId === undefined ? {} : { manifestId }),
    }));
  }
  return Object.freeze(rows);
}

function catalogIdsFromSelection(rows: readonly PlugSelectionRow[], selectedKeys: readonly string[]): string[] {
  const selected = new Set(selectedKeys);
  return rows
    .filter((row) => row.source === "catalog" && row.catalogId !== undefined && selected.has(row.key))
    .map((row) => row.catalogId!);
}

function selectionReferenceTokens(input: string): string[] {
  return [...input.matchAll(/\[(?:catalog|custom)\]\s+[^\s,]+|[^\s,]+/giu)].map((match) => match[0]!.trim());
}

function parseSelectionRefs(input: string, rows: readonly PlugSelectionRow[]): string[] {
  const selected: string[] = [];
  const exactKeys = new Map(rows.map((row) => [row.key, row]));
  const visibleRows = [...rows];
  for (const token of selectionReferenceTokens(input)) {
    const lower = token.toLowerCase();
    if (lower === "all") {
      selected.push(...rows.filter((row) => row.canSelect || row.selected).map((row) => row.key));
      continue;
    }
    if (lower === "none" || lower === "empty") continue;
    if (/^\d+$/u.test(token)) {
      const index = Number(token);
      if (index < 1 || index > visibleRows.length) throw new Error(`Selection number out of range: ${token}`);
      const row = visibleRows[index - 1]!;
      if (!row.canSelect && !row.selected) throw new Error(`${row.key} cannot be selected: ${row.status}`);
      selected.push(row.key);
      continue;
    }
    const exact = exactKeys.get(token);
    if (exact) {
      if (!exact.canSelect && !exact.selected) throw new Error(`${exact.key} cannot be selected: ${exact.status}`);
      selected.push(exact.key);
      continue;
    }
    const qualified = /^\[(catalog|custom)\]\s+(.+)$/iu.exec(token);
    const source = qualified?.[1]?.toLowerCase() as PlugSelectionSource | undefined;
    const reference = qualified?.[2] ?? token;
    const matches = rows.filter((row) => {
      if (source && row.source !== source) return false;
      return row.displayId === reference || row.manifestId === reference;
    });
    if (matches.length === 0) throw new Error(`Unknown plug selection reference: ${token}`);
    if (matches.length > 1) throw new Error(`Ambiguous plug selection reference: ${token}; use a namespaced key`);
    const row = matches[0]!;
    if (!row.canSelect && !row.selected) throw new Error(`${row.key} cannot be selected: ${row.status}`);
    selected.push(row.key);
  }
  return uniq(selected);
}

function selectionChoicesText(rows: readonly PlugSelectionRow[]): string {
  return rows.map((row, index) => {
    const manifest = row.source === "custom" ? ` manifest:${row.manifestId ?? "invalid"}` : "";
    return `${index + 1}. ${row.qualifiedReference} (${row.key})${manifest} — ${row.title} [${row.status}]`;
  }).join("\n");
}

class PlugChecklist implements Component {
  private readonly selected = new Set<string>();
  private readonly idWidth: number;
  private cursor = 0;
  private scroll = 0;

  constructor(
    private readonly manifest: PlugManifest,
    private readonly rows: readonly PlugSelectionRow[],
    private readonly theme: ManagerTheme,
    private readonly done: (result: ChecklistResult) => void,
  ) {
    for (const row of rows) if (row.selected) this.selected.add(row.key);
    this.idWidth = Math.min(24, Math.max(10, ...rows.map((row) => row.displayId.length)));
  }

  invalidate(): void {
    // Stateless render; no cache to clear.
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || data === "k") {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.move(-10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.move(10);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.cursor = 0;
      this.scroll = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.cursor = Math.max(0, this.rows.length - 1);
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleFocused();
      return;
    }
    if (data === "a" || data === "A") {
      for (const row of this.rows) if (row.canSelect) this.selected.add(row.key);
      return;
    }
    if (data === "n" || data === "N") {
      for (const row of this.rows) if (row.canDeselect) this.selected.delete(row.key);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.selectedIds());
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(undefined);
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const viewportRows = Math.min(Math.max(6, this.rows.length), 12);
    this.ensureVisible(viewportRows);

    const selectedIds = this.selectedIds();
    const autoDeps = this.autoDependencyIds(selectedIds);
    const focused = this.rows[this.cursor];
    const visible = this.rows.slice(this.scroll, this.scroll + viewportRows);
    const listEnd = Math.min(this.rows.length, this.scroll + visible.length);
    const lines: string[] = [];

    lines.push(this.line(this.theme.fg("accent", this.theme.bold("zz-plugs select")), safeWidth));
    lines.push(
      this.line(
        `${this.theme.fg("text", "Selected")} ${this.theme.fg("accent", String(selectedIds.length))}/${this.rows.length}: ${this.theme.fg(
          selectedIds.length > 0 ? "text" : "muted",
          selectedIds.length > 0 ? selectedIds.join(", ") : "none",
        )}`,
        safeWidth,
      ),
    );
    lines.push(
      this.line(
        `${this.theme.fg("muted", `Showing ${this.scroll + 1}-${listEnd} of ${this.rows.length}`)}${
          autoDeps.length > 0 ? ` ${this.theme.fg("dim", `auto deps: ${autoDeps.join(", ")}`)}` : ""
        }`,
        safeWidth,
      ),
    );
    lines.push(this.line("", safeWidth));

    for (let offset = 0; offset < visible.length; offset += 1) {
      const row = visible[offset];
      if (!row) continue;
      lines.push(this.renderPluginLine(row, this.scroll + offset, safeWidth));
    }

    lines.push(this.line("", safeWidth));
    if (focused) {
      lines.push(this.line(this.theme.fg("accent", focused.key) + this.theme.fg("muted", ` — ${focused.description}`), safeWidth));
      if (focused.source === "catalog") {
        const deps = focused.dependencyIds && focused.dependencyIds.length > 0 ? focused.dependencyIds.join(", ") : "none";
        lines.push(this.line(this.theme.fg("dim", `requires: ${deps}`), safeWidth));
      } else {
        lines.push(this.line(this.theme.fg("dim", `directory: ${focused.directoryName} • manifest: ${focused.manifestId ?? "invalid"} • ${focused.status}`), safeWidth));
      }
    }
    lines.push(
      this.line(
        this.theme.fg("dim", "↑↓/jk scroll • space toggle • a all • n none • enter apply • esc cancel"),
        safeWidth,
      ),
    );

    return lines;
  }

  private selectedIds(): string[] {
    return this.rows.filter((row) => this.selected.has(row.key)).map((row) => row.key);
  }

  private autoDependencyIds(selectedKeys: string[]): string[] {
    try {
      return resolvePlan(this.manifest, catalogIdsFromSelection(this.rows, selectedKeys)).autoRequired;
    } catch {
      return [];
    }
  }

  private renderPluginLine(row: PlugSelectionRow, index: number, width: number): string {
    const active = index === this.cursor;
    const checked = this.selected.has(row.key);
    const pointer = active ? this.theme.fg("accent", ">") : " ";
    const checkbox = checked ? this.theme.fg("success", "[x]") : this.theme.fg("muted", "[ ]");
    const id = this.formatId(row.displayId, active, checked);
    const title = this.theme.fg(active ? "accent" : "text", row.title);
    const details = row.source === "catalog"
      ? row.dependencyIds && row.dependencyIds.length > 0 ? this.theme.fg("dim", ` requires:${row.dependencyIds.join(",")}`) : ""
      : this.theme.fg("dim", ` manifest:${row.manifestId ?? "invalid"} ${row.status}`);
    return this.line(`${pointer} ${checkbox} ${row.sourceLabel} ${id} ${title}${details}`, width);
  }

  private formatId(id: string, active: boolean, checked: boolean): string {
    const plain = id.length > this.idWidth ? `${id.slice(0, Math.max(1, this.idWidth - 1))}…` : id.padEnd(this.idWidth, " ");
    if (active) return this.theme.fg("accent", plain);
    return this.theme.fg(checked ? "text" : "muted", plain);
  }

  private line(value: string, width: number): string {
    return truncateToWidth(value, width, "…");
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
  }

  private toggleFocused(): void {
    const row = this.rows[this.cursor];
    if (!row) return;
    if (this.selected.has(row.key)) {
      if (row.canDeselect) this.selected.delete(row.key);
    } else if (row.canSelect) {
      this.selected.add(row.key);
    }
  }

  private ensureVisible(viewportRows: number): void {
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    const maxVisibleIndex = this.scroll + viewportRows - 1;
    if (this.cursor > maxVisibleIndex) this.scroll = this.cursor - viewportRows + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.rows.length - viewportRows)));
  }
}

async function showSelectionChecklist(
  ctx: ExtensionCommandContext,
  manifest: PlugManifest,
  rows: readonly PlugSelectionRow[],
): Promise<ChecklistResult> {
  return ctx.ui.custom<ChecklistResult>((tui, theme, _keybindings, done) => {
    const checklist = new PlugChecklist(manifest, rows, theme, done);
    return {
      render: (width) => checklist.render(width),
      invalidate: () => checklist.invalidate(),
      handleInput: (data) => {
        checklist.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function show(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true });
}

function customPlugDiagnosticsText(
  diagnostics: readonly CustomPlugDiagnostic[],
  bindingDiagnostics: readonly CustomPlugBindingDiagnostic[],
  hostDiagnostic?: string,
): string {
  const lines = diagnostics.map((diagnostic) => {
    const plugin = diagnostic.pluginId ? `custom plug "${diagnostic.pluginId}"` : "custom-plug candidate";
    return `- [${diagnostic.stage}] ${plugin} (${diagnostic.manifestPath}): ${diagnostic.message}`;
  });
  lines.push(...bindingDiagnostics.map((diagnostic) =>
    `- [binding] custom plug "${diagnostic.pluginId}" (${diagnostic.manifestPath}): ${diagnostic.message}`,
  ));
  if (hostDiagnostic) lines.push(`- [discovery] custom-plug host: ${hostDiagnostic}`);
  return `Custom plug startup reported ${lines.length} issue(s):\n${lines.join("\n")}`;
}

function projectRootFromManagerModule(managerModuleUrl: string): string | undefined {
  let managerPath: string;
  try {
    managerPath = fileURLToPath(managerModuleUrl);
  } catch {
    return undefined;
  }
  const extensionsDirectory = dirname(managerPath);
  const piDirectory = dirname(extensionsDirectory);
  if (
    basename(managerPath) !== "zz-plug-manager.ts"
    || basename(extensionsDirectory) !== "extensions"
    || basename(piDirectory) !== ".pi"
  ) {
    return undefined;
  }
  return dirname(piDirectory);
}

async function startCustomPlugManager(pi: ExtensionAPI, managerModuleUrl: string): Promise<void> {
  const projectRoot = projectRootFromManagerModule(managerModuleUrl);
  const loaded = projectRoot
    ? await loadCustomPlugs(projectRoot, { reservedCommandNames: ["zz-plugs"] })
    : { plugins: [], diagnostics: [] };
  let bindingDiagnostics: readonly CustomPlugBindingDiagnostic[] = [];
  let hostDiagnostic: string | undefined;
  if (projectRoot) {
    try {
      bindingDiagnostics = commitCustomPlugsToPi(pi, loaded.plugins, projectRoot);
    } catch (error) {
      hostDiagnostic = `Sidecar binding preflight failed before registration: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    hostDiagnostic = `Sidecar scanning skipped because manager module ${managerModuleUrl} is not installed as <project>/.pi/extensions/zz-plug-manager.ts.`;
  }
  const startupDiagnostics = loaded.diagnostics.length > 0 || bindingDiagnostics.length > 0 || hostDiagnostic
    ? customPlugDiagnosticsText(loaded.diagnostics, bindingDiagnostics, hostDiagnostic)
    : undefined;

  if (startupDiagnostics) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(startupDiagnostics, "warning");
    });
  }

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
    return new Text(theme.fg("accent", "zz-plugs") + "\n" + String(message.content ?? ""), 0, 0);
  });

  pi.registerCommand("zz-plugs", {
    description: "Manage repo-local zz pi plugs",
    handler: async (args, ctx) => {
      try {
        const config = await loadConfig(ctx.cwd);
        const parts = splitTokens(args);
        const command = (parts.shift() ?? "help").toLowerCase();

        if (["help", "-h", "--help"].includes(command)) {
          show(pi, helpText());
          return;
        }

        const manifest = await loadManifest(config.sourceUrl, ctx.signal);
        const state = await loadState(ctx.cwd);

        if (command === "list") {
          show(pi, listText(manifest));
          return;
        }

        if (command === "status") {
          show(pi, statusText(state, config.sourceUrl));
          return;
        }

        const { flags, values } = parseFlags(parts);
        const currentSelected = selectedPluginsFromState(manifest, state);
        let nextSelected: string[];

        if (command === "install" || command === "add") {
          if (values.length === 0) throw new Error("install needs at least one plug id, number, or 'all'");
          nextSelected = uniq([...currentSelected, ...parsePluginRefs(values.join(","), manifest)]);
        } else if (command === "remove" || command === "rm") {
          if (values.length === 0) throw new Error("remove needs at least one plug id, number, or 'all'");
          const remove = new Set(parsePluginRefs(values.join(","), manifest));
          if (values.map((value) => value.toLowerCase()).includes("all")) nextSelected = [];
          else nextSelected = currentSelected.filter((id) => !remove.has(id));
        } else if (command === "set") {
          nextSelected = parsePluginRefs(values.join(","), manifest);
        } else if (command === "update") {
          nextSelected = currentSelected;
        } else if (command === "select") {
          const customInventory = projectRoot
            ? await inventoryCustomPlugs(projectRoot)
            : { rows: Object.freeze([]), diagnostics: Object.freeze([]) };
          const selectionRows = buildSelectionRows(manifest, currentSelected, customInventory.rows);
          const currentKeys = selectionRows.filter((row) => row.selected).map((row) => row.key);
          let selectedKeys: string[];
          if (ctx.mode === "tui") {
            const selected = await showSelectionChecklist(ctx, manifest, selectionRows);
            if (selected === undefined) return;
            selectedKeys = selected;
          } else {
            const current = currentKeys.length > 0 ? currentKeys.join(",") : "none";
            show(pi, `Available zz pi plugs:\n${selectionChoicesText(selectionRows)}\n\nCurrent selection: ${current}`);
            const answer = await ctx.ui.input(
              "Select plugs (namespaced keys, [catalog]/[custom] references, numbers, all, or none; empty keeps current):",
              current,
            );
            if (answer === undefined) return;
            const selection = answer.trim();
            selectedKeys = selection ? parseSelectionRefs(selection, selectionRows) : currentKeys;
          }
          nextSelected = catalogIdsFromSelection(selectionRows, selectedKeys);
          const desiredActiveCustomDirectories = selectionRows
            .filter((row) => row.source === "custom" && selectedKeys.includes(row.key))
            .map((row) => row.directoryName!);
          const reloadWillRun = !flags.dryRun && flags.reload && config.autoReload;
          if (projectRoot) {
            // User interaction can outlive the manifest snapshot shown in the checklist.
            // Refresh immediately before planning so preflight uses current disk state.
            const planningInventory = await inventoryCustomPlugs(projectRoot);
            let result: CoordinatedCustomSelectionResult<ApplyResult>;
            try {
              result = await coordinateCustomSelectionApply(
                projectRoot,
                planningInventory,
                desiredActiveCustomDirectories,
                flags.dryRun,
                () => applySelection(ctx.cwd, config.sourceUrl, config.zzLibUrl, manifest, nextSelected, flags, ctx.signal),
              );
            } catch (error) {
              if (error instanceof CustomPlugMovePlanError) throw new Error(customMovePlanFailureText(error), { cause: error });
              if (error instanceof CustomPlugMoveExecutionError) throw new Error(customMoveExecutionFailureText(error), { cause: error });
              throw error;
            }
            show(pi, customSelectionResultText(result, flags.dryRun, reloadWillRun));
            const reloadFailure = await requestSelectionReload(reloadWillRun, () => ctx.reload());
            if (reloadFailure) show(pi, `Error: ${reloadFailure}`);
            return;
          }
        } else {
          show(pi, helpText());
          return;
        }

        const result = await applySelection(ctx.cwd, config.sourceUrl, config.zzLibUrl, manifest, nextSelected, flags, ctx.signal);
        const reloadWillRun = !flags.dryRun && flags.reload && config.autoReload;
        show(pi, applyResultText(result, flags.dryRun, reloadWillRun));
        if (reloadWillRun) {
          await ctx.reload();
          return;
        }
      } catch (error) {
        show(pi, `Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

/** @internal Focused combined-selection model, orchestration, and checklist test seam. */
export const __zzPlugSelectionForTests = Object.freeze({
  buildSelectionRows,
  catalogIdsFromSelection,
  coordinateCustomSelectionApply,
  customMoveExecutionFailureText,
  customMovePlanFailureText,
  customSelectionResultText,
  requestSelectionReload,
  createChecklist: (
    manifest: PlugManifest,
    rows: readonly PlugSelectionRow[],
    theme: ManagerTheme,
    done: (result: ChecklistResult) => void,
  ): Component => new PlugChecklist(manifest, rows, theme, done),
  parseSelectionRefs,
  selectionChoicesText,
});

/** @internal Focused startup test seam for installed module-layout fixtures. */
export async function __zzPlugManagerForTests(pi: ExtensionAPI, managerModuleUrl: string): Promise<void> {
  await startCustomPlugManager(pi, managerModuleUrl);
}

export default async function zzPlugManager(pi: ExtensionAPI): Promise<void> {
  await startCustomPlugManager(pi, import.meta.url);
}
