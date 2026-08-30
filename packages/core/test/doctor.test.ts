import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import {
  doctorBrain,
  initBrain,
  type SourceRecordV1,
  scanSources,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function initializedBrain(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-doctor-source-"));
  await initBrain(root, {
    name: "Doctor source integrity",
    description: "Doctor immutable source tests",
  });
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Doctor Test"]);
  await git(root, ["config", "user.email", "doctor@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial brain"]);
  return root;
}

async function registerSource(
  root: string,
  content: Uint8Array | string,
  fileName = "facts.md",
): Promise<SourceRecordV1> {
  await writeFile(path.join(root, "sources", fileName), content);
  const source = (await scanSources(root)).added.find(
    (candidate) => candidate.path === `sources/${fileName}`,
  );
  if (!source) throw new Error("Expected registered source");
  return source;
}

async function setMaxFileBytes(root: string, maxFileBytes: number) {
  const configPath = path.join(root, "brain.config.yaml");
  const config = parse(await readFile(configPath, "utf8"));
  config.sources.maxFileBytes = maxFileBytes;
  await writeFile(configPath, stringify(config));
}

async function setSourceRoots(root: string, roots: string[]) {
  const configPath = path.join(root, "brain.config.yaml");
  const config = parse(await readFile(configPath, "utf8"));
  config.sources.roots = roots;
  await writeFile(configPath, stringify(config));
}

async function treeSnapshot(
  directory: string,
  relativeRoot = directory,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  const snapshot: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path
      .relative(relativeRoot, absolutePath)
      .split(path.sep)
      .join("/");
    if (entry.isDirectory()) {
      snapshot.push(`${relativePath}/`);
      snapshot.push(...(await treeSnapshot(absolutePath, relativeRoot)));
    } else if (entry.isFile()) {
      const digest = createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex");
      snapshot.push(`${relativePath}:${digest}`);
    } else {
      snapshot.push(`${relativePath}:other`);
    }
  }
  return snapshot;
}

async function durableSnapshot(root: string) {
  const [manifest, state, operations, head, status, cache] = await Promise.all([
    readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    readFile(path.join(root, ".brain", "state.json"), "utf8"),
    readFile(path.join(root, ".brain", "operations.jsonl"), "utf8"),
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["status", "--short"]),
    treeSnapshot(path.join(root, ".brain", "cache")),
  ]);
  return { manifest, state, operations, head, status, cache };
}

