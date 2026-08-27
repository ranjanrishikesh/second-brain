import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  applyChangeSetTransaction,
  beginQuery,
  calculateCatalogRevision,
  doctorBrain,
  finishQuery,
  initBrain,
  readBrainState,
  statusBrain,
  writeBrainState,
  type ChangeSetV1,
  type WikiPageV1,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function gitBrainWithBareRemote(setupComplete = false): Promise<{
  root: string;
  remote: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-sync-"));
  const remote = await mkdtemp(path.join(tmpdir(), "brain-sync-remote-"));
  await initBrain(root, { name: "Sync", description: "Sync tests" });
  if (setupComplete) {
    const state = await readBrainState(root);
    await writeBrainState(root, {
      ...state,
      setup: {
        status: "completed",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "Sync test evidence",
        startedAt: "2026-08-27T00:00:00.000Z",
        completedAt: "2026-08-27T00:00:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });
  }
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Second Brain Sync Test"]);
  await git(root, ["config", "user.email", "brain-sync@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial brain"]);
  await git(remote, ["init", "--bare"]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["push", "-u", "origin", "main"]);
  return { root, remote };
}

function sourcePage(): WikiPageV1 {
  return {
    schema: 1,
    id: "pg_sync_source",
    path: "wiki/pages/sources/sync.md",
    title: "Sync source",
    type: "source",
    status: "active",
    summary: "A page used to exercise a managed synchronization commit.",
    aliases: [],
    tags: [],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    revision: "pending",
    sources: [],
    relations: [],
    body: "# Sync source\n\nA page used to exercise a managed synchronization commit.",
  };
}

function changeSet(operationId: string): ChangeSetV1 {
  return {
    version: 1,
    operationId,
    catalogRevision: calculateCatalogRevision([]),
    reason: "Create a managed page for safe synchronization",
    pages: [{ action: "create", page: sourcePage() }],
    reconciliation: { candidatePageIds: [], reviewed: [] },
  };
}

async function syncApi(): Promise<{
  configureSyncTarget: (
    root: string,
    input: { remote: string; branch: string; confirm: boolean },
  ) => Promise<unknown>;
  attemptManagedSync: (
    root: string,
    options: { beforePush: () => Promise<void> },
  ) => Promise<{ status: string; commit?: string }>;
}> {
  const exports = (await import("../src/index.js")) as Record<string, unknown>;
  expect(exports).toHaveProperty("configureSyncTarget");
  expect(exports).toHaveProperty("attemptManagedSync");
  return {
    configureSyncTarget: exports.configureSyncTarget as (
      root: string,
      input: { remote: string; branch: string; confirm: boolean },
    ) => Promise<unknown>,
    attemptManagedSync: exports.attemptManagedSync as (
      root: string,
      options: { beforePush: () => Promise<void> },
    ) => Promise<{ status: string; commit?: string }>,
  };
}

describe("managed brain synchronization", () => {
  test("refuses to configure a push target without explicit confirmation", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const { configureSyncTarget } = await syncApi();
    const before = await git(remote, ["rev-parse", "refs/heads/main"]);

    await expect(
      configureSyncTarget(root, {
        remote: "origin",
        branch: "main",
        confirm: false,
      }),
    ).rejects.toThrow(/confirm/i);

    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(before);
  });

  test("pushes a confirmed managed commit with its operation trailers", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const { configureSyncTarget } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });

    const result = await applyChangeSetTransaction(
      root,
      changeSet("op_sync_confirmed"),
    );

    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result).toMatchObject({
      sync: {
        status: "synced",
        remote: "origin",
        branch: "main",
        commit: result.commit,
      },
    });
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      result.commit,
    );
    expect(await git(root, ["log", "-1", "--format=%B"])).toContain(
      "Brain-Managed: true",
    );
    expect(await git(root, ["log", "-1", "--format=%B"])).toContain(
      "Brain-Operation: op_sync_confirmed",
    );
  });

  test("refuses a push URL that differs from the confirmed destination", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const replacement = await mkdtemp(
      path.join(tmpdir(), "brain-sync-pushurl-replacement-"),
    );
    await git(replacement, ["init", "--bare"]);
    const { configureSyncTarget } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });
    const originalHead = await git(remote, ["rev-parse", "refs/heads/main"]);
    await git(root, ["config", "remote.origin.pushurl", replacement]);

    const result = await applyChangeSetTransaction(
      root,
      changeSet("op_sync_changed_pushurl"),
    );

    expect(result).toMatchObject({
      sync: {
        status: "manual-sync-required",
        remote: "origin",
        branch: "main",
      },
    });
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      originalHead,
    );
    await expect(
      git(replacement, ["rev-parse", "refs/heads/main"]),
    ).rejects.toThrow();
  });

  test("uses a pre-existing distinct push URL as the confirmed destination", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const pushRemote = await mkdtemp(
      path.join(tmpdir(), "brain-sync-confirmed-pushurl-"),
    );
    await git(pushRemote, ["init", "--bare"]);
    await git(root, ["push", pushRemote, "main"]);
    const fetchHead = await git(remote, ["rev-parse", "refs/heads/main"]);
    await git(root, ["config", "remote.origin.pushurl", pushRemote]);
    const { configureSyncTarget } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });

    const result = await applyChangeSetTransaction(
      root,
      changeSet("op_sync_preexisting_pushurl"),
    );

    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(pushRemote, ["rev-parse", "refs/heads/main"])).toBe(
      result.commit,
    );
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(fetchHead);
  });

  test("pushes to the exact confirmed URL when remote push configuration changes mid-sync", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const replacement = await mkdtemp(
      path.join(tmpdir(), "brain-sync-before-push-replacement-"),
    );
    await git(replacement, ["init", "--bare"]);
    const { configureSyncTarget, attemptManagedSync } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const mutation = await applyChangeSetTransaction(
      root,
      changeSet("op_sync_exact_push_url"),
    );
    if (!mutation.commit) throw new Error("Expected a local managed commit");
    await writeFile(hook, "#!/bin/sh\nexit 0\n");

    const sync = await attemptManagedSync(root, {
      beforePush: async () => {
        await git(root, ["config", "remote.origin.pushurl", replacement]);
      },
    });

    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      mutation.commit,
    );
    await expect(
      git(replacement, ["rev-parse", "refs/heads/main"]),
    ).rejects.toThrow();
    expect(sync).toMatchObject({ status: "manual-sync-required" });
  });

  test("refuses a remote with more than one push URL", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const second = await mkdtemp(
      path.join(tmpdir(), "brain-sync-pushurl-second-"),
    );
    await git(second, ["init", "--bare"]);
    await git(root, ["config", "--add", "remote.origin.pushurl", remote]);
    await git(root, ["config", "--add", "remote.origin.pushurl", second]);
    const { configureSyncTarget } = await syncApi();

    await expect(
      configureSyncTarget(root, {
        remote: "origin",
        branch: "main",
        confirm: true,
      }),
    ).rejects.toThrow(/exactly one.*push URL|multiple.*push URL/i);
  });

  test("refuses a trailer-marked commit that changes an unmanaged path", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const { configureSyncTarget, attemptManagedSync } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });
    const remoteBefore = await git(remote, ["rev-parse", "refs/heads/main"]);
    await writeFile(path.join(root, "private-draft.txt"), "must stay local\n");
    await git(root, ["add", "private-draft.txt"]);
    await git(root, [
      "commit",
      "-m",
      "brain(apply): forged managed commit\n\nBrain-Managed: true\nBrain-Operation: op_forged_private_path",
    ]);

    const sync = await attemptManagedSync(root, {
      beforePush: async () => undefined,
    });

    expect(sync).toMatchObject({ status: "manual-sync-required" });
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      remoteBefore,
    );
  });

  test("refuses a trailer-marked merge commit even when its files look managed", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const { configureSyncTarget, attemptManagedSync } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });
    const remoteBefore = await git(remote, ["rev-parse", "refs/heads/main"]);
    await git(root, ["checkout", "-b", "sync-side"]);
    await writeFile(path.join(root, "wiki", "side.md"), "side branch\n");
    await git(root, ["add", "wiki/side.md"]);
    await git(root, [
      "commit",
      "-m",
      "brain(apply): side history\n\nBrain-Managed: true\nBrain-Operation: op_sync_merge_side",
    ]);
    await git(root, ["checkout", "main"]);
    await writeFile(path.join(root, "wiki", "main.md"), "main branch\n");
    await git(root, ["add", "wiki/main.md"]);
    await git(root, [
      "commit",
      "-m",
      "brain(apply): main history\n\nBrain-Managed: true\nBrain-Operation: op_sync_merge_main",
    ]);
    await git(root, ["merge", "--no-ff", "--no-commit", "sync-side"]);
    await writeFile(
      path.join(root, "private-merge-resolution.txt"),
      "must not push\n",
    );
    await git(root, ["add", "private-merge-resolution.txt"]);
    await git(root, [
      "commit",
      "-m",
      "brain(apply): forged merge\n\nBrain-Managed: true\nBrain-Operation: op_sync_forged_merge",
    ]);

    const sync = await attemptManagedSync(root, {
      beforePush: async () => undefined,
    });

    expect(sync).toMatchObject({ status: "manual-sync-required" });
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      remoteBefore,
    );
  });

  test("reports a Git-derived synced status for a confirmed target", async () => {
    const { root } = await gitBrainWithBareRemote();
    const { configureSyncTarget } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });

    const status = await statusBrain(root);

    expect(status.sync).toMatchObject({
      status: "synced",
      remote: "origin",
      branch: "main",
    });
  });

  test("reports a changed confirmed remote as a manual-sync doctor warning", async () => {
    const { root } = await gitBrainWithBareRemote();
    const replacementRemote = await mkdtemp(
      path.join(tmpdir(), "brain-sync-replacement-"),
    );
    await git(replacementRemote, ["init", "--bare"]);
    const { configureSyncTarget } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });
    await git(root, ["remote", "set-url", "origin", replacementRemote]);

    const doctor = await doctorBrain(root);

    expect(doctor.issues).toContainEqual(
      expect.objectContaining({
        code: "SYNC_MANUAL_REQUIRED",
        severity: "warning",
      }),
    );
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const formatSyncWarning = exports.formatSyncWarning as (
      sync: unknown,
    ) => string | undefined;
    expect(formatSyncWarning((await statusBrain(root)).sync)).toContain(
      "⚠ Sync pending — knowledge is safely committed locally at",
    );
  });

  test("keeps a managed local commit when the configured remote rejects its push", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const { configureSyncTarget } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });
    const before = await git(remote, ["rev-parse", "refs/heads/main"]);
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    const result = await applyChangeSetTransaction(
      root,
      changeSet("op_sync_rejected"),
    );

    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result).toMatchObject({
      sync: { status: "pending", remote: "origin", branch: "main" },
    });
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(result.commit);
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(before);
  });

  test("retries a pending managed push when the next question begins", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const { configureSyncTarget } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const mutation = await applyChangeSetTransaction(
      root,
      changeSet("op_sync_retry"),
    );
    if (!mutation.commit) throw new Error("Expected a local managed commit");
    await writeFile(hook, "#!/bin/sh\nexit 0\n");

    const session = await beginQuery(root, "What synchronization is pending?");

    expect(session).toMatchObject({
      sync: {
        status: "synced",
        remote: "origin",
        branch: "main",
        commit: mutation.commit,
      },
    });
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      mutation.commit,
    );
  });

  test("pushes the reviewed managed commit when HEAD moves before the push", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const { configureSyncTarget, attemptManagedSync } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const mutation = await applyChangeSetTransaction(
      root,
      changeSet("op_sync_exact_commit"),
    );
    if (!mutation.commit) throw new Error("Expected a local managed commit");
    await writeFile(hook, "#!/bin/sh\nexit 0\n");

    let concurrentCommit = "";
    const sync = await attemptManagedSync(root, {
      beforePush: async () => {
        await git(root, [
          "commit",
          "--allow-empty",
          "-m",
          "user: concurrent local work",
        ]);
        concurrentCommit = await git(root, ["rev-parse", "HEAD"]);
      },
    });

    expect(concurrentCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      mutation.commit,
    );
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(concurrentCommit);
    expect(sync).toMatchObject({
      status: "manual-sync-required",
      commit: concurrentCommit,
    });
  });

  test("returns a pending sync warning state after the final query commit is rejected", async () => {
    const { root, remote } = await gitBrainWithBareRemote(true);
    const { configureSyncTarget } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });
    const session = await beginQuery(root, "What remains locally synced?");
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    const finished = await finishQuery(root, session.id, {
      outcome: "answered",
      answerSummary: "The existing wiki has no additional claim to persist.",
    });

    expect(finished).toMatchObject({
      sync: { status: "pending", remote: "origin", branch: "main" },
    });
    expect(finished.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(finished.commit);
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const formatSyncWarning = exports.formatSyncWarning as (
      sync: unknown,
    ) => string | undefined;
    expect(formatSyncWarning(finished.sync)).toBe(
      `⚠ Sync pending — knowledge is safely committed locally at ${finished.commit}, but it has not yet been pushed to origin/main: The remote rejected the push.`,
    );
  });

  test("refuses to auto-push when an unrelated local commit is ahead", async () => {
    const { root, remote } = await gitBrainWithBareRemote();
    const { configureSyncTarget } = await syncApi();
    await configureSyncTarget(root, {
      remote: "origin",
      branch: "main",
      confirm: true,
    });
    const before = await git(remote, ["rev-parse", "refs/heads/main"]);
    await git(root, ["commit", "--allow-empty", "-m", "user: unrelated work"]);

    const result = await applyChangeSetTransaction(
      root,
      changeSet("op_sync_unrelated"),
    );

    expect(result).toMatchObject({
      sync: {
        status: "manual-sync-required",
        remote: "origin",
        branch: "main",
      },
    });
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(before);
  });
});
