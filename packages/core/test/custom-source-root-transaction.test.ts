import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { parse, stringify } from "yaml";
import {
  initBrain,
  recoverBrain,
  scanAndRegisterSources,
} from "../src/index.js";
import { runCanonicalWrite } from "../src/transaction.js";

const execFile = promisify(execFileCallback);
const customRoot = "knowledge/library";
const customSourcePath = `${customRoot}/facts.md`;

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function configureCustomSourceRoot(root: string): Promise<void> {
  const configPath = path.join(root, "brain.config.yaml");
  const config = parse(await readFile(configPath, "utf8"));
  config.sources.roots = [customRoot];
  await writeFile(configPath, stringify(config));
  await mkdir(path.join(root, customRoot), { recursive: true });
}

async function createBrain(description: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-custom-tx-root-"));
  await initBrain(root, { name: "Sources", description });
  await configureCustomSourceRoot(root);
  return root;
}

async function initializeGitHistory(root: string): Promise<void> {
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Custom Root Test"]);
  await git(root, ["config", "user.email", "custom-root@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial brain"]);
}

test("registers and commits an exact source from a configured nested custom root", async () => {
  const root = await createBrain("Git custom source root");
  await initializeGitHistory(root);
  await writeFile(
    path.join(root, customSourcePath),
    "# Facts\n\nSource-backed knowledge.\n",
  );
  await writeFile(
    path.join(root, customRoot, ".private-draft.md"),
    "Never stage this hidden draft.\n",
  );
  await writeFile(path.join(root, "private-notes.txt"), "Keep me private.\n");
  const beforeHead = await git(root, ["rev-parse", "HEAD"]);

  const result = await scanAndRegisterSources(root);

  expect(result.added).toEqual([
    expect.objectContaining({
      path: customSourcePath,
      extractionStatus: "ready",
    }),
  ]);
  expect(await git(root, ["rev-parse", "HEAD"])).not.toBe(beforeHead);
  expect(
    (
      await git(root, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "HEAD",
      ])
    )
      .split("\n")
      .sort(),
  ).toEqual(
    [
      ".brain/operations.jsonl",
      ".brain/source-manifest.json",
      ".brain/state.json",
      customSourcePath,
      "wiki/log.md",
    ].sort(),
  );
  expect(
    await git(root, ["status", "--short", "--", "private-notes.txt"]),
  ).toBe("?? private-notes.txt");
  expect(
    await git(root, [
      "status",
      "--short",
      "--",
      `${customRoot}/.private-draft.md`,
    ]),
  ).toBe(`?? ${customRoot}/.private-draft.md`);
  expect(await readFile(path.join(root, "private-notes.txt"), "utf8")).toBe(
    "Keep me private.\n",
  );
});

test("registers a source from a configured nested custom root without Git", async () => {
  const root = await createBrain("Non-Git custom source root");
  await writeFile(
    path.join(root, customSourcePath),
    "# Facts\n\nLocal source-backed knowledge.\n",
  );

  const result = await scanAndRegisterSources(root);

  expect(result.added).toEqual([
    expect.objectContaining({
      path: customSourcePath,
      extractionStatus: "ready",
    }),
  ]);
  const manifest = JSON.parse(
    await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
  );
  expect(manifest.sources).toEqual([
    expect.objectContaining({ path: customSourcePath }),
  ]);
});

