import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "import-docs";
const SCOPE_STATUS_KEY = "import-docs-scope";
const SCOPE_ENTRY_TYPE = "import-docs-scope";
const CHILD_PI_AGENT_ENV = "PI_CHILD_PI_AGENT";
const LOCALAGENT_CHILD_ENV = "PI_LOCALAGENT_CHILD";
const INHERITED_SCOPE_ENV = "PI_IMPORT_DOCS_ENABLED_REFERENCES";
const CONFIG_FILE_PATH = ".pi/extensions/import-docs.config.jsonc";
const DEFAULT_METADATA_DIR = "reference/.import-docs";
const GIT_NO_LFS_CONFIG_ARGS = [
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
] as const;

interface ReferenceDefinition {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly upstream: string;
  readonly defaultRef: string;
  readonly target: string;
  readonly overlay: readonly string[];
  readonly pruneManifest: string;
}

interface WorkspaceRoot {
  readonly root: string;
  readonly isGit: boolean;
}

interface PruneResult {
  readonly removed: number;
  readonly matched: number;
  readonly missed: number;
  readonly files: readonly string[];
}

interface GitDiffSummary {
  readonly stat: string;
  readonly untracked: number;
}

interface ImportDocsResult {
  readonly dryRun: boolean;
  readonly sha: string;
  readonly ref: string;
  readonly targetRel: string;
  readonly prune: PruneResult;
  readonly metadataRel?: string;
  readonly diff?: GitDiffSummary;
}

interface ReferenceScopeState {
  readonly enabled: readonly string[];
}

type ScopeAction = "show" | "enable" | "disable" | "toggle";

type ParsedArgs =
  | { readonly action: "list" }
  | { readonly action: "help" }
  | { readonly action: "error"; readonly error: string }
  | {
      readonly action: "scope";
      readonly scopeAction: ScopeAction;
      readonly name: string | undefined;
    }
  | {
      readonly action: "import";
      readonly name: string;
      readonly ref: string | undefined;
      readonly force: boolean;
      readonly dryRun: boolean;
    };

const BABYLONJS_PRUNE = `
.azure-pipelines
.build
.github/workflows
.github/scripts
.github/ISSUE_TEMPLATE
.github/ISSUE_TEMPLATE.md
.github/aw
.github/skills
.github/agents
.githooks
.vscode
scripts
eslint.config.mjs
.prettierrc
.prettierignore
.editorconfig
.hintrc
.npmrc
lerna.json
nx.json
package-lock.json
playwright.config.ts
playwright.browserstack.config.ts
playwright.devhost.config.ts
playwright.es6vis.config.ts
vitest.config.mts
vitest.setup.ts
tsconfig.build.json
tsconfig.test.json
tsconfig.devpackages.json
tsconfig.smartFilters.json
tsdoc.json
CNAME
CNAME.txt
.gitattributes
CHANGELOG.md
CODE_OF_CONDUCT.md
contributing.md
packages/dev/buildTools
packages/tools/tests
packages/tools/testsMemoryLeaks
packages/tools/testTools
packages/tools/eslintBabylonPlugin
packages/tools/devHost
packages/tools/babylonServer
packages/tools/snippetLoader
packages/dev/lottiePlayer
specs
packages/public/rollupUMDHelper.mjs
packages/public/rollupUtils.mjs
packages/public/viteToolsHelper.mjs
packages/**/tsconfig.build.json
packages/**/tsconfig.test.json
packages/**/tsconfig.es6-smoke.json
`.trim();

const BABYLON_DOCS_PRUNE = `
components
pages
styles
lib
__tests__
next.config.js
next-env.d.ts
vitest.config.ts
public
configuration/typedoc.config.ts
package.json
package-lock.json
tsconfig.json
.yarnrc
.prettierrc
.markdownlint.json
.gitattributes
.gitignore
.vscode
.github
`.trim();

const BABYLON_WEBSITE_PRUNE = `
src/_data
src/_includes
src/content
src/pages.njk
build
src/build
static
src/assets
eleventy.config.js
.eleventyignore
scripts
docs
.github
azure-pipelines.yml
azure-pipelines.compiled-demos.yml
package-lock.json
eslint.config.mjs
.prettierrc.json
.prettierignore
.gitignore
.vscode
debug.log
updateTheseFiles.md
`.trim();

const ELECTRON_PRUNE = `
chromium_src
patches
build
buildflags
script
BUILD.gn
DEPS
filenames.auto.gni
filenames.gni
filenames.hunspell.gni
filenames.libcxx.gni
filenames.libcxxabi.gni
tsconfig.script.json
.github
.husky
.devcontainer
.yarn
.yarnrc.yml
yarn.lock
.git-blame-ignore-revs
.clang-format
.clang-tidy
.lint-roller.json
.markdownlint-cli2.jsonc
.autofix.markdownlint-cli2.jsonc
.oxfmtrc.json
.oxlintrc.json
CODE_OF_CONDUCT.md
CONTRIBUTING.md
SECURITY.md
`.trim();

const STEAMWORKS_FFI_NODE_PRUNE = `
.github
`.trim();

const BABYLONFLIER_P2P_PRUNE = `
assets
.directreference
`.trim();

