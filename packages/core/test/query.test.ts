import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  renderWikiPage,
  scanSources,
  type WikiPageV1,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

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
    const transaction = await applyChangeSetTransaction(root, {
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
    });
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

  test("blocks completion while catalog bootstrap still has uncataloged sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-bootstrap-finish-"));
    await initBrain(root, { name: "Bootstrap", description: "Bootstrap test" });
    await writeFile(
      path.join(root, "sources", "pending.md"),
      "# Pending\n\nPending knowledge.\n",
    );
    const session = await beginQuery(root, "What is pending?");

    await expect(
      finishQuery(root, session.id, {
        outcome: "answered",
        answerSummary: "Pending knowledge.",
      }),
    ).rejects.toThrow(/bootstrap/i);
  });
});
