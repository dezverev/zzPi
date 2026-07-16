import { readFile, stat } from "node:fs/promises";
import { extname, join, parse, relative, sep } from "node:path";

import { resolveArtifactPath } from "./planning-artifact-paths.ts";

export const IMPLEMENTATION_DOC_ROOT = "docs/artifacts/implementationdocs";
export const IMPLEMENTATION_LEDGER_ROOT = `${IMPLEMENTATION_DOC_ROOT}/ledgers`;

const MAX_IMPLEMENTATION_DOC_CHARS = 500_000;
const MAX_IMPLEMENTATION_LEDGER_CHARS = 250_000;

export interface ResolvedImplementationDocument {
  readonly absoluteDocumentPath: string;
  readonly absoluteLedgerPath: string;
  readonly documentContent: string;
  readonly documentPath: string;
  readonly ledgerContent?: string | undefined;
  readonly ledgerPath: string;
}

function toRepoPath(value: string): string {
  return value.split(sep).join("/");
}

export async function readImplementationDocument(path: string): Promise<string> {
  const content = await readFile(path, "utf8");
  if (!content.trim()) throw new Error("implementation document must not be empty");
  if (content.length > MAX_IMPLEMENTATION_DOC_CHARS) {
    throw new Error(`implementation document exceeds ${MAX_IMPLEMENTATION_DOC_CHARS} characters`);
  }
  return content;
}

async function readOptionalLedger(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    if (content.length > MAX_IMPLEMENTATION_LEDGER_CHARS) {
      throw new Error(`implementation ledger exceeds ${MAX_IMPLEMENTATION_LEDGER_CHARS} characters`);
    }
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function resolveImplementationDocument(
  workspaceRoot: string,
  documentPath: string,
): Promise<ResolvedImplementationDocument> {
  if (extname(documentPath).toLowerCase() !== ".md") {
    throw new Error("implementation document must be a Markdown (.md) file");
  }

  const absoluteDocumentPath = await resolveArtifactPath(
    workspaceRoot,
    IMPLEMENTATION_DOC_ROOT,
    documentPath,
  );
  const documentStats = await stat(absoluteDocumentPath);
  if (!documentStats.isFile()) throw new Error("implementation document must be a regular file");

  const absoluteDocumentRoot = await resolveArtifactPath(
    workspaceRoot,
    IMPLEMENTATION_DOC_ROOT,
    IMPLEMENTATION_DOC_ROOT,
  );
  const documentRelativePath = toRepoPath(relative(absoluteDocumentRoot, absoluteDocumentPath));
  if (!documentRelativePath || documentRelativePath === "ledgers" || documentRelativePath.startsWith("ledgers/")) {
    throw new Error("implementation document cannot be inside the ledger directory");
  }

  const documentContent = await readImplementationDocument(absoluteDocumentPath);

  const parsed = parse(documentRelativePath);
  const ledgerPath = toRepoPath(join(
    IMPLEMENTATION_LEDGER_ROOT,
    parsed.dir,
    `${parsed.name}.ledger.md`,
  ));
  const absoluteLedgerPath = await resolveArtifactPath(
    workspaceRoot,
    IMPLEMENTATION_LEDGER_ROOT,
    ledgerPath,
  );

  return {
    absoluteDocumentPath,
    absoluteLedgerPath,
    documentContent,
    documentPath: `${IMPLEMENTATION_DOC_ROOT}/${documentRelativePath}`,
    ledgerContent: await readOptionalLedger(absoluteLedgerPath),
    ledgerPath,
  };
}

export async function readImplementationLedger(path: string): Promise<string | undefined> {
  return readOptionalLedger(path);
}
