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
  loadWikiPages,
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
  test("does not recover over a live canonical writer", async () => {
    const root = await initializedGitBrain();
    await writeFile(
      path.join(root, ".brain", "runtime", "writer.lock"),
      `${JSON.stringify({ pid: process.pid, operationId: "op_live_writer" })}\n`,
    );

    await expect(recoverBrain(root)).rejects.toThrow(/writer.*active/i);
  });

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

  test("refuses staging that appears while preparing a managed commit", async () => {
    const root = await initializedGitBrain();
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(root, "private-draft.txt"), "do not commit\n");

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_concurrent_user_stage"),
        {
          beforeStage: async () => {
            await git(root, ["add", "private-draft.txt"]);
          },
        },
      ),
    ).rejects.toThrow(/staged changes/i);

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(
      await git(root, ["status", "--short", "--", "private-draft.txt"]),
    ).toBe("A  private-draft.txt");
    await expect(
      readFile(path.join(root, "wiki", "pages", "sources", "orbits.md")),
    ).rejects.toThrow();
  });

  test("does not commit a wiki file created after graph validation", async () => {
    const root = await initializedGitBrain();
    const injectedPath = path.join(root, "wiki", "injected.md");

    const result = await applyChangeSetTransaction(
      root,
      createSourcePageChangeSet("op_late_wiki_injection"),
      {
        beforeStage: async () => {
          await writeFile(injectedPath, "# Private draft\n\nDo not publish.\n");
        },
      },
    );

    if (!result.commit) throw new Error("Expected a managed commit");
    expect(
      await git(root, ["show", "--format=", "--name-only", result.commit]),
    ).not.toContain("wiki/injected.md");
    expect(await readFile(injectedPath, "utf8")).toContain("Private draft");
    expect(await git(root, ["status", "--short", "--", "wiki/injected.md"])).toBe(
      "?? wiki/injected.md",
    );
  });

  test("refuses a pre-commit hook that stages an unrelated file", async () => {
    const root = await initializedGitBrain();
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await writeFile(
      hook,
      "#!/bin/sh\nprintf 'private hook output\\n' > hook-private.txt\ngit add -- hook-private.txt\n",
    );
    await chmod(hook, 0o755);

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_hook_stages_unrelated"),
      ),
    ).rejects.toThrow(/private Git index changed|managed transaction/i);

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await readFile(path.join(root, "hook-private.txt"), "utf8")).toBe(
      "private hook output\n",
    );
    expect(await git(root, ["status", "--short", "--", "hook-private.txt"])).toBe(
      "?? hook-private.txt",
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

  test("rejects operation IDs that could escape the transaction directory", async () => {
    const root = await initializedGitBrain();
    const marker = path.join(root, "escape-marker.txt");
    await writeFile(marker, "must survive\n");
    const changeSet = createSourcePageChangeSet();
    changeSet.operationId = "../../escape-marker.txt";

    await expect(applyChangeSetTransaction(root, changeSet)).rejects.toThrow(
      /operationId|invalid/i,
    );
    expect(await readFile(marker, "utf8")).toBe("must survive\n");
  });

  test("rejects two stable page IDs targeting the same normalized path", async () => {
    const root = await initializedGitBrain();
    const first = sourcePage();
    const second = {
      ...sourcePage(),
      id: "pg_source_collision",
      title: "Colliding source",
    };
    const changeSet = createSourcePageChangeSet("op_duplicate_page_path");
    changeSet.pages = [
      { action: "create", page: first },
      { action: "create", page: second },
    ];

    await expect(applyChangeSetTransaction(root, changeSet)).rejects.toThrow(
      /duplicate wiki page path/i,
    );
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });

  test("rejects two page paths that resolve to the same file through dot segments", async () => {
    const root = await initializedGitBrain();
    const first = sourcePage();
    const second = {
      ...sourcePage(),
      id: "pg_source_dot_collision",
      path: "wiki/pages/sources/nested/../orbits.md",
      title: "Dot-segment collision",
    };
    const changeSet = createSourcePageChangeSet("op_dot_segment_collision");
    changeSet.pages = [
      { action: "create", page: first },
      { action: "create", page: second },
    ];

    await expect(applyChangeSetTransaction(root, changeSet)).rejects.toThrow(
      /non-canonical|unsafe|duplicate wiki page path/i,
    );
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });

  test("requires reconciliation of pages discovered by related-page search", async () => {
    const root = await initializedGitBrain();
    const spectroscopy = {
      ...sourcePage(),
      id: "pg_quasar_spectroscopy",
      path: "wiki/pages/sources/quasar-spectroscopy.md",
      title: "Quasar Spectroscopy",
      summary: "Measures distant redshift.",
      tags: [],
      body: "# Quasar Spectroscopy\n\nMeasures distant redshift.",
    };
    const observatory = {
      ...sourcePage(),
      id: "pg_observatory_notes",
      path: "wiki/pages/sources/observatory-notes.md",
      title: "Observatory Notes",
      summary: "A nightly observing source.",
      tags: [],
      body: "# Observatory Notes\n\nThe quasar spectroscopy run measured a redshift.",
    };
    await applyChangeSetTransaction(root, {
      version: 1,
      operationId: "op_seed_related_search",
      catalogRevision: calculateCatalogRevision([]),
      reason: "Seed related source pages",
      pages: [
        { action: "create", page: spectroscopy },
        { action: "create", page: observatory },
      ],
      reconciliation: { candidatePageIds: [], reviewed: [] },
    });
    const pages = await loadWikiPages(root);
    const current = pages.find((page) => page.id === spectroscopy.id);
    if (!current) throw new Error("Expected spectroscopy page");

    await expect(
      applyChangeSetTransaction(root, {
        version: 1,
        operationId: "op_omit_related_search",
        catalogRevision: calculateCatalogRevision(pages),
        reason: "Update spectroscopy without reviewing search results",
        pages: [
          {
            action: "update",
            expectedRevision: current.revision,
            page: {
              ...current,
              summary: "Measures quasar redshift with spectroscopy.",
              updatedAt: "2026-08-23T15:00:00.000Z",
            },
          },
        ],
        reconciliation: { candidatePageIds: [], reviewed: [] },
      }),
    ).rejects.toThrow(/reconciliation.*pg_observatory_notes/i);
  });

  test("rejects a declared page update that makes no canonical change", async () => {
    const root = await initializedGitBrain();
    await applyChangeSetTransaction(root, createSourcePageChangeSet());
    const [current] = await loadWikiPages(root);
    if (!current) throw new Error("Expected source page");

    await expect(
      applyChangeSetTransaction(root, {
        version: 1,
        operationId: "op_noop_update",
        catalogRevision: calculateCatalogRevision([current]),
        reason: "Attempt a no-op update",
        pages: [
          {
            action: "update",
            expectedRevision: current.revision,
            page: current,
          },
        ],
        reconciliation: { candidatePageIds: [], reviewed: [] },
      }),
    ).rejects.toThrow(/no canonical change|no-op/i);
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

  test("recovers a commit whose private index was not published", async () => {
    const root = await initializedGitBrain();
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_index_publish_failure"),
        { simulateIndexPublishFailure: true },
      ),
    ).rejects.toThrow(/commit completed.*recovery/i);

    expect(await git(root, ["rev-parse", "HEAD"])).not.toBe(beforeHead);
    await expect(
      readFile(
        path.join(root, ".brain", "runtime", "transaction.json"),
        "utf8",
      ),
    ).resolves.toContain("op_index_publish_failure");

    await expect(recoverBrain(root)).resolves.toBe("committed");
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });

  test("preserves recovery material when rollback itself fails", async () => {
    const root = await initializedGitBrain();
    const invalid = sourcePage();
    invalid.relations = [
      {
        targetId: "pg_missing_target",
        kind: "related-to",
        sourceIds: [],
      },
    ];
    const changeSet = createSourcePageChangeSet("op_rollback_failure");
    changeSet.pages[0] = { action: "create", page: invalid };

    await expect(
      applyChangeSetTransaction(root, changeSet, {
        simulateRollbackFailure: true,
      }),
    ).rejects.toThrow(/rollback.*recovery/i);

    const runtime = path.join(root, ".brain", "runtime");
    await expect(
      readFile(path.join(runtime, "transaction.json"), "utf8"),
    ).resolves.toContain("op_rollback_failure");
    await expect(
      readFile(
        path.join(
          runtime,
          "transactions",
          "op_rollback_failure",
          "backup",
          "wiki",
          "home.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("# Transactions");
    await expect(
      readFile(path.join(runtime, "writer.lock"), "utf8"),
    ).resolves.toContain('"recoverable":true');

    await expect(recoverBrain(root)).resolves.toBe("restored");
    await expect(
      readFile(path.join(root, "wiki", "pages", "sources", "orbits.md")),
    ).rejects.toThrow();
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

      expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("");
      if (phase === "files-applied") {
        await expect(
          readFile(
            path.join(root, ".brain", "runtime", "transaction.json"),
            "utf8",
          ),
        ).resolves.toContain('"isolatedIndex": true');
      }
      expect(await recoverBrain(root)).toBe("restored");
      expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(
        await git(root, ["status", "--short", "--", "wiki", ".brain"]),
      ).toBe("");
    },
  );

  test("restores a files-applied crash even when an unrelated commit moves HEAD", async () => {
    const root = await initializedGitBrain();

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_crash_external_head"),
        { simulateCrashAfter: "files-applied" },
      ),
    ).rejects.toThrow("Simulated transaction crash");
    await git(root, [
      "commit",
      "--allow-empty",
      "-m",
      "test: unrelated external commit",
    ]);
    const externalHead = await git(root, ["rev-parse", "HEAD"]);

    expect(await recoverBrain(root)).toBe("restored");
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(externalHead);
    await expect(
      readFile(path.join(root, "wiki", "pages", "sources", "orbits.md")),
    ).rejects.toThrow();
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });

  test("recognizes its exact operation commit from a files-applied journal", async () => {
    const root = await initializedGitBrain();
    const operationId = "op_crash_after_git_commit";
    await expect(
      applyChangeSetTransaction(root, createSourcePageChangeSet(operationId), {
        simulateCrashAfter: "files-applied",
      }),
    ).rejects.toThrow("Simulated transaction crash");
    await git(root, [
      "add",
      "--",
      "wiki",
      ".brain/source-manifest.json",
      ".brain/state.json",
      ".brain/operations.jsonl",
    ]);
    await git(root, [
      "commit",
      "-m",
      `brain(apply): recovered commit [op:${operationId}]`,
    ]);

    expect(await recoverBrain(root)).toBe("committed");
    expect(
      await readFile(
        path.join(root, "wiki", "pages", "sources", "orbits.md"),
        "utf8",
      ),
    ).toContain("Orbits source");
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });

  test("rejects a recovery journal whose backup path escapes runtime", async () => {
    const root = await initializedGitBrain();
    const external = await mkdtemp(
      path.join(tmpdir(), "brain-journal-external-"),
    );
    const journalPath = path.join(
      root,
      ".brain",
      "runtime",
      "transaction.json",
    );
    await writeFile(
      journalPath,
      `${JSON.stringify({
        version: 1,
        operationId: "op_forged_journal",
        phase: "prepared",
        preHead: await git(root, ["rev-parse", "HEAD"]),
        backupPath: path.join(external, "backup"),
        gitRepository: true,
        stagePaths: [],
      })}\n`,
    );

    await expect(recoverBrain(root)).rejects.toThrow(
      "Unsafe recovery journal backup path",
    );
  });

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
