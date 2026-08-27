import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  applyChangeSetTransaction,
  calculateCatalogRevision,
  initBrain,
  loadWikiPages,
  renderWikiPage,
  type ChangeSetV1,
  type WikiPageV1,
} from "../src/index.js";
import { deterministicEmbeddings } from "./helpers/embeddings.js";

const execFile = promisify(execFileCallback);

function page(
  id: string,
  title: string,
  summary: string,
  body: string,
): WikiPageV1 {
  return {
    schema: 1,
    id,
    path: `wiki/pages/concepts/${id.slice(3)}.md`,
    title,
    type: "concept",
    status: "active",
    summary,
    aliases: [],
    tags: [],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    revision: "pending",
    sources: [],
    relations: [],
    body: `# ${title}\n\n${body}`,
  };
}

async function brainWithSemanticPages(git = false): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-reconciliation-"));
  await initBrain(root, {
    name: "Reconciliation",
    description: "Reconciliation tests",
  });
  const gravity = page(
    "pg_gravity_basin",
    "Gravity basin",
    "A gravity basin bends nearby trajectories.",
    "Gravity basin describes a curved field.",
  );
  const blackHole = page(
    "pg_black_hole",
    "Black hole",
    "An event horizon traps light.",
    "An event horizon surrounds a collapsed star.",
  );
  await writeFile(path.join(root, gravity.path), renderWikiPage(gravity));
  await writeFile(path.join(root, blackHole.path), renderWikiPage(blackHole));
  if (git) {
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    await execFile("git", ["init"], { cwd: root });
    await execFile("git", ["config", "user.name", "Second Brain Test"], {
      cwd: root,
    });
    await execFile(
      "git",
      ["config", "user.email", "brain-test@example.invalid"],
      { cwd: root },
    );
    await execFile("git", ["add", "."], { cwd: root });
    await execFile("git", ["commit", "-m", "initial brain"], { cwd: root });
  }
  return root;
}

async function draft(root: string): Promise<ChangeSetV1> {
  const pages = await loadWikiPages(root);
  const gravity = pages.find(
    (candidate) => candidate.id === "pg_gravity_basin",
  );
  if (!gravity) throw new Error("Expected gravity page");
  return {
    version: 1,
    operationId: "op_reconcile_gravity",
    catalogRevision: calculateCatalogRevision(pages),
    reason: "Connect gravity basin to related concepts",
    pages: [
      {
        action: "update",
        expectedRevision: gravity.revision,
        page: {
          ...gravity,
          summary:
            "A gravity basin can curve trajectories around compact objects.",
          updatedAt: "2026-08-27T01:00:00.000Z",
        },
      },
    ],
    reconciliation: {
      candidatePageIds: [],
      reviewed: [],
    },
  };
}

const services = {
  embeddings: deterministicEmbeddings({
    "gravity basin": [1, 0],
    "event horizon": [1, 0],
  }),
};

