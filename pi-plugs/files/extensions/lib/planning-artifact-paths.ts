import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function fail(message: string): never {
  throw new Error(`design artifact path invalid: ${message}`);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function nearestExistingRealPath(path: string): Promise<{
  readonly existing: string;
  readonly suffix: readonly string[];
}> {
  const suffix: string[] = [];
  let current = path;
  while (true) {
    try {
      return { existing: await realpath(current), suffix: suffix.reverse() };
    } catch {
      const parent = dirname(current);
      if (parent === current) fail(`cannot resolve path ${path}`);
      suffix.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

async function resolveWorkspacePath(workspaceRoot: string, relativePath: string): Promise<string> {
  if (!relativePath.trim() || isAbsolute(relativePath)) fail("path must be non-empty and workspace-relative");
  const lexicalRoot = resolve(workspaceRoot);
  const lexical = resolve(lexicalRoot, relativePath);
  const rootReal = await realpath(lexicalRoot);
  if (!isInside(lexicalRoot, lexical)) fail(`path escapes workspace: ${relativePath}`);
  const nearest = await nearestExistingRealPath(lexical);
  const resolvedCandidate = resolve(nearest.existing, ...nearest.suffix);
  if (!isInside(rootReal, resolvedCandidate)) fail(`path escapes workspace through a symlink: ${relativePath}`);
  return resolvedCandidate;
}

export async function resolveArtifactPath(
  workspaceRoot: string,
  artifactRoot: string,
  relativePath: string,
): Promise<string> {
  const rootPath = await resolveWorkspacePath(workspaceRoot, artifactRoot);
  const targetPath = await resolveWorkspacePath(workspaceRoot, relativePath);
  const nearestRoot = await nearestExistingRealPath(rootPath);
  const normalizedRoot = resolve(nearestRoot.existing, ...nearestRoot.suffix);
  if (!isInside(normalizedRoot, targetPath)) fail(`artifact path must be under ${artifactRoot}: ${relativePath}`);
  return targetPath;
}
