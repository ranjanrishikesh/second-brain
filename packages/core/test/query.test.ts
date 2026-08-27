import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  applyChangeSetTransaction,
  attachQueryChange,
  beginQuery,
  calculateCatalogRevision,
  captureWebEvidence,
  expandQuery,
  finishQuery,
  initBrain,
  loadWikiPages,
  nextBootstrapBatch,
  readQuerySession,
  readBrainState,
  renderWikiPage,
  requestWebApproval,
  resolveWebApproval,
  scanSources,
  writeBrainState,
  type WikiPageV1,
} from "../src/index.js";
import { deterministicEmbeddings } from "./helpers/embeddings.js";

const execFile = promisify(execFileCallback);
const runtimeServices = { embeddings: deterministicEmbeddings({}) };

async function approveWebForQuery(
  root: string,
  queryId: string,
): Promise<void> {
  await requestWebApproval(root, queryId, {
    reason: "The local evidence is insufficient for this active question.",
    hostSessionId: "query-test-host",
  });
  await resolveWebApproval(root, queryId, {
    approved: true,
    decidedBy: "query-test-owner",
  });
}

async function findFileNamed(
  directory: string,
  fileName: string,
): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFileNamed(absolutePath, fileName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === fileName) {
      return absolutePath;
    }
  }
  return undefined;
}

async function queryBrain(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-query-"));
  await initBrain(root, { name: "Queries", description: "Query tests" });
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await writeFile(
    path.join(root, "sources", "quasar-evidence.md"),
    "# Quasar Evidence\n\nSpectroscopy reveals quasar redshift.\n",
  );
  const scan = await scanSources(root);
  const sourceId = scan.added[0]?.id;
  if (!sourceId) throw new Error("Expected query source to be registered");
  const page: WikiPageV1 = {
    schema: 1,
    id: "pg_quasar_source",
    path: "wiki/pages/sources/quasar.md",
    title: "Quasar source",
    type: "source",
    status: "active",
    summary: "A summary of quasars.",
    aliases: [],
    tags: ["astronomy"],
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    revision: "pending",
    sources: [{ id: sourceId, locators: ["heading=quasar-evidence"] }],
    relations: [],
    body: `# Quasar source\n\nQuasars are luminous galactic nuclei. [@${sourceId}#heading=quasar-evidence]`,
  };
  await writeFile(path.join(root, page.path), renderWikiPage(page));
  const state = await readBrainState(root);
  await writeBrainState(root, {
    ...state,
    setup: {
      status: "completed",
      id: "setup_0123456789abcdef0123456789abcdef",
      purpose: "Quasar evidence",
      startedAt: "2026-08-23T00:00:00.000Z",
      completedAt: "2026-08-23T00:01:00.000Z",
      initialSourceIds: [sourceId],
      pendingSourceIds: [],
    },
  });
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
  return root;
}

