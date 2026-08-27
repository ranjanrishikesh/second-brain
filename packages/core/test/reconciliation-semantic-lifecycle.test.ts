import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

const localProviderFactory = vi.hoisted(() => vi.fn());
const semanticSearch = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../src/semantic.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/semantic.js")>();
  return {
    ...actual,
    semanticSearch,
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
  type EmbeddingProvider,
  type WikiPageV1,
} from "../src/index.js";

function page(id: string, title: string, summary: string): WikiPageV1 {
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
    body: `# ${title}\n\n${summary}`,
  };
}

describe("semantic reconciliation provider lifetime", () => {
  test("creates one local provider for all changed pages in one plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-reconcile-model-"));
    await initBrain(root, {
      name: "Semantic lifecycle",
      description: "Reuses a local model during reconciliation",
    });
    const provider: EmbeddingProvider = {
      modelId: "test/local-provider",
      modelRevision: "test-revision",
      async embed(texts) {
        return texts.map(() => [1, 0]);
      },
    };
    localProviderFactory.mockReturnValue(provider);
    const first = page(
      "pg_semantic_first",
      "First stellar concept",
      "A first compact stellar object.",
    );
    const second = page(
      "pg_semantic_second",
      "Second stellar concept",
      "A second compact stellar object.",
    );
    const candidate = page(
      "pg_semantic_candidate",
      "Candidate stellar concept",
      "A related compact stellar object.",
    );
    for (const wikiPage of [first, second, candidate]) {
      await writeFile(path.join(root, wikiPage.path), renderWikiPage(wikiPage));
    }
    const state = await readBrainState(root);
    await writeBrainState(root, {
      ...state,
      setup: {
        status: "completed",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "Prepare semantic reconciliation",
        startedAt: "2026-08-27T00:00:00.000Z",
        completedAt: "2026-08-27T00:00:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });
    const pages = await loadWikiPages(root);
    const currentFirst = pages.find((wikiPage) => wikiPage.id === first.id);
    const currentSecond = pages.find((wikiPage) => wikiPage.id === second.id);
    if (!currentFirst || !currentSecond) {
      throw new Error("Expected reconciliation pages");
    }
    const changeSet: ChangeSetV1 = {
      version: 1,
      operationId: "op_semantic_provider_lifecycle",
      catalogRevision: calculateCatalogRevision(pages),
      reason: "Update two related stellar concepts",
      pages: [
        {
          action: "update",
          expectedRevision: currentFirst.revision,
          page: {
            ...currentFirst,
            summary: "An updated first compact stellar object.",
            updatedAt: "2026-08-27T01:00:00.000Z",
          },
        },
        {
          action: "update",
          expectedRevision: currentSecond.revision,
          page: {
            ...currentSecond,
            summary: "An updated second compact stellar object.",
            updatedAt: "2026-08-27T01:00:00.000Z",
          },
        },
      ],
      reconciliation: { candidatePageIds: [], reviewed: [] },
    };

    await planReconciliation(root, changeSet, {
      embeddingProviderFactory: localProviderFactory,
    });

    expect(localProviderFactory).toHaveBeenCalledTimes(1);
    expect(localProviderFactory).toHaveBeenCalledWith(root);
  });
});
