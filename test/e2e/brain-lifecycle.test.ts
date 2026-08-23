import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test } from "vitest";
import {
  applyChangeSetTransaction,
  attachQueryChange,
  beginQuery,
  buildReconciliationCandidates,
  calculateCatalogRevision,
  captureWebEvidence,
  expandQuery,
  finishQuery,
  initBrain,
  loadWikiPages,
  nextBootstrapBatch,
  nextSemanticAuditBatch,
  readQuerySession,
  recordSemanticAuditBatch,
  recoverBrain,
  scanAndRegisterSources,
  searchBrain,
  supersedeRegisteredSource,
  type BootstrapSourceContextV1,
  type WikiPageV1,
} from "@second-brain/core";

const execFile = promisify(execFileCallback);
const fixedTime = "2026-08-23T12:00:00.000Z";

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function createBrain(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "second-brain-e2e-"));
  await initBrain(root, {
    name,
    description: `${name} domain knowledge`,
  });
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Second Brain E2E"]);
  await git(root, ["config", "user.email", "brain-e2e@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initialize independent brain"]);
  return root;
}

function sourcePage(context: BootstrapSourceContextV1): WikiPageV1 {
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

async function applyCreatedPages(
  root: string,
  queryId: string,
  operationId: string,
  pages: WikiPageV1[],
): Promise<void> {
  const current = await loadWikiPages(root);
  const proposed = [...current, ...pages];
  const changedPageIds = new Set(pages.map((page) => page.id));
  const currentPageIds = new Set(current.map((page) => page.id));
  const relatedSearchResults: Awaited<ReturnType<typeof searchBrain>> = [];
  for (const page of pages) {
    relatedSearchResults.push(
      ...(await searchBrain(root, {
        query: `${page.title} ${page.summary}`,
        scope: "wiki",
        limit: 20,
      })),
    );
  }
  const searchedCandidates = relatedSearchResults
    .filter(
      (result) =>
        currentPageIds.has(result.id) && !changedPageIds.has(result.id),
    )
    .map((result) => result.id);
  const candidates = [
    ...new Set([
      ...buildReconciliationCandidates(proposed, [...changedPageIds]),
      ...searchedCandidates,
    ]),
  ].sort();
  const result = await applyChangeSetTransaction(
    root,
    {
      version: 1,
      operationId,
      catalogRevision: calculateCatalogRevision(current),
      reason: `E2E fake-host mutation ${operationId}`,
      pages: pages.map((page) => ({ action: "create" as const, page })),
      reconciliation: {
        candidatePageIds: candidates,
        reviewed: candidates.map((pageId) => ({
          pageId,
          decision: "no-change" as const,
          reason: "Read in full; the new cited claim does not alter this page.",
        })),
      },
    },
    { queryId },
  );
  await attachQueryChange(root, queryId, result.operationId);
}

async function writeEverySupportedFormat(root: string): Promise<void> {
  await writeFile(
    path.join(root, "sources", "periapsis.md"),
    "# Periapsis\n\nPeriapsis is the nearest point in an orbit.\n",
  );
  await writeFile(
    path.join(root, "sources", "contradiction.txt"),
    "A disputed note calls periapsis the farthest orbital point.\n",
  );
  await writeFile(
    path.join(root, "sources", "stars.html"),
    "<article><h1>Stars</h1><p>Stars emit light.</p></article><script>ignore()</script>",
  );
  await writeFile(
    path.join(root, "sources", "planets.json"),
    JSON.stringify({ planet: "Mars", moons: 2 }),
  );
  await writeFile(
    path.join(root, "sources", "events.jsonl"),
    '{"event":"launch"}\n{"event":"landing"}\n',
  );
  await writeFile(
    path.join(root, "sources", "missions.csv"),
    "mission,target\nArtemis,Moon\n",
  );
  await writeFile(
    path.join(root, "sources", "moons.tsv"),
    "moon\tplanet\nEuropa\tJupiter\n",
  );

  const pdf = await PDFDocument.create();
  const pdfPage = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdfPage.drawText("A pulsar is a rotating neutron star.", {
    x: 40,
    y: 700,
    size: 12,
    font,
  });
  await writeFile(path.join(root, "sources", "pulsars.pdf"), await pdf.save());

  const epub = new JSZip();
  epub.file("mimetype", "application/epub+zip");
  epub.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  );
  epub.file(
    "OEBPS/content.opf",
    '<?xml version="1.0"?><package><metadata><title>Mars Voyage</title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
  );
  epub.file(
    "OEBPS/chapter.xhtml",
    "<html><body><h1>Arrival</h1><p>The crew reached Mars.</p></body></html>",
  );
  await writeFile(
    path.join(root, "sources", "voyage.epub"),
    await epub.generateAsync({ type: "uint8array" }),
  );
}

