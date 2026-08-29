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
  attachSetupChange,
  beginSetup,
  beginQuery,
  calculateCatalogRevision,
  captureWebEvidence,
  configureSyncTarget,
  expandQuery,
  finishSetup,
  finishQuery,
  formatSyncWarning,
  initBrain,
  loadWikiPages,
  nextBootstrapBatch,
  nextSetupBatch,
  nextSemanticAuditBatch,
  planReconciliation,
  readQuerySession,
  recordSemanticAuditBatch,
  recoverBrain,
  requestWebApproval,
  resolveWebApproval,
  scanAndRegisterSources,
  searchBrain,
  supersedeRegisteredSource,
  type BrainRuntimeServices,
  type BootstrapSourceContextV1,
  type KnowledgeMutationContext,
  type SetupSourceContextV1,
  type WikiPageV1,
} from "@second-brain/core";

const execFile = promisify(execFileCallback);
const fixedTime = "2026-08-23T12:00:00.000Z";
const runtimeServices: BrainRuntimeServices = {
  embeddings: {
    modelId: "test/e2e-deterministic-e5",
    modelRevision: "test-revision",
    async embed(texts) {
      return texts.map(() => [1, 0]);
    },
  },
};

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

async function applyCreatedPages(
  root: string,
  context: KnowledgeMutationContext,
  operationId: string,
  pages: WikiPageV1[],
): Promise<void> {
  const current = await loadWikiPages(root);
  const changeSet = {
    version: 1 as const,
    operationId,
    catalogRevision: calculateCatalogRevision(current),
    reason: `E2E fake-host mutation ${operationId}`,
    pages: pages.map((page) => ({ action: "create" as const, page })),
    reconciliation: { candidatePageIds: [], reviewed: [] },
  };
  const plan = await planReconciliation(root, changeSet, runtimeServices);
  const directlyRelatedPageIds = new Set(
    pages.flatMap((page) =>
      page.relations.map((relation) => relation.targetId),
    ),
  );
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
      decision: directlyRelatedPageIds.has(candidate.pageId)
        ? ("changed" as const)
        : ("no-change" as const),
      reason: directlyRelatedPageIds.has(candidate.pageId)
        ? "The new page adds a durable relationship to this reviewed page."
        : "Read in full; the new cited claim does not alter this page.",
    })),
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
}

