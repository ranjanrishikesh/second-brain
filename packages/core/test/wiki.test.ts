import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, test } from "vitest";
import {
  applyWikiChangeSet,
  buildReconciliationCandidates,
  type ChangeSetV1,
  calculateCatalogRevision,
  calculatePageRevision,
  initBrain,
  parseWikiPage,
  renderWikiPage,
  type SourceRecordV1,
  scanSources,
  validateWikiGraph,
  type WikiPageV1,
  writeGeneratedWikiFiles,
} from "../src/index.js";

function conceptPage(overrides: Partial<WikiPageV1> = {}): WikiPageV1 {
  return {
    schema: 1,
    id: "pg_orbital_mechanics",
    path: "wiki/pages/concepts/orbital-mechanics.md",
    title: "Orbital Mechanics",
    type: "concept",
    status: "active",
    summary: "How bodies move under gravity.",
    aliases: ["orbital dynamics"],
    tags: ["physics"],
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    revision: "pending",
    sources: [{ id: "src_0123456789abcdef", locators: ["page=1"] }],
    relations: [],
    body: "# Orbital Mechanics\n\nAn orbit is governed by gravity. [@src_0123456789abcdef#page=1]",
    ...overrides,
  };
}

const webArtifactDirectory = "sources/web/2026/08";

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function registerWebArtifact(
  root: string,
  bytes: Uint8Array,
  fileName = "integrity.txt",
) {
  const sourcePath = `${webArtifactDirectory}/${fileName}`;
  const sidecarPath = `${webArtifactDirectory}/.${fileName}.web.json`;
  const extension = path.extname(fileName).slice(1);
  const format = extension === "txt" ? "text" : extension;
  const sidecar = {
    brainWebArtifact: 1,
    sourcePath,
    artifactSha256: sha256(bytes),
    artifactBytes: bytes.byteLength,
    title: "Integrity evidence",
    format,
    mediaType: extension === "pdf" ? "application/pdf" : "text/plain",
    discovery: {
      originalUrl: `https://example.com/${fileName}`,
      finalUrl: `https://example.com/${fileName}`,
      redirectChain: [],
      retrievedAt: "2026-08-30T00:00:00.000Z",
      queryId: "qry_0123456789abcdef0123456789abcdef",
      questionHash: "c".repeat(64),
      query: "What does the integrity evidence say?",
      representation: "artifact",
      completeness: "complete",
    },
  };
  await mkdir(path.join(root, webArtifactDirectory), { recursive: true });
  await writeFile(path.join(root, sourcePath), bytes);
  await writeFile(
    path.join(root, sidecarPath),
    `${JSON.stringify(sidecar, null, 2)}\n`,
  );
  const source = (await scanSources(root)).added[0];
  if (!source) throw new Error("Expected registered web artifact");
  return { source, sourcePath, sidecarPath };
}

