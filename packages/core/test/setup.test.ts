import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, test } from "vitest";
import {
  beginSetup,
  finishSetup,
  initBrain,
  nextSetupBatch,
  renderWikiPage,
  type WikiPageV1,
} from "../src/index.js";
import { deterministicEmbeddings } from "./helpers/embeddings.js";

const services = { embeddings: deterministicEmbeddings({}) };

async function brainWithInitialSource(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-setup-"));
  await initBrain(root, { name: "Astronomy", description: "Setup tests" });
  await writeFile(
    path.join(root, "sources", "orbit.md"),
    "# Orbit\n\nBodies orbit masses.\n",
  );
  return root;
}

describe("one-time brain setup", () => {
  test("rejects a cloned placeholder charter before registering sources", async () => {
    const root = await brainWithInitialSource();
    await writeFile(
      path.join(root, "BRAIN.md"),
      "# Astronomy\n\n## Purpose\n\nReplace this section after cloning with the domain, questions, and outcomes this brain should support.\n",
    );
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
    ) => Promise<unknown>;
    const readBrainState = exports.readBrainState as (root: string) => Promise<{
      setup: { status: string };
    }>;

    await expect(
      beginSetup(root, { purpose: "Astronomy concepts" }, services),
    ).rejects.toThrow(/charter|replace this section/i);

    expect((await readBrainState(root)).setup.status).toBe("not-started");
    expect(
      JSON.parse(
        await readFile(
          path.join(root, ".brain", "source-manifest.json"),
          "utf8",
        ),
      ).sources,
    ).toEqual([]);
  });

  test("refuses to start initial setup without a ready source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-setup-empty-"));
    await initBrain(root, { name: "Empty brain", description: "Setup tests" });
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
    ) => Promise<{ id: string; pendingSourceIds: string[] }>;
    await expect(
      beginSetup(root, { purpose: "A blank brain" }, services),
    ).rejects.toThrow(/at least one.*ready source/i);
  });

  test("reports unsupported-only and extraction-required-only setup blockers", async () => {
    const unsupportedRoot = await mkdtemp(
      path.join(tmpdir(), "brain-setup-unsupported-"),
    );
    await initBrain(unsupportedRoot, {
      name: "Unsupported",
      description: "Unsupported evidence tests",
    });
    await writeFile(
      path.join(unsupportedRoot, "sources", "image.png"),
      "pixels",
    );
    await expect(
      beginSetup(unsupportedRoot, { purpose: "Unsupported corpus" }, services),
    ).rejects.toThrow(/image\.png.*unsupported/i);

    const extractionRoot = await mkdtemp(
      path.join(tmpdir(), "brain-setup-extraction-"),
    );
    await initBrain(extractionRoot, {
      name: "Scanned",
      description: "Scanned evidence tests",
    });
    const document = await PDFDocument.create();
    document.addPage();
    await writeFile(
      path.join(extractionRoot, "sources", "scan.pdf"),
      await document.save(),
    );
    await expect(
      beginSetup(extractionRoot, { purpose: "Scanned corpus" }, services),
    ).rejects.toThrow(/scan\.pdf.*extraction-required/i);
  });

  test("starts setup for ready sources while preserving unusable source diagnostics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-setup-mixed-"));
    await initBrain(root, { name: "Mixed", description: "Mixed evidence" });
    await writeFile(
      path.join(root, "sources", "ready.md"),
      "# Ready\n\nUsable evidence.\n",
    );
    await writeFile(path.join(root, "sources", "image.png"), "pixels");

    const setup = await beginSetup(
      root,
      { purpose: "Catalog usable evidence" },
      services,
    );
    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    ) as {
      sources: Array<{ id: string; path: string; extractionStatus: string }>;
    };
    const ready = manifest.sources.find((source) =>
      source.path.endsWith("ready.md"),
    );
    const unsupported = manifest.sources.find((source) =>
      source.path.endsWith("image.png"),
    );
    if (!ready || !unsupported) throw new Error("Expected both source records");

    expect(setup.pendingSourceIds).toEqual([ready.id]);
    expect(setup.initialSourceIds).toEqual([ready.id, unsupported.id].sort());
    expect(unsupported.extractionStatus).toBe("unsupported");
  });

  test("completes setup after source pages and its full semantic audit", async () => {
    const root = await brainWithInitialSource();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
    ) => Promise<{ id: string }>;
    const nextSetupBatch = exports.nextSetupBatch as (
      root: string,
      setupId: string,
    ) => Promise<{
      sources: Array<{
        record: { id: string };
        extracted?: { chunks: Array<{ locator: string; text: string }> };
      }>;
    }>;
    const applyChangeSetTransaction = exports.applyChangeSetTransaction as (
      root: string,
      changeSet: unknown,
      options: unknown,
    ) => Promise<{ operationId: string }>;
    const attachSetupChange = exports.attachSetupChange as (
      root: string,
      setupId: string,
      operationId: string,
    ) => Promise<unknown>;
    const nextSemanticAuditBatch = exports.nextSemanticAuditBatch as (
      root: string,
    ) => Promise<{ pageIds: string[] }>;
    const recordSemanticAuditBatch = exports.recordSemanticAuditBatch as (
      root: string,
      input: { pageIds: string[]; summary: string },
    ) => Promise<unknown>;
    const finishSetup = exports.finishSetup as (
      root: string,
      setupId: string,
      input: { summary: string },
    ) => Promise<{ status: string; pendingSourceIds: string[] }>;
    const calculateCatalogRevision = exports.calculateCatalogRevision as (
      pages: WikiPageV1[],
    ) => string;
    const setup = await beginSetup(
      root,
      { purpose: "Astronomy concepts" },
      services,
    );
    const context = (await nextSetupBatch(root, setup.id)).sources[0];
    const chunk = context?.extracted?.chunks[0];
    if (!context || !chunk) throw new Error("Expected setup source context");
    const sourcePage: WikiPageV1 = {
      schema: 1,
      id: "pg_setup_orbit_source",
      path: "wiki/pages/sources/setup-orbit.md",
      title: "Setup orbit source",
      type: "source",
      status: "active",
      summary: "A catalog entry for initial orbital evidence.",
      aliases: [],
      tags: [],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      revision: "pending",
      sources: [{ id: context.record.id, locators: [chunk.locator] }],
      relations: [],
      body: `# Setup orbit source\n\n${chunk.text} [@${context.record.id}#${chunk.locator}]`,
    };
    const mutation = await applyChangeSetTransaction(
      root,
      {
        version: 1,
        operationId: "op_setup_complete_source",
        catalogRevision: calculateCatalogRevision([]),
        reason: "Create the initial setup source page",
        pages: [{ action: "create", page: sourcePage }],
        reconciliation: { candidatePageIds: [], reviewed: [] },
      },
      { context: { kind: "setup", id: setup.id }, runtimeServices: services },
    );
    await attachSetupChange(root, setup.id, mutation.operationId);

    await expect(
      finishSetup(root, setup.id, { summary: "Initial catalog" }),
    ).rejects.toThrow(/semantic audit/i);
    const audit = await nextSemanticAuditBatch(root);
    await recordSemanticAuditBatch(root, {
      pageIds: audit.pageIds,
      summary: "Reviewed the complete initial source catalog.",
    });

    const completed = await finishSetup(root, setup.id, {
      summary: "Initial catalog and map are complete.",
    });

    expect(completed).toMatchObject({
      status: "completed",
      pendingSourceIds: [],
    });
  });

  test.each([
    ["declares a locator without citing it", "declared"],
    ["declares no locators", "empty"],
  ] as const)(
    "keeps a ready source pending when its source page %s",
    async (_description, locatorMode) => {
      const root = await brainWithInitialSource();
      const setup = await beginSetup(
        root,
        { purpose: "Astronomy concepts" },
        services,
      );
      const context = (await nextSetupBatch(root, setup.id)).sources[0];
      const chunk = context?.extracted?.chunks[0];
      if (!context || !chunk) throw new Error("Expected setup source context");
      const incompleteSourcePage: WikiPageV1 = {
        schema: 1,
        id: `pg_setup_${locatorMode}_source`,
        path: `wiki/pages/setup-${locatorMode}-source.md`,
        title: `Setup ${locatorMode} source`,
        type: "source",
        status: "active",
        summary: "A source page without matching cited coverage.",
        aliases: [],
        tags: [],
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
        revision: "pending",
        sources: [
          {
            id: context.record.id,
            locators: locatorMode === "declared" ? [chunk.locator] : [],
          },
        ],
        relations: [],
        body: `# Setup ${locatorMode} source\n\nThis body has no inline citation.`,
      };
      await writeFile(
        path.join(root, incompleteSourcePage.path),
        renderWikiPage(incompleteSourcePage),
      );

      await expect(
        finishSetup(root, setup.id, { summary: "Initial catalog" }),
      ).rejects.toThrow(/source page.*orbit/i);
    },
  );

  test("does not finish a knowledge question before initial setup is complete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-setup-gate-"));
    await initBrain(root, { name: "Astronomy", description: "Setup tests" });
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const beginQuery = exports.beginQuery as (
      root: string,
      question: string,
    ) => Promise<{ id: string }>;
    const finishQuery = exports.finishQuery as (
      root: string,
      queryId: string,
      input: { outcome: "answered"; answerSummary: string },
    ) => Promise<unknown>;
    const session = await beginQuery(root, "What belongs in this brain?");

    await expect(
      finishQuery(root, session.id, {
        outcome: "answered",
        answerSummary: "There is no initial source material yet.",
      }),
    ).rejects.toThrow(/setup.*complete/i);
  });

  test("adds sources discovered during setup to the next setup checkpoint", async () => {
    const root = await brainWithInitialSource();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
    ) => Promise<{ id: string }>;
    const beginQuery = exports.beginQuery as (
      root: string,
      question: string,
    ) => Promise<unknown>;
    const nextSetupBatch = exports.nextSetupBatch as (
      root: string,
      setupId: string,
    ) => Promise<{ sources: Array<{ record: { path: string } }> }>;
    const setup = await beginSetup(
      root,
      { purpose: "Astronomy concepts" },
      services,
    );
    await writeFile(
      path.join(root, "sources", "later.md"),
      "# Later\n\nA source arrives while setup is running.\n",
    );

    await beginQuery(root, "What source arrived during setup?");

    expect(
      (await nextSetupBatch(root, setup.id)).sources.map(
        (source) => source.record.path,
      ),
    ).toEqual(["sources/later.md", "sources/orbit.md"]);
  });

  test("discovers a source dropped during setup at its next checkpoint", async () => {
    const root = await brainWithInitialSource();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
    ) => Promise<{ id: string }>;
    const nextSetupBatch = exports.nextSetupBatch as (
      root: string,
      setupId: string,
    ) => Promise<{ sources: Array<{ record: { path: string } }> }>;
    const setup = await beginSetup(
      root,
      { purpose: "Astronomy concepts" },
      services,
    );
    await writeFile(
      path.join(root, "sources", "later.md"),
      "# Later\n\nA source arrives while setup is running.\n",
    );

    const batch = await nextSetupBatch(root, setup.id);

    expect(batch.sources.map((source) => source.record.path)).toEqual([
      "sources/later.md",
      "sources/orbit.md",
    ]);
  });

  test("does not finish setup before scanning a source dropped during setup", async () => {
    const root = await brainWithInitialSource();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
    ) => Promise<{ id: string }>;
    const finishSetup = exports.finishSetup as (
      root: string,
      setupId: string,
      input: { summary: string },
    ) => Promise<unknown>;
    const setup = await beginSetup(
      root,
      { purpose: "Astronomy concepts" },
      services,
    );
    await writeFile(
      path.join(root, "sources", "later.md"),
      "# Later\n\nA source arrives before setup finishes.\n",
    );

    await expect(
      finishSetup(root, setup.id, { summary: "Initial map" }),
    ).rejects.toThrow(/source page.*later/i);
  });

  test("requires a semantic audit after another source arrives during setup", async () => {
    const root = await brainWithInitialSource();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
    ) => Promise<{ id: string }>;
    const nextSetupBatch = exports.nextSetupBatch as (
      root: string,
      setupId: string,
    ) => Promise<{
      sources: Array<{
        record: { id: string };
        extracted?: { chunks: Array<{ locator: string; text: string }> };
      }>;
    }>;
    const applyChangeSetTransaction = exports.applyChangeSetTransaction as (
      root: string,
      changeSet: unknown,
      options: unknown,
    ) => Promise<{ operationId: string }>;
    const attachSetupChange = exports.attachSetupChange as (
      root: string,
      setupId: string,
      operationId: string,
    ) => Promise<unknown>;
    const calculateCatalogRevision = exports.calculateCatalogRevision as (
      pages: WikiPageV1[],
    ) => string;
    const finishSetup = exports.finishSetup as (
      root: string,
      setupId: string,
      input: { summary: string },
    ) => Promise<unknown>;
    const setup = await beginSetup(
      root,
      { purpose: "Astronomy concepts" },
      services,
    );
    await writeFile(
      path.join(root, "sources", "later.md"),
      "# Later\n\nA source arrives before setup finishes.\n",
    );
    const contexts = (await nextSetupBatch(root, setup.id)).sources;
    const pages = contexts.map((context, index): WikiPageV1 => {
      const chunk = context.extracted?.chunks[0];
      if (!chunk) throw new Error("Expected setup source context");
      return {
        schema: 1,
        id: `pg_setup_audit_source_${index}`,
        path: `wiki/pages/sources/setup-audit-${index}.md`,
        title: `Setup audit source ${index}`,
        type: "source",
        status: "active",
        summary: "A source cataloged before initial setup completed.",
        aliases: [],
        tags: [],
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
        revision: "pending",
        sources: [{ id: context.record.id, locators: [chunk.locator] }],
        relations: [],
        body: `# Setup audit source ${index}\n\n${chunk.text} [@${context.record.id}#${chunk.locator}]`,
      };
    });
    const mutation = await applyChangeSetTransaction(
      root,
      {
        version: 1,
        operationId: "op_setup_audit_sources",
        catalogRevision: calculateCatalogRevision([]),
        reason: "Catalog initial and newly arrived setup sources",
        pages: pages.map((page) => ({ action: "create", page })),
        reconciliation: { candidatePageIds: [], reviewed: [] },
      },
      { context: { kind: "setup", id: setup.id }, runtimeServices: services },
    );
    await attachSetupChange(root, setup.id, mutation.operationId);

    await expect(
      finishSetup(root, setup.id, { summary: "Initial map" }),
    ).rejects.toThrow(/semantic audit/i);
  });

  test("recovers an interrupted setup start and can start cleanly", async () => {
    const root = await brainWithInitialSource();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
      testOptions?: { simulateCrashAfter: "files-applied" },
    ) => Promise<{ id: string; status: string; purpose: string }>;
    const readBrainState = exports.readBrainState as (
      root: string,
    ) => Promise<{ setup: { status: string } }>;
    const recoverBrain = exports.recoverBrain as (
      root: string,
    ) => Promise<"restored">;
    await expect(
      beginSetup(root, { purpose: "Astronomy concepts" }, services, {
        simulateCrashAfter: "files-applied",
      }),
    ).rejects.toThrow(/simulated transaction crash/i);
    expect(await recoverBrain(root)).toBe("restored");
    expect((await readBrainState(root)).setup.status).toBe("not-started");

    const started = await beginSetup(
      root,
      { purpose: "Astronomy concepts" },
      services,
    );

    expect(started).toMatchObject({
      status: "in-progress",
      purpose: "Astronomy concepts",
    });
  });

  test("reports later registered sources as query-triggered delta work without reopening setup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-setup-delta-"));
    await initBrain(root, { name: "Astronomy", description: "Setup tests" });
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const readBrainState = exports.readBrainState as (root: string) => Promise<{
      setup: Record<string, unknown>;
    }>;
    const writeBrainState = exports.writeBrainState as (
      root: string,
      state: unknown,
    ) => Promise<void>;
    const beginQuery = exports.beginQuery as (
      root: string,
      question: string,
    ) => Promise<{
      setup: { status: string };
      deltaBootstrap: { required: boolean; pendingSourceIds: string[] };
    }>;
    const state = await readBrainState(root);
    await writeBrainState(root, {
      ...state,
      setup: {
        status: "completed",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "Astronomy concepts",
        startedAt: "2026-08-27T00:00:00.000Z",
        completedAt: "2026-08-27T01:00:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });
    await writeFile(
      path.join(root, "sources", "later.md"),
      "# Later\n\nA later source arrives after setup.\n",
    );

    const session = await beginQuery(root, "What arrived later?");

    expect(session.setup.status).toBe("completed");
    expect(session.deltaBootstrap).toMatchObject({ required: true });
    expect(session.deltaBootstrap.pendingSourceIds).toHaveLength(1);
    expect((await readBrainState(root)).setup).toMatchObject({
      status: "completed",
    });
  });

  test("attaches a setup-bound source-page mutation to its checkpoint", async () => {
    const root = await brainWithInitialSource();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;

    expect(exports).toHaveProperty("attachSetupChange");
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
    ) => Promise<{ id: string }>;
    const nextSetupBatch = exports.nextSetupBatch as (
      root: string,
      setupId: string,
    ) => Promise<{
      sources: Array<{
        record: { id: string; title: string };
        extracted?: { chunks: Array<{ locator: string; text: string }> };
      }>;
    }>;
    const applyChangeSetTransaction = exports.applyChangeSetTransaction as (
      root: string,
      changeSet: unknown,
      options: unknown,
    ) => Promise<{ operationId: string }>;
    const attachSetupChange = exports.attachSetupChange as (
      root: string,
      setupId: string,
      operationId: string,
    ) => Promise<{ pendingSourceIds: string[] }>;
    const calculateCatalogRevision = exports.calculateCatalogRevision as (
      pages: WikiPageV1[],
    ) => string;
    const setup = await beginSetup(
      root,
      { purpose: "Astronomy concepts" },
      services,
    );
    const context = (await nextSetupBatch(root, setup.id)).sources[0];
    const chunk = context?.extracted?.chunks[0];
    if (!context || !chunk) throw new Error("Expected setup source context");
    const page: WikiPageV1 = {
      schema: 1,
      id: "pg_orbit_source",
      path: "wiki/pages/sources/orbit.md",
      title: "Orbit source",
      type: "source",
      status: "active",
      summary: "A catalog entry for orbital evidence.",
      aliases: [],
      tags: [],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      revision: "pending",
      sources: [{ id: context.record.id, locators: [chunk.locator] }],
      relations: [],
      body: `# Orbit source\n\n${chunk.text} [@${context.record.id}#${chunk.locator}]`,
    };
    const result = await applyChangeSetTransaction(
      root,
      {
        version: 1,
        operationId: "op_setup_orbit_page",
        catalogRevision: calculateCatalogRevision([]),
        reason: "Create the setup source page",
        pages: [{ action: "create", page }],
        reconciliation: { candidatePageIds: [], reviewed: [] },
      },
      { context: { kind: "setup", id: setup.id } },
    );

    const checkpoint = await attachSetupChange(
      root,
      setup.id,
      result.operationId,
    );

    expect(checkpoint.pendingSourceIds).toEqual([]);
  });

  test("returns checkpointable source context for the active setup", async () => {
    const root = await brainWithInitialSource();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;

    expect(exports).toHaveProperty("nextSetupBatch");
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
    ) => Promise<{ id: string }>;
    const nextSetupBatch = exports.nextSetupBatch as (
      root: string,
      setupId: string,
    ) => Promise<{
      setupId: string;
      sources: Array<{
        record: { path: string };
        extracted?: { text: string };
      }>;
    }>;
    const setup = await beginSetup(
      root,
      { purpose: "Astronomy concepts" },
      services,
    );

    const batch = await nextSetupBatch(root, setup.id);

    expect(batch.setupId).toBe(setup.id);
    expect(batch.sources).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({ path: "sources/orbit.md" }),
        extracted: expect.objectContaining({
          text: expect.stringContaining("Bodies orbit"),
        }),
      }),
    ]);
  });

  test("starts a resumable setup and refuses completion before every ready source has a page", async () => {
    const root = await brainWithInitialSource();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;

    expect(exports).toHaveProperty("beginSetup");
    expect(exports).toHaveProperty("finishSetup");
    const beginSetup = exports.beginSetup as (
      root: string,
      input: { purpose: string },
      services: typeof services,
    ) => Promise<{ id: string; status: string; pendingSourceIds: string[] }>;
    const finishSetup = exports.finishSetup as (
      root: string,
      setupId: string,
      input: { summary: string },
    ) => Promise<unknown>;

    const setup = await beginSetup(
      root,
      { purpose: "Astronomy concepts" },
      services,
    );

    expect(setup).toMatchObject({ status: "in-progress" });
    expect(setup.pendingSourceIds).toHaveLength(1);
    await expect(
      finishSetup(root, setup.id, { summary: "Initial map" }),
    ).rejects.toThrow(/source page.*orbit/i);
  });
});
