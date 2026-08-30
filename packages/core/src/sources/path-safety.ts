import { type BigIntStats, constants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export interface InspectedRepositoryEntry {
  absolutePath: string;
  realPath: string;
  metadata: BigIntStats;
}

export function sameFileIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function unchangedRepositoryEntry(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isInside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
  });
}

function repositoryPathSegments(relativePath: string, label: string): string[] {
  if (
    path.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.startsWith("//") ||
    relativePath.includes("\\") ||
    hasControlCharacter(relativePath) ||
    relativePath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(
      `${label} must stay inside the brain root: ${relativePath}`,
    );
  }
  return relativePath.split("/");
}

export async function inspectRepositoryEntry(
  root: string,
  relativePath: string,
  expectedKind: "file" | "directory",
  label: string,
  allowMissing = false,
): Promise<InspectedRepositoryEntry | undefined> {
  const segments = repositoryPathSegments(relativePath, label);
  const realRoot = await realpath(root);
  let current = path.resolve(root);
  let metadata: BigIntStats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      metadata = await lstat(current, { bigint: true });
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw new Error(`${label} cannot be read: ${relativePath}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `${label} contains a symbolic link component: ${segments.slice(0, index + 1).join("/")}`,
      );
    }
    const final = index === segments.length - 1;
    if (!final && !metadata.isDirectory()) {
      throw new Error(
        `${label} contains a non-directory component: ${segments.slice(0, index + 1).join("/")}`,
      );
    }
  }
  if (!metadata) throw new Error(`${label} cannot be read: ${relativePath}`);
  if (
    (expectedKind === "file" && !metadata.isFile()) ||
    (expectedKind === "directory" && !metadata.isDirectory())
  ) {
    throw new Error(
      `${label} is not a regular ${expectedKind}: ${relativePath}`,
    );
  }
  let resolved: string;
  try {
    resolved = await realpath(current);
  } catch {
    throw new Error(`${label} cannot be read: ${relativePath}`);
  }
  if (!isInside(realRoot, resolved)) {
    throw new Error(
      `${label} resolves outside the brain root: ${relativePath}`,
    );
  }
  return { absolutePath: current, realPath: resolved, metadata };
}

export async function openStableRepositoryFile(
  inspected: InspectedRepositoryEntry,
): Promise<{
  handle: Awaited<ReturnType<typeof open>>;
  metadata: BigIntStats;
}> {
  const handle = await open(
    inspected.absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      !unchangedRepositoryEntry(inspected.metadata, metadata)
    ) {
      throw new Error("Repository file changed before it was opened");
    }
    return { handle, metadata };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function effectiveSourceRoots(sourceRoots: readonly string[]): string[] {
  const ordered = [...new Set([...sourceRoots, "sources/web"])].sort(
    (left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth || left.localeCompare(right);
    },
  );
  const roots: string[] = [];
  for (const sourceRoot of ordered) {
    if (
      roots.some(
        (parent) =>
          sourceRoot === parent || sourceRoot.startsWith(`${parent}/`),
      )
    ) {
      continue;
    }
    roots.push(sourceRoot);
  }
  return roots;
}

async function walkSourceDirectory(
  root: string,
  relativeDirectory: string,
  inspectedDirectory: InspectedRepositoryEntry,
): Promise<Array<{ relativePath: string; entry: InspectedRepositoryEntry }>> {
  const currentDirectory = await inspectRepositoryEntry(
    root,
    relativeDirectory,
    "directory",
    `Source root ${relativeDirectory}`,
  );
  if (
    !currentDirectory ||
    !unchangedRepositoryEntry(
      inspectedDirectory.metadata,
      currentDirectory.metadata,
    ) ||
    currentDirectory.realPath !== inspectedDirectory.realPath
  ) {
    throw new Error(`Source root changed while scanning: ${relativeDirectory}`);
  }
  let entries: Dirent[];
  try {
    entries = await readdir(currentDirectory.absolutePath, {
      withFileTypes: true,
    });
  } catch {
    throw new Error(`Source root cannot be read: ${relativeDirectory}`);
  }
  const files: Array<{
    relativePath: string;
    entry: InspectedRepositoryEntry;
  }> = [];
  for (const directoryEntry of entries) {
    if (directoryEntry.name.startsWith(".")) continue;
    const relativePath = `${relativeDirectory}/${directoryEntry.name}`;
    const expectedKind = directoryEntry.isDirectory() ? "directory" : "file";
    const inspected = await inspectRepositoryEntry(
      root,
      relativePath,
      expectedKind,
      `Source path ${relativePath}`,
    );
    if (!inspected) continue;
    if (inspected.metadata.isDirectory()) {
      files.push(...(await walkSourceDirectory(root, relativePath, inspected)));
    } else if (inspected.metadata.isFile()) {
      files.push({ relativePath, entry: inspected });
    }
  }
  const finalDirectory = await inspectRepositoryEntry(
    root,
    relativeDirectory,
    "directory",
    `Source root ${relativeDirectory}`,
  );
  if (
    !finalDirectory ||
    !unchangedRepositoryEntry(
      inspectedDirectory.metadata,
      finalDirectory.metadata,
    ) ||
    finalDirectory.realPath !== inspectedDirectory.realPath
  ) {
    throw new Error(`Source root changed while scanning: ${relativeDirectory}`);
  }
  return files;
}

export async function walkSourceFiles(
  root: string,
  sourceRoots: readonly string[],
): Promise<Array<{ relativePath: string; entry: InspectedRepositoryEntry }>> {
  const inspectedRoots = await Promise.all(
    sourceRoots.map(async (sourceRoot) => ({
      sourceRoot,
      inspected: await inspectRepositoryEntry(
        root,
        sourceRoot,
        "directory",
        `Source root ${sourceRoot}`,
        true,
      ),
    })),
  );
  const files = [] as Array<{
    relativePath: string;
    entry: InspectedRepositoryEntry;
  }>;
  for (const { sourceRoot, inspected } of inspectedRoots) {
    if (inspected) {
      files.push(...(await walkSourceDirectory(root, sourceRoot, inspected)));
    }
  }
  return files;
}
