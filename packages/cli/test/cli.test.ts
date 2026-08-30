import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  beginQuery,
  calculateCatalogRevision,
  expandQuery,
  parseWikiPage,
  planReconciliation,
  readBrainState,
  requestWebApproval,
  renderWikiPage,
  resolveWebApproval,
  writeBrainState,
  type WebCaptureResult,
  type ChangeSetV1,
  type WikiPageV1,
} from "@second-brain/core";
import { runCli, type CliRuntimeOptions } from "../src/program.js";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function runBrainSubprocess(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    execFileCallback(
      "pnpm",
      ["brain", ...args],
      { cwd: repositoryRoot },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          exitCode: error?.code ?? 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });
}

function parseBrainJson(stdout: string): unknown {
  return JSON.parse(
    stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1),
  );
}

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function approvedWebQuery(
  root: string,
  question: string,
): Promise<string> {
  const query = await beginQuery(root, question);
  await expandQuery(root, query.id, {
    tier: "sources",
    reason: "The wiki does not contain the answer.",
  });
  await requestWebApproval(root, query.id, {
    reason: "Approved web evidence is required.",
    hostSessionId: "cli-test-host",
  });
  await resolveWebApproval(root, query.id, {
    approved: true,
    decidedBy: "cli-test-owner",
  });
  await expandQuery(root, query.id, {
    tier: "web",
    reason: "Use the approved web evidence.",
  });
  return query.id;
}

async function textPdfBytes(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 40, y: 700, size: 12, font });
  return pdf.save();
}

async function setMaxFileBytes(
  root: string,
  maxFileBytes: number,
): Promise<void> {
  const configPath = path.join(root, "brain.config.yaml");
  const config = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    config.replace(/maxFileBytes: \d+/u, `maxFileBytes: ${maxFileBytes}`),
    "utf8",
  );
}

