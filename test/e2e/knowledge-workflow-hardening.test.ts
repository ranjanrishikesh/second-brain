import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  applyChangeSetTransaction,
  attachQueryChange,
  attachSetupChange,
  auditBrain,
  beginQuery,
  beginSetup,
  calculateCatalogRevision,
  expandQuery,
  finishQuery,
  finishSetup,
  initBrain,
  loadWikiPages,
  nextSemanticAuditBatch,
  nextSetupBatch,
  planReconciliation,
  readBrainItem,
  readQueryItem,
  readQuerySession,
  recordSemanticAuditBatch,
  semanticSearch,
  type BrainRuntimeServices,
  type KnowledgeMutationContext,
  type ReadReceiptV1,
  type SetupSourceContextV1,
  type WikiPageV1,
} from "@second-brain/core";

const execFile = promisify(execFileCallback);
const fixtureSources = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "smoke-brain",
  "sources",
);
const fixedTime = "2026-08-27T12:00:00.000Z";
const runtimeServices: BrainRuntimeServices = {
  embeddings: {
    modelId: "test/fixture-orbits",
    modelRevision: "test-revision",
    async embed(texts) {
      return texts.map((text) =>
        /periapsis|pericenter|closest approach|farthest orbital/iu.test(text)
          ? [1, 0]
          : [0, 1],
      );
    },
  },
};

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function provisionFixtureBrain(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-hardening-e2e-"));
  await initBrain(root, {
    name,
    description: "Disposable smoke fixture for the portable second brain",
  });
  await cp(fixtureSources, path.join(root, "sources"), { recursive: true });
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Second Brain E2E"]);
  await git(root, ["config", "user.email", "brain-e2e@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initialize fixture brain"]);
  return root;
}

function sourcePage(context: SetupSourceContextV1): WikiPageV1 {
  const chunk = context.extracted?.chunks[0];
  if (!chunk) throw new Error(`Expected extracted source ${context.record.id}`);
  const suffix = context.record.id.slice(4, 16);
  return {
    schema: 1,
    id: `pg_source_${suffix}`,
    path: `wiki/pages/sources/${suffix}.md`,
    title: `Source: ${context.record.title}`,
    type: "source",
    status: "active",
    summary: `Catalog entry for ${context.record.title}.`,
    aliases: [],
    tags: [],
    createdAt: fixedTime,
    updatedAt: fixedTime,
    revision: "pending",
    sources: [{ id: context.record.id, locators: [chunk.locator] }],
    relations: [],
    body: `# ${context.record.title}\n\n${chunk.text} [@${context.record.id}#${chunk.locator}]`,
  };
}

async function applyReconciledPages(
  root: string,
  context: KnowledgeMutationContext,
  operationId: string,
  pages: WikiPageV1[],
) {
  const current = await loadWikiPages(root);
  const draft = {
    version: 1 as const,
    operationId,
    catalogRevision: calculateCatalogRevision(current),
    reason: `Fixture hardening mutation ${operationId}`,
    pages: pages.map((page) => ({ action: "create" as const, page })),
    reconciliation: {
      candidatePageIds: [] as string[],
      reviewed: [] as Array<{
        pageId: string;
        decision: "changed" | "no-change";
        reason: string;
      }>,
    },
  };
  const plan = await planReconciliation(root, draft, runtimeServices);
  const directTargets = new Set(
    pages.flatMap((page) =>
      page.relations.map((relation) => relation.targetId),
    ),
  );
  let readReceipts: ReadReceiptV1[];
  if (context.kind === "query") {
    for (const candidate of plan.candidates) {
      await readQueryItem(root, context.id, candidate.pageId);
    }
    const session = await readQuerySession(root, context.id);
    const candidateIds = new Set(
      plan.candidates.map((candidate) => candidate.pageId),
    );
    readReceipts = session.readReceipts.filter((receipt) =>
      candidateIds.has(receipt.pageId),
    );
  } else {
    readReceipts = await Promise.all(
      plan.candidates.map(async (candidate) => {
        await readBrainItem(root, candidate.pageId);
        return {
          pageId: candidate.pageId,
          revision: candidate.revision,
          readAt: fixedTime,
        };
      }),
    );
  }
  const changeSet = {
    ...draft,
    reconciliation: {
      candidatePageIds: plan.candidates.map((candidate) => candidate.pageId),
      plan,
      readReceipts,
      reviewed: plan.candidates.map((candidate) => ({
        pageId: candidate.pageId,
        decision: directTargets.has(candidate.pageId)
          ? ("changed" as const)
          : ("no-change" as const),
        reason: directTargets.has(candidate.pageId)
          ? "The mutation adds a durable typed relationship to this page."
          : "The current revision was read; no revision to this page is needed.",
      })),
    },
  };
  const result = await applyChangeSetTransaction(root, changeSet, {
    context,
    runtimeServices,
  });
  if (context.kind === "query") {
    await attachQueryChange(root, context.id, result.operationId);
  } else {
    await attachSetupChange(root, context.id, result.operationId);
  }
  return { plan, result };
}

