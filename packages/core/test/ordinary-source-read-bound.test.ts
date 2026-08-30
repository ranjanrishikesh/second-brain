import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { scanSources } from "../src/sources/scan.js";

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd: root })).stdout.trim();
}

async function initializeGitHistory(root: string): Promise<void> {
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Bounded Scan Test"]);
  await git(root, ["config", "user.email", "bounded-scan@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial brain"]);
}

async function directoryEntriesOrEmpty(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function createTestRoot(maxFileBytes = 16): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-bounded-source-read-"));
  await mkdir(path.join(root, ".brain"), { recursive: true });
  await mkdir(path.join(root, "sources"), { recursive: true });
  await writeFile(
    path.join(root, "brain.config.yaml"),
    stringify({
      version: 1,
      brain: {
        name: "Test",
        description: "Bounded source read test",
        language: "en",
      },
      sources: { roots: ["sources"], maxFileBytes },
    }),
  );
  await writeFile(
    path.join(root, ".brain", "source-manifest.json"),
    `${JSON.stringify({ version: 1, sources: [] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, ".brain", "state.json"),
    `${JSON.stringify({ version: 1 }, null, 2)}\n`,
  );
  await writeFile(path.join(root, ".brain", "operations.jsonl"), "");
  return root;
}

test("stops reading an initially oversized source at its opened size plus one when it keeps growing", async () => {
  const root = await createTestRoot();

  const relativePath = "sources/growing.txt";
  const sourcePath = path.join(root, relativePath);
  await writeFile(sourcePath, Buffer.alloc(32, "s"));
  await initializeGitHistory(root);

  const canonicalPaths = [
    ".brain/source-manifest.json",
    ".brain/state.json",
    ".brain/operations.jsonl",
  ];
  const canonicalBefore = await Promise.all(
    canonicalPaths.map((candidate) =>
      readFile(path.join(root, candidate), "utf8"),
    ),
  );
  const headBefore = await git(root, ["rev-parse", "HEAD"]);
  const cumulativeBytesRead: number[] = [];

  await expect(
    scanSources(root, undefined, {
      afterLocalSourceChunkRead: async (candidate, bytesRead) => {
        if (candidate !== relativePath) return;
        cumulativeBytesRead.push(bytesRead);
        await appendFile(sourcePath, Buffer.alloc(32, "g"));
      },
    }),
  ).rejects.toThrow(/source changed while scanning/i);

  expect(cumulativeBytesRead).toEqual([32, 33]);
  expect(
    await Promise.all(
      canonicalPaths.map((candidate) =>
        readFile(path.join(root, candidate), "utf8"),
      ),
    ),
  ).toEqual(canonicalBefore);
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(headBefore);
  expect(
    await directoryEntriesOrEmpty(
      path.join(root, ".brain", "cache", "extracted"),
    ),
  ).toEqual([]);
});

test("streams a stable oversized source once and uses its full digest for duplicate classification", async () => {
  const root = await createTestRoot();
  const bytes = Buffer.alloc(32, "d");
  await writeFile(path.join(root, "sources", "first.txt"), bytes);
  await writeFile(path.join(root, "sources", "second.txt"), bytes);

  const result = await scanSources(root);

  expect(result.added).toHaveLength(1);
  expect(result.added[0]).toMatchObject({
    path: "sources/first.txt",
    bytes: 32,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    extractionStatus: "failed",
    extractor: "none",
    error: "Source exceeds configured maximum of 16 bytes",
  });
  expect(result.duplicates).toEqual([
    {
      path: "sources/second.txt",
      sourceId: result.added[0]?.id,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: 32,
    },
  ]);
});

test.each([
  {
    label: "the exact configured maximum",
    size: 16,
    extractionStatus: "ready",
    extractor: "text-v1",
    error: undefined,
  },
  {
    label: "one byte above the configured maximum",
    size: 17,
    extractionStatus: "failed",
    extractor: "none",
    error: "Source exceeds configured maximum of 16 bytes",
  },
] as const)(
  "keeps the ordinary source boundary behavior at $label",
  async ({ size, extractionStatus, extractor, error }) => {
    const root = await createTestRoot();
    await writeFile(
      path.join(root, "sources", "boundary.txt"),
      Buffer.alloc(size, "b"),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      bytes: size,
      extractionStatus,
      extractor,
      ...(error ? { error } : {}),
    });
    if (!error) expect(result.added[0]).not.toHaveProperty("error");
  },
);
