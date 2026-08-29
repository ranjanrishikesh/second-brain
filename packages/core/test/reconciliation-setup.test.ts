import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

vi.mock("../src/semantic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/semantic.js")>();
  return {
    ...actual,
    semanticSearch: async () => [
      {
        kind: "wiki" as const,
        id: "pg_setup_pulsar",
        title: "Pulsar",
        path: "wiki/pages/concepts/pulsar.md",
        locator: "page",
        snippet: "A rotating neutron star emits pulses.",
        score: 1,
      },
    ],
  };
});

import {
  calculateCatalogRevision,
  initBrain,
  loadWikiPages,
  planReconciliation,
  readBrainState,
  renderWikiPage,
  writeBrainState,
  type ChangeSetV1,
  type WikiPageV1,
} from "../src/index.js";

function page(id: string, title: string, body: string): WikiPageV1 {
  return {
    schema: 1,
    id,
    path: `wiki/pages/concepts/${id.slice(3)}.md`,
    title,
    type: "concept",
    status: "active",
    summary: body,
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

describe("reconciliation during setup", () => {
  test("uses semantic related-page retrieval while initial setup is in progress", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-reconcile-setup-"));
    await initBrain(root, {
      name: "Setup reconciliation",
      description: "Semantic setup reconciliation test",
    });
    const lighthouse = page(
      "pg_setup_lighthouse",
      "Stellar lighthouse",
      "A cosmic beacon can be explained by an object that rotates rapidly.",
    );
    const pulsar = page(
      "pg_setup_pulsar",
      "Pulsar",
      "A rotating neutron star emits pulses.",
    );
    await writeFile(
      path.join(root, lighthouse.path),
      renderWikiPage(lighthouse),
    );
    await writeFile(path.join(root, pulsar.path), renderWikiPage(pulsar));
    const state = await readBrainState(root);
    await writeBrainState(root, {
      ...state,
      setup: {
        status: "in-progress",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "Build the initial source catalog",
        startedAt: "2026-08-27T00:00:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });
    const pages = await loadWikiPages(root);
    const current = pages.find((candidate) => candidate.id === lighthouse.id);
    if (!current) throw new Error("Expected the changed setup page");
    const changeSet: ChangeSetV1 = {
      version: 1,
      operationId: "op_setup_semantic_reconciliation",
      catalogRevision: calculateCatalogRevision(pages),
      reason: "Connect the initial catalog with semantically related concepts",
      pages: [
        {
          action: "update",
          expectedRevision: current.revision,
          page: {
            ...current,
            summary:
              "A stellar lighthouse is a rotating compact object that creates periodic signals.",
            updatedAt: "2026-08-27T01:00:00.000Z",
          },
        },
      ],
      reconciliation: { candidatePageIds: [], reviewed: [] },
    };

    const plan = await planReconciliation(root, changeSet);

    expect(plan.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageId: pulsar.id,
          reasons: expect.arrayContaining(["semantic"]),
        }),
      ]),
    );
  });
});
