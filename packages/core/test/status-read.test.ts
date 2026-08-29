import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  initBrain,
  inspectOnboarding,
  onboardingStatusV1Schema,
  readBrainState,
  readBrainItem,
  renderWikiPage,
  scanSources,
  statusBrain,
  writeBrainState,
  type WikiPageV1,
} from "../src/index.js";

async function initializedBrain(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-onboarding-"));
  await initBrain(root, { name, description: `${name} source material.` });
  return root;
}

describe("brain status and reading", () => {
  test("reports template and initialized-empty onboarding states without writing files", async () => {
    const templateRoot = await initializedBrain("Portable Second Brain");
    await writeFile(
      path.join(templateRoot, "brain.config.yaml"),
      `version: 1\nbrain:\n  name: Portable Second Brain\n  description: A self-maintaining personal knowledge base.\n  language: en\n`,
    );
    const initializedEmptyRoot = await initializedBrain("Astronomy");
    const stateBefore = await readFile(
      path.join(initializedEmptyRoot, ".brain", "state.json"),
      "utf8",
    );

    expect((await inspectOnboarding(templateRoot)).phase).toBe(
      "needs-initialization",
    );
    expect(await inspectOnboarding(initializedEmptyRoot)).toMatchObject({
      phase: "awaiting-sources",
      nextAction: "add-sources",
      sourceFiles: { discovered: 0, registered: 0 },
    });
    expect(
      await readFile(
        path.join(initializedEmptyRoot, ".brain", "state.json"),
        "utf8",
      ),
    ).toBe(stateBefore);
    await expect(
      readFile(
        path.join(initializedEmptyRoot, ".brain", "cache", "index.sqlite"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("discovers supported source candidates without extracting or registering them", async () => {
    const root = await initializedBrain("Mixed sources");
    await writeFile(path.join(root, "sources", "paper.pdf"), "not a PDF");
    await writeFile(path.join(root, "sources", "notes.docx"), "not a DOCX");
    await writeFile(path.join(root, "sources", "diagram.png"), "pixels");
    await writeFile(path.join(root, "sources", ".hidden.pdf"), "hidden");
    await mkdir(path.join(root, "sources", ".private"));
    await writeFile(
      path.join(root, "sources", ".private", "secret.docx"),
      "hidden",
    );

    const onboarding = await inspectOnboarding(root);

    expect(onboarding).toMatchObject({
      phase: "sources-unregistered",
      nextAction: "scan-sources",
      sourceFiles: {
        discovered: 3,
        supportedCandidates: 2,
        unsupportedCandidates: 1,
        registered: 0,
        samplePaths: [
          "sources/diagram.png",
          "sources/notes.docx",
          "sources/paper.pdf",
        ],
      },
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(root, ".brain", "source-manifest.json"),
          "utf8",
        ),
      ).sources,
    ).toEqual([]);
  });

  test("reports blocked extraction, pending charter, active setup, and completed setup", async () => {
    const blockedRoot = await initializedBrain("Blocked");
    await writeFile(path.join(blockedRoot, "sources", "image.png"), "pixels");
    await scanSources(blockedRoot);
    expect(await inspectOnboarding(blockedRoot)).toMatchObject({
      phase: "sources-blocked",
      nextAction: "resolve-source-errors",
      sourceFiles: { registered: 1, ready: 0, unsupported: 1 },
    });

    const pendingRoot = await initializedBrain("Pending charter");
    await writeFile(
      path.join(pendingRoot, "sources", "stars.md"),
      "# Stars\n\nStellar evidence.\n",
    );
    await scanSources(pendingRoot);
    expect(await inspectOnboarding(pendingRoot)).toMatchObject({
      phase: "awaiting-charter",
      nextAction: "set-charter",
      charter: { configured: false, origin: "pending" },
      sourceFiles: { registered: 1, ready: 1 },
    });

    const state = await readBrainState(pendingRoot);
    await writeBrainState(pendingRoot, {
      ...state,
      setup: {
        status: "in-progress",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "Catalog stellar evidence",
        startedAt: "2026-08-29T00:00:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });
    expect(await inspectOnboarding(pendingRoot)).toMatchObject({
      phase: "setup-in-progress",
      nextAction: "resume-setup",
    });

    await writeBrainState(pendingRoot, {
      ...state,
      setup: {
        status: "completed",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "Catalog stellar evidence",
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:01:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });
    expect(await inspectOnboarding(pendingRoot)).toMatchObject({
      phase: "ready",
      nextAction: "ask-question",
    });
  });

  test("recognizes a configured legacy charter and exposes onboarding through status", async () => {
    const root = await initializedBrain("Legacy charter");
    await writeFile(
      path.join(root, "BRAIN.md"),
      "# Legacy charter\n\nAstronomy reference material.\n\n## Purpose\n\nAnswer astronomy questions from registered evidence.\n\n## Boundaries\n\nOnly the supplied astronomy corpus.\n",
    );
    await writeFile(
      path.join(root, "sources", "stars.md"),
      "# Stars\n\nStellar evidence.\n",
    );
    await scanSources(root);

    const onboarding = await inspectOnboarding(root);
    const status = await statusBrain(root);

    expect(onboardingStatusV1Schema.parse(onboarding)).toMatchObject({
      phase: "ready-for-setup",
      nextAction: "begin-setup",
      charter: { configured: true, origin: "legacy" },
    });
    expect(status.onboarding).toEqual(onboarding);
  });

  test("defaults legacy state to an unconfigured setup and sync status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-status-legacy-"));
    await initBrain(root, { name: "Legacy", description: "Legacy state" });
    await writeFile(
      path.join(root, ".brain", "state.json"),
      `${JSON.stringify({
        version: 1,
        catalogRevision: "empty",
        knowledgeMutations: 0,
        lastSemanticAuditMutation: 0,
        bootstrap: { status: "pending", pendingSourceIds: [] },
      })}\n`,
    );

    expect(await statusBrain(root)).toMatchObject({
      setup: { status: "not-started", required: true },
      sync: { status: "unconfigured" },
    });
  });

  test("reports canonical counts and reads page or source records by stable ID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-status-"));
    await initBrain(root, { name: "Status", description: "Status tests" });
    await writeFile(
      path.join(root, "sources", "stars.md"),
      "# Stars\n\nStars emit light.\n",
    );
    const scan = await scanSources(root);
    const source = scan.added[0];
    if (!source) throw new Error("Expected a source");
    const page: WikiPageV1 = {
      schema: 1,
      id: "pg_stars_source",
      path: "wiki/pages/sources/stars.md",
      title: "Stars source",
      type: "source",
      status: "active",
      summary: "A source about stars.",
      aliases: [],
      tags: ["astronomy"],
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      revision: "pending",
      sources: [{ id: source.id, locators: ["heading=stars"] }],
      relations: [],
      body: `# Stars source\n\nStars emit light. [@${source.id}#heading=stars]`,
    };
    await writeFile(path.join(root, page.path), renderWikiPage(page));

    const status = await statusBrain(root);
    const pageRead = await readBrainItem(root, page.id);
    await rm(path.join(root, ".brain", "cache"), {
      recursive: true,
      force: true,
    });
    const sourceRead = await readBrainItem(root, source.id, "heading=stars");

    expect(status).toMatchObject({
      version: 1,
      brain: { name: "Status" },
      sources: { total: 1, ready: 1 },
      wiki: { pages: 1 },
      bootstrap: { required: false },
      recovery: { required: false },
    });
    expect(pageRead).toMatchObject({ kind: "wiki", page: { id: page.id } });
    expect(sourceRead).toMatchObject({
      kind: "source",
      source: { id: source.id },
      chunks: [{ locator: "heading=stars" }],
    });
    await expect(readBrainItem(root, "pg_missing_page")).rejects.toThrow(
      /not found/i,
    );
  });
});