async function completeInitialSetup(
  root: string,
  purpose: string,
): Promise<Array<BootstrapSourceContextV1 | SetupSourceContextV1>> {
  const setup = await beginSetup(root, { purpose }, runtimeServices);
  const sources: Array<BootstrapSourceContextV1 | SetupSourceContextV1> = [];
  let batchNumber = 0;
  while (true) {
    const batch = await nextSetupBatch(root, setup.id);
    if (batch.sources.length === 0) break;
    sources.push(...batch.sources);
    await applyCreatedPages(
      root,
      { kind: "setup", id: setup.id },
      `op_e2e_setup_batch_${batchNumber}`,
      batch.sources.map(sourcePage),
    );
    batchNumber += 1;
  }

  while (true) {
    const audit = await nextSemanticAuditBatch(root);
    if (audit.pageIds.length === 0) break;
    const recorded = await recordSemanticAuditBatch(root, {
      pageIds: audit.pageIds,
      summary: "Reviewed the complete initial catalog and map.",
    });
    if (recorded.complete) break;
  }
  await finishSetup(root, setup.id, {
    summary: "Initial source catalog and shallow map are complete.",
  });
  return sources;
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

  const docx = new JSZip();
  docx.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  docx.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  docx.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  docx.file(
    "word/styles.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
  );
  docx.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Orbital Resonance</w:t></w:r></w:p><w:p><w:r><w:t>Orbital resonance occurs when orbiting bodies exert regular gravitational influence.</w:t></w:r></w:p></w:body></w:document>',
  );
  await writeFile(
    path.join(root, "sources", "resonance.docx"),
    await docx.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    }),
  );

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

    const initialSources = await completeInitialSetup(
      root,
      "Astronomy concepts and observations",
    );
    expect(initialSources).toHaveLength(10);
    expect(
      new Set(initialSources.map((item) => item.record.mediaType)),
    ).toEqual(
      new Set([
        "text/markdown",
        "text/plain",
        "text/html",
        "application/json",
        "application/x-ndjson",
        "text/csv",
        "text/tab-separated-values",
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/epub+zip",
      ]),
    );
    expect(
      initialSources.find((item) => item.record.path.endsWith("resonance.docx"))
        ?.extracted?.chunks[0],
    ).toMatchObject({ locator: "heading=orbital-resonance" });
    const session = await beginQuery(root, "What is periapsis?");
    expect(session.currentTier).toBe("wiki");
    expect(session.setup.status).toBe("completed");
    expect(session.bootstrap.pendingSourceIds).toEqual([]);
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
    const nearest = initialSources.find((item) =>
      item.record.path.endsWith("periapsis.md"),
    );
    const disputed = initialSources.find((item) =>
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
    await applyCreatedPages(
      root,
      { kind: "query", id: session.id },
      "op_e2e_raw_answer",
      [topic],
    );
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
    await writeFile(
      path.join(root, "sources", "research-foundation.md"),
      "# Research foundation\n\nThe initial local corpus contains general research notes.\n",
    );
    await completeInitialSetup(root, "Research evidence");
    const session = await beginQuery(root, "Did Project Zephyr discover life?");
    await expandQuery(root, session.id, {
      tier: "sources",
      reason: "No local page or source addresses Project Zephyr.",
    });
    await requestWebApproval(root, session.id, {
      reason: "The local source catalog has no Project Zephyr evidence.",
      hostSessionId: "e2e-fake-host",
    });
    await resolveWebApproval(root, session.id, {
      approved: true,
      decidedBy: "e2e-owner",
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
    await applyCreatedPages(
      root,
      { kind: "query", id: session.id },
      "op_e2e_web_gap",
      [capturedPage, gap],
    );
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

  test("exposes the complete host lifecycle through durable state", async () => {
    const root = await createBrain("Host contract Brain");
    await writeFile(
      path.join(root, "sources", "contract.md"),
      "# Contract evidence\n\nA raw source supports the host contract.\n",
    );
    const setupSources = await completeInitialSetup(
      root,
      "Host lifecycle contract evidence",
    );
    const source = setupSources[0];
    if (!source?.extracted?.chunks[0]) {
      throw new Error("Expected a source page from the initial setup");
    }
    const sourcePageId = `pg_source_${source.record.id.slice(4, 16)}`;

    const wikiOnly = await beginQuery(root, "What is already known?");
    const wikiOnlyFinished = await finishQuery(root, wikiOnly.id, {
      outcome: "answered",
      answerSummary: "The existing wiki can be answered without new evidence.",
    });
    expect(wikiOnlyFinished.session).toMatchObject({
      tiersUsed: ["wiki"],
      changeOperationIds: [],
      sync: { status: "unconfigured" },
    });

    const raw = await beginQuery(
      root,
      "What does the raw contract source say?",
    );
    await expandQuery(root, raw.id, {
      tier: "sources",
      reason: "The shallow source catalog has no reusable answer page yet.",
    });
    const rawTopic: WikiPageV1 = {
      schema: 1,
      id: "pg_contract_raw_topic",
      path: "wiki/pages/topics/contract-raw.md",
      title: "Host contract evidence",
      type: "topic",
      status: "active",
      summary: "A raw source supports the host contract.",
      aliases: [],
      tags: ["contract"],
      createdAt: fixedTime,
      updatedAt: fixedTime,
      revision: "pending",
      sources: [
        {
          id: source.record.id,
          locators: [source.extracted.chunks[0].locator],
        },
      ],
      relations: [
        {
          targetId: sourcePageId,
          kind: "supports",
          sourceIds: [source.record.id],
        },
      ],
      body: `# Host contract evidence\n\nA raw source supports the host contract. [@${source.record.id}#${source.extracted.chunks[0].locator}]`,
    };
    await applyCreatedPages(
      root,
      { kind: "query", id: raw.id },
      "op_e2e_host_raw",
      [rawTopic],
    );
    const rawFinished = await finishQuery(root, raw.id, {
      outcome: "answered",
      answerSummary: "The raw source has been persisted as a cited topic.",
    });
    expect(rawFinished.session).toMatchObject({
      tiersUsed: ["wiki", "sources"],
      outcome: "answered",
    });

    const denied = await beginQuery(root, "Can the host research the web now?");
    await expandQuery(root, denied.id, {
      tier: "sources",
      reason: "No local page answers the web-policy question.",
    });
    await requestWebApproval(root, denied.id, {
      reason: "The local source catalog is insufficient for this question.",
      hostSessionId: "e2e-host-contract",
    });
    await resolveWebApproval(root, denied.id, {
      approved: false,
      decidedBy: "brain-owner",
      denialReason: "Keep this question local.",
    });
    await expect(
      expandQuery(root, denied.id, {
        tier: "web",
        reason: "The owner denied web research.",
      }),
    ).rejects.toThrow(/denied|approval/i);
    const deniedGap: WikiPageV1 = {
      schema: 1,
      id: "pg_contract_denied_gap",
      path: "wiki/pages/questions/web-policy-gap.md",
      title: "Can the host research the web now?",
      type: "question",
      status: "active",
      summary: "Unresolved because the owner denied web research.",
      aliases: [],
      tags: ["evidence-gap"],
      createdAt: fixedTime,
      updatedAt: fixedTime,
      revision: "pending",
      sources: [],
      relations: [
        { targetId: sourcePageId, kind: "related-to", sourceIds: [] },
      ],
      body: "# Can the host research the web now?\n\nNo. The owner denied web research for this question.\n\n## Evidence needed\n\nAn approved web-research request.",
    };
    await applyCreatedPages(
      root,
      { kind: "query", id: denied.id },
      "op_e2e_host_denied_gap",
      [deniedGap],
    );
    const deniedFinished = await finishQuery(root, denied.id, {
      outcome: "unanswered",
      answerSummary: "The owner denied web research, so the gap remains open.",
    });
    expect(deniedFinished.session).toMatchObject({
      outcome: "unanswered",
      webApproval: { status: "denied" },
    });

    const approved = await beginQuery(
      root,
      "What approved web evidence exists?",
    );
    await expandQuery(root, approved.id, {
      tier: "sources",
      reason: "The local sources do not include this new evidence.",
    });
    await requestWebApproval(root, approved.id, {
      reason: "The current question needs external evidence.",
      hostSessionId: "e2e-host-contract",
    });
    await resolveWebApproval(root, approved.id, {
      approved: true,
      decidedBy: "brain-owner",
    });
    await expandQuery(root, approved.id, {
      tier: "web",
      reason: "The approved local-evidence gap remains unresolved.",
    });
    const captured = await captureWebEvidence(root, approved.id, {
      url: "https://example.test/host-contract",
      title: "Host contract evidence",
      captureKind: "snippet",
      content: "Captured web evidence is immutable before it supports a claim.",
      retrievedAt: fixedTime,
    });
    expect(captured.session).toMatchObject({
      currentTier: "web",
      webApproval: { status: "approved" },
      webEvidenceSourceIds: [captured.source.id],
    });

    const remote = await mkdtemp(path.join(tmpdir(), "brain-e2e-sync-remote-"));
    const branch = await git(root, ["branch", "--show-current"]);
    await git(remote, ["init", "--bare"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "-u", "origin", branch]);
    await configureSyncTarget(root, {
      remote: "origin",
      branch,
      confirm: true,
    });
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const pending = await beginQuery(root, "What remains safely committed?");
    const pendingFinished = await finishQuery(root, pending.id, {
      outcome: "answered",
      answerSummary:
        "The answer is locally durable while remote sync is pending.",
    });
    expect(pendingFinished.sync).toMatchObject({ status: "pending" });
    expect(
      formatSyncWarning(pendingFinished.sync ?? { status: "unconfigured" }),
    ).toMatch(
      /^⚠ Sync pending — knowledge is safely committed locally at [a-f0-9]{40}, but it has not yet been pushed to origin\//,
    );
  }, 60_000);
});