describe("reconciliation planning", () => {
  test("uses the configured related-page candidate limit", async () => {
    const root = await brainWithSemanticPages();
    const neutronStar = page(
      "pg_neutron_star",
      "Neutron star",
      "A compact stellar remnant.",
      "A neutron star has an event horizon analogy in compact-object study.",
    );
    await writeFile(
      path.join(root, neutronStar.path),
      renderWikiPage(neutronStar),
    );
    await writeFile(
      path.join(root, "brain.config.yaml"),
      [
        "version: 1",
        "brain:",
        "  name: Reconciliation",
        "  description: Reconciliation tests",
        "graph:",
        "  relatedPageLimit: 1",
        "",
      ].join("\n"),
    );

    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const planReconciliation = exports.planReconciliation as (
      root: string,
      changeSet: ChangeSetV1,
      services: typeof services,
    ) => Promise<{ candidates: Array<{ pageId: string }> }>;
    const plan = await planReconciliation(root, await draft(root), services);

    expect(plan.candidates.map((candidate) => candidate.pageId)).toEqual([
      "pg_black_hole",
    ]);
  });

  test("includes a semantic candidate with its reason", async () => {
    const root = await brainWithSemanticPages();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;

    expect(exports).toHaveProperty("planReconciliation");
    const planReconciliation = exports.planReconciliation as (
      root: string,
      changeSet: ChangeSetV1,
      services: typeof services,
    ) => Promise<{
      candidates: Array<{ pageId: string; reasons: string[] }>;
    }>;
    const plan = await planReconciliation(root, await draft(root), services);

    expect(plan.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageId: "pg_black_hole",
          reasons: expect.arrayContaining(["semantic"]),
        }),
      ]),
    );
  });

  test("does not spread a contradiction between changed pages to unrelated pages", async () => {
    const root = await brainWithSemanticPages();
    const changeSet = await draft(root);
    changeSet.pages.push({
      action: "create",
      page: {
        ...page(
          "pg_equivalence_note",
          "Equivalence note",
          "A compact note about a disputed model.",
          "The disputed model concerns equivalence only.",
        ),
        relations: [
          {
            targetId: "pg_gravity_basin",
            kind: "contradicts",
            sourceIds: [],
          },
        ],
      },
    });

    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const planReconciliation = exports.planReconciliation as (
      root: string,
      changeSet: ChangeSetV1,
    ) => Promise<{ candidates: Array<{ pageId: string }> }>;
    const plan = await planReconciliation(root, changeSet);

    const blackHole = plan.candidates.find(
      (candidate) => candidate.pageId === "pg_black_hole",
    );
    expect(blackHole?.reasons).not.toContain("contradiction");
  });

  test("rejects a transaction when a planned candidate has no read receipt", async () => {
    const root = await brainWithSemanticPages(true);
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    expect(exports).toHaveProperty("planReconciliation");
    const planReconciliation = exports.planReconciliation as (
      root: string,
      changeSet: ChangeSetV1,
      services: typeof services,
    ) => Promise<{
      candidates: Array<{ pageId: string; reasons: string[] }>;
    }>;
    const changeSet = await draft(root);
    const plan = await planReconciliation(root, changeSet, services);
    changeSet.reconciliation = {
      candidatePageIds: plan.candidates.map((candidate) => candidate.pageId),
      plan,
      readReceipts: [],
      reviewed: plan.candidates.map((candidate) => ({
        pageId: candidate.pageId,
        decision: "no-change" as const,
        reason: "No durable relationship change is justified.",
      })),
    };

    await expect(
      applyChangeSetTransaction(root, changeSet, { runtimeServices: services }),
    ).rejects.toThrow(/read receipt/i);
  });

  test("commits a complete receipt that records an interconnected change", async () => {
    const root = await brainWithSemanticPages(true);
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const planReconciliation = exports.planReconciliation as (
      root: string,
      changeSet: ChangeSetV1,
      services: typeof services,
    ) => Promise<{
      candidates: Array<{ pageId: string; revision: string }>;
    }>;
    const changeSet = await draft(root);
    const mutation = changeSet.pages[0];
    if (!mutation) throw new Error("Expected gravity mutation");
    mutation.page.relations = [
      {
        targetId: "pg_black_hole",
        kind: "related-to",
        sourceIds: [],
      },
    ];
    const plan = await planReconciliation(root, changeSet, services);
    changeSet.reconciliation = {
      candidatePageIds: plan.candidates.map((candidate) => candidate.pageId),
      plan,
      readReceipts: plan.candidates.map((candidate) => ({
        pageId: candidate.pageId,
        revision: candidate.revision,
        readAt: "2026-08-27T01:01:00.000Z",
      })),
      reviewed: plan.candidates.map((candidate) => ({
        pageId: candidate.pageId,
        decision: "changed" as const,
        reason: "The compact-object relationship is durable and useful.",
      })),
    };

    const result = await applyChangeSetTransaction(root, changeSet, {
      runtimeServices: services,
    });

    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.audit.ok).toBe(true);
    expect(
      (await loadWikiPages(root)).find((page) => page.id === "pg_gravity_basin")
        ?.relations,
    ).toContainEqual(expect.objectContaining({ targetId: "pg_black_hole" }));
  });

  test("rejects a whitespace-only reconciliation decision", async () => {
    const root = await brainWithSemanticPages(true);
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const planReconciliation = exports.planReconciliation as (
      root: string,
      changeSet: ChangeSetV1,
      services: typeof services,
    ) => Promise<{
      candidates: Array<{ pageId: string; revision: string }>;
    }>;
    const changeSet = await draft(root);
    const plan = await planReconciliation(root, changeSet, services);
    changeSet.reconciliation = {
      candidatePageIds: plan.candidates.map((candidate) => candidate.pageId),
      plan,
      readReceipts: plan.candidates.map((candidate) => ({
        pageId: candidate.pageId,
        revision: candidate.revision,
        readAt: "2026-08-27T01:01:00.000Z",
      })),
      reviewed: plan.candidates.map((candidate) => ({
        pageId: candidate.pageId,
        decision: "no-change" as const,
        reason: "   ",
      })),
    };

    await expect(
      applyChangeSetTransaction(root, changeSet, { runtimeServices: services }),
    ).rejects.toThrow(/too small|reason/i);
  });

  test("rejects a stale candidate read receipt", async () => {
    const root = await brainWithSemanticPages(true);
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const planReconciliation = exports.planReconciliation as (
      root: string,
      changeSet: ChangeSetV1,
      services: typeof services,
    ) => Promise<{
      candidates: Array<{ pageId: string; revision: string }>;
    }>;
    const changeSet = await draft(root);
    const plan = await planReconciliation(root, changeSet, services);
    changeSet.reconciliation = {
      candidatePageIds: plan.candidates.map((candidate) => candidate.pageId),
      plan,
      readReceipts: plan.candidates.map((candidate) => ({
        pageId: candidate.pageId,
        revision: "stale-revision",
        readAt: "2026-08-27T01:01:00.000Z",
      })),
      reviewed: plan.candidates.map((candidate) => ({
        pageId: candidate.pageId,
        decision: "no-change" as const,
        reason: "The relationship is not useful enough to persist.",
      })),
    };

    await expect(
      applyChangeSetTransaction(root, changeSet, { runtimeServices: services }),
    ).rejects.toThrow(/current read receipt/i);
  });

  test("rejects a planned candidate without a decision", async () => {
    const root = await brainWithSemanticPages(true);
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const planReconciliation = exports.planReconciliation as (
      root: string,
      changeSet: ChangeSetV1,
      services: typeof services,
    ) => Promise<{
      candidates: Array<{ pageId: string; revision: string }>;
    }>;
    const changeSet = await draft(root);
    const plan = await planReconciliation(root, changeSet, services);
    changeSet.reconciliation = {
      candidatePageIds: plan.candidates.map((candidate) => candidate.pageId),
      plan,
      readReceipts: plan.candidates.map((candidate) => ({
        pageId: candidate.pageId,
        revision: candidate.revision,
        readAt: "2026-08-27T01:01:00.000Z",
      })),
      reviewed: [],
    };

    await expect(
      applyChangeSetTransaction(root, changeSet, { runtimeServices: services }),
    ).rejects.toThrow(/reconciliation decision/i);
  });
});
