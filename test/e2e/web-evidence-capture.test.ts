import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  applyChangeSetTransaction,
  attachQueryChange,
  attachSetupChange,
  type BootstrapSourceContextV1,
  type BrainRuntimeServices,
  beginQuery,
  beginSetup,
  calculateCatalogRevision,
  captureWebEvidence,
  expandQuery,
  finishQuery,
  finishSetup,
  initBrain,
  type KnowledgeMutationContext,
  loadWikiPages,
  nextBootstrapBatch,
  nextSemanticAuditBatch,
  nextSetupBatch,
  planReconciliation,
  recordSemanticAuditBatch,
  requestWebApproval,
  resolveWebApproval,
  type SetupSourceContextV1,
  searchBrain,
  type WikiPageV1,
} from "@second-brain/core";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test } from "vitest";

const execFile = promisify(execFileCallback);
const fixedTime = "2026-08-30T12:00:00.000Z";
const runtimeServices: BrainRuntimeServices = {
  embeddings: {
    modelId: "test/web-evidence",
    modelRevision: "1",
    async embed(texts) {
      return texts.map(() => [1, 0]);
    },
  },
};

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function createBrain(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "web-evidence-e2e-"));
  await initBrain(root, {
    name: "Web evidence brain",
    description: "Fake-host durable web evidence test",
  });
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Web Evidence E2E"]);
  await git(root, ["config", "user.email", "web-e2e@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initialize brain"]);
  return root;
}

function sourcePage(
  context: BootstrapSourceContextV1 | SetupSourceContextV1,
): WikiPageV1 {
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

async function applyPages(
  root: string,
  context: KnowledgeMutationContext,
  operationId: string,
  pages: WikiPageV1[],
): Promise<void> {
  const changeSet = {
    version: 1 as const,
    operationId,
    catalogRevision: calculateCatalogRevision(await loadWikiPages(root)),
    reason: `Fake-host web evidence mutation ${operationId}`,
    pages: pages.map((page) => ({ action: "create" as const, page })),
    reconciliation: { candidatePageIds: [], reviewed: [] },
  };
  const plan = await planReconciliation(root, changeSet, runtimeServices);
  changeSet.reconciliation = {
    candidatePageIds: plan.candidates.map((candidate) => candidate.pageId),
    plan,
    readReceipts: plan.candidates.map((candidate) => ({
      pageId: candidate.pageId,
      revision: candidate.revision,
      readAt: fixedTime,
    })),
    reviewed: plan.candidates.map((candidate) => ({
      pageId: candidate.pageId,
      decision: "no-change" as const,
      reason: "Read in full; the new cited evidence does not alter this page.",
    })),
  };
  const result = await applyChangeSetTransaction(root, changeSet, {
    context,
    runtimeServices,
  });
  if (context.kind === "query")
    await attachQueryChange(root, context.id, result.operationId);
  else await attachSetupChange(root, context.id, result.operationId);
}

async function completeSetup(root: string): Promise<void> {
  await writeFile(
    path.join(root, "sources", "foundation.md"),
    "# Foundation\n\nThis brain maintains evidence-backed research notes.\n",
  );
  const setup = await beginSetup(
    root,
    { purpose: "Evidence-backed research" },
    runtimeServices,
  );
  while (true) {
    const batch = await nextSetupBatch(root, setup.id);
    if (batch.sources.length === 0) break;
    await applyPages(
      root,
      { kind: "setup", id: setup.id },
      "op_web_e2e_setup",
      batch.sources.map(sourcePage),
    );
  }
  while (true) {
    const audit = await nextSemanticAuditBatch(root);
    if (audit.pageIds.length === 0) break;
    const result = await recordSemanticAuditBatch(root, {
      pageIds: audit.pageIds,
      summary: "Reviewed the initial catalog and map.",
    });
    if (result.complete) break;
  }
  await finishSetup(root, setup.id, { summary: "Initial setup is complete." });
}

async function approveAndEnterWeb(
  root: string,
  queryId: string,
): Promise<void> {
  await expandQuery(root, queryId, {
    tier: "sources",
    reason: "Wiki evidence is insufficient.",
  });
  await requestWebApproval(root, queryId, {
    reason: "Local evidence is insufficient for this question.",
    hostSessionId: "fake-host",
  });
  await resolveWebApproval(root, queryId, {
    approved: true,
    decidedBy: "owner",
  });
  await expandQuery(root, queryId, {
    tier: "web",
    reason: "Approved web evidence is required.",
  });
}

async function pdfBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("The durable report found seven signals.", {
    x: 40,
    y: 700,
    size: 12,
    font,
  });
  return await document.save();
}