describe("doctor registered-source integrity", () => {
  test("rejects a sparse oversized replacement before retaining source bytes and stays read-only", async () => {
    const root = await initializedBrain();
    const source = await registerSource(root, "# Facts\n\nSmall evidence.\n");
    await setMaxFileBytes(root, 4096);
    const sourcePath = path.join(root, source.path);
    const sparseBytes = 16 * 1024 * 1024;
    const handle = await open(sourcePath, "r+");
    await handle.truncate(sparseBytes);
    await handle.close();
    const before = await durableSnapshot(root);
    const readProgress: number[] = [];

    const report = await doctorBrain(root, {
      afterSourceReadProgress(relativePath, bytesRead) {
        if (relativePath === source.path) readProgress.push(bytesRead);
      },
    });

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_SIZE_MISMATCH",
        severity: "error",
        path: source.path,
      }),
    );
    expect(readProgress).toEqual([0]);
    expect((await stat(sourcePath)).size).toBe(sparseBytes);
    expect(await durableSnapshot(root)).toEqual(before);
  });

  test("rejects an exact registered source above the current maximum without reading it", async () => {
    const root = await initializedBrain();
    const content = Buffer.alloc(8192, 0x61);
    const source = await registerSource(root, content, "large.txt");
    await setMaxFileBytes(root, 4096);
    const readProgress: number[] = [];

    const report = await doctorBrain(root, {
      afterSourceReadProgress(relativePath, bytesRead) {
        if (relativePath === source.path) readProgress.push(bytesRead);
      },
    });

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_SIZE_MISMATCH",
        path: source.path,
      }),
    );
    expect(readProgress).toEqual([0]);
  });

  test("incrementally hashes a source of the exact recorded size", async () => {
    const root = await initializedBrain();
    const content = Buffer.from("# Exact\n\nRecorded bytes.\n");
    const source = await registerSource(root, content);
    const readProgress: number[] = [];

    const report = await doctorBrain(root, {
      afterSourceReadProgress(relativePath, bytesRead) {
        if (relativePath === source.path) readProgress.push(bytesRead);
      },
    });

    expect(report.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^SOURCE_(?:SIZE|HASH|PATH|CHANGED)/),
          path: source.path,
        }),
      ]),
    );
    expect(readProgress).toEqual([0, content.byteLength]);
  });

  test("reports a same-size source mutation after bounded hashing", async () => {
    const root = await initializedBrain();
    const original = Buffer.from("alpha evidence\n");
    const changed = Buffer.from("omega evidence\n");
    expect(changed.byteLength).toBe(original.byteLength);
    const source = await registerSource(root, original, "same-size.txt");
    await writeFile(path.join(root, source.path), changed);
    const readProgress: number[] = [];

    const report = await doctorBrain(root, {
      afterSourceReadProgress(relativePath, bytesRead) {
        if (relativePath === source.path) readProgress.push(bytesRead);
      },
    });

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_HASH_MISMATCH",
        path: source.path,
      }),
    );
    expect(readProgress).toEqual([0, original.byteLength]);
  });

  test("rejects a symlink replacement without following it", async () => {
    const root = await initializedBrain();
    const content = "# Symlink\n\nExact target bytes.\n";
    const source = await registerSource(root, content);
    const sourcePath = path.join(root, source.path);
    const targetPath = path.join(path.dirname(sourcePath), "target.md");
    await writeFile(targetPath, content);
    await rm(sourcePath);
    await symlink(path.basename(targetPath), sourcePath);

    const report = await doctorBrain(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_PATH_UNSAFE",
        path: source.path,
      }),
    );
  });

  test("rejects a registered path whose source ancestor resolves outside the brain", async () => {
    const root = await initializedBrain();
    const content = "# Contained\n\nMust remain in the brain.\n";
    const source = await registerSource(root, content);
    const outside = await mkdtemp(path.join(tmpdir(), "brain-doctor-outside-"));
    await writeFile(path.join(outside, "facts.md"), content);
    await rename(path.join(root, "sources"), path.join(root, "sources-inside"));
    await symlink(outside, path.join(root, "sources"), "dir");

    const report = await doctorBrain(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_PATH_UNSAFE",
        path: source.path,
      }),
    );
  });

  test("reports deletion as a controlled missing-source issue", async () => {
    const root = await initializedBrain();
    const source = await registerSource(root, "# Deleted\n\nEvidence.\n");
    await rm(path.join(root, source.path));

    const report = await doctorBrain(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_MISSING",
        path: source.path,
      }),
    );
  });

  test("detects a source-path identity swap after opening without reading it", async () => {
    const root = await initializedBrain();
    const content = Buffer.from("# Identity\n\nPinned bytes.\n");
    const source = await registerSource(root, content);
    const sourcePath = path.join(root, source.path);
    let swapped = false;
    const readProgress: number[] = [];

    const report = await doctorBrain(root, {
      async afterSourceOpened(relativePath) {
        if (relativePath !== source.path || swapped) return;
        swapped = true;
        await rename(sourcePath, `${sourcePath}.opened`);
        await writeFile(sourcePath, content);
      },
      afterSourceReadProgress(relativePath, bytesRead) {
        if (relativePath === source.path) readProgress.push(bytesRead);
      },
    });

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_CHANGED_DURING_CHECK",
        path: source.path,
      }),
    );
    expect(readProgress).toEqual([0]);
  });

  test("detects an opened source size change before reading it", async () => {
    const root = await initializedBrain();
    const content = Buffer.from("# Size race\n\nPinned bytes.\n");
    const source = await registerSource(root, content);
    const sourcePath = path.join(root, source.path);
    let changed = false;
    const readProgress: number[] = [];

    const report = await doctorBrain(root, {
      async afterSourceOpened(relativePath) {
        if (relativePath !== source.path || changed) return;
        changed = true;
        await writeFile(sourcePath, Buffer.concat([content, Buffer.alloc(64)]));
      },
      afterSourceReadProgress(relativePath, bytesRead) {
        if (relativePath === source.path) readProgress.push(bytesRead);
      },
    });

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_CHANGED_DURING_CHECK",
        path: source.path,
      }),
    );
    expect(readProgress).toEqual([0]);
  });
});

