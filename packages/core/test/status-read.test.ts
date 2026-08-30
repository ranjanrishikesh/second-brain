import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  doctorBrain,
  initBrain,
  inspectOnboarding,
  onboardingStatusV1Schema,
  readBrainState,
  readBrainItem,
  renderWikiPage,
  scanAndRegisterSources,
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
    expect((await statusBrain(initializedEmptyRoot)).support).toEqual({
      issueTrackerUrl: "https://github.com/ranjanrishikesh/second-brain/issues",
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

  test("treats content-identical source paths as durably acknowledged after scanning", async () => {
    const root = await initializedBrain("Duplicate sources");
    const sourceBytes = "# Shared evidence\n\nOne canonical source body.\n";
    await writeFile(path.join(root, "sources", "original.md"), sourceBytes);
    await scanAndRegisterSources(root);
    await writeFile(path.join(root, "sources", "copy.md"), sourceBytes);

    expect(await inspectOnboarding(root)).toMatchObject({
      phase: "sources-unregistered",
      nextAction: "scan-sources",
    });

    const scan = await scanAndRegisterSources(root);
    const operationsAfterAcknowledgement = await readFile(
      path.join(root, ".brain", "operations.jsonl"),
      "utf8",
    );

    expect(scan).toMatchObject({
      added: [],
      duplicates: [
        {
          path: "sources/copy.md",
          sourceId: expect.stringMatching(/^src_[a-f0-9]{16}$/),
        },
      ],
    });
    expect(await inspectOnboarding(root)).toMatchObject({
      phase: "ready-for-setup",
      nextAction: "begin-setup",
      sourceFiles: { discovered: 2, registered: 1, ready: 1 },
    });
    expect((await readBrainState(root)).sourceDuplicates).toEqual([
      {
        path: "sources/copy.md",
        sourceId: expect.stringMatching(/^src_[a-f0-9]{16}$/),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bytes: Buffer.byteLength(sourceBytes),
      },
    ]);

    await scanAndRegisterSources(root);
    expect(
      await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8"),
    ).toBe(operationsAfterAcknowledgement);

    const sameSizeChangedBytes = sourceBytes.replace("One", "Two");
    expect(Buffer.byteLength(sameSizeChangedBytes)).toBe(
      Buffer.byteLength(sourceBytes),
    );
    await writeFile(
      path.join(root, "sources", "copy.md"),
      sameSizeChangedBytes,
    );
    // Routine status remains metadata-only; doctor performs the expensive
    // cryptographic verification and catches same-size byte changes.
    expect(await inspectOnboarding(root)).toMatchObject({
      phase: "ready-for-setup",
      nextAction: "begin-setup",
    });
    expect(await doctorBrain(root)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_DUPLICATE_MISMATCH",
          severity: "error",
          path: "sources/copy.md",
        }),
      ]),
    });

    await writeFile(
      path.join(root, "sources", "copy.md"),
      "# Independent evidence\n\nThis is no longer a duplicate.\n",
    );
    expect(await inspectOnboarding(root)).toMatchObject({
      phase: "sources-unregistered",
      nextAction: "scan-sources",
    });
    expect(await doctorBrain(root)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_DUPLICATE_MISMATCH",
          severity: "error",
          path: "sources/copy.md",
        }),
      ]),
    });

    const replacementScan = await scanAndRegisterSources(root);
    expect(replacementScan.added).toEqual([
      expect.objectContaining({ path: "sources/copy.md" }),
    ]);
    expect((await readBrainState(root)).sourceDuplicates).toEqual([]);
  });

  test.each(["mutated", "deleted", "redirected outside"] as const)(
    "reports a %s duplicate web sidecar through duplicate integrity",
    async (condition) => {
      const root = await initializedBrain("Duplicate web sources");
      const artifactBytes = new TextEncoder().encode(
        "Shared web artifact evidence.\n",
      );
      await writeFile(
        path.join(root, "sources", "original.txt"),
        artifactBytes,
      );
      await scanAndRegisterSources(root);
      const sourcePath = "sources/web/2026/08/copy.txt";
      const sidecarPath = "sources/web/2026/08/.copy.txt.web.json";
      await mkdir(path.join(root, path.dirname(sourcePath)), {
        recursive: true,
      });
      await writeFile(path.join(root, sourcePath), artifactBytes);
      const sidecar = {
        brainWebArtifact: 1,
        sourcePath,
        artifactSha256: createHash("sha256")
          .update(artifactBytes)
          .digest("hex"),
        artifactBytes: artifactBytes.byteLength,
        title: "Alpha",
        format: "text",
        mediaType: "text/plain",
        discovery: {
          originalUrl: "https://example.com/copy.txt",
          finalUrl: "https://example.com/copy.txt",
          redirectChain: [],
          retrievedAt: "2026-08-30T00:00:00.000Z",
          queryId: "qry_0123456789abcdef0123456789abcdef",
          questionHash: "c".repeat(64),
          query: "What does the shared evidence say?",
          representation: "artifact",
          completeness: "complete",
        },
      };
      await writeFile(
        path.join(root, sidecarPath),
        `${JSON.stringify(sidecar, null, 2)}\n`,
      );
      await scanAndRegisterSources(root);
      if (condition === "mutated") {
        sidecar.title = "Bravo";
        await writeFile(
          path.join(root, sidecarPath),
          `${JSON.stringify(sidecar, null, 2)}\n`,
        );
      } else if (condition === "deleted") {
        await rm(path.join(root, sidecarPath));
        expect(await inspectOnboarding(root)).toMatchObject({
          phase: "sources-unregistered",
          nextAction: "scan-sources",
        });
      } else {
        const outside = await mkdtemp(
          path.join(tmpdir(), "brain-duplicate-sidecar-outside-"),
        );
        await writeFile(
          path.join(outside, "sidecar.json"),
          await readFile(path.join(root, sidecarPath)),
        );
        await symlink(outside, path.join(root, "sources", "sidecar-link"));
        const statePath = path.join(root, ".brain", "state.json");
        const state = JSON.parse(await readFile(statePath, "utf8"));
        state.sourceDuplicates[0].sidecarPath =
          "sources/sidecar-link/sidecar.json";
        await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
      }

      expect(await doctorBrain(root)).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "SOURCE_DUPLICATE_MISMATCH",
            severity: "error",
            path: sourcePath,
          }),
        ]),
      });
    },
  );

  test("rejects a partial duplicate sidecar acknowledgement", async () => {
    const root = await initializedBrain("Partial duplicate sidecar");
    const statePath = path.join(root, ".brain", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.sourceDuplicates = [
      {
        path: "sources/web/2026/08/copy.txt",
        sourceId: "src_0123456789abcdef",
        sha256: "a".repeat(64),
        bytes: 12,
        sidecarPath: "sources/web/2026/08/.copy.txt.web.json",
      },
    ];
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    await expect(readBrainState(root)).rejects.toThrow(/sidecar/i);

    state.sourceDuplicates[0] = {
      ...state.sourceDuplicates[0],
      sidecarSha256: "b".repeat(64),
      sidecarBytes: 34,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await expect(readBrainState(root)).resolves.toMatchObject({
      sourceDuplicates: [
        expect.objectContaining({
          sidecarPath: "sources/web/2026/08/.copy.txt.web.json",
          sidecarSha256: "b".repeat(64),
          sidecarBytes: 34,
        }),
      ],
    });
  });

  test("rejects a partial primary fingerprint while preserving legacy duplicate state", async () => {
    const root = await initializedBrain("Partial duplicate fingerprint");
    const statePath = path.join(root, ".brain", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.sourceDuplicates = [
      {
        path: "sources/copy.txt",
        sourceId: "src_0123456789abcdef",
        sha256: "a".repeat(64),
      },
    ];
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    await expect(readBrainState(root)).rejects.toThrow();

    delete state.sourceDuplicates[0].sha256;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await expect(readBrainState(root)).resolves.toMatchObject({
      sourceDuplicates: [
        {
          path: "sources/copy.txt",
          sourceId: "src_0123456789abcdef",
        },
      ],
    });
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
      path.join(pendingRoot, "BRAIN.md"),
      "# Pending charter\n\nPending charter source material.\n\n## Purpose\n\nReplace this section after cloning with the domain this brain should support.\n",
    );
    await writeFile(
      path.join(pendingRoot, "sources", "stars.md"),
      "# Stars\n\nStellar evidence.\n",
    );
    const pendingScan = await scanSources(pendingRoot);
    const pendingSource = pendingScan.added[0];
    if (!pendingSource) throw new Error("Expected a ready source");
    expect(await inspectOnboarding(pendingRoot)).toMatchObject({
      phase: "awaiting-charter",
      nextAction: "set-charter",
      charter: { configured: false, origin: "pending" },
      sourceFiles: { registered: 1, ready: 1 },
    });
    await writeFile(
      path.join(pendingRoot, "BRAIN.md"),
      "# Pending charter\n\nStellar evidence brain.\n\n## Purpose\n\nCatalog and answer questions from stellar evidence.\n",
    );
    const pendingSourcePage: WikiPageV1 = {
      schema: 1,
      id: "pg_pending_stars_source",
      path: "wiki/pages/sources/pending-stars.md",
      title: "Pending stars source",
      type: "source",
      status: "active",
      summary: "The registered stellar evidence source.",
      aliases: [],
      tags: ["astronomy"],
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      revision: "pending",
      sources: [{ id: pendingSource.id, locators: ["heading=stars"] }],
      relations: [],
      body: `# Pending stars source\n\nStellar evidence. [@${pendingSource.id}#heading=stars]`,
    };
    await writeFile(
      path.join(pendingRoot, pendingSourcePage.path),
      renderWikiPage(pendingSourcePage),
    );

    const state = await readBrainState(pendingRoot);
    await writeBrainState(pendingRoot, {
      ...state,
      setup: {
        status: "in-progress",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "Catalog stellar evidence",
        startedAt: "2026-08-29T00:00:00.000Z",
        initialSourceIds: [pendingSource.id],
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
        initialSourceIds: [pendingSource.id],
        pendingSourceIds: [],
      },
    });
    expect(await inspectOnboarding(pendingRoot)).toMatchObject({
      phase: "ready",
      nextAction: "ask-question",
    });

    await writeFile(
      path.join(pendingRoot, "sources", "later-delta.md"),
      "# Later delta\n\nEvidence added after initial setup.\n",
    );
    await scanAndRegisterSources(pendingRoot);
    expect(await inspectOnboarding(pendingRoot)).toMatchObject({
      phase: "ready",
      nextAction: "ask-question",
      setup: { status: "completed" },
      sourceFiles: { registered: 2, ready: 2 },
    });
  });

  test("does not report a completed setup as ready when readiness invariants are missing", async () => {
    const emptyRoot = await initializedBrain("Completed without sources");
    const emptyState = await readBrainState(emptyRoot);
    await writeBrainState(emptyRoot, {
      ...emptyState,
      setup: {
        status: "completed",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "Legacy completed setup",
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:01:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });

    expect(await inspectOnboarding(emptyRoot)).toMatchObject({
      phase: "awaiting-sources",
      nextAction: "add-sources",
    });
    expect(await doctorBrain(emptyRoot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "SETUP_STATE_INVALID",
          severity: "error",
        }),
      ]),
    });

    const pendingCharterRoot = await initializedBrain(
      "Completed without charter",
    );
    await writeFile(
      path.join(pendingCharterRoot, "sources", "evidence.md"),
      "# Evidence\n\nUsable source material.\n",
    );
    await scanAndRegisterSources(pendingCharterRoot);
    await writeFile(
      path.join(pendingCharterRoot, "BRAIN.md"),
      "# Completed without charter\n\n## Purpose\n\nReplace this section after cloning.\n",
    );
    const pendingState = await readBrainState(pendingCharterRoot);
    await writeBrainState(pendingCharterRoot, {
      ...pendingState,
      setup: {
        status: "completed",
        id: "setup_abcdef0123456789abcdef0123456789",
        purpose: "Legacy completed setup",
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:01:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });

    expect(await inspectOnboarding(pendingCharterRoot)).toMatchObject({
      phase: "awaiting-charter",
      nextAction: "set-charter",
    });
    expect(await doctorBrain(pendingCharterRoot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "SETUP_STATE_INVALID" }),
      ]),
    });

    const missingPageRoot = await initializedBrain(
      "Completed without source pages",
    );
    await writeFile(
      path.join(missingPageRoot, "sources", "evidence.md"),
      "# Evidence\n\nUsable source material.\n",
    );
    const missingPageScan = await scanAndRegisterSources(missingPageRoot);
    const missingPageSource = missingPageScan.added[0];
    if (!missingPageSource) throw new Error("Expected a ready source");
    const missingPageState = await readBrainState(missingPageRoot);
    await writeBrainState(missingPageRoot, {
      ...missingPageState,
      setup: {
        status: "completed",
        id: "setup_fedcba9876543210fedcba9876543210",
        purpose: "Catalog the initial evidence",
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:01:00.000Z",
        initialSourceIds: [missingPageSource.id],
        pendingSourceIds: [],
      },
    });

    expect(await inspectOnboarding(missingPageRoot)).toMatchObject({
      phase: "setup-in-progress",
      nextAction: "resume-setup",
    });
    expect(await doctorBrain(missingPageRoot)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "SETUP_STATE_INVALID",
          severity: "error",
        }),
      ]),
    });
  });

  test("requires matching declared inline citations for completed source-page coverage", async () => {
    const root = await initializedBrain("Completed citation coverage");
    await writeFile(
      path.join(root, "sources", "evidence.md"),
      "# Evidence\n\nUsable source material.\n",
    );
    const scan = await scanAndRegisterSources(root);
    const source = scan.added[0];
    if (!source) throw new Error("Expected a ready source");
    const sourcePage: WikiPageV1 = {
      schema: 1,
      id: "pg_completed_citation_source",
      path: "wiki/pages/completed-citation-source.md",
      title: "Completed citation source",
      type: "source",
      status: "active",
      summary: "A completed source page requiring cited coverage.",
      aliases: [],
      tags: [],
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      revision: "pending",
      sources: [{ id: source.id, locators: ["heading=evidence"] }],
      relations: [],
      body: "# Completed citation source\n\nThe declaration is initially uncited.",
    };
    await writeFile(
      path.join(root, sourcePage.path),
      renderWikiPage(sourcePage),
    );
    const state = await readBrainState(root);
    await writeBrainState(root, {
      ...state,
      setup: {
        status: "completed",
        id: "setup_1234567890abcdef1234567890abcdef",
        purpose: "Catalog cited evidence",
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:01:00.000Z",
        initialSourceIds: [source.id],
        pendingSourceIds: [],
      },
    });

    expect(await inspectOnboarding(root)).toMatchObject({
      phase: "setup-in-progress",
      nextAction: "resume-setup",
    });
    expect(await doctorBrain(root)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "SETUP_STATE_INVALID",
          severity: "error",
        }),
      ]),
    });

    await writeFile(
      path.join(root, sourcePage.path),
      renderWikiPage({
        ...sourcePage,
        body: `# Completed citation source\n\nThe evidence is cited. [@${source.id}#heading=evidence]`,
      }),
    );

    expect(await inspectOnboarding(root)).toMatchObject({
      phase: "ready",
      nextAction: "ask-question",
    });
    expect((await doctorBrain(root)).issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SETUP_STATE_INVALID" }),
      ]),
    );
  });

  test("rejects empty and malformed managed charters instead of treating them as legacy", async () => {
    const root = await initializedBrain("Invalid charter");
    await writeFile(
      path.join(root, "sources", "evidence.md"),
      "# Evidence\n\nUsable source material.\n",
    );
    await scanAndRegisterSources(root);

    for (const invalidCharter of [
      "",
      "---\nbrainCharter: 2\norigin: inferred\n---\n\n# Invalid charter\n",
      "---\nbrainCharter: 1\norigin: inferred\n\n# Missing close\n",
      "#    \n\nAstronomy reference material.\n\n## Purpose\n\nAnswer astronomy questions from registered evidence.\n",
    ]) {
      await writeFile(path.join(root, "BRAIN.md"), invalidCharter);

      expect(await inspectOnboarding(root)).toMatchObject({
        phase: "awaiting-charter",
        nextAction: "set-charter",
        charter: { configured: false, origin: "pending" },
      });
      expect(await doctorBrain(root)).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "CHARTER_INVALID",
            severity: "error",
          }),
        ]),
      });
    }
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
