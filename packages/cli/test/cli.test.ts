import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  calculateCatalogRevision,
  parseWikiPage,
  planReconciliation,
  readBrainState,
  renderWikiPage,
  writeBrainState,
  type ChangeSetV1,
  type WikiPageV1,
} from "@second-brain/core";
import { runCli } from "../src/program.js";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

describe("brain CLI", () => {
  test("initializes a brain from explicit arguments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-"));
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Fiction",
        "--description",
        "Books and worlds",
      ],
      { write: (value) => output.push(value) },
    );

    expect(exitCode).toBe(0);
    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toContain(
      "# Fiction",
    );
    expect(output.join("")).toContain("Initialized Fiction");
  });

  test("starts initial setup through the CLI with a local embedding provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-setup-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Setup",
        "--description",
        "Setup CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, "sources", "foundation.md"),
      "# Foundation\n\nInitial setup evidence.\n",
    );
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "setup",
        "begin",
        "--purpose",
        "Create the initial source catalog.",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => output.push(value) },
      {
        runtimeServices: {
          embeddings: {
            modelId: "test/cli",
            modelRevision: "test-revision",
            embed: async (texts: readonly string[]) => texts.map(() => [0, 1]),
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      status: "in-progress",
      purpose: "Create the initial source catalog.",
    });
  });

  test("returns the next checkpointed setup batch through the CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-setup-next-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Setup next",
        "--description",
        "Setup next CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, "sources", "foundation.md"),
      "# Foundation\n\nInitial setup evidence.\n",
    );
    const beginOutput: string[] = [];
    await runCli(
      [
        "setup",
        "begin",
        "--purpose",
        "Create the initial source catalog.",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => beginOutput.push(value) },
      {
        runtimeServices: {
          embeddings: {
            modelId: "test/cli",
            modelRevision: "test-revision",
            embed: async (texts: readonly string[]) => texts.map(() => [0, 1]),
          },
        },
      },
    );
    const setup = JSON.parse(beginOutput.join("")) as { id: string };
    const output: string[] = [];

    const exitCode = await runCli(
      ["setup", "next", setup.id, "--root", root, "--json"],
      { write: (value) => output.push(value) },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      setupId: setup.id,
      sourceIds: [expect.stringMatching(/^src_[a-f0-9]{16}$/)],
    });
  });

  test("refuses to start an empty initial setup through the CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-setup-finish-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Setup finish",
        "--description",
        "Setup finish CLI test",
      ],
      { write: () => undefined },
    );
    await expect(
      runCli(
        [
          "setup",
          "begin",
          "--purpose",
          "Create the initial source catalog.",
          "--root",
          root,
          "--json",
        ],
        { write: () => undefined },
        {
          runtimeServices: {
            embeddings: {
              modelId: "test/cli",
              modelRevision: "test-revision",
              embed: async (texts: readonly string[]) =>
                texts.map(() => [0, 1]),
            },
          },
        },
      ),
    ).rejects.toThrow(/at least one.*ready source/i);
  });

  test("binds a source-page apply to the active setup checkpoint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-setup-apply-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Setup apply",
        "--description",
        "Setup apply CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, "sources", "foundation.md"),
      "# Foundation\n\nA source page must be checkpointed.\n",
    );
    const beginOutput: string[] = [];
    await runCli(
      [
        "setup",
        "begin",
        "--purpose",
        "Create the initial source catalog.",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => beginOutput.push(value) },
      {
        runtimeServices: {
          embeddings: {
            modelId: "test/cli",
            modelRevision: "test-revision",
            embed: async (texts: readonly string[]) => texts.map(() => [0, 1]),
          },
        },
      },
    );
    const setup = JSON.parse(beginOutput.join("")) as { id: string };
    const batchOutput: string[] = [];
    await runCli(["setup", "next", setup.id, "--root", root, "--json"], {
      write: (value) => batchOutput.push(value),
    });
    const batch = JSON.parse(batchOutput.join("")) as {
      sources: Array<{
        record: { id: string; title: string };
        extracted: { chunks: Array<{ locator: string; text: string }> };
      }>;
    };
    const source = batch.sources[0];
    if (!source?.extracted.chunks[0]) {
      throw new Error("Expected a setup source context");
    }
    const chunk = source.extracted.chunks[0];
    const changeSetPath = path.join(root, "setup-change-set.json");
    await writeFile(
      changeSetPath,
      `${JSON.stringify({
        version: 1,
        operationId: "op_cli_setup_attach",
        catalogRevision: calculateCatalogRevision([]),
        reason: "Create the initial source page.",
        pages: [
          {
            action: "create",
            page: {
              schema: 1,
              id: `pg_setup_${source.record.id.slice(4)}`,
              path: "wiki/pages/sources/foundation.md",
              title: `Source: ${source.record.title}`,
              type: "source",
              status: "active",
              summary: "Catalog entry for the initial foundation source.",
              aliases: [],
              tags: [],
              createdAt: "2026-08-27T00:00:00.000Z",
              updatedAt: "2026-08-27T00:00:00.000Z",
              revision: "pending",
              sources: [
                {
                  id: source.record.id,
                  locators: [chunk.locator],
                },
              ],
              relations: [],
              body: `# ${source.record.title}\n\n${chunk.text} [@${source.record.id}#${chunk.locator}]`,
            },
          },
        ],
        reconciliation: { candidatePageIds: [], reviewed: [] },
      })}\n`,
      "utf8",
    );
    const applyOutput: string[] = [];

    const applyExitCode = await runCli(
      ["apply", changeSetPath, "--setup", setup.id, "--root", root, "--json"],
      { write: (value) => applyOutput.push(value) },
    );

    expect(applyExitCode).toBe(0);
    expect(JSON.parse(applyOutput.join(""))).toMatchObject({
      operationId: "op_cli_setup_attach",
    });

    const nextOutput: string[] = [];
    await runCli(["setup", "next", setup.id, "--root", root, "--json"], {
      write: (value) => nextOutput.push(value),
    });
    expect(JSON.parse(nextOutput.join(""))).toMatchObject({
      sourceIds: [],
    });
  });

  test("plans reconciliation from a change-set draft through the CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-reconcile-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Reconciliation",
        "--description",
        "Reconciliation CLI test",
      ],
      { write: () => undefined },
    );
    const draftPath = path.join(root, "draft.json");
    await writeFile(
      draftPath,
      `${JSON.stringify({
        version: 1,
        operationId: "op_cli_reconcile",
        catalogRevision: calculateCatalogRevision([]),
        reason: "Add a reusable orbit concept.",
        pages: [
          {
            action: "create",
            page: {
              schema: 1,
              id: "pg_cli_orbit",
              path: "wiki/pages/concepts/orbit.md",
              title: "Orbit",
              type: "concept",
              status: "active",
              summary: "A repeatable orbital-path concept.",
              aliases: [],
              tags: ["astronomy"],
              createdAt: "2026-08-27T00:00:00.000Z",
              updatedAt: "2026-08-27T00:00:00.000Z",
              revision: "pending",
              sources: [],
              relations: [],
              body: "# Orbit\n\nAn orbit is a repeated path.",
            },
          },
        ],
        reconciliation: { candidatePageIds: [], reviewed: [] },
      })}\n`,
      "utf8",
    );
    const output: string[] = [];

    const exitCode = await runCli(
      ["reconcile", "plan", draftPath, "--root", root, "--json"],
      { write: (value) => output.push(value) },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      changedPageIds: ["pg_cli_orbit"],
      candidates: [],
    });
  });

  test("records a query-scoped wiki read receipt through the CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-query-read-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Query read",
        "--description",
        "Query read CLI test",
      ],
      { write: () => undefined },
    );
    const page: WikiPageV1 = {
      schema: 1,
      id: "pg_cli_pulsar",
      path: "wiki/pages/concepts/pulsar.md",
      title: "Pulsar",
      type: "concept",
      status: "active",
      summary: "A rotating neutron star with observed pulses.",
      aliases: [],
      tags: ["astronomy"],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      revision: "pending",
      sources: [],
      relations: [],
      body: "# Pulsar\n\nA pulsar emits recurring observed pulses.",
    };
    await writeFile(path.join(root, page.path), renderWikiPage(page));
    const beginOutput: string[] = [];
    await runCli(
      ["query", "begin", "What is a pulsar?", "--root", root, "--json"],
      { write: (value) => beginOutput.push(value) },
    );
    const session = JSON.parse(beginOutput.join("")) as { id: string };
    const output: string[] = [];

    const exitCode = await runCli(
      ["query", "read", session.id, "pg_cli_pulsar", "--root", root, "--json"],
      { write: (value) => output.push(value) },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      item: { kind: "wiki" },
      receipt: { pageId: "pg_cli_pulsar" },
    });
  });

  test("uses persisted query read receipts when applying a reconciliation plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-apply-query-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Apply query",
        "--description",
        "Apply query CLI test",
      ],
      { write: () => undefined },
    );
    const gravityTemplate: WikiPageV1 = {
      schema: 1,
      id: "pg_cli_gravity",
      path: "wiki/pages/concepts/gravity.md",
      title: "Gravity",
      type: "concept",
      status: "active",
      summary: "A field that affects orbital trajectories.",
      aliases: [],
      tags: ["astronomy"],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      revision: "pending",
      sources: [],
      relations: [
        {
          targetId: "pg_cli_horizon",
          kind: "related-to",
          sourceIds: [],
        },
      ],
      body: "# Gravity\n\nGravity affects orbital trajectories.",
    };
    const horizonTemplate: WikiPageV1 = {
      ...gravityTemplate,
      id: "pg_cli_horizon",
      path: "wiki/pages/concepts/horizon.md",
      title: "Event horizon",
      summary: "A boundary around a compact object.",
      relations: [],
      body: "# Event horizon\n\nAn event horizon bounds a compact object.",
    };
    await writeFile(
      path.join(root, gravityTemplate.path),
      renderWikiPage(gravityTemplate),
    );
    await writeFile(
      path.join(root, horizonTemplate.path),
      renderWikiPage(horizonTemplate),
    );
    const gravity = parseWikiPage(
      await readFile(path.join(root, gravityTemplate.path), "utf8"),
      gravityTemplate.path,
    );
    const horizon = parseWikiPage(
      await readFile(path.join(root, horizonTemplate.path), "utf8"),
      horizonTemplate.path,
    );
    const draft: ChangeSetV1 = {
      version: 1,
      operationId: "op_cli_apply_query",
      catalogRevision: calculateCatalogRevision([gravity, horizon]),
      reason: "Clarify how gravity shapes a trajectory.",
      pages: [
        {
          action: "update",
          expectedRevision: gravity.revision,
          page: {
            ...gravity,
            summary: "A field that shapes nearby orbital trajectories.",
            updatedAt: "2026-08-27T01:00:00.000Z",
          },
        },
      ],
      reconciliation: { candidatePageIds: [], reviewed: [] },
    };
    const plan = await planReconciliation(root, draft);
    expect(plan.candidates.map((candidate) => candidate.pageId)).toEqual([
      "pg_cli_horizon",
    ]);
    const changeSet: ChangeSetV1 = {
      ...draft,
      reconciliation: {
        plan,
        candidatePageIds: plan.candidates.map((candidate) => candidate.pageId),
        readReceipts: [],
        reviewed: plan.candidates.map((candidate) => ({
          pageId: candidate.pageId,
          decision: "no-change" as const,
          reason: "The existing boundary page does not need a change.",
        })),
      },
    };
    const changeSetPath = path.join(root, "change-set.json");
    await writeFile(changeSetPath, `${JSON.stringify(changeSet)}\n`, "utf8");
    const beginOutput: string[] = [];
    await runCli(
      [
        "query",
        "begin",
        "How does gravity shape a trajectory?",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => beginOutput.push(value) },
    );
    const session = JSON.parse(beginOutput.join("")) as { id: string };
    await runCli(
      ["query", "read", session.id, "pg_cli_horizon", "--root", root, "--json"],
      { write: () => undefined },
    );
    const output: string[] = [];

    const exitCode = await runCli(
      ["apply", changeSetPath, "--query", session.id, "--root", root, "--json"],
      { write: (value) => output.push(value) },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      operationId: "op_cli_apply_query",
    });
  });

  test("records one web approval for the active query through the CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-web-approval-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Web approval",
        "--description",
        "Web approval CLI test",
      ],
      { write: () => undefined },
    );
    const beginOutput: string[] = [];
    await runCli(
      [
        "query",
        "begin",
        "What does current astronomy report?",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => beginOutput.push(value) },
    );
    const session = JSON.parse(beginOutput.join("")) as { id: string };
    await runCli(
      [
        "query",
        "expand",
        session.id,
        "--tier",
        "sources",
        "--reason",
        "The wiki has no answer.",
        "--root",
        root,
        "--json",
      ],
      { write: () => undefined },
    );
    const requestOutput: string[] = [];

    const requestExitCode = await runCli(
      [
        "query",
        "request-web",
        session.id,
        "--reason",
        "Local evidence is insufficient for this question.",
        "--host-session",
        "cli-host-session",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => requestOutput.push(value) },
    );

    expect(requestExitCode).toBe(0);
    expect(JSON.parse(requestOutput.join(""))).toMatchObject({
      status: "requested",
      queryId: session.id,
    });

    const approvalOutput: string[] = [];
    const approvalExitCode = await runCli(
      [
        "query",
        "approve-web",
        session.id,
        "--approved",
        "true",
        "--decided-by",
        "brain-owner",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => approvalOutput.push(value) },
    );

    expect(approvalExitCode).toBe(0);
    expect(JSON.parse(approvalOutput.join(""))).toMatchObject({
      id: session.id,
      webApproval: { status: "approved", decidedBy: "brain-owner" },
    });
  });

  test("configures and reports a confirmed sync target through the CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-sync-"));
    const remote = await mkdtemp(path.join(tmpdir(), "brain-cli-sync-remote-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Sync",
        "--description",
        "Sync CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain CLI Test"]);
    await git(root, ["config", "user.email", "brain-cli@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial brain"]);
    await git(remote, ["init", "--bare"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "-u", "origin", "main"]);
    const configureOutput: string[] = [];

    const configureExitCode = await runCli(
      [
        "sync",
        "configure",
        "--remote",
        "origin",
        "--branch",
        "main",
        "--confirm",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => configureOutput.push(value) },
    );

    expect(configureExitCode).toBe(0);
    const configured = JSON.parse(configureOutput.join(""));
    expect(configured).toMatchObject({
      target: { remote: "origin", branch: "main" },
      sync: { status: "synced" },
    });

    const statusOutput: string[] = [];
    const statusExitCode = await runCli(
      ["sync", "status", "--root", root, "--json"],
      { write: (value) => statusOutput.push(value) },
    );

    expect(statusExitCode).toBe(0);
    expect(JSON.parse(statusOutput.join(""))).toMatchObject({
      status: "synced",
      remote: "origin",
      branch: "main",
    });
  });

  test("returns an unconfigured result from an explicit sync attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-sync-empty-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Empty sync",
        "--description",
        "Empty sync CLI test",
      ],
      { write: () => undefined },
    );
    const output: string[] = [];

    const exitCode = await runCli(["sync", "--root", root, "--json"], {
      write: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toEqual({ status: "unconfigured" });
  });

  test("shows the protected local commit when a human-readable apply cannot push", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-sync-warning-"));
    const remote = await mkdtemp(
      path.join(tmpdir(), "brain-cli-sync-warning-remote-"),
    );
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Sync warning",
        "--description",
        "Sync warning CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain CLI Test"]);
    await git(root, ["config", "user.email", "brain-cli@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial brain"]);
    await git(remote, ["init", "--bare"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "-u", "origin", "main"]);
    await runCli(
      [
        "sync",
        "configure",
        "--remote",
        "origin",
        "--branch",
        "main",
        "--confirm",
        "--root",
        root,
        "--json",
      ],
      { write: () => undefined },
    );
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const changeSetPath = path.join(root, "change-set.json");
    await writeFile(
      changeSetPath,
      `${JSON.stringify({
        version: 1,
        operationId: "op_cli_sync_warning",
        catalogRevision: calculateCatalogRevision([]),
        reason: "Record a safe pending-sync operation.",
        pages: [],
        reconciliation: { candidatePageIds: [], reviewed: [] },
      })}\n`,
      "utf8",
    );
    const output: string[] = [];

    const exitCode = await runCli(["apply", changeSetPath, "--root", root], {
      write: (value) => output.push(value),
    });

    const commit = await git(root, ["rev-parse", "HEAD"]);
    expect(exitCode).toBe(0);
    expect(output.join("")).toBe(
      `⚠ Sync pending — knowledge is safely committed locally at ${commit}, but it has not yet been pushed to origin/main: The remote rejected the push.\n`,
    );
  });

  test("shows the protected local commit when a human-readable query finish cannot push", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-query-sync-"));
    const remote = await mkdtemp(
      path.join(tmpdir(), "brain-cli-query-sync-remote-"),
    );
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Query sync warning",
        "--description",
        "Query finish sync warning CLI test",
      ],
      { write: () => undefined },
    );
    const state = await readBrainState(root);
    await writeBrainState(root, {
      ...state,
      setup: {
        status: "completed",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "CLI query synchronization test",
        startedAt: "2026-08-27T00:00:00.000Z",
        completedAt: "2026-08-27T00:00:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain CLI Test"]);
    await git(root, ["config", "user.email", "brain-cli@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial brain"]);
    await git(remote, ["init", "--bare"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "-u", "origin", "main"]);
    await runCli(
      [
        "sync",
        "configure",
        "--remote",
        "origin",
        "--branch",
        "main",
        "--confirm",
        "--root",
        root,
        "--json",
      ],
      { write: () => undefined },
    );
    const beginOutput: string[] = [];
    await runCli(
      [
        "query",
        "begin",
        "What was committed locally?",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => beginOutput.push(value) },
    );
    const session = JSON.parse(beginOutput.join("")) as { id: string };
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "query",
        "finish",
        session.id,
        "--outcome",
        "answered",
        "--summary",
        "The existing wiki required no additional mutation.",
        "--root",
        root,
      ],
      { write: (value) => output.push(value) },
    );

    const commit = await git(root, ["rev-parse", "HEAD"]);
    expect(exitCode).toBe(0);
    expect(output.join("")).toBe(
      `⚠ Sync pending — knowledge is safely committed locally at ${commit}, but it has not yet been pushed to origin/main: The remote rejected the push.\n`,
    );
  });

  test("reports a healthy initialized brain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-doctor-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Health",
        "--description",
        "Health test",
      ],
      { write: () => undefined },
    );
    const output: string[] = [];

    const exitCode = await runCli(["doctor", "--root", root, "--json"], {
      write: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      ok: true,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "SOURCES_EMPTY", severity: "warning" }),
        expect.objectContaining({
          code: "SETUP_INCOMPLETE",
          severity: "warning",
        }),
      ]),
    });
  });

  test("scans sources and emits machine-readable results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-scan-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Sources",
        "--description",
        "Source CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, "sources", "note.md"),
      "# Note\n\nCLI source scan.\n",
    );
    const output: string[] = [];

    const exitCode = await runCli(
      ["source", "scan", "--root", root, "--json"],
      {
        write: (value) => output.push(value),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join("")).added[0].path).toBe("sources/note.md");
  });

  test("searches a selected brain scope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-search-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Search",
        "--description",
        "Search CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, "sources", "note.md"),
      "# Note\n\nQuasars are luminous.\n",
    );
    await runCli(["source", "scan", "--root", root], {
      write: () => undefined,
    });
    const output: string[] = [];

    const exitCode = await runCli(
      [
        "search",
        "--root",
        root,
        "--query",
        "quasars",
        "--scope",
        "sources",
        "--json",
      ],
      { write: (value) => output.push(value) },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))[0].path).toBe("sources/note.md");
  });

  test("reports status and reads a source locator as JSON", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-status-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Status",
        "--description",
        "Status CLI test",
      ],
      { write: () => undefined },
    );
    await writeFile(
      path.join(root, "sources", "stars.md"),
      "# Stars\n\nStars emit light.\n",
    );
    const scanOutput: string[] = [];
    await runCli(["source", "scan", "--root", root, "--json"], {
      write: (value) => scanOutput.push(value),
    });
    const sourceId = JSON.parse(scanOutput.join("")).added[0].id as string;
    const statusOutput: string[] = [];
    const readOutput: string[] = [];

    expect(
      await runCli(["status", "--root", root, "--json"], {
        write: (value) => statusOutput.push(value),
      }),
    ).toBe(0);
    expect(
      await runCli(
        [
          "read",
          sourceId,
          "--locator",
          "heading=stars",
          "--root",
          root,
          "--json",
        ],
        { write: (value) => readOutput.push(value) },
      ),
    ).toBe(0);

    expect(JSON.parse(statusOutput.join(""))).toMatchObject({
      sources: { total: 1, ready: 1 },
      bootstrap: { required: true },
    });
    expect(JSON.parse(readOutput.join(""))).toMatchObject({
      kind: "source",
      chunks: [{ locator: "heading=stars" }],
    });
  });

  test("does not allow the CLI to enter web without a core approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-query-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Queries",
        "--description",
        "Query CLI test",
      ],
      { write: () => undefined },
    );
    const beginOutput: string[] = [];
    await runCli(
      ["query", "begin", "What is a pulsar?", "--root", root, "--json"],
      { write: (value) => beginOutput.push(value) },
    );
    const session = JSON.parse(beginOutput.join("")) as { id: string };
    const sourceOutput: string[] = [];

    await runCli(
      [
        "query",
        "expand",
        session.id,
        "--tier",
        "sources",
        "--reason",
        "The wiki has no answer.",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => sourceOutput.push(value) },
    );
    await expect(
      runCli(
        [
          "query",
          "expand",
          session.id,
          "--tier",
          "web",
          "--reason",
          "The sources have no answer.",
          "--root",
          root,
          "--json",
        ],
        { write: () => undefined },
      ),
    ).rejects.toThrow(/web approval/i);

    expect(JSON.parse(sourceOutput.join(""))).toMatchObject({
      currentTier: "sources",
      tiersUsed: ["wiki", "sources"],
    });
  });
});