describe("brain CLI", () => {
  test("initializes from repository-derived defaults and returns onboarding JSON", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "brain-cli-bare-"));
    const root = path.join(parent, "second-brain-smoke");
    await mkdir(root);
    const output: string[] = [];

    const exitCode = await runCli(["init", "--root", root, "--json"], {
      write: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      initialization: {
        mode: "template-replaced",
        name: "Second Brain Smoke",
        description: "A source-backed knowledge brain for Second Brain Smoke.",
      },
      status: {
        onboarding: {
          phase: "awaiting-sources",
          nextAction: "add-sources",
        },
      },
    });
  });

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

  test("captures legacy and provenance-rich text modes without changing the JSON envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-web-text-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Web text",
        "--description",
        "Web text CLI test",
      ],
      { write: () => undefined },
    );
    const queryId = await approvedWebQuery(root, "What does the report say?");
    const legacyOutput: string[] = [];

    await runCli(
      [
        "web",
        "capture",
        queryId,
        "--url",
        "https://example.test/legacy",
        "--title",
        "Legacy report",
        "--kind",
        "page",
        "--content",
        "Legacy page body.",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => legacyOutput.push(value) },
    );

    const legacy = JSON.parse(legacyOutput.join("")) as WebCaptureResult;
    expect(Object.keys(legacy).sort()).toEqual([
      "created",
      "session",
      "source",
    ]);
    expect(legacy.source.provenance).toMatchObject({
      representation: "text",
      completeness: "complete",
      url: "https://example.test/legacy",
      finalUrl: "https://example.test/legacy",
    });

    const contentFile = path.join(root, ".brain", "runtime", "partial.txt");
    await writeFile(
      contentFile,
      "Partial body from the final response.\n",
      "utf8",
    );
    const output: string[] = [];
    await runCli(
      [
        "web",
        "capture",
        queryId,
        "--url",
        "https://example.test/start",
        "--final-url",
        "https://example.test/final",
        "--redirect-url",
        "https://example.test/first",
        "--redirect-url",
        "https://example.test/second",
        "--title",
        "Partial report",
        "--kind",
        "page",
        "--completeness",
        "partial",
        "--content-file",
        contentFile,
        "--retrieved-at",
        "2026-08-30T10:15:00.000Z",
        "--root",
        root,
        "--json",
      ],
      { write: (value) => output.push(value) },
    );

    const captured = JSON.parse(output.join("")) as WebCaptureResult;
    expect(captured.source.provenance).toMatchObject({
      url: "https://example.test/start",
      finalUrl: "https://example.test/final",
      redirectChain: [
        "https://example.test/first",
        "https://example.test/second",
      ],
      completeness: "partial",
      representation: "text",
    });
    expect(
      await readFile(path.join(root, captured.source.path), "utf8"),
    ).toContain("Partial body from the final response.\n");
  });

  test("preserves artifact bytes through real Commander parsing and reports create and reuse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-web-artifact-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Web artifact",
        "--description",
        "Web artifact CLI test",
      ],
      { write: () => undefined },
    );
    const queryId = await approvedWebQuery(
      root,
      "How many signals did the report find?",
    );
    const bytes = await textPdfBytes("The report found seven signals.");
    const artifactPath = path.join(root, ".brain", "runtime", "report.pdf");
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, bytes);

    const subprocess = await runBrainSubprocess([
      "web",
      "capture",
      queryId,
      "--url",
      "https://example.test/report",
      "--final-url",
      "https://cdn.example.test/report.pdf",
      "--redirect-url",
      "https://example.test/download",
      "--redirect-url",
      "https://cdn.example.test/report.pdf",
      "--title",
      "Signals report",
      "--kind",
      "artifact",
      "--artifact-file",
      artifactPath,
      "--media-type",
      "application/pdf",
      "--retrieved-at",
      "2026-08-30T11:00:00.000Z",
      "--root",
      root,
      "--json",
    ]);

    expect(subprocess.exitCode, subprocess.stderr).toBe(0);
    const created = parseBrainJson(subprocess.stdout) as WebCaptureResult;
    expect(created.created).toBe(true);
    expect(created.source.path).toMatch(/signals-report-[a-f0-9]{12}\.pdf$/u);
    expect(await readFile(path.join(root, created.source.path))).toEqual(
      Buffer.from(bytes),
    );
    expect(created.source.provenance.redirectChain).toEqual([
      "https://example.test/download",
      "https://cdn.example.test/report.pdf",
    ]);
    expect(created.session.webEvidenceSourceIds).toContain(created.source.id);

    const overrideBytes = await textPdfBytes(
      "The override report is readable.",
    );
    const extensionlessPath = path.join(root, ".brain", "runtime", "download");
    await writeFile(extensionlessPath, overrideBytes);
    const firstHuman: string[] = [];
    await runCli(
      [
        "web",
        "capture",
        queryId,
        "--url",
        "https://example.test/override",
        "--title",
        "Override report",
        "--kind",
        "artifact",
        "--artifact-file",
        extensionlessPath,
        "--file-name",
        "override.pdf",
        "--root",
        root,
      ],
      { write: (value) => firstHuman.push(value) },
    );
    expect(firstHuman.join("")).toMatch(
      /^Captured sources\/web\/.+\.pdf \(ready\)\.\n$/u,
    );

    const reusedHuman: string[] = [];
    await runCli(
      [
        "web",
        "capture",
        queryId,
        "--url",
        "https://example.test/override",
        "--title",
        "Override report",
        "--kind",
        "artifact",
        "--artifact-file",
        extensionlessPath,
        "--file-name",
        "override.pdf",
        "--root",
        root,
      ],
      { write: (value) => reusedHuman.push(value) },
    );
    expect(reusedHuman.join("")).toMatch(
      /^Reused sources\/web\/.+\.pdf \(ready\)\.\n$/u,
    );
  });

  test("rejects invalid capture modes and malformed UTF-8 before canonical preparation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-web-invalid-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Web invalid",
        "--description",
        "Web invalid CLI test",
      ],
      { write: () => undefined },
    );
    const queryId = await approvedWebQuery(root, "What is invalid input?");
    const artifactPath = path.join(root, ".brain", "runtime", "artifact.pdf");
    const malformedPath = path.join(root, ".brain", "runtime", "malformed.txt");
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, await textPdfBytes("Valid PDF bytes."));
    await writeFile(malformedPath, Uint8Array.of(0xc3, 0x28));
    const base = [
      "web",
      "capture",
      queryId,
      "--url",
      "https://example.test/input",
      "--title",
      "Input",
      "--root",
      root,
    ];

    const invalidModes = [
      [...base, "--kind", "page"],
      [...base, "--kind", "artifact"],
      [...base, "--kind", "page", "--artifact-file", artifactPath],
      [...base, "--kind", "artifact", "--content", "text"],
      [
        ...base,
        "--kind",
        "page",
        "--content",
        "text",
        "--content-file",
        malformedPath,
      ],
      [
        ...base,
        "--kind",
        "artifact",
        "--artifact-file",
        artifactPath,
        "--content",
        "text",
      ],
      [
        ...base,
        "--kind",
        "snippet",
        "--completeness",
        "complete",
        "--content",
        "text",
      ],
    ];
    for (const args of invalidModes) {
      await expect(runCli(args, { write: () => undefined })).rejects.toThrow();
    }
    await expect(
      runCli([...base, "--kind", "page", "--content-file", malformedPath], {
        write: () => undefined,
      }),
    ).rejects.toThrow(/UTF-8/iu);
    await expect(access(path.join(root, "sources", "web"))).rejects.toThrow();
  });

  test("rejects oversized artifact and text files from opened metadata before reading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-web-bounded-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Web bounded",
        "--description",
        "Web bounded input CLI test",
      ],
      { write: () => undefined },
    );
    await setMaxFileBytes(root, 32);
    const queryId = await approvedWebQuery(root, "What exceeds the bound?");
    const artifactPath = path.join(root, ".brain", "runtime", "large.pdf");
    const textPath = path.join(root, ".brain", "runtime", "large.txt");
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, Buffer.alloc(64, 0x25));
    await writeFile(textPath, "x".repeat(64), "utf8");
    const initialStats: Array<{ filePath: string; size: number }> = [];
    const readTotals: Array<{ filePath: string; totalBytes: number }> = [];
    const runtimeOptions: CliRuntimeOptions = {
      webInputFileTestOptions: {
        afterInitialStat: (observation: { filePath: string; size: number }) =>
          initialStats.push(observation),
        afterChunkRead: (observation: {
          filePath: string;
          totalBytes: number;
        }) => readTotals.push(observation),
      },
    };
    const base = [
      "web",
      "capture",
      queryId,
      "--url",
      "https://example.test/large",
      "--title",
      "Large input",
      "--root",
      root,
    ];

    await expect(
      runCli(
        [
          ...base,
          "--kind",
          "artifact",
          "--artifact-file",
          artifactPath,
          "--file-name",
          "large.pdf",
        ],
        { write: () => undefined },
        runtimeOptions,
      ),
    ).rejects.toThrow(/32 bytes/iu);
    await expect(
      runCli(
        [...base, "--kind", "page", "--content-file", textPath],
        { write: () => undefined },
        runtimeOptions,
      ),
    ).rejects.toThrow(/32 bytes/iu);

    expect(initialStats).toEqual([
      { filePath: artifactPath, size: 64 },
      { filePath: textPath, size: 64 },
    ]);
    expect(readTotals).toEqual([]);
    await expect(access(path.join(root, "sources", "web"))).rejects.toThrow();
  });

  test("rejects a same-size input mutation through the opened file before capture", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-web-mutated-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Web mutation",
        "--description",
        "Web input mutation CLI test",
      ],
      { write: () => undefined },
    );
    await setMaxFileBytes(root, 1_024);
    const queryId = await approvedWebQuery(root, "What changed while reading?");
    const textPath = path.join(root, ".brain", "runtime", "mutable.txt");
    await mkdir(path.dirname(textPath), { recursive: true });
    await writeFile(textPath, "original evidence", "utf8");
    let mutated = false;
    const runtimeOptions: CliRuntimeOptions = {
      webInputFileTestOptions: {
        afterInitialStat: async () => {
          await writeFile(textPath, "mutated! evidence", "utf8");
          mutated = true;
        },
      },
    };

    await expect(
      runCli(
        [
          "web",
          "capture",
          queryId,
          "--url",
          "https://example.test/mutable",
          "--title",
          "Mutable input",
          "--kind",
          "page",
          "--content-file",
          textPath,
          "--root",
          root,
        ],
        { write: () => undefined },
        runtimeOptions,
      ),
    ).rejects.toThrow(/changed while it was being read/iu);
    expect(mutated).toBe(true);
    await expect(access(path.join(root, "sources", "web"))).rejects.toThrow();
  });

  test("rejects a non-regular web capture input after opening it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-web-regular-"));
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Web regular",
        "--description",
        "Web regular-file CLI test",
      ],
      { write: () => undefined },
    );
    const queryId = await approvedWebQuery(root, "Is this input a file?");
    const directoryPath = path.join(root, ".brain", "runtime", "directory");
    await mkdir(directoryPath, { recursive: true });

    await expect(
      runCli(
        [
          "web",
          "capture",
          queryId,
          "--url",
          "https://example.test/directory",
          "--title",
          "Directory input",
          "--kind",
          "page",
          "--content-file",
          directoryPath,
          "--root",
          root,
        ],
        { write: () => undefined },
      ),
    ).rejects.toThrow(/regular file/iu);
    await expect(access(path.join(root, "sources", "web"))).rejects.toThrow();
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

    const humanOutput: string[] = [];
    const humanExitCode = await runCli(["doctor", "--root", root], {
      write: (value) => humanOutput.push(value),
    });
    expect(humanExitCode).toBe(0);
    expect(humanOutput.join(" ")).toContain("[warning] SOURCES_EMPTY");
    expect(humanOutput.join(" ")).toContain("[warning] SETUP_INCOMPLETE");
    expect(humanOutput.at(-1)).toBe("Brain is healthy with warnings.\n");
  });

  test("returns a fatal doctor status without mutating process state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-cli-fatal-local-"));
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const exitCode = await runCli(["doctor", "--root", root, "--json"], {
        write: () => undefined,
      });

      expect(process.exitCode).toBeUndefined();
      expect(exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test("exits nonzero from pnpm brain when doctor reports fatal errors", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-cli-doctor-subprocess-fatal-"),
    );

    const result = await runBrainSubprocess([
      "doctor",
      "--root",
      root,
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(parseBrainJson(result.stdout)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "CONFIG_MISSING", severity: "error" }),
      ]),
    });
  });

  test("exits zero from pnpm brain when doctor reports onboarding warnings", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-cli-doctor-subprocess-warning-"),
    );
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Warning health",
        "--description",
        "Warning-only doctor subprocess test",
      ],
      { write: () => undefined },
    );

    const result = await runBrainSubprocess([
      "doctor",
      "--root",
      root,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(parseBrainJson(result.stdout)).toMatchObject({
      ok: true,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "SETUP_INCOMPLETE",
          severity: "warning",
        }),
      ]),
    });
  });

  test("exits nonzero from pnpm brain for a fatal structural audit", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-cli-audit-subprocess-fatal-"),
    );
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Structural audit",
        "--description",
        "Fatal structural audit subprocess test",
      ],
      { write: () => undefined },
    );
    const invalidPage: WikiPageV1 = {
      schema: 1,
      id: "pg_cli_invalid_audit",
      path: "wiki/pages/invalid-audit.md",
      title: "Invalid audit page",
      type: "not-configured",
      status: "active",
      summary: "A page with an invalid structural type.",
      aliases: [],
      tags: [],
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      revision: "pending",
      sources: [],
      relations: [],
      body: "# Invalid audit page\n\nThis page violates the graph configuration.",
    };
    await writeFile(
      path.join(root, invalidPage.path),
      renderWikiPage(invalidPage),
    );

    const result = await runBrainSubprocess([
      "audit",
      "--root",
      root,
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(parseBrainJson(result.stdout)).toMatchObject({
      structural: {
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "UNKNOWN_PAGE_TYPE",
            severity: "error",
          }),
        ]),
      },
    });
  });

  test("exits zero from pnpm brain while only semantic audit work remains", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-cli-audit-subprocess-intermediate-"),
    );
    await runCli(
      [
        "init",
        "--root",
        root,
        "--name",
        "Semantic audit",
        "--description",
        "Intermediate semantic audit subprocess test",
      ],
      { write: () => undefined },
    );
    const sourcePage: WikiPageV1 = {
      schema: 1,
      id: "pg_cli_semantic_audit",
      path: "wiki/pages/semantic-audit.md",
      title: "Semantic audit page",
      type: "source",
      status: "active",
      summary: "A structurally healthy page awaiting semantic review.",
      aliases: [],
      tags: [],
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      revision: "pending",
      sources: [],
      relations: [],
      body: "# Semantic audit page\n\nThis page awaits semantic review.",
    };
    await writeFile(
      path.join(root, sourcePage.path),
      renderWikiPage(sourcePage),
    );
    const state = await readBrainState(root);
    await writeBrainState(root, { ...state, semanticAuditDue: true });

    const result = await runBrainSubprocess([
      "audit",
      "--root",
      root,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(parseBrainJson(result.stdout)).toMatchObject({
      structural: { ok: true },
      semantic: { complete: false, pageIds: [sourcePage.id] },
    });
  });

  test("sets a validated charter from JSON through the CLI", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "brain-cli-charter-"));
    const root = path.join(parent, "astronomy-brain");
    await mkdir(root);
    await runCli(["init", "--root", root], { write: () => undefined });
    await writeFile(
      path.join(root, "sources", "orbits.md"),
      "# Orbits\n\nBodies follow orbital paths.\n",
    );
    await runCli(["source", "scan", "--root", root, "--json"], {
      write: () => undefined,
    });
    const charterPath = path.join(root, "charter.json");
    await writeFile(
      charterPath,
      `${JSON.stringify({
        version: 1,
        description: "Astronomy observations and orbital mechanics.",
        purpose: "Answer source-backed astronomy questions.",
        boundaries: ["Include registered astronomy sources."],
        domainConventions: ["Preserve astronomical terminology."],
        evidencePreferences: ["Prefer primary evidence."],
        origin: "inferred",
      })}\n`,
    );
    const output: string[] = [];

    const exitCode = await runCli(
      ["charter", "set", charterPath, "--root", root, "--json"],
      { write: (value) => output.push(value) },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      version: 1,
      charter: { origin: "inferred" },
      operationId: expect.stringMatching(/^op_charter_/),
    });
    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toContain(
      "brainCharter: 1",
    );
  });

  test("prints the onboarding phase and next action in human status", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "brain-cli-status-human-"),
    );
    const root = path.join(parent, "physics-brain");
    await mkdir(root);
    await runCli(["init", "--root", root], { write: () => undefined });
    const output: string[] = [];

    const exitCode = await runCli(["status", "--root", root], {
      write: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(output.join("")).toContain("Onboarding: awaiting-sources");
    expect(output.join("")).toContain("Next: add-sources");
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
