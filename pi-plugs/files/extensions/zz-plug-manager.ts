import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

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

function stripJsonc(text: string): string {
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

const HARNESS_INTEGRATION_IDS = ["codex-readsubagent", "claude-readsubagent", "copilot-readsubagent"] as const;
type HarnessIntegrationId = (typeof HARNESS_INTEGRATION_IDS)[number];

function isHarnessIntegrationId(id: string): id is HarnessIntegrationId {
  return (HARNESS_INTEGRATION_IDS as readonly string[]).includes(id);
}

function harnessIntegrationPlugin(id: HarnessIntegrationId): PlugManifestPlugin {
  if (id === "codex-readsubagent") {
    return {
      id,
      title: "Codex readsubagent",
      description: "Installs the Codex readsubagent custom agent, AGENTS.md guidance, and Codex LM Studio provider block.",
      entry: "extensions/00-zz-subagent-runtime.ts",
      internal: false,
      pluginDeps: ["zz-subagent-runtime"],
      optionalPluginDeps: [],
      fileDeps: [],
      configFiles: [],
      sharedDeps: [],
      tags: ["agent", "codex", "read-only"],
    };
  }

  if (id === "claude-readsubagent") {
    return {
      id,
      title: "Claude readsubagent",
      description: "Installs the Claude Code readsubagent, MCP server registration, and CLAUDE.md guidance.",
      entry: "extensions/00-zz-subagent-runtime.ts",
      internal: false,
      pluginDeps: ["zz-subagent-runtime", "zz-local-models"],
      optionalPluginDeps: [],
      fileDeps: [],
      configFiles: [],
      sharedDeps: [],
      tags: ["agent", "claude", "mcp", "read-only"],
    };
  }

  return {
    id,
    title: "Copilot readsubagent",
    description: "Installs the Copilot/VS Code MCP readsubagent server and copilot-instructions.md guidance.",
    entry: "extensions/00-zz-subagent-runtime.ts",
    internal: false,
    pluginDeps: ["zz-subagent-runtime", "zz-local-models"],
    optionalPluginDeps: [],
    fileDeps: [],
    configFiles: [],
    sharedDeps: [],
    tags: ["agent", "copilot", "mcp", "read-only"],
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
  const selected = normalizeSelectedPlugins(manifest, asStringArray(state.selected_plugins));
  return selected.length > 0
    ? selected
    : normalizeSelectedPlugins(manifest, asStringArray(state.installed_plugins));
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

function oldHashes(state: InstallState): Record<string, string> {
  if (isRecord(state.file_hashes)) {
    return Object.fromEntries(Object.entries(state.file_hashes).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  return Object.fromEntries((state.files ?? []).map((file) => [cleanRelPath(file.path), file.sha256]));
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

const CODEX_AGENT_REL = ".codex/agents/readsubagent.toml";
const CODEX_MANIFEST_REL = ".codex/zz-codex-readsubagent-manifest.json";
const CLAUDE_AGENT_REL = ".claude/agents/readsubagent.md";
const CLAUDE_MANIFEST_REL = ".claude/zz-claude-readsubagent-manifest.json";
const COPILOT_MANIFEST_REL = ".github/zz-copilot-readsubagent-manifest.json";
const MCP_ONLY_MANIFEST_REL = ".zz-mcp/zz-readsubagent-mcp-manifest.json";
const READSUBAGENT_SERVER_REL = ".zz-mcp/zz-readsubagent-mcp.py";
const SERVER_NAME = "zz_readsubagent";
const SERVER_ARGS_PATH = ".zz-mcp/zz-readsubagent-mcp.py";
const DEFAULT_LOCAL_PROVIDER_URL = "http://127.0.0.1:11444/v1";
const DEFAULT_LOCAL_MODEL_SELECTOR = "lm-studio/qwen/qwen3.6-35b-a3b";

const CODEX_AGENTS_START = "<!-- zz-codex-readsubagent:start -->";
const CODEX_AGENTS_END = "<!-- zz-codex-readsubagent:end -->";
const CLAUDE_GUIDANCE_START = "<!-- zz-claude-readsubagent:start -->";
const CLAUDE_GUIDANCE_END = "<!-- zz-claude-readsubagent:end -->";
const COPILOT_GUIDANCE_START = "<!-- zz-copilot-readsubagent:start -->";
const COPILOT_GUIDANCE_END = "<!-- zz-copilot-readsubagent:end -->";
const CODEX_PROVIDER_START = "# zz-codex-readsubagent:start";
const CODEX_PROVIDER_END = "# zz-codex-readsubagent:end";

const CODEX_AGENTS_BLOCK = `${CODEX_AGENTS_START}
## Read Planning

Before doing focused reads of specific implementation files, start with a
read-planning pass through the \`readsubagent\` custom agent.

Use \`readsubagent\` to get:

- A short map of the relevant subsystem.
- Candidate files and directories, with reasons.
- The smallest focused read list for the main agent.
- Search terms, symbols, or line anchors that should guide the focused reads.
- Files or areas that look related but should be avoided for now.
- Uncertainty or follow-up questions that could change the read plan.

Use at least a ten-minute wait for \`readsubagent\` when the tool supports an
explicit timeout, because the local model may be slower than hosted models.
Prefer a longer wait over assuming the subagent stalled.

Use \`readsubagent\` only for factual read planning and file inspection. Do not
ask it to create implementation plans, solution proposals, edit strategies,
code-review judgments, bug findings, correctness assessments, or accept/reject
recommendations.
${CODEX_AGENTS_END}`;

const CLAUDE_GUIDANCE_BLOCK = `${CLAUDE_GUIDANCE_START}
## Read Planning

Before doing focused reads of specific implementation files, start with a
read-planning pass through the \`readsubagent\` subagent, which delegates to a
local model via the \`mcp__zz_readsubagent__readsubagent\` MCP tool.

Use \`readsubagent\` to get a short subsystem map, candidate files, the smallest
focused read list, useful search terms/line anchors, areas to avoid, and
uncertainty or follow-up questions.

The local model can be slow. Allow a long wait for \`readsubagent\`; prefer
waiting over assuming it stalled. Use it only for factual read planning and file
inspection, not implementation planning or code-review judgments.
${CLAUDE_GUIDANCE_END}`;

const COPILOT_GUIDANCE_BLOCK = `${COPILOT_GUIDANCE_START}
## Read Planning

Before doing focused reads of specific implementation files, ask Copilot to use
the \`readsubagent\` tool from the \`zz_readsubagent\` MCP server to get a
read-planning pass. The tool delegates to a local model via \`pi\` and returns a
concise factual report with paths and line ranges.

Use \`readsubagent\` for factual read planning and file inspection only. Do not
ask it for implementation plans, edit strategies, code-review judgments, or
correctness assessments. The local model can be slow; prefer waiting over
assuming it stalled.
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
  return COPILOT_MANIFEST_REL;
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

function manifestFileHashes(manifest: JsonRecord | undefined): Record<string, string> {
  const hashes = manifest?.file_hashes;
  if (!isPlainRecord(hashes)) return {};
  return Object.fromEntries(Object.entries(hashes).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function readHarnessManifest(cwd: string, rel: string): Promise<JsonRecord | undefined> {
  return readJson(safeTarget(cwd, rel));
}

async function knownReadsubagentManifestOwns(cwd: string, rel: string, exceptManifestRel?: string): Promise<boolean> {
  for (const manifestRel of [CODEX_MANIFEST_REL, CLAUDE_MANIFEST_REL, COPILOT_MANIFEST_REL, MCP_ONLY_MANIFEST_REL]) {
    if (manifestRel === exceptManifestRel) continue;
    const manifest = await readHarnessManifest(cwd, manifestRel);
    if (manifestOwns(manifest, rel)) return true;
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
): Promise<string> {
  const target = safeTarget(cwd, rel);
  const owned = manifestOwns(manifest, rel) || (await knownReadsubagentManifestOwns(cwd, rel, manifestRel));
  if ((await fileExists(target)) && !owned && !force) {
    if (!(await readFile(target)).equals(buffer)) {
      throw new Error(`Refusing to overwrite existing unowned ${rel}. Use --force if you want zz-plugs to claim it.`);
    }
    return `unchanged existing matching ${rel}`;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return `installed ${rel}`;
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

function codexConfigPath(manifest?: JsonRecord): string {
  const provider = manifest?.provider;
  if (isPlainRecord(provider) && typeof provider.config_path === "string") return provider.config_path;
  const codexDir = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : resolve(homedir(), ".codex");
  return resolve(codexDir, "config.toml");
}

async function ensureCodexProvider(providerUrl: string, manifest: JsonRecord | undefined, force: boolean): Promise<ManagedAction> {
  const target = codexConfigPath(manifest);
  const existing = (await fileExists(target)) ? await readFile(target, "utf8") : "";
  const block = `${CODEX_PROVIDER_START}
[model_providers.zz_lmstudio_read]
name = "LM Studio readsubagent"
base_url = "${providerUrl}"
${CODEX_PROVIDER_END}`;

  if (existing.includes(CODEX_PROVIDER_START) && existing.includes(CODEX_PROVIDER_END)) {
    const result = replaceMarkedBlock(existing, CODEX_PROVIDER_START, CODEX_PROVIDER_END, block);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${result.text.trimEnd()}\n`, "utf8");
    return { action: `updated ${target}`, managed: true };
  }
  if (/^\[model_providers\.zz_lmstudio_read\]\s*$/mu.test(existing) && !force) {
    return { action: `preserved existing unmanaged zz_lmstudio_read provider in ${target}`, managed: false };
  }
  const result = replaceMarkedBlock(existing, CODEX_PROVIDER_START, CODEX_PROVIDER_END, block);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${result.text.trimEnd()}\n`, "utf8");
  return { action: `added zz_lmstudio_read provider to ${target}`, managed: true };
}

async function removeCodexProvider(manifest: JsonRecord | undefined): Promise<string | undefined> {
  const target = codexConfigPath(manifest);
  if (!(await fileExists(target))) return undefined;
  const result = removeMarkedBlock(await readFile(target, "utf8"), CODEX_PROVIDER_START, CODEX_PROVIDER_END);
  if (!result.removed) return undefined;
  await writeFile(target, result.text, "utf8");
  return `removed zz_lmstudio_read provider block from ${target}`;
}

function serverEntry(model: string, piBin: string): JsonRecord {
  const env: JsonRecord = { ZZ_READSUBAGENT_MODEL: model };
  if (piBin !== "pi") env.ZZ_READSUBAGENT_PI_BIN = piBin;
  return {
    type: "stdio",
    command: "python3",
    args: [SERVER_ARGS_PATH],
    env,
  };
}

async function readJsonObjectForEdit(path: string, label: string): Promise<JsonRecord> {
  if (!(await fileExists(path))) return {};
  return parseJsoncRecord(await readFile(path, "utf8"), label);
}

async function ensureMcpServer(
  cwd: string,
  rel: string,
  topKey: "mcpServers" | "servers",
  model: string,
  piBin: string,
  manifest: JsonRecord | undefined,
  force: boolean,
): Promise<ManagedAction> {
  const target = safeTarget(cwd, rel);
  const data = await readJsonObjectForEdit(target, rel);
  const currentServers = data[topKey];
  const servers = isPlainRecord(currentServers) ? currentServers : {};
  const existing = servers[SERVER_NAME];
  const managed = manifestManagedServers(manifest).includes(SERVER_NAME);
  if (isPlainRecord(existing) && !managed && !force) {
    return { action: `preserved existing unmanaged ${SERVER_NAME} server in ${rel}`, managed: false };
  }
  servers[SERVER_NAME] = serverEntry(model, piBin);
  data[topKey] = servers;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { action: `registered ${SERVER_NAME} server in ${rel}`, managed: true };
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
  const manifest = await readHarnessManifest(cwd, CODEX_MANIFEST_REL);
  const defaults = await readHarnessDefaults(cwd);
  const providerUrl = process.env.ZZ_CODEX_READSUBAGENT_PROVIDER_URL || defaults.providerUrl;
  const skipProvider = truthy(process.env.ZZ_CODEX_READSUBAGENT_SKIP_PROVIDER);
  const skipAgentsMd = truthy(process.env.ZZ_CODEX_READSUBAGENT_SKIP_AGENTS_MD);

  if (options.dryRun) {
    return [
      `would install/update ${CODEX_AGENT_REL}`,
      skipAgentsMd ? "would skip AGENTS.md guidance" : "would add/update AGENTS.md guidance",
      skipProvider ? "would skip Codex provider" : `would add/update Codex provider ${providerUrl}`,
    ];
  }

  const actions: string[] = [];
  const agent = await fetchUrlBytes(joinUrl(sourceBase, "readsubagent.toml"), signal);
  actions.push(await ensureHarnessFile(cwd, CODEX_AGENT_REL, agent, manifest, CODEX_MANIFEST_REL, options.force));
  if (skipAgentsMd) actions.push("skipped AGENTS.md guidance");
  else actions.push(await ensureMarkedBlockFile(cwd, "AGENTS.md", "# Codex Guidance\n", CODEX_AGENTS_START, CODEX_AGENTS_END, CODEX_AGENTS_BLOCK));

  let providerManaged = false;
  if (skipProvider) actions.push("skipped user-level Codex provider");
  else {
    const provider = await ensureCodexProvider(providerUrl, manifest, options.force);
    providerManaged = provider.managed;
    actions.push(provider.action);
  }

  await writeHarnessManifest(cwd, CODEX_MANIFEST_REL, {
    installer: "zz-codex-readsubagent",
    schemaVersion: 1,
    source_url: sourceBase,
    owned_files: [CODEX_AGENT_REL],
    managed_blocks: [
      ...(skipAgentsMd ? [] : ["AGENTS.md:zz-codex-readsubagent"]),
      ...(providerManaged ? ["~/.codex/config.toml:zz-codex-readsubagent"] : []),
    ],
    file_hashes: await hashExistingHarnessFiles(cwd, [CODEX_AGENT_REL]),
    provider: {
      name: "zz_lmstudio_read",
      base_url: providerUrl,
      config_path: codexConfigPath(manifest),
      managed: providerManaged,
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

  if (options.dryRun) {
    return [
      `would install/update ${CLAUDE_AGENT_REL}`,
      `would install/update ${READSUBAGENT_SERVER_REL}`,
      skipMcp ? "would skip .mcp.json registration" : `would register ${SERVER_NAME} in .mcp.json using ${model}`,
      skipClaudeMd ? "would skip CLAUDE.md guidance" : "would add/update CLAUDE.md guidance",
    ];
  }

  const actions: string[] = [];
  const agent = await fetchUrlBytes(joinUrl(sourceBase, "readsubagent.md"), signal);
  const server = await fetchUrlBytes(joinUrl(mcpBase, "zz-readsubagent-mcp.py"), signal);
  actions.push(await ensureHarnessFile(cwd, CLAUDE_AGENT_REL, agent, manifest, CLAUDE_MANIFEST_REL, options.force));
  actions.push(await ensureHarnessFile(cwd, READSUBAGENT_SERVER_REL, server, manifest, CLAUDE_MANIFEST_REL, options.force));

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
    owned_files: [CLAUDE_AGENT_REL, READSUBAGENT_SERVER_REL],
    managed_blocks: skipClaudeMd ? [] : ["CLAUDE.md:zz-claude-readsubagent"],
    managed_servers: serverManaged ? [SERVER_NAME] : [],
    file_hashes: await hashExistingHarnessFiles(cwd, [CLAUDE_AGENT_REL, READSUBAGENT_SERVER_REL]),
    server: { name: SERVER_NAME, model, pi_bin: piBin, config_path: safeTarget(cwd, ".mcp.json"), managed: serverManaged },
  });
  return actions;
}

async function installCopilotIntegration(cwd: string, sourceUrl: string, options: ApplyOptions, signal?: AbortSignal): Promise<string[]> {
  const mcpBase = siblingUrl(sourceUrl, "zz-readsubagent-mcp");
  const manifest = await readHarnessManifest(cwd, COPILOT_MANIFEST_REL);
  const defaults = await readHarnessDefaults(cwd);
  const model = process.env.ZZ_COPILOT_READSUBAGENT_MODEL || defaults.modelSelector || DEFAULT_LOCAL_MODEL_SELECTOR;
  const piBin = process.env.ZZ_COPILOT_READSUBAGENT_PI_BIN || "pi";
  const skipMcp = truthy(process.env.ZZ_COPILOT_READSUBAGENT_SKIP_MCP);
  const skipInstructions = truthy(process.env.ZZ_COPILOT_READSUBAGENT_SKIP_INSTRUCTIONS);

  if (options.dryRun) {
    return [
      `would install/update ${READSUBAGENT_SERVER_REL}`,
      skipMcp ? "would skip .vscode/mcp.json registration" : `would register ${SERVER_NAME} in .vscode/mcp.json using ${model}`,
      skipInstructions ? "would skip Copilot instructions" : "would add/update .github/copilot-instructions.md guidance",
    ];
  }

  const actions: string[] = [];
  const server = await fetchUrlBytes(joinUrl(mcpBase, "zz-readsubagent-mcp.py"), signal);
  actions.push(await ensureHarnessFile(cwd, READSUBAGENT_SERVER_REL, server, manifest, COPILOT_MANIFEST_REL, options.force));

  let serverManaged = false;
  if (skipMcp) actions.push("skipped .vscode/mcp.json registration");
  else {
    const registration = await ensureMcpServer(cwd, ".vscode/mcp.json", "servers", model, piBin, manifest, options.force);
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

  await writeHarnessManifest(cwd, COPILOT_MANIFEST_REL, {
    installer: "zz-copilot-readsubagent",
    schemaVersion: 1,
    source_url: mcpBase,
    owned_files: [READSUBAGENT_SERVER_REL],
    managed_blocks: skipInstructions ? [] : [".github/copilot-instructions.md:zz-copilot-readsubagent"],
    managed_servers: serverManaged ? [SERVER_NAME] : [],
    file_hashes: await hashExistingHarnessFiles(cwd, [READSUBAGENT_SERVER_REL]),
    server: { name: SERVER_NAME, model, pi_bin: piBin, config_path: safeTarget(cwd, ".vscode/mcp.json"), managed: serverManaged },
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
  return installCopilotIntegration(cwd, sourceUrl, options, signal);
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
  if (await knownReadsubagentManifestOwns(cwd, rel, manifestRel)) return `kept ${rel} because another readsubagent integration owns it`;
  if (options.dryRun) return `would remove ${rel}`;
  const previousHash = manifestFileHashes(manifest)[rel];
  if (previousHash && (await hashFile(target)) !== previousHash) return `kept modified ${rel}`;
  await unlink(target);
  return `removed ${rel}`;
}

async function removeHarnessIntegration(cwd: string, id: HarnessIntegrationId, options: ApplyOptions): Promise<string[]> {
  const manifestRel = harnessManifestRel(id);
  const manifest = await readHarnessManifest(cwd, manifestRel);
  if (!manifest) return options.dryRun ? [`would remove ${id} if installed`] : [];

  const actions: string[] = [];
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
  }

  if (id === "copilot-readsubagent") {
    if (manifestManagedServers(manifest).includes(SERVER_NAME)) {
      if (options.dryRun) actions.push(`would remove ${SERVER_NAME} from .vscode/mcp.json`);
      else {
        const action = await removeMcpServer(cwd, ".vscode/mcp.json", "servers");
        if (action) actions.push(action);
      }
    }
    if (manifestManagedBlocks(manifest).includes(".github/copilot-instructions.md:zz-copilot-readsubagent")) {
      if (options.dryRun) actions.push("would remove Copilot instructions block");
      else {
        const action = await removeMarkedBlockFile(cwd, ".github/copilot-instructions.md", COPILOT_GUIDANCE_START, COPILOT_GUIDANCE_END);
        if (action) actions.push(action);
      }
    }
  }

  if (options.dryRun) actions.push(`would remove ${manifestRel}`);
  else {
    const manifestPath = safeTarget(cwd, manifestRel);
    if (await fileExists(manifestPath)) await unlink(manifestPath);
    actions.push(`removed ${manifestRel}`);
    for (const dir of [".codex", ".claude", ".github", ".vscode", ".zz-mcp"]) {
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
  const previous = previousSelected.length > 0 ? previousSelected : previousInstalled;
  const next = plan.selected.filter(isHarnessIntegrationId);
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
  const previousHashes = oldHashes(state);
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
      const previousHash = previousHashes[rel];
      if (previousHash && (await hashFile(target)) !== previousHash) {
        warnings.push(`kept modified config from removed plug: ${rel}`);
        continue;
      }
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
    "  /zz-plugs select",
    "  /zz-plugs install <id|number|all> [--force] [--reset-config] [--dry-run]",
    "  /zz-plugs remove <id|number|all> [--dry-run]",
    "  /zz-plugs set <id|number|all|none> [--force] [--reset-config] [--dry-run]",
    "  /zz-plugs update [--force] [--reset-config] [--dry-run]",
    "",
    "Hard dependencies are installed automatically. Existing config files get missing defaults merged in; --reset-config overwrites them.",
    "Codex/Claude/Copilot readsubagent harness integrations appear in list/select and are installed outside .pi with their own manifests.",
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

function applyResultText(result: ApplyResult, dryRun: boolean): string {
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
  if (!dryRun) lines.push("", "Reloading pi so changes take effect...");
  return lines.join("\n");
}

type ManagerTheme = ExtensionCommandContext["ui"]["theme"];

type ChecklistResult = string[] | undefined;

class PlugChecklist implements Component {
  private readonly selected = new Set<string>();
  private readonly idWidth: number;
  private cursor = 0;
  private scroll = 0;

  constructor(
    private readonly manifest: PlugManifest,
    private readonly plugins: PlugManifestPlugin[],
    currentSelected: string[],
    private readonly theme: ManagerTheme,
    private readonly done: (result: ChecklistResult) => void,
  ) {
    for (const id of currentSelected) this.selected.add(id);
    this.idWidth = Math.min(24, Math.max(10, ...plugins.map((plugin) => plugin.id.length)));
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
      this.cursor = Math.max(0, this.plugins.length - 1);
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleFocused();
      return;
    }
    if (data === "a" || data === "A") {
      for (const plugin of this.plugins) this.selected.add(plugin.id);
      return;
    }
    if (data === "n" || data === "N") {
      this.selected.clear();
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
    const viewportRows = Math.min(Math.max(6, this.plugins.length), 12);
    this.ensureVisible(viewportRows);

    const selectedIds = this.selectedIds();
    const autoDeps = this.autoDependencyIds(selectedIds);
    const focused = this.plugins[this.cursor];
    const visible = this.plugins.slice(this.scroll, this.scroll + viewportRows);
    const listEnd = Math.min(this.plugins.length, this.scroll + visible.length);
    const lines: string[] = [];

    lines.push(this.line(this.theme.fg("accent", this.theme.bold("zz-plugs select")), safeWidth));
    lines.push(
      this.line(
        `${this.theme.fg("text", "Selected")} ${this.theme.fg("accent", String(selectedIds.length))}/${this.plugins.length}: ${this.theme.fg(
          selectedIds.length > 0 ? "text" : "muted",
          selectedIds.length > 0 ? selectedIds.join(", ") : "none",
        )}`,
        safeWidth,
      ),
    );
    lines.push(
      this.line(
        `${this.theme.fg("muted", `Showing ${this.scroll + 1}-${listEnd} of ${this.plugins.length}`)}${
          autoDeps.length > 0 ? ` ${this.theme.fg("dim", `auto deps: ${autoDeps.join(", ")}`)}` : ""
        }`,
        safeWidth,
      ),
    );
    lines.push(this.line("", safeWidth));

    for (let offset = 0; offset < visible.length; offset += 1) {
      const plugin = visible[offset];
      if (!plugin) continue;
      lines.push(this.renderPluginLine(plugin, this.scroll + offset, safeWidth));
    }

    lines.push(this.line("", safeWidth));
    if (focused) {
      lines.push(this.line(this.theme.fg("accent", focused.id) + this.theme.fg("muted", ` — ${focused.description}`), safeWidth));
      const deps = focused.pluginDeps.length > 0 ? focused.pluginDeps.join(", ") : "none";
      lines.push(this.line(this.theme.fg("dim", `requires: ${deps}`), safeWidth));
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
    return this.plugins.filter((plugin) => this.selected.has(plugin.id)).map((plugin) => plugin.id);
  }

  private autoDependencyIds(selectedIds: string[]): string[] {
    try {
      return resolvePlan(this.manifest, selectedIds).autoRequired;
    } catch {
      return [];
    }
  }

  private renderPluginLine(plugin: PlugManifestPlugin, index: number, width: number): string {
    const active = index === this.cursor;
    const checked = this.selected.has(plugin.id);
    const pointer = active ? this.theme.fg("accent", ">") : " ";
    const checkbox = checked ? this.theme.fg("success", "[x]") : this.theme.fg("muted", "[ ]");
    const id = this.formatId(plugin.id, active, checked);
    const title = this.theme.fg(active ? "accent" : "text", plugin.title);
    const deps = plugin.pluginDeps.length > 0 ? this.theme.fg("dim", ` requires:${plugin.pluginDeps.join(",")}`) : "";
    return this.line(`${pointer} ${checkbox} ${id} ${title}${deps}`, width);
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
    if (this.plugins.length === 0) return;
    this.cursor = Math.max(0, Math.min(this.plugins.length - 1, this.cursor + delta));
  }

  private toggleFocused(): void {
    const plugin = this.plugins[this.cursor];
    if (!plugin) return;
    if (this.selected.has(plugin.id)) this.selected.delete(plugin.id);
    else this.selected.add(plugin.id);
  }

  private ensureVisible(viewportRows: number): void {
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    const maxVisibleIndex = this.scroll + viewportRows - 1;
    if (this.cursor > maxVisibleIndex) this.scroll = this.cursor - viewportRows + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.plugins.length - viewportRows)));
  }
}

async function showSelectionChecklist(
  ctx: ExtensionCommandContext,
  manifest: PlugManifest,
  currentSelected: string[],
): Promise<ChecklistResult> {
  const plugins = visiblePlugins(manifest);
  return ctx.ui.custom<ChecklistResult>((tui, theme, _keybindings, done) => {
    const checklist = new PlugChecklist(manifest, plugins, currentSelected, theme, done);
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

export default function zzPlugManager(pi: ExtensionAPI) {
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
          if (ctx.mode === "tui") {
            const selected = await showSelectionChecklist(ctx, manifest, currentSelected);
            if (selected === undefined) return;
            nextSelected = selected;
          } else {
            const current = currentSelected.length > 0 ? currentSelected.join(",") : "none";
            show(pi, `${listText(manifest)}\n\nCurrent selection: ${current}`);
            const answer = await ctx.ui.input(
              "Select zz pi plugs (comma-separated ids/numbers, all, or none; empty keeps current):",
              current,
            );
            if (answer === undefined) return;
            const selection = answer.trim();
            nextSelected = selection ? parsePluginRefs(selection, manifest) : currentSelected;
          }
        } else {
          show(pi, helpText());
          return;
        }

        const result = await applySelection(ctx.cwd, config.sourceUrl, config.zzLibUrl, manifest, nextSelected, flags, ctx.signal);
        show(pi, applyResultText(result, flags.dryRun));
        if (!flags.dryRun && flags.reload && config.autoReload) {
          await ctx.reload();
          return;
        }
      } catch (error) {
        show(pi, `Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}