const DEFAULT_REFERENCES: readonly ReferenceDefinition[] = [
  {
    name: "babylonjs",
    aliases: ["babylon", "babylon.js", "babylon-js", "babylon-source"],
    description: "Babylon.js engine source mirror pruned for reference reading",
    upstream: "https://github.com/BabylonJS/Babylon.js.git",
    defaultRef: "master",
    target: "reference/Babylon.js",
    overlay: ["dezverev", "AGENTS.md"],
    pruneManifest: BABYLONJS_PRUNE,
  },
  {
    name: "babylondocs",
    aliases: ["babylon-docs", "babylon-documentation", "documentation"],
    description: "Official Babylon.js markdown documentation",
    upstream: "https://github.com/BabylonJS/Documentation.git",
    defaultRef: "master",
    target: "reference/babylondocs",
    overlay: ["AGENTS.md"],
    pruneManifest: BABYLON_DOCS_PRUNE,
  },
  {
    name: "babylonwebsite",
    aliases: ["babylon-website", "babylon-demos", "website"],
    description: "Babylon website demo sources under src/compiledDemos and src/pureCompiledDemos",
    upstream: "https://github.com/BabylonJS/Website.git",
    defaultRef: "master",
    target: "reference/babylonwebsite",
    overlay: ["AGENTS.md"],
    pruneManifest: BABYLON_WEBSITE_PRUNE,
  },
  {
    name: "electron",
    aliases: ["electronjs"],
    description: "Electron source, docs, typings, tests, and default app",
    upstream: "https://github.com/electron/electron.git",
    defaultRef: "main",
    target: "reference/electron",
    overlay: [],
    pruneManifest: ELECTRON_PRUNE,
  },
  {
    name: "steamworks-ffi-node",
    aliases: ["steamworks", "steamworks-ffi"],
    description: "Koffi-based Node Steamworks FFI wrapper reference",
    upstream: "https://github.com/ArtyProf/steamworks-ffi-node.git",
    defaultRef: "main",
    target: "reference/steamworks-ffi-node",
    overlay: [],
    pruneManifest: STEAMWORKS_FFI_NODE_PRUNE,
  },
  {
    name: "babylonflier-p2p",
    aliases: ["babylonflier", "babylon-flier", "flier-p2p"],
    description: "BabylonFlier P2P game prototype reference",
    upstream: "https://github.com/dezverev/BabylonFlier-P2P.git",
    defaultRef: "main",
    target: "reference/GamePrototype/BabylonFlier-P2P",
    overlay: [],
    pruneManifest: BABYLONFLIER_P2P_PRUNE,
  },
];

let metadataDir = DEFAULT_METADATA_DIR;
let references: readonly ReferenceDefinition[] = DEFAULT_REFERENCES;

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function findReference(name: string): ReferenceDefinition | undefined {
  const normalized = normalizeName(name);
  return references.find((reference) => {
    return (
      reference.name === normalized ||
      reference.aliases.some((alias) => normalizeName(alias) === normalized)
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
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

function parseJsonc(text: string, path: string): unknown {
  try {
    return JSON.parse(stripJsonTrailingCommas(stripJsonComments(text))) as unknown;
  } catch (error) {
    throw new Error(`${path} is not valid JSONC: ${formatError(error)}`);
  }
}

function resolveConfigPath(cwd: string): string {
  let currentDir = resolve(cwd);

  while (true) {
    const candidate = resolve(currentDir, CONFIG_FILE_PATH);
    if (existsSync(candidate)) return candidate;

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return resolve(cwd, CONFIG_FILE_PATH);
    currentDir = parentDir;
  }
}

function referenceFromConfig(value: unknown): ReferenceDefinition {
  if (!isRecord(value)) throw new Error("Each import-docs reference must be an object.");

  const name = getString(value.name)?.trim();
  const description = getString(value.description)?.trim();
  const upstream = getString(value.upstream)?.trim();
  const defaultRef = getString(value.defaultRef)?.trim();
  const target = getString(value.target)?.trim();
  const aliases = getStringArray(value.aliases) ?? [];
  const overlay = getStringArray(value.overlay) ?? [];
  const pruneManifest = getString(value.pruneManifest) ?? getStringArray(value.prune)?.join("\n");

  if (!name || !description || !upstream || !defaultRef || !target) {
    throw new Error(
      "Each import-docs reference needs name, description, upstream, defaultRef, and target.",
    );
  }

  return {
    name: normalizeName(name),
    aliases,
    description,
    upstream,
    defaultRef,
    target,
    overlay,
    pruneManifest: pruneManifest ?? "",
  };
}

function loadImportDocsConfig(cwd: string, onWarning?: (message: string) => void): void {
  metadataDir = DEFAULT_METADATA_DIR;
  references = DEFAULT_REFERENCES;

  const configPath = resolveConfigPath(cwd);
  if (!existsSync(configPath)) return;

  try {
    const parsed = parseJsonc(readFileSync(configPath, "utf8"), CONFIG_FILE_PATH);
    if (!isRecord(parsed)) throw new Error(`${CONFIG_FILE_PATH} must contain a JSON object.`);

    const configuredMetadataDir = getString(parsed.metadataDir)?.trim();
    if (configuredMetadataDir) metadataDir = configuredMetadataDir;

    if (Array.isArray(parsed.references)) {
      const configuredReferences = parsed.references.map(referenceFromConfig);
      if (configuredReferences.length > 0) references = configuredReferences;
    }
  } catch (error) {
    metadataDir = DEFAULT_METADATA_DIR;
    references = DEFAULT_REFERENCES;
    onWarning?.(`import-docs config ignored: ${formatError(error)}`);
  }
}

function parseScopeAction(value: string): ScopeAction | undefined {
  const normalized = normalizeName(value);
  if (normalized === "show" || normalized === "status" || normalized === "enabled") return "show";
  if (normalized === "enable" || normalized === "on") return "enable";
  if (normalized === "disable" || normalized === "off") return "disable";
  if (normalized === "toggle") return "toggle";
  return undefined;
}

function parseScopeArgs(tokens: readonly string[], offset: number): ParsedArgs {
  const first = tokens[offset];
  if (!first) return { action: "scope", scopeAction: "show", name: undefined };

  const scopeAction = parseScopeAction(first);
  if (!scopeAction) {
    return { action: "scope", scopeAction: "toggle", name: first };
  }

  if (scopeAction === "show") return { action: "scope", scopeAction, name: undefined };

  const name = tokens[offset + 1];
  if (!name) {
    return { action: "error", error: `${first} requires a reference name or "all"` };
  }

  return { action: "scope", scopeAction, name };
}

function parseImportArgs(args: string): ParsedArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];

  if (!first) return { action: "list" };

  const command = normalizeName(first);
  if (command === "list" || command === "ls" || command === "<list>") {
    return { action: "list" };
  }
  if (command === "help" || command === "--help" || command === "-h") {
    return { action: "help" };
  }
  if (command === "scope" || command === "status" || command === "enabled" || command === "refs") {
    return parseScopeArgs(tokens, 1);
  }

  const directScopeAction = parseScopeAction(command);
  if (directScopeAction && directScopeAction !== "show") {
    const name = tokens[1];
    if (!name) return { action: "error", error: `${first} requires a reference name or "all"` };
    return { action: "scope", scopeAction: directScopeAction, name };
  }

  let ref: string | undefined;
  let force = false;
  let dryRun = false;

  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;

    if (token === "--force") {
      force = true;
      continue;
    }

    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (token === "--ref") {
      const value = tokens[index + 1];
      if (!value) return { action: "error", error: "--ref requires a branch, tag, or SHA" };
      ref = value;
      index++;
      continue;
    }

    if (token.startsWith("--ref=")) {
      const value = token.slice("--ref=".length);
      if (!value) return { action: "error", error: "--ref requires a branch, tag, or SHA" };
      ref = value;
      continue;
    }

    return { action: "error", error: `Unknown option: ${token}` };
  }

  return { action: "import", name: first, ref, force, dryRun };
}

function formatReferenceList(): string {
  const lines = [
    "Supported /import-docs references:",
    ...references.map((reference) => {
      const aliases =
        reference.aliases.length > 0 ? ` aliases: ${reference.aliases.join(", ")}` : "";
      return `- ${reference.name} -> ${reference.target} (${reference.defaultRef});${aliases}\n  ${reference.description}`;
    }),
    "",
    "Usage: /import-docs <name> [--ref <branch|tag|sha>] [--dry-run] [--force]",
    "Scope: /import-docs scope | enable <name> | disable <name> | toggle <name>",
  ];
  return lines.join("\n");
}

function formatHelp(): string {
  return [
    "Import supported upstream docs/source repos into this repo's reference/ folder.",
    "",
    "Usage:",
    "  /import-docs list",
    "  /import-docs babylonjs",
    "  /import-docs babylondocs --dry-run",
    "  /import-docs electron --ref v39.2.6 --force",
    "  /import-docs scope",
    "  /import-docs enable babylondocs",
    "  /import-docs disable all",
    "",
    "Targets are repo-relative (for example reference/Babylon.js), so the extension can be copied to another repo.",
    "Reference scope is opt-in per chat session. Imported references are off by default; enable only the docs/source trees that are relevant.",
    "Existing import targets are replaced after preserving configured overlay entries. In a Git repo, dirty target files require --force.",
  ].join("\n");
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function commandFailure(command: string, args: readonly string[], result: ExecResult): Error {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  const details = output ? `\n${truncate(output, 4_000)}` : "";
  return new Error(`${formatCommand(command, args)} exited with code ${result.code}${details}`);
}

async function runChecked(
  pi: ExtensionAPI,
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const result = await pi.exec(command, [...args], options);
  if (result.code !== 0) throw commandFailure(command, args, result);
  return result;
}

async function resolveWorkspaceRoot(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<WorkspaceRoot> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: ctx.cwd,
    timeout: 5_000,
  });

  const root = result.stdout.trim();
  if (result.code === 0 && root) return { root, isGit: true };
  return { root: ctx.cwd, isGit: false };
}

