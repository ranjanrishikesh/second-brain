import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  applyChangeSetTransaction,
  type ChangeSetV1,
  calculateCatalogRevision,
  calculatePageRevision,
  doctorBrain,
  initBrain,
  loadWikiPages,
  recoverBrain,
  renderWikiPage,
  type WikiPageV1,
} from "../src/index.js";
import { runCanonicalWrite } from "../src/transaction.js";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function waitForOwnedIndexLock(
  filePath: string,
  operationId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const marker = JSON.parse(await readFile(filePath, "utf8")) as {
        operationId?: string;
      };
      if (marker.operationId === operationId) return;
    } catch {
      // Git may briefly use its own lock while the worker is preparing.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for owned index lock ${filePath}`);
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function waitForIndexPublicationLock(
  lockPath: string,
  journalPath: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        commitHash?: string;
      };
      const lock = await readFile(lockPath, "utf8");
      if (journal.commitHash && !lock.trimStart().startsWith("{")) return;
    } catch {
      // Wait until the transaction has reached its publication seam.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for index publication at ${lockPath}`);
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
  test("an opted-in canonical writer waits for a live owner and cleans up ownership", async () => {
    const root = await initializedGitBrain();
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstReachedBarrier!: () => void;
    const barrierReached = new Promise<void>((resolve) => {
      firstReachedBarrier = resolve;
    });
    const order: string[] = [];

    const first = runCanonicalWrite(
      root,
      {
        operationId: "op_wait_owner_first",
        commitMessage: "test first writer",
        testOptions: {
          afterMutationBeforeSeal: async () => {
            firstReachedBarrier();
            await firstPaused;
          },
        },
      },
      async () => {
        order.push("first");
        return { value: "first", stagePaths: [] };
      },
    );
    await barrierReached;

    const second = runCanonicalWrite(
      root,
      {
        operationId: "op_wait_owner_second",
        commitMessage: "test second writer",
        waitForWriter: { timeoutMs: 1_000, pollIntervalMs: 5 },
      },
      async () => {
        order.push("second");
        return { value: "second", stagePaths: [] };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(["first"]);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(order).toEqual(["first", "second"]);
    await expect(
      access(path.join(root, ".brain", "runtime", "writer.lock")),
    ).rejects.toThrow();
    await expect(
      access(path.join(root, ".brain", "runtime", "transaction.json")),
    ).rejects.toThrow();
  });

  test.each([
    ["stale", { pid: 2_147_483_647, operationId: "op_stale_writer" }],
    [
      "recoverable",
      {
        pid: process.pid,
        operationId: "op_recoverable_writer",
        recoverable: true,
      },
    ],
    ["malformed", { pid: "not-a-pid", operationId: "op_bad_writer" }],
  ])(
    "an opted-in canonical writer refuses a %s owner",
    async (_kind, marker) => {
      const root = await initializedGitBrain();
      const lockPath = path.join(root, ".brain", "runtime", "writer.lock");
      await writeFile(lockPath, `${JSON.stringify(marker)}\n`);

      await expect(
        runCanonicalWrite(
          root,
          {
            operationId: "op_wait_refusal",
            commitMessage: "must refuse",
            waitForWriter: { timeoutMs: 100, pollIntervalMs: 5 },
          },
          async () => ({ value: undefined, stagePaths: [] }),
        ),
      ).rejects.toThrow(/recover/i);
      await expect(readFile(lockPath, "utf8")).resolves.toContain(
        String(marker.operationId),
      );
    },
  );

  test("an opted-in canonical writer refuses journal-only recovery state", async () => {
    const root = await initializedGitBrain();
    const journalPath = path.join(
      root,
      ".brain",
      "runtime",
      "transaction.json",
    );
    await writeFile(journalPath, "{}\n");

    await expect(
      runCanonicalWrite(
        root,
        {
          operationId: "op_wait_journal_only",
          commitMessage: "must refuse",
          waitForWriter: { timeoutMs: 100, pollIntervalMs: 5 },
        },
        async () => ({ value: undefined, stagePaths: [] }),
      ),
    ).rejects.toThrow(/recover/i);
    await expect(readFile(journalPath, "utf8")).resolves.toBe("{}\n");
  });

  test("an opted-in canonical writer times out without stealing a live lock", async () => {
    const root = await initializedGitBrain();
    const lockPath = path.join(root, ".brain", "runtime", "writer.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, operationId: "op_live_timeout" })}\n`,
    );

    await expect(
      runCanonicalWrite(
        root,
        {
          operationId: "op_wait_timeout",
          commitMessage: "must time out",
          waitForWriter: { timeoutMs: 25, pollIntervalMs: 5 },
        },
        async () => ({ value: undefined, stagePaths: [] }),
      ),
    ).rejects.toThrow(/timed out.*canonical writer/i);
    await expect(readFile(lockPath, "utf8")).resolves.toContain(
      "op_live_timeout",
    );
  });

  test("an opted-in writer loops when an exited owner removes its lock after inspection", async () => {
    const root = await initializedGitBrain();
    const lockPath = path.join(root, ".brain", "runtime", "writer.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, operationId: "op_owner_exited" })}\n`,
    );
    const options = {
      operationId: "op_owner_exit_waiter",
      commitMessage: "continue after owner cleanup",
      waitForWriter: { timeoutMs: 100, pollIntervalMs: 5 },
      testOptions: {
        afterWriterOwnerRead: async () => {
          await rm(lockPath);
        },
      },
    } as unknown as Parameters<typeof runCanonicalWrite<string>>[1];

    await expect(
      runCanonicalWrite(root, options, async () => ({
        value: "acquired",
        stagePaths: [],
      })),
    ).resolves.toMatchObject({ value: "acquired" });
    await expect(access(lockPath)).rejects.toThrow();
  });

  test("preserves committed Git recovery state when a post-commit action fails", async () => {
    const root = await initializedGitBrain();
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    const brainPath = path.join(root, "BRAIN.md");
    const updated = `${await readFile(brainPath, "utf8")}\nCommitted callback seam.\n`;
    const options = {
      operationId: "op_post_commit_git",
      commitMessage: "test post commit failure",
      managedRootPaths: ["BRAIN.md"],
      afterCanonicalCommit: async () => {
        expect(await readFile(brainPath, "utf8")).toBe(updated);
        throw new Error("post-commit callback failed");
      },
    } as unknown as Parameters<typeof runCanonicalWrite<string>>[1];

    await expect(
      runCanonicalWrite(root, options, async (writer) => {
        await writer.writeText("BRAIN.md", updated);
        return { value: "committed", stagePaths: ["BRAIN.md"] };
      }),
    ).rejects.toThrow(/post-commit callback failed/i);

    expect(await git(root, ["rev-parse", "HEAD"])).not.toBe(beforeHead);
    await expect(
      readFile(
        path.join(root, ".brain", "runtime", "transaction.json"),
        "utf8",
      ),
    ).resolves.toContain('"phase": "committed"');
    await expect(
      readFile(path.join(root, ".brain", "runtime", "writer.lock"), "utf8"),
    ).resolves.toContain('"recoverable":true');
    await expect(recoverBrain(root)).resolves.toBe("committed");
    await expect(readFile(brainPath, "utf8")).resolves.toBe(updated);
  });

  test("keeps a non-Git canonical mutation when a post-commit action fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-post-commit-"));
    await initBrain(root, {
      name: "Post Commit",
      description: "Non-Git callback test",
    });
    const brainPath = path.join(root, "BRAIN.md");
    const updated = `${await readFile(brainPath, "utf8")}\nCommitted without Git.\n`;
    const options = {
      operationId: "op_post_commit_no_git",
      commitMessage: "test post commit failure",
      managedRootPaths: ["BRAIN.md"],
      afterCanonicalCommit: async () => {
        expect(await readFile(brainPath, "utf8")).toBe(updated);
        throw new Error("non-git post-commit callback failed");
      },
    } as unknown as Parameters<typeof runCanonicalWrite<string>>[1];

    await expect(
      runCanonicalWrite(root, options, async (writer) => {
        await writer.writeText("BRAIN.md", updated);
        return { value: "committed", stagePaths: ["BRAIN.md"] };
      }),
    ).rejects.toThrow(/non-git post-commit callback failed/i);
    await expect(readFile(brainPath, "utf8")).resolves.toBe(updated);
    await expect(
      access(path.join(root, ".brain", "runtime", "transaction.json")),
    ).rejects.toThrow();
    await expect(
      access(path.join(root, ".brain", "runtime", "writer.lock")),
    ).rejects.toThrow();
  });

  test("does not recover over a live canonical writer", async () => {
    const root = await initializedGitBrain();
    await writeFile(
      path.join(root, ".brain", "runtime", "writer.lock"),
      `${JSON.stringify({ pid: process.pid, operationId: "op_live_writer" })}\n`,
    );

    await expect(recoverBrain(root)).rejects.toThrow(/writer.*active/i);
  });

  test("reports a stale Git index lock instead of declaring the brain healthy", async () => {
    const root = await initializedGitBrain();
    await writeFile(path.join(root, ".git", "index.lock"), "stale\n");

    const doctor = await doctorBrain(root);

    expect(doctor.ok).toBe(false);
    expect(doctor.issues).toContainEqual(
      expect.objectContaining({
        code: "GIT_INDEX_LOCK_PRESENT",
        severity: "error",
      }),
    );
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

  test("rejects an untracked wiki file created after graph validation", async () => {
    const root = await initializedGitBrain();
    const injectedPath = path.join(root, "wiki", "injected.md");

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_late_wiki_injection"),
        {
          beforeStage: async () => {
            await writeFile(
              injectedPath,
              "# Private draft\n\nDo not publish.\n",
            );
          },
        },
      ),
    ).rejects.toThrow(/unexpected managed worktree|unvalidated/i);

    await expect(readFile(injectedPath, "utf8")).rejects.toThrow();
    await expect(
      readFile(path.join(root, "wiki", "pages", "sources", "orbits.md")),
    ).rejects.toThrow();
  });

  test("rejects a valid page overwrite between graph validation and private staging", async () => {
    const root = await initializedGitBrain();
    const options = {
      afterMutation: async () => {
        const [page] = await loadWikiPages(root);
        if (!page) throw new Error("Expected the validated source page");
        const injected = {
          ...page,
          summary: "Injected page summary that was never reconciled.",
          body: "# Orbits source\n\nInjected but structurally valid content.",
        };
        injected.revision = calculatePageRevision(injected);
        await writeFile(
          path.join(root, injected.path),
          renderWikiPage(injected),
        );
      },
    } as unknown as Parameters<typeof applyChangeSetTransaction>[2];

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_post_validation_overwrite"),
        options,
      ),
    ).rejects.toThrow(/changed after graph validation|unvalidated/i);
    await expect(
      readFile(path.join(root, "wiki", "pages", "sources", "orbits.md")),
    ).rejects.toThrow();
  });

  test("rejects a generated wiki log overwrite between mutation and private staging", async () => {
    const root = await initializedGitBrain();
    const logPath = path.join(root, "wiki", "log.md");
    const beforeLog = await readFile(logPath, "utf8");
    const options = {
      afterMutation: async () => {
        await writeFile(
          logPath,
          "# Operation Log\n\nInjected operation that was never validated.\n",
        );
      },
    } as unknown as Parameters<typeof applyChangeSetTransaction>[2];

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_post_mutation_log_overwrite"),
        options,
      ),
    ).rejects.toThrow(/changed after graph validation|unvalidated/i);
    expect(await readFile(logPath, "utf8")).toBe(beforeLog);
  });

  test("rejects a same-content symlink substituted for a generated wiki file", async () => {
    const root = await initializedGitBrain();
    const logPath = path.join(root, "wiki", "log.md");
    const mirroredLogPath = path.join(root, "same-log-content.md");
    const options = {
      afterMutation: async () => {
        const generatedLog = await readFile(logPath, "utf8");
        await writeFile(mirroredLogPath, generatedLog);
        await rm(logPath);
        await symlink(mirroredLogPath, logPath);
      },
    } as unknown as Parameters<typeof applyChangeSetTransaction>[2];

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_same_content_log_symlink"),
        options,
      ),
    ).rejects.toThrow(/regular|symlink|unvalidated/i);
  });

  test("rejects a generated wiki log overwrite before initial transaction sealing", async () => {
    const root = await initializedGitBrain();
    const logPath = path.join(root, "wiki", "log.md");
    const beforeLog = await readFile(logPath, "utf8");
    const options = {
      afterMutationBeforeSeal: async () => {
        await writeFile(
          logPath,
          "# Operation Log\n\nInjected before the transaction could seal it.\n",
        );
      },
    } as unknown as Parameters<typeof applyChangeSetTransaction>[2];

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_preseal_log_overwrite"),
        options,
      ),
    ).rejects.toThrow(/changed after graph validation|unvalidated/i);
    expect(await readFile(logPath, "utf8")).toBe(beforeLog);
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
    expect(
      await git(root, ["status", "--short", "--", "hook-private.txt"]),
    ).toBe("?? hook-private.txt");
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

  test("removes an owned stale Git index lock after a hard writer crash", async () => {
    const root = await initializedGitBrain();
    const workerPath = path.join(root, "hard-crash-worker.mts");
    const coreEntry = new URL("../src/index.ts", import.meta.url).href;
    const changeSet = createSourcePageChangeSet("op_hard_crash_index_lock");
    await writeFile(
      workerPath,
      `import { applyChangeSetTransaction } from ${JSON.stringify(coreEntry)};\nconst root = process.argv.at(-1);\nif (!root) throw new Error("missing root");\nawait applyChangeSetTransaction(root, ${JSON.stringify(changeSet)}, { afterIndexLock: async () => new Promise(() => {}) });\n`,
    );
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const workspaceRoot = path.resolve(testDirectory, "../../..");
    const tsxLoader = path.join(
      workspaceRoot,
      "node_modules",
      "tsx",
      "dist",
      "loader.mjs",
    );
    const worker = spawn(
      process.execPath,
      ["--import", tsxLoader, workerPath, root],
      {
        cwd: root,
        stdio: "ignore",
      },
    );

    try {
      const indexLock = path.join(root, ".git", "index.lock");
      await waitForOwnedIndexLock(indexLock, "op_hard_crash_index_lock");
      worker.kill("SIGKILL");
      if (!worker.pid) throw new Error("Hard-crash worker has no process ID");
      await waitForProcessExit(worker.pid);
      await expect(access(indexLock)).resolves.toBeUndefined();
    } finally {
      if (!worker.killed) worker.kill("SIGKILL");
    }

    const indexLock = path.join(root, ".git", "index.lock");
    expect(await recoverBrain(root)).toBe("restored");
    await expect(access(indexLock)).rejects.toThrow();
    await expect(
      readFile(path.join(root, "wiki", "pages", "sources", "orbits.md")),
    ).rejects.toThrow();
    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_after_hard_crash_recovery"),
      ),
    ).resolves.toMatchObject({
      commit: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
  });

  test("recovers an owned binary index lock after a hard crash during publication", async () => {
    const root = await initializedGitBrain();
    const workerPath = path.join(root, "hard-crash-publication-worker.mts");
    const coreEntry = new URL("../src/index.ts", import.meta.url).href;
    const changeSet = createSourcePageChangeSet("op_hard_crash_index_publish");
    await writeFile(
      workerPath,
      `import { applyChangeSetTransaction } from ${JSON.stringify(coreEntry)};\nconst root = process.argv.at(-1);\nif (!root) throw new Error("missing root");\nawait applyChangeSetTransaction(root, ${JSON.stringify(changeSet)}, { afterIndexCopy: async () => new Promise(() => {}) });\n`,
    );
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const workspaceRoot = path.resolve(testDirectory, "../../..");
    const tsxLoader = path.join(
      workspaceRoot,
      "node_modules",
      "tsx",
      "dist",
      "loader.mjs",
    );
    const worker = spawn(
      process.execPath,
      ["--import", tsxLoader, workerPath, root],
      { cwd: root, stdio: "ignore" },
    );
    const indexLock = path.join(root, ".git", "index.lock");
    const journalPath = path.join(
      root,
      ".brain",
      "runtime",
      "transaction.json",
    );

    try {
      await waitForIndexPublicationLock(indexLock, journalPath);
      worker.kill("SIGKILL");
      if (!worker.pid) throw new Error("Hard-crash worker has no process ID");
      await waitForProcessExit(worker.pid);
      await expect(access(indexLock)).resolves.toBeUndefined();
    } finally {
      if (!worker.killed) worker.kill("SIGKILL");
    }

    expect(await recoverBrain(root)).toBe("committed");
    await expect(access(indexLock)).rejects.toThrow();
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });

  test("recovers after a second hard crash while recovery reacquires the index lock", async () => {
    const root = await initializedGitBrain();
    const operationId = "op_recovery_reacquire_index";
    await expect(
      applyChangeSetTransaction(root, createSourcePageChangeSet(operationId), {
        simulateIndexPublishFailure: true,
      }),
    ).rejects.toThrow(/commit completed.*recovery/i);

    const workerPath = path.join(root, "hard-crash-recovery-worker.mts");
    const coreEntry = new URL("../src/index.ts", import.meta.url).href;
    await writeFile(
      workerPath,
      `import { recoverBrain } from ${JSON.stringify(coreEntry)};\nconst root = process.argv.at(-1);\nif (!root) throw new Error("missing root");\nawait recoverBrain(root, { afterIndexLock: async () => new Promise(() => {}) });\n`,
    );
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const workspaceRoot = path.resolve(testDirectory, "../../..");
    const tsxLoader = path.join(
      workspaceRoot,
      "node_modules",
      "tsx",
      "dist",
      "loader.mjs",
    );
    const worker = spawn(
      process.execPath,
      ["--import", tsxLoader, workerPath, root],
      { cwd: root, stdio: "ignore" },
    );
    const indexLock = path.join(root, ".git", "index.lock");

    try {
      await waitForOwnedIndexLock(indexLock, operationId);
      worker.kill("SIGKILL");
      if (!worker.pid) throw new Error("Hard-crash worker has no process ID");
      await waitForProcessExit(worker.pid);
      await expect(access(indexLock)).resolves.toBeUndefined();
    } finally {
      if (!worker.killed) worker.kill("SIGKILL");
    }

    expect(await recoverBrain(root)).toBe("committed");
    await expect(access(indexLock)).rejects.toThrow();
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });

  test("does not remove an index lock owned by another operation during recovery", async () => {
    const root = await initializedGitBrain();
    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_recovery_lock_owner"),
        { simulateCrashAfter: "files-applied" },
      ),
    ).rejects.toThrow("Simulated transaction crash");
    const indexLock = path.join(root, ".git", "index.lock");
    await writeFile(
      indexLock,
      `${JSON.stringify({
        version: 1,
        operationId: "op_someone_else",
        pid: process.pid,
        token: "00000000-0000-4000-8000-000000000001",
      })}\n`,
    );
    const journalPath = path.join(
      root,
      ".brain",
      "runtime",
      "transaction.json",
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.gitIndexLockPath = indexLock;
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    await expect(recoverBrain(root)).rejects.toThrow(
      /belongs to another operation/i,
    );
    await expect(access(indexLock)).resolves.toBeUndefined();
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

  test("recovers cleanly when interrupted after the journal is removed", async () => {
    const root = await initializedGitBrain();
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);

    await expect(
      applyChangeSetTransaction(
        root,
        createSourcePageChangeSet("op_cleanup_journal_removed"),
        { simulateCrashAfter: "journal-removed" as never },
      ),
    ).rejects.toThrow("Simulated transaction crash");

    await expect(
      readFile(path.join(root, ".brain", "runtime", "transaction.json")),
    ).rejects.toThrow();
    expect(await recoverBrain(root)).toBe("clean");
    expect(await git(root, ["rev-parse", "HEAD"])).not.toBe(beforeHead);
    expect(await git(root, ["status", "--short", "--", "wiki", ".brain"])).toBe(
      "",
    );
  });
});
