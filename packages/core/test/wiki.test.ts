import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  applyWikiChangeSet,
  buildReconciliationCandidates,
  calculateCatalogRevision,
  calculatePageRevision,
  initBrain,
  parseWikiPage,
  renderWikiPage,
  scanSources,
  validateWikiGraph,
  writeGeneratedWikiFiles,
  type ChangeSetV1,
  type WikiPageV1,
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

describe("wiki page format", () => {
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
