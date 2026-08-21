import { lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { CustomPlugInventoryResult, CustomPlugInventoryRow } from "./custom-plug-loader.ts";

export type CustomPlugMoveDirection = "activate" | "deactivate";
export type CustomPlugMoveStage = "preflight" | "root-preparation" | "destination-check" | "rename" | "rollback";
export type CustomPlugKnownLocation = "source" | "destination" | "both" | "missing" | "unknown";

export interface CustomPlugMove {
  readonly identity: string;
  readonly directoryName: string;
  readonly direction: CustomPlugMoveDirection;
  readonly source: string;
  readonly destination: string;
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly display: Readonly<{
    directoryName: string;
    pluginId?: string;
    title?: string;
  }>;
}

export interface CustomPlugMovePlanIssue {
  readonly identity: string;
  readonly source?: string;
  readonly destination?: string;
  readonly stage: "preflight";
  readonly message: string;
  readonly code?: string;
}

export class CustomPlugMovePlanError extends Error {
  readonly issues: readonly CustomPlugMovePlanIssue[];

  constructor(issues: readonly CustomPlugMovePlanIssue[]) {
    super(`Custom plug move preflight failed (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "CustomPlugMovePlanError";
    this.issues = Object.freeze([...issues]);
  }
}

export interface CustomPlugMoveFailure {
  readonly identity: string;
  readonly source: string;
  readonly destination: string;
  readonly stage: Exclude<CustomPlugMoveStage, "preflight">;
  readonly rootPath?: string;
  readonly message: string;
  readonly code?: string;
  readonly finalKnownLocation: CustomPlugKnownLocation;
}

export interface CustomPlugMoveJournalEntry {
  readonly identity: string;
  readonly direction: CustomPlugMoveDirection;
  readonly source: string;
  readonly destination: string;
}

export interface CustomPlugMoveExecutionResult {
  readonly ok: true;
  readonly journal: readonly CustomPlugMoveJournalEntry[];
}

export interface CustomPlugMoveCompensationResult {
  readonly rollbackFailures: readonly CustomPlugMoveFailure[];
}

export interface CustomPlugMoveFailedResult {
  readonly ok: false;
  readonly journal: readonly CustomPlugMoveJournalEntry[];
  readonly failure: CustomPlugMoveFailure;
  readonly rollbackFailures: readonly CustomPlugMoveFailure[];
}

export class CustomPlugMoveExecutionError extends Error {
  readonly result: CustomPlugMoveFailedResult;

  constructor(result: CustomPlugMoveFailedResult, cause?: unknown) {
    super(`Custom plug move failed for ${result.failure.identity} during ${result.failure.stage}`, { cause });
    this.name = "CustomPlugMoveExecutionError";
    this.result = result;
  }
}

export interface CustomPlugMoveFileSystem {
  readonly lstat: typeof lstat;
  readonly mkdir: typeof mkdir;
  readonly readdir: typeof readdir;
  readonly realpath: typeof realpath;
  readonly rename: typeof rename;
}

const defaultFileSystem: CustomPlugMoveFileSystem = { lstat, mkdir, readdir, realpath, rename };

function isContained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(fs: CustomPlugMoveFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function knownLocation(
  fs: CustomPlugMoveFileSystem,
  source: string,
  destination: string,
): Promise<CustomPlugKnownLocation> {
  try {
    const [atSource, atDestination] = await Promise.all([
      pathExists(fs, source),
      pathExists(fs, destination),
    ]);
    if (atSource && atDestination) return "both";
    if (atSource) return "source";
    if (atDestination) return "destination";
    return "missing";
  } catch {
    return "unknown";
  }
}

function immutableMove(row: CustomPlugInventoryRow, direction: CustomPlugMoveDirection, sourceRoot: string, destinationRoot: string): CustomPlugMove {
  const display = Object.freeze({
    directoryName: row.directoryName,
    ...(row.manifest === undefined ? {} : { pluginId: row.manifest.id }),
    ...(row.manifest?.title === undefined ? {} : { title: row.manifest.title }),
  });
  return Object.freeze({
    identity: `custom:${row.directoryName}`,
    directoryName: row.directoryName,
    direction,
    source: join(sourceRoot, row.directoryName),
    destination: join(destinationRoot, row.directoryName),
    sourceRoot,
    destinationRoot,
    display,
  });
}

export async function planCustomPlugActivationMoves(
  projectRoot: string,
  inventory: CustomPlugInventoryResult,
  desiredActiveDirectoryNames: ReadonlySet<string> | readonly string[],
  fs: CustomPlugMoveFileSystem = defaultFileSystem,
): Promise<readonly CustomPlugMove[]> {
  const root = resolve(projectRoot);
  const activeRoot = join(root, ".zzpi", "custom-plugs");
  const disabledRoot = join(root, ".zzpi", "custom-plugs-disabled");
  const desired = new Set(desiredActiveDirectoryNames);
  const issues: CustomPlugMovePlanIssue[] = [];
  const byDirectory = new Map<string, CustomPlugInventoryRow[]>();
  for (const row of inventory.rows) {
    const rows = byDirectory.get(row.directoryName) ?? [];
    rows.push(row);
    byDirectory.set(row.directoryName, rows);
  }

  for (const directoryName of [...desired].sort()) {
    if (!byDirectory.has(directoryName)) {
      issues.push({ identity: `custom:${directoryName}`, stage: "preflight", message: "desired active directory is absent from inventory" });
    }
  }

  const moves: CustomPlugMove[] = [];
  for (const directoryName of [...byDirectory.keys()].sort()) {
    const rows = byDirectory.get(directoryName)!;
    if (rows.length !== 1) {
      const affected = desired.has(directoryName)
        ? rows.every((row) => row.state !== "active")
        : rows.some((row) => row.state === "active");
      if (affected) {
        issues.push({ identity: `custom:${directoryName}`, stage: "preflight", message: "ambiguous duplicate directory identity blocks activation" });
      }
      continue;
    }
    const row = rows[0];
    const shouldBeActive = desired.has(directoryName);
    if ((row.state === "active") === shouldBeActive) continue;
    if (shouldBeActive && !row.activatable) {
      issues.push({
        identity: `custom:${directoryName}`,
        source: row.directoryPath,
        stage: "preflight",
        message: "disabled custom plug is not valid and unambiguous for activation",
      });
      continue;
    }
    moves.push(immutableMove(
      row,
      shouldBeActive ? "activate" : "deactivate",
      row.state === "active" ? activeRoot : disabledRoot,
      row.state === "active" ? disabledRoot : activeRoot,
    ));
  }

  let projectRealPath: string | undefined;
  try {
    projectRealPath = await fs.realpath(root);
  } catch (error) {
    issues.push({ identity: "custom:<roots>", stage: "preflight", message: `project root is unavailable: ${errorMessage(error)}`, code: errorCode(error) });
  }

  for (const fixedRoot of [join(root, ".zzpi"), activeRoot, disabledRoot]) {
    try {
      const fixedRootStat = await fs.lstat(fixedRoot);
      if (!fixedRootStat.isDirectory() || fixedRootStat.isSymbolicLink()) {
        issues.push({ identity: "custom:<roots>", source: fixedRoot, stage: "preflight", message: "custom plug root must be a real directory, not a symlink" });
        continue;
      }
      if (projectRealPath !== undefined) {
        const fixedRootRealPath = await fs.realpath(fixedRoot);
        if (!isContained(projectRealPath, fixedRootRealPath)) {
          issues.push({ identity: "custom:<roots>", source: fixedRoot, stage: "preflight", message: "custom plug root resolves outside the canonical project root" });
        }
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        issues.push({ identity: "custom:<roots>", source: fixedRoot, stage: "preflight", message: `cannot validate custom plug root: ${errorMessage(error)}`, code: errorCode(error) });
      }
    }
  }

  for (const move of moves) {
    const row = byDirectory.get(move.directoryName)![0];
    if (row.root !== move.sourceRoot || resolve(row.directoryPath) !== move.source ||
        !isContained(move.sourceRoot, move.source) || !isContained(move.destinationRoot, move.destination)) {
      issues.push({ identity: move.identity, source: move.source, destination: move.destination, stage: "preflight", message: "inventory path is outside its fixed custom plug root" });
      continue;
    }
    try {
      const sourceStat = await fs.lstat(move.source);
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
        issues.push({ identity: move.identity, source: move.source, destination: move.destination, stage: "preflight", message: "planned source is not a real directory" });
      } else if (projectRealPath !== undefined) {
        const sourceRealPath = await fs.realpath(move.source);
        if (!isContained(projectRealPath, sourceRealPath)) {
          issues.push({ identity: move.identity, source: move.source, destination: move.destination, stage: "preflight", message: "planned source resolves outside the project root" });
        }
      }
    } catch (error) {
      issues.push({ identity: move.identity, source: move.source, destination: move.destination, stage: "preflight", message: `planned source is unavailable: ${errorMessage(error)}`, code: errorCode(error) });
    }
    try {
      if (await pathExists(fs, move.destination)) {
        issues.push({ identity: move.identity, source: move.source, destination: move.destination, stage: "preflight", message: "planned destination already exists" });
      } else if (await pathExists(fs, move.destinationRoot)) {
        if (projectRealPath !== undefined) {
          const destinationRootRealPath = await fs.realpath(move.destinationRoot);
          if (!isContained(projectRealPath, destinationRootRealPath)) {
            issues.push({ identity: move.identity, source: move.source, destination: move.destination, stage: "preflight", message: "destination root resolves outside the project root" });
          }
        }
        const entries = await fs.readdir(move.destinationRoot);
        if ((entries as string[]).some((entry) => entry !== move.directoryName && entry.toLowerCase() === move.directoryName.toLowerCase())) {
          issues.push({ identity: move.identity, source: move.source, destination: move.destination, stage: "preflight", message: "planned destination has a case-colliding entry" });
        }
      } else {
        const zzpiRoot = dirname(move.destinationRoot);
        if (await pathExists(fs, zzpiRoot) && projectRealPath !== undefined) {
          const zzpiRealPath = await fs.realpath(zzpiRoot);
          if (!isContained(projectRealPath, zzpiRealPath)) {
            issues.push({ identity: move.identity, source: move.source, destination: move.destination, stage: "preflight", message: "destination parent resolves outside the project root" });
          }
        }
      }
    } catch (error) {
      issues.push({ identity: move.identity, source: move.source, destination: move.destination, stage: "preflight", message: `cannot validate planned destination: ${errorMessage(error)}`, code: errorCode(error) });
    }
  }

  if (issues.length > 0) throw new CustomPlugMovePlanError(issues);
  return Object.freeze(moves);
}

function journalEntry(move: CustomPlugMove): CustomPlugMoveJournalEntry {
  return Object.freeze({ identity: move.identity, direction: move.direction, source: move.source, destination: move.destination });
}

export async function compensateCustomPlugActivationMoves(
  journal: readonly CustomPlugMoveJournalEntry[],
  fs: CustomPlugMoveFileSystem = defaultFileSystem,
): Promise<CustomPlugMoveCompensationResult> {
  const rollbackFailures: CustomPlugMoveFailure[] = [];
  for (const completed of [...journal].reverse()) {
    try {
      if (await pathExists(fs, completed.source)) {
        throw Object.assign(new Error("rollback destination is occupied"), { code: "EEXIST" });
      }
      await fs.rename(completed.destination, completed.source);
    } catch (rollbackError) {
      rollbackFailures.push(Object.freeze({
        identity: completed.identity,
        source: completed.destination,
        destination: completed.source,
        stage: "rollback" as const,
        message: errorMessage(rollbackError),
        ...(errorCode(rollbackError) === undefined ? {} : { code: errorCode(rollbackError) }),
        finalKnownLocation: await knownLocation(fs, completed.destination, completed.source),
      }));
    }
  }
  return Object.freeze({ rollbackFailures: Object.freeze(rollbackFailures) });
}

export async function executeCustomPlugActivationMoves(
  plan: readonly CustomPlugMove[],
  fs: CustomPlugMoveFileSystem = defaultFileSystem,
): Promise<CustomPlugMoveExecutionResult> {
  const journal: CustomPlugMoveJournalEntry[] = [];
  const destinationRoots = [...new Set(plan.map((move) => move.destinationRoot))].sort();
  for (const destinationRoot of destinationRoots) {
    try {
      await fs.mkdir(destinationRoot, { recursive: true });
    } catch (error) {
      const move = plan.find((candidate) => candidate.destinationRoot === destinationRoot)!;
      const failure: CustomPlugMoveFailure = Object.freeze({
        identity: move.identity,
        source: move.source,
        destination: move.destination,
        stage: "root-preparation" as const,
        rootPath: destinationRoot,
        message: errorMessage(error),
        ...(errorCode(error) === undefined ? {} : { code: errorCode(error) }),
        finalKnownLocation: await knownLocation(fs, move.source, move.destination),
      });
      const result: CustomPlugMoveFailedResult = Object.freeze({
        ok: false,
        journal: Object.freeze([]),
        failure,
        rollbackFailures: Object.freeze([]),
      });
      throw new CustomPlugMoveExecutionError(result, error);
    }
  }

  for (const move of plan) {
    let failureStage: "destination-check" | "rename" = "destination-check";
    try {
      // Portable Node has no atomic no-replace directory rename. Recheck every
      // observed collision immediately before rename; external TOCTOU races remain unsupported.
      if (await pathExists(fs, move.destination)) {
        throw Object.assign(new Error("destination appeared after preflight"), { code: "EEXIST" });
      }
      failureStage = "rename";
      await fs.rename(move.source, move.destination);
      journal.push(journalEntry(move));
    } catch (error) {
      const compensation = await compensateCustomPlugActivationMoves(journal, fs);
      const failure: CustomPlugMoveFailure = Object.freeze({
        identity: move.identity,
        source: move.source,
        destination: move.destination,
        stage: failureStage,
        message: errorMessage(error),
        ...(errorCode(error) === undefined ? {} : { code: errorCode(error) }),
        finalKnownLocation: await knownLocation(fs, move.source, move.destination),
      });
      const result: CustomPlugMoveFailedResult = Object.freeze({
        ok: false,
        journal: Object.freeze([...journal]),
        failure,
        rollbackFailures: compensation.rollbackFailures,
      });
      throw new CustomPlugMoveExecutionError(result, error);
    }
  }
  return Object.freeze({ ok: true, journal: Object.freeze([...journal]) });
}