describe("query lifecycle", () => {
  test("begins at the wiki tier and persists a resumable session", async () => {
    const root = await queryBrain();

    const session = await beginQuery(root, "What are quasars?");

    expect(session.status).toBe("open");
    expect(session.tiersUsed).toEqual(["wiki"]);
    expect(session.wikiResults[0]?.id).toBe("pg_quasar_source");
    expect(session.bootstrap.pendingSourceIds).toEqual([]);
    const saved = JSON.parse(
      await readFile(
        path.join(root, ".brain", "runtime", "queries", `${session.id}.json`),
        "utf8",
      ),
    );
    expect(saved.question).toBe("What are quasars?");
  });

  test("records a current wiki read receipt for an open query", async () => {
    const root = await queryBrain();
    const session = await beginQuery(root, "What are quasars?");
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;

    expect(exports).toHaveProperty("readQueryItem");
    const readQueryItem = exports.readQueryItem as (
      root: string,
      queryId: string,
      reference: string,
    ) => Promise<{
      receipt?: { pageId: string; revision: string };
      item: { kind: string };
    }>;
    const result = await readQueryItem(root, session.id, "pg_quasar_source");
    const persisted = await readQuerySession(root, session.id);

    expect(result.item).toMatchObject({ kind: "wiki" });
    expect(result.receipt).toMatchObject({ pageId: "pg_quasar_source" });
    expect(persisted.readReceipts).toEqual([
      expect.objectContaining({
        pageId: "pg_quasar_source",
        revision: result.receipt?.revision,
      }),
    ]);
  });

  test("recovers an interrupted canonical write before beginning a query", async () => {
    const root = await queryBrain();
    const [current] = await loadWikiPages(root);
    if (!current) throw new Error("Expected a wiki page");
    await expect(
      applyChangeSetTransaction(
        root,
        {
          version: 1,
          operationId: "op_query_recovery",
          catalogRevision: calculateCatalogRevision([current]),
          reason: "Simulate an interrupted update",
          pages: [
            {
              action: "update",
              expectedRevision: current.revision,
              page: {
                ...current,
                summary: "This interrupted summary must be rolled back.",
                updatedAt: "2026-08-23T14:00:00.000Z",
              },
            },
          ],
          reconciliation: { candidatePageIds: [], reviewed: [] },
        },
        { simulateCrashAfter: "files-applied", runtimeServices },
      ),
    ).rejects.toThrow("Simulated transaction crash");

    const session = await beginQuery(root, "What are quasars?");

    expect(session.status).toBe("open");
    expect((await loadWikiPages(root))[0]?.summary).toBe(current.summary);
  });

  test("expands to raw sources only after the wiki is assessed as insufficient", async () => {
    const root = await queryBrain();
    const session = await beginQuery(
      root,
      "What does spectroscopy reveal about quasar redshift?",
    );

    const expanded = await expandQuery(root, session.id, {
      tier: "sources",
      reason: "The wiki summary does not cover spectroscopy.",
    });

    expect(expanded.currentTier).toBe("sources");
    expect(expanded.tiersUsed).toEqual(["wiki", "sources"]);
    expect(expanded.sourceResults[0]?.path).toBe("sources/quasar-evidence.md");
    expect(expanded.tierAssessments).toContainEqual(
      expect.objectContaining({ tier: "wiki", status: "insufficient" }),
    );
  });

  test("returns checkpointed source context for pending catalog bootstrap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-bootstrap-"));
    await initBrain(root, { name: "Bootstrap", description: "Bootstrap test" });
    await writeFile(
      path.join(root, "sources", "one.md"),
      "# One\n\nFirst source.\n",
    );
    await writeFile(
      path.join(root, "sources", "two.md"),
      "# Two\n\nSecond source.\n",
    );

    const session = await beginQuery(root, "What is in this brain?");
    const batch = await nextBootstrapBatch(root, session.id);

    expect(session.bootstrap.required).toBe(true);
    expect(batch.sources).toHaveLength(2);
    expect(batch.sources.map((source) => source.extracted?.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("First source"),
        expect.stringContaining("Second source"),
      ]),
    );
  });

  test("registers and commits newly dropped immutable sources at query start", async () => {
    const root = await queryBrain();
    await writeFile(
      path.join(root, "sources", "new-evidence.md"),
      "# New Evidence\n\nA new finding.\n",
    );

    const session = await beginQuery(root, "What is the new finding?");

    const subject = (
      await execFile("git", ["log", "-1", "--pretty=%s"], { cwd: root })
    ).stdout.trim();
    const status = (
      await execFile(
        "git",
        ["status", "--short", "--", "sources", ".brain/source-manifest.json"],
        {
          cwd: root,
        },
      )
    ).stdout.trim();
    expect(subject).toContain("brain(source)");
    expect(status).toBe("");
    expect(session.bootstrap.pendingSourceIds).toHaveLength(1);
  });

  test("rejects modified registered source bytes without overwriting user work", async () => {
    const root = await queryBrain();
    const sourcePath = path.join(root, "sources", "quasar-evidence.md");
    await writeFile(
      sourcePath,
      "# Changed\n\nThese bytes must not replace history.\n",
    );

    await expect(beginQuery(root, "What changed?")).rejects.toThrow(
      /immutable source violation/i,
    );

    expect(await readFile(sourcePath, "utf8")).toContain("must not replace");
    expect(
      await execFile(
        "git",
        ["status", "--short", "--", "sources/quasar-evidence.md"],
        {
          cwd: root,
        },
      ).then((result) => result.stdout.trim()),
    ).toBe("M sources/quasar-evidence.md");
  });

  test("captures deduplicated, versioned web evidence only at the web tier", async () => {
    const root = await queryBrain();
    const session = await beginQuery(
      root,
      "What did the new quasar survey find?",
    );

    await expect(
      captureWebEvidence(root, session.id, {
        url: "https://example.test/quasar-survey",
        title: "Quasar survey",
        captureKind: "page",
        content: "The survey found twelve quasars.",
        retrievedAt: "2026-08-23T12:00:00.000Z",
      }),
    ).rejects.toThrow("web tier");

    await expandQuery(root, session.id, {
      tier: "sources",
      reason: "The local wiki does not cover the new survey.",
    });
    await approveWebForQuery(root, session.id);
    await expandQuery(root, session.id, {
      tier: "web",
      reason: "The raw sources do not cover the new survey.",
    });
    const first = await captureWebEvidence(root, session.id, {
      url: "https://example.test/quasar-survey",
      title: "Quasar survey",
      captureKind: "page",
      content: "The survey found twelve quasars.",
      retrievedAt: "2026-08-23T12:00:00.000Z",
    });
    const duplicate = await captureWebEvidence(root, session.id, {
      url: "https://example.test/quasar-survey",
      title: "Quasar survey",
      captureKind: "page",
      content: "The survey found twelve quasars.",
      retrievedAt: "2026-08-24T12:00:00.000Z",
    });
    const changed = await captureWebEvidence(root, session.id, {
      url: "https://example.test/quasar-survey",
      title: "Quasar survey update",
      captureKind: "page",
      content: "The corrected survey found thirteen quasars.",
      retrievedAt: "2026-08-25T12:00:00.000Z",
    });

    expect(first.source.provenance).toEqual(
      expect.objectContaining({
        kind: "web",
        url: "https://example.test/quasar-survey",
        query: session.question,
      }),
    );
    expect(first.source.path).toMatch(
      /^sources\/web\/2026\/08\/quasar-survey-[a-f0-9]{12}\.md$/,
    );
    expect(duplicate.source.id).toBe(first.source.id);
    expect(duplicate.created).toBe(false);
    expect(changed.source.id).not.toBe(first.source.id);
    expect(changed.source.supersedes).toBe(first.source.id);
    expect(changed.session.webEvidenceSourceIds).toEqual([
      first.source.id,
      changed.source.id,
    ]);
  });

  test("never deletes committed web evidence when query-session linkage fails", async () => {
    const root = await queryBrain();
    const session = await beginQuery(root, "What did Project Aurora report?");
    await expandQuery(root, session.id, {
      tier: "sources",
      reason: "The wiki does not mention Project Aurora.",
    });
    await approveWebForQuery(root, session.id);
    await expandQuery(root, session.id, {
      tier: "web",
      reason: "Local sources do not mention Project Aurora.",
    });
    const input = {
      url: "https://example.test/aurora",
      title: "Project Aurora",
      captureKind: "page" as const,
      content: "Aurora reported a candidate signal.",
      retrievedAt: "2026-08-23T14:00:00.000Z",
    };

    await expect(
      captureWebEvidence(root, session.id, input, {
        simulateSessionWriteFailure: true,
      }),
    ).rejects.toThrow(/session write failure/i);

    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    );
    const source = manifest.sources.find(
      (candidate: { provenance?: { url?: string } }) =>
        candidate.provenance?.url === input.url,
    );
    expect(source).toBeDefined();
    expect(await readFile(path.join(root, source.path), "utf8")).toContain(
      "candidate signal",
    );
    expect(
      await execFile(
        "git",
        ["status", "--short", "--", source.path, ".brain/source-manifest.json"],
        { cwd: root },
      ).then((result) => result.stdout.trim()),
    ).toBe("");

    const retry = await captureWebEvidence(root, session.id, input);
    expect(retry.created).toBe(false);
    expect(retry.session.webEvidenceSourceIds).toContain(source.id);
    expect(retry.session.bootstrap).toMatchObject({
      required: true,
      pendingSourceIds: [source.id],
    });
  });

  test("does not delete prepared web evidence while another canonical writer is active", async () => {
    const root = await queryBrain();
    const session = await beginQuery(
      root,
      "What did the concurrent survey find?",
    );
    await expandQuery(root, session.id, {
      tier: "sources",
      reason: "The wiki does not cover the concurrent survey.",
    });
    await approveWebForQuery(root, session.id);
    await expandQuery(root, session.id, {
      tier: "web",
      reason: "Local sources do not cover the concurrent survey.",
    });
    const input = {
      url: "https://example.test/concurrent-survey",
      title: "Concurrent capture",
      captureKind: "page" as const,
      content: "The concurrent survey found a candidate.",
    };
    const digest = createHash("sha256")
      .update(`${input.url}\0${input.content}`)
      .digest("hex")
      .slice(0, 12);
    const evidenceName = `concurrent-capture-${digest}.md`;
    await writeFile(
      path.join(root, ".brain", "runtime", "writer.lock"),
      `${JSON.stringify({
        pid: process.pid,
        operationId: "op_concurrent_capture",
        recoverable: false,
      })}\n`,
    );

    await expect(captureWebEvidence(root, session.id, input)).rejects.toThrow(
      /exist|lock|writer/i,
    );

    const evidencePath = await findFileNamed(
      path.join(root, "sources", "web"),
      evidenceName,
    );
    if (!evidencePath) throw new Error("Expected prepared web evidence");
    const preparedEvidence = await readFile(evidencePath, "utf8");
    expect(preparedEvidence).toContain("concurrent survey found a candidate");

    await rm(path.join(root, ".brain", "runtime", "writer.lock"));
    await writeFile(evidencePath, "mismatched prepared bytes\n");
    await expect(captureWebEvidence(root, session.id, input)).rejects.toThrow(
      /prepared web evidence bytes do not match/i,
    );
    await writeFile(evidencePath, preparedEvidence);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const resumed = await captureWebEvidence(root, session.id, input);

    expect(resumed.created).toBe(true);
    expect(resumed.session.webEvidenceSourceIds).toContain(resumed.source.id);
    expect(resumed.source.path).toBe(
      path.relative(root, evidencePath).split(path.sep).join("/"),
    );
  });

  test("finishes a wiki-only answer with a log-only knowledge operation", async () => {
    const root = await queryBrain();
    const session = await beginQuery(root, "What are quasars?");

    const finished = await finishQuery(root, session.id, {
      outcome: "answered",
      answerSummary: "Quasars are luminous galactic nuclei.",
    });

    expect(finished.session.status).toBe("finished");
    expect(finished.session.outcome).toBe("answered");
    expect(finished.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(await readFile(path.join(root, "wiki", "log.md"), "utf8")).toContain(
      session.question,
    );
    const operation = JSON.parse(
      (await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .at(-1) ?? "{}",
    );
    expect(operation).toMatchObject({
      kind: "query",
      status: "completed",
      tiersUsed: ["wiki"],
    });
  });

  test("resumes query completion after a commit-completed interruption without duplicating the log", async () => {
    const root = await queryBrain();
    const session = await beginQuery(root, "What are quasars?");
    const finishOptions = {
      outcome: "answered" as const,
      answerSummary: "Quasars are luminous galactic nuclei.",
    };

    await expect(
      finishQuery(root, session.id, finishOptions, {
        simulateCrashAfter: "committed",
      }),
    ).rejects.toThrow("Simulated transaction crash");

    const resumed = await finishQuery(root, session.id, finishOptions);
    const queryOperations = (
      await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(
        (operation: { kind?: string; queryId?: string }) =>
          operation.kind === "query" && operation.queryId === session.id,
      );

    expect(resumed.session.status).toBe("finished");
    expect(queryOperations).toHaveLength(1);
    expect(resumed.operationId).toBe(queryOperations[0]?.id);
  });

  test("blocks query completion while a semantic audit is due", async () => {
    const root = await queryBrain();
    const session = await beginQuery(root, "What are quasars?");
    const statePath = path.join(root, ".brain", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.knowledgeMutations = 25;
    state.semanticAuditDue = true;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await execFile("git", ["add", ".brain/state.json"], { cwd: root });
    await execFile("git", ["commit", "-m", "test: semantic audit due"], {
      cwd: root,
    });

    await expect(
      finishQuery(root, session.id, {
        outcome: "answered",
        answerSummary: "Quasars are luminous galactic nuclei.",
      }),
    ).rejects.toThrow(/semantic audit/i);
  });

  test("requires a durable wiki mutation before a raw-backed answer can finish", async () => {
    const root = await queryBrain();
    const session = await beginQuery(
      root,
      "What does spectroscopy reveal about quasar redshift?",
    );
    await expandQuery(root, session.id, {
      tier: "sources",
      reason: "The wiki lacks the spectroscopy detail.",
    });

    await expect(
      finishQuery(root, session.id, {
        outcome: "answered",
        answerSummary: "Spectroscopy reveals quasar redshift.",
      }),
    ).rejects.toThrow(/durable wiki/i);

    const [current] = await loadWikiPages(root);
    if (!current) throw new Error("Expected a wiki page");
    const transaction = await applyChangeSetTransaction(
      root,
      {
        version: 1,
        operationId: "op_query_raw_update",
        catalogRevision: calculateCatalogRevision([current]),
        reason: "Persist raw-backed spectroscopy knowledge",
        pages: [
          {
            action: "update",
            expectedRevision: current.revision,
            page: {
              ...current,
              summary:
                "Quasars are luminous nuclei whose redshift is measured spectroscopically.",
              updatedAt: "2026-08-23T13:00:00.000Z",
              body: `${current.body}\n\nSpectroscopy reveals their redshift. [@${current.sources[0]?.id}#heading=quasar-evidence]`,
            },
          },
        ],
        reconciliation: { candidatePageIds: [], reviewed: [] },
      },
      { queryId: session.id, runtimeServices },
    );
    await attachQueryChange(root, session.id, transaction.operationId);
    const finished = await finishQuery(root, session.id, {
      outcome: "answered",
      answerSummary: "Spectroscopy reveals quasar redshift.",
    });

    expect(finished.session.changeOperationIds).toEqual([
      "op_query_raw_update",
    ]);
    expect(finished.session.status).toBe("finished");
  });

  test("rejects attaching an unbound historical wiki mutation to a query", async () => {
    const root = await queryBrain();
    const [current] = await loadWikiPages(root);
    if (!current) throw new Error("Expected a wiki page");
    const transaction = await applyChangeSetTransaction(
      root,
      {
        version: 1,
        operationId: "op_unbound_history",
        catalogRevision: calculateCatalogRevision([current]),
        reason: "A mutation unrelated to the later query",
        pages: [
          {
            action: "update",
            expectedRevision: current.revision,
            page: {
              ...current,
              summary: "An unrelated historical summary.",
              updatedAt: "2026-08-23T14:00:00.000Z",
            },
          },
        ],
        reconciliation: { candidatePageIds: [], reviewed: [] },
      },
      { runtimeServices },
    );
    const session = await beginQuery(root, "What does spectroscopy reveal?");
    await expandQuery(root, session.id, {
      tier: "sources",
      reason: "The wiki does not answer the question.",
    });

    await expect(
      attachQueryChange(root, session.id, transaction.operationId),
    ).rejects.toThrow(/bound|query/i);
  });

  test("does not let a wiki-tier mutation satisfy a raw-backed answer", async () => {
    const root = await queryBrain();
    const session = await beginQuery(root, "What does spectroscopy reveal?");
    const [current] = await loadWikiPages(root);
    if (!current) throw new Error("Expected a wiki page");
    const transaction = await applyChangeSetTransaction(
      root,
      {
        version: 1,
        operationId: "op_wiki_tier_only",
        catalogRevision: calculateCatalogRevision([current]),
        reason: "Persist a wiki-tier clarification",
        pages: [
          {
            action: "update",
            expectedRevision: current.revision,
            page: {
              ...current,
              summary: "A clarified wiki-only summary of quasars.",
              updatedAt: "2026-08-23T14:00:00.000Z",
            },
          },
        ],
        reconciliation: { candidatePageIds: [], reviewed: [] },
      },
      { queryId: session.id, runtimeServices },
    );
    await attachQueryChange(root, session.id, transaction.operationId);
    await expandQuery(root, session.id, {
      tier: "sources",
      reason: "The clarified wiki still lacks spectroscopy details.",
    });

    await expect(
      finishQuery(root, session.id, {
        outcome: "answered",
        answerSummary: "Spectroscopy reveals redshift.",
      }),
    ).rejects.toThrow(/source|tier|raw/i);
  });

  test("blocks completion while catalog bootstrap still has uncataloged sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-bootstrap-finish-"));
    await initBrain(root, { name: "Bootstrap", description: "Bootstrap test" });
    const state = await readBrainState(root);
    await writeBrainState(root, {
      ...state,
      setup: {
        status: "completed",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "Prior setup",
        startedAt: "2026-08-23T00:00:00.000Z",
        completedAt: "2026-08-23T01:00:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });
    await writeFile(
      path.join(root, "sources", "pending.md"),
      "# Pending\n\nPending knowledge.\n",
    );
    const session = await beginQuery(root, "What is pending?");
    await expandQuery(root, session.id, {
      tier: "sources",
      reason: "The wiki does not answer the pending-source question.",
    });

    await expect(
      finishQuery(root, session.id, {
        outcome: "answered",
        answerSummary: "Pending knowledge.",
      }),
    ).rejects.toThrow(/delta bootstrap/i);
  });
});
