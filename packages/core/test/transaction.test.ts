import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  applyChangeSetTransaction,
  calculateCatalogRevision,
  initBrain,
  recoverBrain,
  type ChangeSetV1,
  type WikiPageV1,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function initializedGitBrain(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-transaction-"));
  await initBrain(root, {
    name: "Transactions",
    description: "Transaction tests",
  });
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Second Brain Test"]);
  await git(root, ["config", "user.email", "brain-test@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial brain"]);
  return root;
}

function sourcePage(): WikiPageV1 {
  return {
    schema: 1,
    id: "pg_source_orbits",
    path: "wiki/pages/sources/orbits.md",
    title: "Orbits source",
    type: "source",
    status: "active",
    summary: "A source summary.",
    aliases: [],
    tags: ["physics"],
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    revision: "pending",
    sources: [],
    relations: [],
    body: "# Orbits source\n\nA source summary.",
  };
}

function createSourcePageChangeSet(
  operationId = "op_create_source_page",
): ChangeSetV1 {
  return {
    version: 1,
    operationId,
    catalogRevision: calculateCatalogRevision([]),
    reason: "Create the first source page",
    pages: [{ action: "create", page: sourcePage() }],
    reconciliation: { candidatePageIds: [], reviewed: [] },
  };
}

describe("applyChangeSetTransaction", () => {
  test("commits validated managed files while preserving unrelated worktree edits", async () => {
    const root = await initializedGitBrain();
    await writeFile(
      path.join(root, "personal-notes.txt"),
      "keep me uncommitted\n",
    );
    const changeSet = createSourcePageChangeSet();

    const result = await applyChangeSetTransaction(root, changeSet);

    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(root, ["log", "-1", "--pretty=%s"])).toContain(
      "op_create_source_page",
    );
    expect(await readFile(path.join(root, "personal-notes.txt"), "utf8")).toBe(
      "keep me uncommitted\n",
    );
    expect(
      await git(root, ["status", "--short", "--", "personal-notes.txt"]),
    ).toBe("?? personal-notes.txt");
  });

  test("refuses any pre-existing staged change", async () => {
    const root = await initializedGitBrain();
    await writeFile(path.join(root, "staged.txt"), "staged user work\n");
    await git(root, ["add", "staged.txt"]);

    await expect(
      applyChangeSetTransaction(root, createSourcePageChangeSet()),
    ).rejects.toThrow(/staged changes/i);
    expect(await git(root, ["status", "--short", "--", "staged.txt"])).toBe(
      "A  staged.txt",
    );
  });

  test("restores canonical files and HEAD after whole-graph validation fails", async () => {
    const root = await initializedGitBrain();
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    const beforeOperations = await readFile(
      path.join(root, ".brain", "operations.jsonl"),
      "utf8",
    );
    const invalid = sourcePage();
    invalid.relations = [
      {
        targetId: "pg_missing_target",
        kind: "related-to",
        sourceIds: [],
      },
    ];
    const changeSet = createSourcePageChangeSet("op_invalid_graph");
    changeSet.pages[0] = { action: "create", page: invalid };

    await expect(applyChangeSetTransaction(root, changeSet)).rejects.toThrow(
      /DANGLING_RELATION/,
    );

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
    expect(
      await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8"),
    ).toBe(beforeOperations);
  });

  test("restores canonical files and HEAD when Git commit fails", async () => {
    const root = await initializedGitBrain();
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_commit_failure"),
      ),
    ).rejects.toThrow();

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });

  test("aborts on concurrent HEAD movement without discarding the new commit", async () => {
    const root = await initializedGitBrain();
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_concurrent_head"),
        { simulateHeadMovementBeforeCommit: true },
      ),
    ).rejects.toThrow(/HEAD changed/i);

    expect(await git(root, ["rev-parse", "HEAD"])).not.toBe(beforeHead);
    expect(await git(root, ["log", "-1", "--pretty=%s"])).toBe(
      "test: concurrent HEAD movement",
    );
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });

  test.each(["prepared", "files-applied"] as const)(
    "recovers an interrupted %s transaction by restoring its snapshot",
    async (phase) => {
      const root = await initializedGitBrain();
      const beforeHead = await git(root, ["rev-parse", "HEAD"]);

      await expect(
        applyChangeSetTransaction(
          root,
          createSourcePageChangeSet(`op_crash_${phase}`),
          { simulateCrashAfter: phase },
        ),
      ).rejects.toThrow("Simulated transaction crash");

      expect(await recoverBrain(root)).toBe("restored");
      expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(
        await git(root, ["status", "--short", "--", "wiki", ".brain"]),
      ).toBe("");
    },
  );

  test("recognizes a commit-completed crash without rolling back the commit", async () => {
    const root = await initializedGitBrain();
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_crash_committed"),
        { simulateCrashAfter: "committed" },
      ),
    ).rejects.toThrow("Simulated transaction crash");

    expect(await recoverBrain(root)).toBe("committed");
    expect(await git(root, ["rev-parse", "HEAD"])).not.toBe(beforeHead);
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });
});