function repoPathToAbsolute(repoRoot: string, repoPath: string): string {
  if (repoPath.includes("\0") || isAbsolute(repoPath) || repoPath.startsWith("..")) {
    throw new Error(`Unsafe repo-relative path: ${repoPath}`);
  }

  const resolved = resolve(repoRoot, ...repoPath.split("/").filter(Boolean));
  const relativePath = relative(repoRoot, resolved);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Repo-relative path escapes the repo: ${repoPath}`);
  }

  return resolved;
}

function toPosixPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function findWorkspaceRootSync(cwd: string): string {
  let current = resolve(cwd);

  while (true) {
    if (existsSync(join(current, ".git"))) return current;

    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function referenceAbsPath(repoRoot: string, reference: ReferenceDefinition): string {
  return repoPathToAbsolute(repoRoot, reference.target);
}

function getInstalledReferences(repoRoot: string): ReferenceDefinition[] {
  return references.filter((reference) => existsSync(referenceAbsPath(repoRoot, reference)));
}

function isReferenceEnabled(
  reference: ReferenceDefinition,
  enabledReferenceNames: ReadonlySet<string>,
): boolean {
  return enabledReferenceNames.has(reference.name);
}

function isPathInsideOrEqual(pathRel: string, targetRel: string): boolean {
  return pathRel === targetRel || pathRel.startsWith(`${targetRel}/`);
}

function isPathAncestorOrEqual(pathRel: string, targetRel: string): boolean {
  return (
    pathRel === "." ||
    pathRel === "" ||
    targetRel === pathRel ||
    targetRel.startsWith(`${pathRel}/`)
  );
}

function isUnderReferenceFolder(pathRel: string): boolean {
  return pathRel === "reference" || pathRel.startsWith("reference/");
}

function normalizeToolPath(
  rawPath: string | undefined,
  ctx: ExtensionContext,
  repoRoot: string,
): string | undefined {
  const input = (rawPath ?? ".").trim();
  const withoutAt = input.startsWith("@") ? input.slice(1) : input;
  const normalizedInput = withoutAt === "" ? "." : withoutAt;

  const absolute = isAbsolute(normalizedInput)
    ? normalizedInput
    : normalizedInput === "reference" || normalizedInput.startsWith("reference/")
      ? resolve(repoRoot, normalizedInput)
      : resolve(ctx.cwd, normalizedInput);

  const rel = relative(repoRoot, absolute);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return toPosixPath(rel);
}

function getPathInputForScopedTool(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;

  if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName)) {
    return getString(input.path);
  }

  return undefined;
}

function formatReferenceNames(references: readonly ReferenceDefinition[]): string {
  if (references.length === 0) return "none";
  return references.map((reference) => reference.name).join(", ");
}

function formatReferenceScopeStatus(
  repoRoot: string,
  enabledReferenceNames: ReadonlySet<string>,
): string {
  const installed = getInstalledReferences(repoRoot);
  const missing = references.filter((reference) => !installed.includes(reference));

  const lines = [
    "Reference scope for this chat session:",
    "Imported references are off by default. Enable only the ones relevant to the current task.",
    "",
  ];

  if (installed.length === 0) {
    lines.push("No supported /import-docs references are imported yet.");
  } else {
    for (const reference of installed) {
      const state = isReferenceEnabled(reference, enabledReferenceNames) ? "ON " : "off";
      lines.push(`- [${state}] ${reference.name} -> ${reference.target}`);
    }
  }

  if (missing.length > 0) {
    lines.push("", `Not imported: ${missing.map((reference) => reference.name).join(", ")}`);
  }

  lines.push(
    "",
    "Commands: /import-docs enable <name>, /import-docs disable <name>, /import-docs toggle <name>",
  );
  return lines.join("\n");
}

function parseInheritedScopeEnv(): string[] {
  const isChildAgent =
    process.env[CHILD_PI_AGENT_ENV] === "1" || process.env[LOCALAGENT_CHILD_ENV] === "1";
  if (!isChildAgent) return [];

  const raw = process.env[INHERITED_SCOPE_ENV]?.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    // Fall back to comma-separated values below.
  }

  return raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function buildReferenceScopePrompt(
  repoRoot: string,
  enabledReferenceNames: ReadonlySet<string>,
): string {
  const installed = getInstalledReferences(repoRoot);
  if (installed.length === 0) return "";

  const enabled = installed.filter((reference) =>
    isReferenceEnabled(reference, enabledReferenceNames),
  );
  const disabled = installed.filter(
    (reference) => !isReferenceEnabled(reference, enabledReferenceNames),
  );

  const lines = [
    "<reference_scope>",
    "Reference projects under reference/ are explicit opt-in for this chat session.",
    "Do not read, search, list, summarize, cite, or otherwise use disabled reference projects.",
    "Avoid broad searches over reference/; target enabled reference paths directly when reference material is needed.",
    `Enabled references: ${enabled.length === 0 ? "none" : ""}`,
  ];

  for (const reference of enabled) {
    lines.push(`- ${reference.name}: ${reference.target}`);
  }

  lines.push(`Disabled references: ${disabled.length === 0 ? "none" : ""}`);
  for (const reference of disabled) {
    lines.push(`- ${reference.name}: ${reference.target}`);
  }

  lines.push(
    "Toggle with /import-docs enable <name> or /import-docs disable <name>.",
    "</reference_scope>",
  );
  return lines.join("\n");
}

function disabledReferencePathReason(
  toolName: string,
  pathRel: string,
  installedReferences: readonly ReferenceDefinition[],
  enabledReferenceNames: ReadonlySet<string>,
): string | undefined {
  const disabledInside = installedReferences.find((reference) => {
    return (
      !isReferenceEnabled(reference, enabledReferenceNames) &&
      isPathInsideOrEqual(pathRel, reference.target)
    );
  });

  if (disabledInside) {
    return `${toolName} blocked: ${disabledInside.name} is currently out of reference scope. Use /import-docs enable ${disabledInside.name} to opt it in for this chat session.`;
  }

  const enabledInside = installedReferences.some((reference) => {
    return (
      isReferenceEnabled(reference, enabledReferenceNames) &&
      isPathInsideOrEqual(pathRel, reference.target)
    );
  });
  if (enabledInside) return undefined;

  const disabledUnderPath = installedReferences.filter((reference) => {
    return (
      !isReferenceEnabled(reference, enabledReferenceNames) &&
      isPathAncestorOrEqual(pathRel, reference.target)
    );
  });

  if ((toolName === "grep" || toolName === "find") && disabledUnderPath.length > 0) {
    return `${toolName} blocked: ${pathRel} would include disabled reference project(s): ${formatReferenceNames(disabledUnderPath)}. Narrow the search outside reference/ or enable the needed reference.`;
  }

  if (toolName === "ls" && pathRel === "reference" && disabledUnderPath.length > 0) {
    return `ls blocked: reference/ contains disabled reference project(s): ${formatReferenceNames(disabledUnderPath)}. Enable the needed reference first.`;
  }

  if (isUnderReferenceFolder(pathRel)) {
    return `${toolName} blocked: ${pathRel} is under reference/ but is not part of an enabled reference scope.`;
  }

  return undefined;
}

function normalizeCommandForReferenceScope(command: string): string {
  return command.replaceAll("@reference", "reference").replaceAll("./reference", "reference");
}

function commandMentionsReferenceTarget(command: string, reference: ReferenceDefinition): boolean {
  return command.includes(reference.target);
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }

    if (";|&".includes(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      words.push(char);
      continue;
    }

    current += char;
  }

  if (current) words.push(current);
  return words;
}

function commandName(word: string): string {
  const lastSlash = word.lastIndexOf("/");
  return lastSlash >= 0 ? word.slice(lastSlash + 1) : word;
}

function optionConsumesNextArg(option: string): boolean {
  return [
    "-e",
    "--regexp",
    "-g",
    "--glob",
    "--iglob",
    "-t",
    "--type",
    "-T",
    "--type-not",
    "--ignore-file",
    "--path-separator",
    "--encoding",
    "--sort",
    "--sortr",
    "-m",
    "--max-count",
    "-C",
    "--context",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
  ].includes(option);
}

function commandHasReferenceExclude(command: string): boolean {
  return (
    command.includes("!reference/**") ||
    command.includes("!reference/*") ||
    (command.includes("reference/**") && command.includes("--exclude"))
  );
}

function rgLikePathCandidates(args: readonly string[]): string[] {
  const paths: string[] = [];
  let patternSeen = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === "--") {
      paths.push(...args.slice(index + 1));
      break;
    }

    if (arg === "--files") {
      patternSeen = true;
      continue;
    }

    if (arg.startsWith("--regexp=") || arg.startsWith("-e")) {
      patternSeen = true;
      if (arg === "-e" || arg === "--regexp") index++;
      continue;
    }

    if (arg.startsWith("-")) {
      if (optionConsumesNextArg(arg)) index++;
      continue;
    }

    if (!patternSeen) {
      patternSeen = true;
      continue;
    }

    paths.push(arg);
  }

  return paths;
}

function findPathCandidates(args: readonly string[]): string[] {
  const paths: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("-") || arg === "(" || arg === ")" || arg === "!") break;
    paths.push(arg);
  }

  return paths.length > 0 ? paths : ["."];
}

function grepPathCandidates(args: readonly string[]): string[] | undefined {
  if (!args.some((arg) => /^-[^-]*[Rr]/u.test(arg) || arg === "--recursive")) return undefined;
  return rgLikePathCandidates(args);
}

function pathCandidatesIncludeDisabledReferences(
  candidates: readonly string[],
  ctx: ExtensionContext,
  repoRoot: string,
  disabledReferences: readonly ReferenceDefinition[],
): boolean {
  const effectiveCandidates = candidates.length > 0 ? candidates : ["."];

  return effectiveCandidates.some((candidate) => {
    const pathRel = normalizeToolPath(candidate, ctx, repoRoot);
    if (!pathRel) return false;

    return disabledReferences.some((reference) => {
      return (
        isPathAncestorOrEqual(pathRel, reference.target) ||
        isPathInsideOrEqual(pathRel, reference.target)
      );
    });
  });
}

function pathCandidatesDirectlyAccessDisabledReferences(
  candidates: readonly string[],
  ctx: ExtensionContext,
  repoRoot: string,
  disabledReferences: readonly ReferenceDefinition[],
): boolean {
  return candidates.some((candidate) => {
    const pathRel = normalizeToolPath(candidate, ctx, repoRoot);
    if (!pathRel) return false;
    if (pathRel === "reference") return disabledReferences.length > 0;

    return disabledReferences.some((reference) => isPathInsideOrEqual(pathRel, reference.target));
  });
}

function shellArgsAfter(words: readonly string[], commandIndex: number): string[] {
  const args: string[] = [];

  for (const word of words.slice(commandIndex + 1)) {
    if (";|&".includes(word)) break;
    args.push(word);
  }

  return args;
}

function simplePathCommandCandidates(
  command: string,
  args: readonly string[],
): string[] | undefined {
  const pathCommands = new Set([
    "ls",
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "wc",
    "stat",
    "file",
    "cd",
    "pushd",
  ]);
  if (!pathCommands.has(command)) return undefined;

  const paths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--") {
      paths.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("-")) continue;
    paths.push(arg);
  }

  return paths;
}

function simplePathCommandBlockReason(
  commandNameValue: string,
  candidates: readonly string[] | undefined,
  ctx: ExtensionContext,
  repoRoot: string,
  disabledReferences: readonly ReferenceDefinition[],
): string | undefined {
  if (!candidates || candidates.length === 0) return undefined;

  if (
    pathCandidatesDirectlyAccessDisabledReferences(candidates, ctx, repoRoot, disabledReferences)
  ) {
    return `bash blocked: this ${commandNameValue} command would access disabled reference project(s): ${formatReferenceNames(disabledReferences)}. Enable the needed reference first.`;
  }

  return undefined;
}

function broadBashSearchBlockReason(
  command: string,
  ctx: ExtensionContext,
  repoRoot: string,
  disabledReferences: readonly ReferenceDefinition[],
): string | undefined {
  if (commandHasReferenceExclude(command)) return undefined;

  const words = splitShellWords(command);
  for (let index = 0; index < words.length; index++) {
    const name = commandName(words[index] ?? "");
    const args = shellArgsAfter(words, index);

    const pathCommandReason = simplePathCommandBlockReason(
      name,
      simplePathCommandCandidates(name, args),
      ctx,
      repoRoot,
      disabledReferences,
    );
    if (pathCommandReason) return pathCommandReason;

    let candidates: string[] | undefined;
    if (name === "rg" || name === "fd") {
      candidates = rgLikePathCandidates(args);
    } else if (name === "find") {
      candidates = findPathCandidates(args);
    } else if (name === "grep") {
      candidates = grepPathCandidates(args);
    }

    if (
      candidates &&
      pathCandidatesIncludeDisabledReferences(candidates, ctx, repoRoot, disabledReferences)
    ) {
      return `bash blocked: this ${name} command could traverse disabled reference project(s): ${formatReferenceNames(disabledReferences)}. Target non-reference paths, add a reference/ exclude, or enable the needed reference.`;
    }
  }

  return undefined;
}

function bashReferenceScopeBlockReason(
  command: string,
  ctx: ExtensionContext,
  repoRoot: string,
  enabledReferenceNames: ReadonlySet<string>,
): string | undefined {
  const installed = getInstalledReferences(repoRoot);
  const disabled = installed.filter(
    (reference) => !isReferenceEnabled(reference, enabledReferenceNames),
  );
  if (disabled.length === 0) return undefined;

  const normalized = normalizeCommandForReferenceScope(command);
  const disabledMention = disabled.find((reference) =>
    commandMentionsReferenceTarget(normalized, reference),
  );
  if (disabledMention) {
    return `bash blocked: ${disabledMention.name} is currently out of reference scope. Use /import-docs enable ${disabledMention.name} to opt it in for this chat session.`;
  }

  const broadSearchReason = broadBashSearchBlockReason(normalized, ctx, repoRoot, disabled);
  if (broadSearchReason) return broadSearchReason;

  return undefined;
}

function toolReferenceScopeBlockReason(
  toolName: string,
  input: unknown,
  ctx: ExtensionContext,
  enabledReferenceNames: ReadonlySet<string>,
): string | undefined {
  const repoRoot = findWorkspaceRootSync(ctx.cwd);

  if (toolName === "bash" && isRecord(input)) {
    const command = getString(input.command);
    return command
      ? bashReferenceScopeBlockReason(command, ctx, repoRoot, enabledReferenceNames)
      : undefined;
  }

  const rawPath = getPathInputForScopedTool(toolName, input);
  if (rawPath === undefined && !["grep", "find", "ls"].includes(toolName)) return undefined;

  const pathRel = normalizeToolPath(rawPath, ctx, repoRoot);
  if (!pathRel) return undefined;

  const installed = getInstalledReferences(repoRoot);
  if (installed.length === 0) return undefined;

  return disabledReferencePathReason(toolName, pathRel, installed, enabledReferenceNames);
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertCleanImportPaths(
  pi: ExtensionAPI,
  workspace: WorkspaceRoot,
  pathsRel: readonly string[],
  targetAbs: string,
  force: boolean,
): Promise<void> {
  if (workspace.isGit) {
    const status = await runChecked(pi, "git", ["status", "--porcelain", "--", ...pathsRel], {
      cwd: workspace.root,
      timeout: 10_000,
    });
    if (status.stdout.trim() && !force) {
      throw new Error(
        `${pathsRel.join(", ")} has uncommitted changes. Commit/stash them or rerun /import-docs with --force.`,
      );
    }
    return;
  }

  if ((await directoryHasEntries(targetAbs)) && !force) {
    throw new Error(
      `${pathsRel[0] ?? "reference target"} already exists. Rerun /import-docs with --force to replace it.`,
    );
  }
}

async function cloneUpstream(
  pi: ExtensionAPI,
  reference: ReferenceDefinition,
  ref: string,
  tmp: string,
): Promise<{ readonly clonePath: string; readonly sha: string }> {
  const clonePath = join(tmp, "src");
  const shallowBranchCloneArgs = [
    ...GIT_NO_LFS_CONFIG_ARGS,
    "clone",
    "--quiet",
    "--depth=1",
    "--branch",
    ref,
    "--single-branch",
    reference.upstream,
    clonePath,
  ];

  const branchClone = await pi.exec("git", shallowBranchCloneArgs, { cwd: tmp });
  if (branchClone.code !== 0) {
    await rm(clonePath, { recursive: true, force: true });
    await runChecked(
      pi,
      "git",
      [...GIT_NO_LFS_CONFIG_ARGS, "clone", "--quiet", "--depth=1", reference.upstream, clonePath],
      { cwd: tmp },
    );
    await runChecked(pi, "git", ["fetch", "--quiet", "--depth=1", "origin", ref], {
      cwd: clonePath,
    });
    await runChecked(pi, "git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], {
      cwd: clonePath,
    });
  }

  const sha = (
    await runChecked(pi, "git", ["rev-parse", "HEAD"], { cwd: clonePath })
  ).stdout.trim();
  return { clonePath, sha };
}

async function moveOverlayAside(
  reference: ReferenceDefinition,
  targetAbs: string,
  stashAbs: string,
): Promise<void> {
  for (const entry of reference.overlay) {
    const source = join(targetAbs, entry);
    if (!existsSync(source)) continue;

    const destination = join(stashAbs, entry);
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
  }
}

async function wipeTarget(targetAbs: string): Promise<void> {
  await mkdir(targetAbs, { recursive: true });
  const entries = await readdir(targetAbs);
  await Promise.all(
    entries.map((entry) => rm(join(targetAbs, entry), { recursive: true, force: true })),
  );
}

async function copyUpstreamInto(clonePath: string, targetAbs: string): Promise<void> {
  await mkdir(targetAbs, { recursive: true });
  const entries = await readdir(clonePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    await cp(join(clonePath, entry.name), join(targetAbs, entry.name), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

async function restoreOverlay(
  reference: ReferenceDefinition,
  targetAbs: string,
  stashAbs: string,
): Promise<void> {
  for (const entry of reference.overlay) {
    const stashed = join(stashAbs, entry);
    if (!existsSync(stashed)) continue;

    const destination = join(targetAbs, entry);
    if (existsSync(destination)) await rm(destination, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true });
    await rename(stashed, destination);
  }
}

function parseManifest(manifest: string): string[] {
  return manifest
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter(Boolean);
}

function patternToRegex(pattern: string): RegExp {
  let regex = "";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];
    if (!char) break;

    if (char === "*" && pattern[index + 1] === "*") {
      regex += ".*";
      index += 2;
      if (pattern[index] === "/") index++;
      continue;
    }

    if (char === "*") {
      regex += "[^/]*";
      index++;
      continue;
    }

    if (".+?^$(){}|[]\\".includes(char)) {
      regex += `\\${char}`;
      index++;
      continue;
    }

    regex += char;
    index++;
  }

  return new RegExp(`^${regex}$`, "u");
}

function matchManifestEntry(entry: string, relFiles: readonly string[]): string[] {
  if (entry.includes("*")) {
    const regex = patternToRegex(entry);
    return relFiles.filter((file) => regex.test(file));
  }

  return relFiles.filter((file) => file === entry || file.startsWith(`${entry}/`));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        output.push(absolute);
      }
    }
  }

  await walk(root);
  return output;
}

async function pruneEmptyDirs(root: string): Promise<void> {
  async function visit(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    let kept = 0;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const stillThere = await visit(join(dir, entry.name));
        if (stillThere) kept++;
      } else {
        kept++;
      }
    }

    if (kept === 0 && dir !== root) {
      await rm(dir, { recursive: true, force: true });
      return false;
    }

    return true;
  }

  await visit(root);
}

async function pruneReference(options: {
  readonly targetDir: string;
  readonly manifest: string;
  readonly dryRun: boolean;
}): Promise<PruneResult> {
  if (!(await pathExists(options.targetDir))) {
    throw new Error(`Prune target does not exist: ${options.targetDir}`);
  }

  const entries = parseManifest(options.manifest);
  const absFiles = await walkFiles(options.targetDir);
  const relFiles = absFiles.map((file) => toPosixPath(relative(options.targetDir, file)));
  const toDelete = new Set<string>();
  let matched = 0;
  let missed = 0;

  for (const entry of entries) {
    const hits = matchManifestEntry(entry, relFiles);
    if (hits.length === 0) {
      missed++;
      continue;
    }

    matched++;
    hits.forEach((hit) => toDelete.add(hit));
  }

  const files = [...toDelete].sort();
  if (!options.dryRun) {
    for (const file of files) {
      await rm(join(options.targetDir, file), { force: true });
    }
    await pruneEmptyDirs(options.targetDir);
  }

  return {
    removed: options.dryRun ? 0 : files.length,
    matched,
    missed,
    files,
  };
}

async function writeMetadata(options: {
  readonly repoRoot: string;
  readonly metadataRel: string;
  readonly reference: ReferenceDefinition;
  readonly sha: string;
  readonly ref: string;
  readonly targetRel: string;
}): Promise<void> {
  const metadataPath = repoPathToAbsolute(options.repoRoot, options.metadataRel);
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(
    metadataPath,
    [
      `name=${options.reference.name}`,
      `upstream=${options.reference.upstream}`,
      `target=${options.targetRel}`,
      `defaultRef=${options.reference.defaultRef}`,
      `ref=${options.ref}`,
      `sha=${options.sha}`,
      `importedAt=${new Date().toISOString()}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function summarizeGitDiff(
  pi: ExtensionAPI,
  workspace: WorkspaceRoot,
  paths: readonly string[],
): Promise<GitDiffSummary | undefined> {
  if (!workspace.isGit) return undefined;

  const diff = await pi.exec("git", ["diff", "--shortstat", "--", ...paths], {
    cwd: workspace.root,
    timeout: 10_000,
  });
  const untracked = await pi.exec(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", ...paths],
    {
      cwd: workspace.root,
      timeout: 10_000,
    },
  );

  const untrackedCount = untracked.stdout.split("\n").filter(Boolean).length;
  return {
    stat: diff.code === 0 ? diff.stdout.trim() : "",
    untracked: untracked.code === 0 ? untrackedCount : 0,
  };
}

async function importReference(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  reference: ReferenceDefinition,
  options: { readonly ref: string | undefined; readonly force: boolean; readonly dryRun: boolean },
): Promise<ImportDocsResult> {
  const workspace = await resolveWorkspaceRoot(pi, ctx);
  const targetAbs = repoPathToAbsolute(workspace.root, reference.target);
  const targetRel = toPosixPath(relative(workspace.root, targetAbs));
  const metadataRel = `${metadataDir}/${reference.name}.UPSTREAM`;
  const ref = options.ref ?? reference.defaultRef;

  if (!options.dryRun) {
    await assertCleanImportPaths(pi, workspace, [targetRel, metadataRel], targetAbs, options.force);
  }

  const tmp = await mkdtemp(join(tmpdir(), `pi-import-docs-${reference.name}-`));
  try {
    const { clonePath, sha } = await cloneUpstream(pi, reference, ref, tmp);

    if (options.dryRun) {
      const prune = await pruneReference({
        targetDir: clonePath,
        manifest: reference.pruneManifest,
        dryRun: true,
      });
      return { dryRun: true, sha, ref, targetRel, prune };
    }

    const stashAbs = join(tmp, "overlay-stash");
    await mkdir(stashAbs, { recursive: true });
    let overlayMoved = false;
    try {
      await moveOverlayAside(reference, targetAbs, stashAbs);
      overlayMoved = true;
      await wipeTarget(targetAbs);
      await copyUpstreamInto(clonePath, targetAbs);
      await restoreOverlay(reference, targetAbs, stashAbs);
      overlayMoved = false;
    } catch (error: unknown) {
      if (overlayMoved) await restoreOverlay(reference, targetAbs, stashAbs);
      throw error;
    }

    const prune = await pruneReference({
      targetDir: targetAbs,
      manifest: reference.pruneManifest,
      dryRun: false,
    });
    await writeMetadata({
      repoRoot: workspace.root,
      metadataRel,
      reference,
      sha,
      ref,
      targetRel,
    });

    const diff = await summarizeGitDiff(pi, workspace, [targetRel, metadataRel]);
    const result = { dryRun: false, sha, ref, targetRel, prune, metadataRel };
    return diff ? { ...result, diff } : result;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function formatImportResult(reference: ReferenceDefinition, result: ImportDocsResult): string {
  const shortSha = result.sha.slice(0, 12);
  if (result.dryRun) {
    return [
      `Dry-run complete for ${reference.name} @ ${result.ref} (${shortSha}).`,
      `Target: ${result.targetRel}`,
      `Prune would remove ${result.prune.files.length} file(s) (${result.prune.matched} patterns matched, ${result.prune.missed} missed).`,
    ].join("\n");
  }

  const lines = [
    `Imported ${reference.name} @ ${result.ref} (${shortSha}) into ${result.targetRel}.`,
    `Pruned ${result.prune.removed} file(s) (${result.prune.matched} patterns matched, ${result.prune.missed} missed).`,
  ];

  if (result.metadataRel) lines.push(`Metadata: ${result.metadataRel}`);
  if (result.diff?.stat) lines.push(`Diff: ${result.diff.stat}`);
  if (result.diff && result.diff.untracked > 0) {
    lines.push(`${result.diff.untracked} untracked file(s) under imported paths.`);
  }

  return lines.join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function importDocsExtension(pi: ExtensionAPI) {
  let enabledReferenceNames = new Set<string>();

  function sortedEnabledReferenceNames(): string[] {
    return [...enabledReferenceNames].sort();
  }

  function persistScopeState(): void {
    pi.appendEntry<ReferenceScopeState>(SCOPE_ENTRY_TYPE, {
      enabled: sortedEnabledReferenceNames(),
    });
  }

  function applyScopeStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    const repoRoot = findWorkspaceRootSync(ctx.cwd);
    const enabledInstalled = getInstalledReferences(repoRoot).filter((reference) => {
      return isReferenceEnabled(reference, enabledReferenceNames);
    });

    ctx.ui.setStatus(
      SCOPE_STATUS_KEY,
      enabledInstalled.length > 0
        ? `refs: ${enabledInstalled.map((reference) => reference.name).join(",")}`
        : "refs: off",
    );
  }

  function restoreScopeFromBranch(ctx: ExtensionContext): void {
    let saved: readonly string[] | undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== SCOPE_ENTRY_TYPE) continue;
      if (!isRecord(entry.data) || !Array.isArray(entry.data.enabled)) continue;

      saved = entry.data.enabled.filter((value): value is string => typeof value === "string");
    }

    enabledReferenceNames = new Set(
      (saved ?? [])
        .map((name) => findReference(name)?.name)
        .filter((name): name is string => typeof name === "string"),
    );

    for (const inheritedName of parseInheritedScopeEnv()) {
      const reference = findReference(inheritedName);
      if (reference) enabledReferenceNames.add(reference.name);
    }

    applyScopeStatus(ctx);
  }

  function resolveScopeTargets(
    name: string | undefined,
    ctx: ExtensionCommandContext,
  ): ReferenceDefinition[] | string {
    const repoRoot = findWorkspaceRootSync(ctx.cwd);
    const installed = getInstalledReferences(repoRoot);

    if (!name) return "Missing reference name. Use /import-docs scope to list imported references.";
    if (normalizeName(name) === "all") return installed;

    const reference = findReference(name);
    if (!reference) return `Unknown reference: ${name}`;
    if (!installed.includes(reference)) {
      return `${reference.name} is not imported yet. Import it with /import-docs ${reference.name}.`;
    }

    return [reference];
  }

  function updateScope(
    parsed: Extract<ParsedArgs, { readonly action: "scope" }>,
    ctx: ExtensionCommandContext,
  ): void {
    if (parsed.scopeAction === "show") {
      ctx.ui.notify(
        formatReferenceScopeStatus(findWorkspaceRootSync(ctx.cwd), enabledReferenceNames),
        "info",
      );
      applyScopeStatus(ctx);
      return;
    }

    const targets = resolveScopeTargets(parsed.name, ctx);
    if (typeof targets === "string") {
      ctx.ui.notify(targets, "error");
      return;
    }

    if (targets.length === 0) {
      ctx.ui.notify("No supported references are imported yet.", "warning");
      return;
    }

    for (const reference of targets) {
      if (parsed.scopeAction === "enable") {
        enabledReferenceNames.add(reference.name);
      } else if (parsed.scopeAction === "disable") {
        enabledReferenceNames.delete(reference.name);
      } else if (enabledReferenceNames.has(reference.name)) {
        enabledReferenceNames.delete(reference.name);
      } else {
        enabledReferenceNames.add(reference.name);
      }
    }

    persistScopeState();
    applyScopeStatus(ctx);
    ctx.ui.notify(
      formatReferenceScopeStatus(findWorkspaceRootSync(ctx.cwd), enabledReferenceNames),
      "info",
    );
  }

  function commandCompletions(prefix: string) {
    const trimmedLeft = prefix.trimStart();
    const hasTrailingSpace = /\s$/u.test(prefix);
    const tokens = trimmedLeft.split(/\s+/u).filter(Boolean);
    const first = tokens[0];
    const second = tokens[1];
    const referenceItems = ["all", ...references.map((reference) => reference.name)];

    function filteredItems(items: readonly string[], value: string) {
      const filtered = items.filter((item) => item.startsWith(value.toLowerCase()));
      return filtered.length > 0 ? filtered.map((item) => ({ value: item, label: item })) : null;
    }

    if (!first || (tokens.length === 1 && !hasTrailingSpace)) {
      return filteredItems(
        [
          "list",
          "scope",
          "enable",
          "disable",
          "toggle",
          ...references.map((reference) => reference.name),
        ],
        first ?? "",
      );
    }

    if (first === "scope" && (!second || (tokens.length === 2 && !hasTrailingSpace))) {
      return filteredItems(["enable", "disable", "toggle", ...referenceItems], second ?? "");
    }

    const scopeAction =
      first === "scope" ? parseScopeAction(second ?? "") : parseScopeAction(first);
    if (scopeAction && scopeAction !== "show") {
      const current = first === "scope" ? (tokens[2] ?? "") : (second ?? "");
      return filteredItems(referenceItems, current);
    }

    return null;
  }

  pi.on("session_start", (_event, ctx) => {
    loadImportDocsConfig(ctx.cwd, (message) => ctx.ui.notify(message, "warning"));
    restoreScopeFromBranch(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    loadImportDocsConfig(ctx.cwd, (message) => ctx.ui.notify(message, "warning"));
    restoreScopeFromBranch(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    applyScopeStatus(ctx);
    const scopePrompt = buildReferenceScopePrompt(
      findWorkspaceRootSync(ctx.cwd),
      enabledReferenceNames,
    );
    if (!scopePrompt) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${scopePrompt}`,
    };
  });

  pi.on("tool_call", (event, ctx) => {
    const reason = toolReferenceScopeBlockReason(
      event.toolName,
      event.input,
      ctx,
      enabledReferenceNames,
    );
    return reason ? { block: true, reason } : undefined;
  });

  pi.registerCommand("import-docs", {
    description: "Import docs/source references and opt them into repo-relative reference/ scope",
    getArgumentCompletions: commandCompletions,
    handler: async (args, ctx) => {
      loadImportDocsConfig(ctx.cwd, (message) => ctx.ui.notify(message, "warning"));
      const parsed = parseImportArgs(args);

      if (parsed.action === "list") {
        ctx.ui.notify(formatReferenceList(), "info");
        return;
      }

      if (parsed.action === "help") {
        ctx.ui.notify(formatHelp(), "info");
        return;
      }

      if (parsed.action === "error") {
        ctx.ui.notify(`${parsed.error}\n\n${formatHelp()}`, "error");
        return;
      }

      if (parsed.action === "scope") {
        updateScope(parsed, ctx);
        return;
      }

      const reference = findReference(parsed.name);
      if (!reference) {
        ctx.ui.notify(
          `Unknown import-docs reference: ${parsed.name}\n\n${formatReferenceList()}`,
          "error",
        );
        return;
      }

      ctx.ui.setStatus(STATUS_KEY, "import-docs: waiting for idle");
      try {
        await ctx.waitForIdle();
        ctx.ui.setStatus(
          STATUS_KEY,
          parsed.dryRun
            ? `import-docs: dry-run ${reference.name}`
            : `import-docs: importing ${reference.name}`,
        );
        const result = await importReference(pi, ctx, reference, parsed);
        ctx.ui.notify(formatImportResult(reference, result), "info");
        applyScopeStatus(ctx);
      } catch (error: unknown) {
        ctx.ui.notify(`import-docs failed: ${formatError(error)}`, "error");
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}

export const __test = {
  buildReferenceScopePrompt,
  findReference,
  formatReferenceScopeStatus,
  parseImportArgs,
  parseInheritedScopeEnv,
  toolReferenceScopeBlockReason,
};