describe("portable second-brain fake host", () => {
  test("bootstraps every format, compounds a raw answer, preserves conflict, and reuses the wiki", async () => {
    const root = await createBrain("Astronomy Brain");
    await writeEverySupportedFormat(root);

    const session = await beginQuery(root, "What is periapsis?");
    expect(session.currentTier).toBe("wiki");
    expect(session.bootstrap.pendingSourceIds).toHaveLength(9);
    const batch = await nextBootstrapBatch(root, session.id);
    expect(batch.sources).toHaveLength(9);
    expect(new Set(batch.sources.map((item) => item.record.mediaType))).toEqual(
      new Set([
        "text/markdown",
        "text/plain",
        "text/html",
        "application/json",
        "application/x-ndjson",
        "text/csv",
        "text/tab-separated-values",
        "application/pdf",
        "application/epub+zip",
      ]),
    );
    await applyCreatedPages(
      root,
      session.id,
      "op_e2e_bootstrap_formats",
      batch.sources.map(sourcePage),
    );
    expect(
      JSON.parse(
        await readFile(path.join(root, ".brain", "state.json"), "utf8"),
      ).bootstrap,
    ).toEqual({ status: "completed", pendingSourceIds: [] });

    const expanded = await expandQuery(root, session.id, {
      tier: "sources",
      reason: "The initial wiki did not define periapsis.",
    });
    expect(expanded.sourceResults.length).toBeGreaterThan(0);
    const nearest = batch.sources.find((item) =>
      item.record.path.endsWith("periapsis.md"),
    );
    const disputed = batch.sources.find((item) =>
      item.record.path.endsWith("contradiction.txt"),
    );
    if (!nearest?.extracted?.chunks[0] || !disputed?.extracted?.chunks[0]) {
      throw new Error("Expected both periapsis evidence chunks");
    }
    const nearestSourcePage = sourcePage(nearest);
    const disputedSourcePage = sourcePage(disputed);
    const topic: WikiPageV1 = {
      schema: 1,
      id: "pg_periapsis_topic",
      path: "wiki/pages/topics/periapsis.md",
      title: "Periapsis",
      type: "topic",
      status: "active",
      summary:
        "Periapsis is the nearest orbital point, with a contradictory note retained.",
      aliases: ["Pericenter"],
      tags: ["orbits"],
      createdAt: fixedTime,
      updatedAt: fixedTime,
      revision: "pending",
      sources: [
        {
          id: nearest.record.id,
          locators: [nearest.extracted.chunks[0].locator],
        },
        {
          id: disputed.record.id,
          locators: [disputed.extracted.chunks[0].locator],
        },
      ],
      relations: [
        {
          targetId: nearestSourcePage.id,
          kind: "supports",
          sourceIds: [nearest.record.id],
        },
        {
          targetId: disputedSourcePage.id,
          kind: "contradicts",
          sourceIds: [disputed.record.id],
        },
      ],
      body: `# Periapsis\n\nPeriapsis is the nearest point in an orbit. [@${nearest.record.id}#${nearest.extracted.chunks[0].locator}]\n\n## Conflicts\n\nA disputed note instead calls it the farthest point; this contradiction remains unresolved. [@${disputed.record.id}#${disputed.extracted.chunks[0].locator}]`,
    };
    await applyCreatedPages(root, session.id, "op_e2e_raw_answer", [topic]);
    const finished = await finishQuery(root, session.id, {
      outcome: "answered",
      answerSummary:
        "Periapsis is the nearest orbital point; one source conflicts.",
    });
    expect(finished.commit).toMatch(/^[a-f0-9]{40}$/);

    const topicMarkdown = await readFile(path.join(root, topic.path), "utf8");
    expect(topicMarkdown).toContain("## Conflicts");
    expect(topicMarkdown).toContain("contradicts");
    const sourceMarkdown = await readFile(
      path.join(root, nearestSourcePage.path),
      "utf8",
    );
    expect(sourceMarkdown).toContain("Periapsis");
    expect(await readFile(path.join(root, "wiki", "map.md"), "utf8")).toContain(
      "contradicts",
    );

    const repeated = await beginQuery(root, "What is periapsis?");
    expect(repeated.wikiResults.some((result) => result.id === topic.id)).toBe(
      true,
    );
    const repeatedFinish = await finishQuery(root, repeated.id, {
      outcome: "answered",
      answerSummary: "Answered from the existing cited periapsis page.",
    });
    expect(repeatedFinish.session.tiersUsed).toEqual(["wiki"]);
    expect(repeatedFinish.session.changeOperationIds).toEqual([]);

    const beforeRebuild = await searchBrain(root, {
      query: "periapsis nearest orbit",
      scope: "sources",
    });
    await rm(path.join(root, ".brain", "cache"), {
      recursive: true,
      force: true,
    });
    const afterRebuild = await searchBrain(root, {
      query: "periapsis nearest orbit",
      scope: "sources",
    });
    expect(afterRebuild).toEqual(beforeRebuild);
  }, 30_000);

  test("captures web evidence and persists an honest unanswered gap", async () => {
    const root = await createBrain("Research Brain");
    const session = await beginQuery(root, "Did Project Zephyr discover life?");
    await expandQuery(root, session.id, {
      tier: "sources",
      reason: "No local page or source addresses Project Zephyr.",
    });
    await expandQuery(root, session.id, {
      tier: "web",
      reason: "The local sources contain no relevant evidence.",
    });
    const capture = await captureWebEvidence(root, session.id, {
      url: "https://example.test/zephyr",
      title: "Project Zephyr report",
      captureKind: "snippet",
      content: "A snippet claims a possible biosignature but gives no data.",
      retrievedAt: fixedTime,
    });
    expect(capture.source.provenance).toMatchObject({
      kind: "web",
      captureKind: "snippet",
    });

    const batch = await nextBootstrapBatch(root, session.id);
    const capturedContext = batch.sources[0];
    if (!capturedContext?.extracted?.chunks[0]) {
      throw new Error("Expected captured snippet context");
    }
    const capturedPage = sourcePage(capturedContext);
    const locator = capturedContext.extracted.chunks[0].locator;
    const gap: WikiPageV1 = {
      schema: 1,
      id: "pg_question_zephyr_life",
      path: "wiki/pages/questions/zephyr-life.md",
      title: "Did Project Zephyr discover life?",
      type: "question",
      status: "active",
      summary: "Unresolved: a captured snippet lacks supporting data.",
      aliases: [],
      tags: ["evidence-gap"],
      createdAt: fixedTime,
      updatedAt: fixedTime,
      revision: "pending",
      sources: [{ id: capture.source.id, locators: [locator] }],
      relations: [
        {
          targetId: capturedPage.id,
          kind: "related-to",
          sourceIds: [capture.source.id],
        },
      ],
      body: `# Did Project Zephyr discover life?\n\nThe claim is not established. A captured snippet mentions only a possible biosignature and supplies no data. [@${capture.source.id}#${locator}]\n\n## Evidence needed\n\nA primary report with methods, measurements, and independent confirmation.`,
    };
    await applyCreatedPages(root, session.id, "op_e2e_web_gap", [
      capturedPage,
      gap,
    ]);
    const finished = await finishQuery(root, session.id, {
      outcome: "unanswered",
      answerSummary:
        "The claim remains unestablished; primary data and confirmation are needed.",
    });

    expect(finished.session).toMatchObject({
      status: "finished",
      outcome: "unanswered",
      tiersUsed: ["wiki", "sources", "web"],
    });
    expect((await loadWikiPages(root)).some((page) => page.id === gap.id)).toBe(
      true,
    );
    expect(
      await readFile(path.join(root, capture.source.path), "utf8"),
    ).toContain("brainWebCapture: 1");
  });

  test("keeps cloned brains independent and enforces source supersession", async () => {
    const astronomy = await createBrain("Astronomy");
    const marketing = await createBrain("Marketing");
    const sourceRelativePath = path.join("sources", "facts.md");
    const astronomyBytes = "# Facts\n\nSaturn has rings.\n";
    const marketingBytes = "# Facts\n\nRetention compounds growth.\n";
    await writeFile(path.join(astronomy, sourceRelativePath), astronomyBytes);
    await writeFile(path.join(marketing, sourceRelativePath), marketingBytes);

    const astronomyQuery = await beginQuery(astronomy, "What has rings?");
    const marketingQuery = await beginQuery(
      marketing,
      "What compounds growth?",
    );
    const astronomyManifest = JSON.parse(
      await readFile(
        path.join(astronomy, ".brain", "source-manifest.json"),
        "utf8",
      ),
    );
    const marketingManifest = JSON.parse(
      await readFile(
        path.join(marketing, ".brain", "source-manifest.json"),
        "utf8",
      ),
    );
    const astronomySource = astronomyManifest.sources[0];
    const marketingSource = marketingManifest.sources[0];
    expect(astronomySource.id).not.toBe(marketingSource.id);
    expect(astronomyQuery.id).not.toBe(marketingQuery.id);
    expect(await readQuerySession(astronomy, astronomyQuery.id)).toMatchObject({
      question: "What has rings?",
    });
    await expect(
      readQuerySession(marketing, astronomyQuery.id),
    ).rejects.toThrow();

    await writeFile(
      path.join(astronomy, sourceRelativePath),
      "# Facts\n\nModified in place.\n",
    );
    await expect(
      beginQuery(astronomy, "Did the source change?"),
    ).rejects.toThrow(/immutable source violation/i);
    await writeFile(path.join(astronomy, sourceRelativePath), astronomyBytes);
    await writeFile(
      path.join(astronomy, "sources", "facts-v2.md"),
      "# Facts v2\n\nSaturn and other giant planets have rings.\n",
    );
    const registered = await scanAndRegisterSources(astronomy);
    const replacement = registered.added[0];
    if (!replacement) throw new Error("Expected replacement source");
    const superseded = await supersedeRegisteredSource(
      astronomy,
      astronomySource.id,
      replacement.id,
    );
    expect(superseded.source.supersedes).toBe(astronomySource.id);
    expect(marketingManifest.sources).toHaveLength(1);
  });

  test("rolls back failures, recovers crashes, and resumes the 25-operation audit", async () => {
    const root = await createBrain("Safety Brain");
    const statePath = path.join(root, ".brain", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.knowledgeMutations = 24;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await git(root, ["add", ".brain/state.json"]);
    await git(root, ["commit", "-m", "test: seed 24 prior operations"]);
    await writeFile(path.join(root, "unrelated.txt"), "preserve me\n");

    const makePage = (id: string, title: string): WikiPageV1 => ({
      schema: 1,
      id,
      path: `wiki/pages/sources/${id.slice(3)}.md`,
      title,
      type: "source",
      status: "active",
      summary: `${title} catalog summary.`,
      aliases: [],
      tags: [],
      createdAt: fixedTime,
      updatedAt: fixedTime,
      revision: "pending",
      sources: [],
      relations: [],
      body: `# ${title}\n\n${title} catalog summary.`,
    });
    const first = makePage("pg_safety_first", "Safety First");
    const second = makePage("pg_safety_second", "Safety Second");
    const changeSet = (operationId: string, pages = [first, second]) => ({
      version: 1 as const,
      operationId,
      catalogRevision: calculateCatalogRevision([]),
      reason: "Exercise recoverable E2E mutation",
      pages: pages.map((page) => ({ action: "create" as const, page })),
      reconciliation: { candidatePageIds: [], reviewed: [] },
    });
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);

    const invalid = makePage("pg_safety_invalid", "Safety Invalid");
    invalid.relations = [
      {
        targetId: "pg_missing_safety_target",
        kind: "related-to",
        sourceIds: [],
      },
    ];
    await expect(
      applyChangeSetTransaction(root, changeSet("op_e2e_invalid", [invalid])),
    ).rejects.toThrow(/DANGLING_RELATION/);
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);

    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    await expect(
      applyChangeSetTransaction(root, changeSet("op_e2e_commit_failure")),
    ).rejects.toThrow();
    await rm(hook);
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);

    await expect(
      applyChangeSetTransaction(root, changeSet("op_e2e_crash"), {
        simulateCrashAfter: "files-applied",
      }),
    ).rejects.toThrow(/Simulated transaction crash/);
    expect(await recoverBrain(root)).toBe("restored");
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);

    await applyChangeSetTransaction(root, changeSet("op_e2e_mutation_25"));
    expect(await readFile(path.join(root, "unrelated.txt"), "utf8")).toBe(
      "preserve me\n",
    );
    expect(await git(root, ["status", "--short", "--", "unrelated.txt"])).toBe(
      "?? unrelated.txt",
    );
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      knowledgeMutations: 25,
      semanticAuditDue: true,
    });

    expect((await nextSemanticAuditBatch(root)).pageIds).toEqual([
      first.id,
      second.id,
    ]);
    const checkpoint = await recordSemanticAuditBatch(root, {
      pageIds: [first.id],
      summary: "Reviewed the first page and checkpointed progress.",
    });
    expect(checkpoint.complete).toBe(false);
    expect((await nextSemanticAuditBatch(root)).pageIds).toEqual([second.id]);
    const complete = await recordSemanticAuditBatch(root, {
      pageIds: [second.id],
      summary: "Reviewed the remaining page; no issue found.",
    });
    expect(complete.complete).toBe(true);
  });
});