test("rolls back canonical registration when a custom-root source changes and preserves unrelated work", async () => {
  const root = await createBrain("Custom source root rollback");
  await initializeGitHistory(root);
  const sourcePath = path.join(root, customSourcePath);
  await writeFile(sourcePath, "# Facts\n\nOriginal bytes.\n");
  await writeFile(path.join(root, "private-notes.txt"), "Keep me private.\n");
  const canonicalPaths = [
    ".brain/source-manifest.json",
    ".brain/state.json",
    ".brain/operations.jsonl",
    "wiki/log.md",
  ];
  const canonicalBefore = await Promise.all(
    canonicalPaths.map((candidate) =>
      readFile(path.join(root, candidate), "utf8"),
    ),
  );
  const headBefore = await git(root, ["rev-parse", "HEAD"]);

  await expect(
    scanAndRegisterSources(root, {
      beforeStage: async () => {
        await writeFile(sourcePath, "# Facts\n\nChanged during commit.\n");
      },
    }),
  ).rejects.toThrow(/source.*changed|unvalidated|private Git index/i);

  expect(
    await Promise.all(
      canonicalPaths.map((candidate) =>
        readFile(path.join(root, candidate), "utf8"),
      ),
    ),
  ).toEqual(canonicalBefore);
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(headBefore);
  expect(await readFile(sourcePath, "utf8")).toContain(
    "Changed during commit.",
  );
  expect(await readFile(path.join(root, "private-notes.txt"), "utf8")).toBe(
    "Keep me private.\n",
  );
});

test("immutable input roots cannot authorize writes or seal a sibling path", async () => {
  const root = await createBrain("Immutable input isolation");
  const outsideBytes = Buffer.from("Private sibling.\n");
  await writeFile(path.join(root, "private-notes.txt"), outsideBytes);

  await expect(
    runCanonicalWrite(
      root,
      {
        operationId: "op_custom_root_write",
        commitMessage: "test: forbidden custom-root write",
        immutableInputRootPaths: [customRoot],
      },
      async (writer) => {
        await writer.writeText(
          `${customRoot}/generated.md`,
          "Generated mutation.\n",
        );
        return { value: undefined, stagePaths: [] };
      },
    ),
  ).rejects.toThrow(/unsafe canonical file path/i);

  await expect(
    runCanonicalWrite(
      root,
      {
        operationId: "op_custom_root_sibling",
        commitMessage: "test: forbidden sibling seal",
        immutableInputRootPaths: [customRoot],
      },
      async (writer) => {
        await writer.sealExisting("private-notes.txt", {
          bytes: outsideBytes.byteLength,
          sha256: createHash("sha256").update(outsideBytes).digest("hex"),
        });
        return { value: undefined, stagePaths: ["private-notes.txt"] };
      },
    ),
  ).rejects.toThrow(/unsafe immutable input path/i);

  expect(await readFile(path.join(root, "private-notes.txt"), "utf8")).toBe(
    "Private sibling.\n",
  );
});

test("recovers a custom-root registration without restoring or removing the immutable input", async () => {
  const root = await createBrain("Custom source root recovery");
  await initializeGitHistory(root);
  const sourceBytes = "# Facts\n\nRecover this custom source.\n";
  await writeFile(path.join(root, customSourcePath), sourceBytes);
  const manifestPath = path.join(root, ".brain", "source-manifest.json");
  const manifestBefore = await readFile(manifestPath, "utf8");

  await expect(
    scanAndRegisterSources(root, { simulateCrashAfter: "files-applied" }),
  ).rejects.toThrow(/simulated transaction crash/i);
  await expect(recoverBrain(root)).resolves.toBe("restored");

  expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
  expect(await readFile(path.join(root, customSourcePath), "utf8")).toBe(
    sourceBytes,
  );
  await expect(scanAndRegisterSources(root)).resolves.toMatchObject({
    added: [{ path: customSourcePath }],
  });
});

test("rejects an unsafe immutable input root before mutation", async () => {
  const root = await createBrain("Unsafe immutable input root");
  let mutated = false;

  await expect(
    runCanonicalWrite(
      root,
      {
        operationId: "op_unsafe_input_root",
        commitMessage: "test: unsafe immutable input root",
        immutableInputRootPaths: ["../knowledge"],
      },
      async () => {
        mutated = true;
        return { value: undefined, stagePaths: [] };
      },
    ),
  ).rejects.toThrow(/sources\.roots|canonical repository-relative/i);

  expect(mutated).toBe(false);
});