describe("doctor source-root safety", () => {
  test("reports a default sources symlink as a controlled fatal issue without reading outside", async () => {
    const root = await initializedBrain();
    const outside = await mkdtemp(
      path.join(tmpdir(), "brain-doctor-root-outside-"),
    );
    await writeFile(
      path.join(outside, "private.md"),
      "# Private\n\nOutside.\n",
    );
    await rm(path.join(root, "sources"), { recursive: true });
    await symlink(outside, path.join(root, "sources"), "dir");
    const outsideBefore = await treeSnapshot(outside);
    const cacheBefore = await treeSnapshot(path.join(root, ".brain", "cache"));

    const report = await doctorBrain(root);

    expect(report).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ROOT_UNSAFE",
          severity: "error",
          path: "sources",
        }),
      ]),
    });
    expect(await treeSnapshot(outside)).toEqual(outsideBefore);
    expect(await treeSnapshot(path.join(root, ".brain", "cache"))).toEqual(
      cacheBefore,
    );
  });

  test("reports an intermediate configured-root symlink without reading outside", async () => {
    const root = await initializedBrain();
    const outside = await mkdtemp(
      path.join(tmpdir(), "brain-doctor-ancestor-outside-"),
    );
    await mkdir(path.join(outside, "nested"));
    await writeFile(
      path.join(outside, "nested", "private.md"),
      "# Private\n\nOutside.\n",
    );
    await setSourceRoots(root, ["imports/raw/nested"]);
    await symlink(outside, path.join(root, "imports"), "dir");
    const outsideBefore = await treeSnapshot(outside);
    const cacheBefore = await treeSnapshot(path.join(root, ".brain", "cache"));

    const report = await doctorBrain(root);

    expect(report).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_ROOT_UNSAFE",
          severity: "error",
          path: "imports/raw/nested",
        }),
      ]),
    });
    expect(await treeSnapshot(outside)).toEqual(outsideBefore);
    expect(await treeSnapshot(path.join(root, ".brain", "cache"))).toEqual(
      cacheBefore,
    );
  });

  test("keeps a missing required sources directory as LAYOUT_MISSING", async () => {
    const root = await initializedBrain();
    await rm(path.join(root, "sources"), { recursive: true });

    const report = await doctorBrain(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "LAYOUT_MISSING",
        severity: "error",
        path: "sources",
      }),
    );
    expect(report.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_ROOT_UNSAFE" }),
      ]),
    );
  });

  test("keeps an absent optional configured root nonfatal and onboarding warnings ordinary", async () => {
    const root = await initializedBrain();
    await setSourceRoots(root, ["optional/evidence"]);

    const report = await doctorBrain(root);

    expect(report.ok).toBe(true);
    expect(report.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_ROOT_UNSAFE" }),
      ]),
    );
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCES_EMPTY",
          severity: "warning",
        }),
        expect.objectContaining({
          code: "SETUP_INCOMPLETE",
          severity: "warning",
        }),
      ]),
    );
  });
});