describe("fake host durable web evidence", () => {
  test("captures artifacts and pages, reuses the wiki, and keeps denial empty", async () => {
    const root = await createBrain();
    await completeSetup(root);

    const first = await beginQuery(
      root,
      "How many signals did the durable report find?",
    );
    await approveAndEnterWeb(root, first.id);
    const bytes = await pdfBytes();
    const captured = await captureWebEvidence(root, first.id, {
      representation: "artifact",
      originalUrl: "https://example.test/durable-report.pdf",
      finalUrl: "https://cdn.example.test/durable-report.pdf",
      redirectChain: ["https://cdn.example.test/durable-report.pdf"],
      title: "Durable report",
      fileName: "durable-report.pdf",
      declaredMediaType: "application/pdf",
      responseComplete: true,
      content: bytes,
      retrievedAt: fixedTime,
    });
    expect(await readFile(path.join(root, captured.source.path))).toEqual(
      Buffer.from(bytes),
    );
    const sidecarPath = captured.source.provenance.sidecarPath;
    if (!sidecarPath) throw new Error("Expected artifact sidecar");
    const sidecar = JSON.parse(
      await readFile(path.join(root, sidecarPath), "utf8"),
    );
    expect(sidecar).toMatchObject({
      brainWebArtifact: 1,
      sourcePath: captured.source.path,
      discovery: {
        queryId: first.id,
        representation: "artifact",
        completeness: "complete",
      },
    });
    expect(
      (await git(root, ["show", "--pretty=format:", "--name-only", "HEAD"]))
        .split("\n")
        .filter(Boolean)
        .sort(),
    ).toEqual(
      [
        ".brain/operations.jsonl",
        ".brain/source-manifest.json",
        ".brain/state.json",
        captured.source.path,
        sidecarPath,
        "wiki/log.md",
      ].sort(),
    );

    const batch = await nextBootstrapBatch(root, first.id);
    const context = batch.sources.find(
      (item) => item.record.id === captured.source.id,
    );
    if (!context?.extracted?.chunks[0])
      throw new Error("Expected captured PDF extraction");
    const source = sourcePage(context);
    const locator = context.extracted.chunks[0].locator;
    const answer: WikiPageV1 = {
      schema: 1,
      id: "pg_durable_report_answer",
      path: "wiki/pages/topics/durable-report-answer.md",
      title: "Durable report answer",
      type: "topic",
      status: "active",
      summary: "The durable report found seven signals.",
      aliases: [],
      tags: ["web-evidence"],
      createdAt: fixedTime,
      updatedAt: fixedTime,
      revision: "pending",
      sources: [{ id: captured.source.id, locators: [locator] }],
      relations: [
        {
          targetId: source.id,
          kind: "supports",
          sourceIds: [captured.source.id],
        },
      ],
      body: `# Durable report answer\n\nThe report found seven signals. [@${captured.source.id}#${locator}]`,
    };
    await applyPages(
      root,
      { kind: "query", id: first.id },
      "op_web_e2e_answer",
      [source, answer],
    );
    await finishQuery(root, first.id, {
      outcome: "answered",
      answerSummary: "The report found seven signals.",
    });

    const repeated = await beginQuery(
      root,
      "How many signals did the durable report find?",
    );
    expect(repeated.tiersUsed).toEqual(["wiki"]);
    expect(repeated.wikiResults.some((result) => result.id === answer.id)).toBe(
      true,
    );
    const repeatedFinished = await finishQuery(root, repeated.id, {
      outcome: "answered",
      answerSummary: "Answered from the existing cited wiki page.",
    });
    expect(repeatedFinished.session.tiersUsed).toEqual(["wiki"]);

    const second = await beginQuery(
      root,
      "What does the ordinary web page say?",
    );
    await approveAndEnterWeb(root, second.id);
    const page = await captureWebEvidence(root, second.id, {
      representation: "text",
      originalUrl: "https://example.test/ordinary-page",
      title: "Ordinary page",
      captureKind: "page",
      completeness: "complete",
      content: "  Complete accessible page text.  ",
      retrievedAt: "2026-08-30T12:30:00.000Z",
    });
    expect(await readFile(path.join(root, page.source.path), "utf8")).toContain(
      "  Complete accessible page text.  \n",
    );

    const beforeDenied = (
      await readdir(path.join(root, "sources", "web"), { recursive: true })
    ).sort();
    const denied = await beginQuery(root, "What does the denied site say?");
    await expandQuery(root, denied.id, {
      tier: "sources",
      reason: "Wiki evidence is insufficient.",
    });
    await requestWebApproval(root, denied.id, {
      reason: "This question would require web evidence.",
      hostSessionId: "fake-host",
    });
    await resolveWebApproval(root, denied.id, {
      approved: false,
      decidedBy: "owner",
      denialReason: "Keep this question local.",
    });
    await expect(
      expandQuery(root, denied.id, { tier: "web", reason: "Denied." }),
    ).rejects.toThrow(/denied/i);
    const beforeDeniedManifest = await readFile(
      path.join(root, ".brain", "source-manifest.json"),
      "utf8",
    );
    const beforeDeniedOperations = await readFile(
      path.join(root, ".brain", "operations.jsonl"),
      "utf8",
    );
    const beforeDeniedHead = await git(root, ["rev-parse", "HEAD"]);
    await expect(
      captureWebEvidence(root, denied.id, {
        representation: "text",
        originalUrl: "https://example.test/denied-site",
        title: "Denied site",
        captureKind: "page",
        completeness: "complete",
        content: "This denied content must never become durable evidence.",
        retrievedAt: "2026-08-30T12:45:00.000Z",
      }),
    ).rejects.toThrow(/web tier|denied|approval/i);
    expect(
      (
        await readdir(path.join(root, "sources", "web"), { recursive: true })
      ).sort(),
    ).toEqual(beforeDenied);
    await expect(
      readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    ).resolves.toBe(beforeDeniedManifest);
    await expect(
      readFile(path.join(root, ".brain", "operations.jsonl"), "utf8"),
    ).resolves.toBe(beforeDeniedOperations);
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeDeniedHead);
    expect(await git(root, ["status", "--short", "--", "sources"])).toBe("");
    expect(
      await searchBrain(root, { query: "denied site", scope: "sources" }),
    ).toEqual([]);
  }, 90_000);
});