async function updateRegisteredSource(
  root: string,
  update: (source: SourceRecordV1) => void,
): Promise<void> {
  const manifestPath = path.join(root, ".brain", "source-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  update(manifest.sources[0] as SourceRecordV1);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("wiki page format", () => {
  test.each([
    [
      "WEB_ARTIFACT_SIDECAR_MISSING",
      async (root: string, sidecarPath: string) => {
        await rm(path.join(root, sidecarPath));
      },
    ],
    [
      "WEB_ARTIFACT_SIDECAR_INVALID",
      async (root: string, sidecarPath: string) => {
        await writeFile(path.join(root, sidecarPath), "{}\n");
      },
    ],
    [
      "WEB_ARTIFACT_SIDECAR_PATH_MISMATCH",
      async (root: string) => {
        await updateRegisteredSource(root, (source) => {
          source.provenance.sidecarPath = `${webArtifactDirectory}/.different.txt.web.json`;
        });
      },
    ],
    [
      "WEB_ARTIFACT_SIDECAR_HASH_MISMATCH",
      async (root: string, sidecarPath: string) => {
        const current = await readFile(path.join(root, sidecarPath), "utf8");
        await writeFile(path.join(root, sidecarPath), `${current}\n`);
      },
    ],
    [
      "WEB_ARTIFACT_SOURCE_MISMATCH",
      async (root: string) => {
        await updateRegisteredSource(root, (source) => {
          source.provenance.url = "https://example.com/different.txt";
        });
      },
    ],
    [
      "WEB_ARTIFACT_SOURCE_MISMATCH",
      async (root: string) => {
        await updateRegisteredSource(root, (source) => {
          delete source.provenance.representation;
        });
      },
    ],
    [
      "WEB_ARTIFACT_SOURCE_MISMATCH",
      async (root: string) => {
        await updateRegisteredSource(root, (source) => {
          delete source.provenance.representation;
          delete source.provenance.sidecarPath;
          delete source.provenance.sidecarSha256;
          delete source.provenance.sidecarBytes;
          delete source.provenance.webDiscoveries;
        });
      },
    ],
  ])("reports structural issue %s", async (code, corrupt) => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-graph-web-"));
    await initBrain(root, { name: "Graph", description: "Web integrity" });
    const { sidecarPath } = await registerWebArtifact(
      root,
      new TextEncoder().encode("Integrity evidence.\n"),
    );
    await corrupt(root, sidecarPath);

    const report = await validateWikiGraph(root);

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code, severity: "error" }),
    );
  });

  test("rejects factual citations to non-ready sources but allows locator-free gap references", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-non-ready-citation-"),
    );
    await initBrain(root, {
      name: "Graph",
      description: "Citation readiness",
    });
    const document = await PDFDocument.create();
    document.addPage();
    const { source } = await registerWebArtifact(
      root,
      await document.save(),
      "image-only.pdf",
    );
    expect(source.extractionStatus).toBe("extraction-required");
    const gap = conceptPage({
      id: "pg_missing_web_evidence",
      path: "wiki/pages/questions/missing-web-evidence.md",
      title: "Missing web evidence",
      type: "question",
      aliases: [],
      sources: [{ id: source.id, locators: [] }],
      body: "# Missing web evidence\n\nThe captured PDF needs text extraction.",
    });
    const claim = conceptPage({
      id: "pg_unsupported_web_claim",
      path: "wiki/pages/sources/unsupported-web-claim.md",
      title: "Unsupported web claim",
      type: "source",
      aliases: [],
      sources: [{ id: source.id, locators: ["page=1"] }],
      body: `# Unsupported web claim\n\nThe PDF proves the claim. [@${source.id}#page=1]`,
    });
    await writeFile(path.join(root, gap.path), renderWikiPage(gap));
    await writeFile(path.join(root, claim.path), renderWikiPage(claim));

    const report = await validateWikiGraph(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCE_NOT_READY_FOR_CITATION",
        pageId: claim.id,
      }),
    );
    expect(report.issues).not.toContainEqual(
      expect.objectContaining({
        code: "SOURCE_NOT_READY_FOR_CITATION",
        pageId: gap.id,
      }),
    );
  });

  test("round-trips canonical frontmatter and cited Markdown", () => {
    const markdown = renderWikiPage(conceptPage());

    const parsed = parseWikiPage(
      markdown,
      "wiki/pages/concepts/orbital-mechanics.md",
    );

    expect(parsed).toMatchObject({
      id: "pg_orbital_mechanics",
      title: "Orbital Mechanics",
      type: "concept",
      sources: [{ id: "src_0123456789abcdef", locators: ["page=1"] }],
    });
    expect(parsed.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.body).toContain("[@src_0123456789abcdef#page=1]");
  });

  test("reports a relationship whose target page does not exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-graph-"));
    await initBrain(root, { name: "Graph", description: "Graph validation" });
    const page = conceptPage({
      sources: [],
      body: "# Orbital Mechanics\n\nA concept page.",
      relations: [
        {
          targetId: "pg_missing_target",
          kind: "related-to",
          sourceIds: [],
        },
      ],
    });
    await writeFile(path.join(root, page.path), renderWikiPage(page));

    const report = await validateWikiGraph(root);

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "DANGLING_RELATION", pageId: page.id }),
    );
  });

  test("rejects citations to sources outside the manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-citations-"));
    await initBrain(root, {
      name: "Graph",
      description: "Citation validation",
    });
    const page = conceptPage();
    await writeFile(path.join(root, page.path), renderWikiPage(page));

    const report = await validateWikiGraph(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_SOURCE", pageId: page.id }),
    );
  });

  test("rejects a relationship to a missing target heading anchor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-anchors-"));
    await initBrain(root, { name: "Graph", description: "Anchor validation" });
    const target = conceptPage({
      id: "pg_gravity_concept",
      path: "wiki/pages/concepts/gravity.md",
      title: "Gravity",
      summary: "The attraction between masses.",
      sources: [],
      body: "# Gravity\n\n## Definition\n\nA concept page.",
    });
    const source = conceptPage({
      sources: [],
      body: "# Orbital Mechanics\n\nA concept page.",
      relations: [
        {
          targetId: target.id,
          kind: "depends-on",
          anchor: "missing-section",
          sourceIds: [],
        },
      ],
    });
    await writeFile(path.join(root, target.path), renderWikiPage(target));
    await writeFile(path.join(root, source.path), renderWikiPage(source));

    const report = await validateWikiGraph(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "DANGLING_ANCHOR", pageId: source.id }),
    );
  });

  test("rejects duplicate titles and aliases across pages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-aliases-"));
    await initBrain(root, { name: "Graph", description: "Alias validation" });
    const first = conceptPage({
      sources: [],
      body: "# Orbital Mechanics\n\nOne page.",
    });
    const second = conceptPage({
      id: "pg_orbital_dynamics",
      path: "wiki/pages/concepts/orbital-dynamics.md",
      title: "Orbital Dynamics",
      aliases: ["orbital mechanics"],
      sources: [],
      body: "# Orbital Dynamics\n\nAnother page.",
    });
    await writeFile(path.join(root, first.path), renderWikiPage(first));
    await writeFile(path.join(root, second.path), renderWikiPage(second));

    const report = await validateWikiGraph(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_PAGE_NAME",
        pageId: second.id,
      }),
    );
  });

  test("enforces configured page and relationship types", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-types-"));
    await initBrain(root, { name: "Graph", description: "Type validation" });
    const page = conceptPage({
      type: "alien",
      sources: [],
      body: "# Orbital Mechanics\n\nA page.",
      relations: [
        { targetId: "pg_missing_target", kind: "teleports-to", sourceIds: [] },
      ],
    });
    await writeFile(path.join(root, page.path), renderWikiPage(page));

    const report = await validateWikiGraph(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_PAGE_TYPE", pageId: page.id }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "UNKNOWN_RELATION_TYPE",
        pageId: page.id,
      }),
    );
  });

  test("reports active knowledge pages with no graph connection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-orphans-"));
    await initBrain(root, { name: "Graph", description: "Orphan validation" });
    const page = conceptPage({
      sources: [],
      body: "# Orbital Mechanics\n\nAn isolated page.",
    });
    await writeFile(path.join(root, page.path), renderWikiPage(page));

    const report = await validateWikiGraph(root);

    expect(report.orphanPageIds).toEqual([page.id]);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "ORPHAN_PAGE", pageId: page.id }),
    );
  });

  test("rejects citation locators absent from extracted source content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-locators-"));
    await initBrain(root, { name: "Graph", description: "Locator validation" });
    await writeFile(
      path.join(root, "sources", "gravity.md"),
      "# Gravity\n\nMass attracts mass.\n",
    );
    const scan = await scanSources(root);
    const sourceId = scan.added[0]?.id;
    if (!sourceId) throw new Error("Expected the source to be registered");
    const page = conceptPage({
      sources: [{ id: sourceId, locators: ["heading=missing"] }],
      body: `# Orbital Mechanics\n\nGravity matters. [@${sourceId}#heading=missing]`,
    });
    await writeFile(path.join(root, page.path), renderWikiPage(page));

    const report = await validateWikiGraph(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "INVALID_SOURCE_LOCATOR",
        pageId: page.id,
      }),
    );
  });

  test("requires every inline citation locator to match page frontmatter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-citation-contract-"));
    await initBrain(root, { name: "Graph", description: "Citation contract" });
    await writeFile(
      path.join(root, "sources", "gravity.md"),
      "# Gravity\n\nMass attracts mass.\n\n## Evidence\n\nObserved.\n",
    );
    const sourceId = (await scanSources(root)).added[0]?.id;
    if (!sourceId) throw new Error("Expected the source to be registered");
    const missingLocator = conceptPage({
      id: "pg_missing_locator",
      path: "wiki/pages/sources/missing-locator.md",
      type: "source",
      title: "Missing locator",
      aliases: [],
      sources: [{ id: sourceId, locators: ["heading=gravity"] }],
      body: `# Missing locator\n\nGravity matters. [@${sourceId}]`,
    });
    const undeclaredLocator = conceptPage({
      id: "pg_undeclared_locator",
      path: "wiki/pages/sources/undeclared-locator.md",
      type: "source",
      title: "Undeclared locator",
      aliases: [],
      sources: [{ id: sourceId, locators: ["heading=evidence"] }],
      body: `# Undeclared locator\n\nGravity matters. [@${sourceId}#heading=gravity]`,
    });
    await writeFile(
      path.join(root, missingLocator.path),
      renderWikiPage(missingLocator),
    );
    await writeFile(
      path.join(root, undeclaredLocator.path),
      renderWikiPage(undeclaredLocator),
    );

    const report = await validateWikiGraph(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "MISSING_CITATION_LOCATOR",
        pageId: missingLocator.id,
      }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "CITATION_NOT_DECLARED",
        pageId: undeclaredLocator.id,
      }),
    );
  });

  test("rebuilds missing extracted cache before validating locators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-locator-cache-"));
    await initBrain(root, { name: "Graph", description: "Cache rebuild" });
    await writeFile(
      path.join(root, "sources", "gravity.md"),
      "# Gravity\n\nMass attracts mass.\n",
    );
    const sourceId = (await scanSources(root)).added[0]?.id;
    if (!sourceId) throw new Error("Expected the source to be registered");
    const page = conceptPage({
      path: "wiki/pages/sources/gravity.md",
      type: "source",
      sources: [{ id: sourceId, locators: ["heading=gravity"] }],
      body: `# Orbital Mechanics\n\nGravity matters. [@${sourceId}#heading=gravity]`,
    });
    await writeFile(path.join(root, page.path), renderWikiPage(page));
    const cachePath = path.join(
      root,
      ".brain",
      "cache",
      "extracted",
      `${sourceId}.json`,
    );
    await rm(cachePath);

    const report = await validateWikiGraph(root);

    expect(report.issues).not.toContainEqual(
      expect.objectContaining({ code: "INVALID_SOURCE_LOCATOR" }),
    );
    await expect(access(cachePath)).resolves.toBeUndefined();
  });

  test("rebuilds a schema-valid extracted cache whose content hash is not canonical", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-locator-integrity-"));
    await initBrain(root, { name: "Graph", description: "Cache integrity" });
    await writeFile(
      path.join(root, "sources", "gravity.md"),
      "# Gravity\n\nMass attracts mass.\n",
    );
    const sourceId = (await scanSources(root)).added[0]?.id;
    if (!sourceId) throw new Error("Expected the source to be registered");
    const cachePath = path.join(
      root,
      ".brain",
      "cache",
      "extracted",
      `${sourceId}.json`,
    );
    await writeFile(
      cachePath,
      `${JSON.stringify(
        {
          version: 1,
          sourceId,
          title: "Gravity",
          text: "Invented evidence.",
          chunks: [
            {
              id: `${sourceId}:invented`,
              sourceId,
              ordinal: 0,
              locator: "heading=invented",
              text: "Invented evidence.",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const page = conceptPage({
      path: "wiki/pages/sources/gravity.md",
      type: "source",
      sources: [{ id: sourceId, locators: ["heading=invented"] }],
      body: `# Orbital Mechanics\n\nInvented claim. [@${sourceId}#heading=invented]`,
    });
    await writeFile(path.join(root, page.path), renderWikiPage(page));

    const report = await validateWikiGraph(root);
    const rebuilt = JSON.parse(await readFile(cachePath, "utf8"));

    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "INVALID_SOURCE_LOCATOR",
        pageId: page.id,
      }),
    );
    expect(
      rebuilt.chunks.map((chunk: { locator: string }) => chunk.locator),
    ).not.toContain("heading=invented");
  });

  test("generates connections, backlinks, and the global index", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-generated-"));
    await initBrain(root, {
      name: "Graph",
      description: "Generated navigation",
    });
    const target = conceptPage({
      id: "pg_gravity_concept",
      path: "wiki/pages/concepts/gravity.md",
      title: "Gravity",
      summary: "The attraction between masses.",
      aliases: [],
      sources: [],
      body: "# Gravity\n\n## Definition\n\nA concept page.",
    });
    const source = conceptPage({
      sources: [],
      body: "# Orbital Mechanics\n\nA concept page.",
      relations: [
        {
          targetId: target.id,
          kind: "depends-on",
          anchor: "definition",
          note: "Gravity shapes orbits.",
          sourceIds: [],
        },
      ],
    });
    await writeFile(path.join(root, target.path), renderWikiPage(target));
    await writeFile(path.join(root, source.path), renderWikiPage(source));

    await writeGeneratedWikiFiles(root);

    const targetMarkdown = await import("node:fs/promises").then(
      ({ readFile }) => readFile(path.join(root, target.path), "utf8"),
    );
    const sourceMarkdown = await import("node:fs/promises").then(
      ({ readFile }) => readFile(path.join(root, source.path), "utf8"),
    );
    const index = await import("node:fs/promises").then(({ readFile }) =>
      readFile(path.join(root, "wiki", "index.md"), "utf8"),
    );
    expect(sourceMarkdown).toContain("## Connections");
    expect(sourceMarkdown).toContain(
      "[[pages/concepts/gravity#definition|Gravity § definition]]",
    );
    expect(targetMarkdown).toContain("## Backlinks");
    expect(targetMarkdown).toContain("Orbital Mechanics");
    expect(index).toContain(
      "[[pages/concepts/orbital-mechanics|Orbital Mechanics]]",
    );
    expect(() => parseWikiPage(targetMarkdown, target.path)).not.toThrow();
  });

  test("reports unresolved Obsidian wikilinks in authored content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-wikilinks-"));
    await initBrain(root, {
      name: "Graph",
      description: "Wikilink validation",
    });
    const page = conceptPage({
      sources: [],
      body: "# Orbital Mechanics\n\nSee [[pages/concepts/missing#definition|Missing]].",
    });
    await writeFile(path.join(root, page.path), renderWikiPage(page));

    const report = await validateWikiGraph(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "DANGLING_WIKILINK", pageId: page.id }),
    );
  });

  test("rejects a page update without reconciliation decisions for every candidate", () => {
    const target = conceptPage({
      id: "pg_gravity_concept",
      path: "wiki/pages/concepts/gravity.md",
      title: "Gravity",
      summary: "The attraction between masses.",
      aliases: [],
      sources: [],
      body: "# Gravity\n\nA concept page.",
    });
    target.revision = calculatePageRevision(target);
    const current = conceptPage({
      sources: [],
      body: "# Orbital Mechanics\n\nA concept page.",
      relations: [{ targetId: target.id, kind: "depends-on", sourceIds: [] }],
    });
    current.revision = calculatePageRevision(current);
    const updated = { ...current, summary: "Updated orbital knowledge." };
    const changeSet: ChangeSetV1 = {
      version: 1,
      operationId: "op_reconciliation",
      catalogRevision: calculateCatalogRevision([current, target]),
      reason: "Update the concept",
      pages: [
        {
          action: "update",
          expectedRevision: current.revision,
          page: updated,
        },
      ],
      reconciliation: {
        candidatePageIds: [target.id],
        reviewed: [],
      },
    };

    expect(() => applyWikiChangeSet([current, target], changeSet)).toThrow(
      /reconciliation.*pg_gravity_concept/i,
    );
  });

  test("selects graph neighbors and shared-evidence pages for reconciliation", () => {
    const target = conceptPage({
      id: "pg_gravity_concept",
      path: "wiki/pages/concepts/gravity.md",
      title: "Gravity",
      aliases: [],
      sources: [],
      body: "# Gravity\n\nA concept page.",
    });
    const current = conceptPage({
      relations: [{ targetId: target.id, kind: "depends-on", sourceIds: [] }],
    });
    const sharedEvidence = conceptPage({
      id: "pg_ellipse_concept",
      path: "wiki/pages/concepts/ellipse.md",
      title: "Ellipse",
      aliases: [],
      body: "# Ellipse\n\nA concept page. [@src_0123456789abcdef#page=1]",
    });
    const unrelated = conceptPage({
      id: "pg_marketing_concept",
      path: "wiki/pages/concepts/marketing.md",
      title: "Marketing",
      aliases: [],
      tags: ["business"],
      sources: [],
      body: "# Marketing\n\nAn unrelated page.",
    });

    const candidates = buildReconciliationCandidates(
      [current, target, sharedEvidence, unrelated],
      [current.id],
    );

    expect(candidates).toEqual([sharedEvidence.id, target.id].sort());
  });

  test("selects near-duplicate page names for reconciliation", () => {
    const current = conceptPage({
      sources: [],
      body: "# Orbital Mechanics\n\nA concept page.",
    });
    const possibleDuplicate = conceptPage({
      id: "pg_orbital_dynamics",
      path: "wiki/pages/concepts/orbital-dynamics.md",
      title: "Orbital Dynamics",
      aliases: [],
      tags: [],
      sources: [],
      body: "# Orbital Dynamics\n\nA separate concept page.",
    });

    expect(
      buildReconciliationCandidates([current, possibleDuplicate], [current.id]),
    ).toEqual([possibleDuplicate.id]);
  });

  test("merges duplicate pages without deleting history or breaking inbound relations", () => {
    const target = conceptPage({
      sources: [],
      body: "# Orbital Mechanics\n\nCanonical page.",
    });
    target.revision = calculatePageRevision(target);
    const duplicate = conceptPage({
      id: "pg_orbital_dynamics",
      path: "wiki/pages/concepts/orbital-dynamics.md",
      title: "Orbital Dynamics",
      aliases: [],
      sources: [],
      body: "# Orbital Dynamics\n\nDuplicate page.",
    });
    duplicate.revision = calculatePageRevision(duplicate);
    const referring = conceptPage({
      id: "pg_ellipse_concept",
      path: "wiki/pages/concepts/ellipse.md",
      title: "Ellipse",
      aliases: [],
      sources: [],
      body: "# Ellipse\n\nA referring page.",
      relations: [
        { targetId: duplicate.id, kind: "related-to", sourceIds: [] },
      ],
    });
    referring.revision = calculatePageRevision(referring);
    const changeSet = {
      version: 1,
      operationId: "op_merge",
      catalogRevision: calculateCatalogRevision([target, duplicate, referring]),
      reason: "Merge duplicate concepts",
      pages: [
        {
          action: "merge",
          expectedRevision: target.revision,
          mergeSourceIds: [duplicate.id],
          page: target,
        },
      ],
      reconciliation: {
        candidatePageIds: [duplicate.id, referring.id],
        reviewed: [
          {
            pageId: duplicate.id,
            decision: "changed",
            reason: "Archived as duplicate",
          },
          {
            pageId: referring.id,
            decision: "changed",
            reason: "Inbound relation rewritten",
          },
        ],
      },
    } as unknown as ChangeSetV1;

    const pages = applyWikiChangeSet([target, duplicate, referring], changeSet);

    expect(pages.find((page) => page.id === duplicate.id)?.status).toBe(
      "superseded",
    );
    expect(
      pages.find((page) => page.id === referring.id)?.relations[0]?.targetId,
    ).toBe(target.id);
    expect(
      pages.find((page) => page.id === target.id)?.relations,
    ).toContainEqual(
      expect.objectContaining({ targetId: duplicate.id, kind: "supersedes" }),
    );
  });

  test("rejects the same stable page ID at multiple paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-page-ids-"));
    await initBrain(root, { name: "Graph", description: "ID validation" });
    const first = conceptPage({
      sources: [],
      body: "# Orbital Mechanics\n\nFirst path.",
    });
    const second = conceptPage({
      path: "wiki/pages/concepts/duplicate-path.md",
      title: "Duplicate Path",
      aliases: [],
      sources: [],
      body: "# Duplicate Path\n\nSecond path.",
    });
    await writeFile(path.join(root, first.path), renderWikiPage(first));
    await writeFile(path.join(root, second.path), renderWikiPage(second));

    const report = await validateWikiGraph(root);

    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_PAGE_ID", pageId: first.id }),
    );
  });
});