async function completeFixtureSetup(
  root: string,
): Promise<SetupSourceContextV1[]> {
  const setup = await beginSetup(
    root,
    { purpose: "Orbital terminology and source-backed claims" },
    runtimeServices,
  );
  const sources: SetupSourceContextV1[] = [];
  let batchNumber = 0;
  while (true) {
    const batch = await nextSetupBatch(root, setup.id);
    if (batch.sources.length === 0) break;
    sources.push(...batch.sources);
    await applyReconciledPages(
      root,
      { kind: "setup", id: setup.id },
      `op_fixture_setup_${batchNumber}`,
      batch.sources.map(sourcePage),
    );
    batchNumber += 1;
  }
  while (true) {
    const audit = await nextSemanticAuditBatch(root);
    if (audit.pageIds.length === 0) break;
    const recorded = await recordSemanticAuditBatch(root, {
      pageIds: audit.pageIds,
      summary: "Reviewed every fixture source page during initial setup.",
    });
    if (recorded.complete) break;
  }
  await finishSetup(root, setup.id, {
    summary:
      "Fixture source catalog and shallow relationship map are complete.",
  });
  return sources;
}

describe("knowledge workflow hardening smoke fixture", () => {
  test("builds a cited semantic graph from fixture sources and preserves reciprocal contradictions", async () => {
    const root = await provisionFixtureBrain("Orbital fixture");
    const sources = await completeFixtureSetup(root);
    expect(sources).toHaveLength(3);

    const foundations = sources.find((source) =>
      source.record.path.endsWith("foundations.md"),
    );
    const contradiction = sources.find((source) =>
      source.record.path.endsWith("contradiction.md"),
    );
    const synonyms = sources.find((source) =>
      source.record.path.endsWith("synonyms.md"),
    );
    if (
      !foundations?.extracted?.chunks[0] ||
      !contradiction?.extracted?.chunks[0] ||
      !synonyms?.extracted?.chunks[0]
    ) {
      throw new Error("Expected every smoke-fixture source to be extracted");
    }

    const beforeCacheDelete = await semanticSearch(
      root,
      "What is another name for periapsis?",
      "sources",
      10,
      runtimeServices,
    );
    expect(
      beforeCacheDelete.some((result) => result.id === synonyms.record.id),
    ).toBe(true);
    await rm(path.join(root, ".brain", "cache", "semantic-index.json"));
    await expect(
      semanticSearch(
        root,
        "What is another name for periapsis?",
        "sources",
        10,
        runtimeServices,
      ),
    ).resolves.toEqual(beforeCacheDelete);

    const query = await beginQuery(root, "What is periapsis?");
    await expandQuery(root, query.id, {
      tier: "sources",
      reason:
        "The shallow catalog alone does not resolve the contradictory claims.",
    });
    const foundationsSourcePageId = `pg_source_${foundations.record.id.slice(4, 16)}`;
    const contradictionSourcePageId = `pg_source_${contradiction.record.id.slice(4, 16)}`;
    const nearest: WikiPageV1 = {
      schema: 1,
      id: "pg_claim_nearest",
      path: "wiki/pages/topics/periapsis-nearest.md",
      title: "Periapsis is the nearest orbital point",
      type: "concept",
      status: "active",
      summary:
        "The supported definition of periapsis is the nearest orbital point.",
      aliases: ["Pericenter"],
      tags: ["orbits"],
      createdAt: fixedTime,
      updatedAt: fixedTime,
      revision: "pending",
      sources: [
        {
          id: foundations.record.id,
          locators: [foundations.extracted.chunks[0].locator],
        },
      ],
      relations: [
        {
          targetId: "pg_claim_farthest",
          kind: "contradicts",
          sourceIds: [contradiction.record.id],
        },
        {
          targetId: foundationsSourcePageId,
          kind: "supports",
          sourceIds: [foundations.record.id],
        },
      ],
      body: `# Periapsis\n\nPeriapsis is the nearest point in an orbit. [@${foundations.record.id}#${foundations.extracted.chunks[0].locator}]`,
    };
    const farthest: WikiPageV1 = {
      schema: 1,
      id: "pg_claim_farthest",
      path: "wiki/pages/questions/periapsis-farthest-claim.md",
      title: "Disputed farthest-point claim",
      type: "question",
      status: "active",
      summary: "A contradictory source calls periapsis the farthest point.",
      aliases: [],
      tags: ["orbits", "conflict"],
      createdAt: fixedTime,
      updatedAt: fixedTime,
      revision: "pending",
      sources: [
        {
          id: contradiction.record.id,
          locators: [contradiction.extracted.chunks[0].locator],
        },
      ],
      relations: [
        {
          targetId: "pg_claim_nearest",
          kind: "contradicts",
          sourceIds: [foundations.record.id],
        },
        {
          targetId: contradictionSourcePageId,
          kind: "supports",
          sourceIds: [contradiction.record.id],
        },
      ],
      body: `# Disputed farthest-point claim\n\nA source calls periapsis the farthest point. This conflict remains unresolved. [@${contradiction.record.id}#${contradiction.extracted.chunks[0].locator}]`,
    };
    const applied = await applyReconciledPages(
      root,
      { kind: "query", id: query.id },
      "op_fixture_raw_fallback",
      [nearest, farthest],
    );
    const synonymSourcePageId = `pg_source_${synonyms.record.id.slice(4, 16)}`;
    expect(
      applied.plan.candidates.find(
        (candidate) => candidate.pageId === synonymSourcePageId,
      )?.reasons,
    ).toContain("semantic");

    const finished = await finishQuery(root, query.id, {
      outcome: "answered",
      answerSummary:
        "Periapsis is supported as the nearest orbital point; a conflicting source remains linked.",
    });
    expect(finished.session.tiersUsed).toEqual(["wiki", "sources"]);
    expect(finished.commit).toMatch(/^[a-f0-9]{40}$/);

    const pages = new Map(
      (await loadWikiPages(root)).map((page) => [page.id, page]),
    );
    expect(pages.get(nearest.id)?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetId: farthest.id, kind: "contradicts" }),
      ]),
    );
    expect(pages.get(farthest.id)?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetId: nearest.id, kind: "contradicts" }),
      ]),
    );
    expect((await auditBrain(root)).structural.ok).toBe(true);

    const repeated = await beginQuery(root, "What is periapsis?");
    expect(
      repeated.wikiResults.some((result) => result.id === nearest.id),
    ).toBe(true);
    await expect(
      finishQuery(root, repeated.id, {
        outcome: "answered",
        answerSummary: "Answered from the existing cited graph.",
      }),
    ).resolves.toMatchObject({
      session: { tiersUsed: ["wiki"], changeOperationIds: [] },
    });
  }, 60_000);
});
