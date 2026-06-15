import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  getBooleanField,
  getErrorMessage,
  getStringArrayField,
  getStringField,
  readJsoncConfig,
} from "./zz-lib/jsonc-config.ts";

const CONFIG_FILE_PATH = ".pi/extensions/pi-context.config.jsonc";

interface PiContextConfig {
  readonly contextFilenames: readonly string[];
  readonly includeAncestorContext: boolean;
  readonly includeGlobalContext: boolean;
  readonly insertBeforeMarker: string;
  readonly stripBuiltInProjectContext: boolean;
}

const DEFAULT_CONFIG: PiContextConfig = {
  contextFilenames: ["PI.md", "PI.MD"],
  includeAncestorContext: true,
  includeGlobalContext: true,
  insertBeforeMarker: "\nCurrent date:",
  stripBuiltInProjectContext: true,
};

let currentConfig: PiContextConfig = { ...DEFAULT_CONFIG };

interface ContextFile {
  readonly path: string;
  readonly content: string;
}

function loadConfig(ctx: ExtensionContext): void {
  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, ctx.cwd);
    currentConfig = record
      ? {
          contextFilenames:
            getStringArrayField(record, "contextFilenames") ?? DEFAULT_CONFIG.contextFilenames,
          includeAncestorContext:
            getBooleanField(record, "includeAncestorContext") ??
            DEFAULT_CONFIG.includeAncestorContext,
          includeGlobalContext:
            getBooleanField(record, "includeGlobalContext") ?? DEFAULT_CONFIG.includeGlobalContext,
          insertBeforeMarker:
            getStringField(record, "insertBeforeMarker") ?? DEFAULT_CONFIG.insertBeforeMarker,
          stripBuiltInProjectContext:
            getBooleanField(record, "stripBuiltInProjectContext") ??
            DEFAULT_CONFIG.stripBuiltInProjectContext,
        }
      : { ...DEFAULT_CONFIG };
  } catch (error) {
    currentConfig = { ...DEFAULT_CONFIG };
    ctx.ui.notify(`pi-context config ignored: ${getErrorMessage(error)}`, "warning");
  }
}

function loadContextFileFromDir(dir: string): ContextFile | undefined {
  for (const filename of currentConfig.contextFilenames) {
    const path = join(dir, filename);
    if (!existsSync(path)) continue;

    return {
      path,
      content: readFileSync(path, "utf8"),
    };
  }

  return undefined;
}

function loadPiContextFiles(cwd: string): ContextFile[] {
  const files: ContextFile[] = [];
  const seen = new Set<string>();

  if (currentConfig.includeGlobalContext) {
    const globalContext = loadContextFileFromDir(getAgentDir());
    if (globalContext) {
      files.push(globalContext);
      seen.add(globalContext.path);
    }
  }

  const ancestorFiles: ContextFile[] = [];
  if (currentConfig.includeAncestorContext) {
    let currentDir = resolve(cwd);

    while (true) {
      const contextFile = loadContextFileFromDir(currentDir);
      if (contextFile && !seen.has(contextFile.path)) {
        ancestorFiles.unshift(contextFile);
        seen.add(contextFile.path);
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  }

  files.push(...ancestorFiles);
  return files;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatPiProjectContext(files: readonly ContextFile[]): string {
  if (files.length === 0) return "";

  let context = "<pi_project_context>\n\n";
  context += "Pi-specific project instructions and guidelines from PI.md files only:\n\n";

  for (const file of files) {
    context += `<project_instructions path="${escapeAttribute(file.path)}">\n${file.content}\n</project_instructions>\n\n`;
  }

  context += "</pi_project_context>";
  return context;
}

function stripBuiltInProjectContext(systemPrompt: string): string {
  return systemPrompt
    .replace(/\n*<project_context>\n\n[\s\S]*?<\/project_context>\n*/g, "\n")
    .trimEnd();
}

function insertBeforeCurrentDate(systemPrompt: string, block: string): string {
  if (!block) return systemPrompt;

  const marker = currentConfig.insertBeforeMarker;
  const index = marker ? systemPrompt.lastIndexOf(marker) : -1;
  if (index === -1) return `${systemPrompt}\n\n${block}`;

  return `${systemPrompt.slice(0, index)}\n\n${block}${systemPrompt.slice(index)}`;
}

export default function piContextExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    loadConfig(ctx);
    const piContextFiles = loadPiContextFiles(ctx.cwd);
    const basePrompt = currentConfig.stripBuiltInProjectContext
      ? stripBuiltInProjectContext(event.systemPrompt)
      : event.systemPrompt;
    const piContext = formatPiProjectContext(piContextFiles);

    return {
      systemPrompt: insertBeforeCurrentDate(basePrompt, piContext),
    };
  });

  pi.registerCommand("pi-context", {
    description: "Show PI.md context files that pi-context will send to the model",
    handler: (_args, ctx) => {
      loadConfig(ctx);
      const piContextFiles = loadPiContextFiles(ctx.cwd);
      if (piContextFiles.length === 0) {
        ctx.ui.notify(
          currentConfig.stripBuiltInProjectContext
            ? "No PI.md files found. Built-in AGENTS.md/CLAUDE.md context is stripped before model calls."
            : "No PI.md files found.",
          "warning",
        );
        return Promise.resolve();
      }

      ctx.ui.notify(
        `Using PI.md context only:\n${piContextFiles.map((file) => `- ${file.path}`).join("\n")}`,
        "info",
      );
      return Promise.resolve();
    },
  });
}
