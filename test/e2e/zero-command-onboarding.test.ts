import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, test } from "vitest";
import {
  applyChangeSetTransaction,
  attachSetupChange,
  attemptManagedSync,
  auditBrain,
  beginSetup,
  calculateCatalogRevision,
  configureSyncTarget,
  doctorBrain,
  finishSetup,
  initBrain,
  loadWikiPages,
  nextSemanticAuditBatch,
  nextSetupBatch,
  planReconciliation,
  readBrainItem,
  rebuildSearchIndex,
  recordSemanticAuditBatch,
  searchBrain,
  statusBrain,
  type BrainCharterResultV1,
  type BrainRuntimeServices,
  type BrainStatusV1,
  type InitBrainResultV1,
  type ReadReceiptV1,
  type SetupSourceContextV1,
  type SourceScanResult,
  type WikiPageV1,
} from "@second-brain/core";
import { runCli } from "../../packages/cli/src/program.js";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const fixedTime = "2026-08-29T12:00:00.000Z";
const temporaryRoots: string[] = [];
const runtimeServices: BrainRuntimeServices = {
  embeddings: {
    modelId: "test/zero-command-onboarding",
    modelRevision: "test-revision",
    async embed(texts) {
      return texts.map((text) =>
        /orbit|resonance|kepler|astronomy/iu.test(text) ? [1, 0] : [0, 1],
      );
    },
  },
};

interface InitCliResult {
  initialization: InitBrainResultV1;
  status: BrainStatusV1;
}

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

function isPristineTemplateSoftwarePath(relativePath: string): boolean {
  const [firstPathSegment] = relativePath.split("/");
  return ![
    ".brain",
    "BRAIN.md",
    "brain.config.yaml",
    "sources",
    "wiki",
  ].includes(firstPathSegment);
}

describe("pristine template tracked-file filtering", () => {
  test("excludes Git-style canonical paths when the host separator is Windows", () => {
    const originalSeparator = path.sep;
    Object.defineProperty(path, "sep", { value: "\\", configurable: true });
    try {
      expect(isPristineTemplateSoftwarePath(".brain/state.json")).toBe(false);
    } finally {
      Object.defineProperty(path, "sep", {
        value: originalSeparator,
        configurable: true,
      });
    }
  });
});

async function materializePristineTemplate(
  folderName: string,
  sourceRoot = repositoryRoot,
): Promise<{
  root: string;
  sandbox: string;
}> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "brain-onboarding-e2e-"));
  temporaryRoots.push(sandbox);
  const root = path.join(sandbox, folderName);
  const trackedFiles = (await git(sourceRoot, ["ls-files"]))
    .split("\n")
    .filter(isPristineTemplateSoftwarePath);
  for (const relativePath of trackedFiles) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(sourceRoot, relativePath), destination);
  }

  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Zero Command E2E"]);
  await git(root, ["config", "user.email", "onboarding@example.invalid"]);
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "--quiet", "-m", "initial template software"]);
  await initBrain(root, {
    name: "Portable Second Brain",
    description: "A self-maintaining personal knowledge base.",
  });
  return { root, sandbox };
}

async function configuredShallowDetachedHost(folderName: string): Promise<{
  root: string;
  sandbox: string;
}> {
  const { root: configuredRoot, sandbox } = await materializePristineTemplate(
    `${folderName}-configured`,
  );
  await runCliJson<InitCliResult>(["init", "--root", configuredRoot, "--json"]);

  const root = path.join(sandbox, `${folderName}-shallow-detached`);
  await git(sandbox, [
    "clone",
    "--quiet",
    "--depth",
    "1",
    `file://${configuredRoot}`,
    root,
  ]);
  await git(root, ["checkout", "--quiet", "--detach"]);
  return { root, sandbox };
}

async function runCliRaw(
  args: string[],
  services: BrainRuntimeServices = runtimeServices,
): Promise<{ exitCode: number; output: string }> {
  const output: string[] = [];
  const exitCode = await runCli(
    args,
    { write: (value) => output.push(value) },
    { runtimeServices: services },
  );
  return { exitCode, output: output.join("") };
}

async function runCliJson<T>(args: string[]): Promise<T> {
  const result = await runCliRaw(args);
  expect(result.exitCode, result.output).toBe(0);
  return JSON.parse(result.output) as T;
}

async function runInstalledBrainJson<T>(
  root: string,
  args: string[],
): Promise<T> {
  const command = await execFile(
    "pnpm",
    ["--silent", "brain", ...args, "--json"],
    { cwd: root },
  );
  expect(command.stderr).toBe("");
  return JSON.parse(command.stdout) as T;
}

async function addPdfAndDocxCorpus(root: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(
    "Keplerian orbits describe motion around a primary astronomical body.",
    { x: 40, y: 700, size: 12, font },
  );
  await writeFile(
    path.join(root, "sources", "kepler-orbits.pdf"),
    await pdf.save(),
  );

  const imageOnlyPdf = await PDFDocument.create();
  imageOnlyPdf.addPage();
  await writeFile(
    path.join(root, "sources", "scanned-observations.pdf"),
    await imageOnlyPdf.save(),
  );

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
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Orbital Resonance</w:t></w:r></w:p><w:p><w:r><w:t>Orbital resonance occurs when orbiting bodies exert regular gravitational influence on one another.</w:t></w:r></w:p></w:body></w:document>',
  );
  await writeFile(
    path.join(root, "sources", "orbital-resonance.docx"),
    await docx.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );

  await writeFile(
    path.join(root, "sources", "legacy-observations.doc"),
    "Legacy Word binary placeholder",
  );
}

function sourcePageId(sourceId: string): string {
  return `pg_source_${sourceId.slice(4, 16)}`;
}

function sourcePages(contexts: SetupSourceContextV1[]): WikiPageV1[] {
  return contexts.map((context) => {
    const chunk = context.extracted?.chunks[0];
    if (!chunk) throw new Error(`Expected ready source ${context.record.path}`);
    const related = contexts.filter(
      (candidate) => candidate.record.id !== context.record.id,
    );
    return {
      schema: 1,
      id: sourcePageId(context.record.id),
      path: `wiki/pages/sources/${context.record.id.slice(4, 16)}.md`,
      title: `Source: ${context.record.title}`,
      type: "source",
      status: "active",
      summary: `Cited shallow catalog page for ${context.record.title}.`,
      aliases: [],
      tags: ["initial-catalog"],
      createdAt: fixedTime,
      updatedAt: fixedTime,
      revision: "pending",
      sources: [{ id: context.record.id, locators: [chunk.locator] }],
      relations: related.map((candidate) => ({
        targetId: sourcePageId(candidate.record.id),
        kind: "related-to",
        sourceIds: [context.record.id],
      })),
      body: `# ${context.record.title}\n\n${chunk.text} [@${context.record.id}#${chunk.locator}]`,
    };
  });
}

async function applySetupPages(
  root: string,
  setupId: string,
  pages: WikiPageV1[],
): Promise<void> {
  const current = await loadWikiPages(root);
  const draft = {
    version: 1 as const,
    operationId: "op_zero_command_setup_pages",
    catalogRevision: calculateCatalogRevision(current),
    reason: "Build cited shallow pages for every ready onboarding source",
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
  const readReceipts: ReadReceiptV1[] = await Promise.all(
    plan.candidates.map(async (candidate) => {
      await readBrainItem(root, candidate.pageId);
      return {
        pageId: candidate.pageId,
        revision: candidate.revision,
        readAt: fixedTime,
      };
    }),
  );
  const result = await applyChangeSetTransaction(
    root,
    {
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
            ? "The new source catalog records a direct typed relationship."
            : "The current page was read and needs no source-backed change.",
        })),
      },
    },
    {
      context: { kind: "setup", id: setupId },
      runtimeServices,
    },
  );
  await attachSetupChange(root, setupId, result.operationId);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("zero-command onboarding fake host", () => {
  test("materializes a pristine fixture from a configured shallow detached host", async () => {
    const { root: hostRoot } = await configuredShallowDetachedHost(
      "second-brain-isolated-fixture",
    );
    expect((await statusBrain(hostRoot)).onboarding).toMatchObject({
      phase: "awaiting-sources",
      nextAction: "add-sources",
    });
    expect(await git(hostRoot, ["rev-parse", "--is-shallow-repository"])).toBe(
      "true",
    );
    expect(await git(hostRoot, ["branch", "--show-current"])).toBe("");

    const { root } = await materializePristineTemplate(
      "second-brain-isolated-fixture",
      hostRoot,
    );

    expect((await statusBrain(root)).onboarding).toMatchObject({
      phase: "needs-initialization",
      nextAction: "initialize",
    });
    expect(await git(root, ["rev-parse", "--is-shallow-repository"])).toBe(
      "false",
    );
    expect(await git(root, ["branch", "--show-current"])).toBe("main");

    const initialized = await runCliJson<InitCliResult>([
      "init",
      "--root",
      root,
      "--json",
    ]);
    expect(initialized.status.onboarding).toMatchObject({
      phase: "awaiting-sources",
      nextAction: "add-sources",
    });
    for (const canonicalPath of [
      "BRAIN.md",
      "brain.config.yaml",
      ".brain/source-manifest.json",
      ".brain/state.json",
      ".brain/operations.jsonl",
      "sources/.gitkeep",
      "wiki/home.md",
    ]) {
      await expect(
        access(path.join(root, canonicalPath)),
      ).resolves.toBeUndefined();
    }
  }, 30_000);

  test("runs the brain CLI after a locked install without prebuilt artifacts", async () => {
    const { root } = await materializePristineTemplate("second-brain-unbuilt");
    await expect(
      access(path.join(root, "packages", "core", "dist", "index.js")),
    ).rejects.toThrow();

    await execFile("pnpm", ["install", "--offline", "--frozen-lockfile"], {
      cwd: root,
    });
    const command = await execFile("pnpm", ["brain", "status"], {
      cwd: root,
    });

    expect(command.stdout).toContain("Onboarding: needs-initialization");
    await expect(
      access(path.join(root, "packages", "core", "dist", "index.js")),
    ).rejects.toThrow();
  }, 30_000);

  test("resumes pre-semantic onboarding across installed CLI processes", async () => {
    const { root } = await materializePristineTemplate(
      "second-brain-process-resume",
    );
    await execFile("pnpm", ["install", "--offline", "--frozen-lockfile"], {
      cwd: root,
    });

    expect(
      (await runInstalledBrainJson<BrainStatusV1>(root, ["status"])).onboarding,
    ).toMatchObject({
      phase: "needs-initialization",
      nextAction: "initialize",
    });

    const initialized = await runInstalledBrainJson<InitCliResult>(root, [
      "init",
    ]);
    expect(initialized.status).toMatchObject({
      support: {
        issueTrackerUrl:
          "https://github.com/ranjanrishikesh/second-brain/issues",
      },
      onboarding: {
        phase: "awaiting-sources",
        nextAction: "add-sources",
      },
    });
    expect(initialized.initialization).toMatchObject({
      name: "Second Brain Process Resume",
    });

    await addPdfAndDocxCorpus(root);
    expect(
      (await runInstalledBrainJson<BrainStatusV1>(root, ["status"])).onboarding,
    ).toMatchObject({
      phase: "sources-unregistered",
      nextAction: "scan-sources",
    });

    const scan = await runInstalledBrainJson<SourceScanResult>(root, [
      "source",
      "scan",
    ]);
    expect(
      scan.added.filter((source) => source.extractionStatus === "ready"),
    ).toHaveLength(2);
    expect(
      (await runInstalledBrainJson<BrainStatusV1>(root, ["status"])).onboarding,
    ).toMatchObject({
      phase: "awaiting-charter",
      nextAction: "set-charter",
    });

    const charterFile = path.join(root, ".brain", "runtime", "charter.json");
    await writeFile(
      charterFile,
      `${JSON.stringify({
        version: 1,
        description: "Astronomy evidence about orbits and resonance.",
        purpose: "Answer source-backed astronomy questions.",
        boundaries: ["Include all registered source material."],
        domainConventions: ["Preserve astronomical terminology."],
        evidencePreferences: ["Prefer explicit stable source locators."],
        origin: "inferred",
      })}\n`,
    );
    await runInstalledBrainJson<BrainCharterResultV1>(root, [
      "charter",
      "set",
      charterFile,
    ]);
    expect(
      (await runInstalledBrainJson<BrainStatusV1>(root, ["status"])).onboarding,
    ).toMatchObject({
      phase: "ready-for-setup",
      nextAction: "begin-setup",
    });
  }, 120_000);

  test("resumes a cloned brain from empty identity through cited ready state and safe sync", async () => {
    const { root, sandbox } =
      await materializePristineTemplate("second-brain-smoke");
    const remote = path.join(sandbox, "confirmed.git");
    await git(sandbox, ["init", "--bare", remote]);
    await git(root, ["remote", "add", "origin", remote]);
    const branch = await git(root, ["branch", "--show-current"]);
    await git(root, ["push", "-u", "origin", `${branch}:${branch}`]);

    expect((await statusBrain(root)).onboarding).toMatchObject({
      phase: "needs-initialization",
      nextAction: "initialize",
    });

    const unconfirmed = await runCliRaw([
      "sync",
      "--root",
      root,
      "configure",
      "--remote",
      "origin",
      "--branch",
      branch,
    ]);
    expect(unconfirmed.exitCode).not.toBe(0);
    expect(unconfirmed.output).toMatch(/confirm/i);
    await configureSyncTarget(root, {
      remote: "origin",
      branch,
      confirm: true,
    });

    const initialized = await runCliJson<InitCliResult>([
      "init",
      "--root",
      root,
      "--json",
    ]);
    expect(initialized).toMatchObject({
      initialization: {
        mode: "template-replaced",
        name: "Second Brain Smoke",
      },
      status: {
        onboarding: {
          phase: "awaiting-sources",
          nextAction: "add-sources",
        },
        setup: { status: "not-started" },
      },
    });
    const firstIdentityHead = await git(root, ["rev-parse", "HEAD"]);
    const repeated = await runCliJson<InitCliResult>([
      "init",
      "--root",
      root,
      "--json",
    ]);
    expect(repeated.initialization.mode).toBe("existing");
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(firstIdentityHead);

    await writeFile(
      path.join(root, "owner-draft.txt"),
      "This unrelated owner draft must remain untouched.\n",
    );
    await addPdfAndDocxCorpus(root);

    const resumedWithFiles = await runCliJson<BrainStatusV1>([
      "status",
      "--root",
      root,
      "--json",
    ]);
    expect(resumedWithFiles.onboarding).toMatchObject({
      phase: "sources-unregistered",
      nextAction: "scan-sources",
      sourceFiles: {
        discovered: 4,
        supportedCandidates: 3,
        unsupportedCandidates: 1,
      },
    });

    const scan = await runCliJson<SourceScanResult>([
      "source",
      "scan",
      "--root",
      root,
      "--json",
    ]);
    expect(scan.added).toHaveLength(4);
    expect(
      scan.added.filter((source) => source.extractionStatus === "ready"),
    ).toHaveLength(2);
    expect(
      scan.added.find((source) =>
        source.path.endsWith("scanned-observations.pdf"),
      )?.extractionStatus,
    ).toBe("extraction-required");
    expect(
      scan.added.find((source) =>
        source.path.endsWith("legacy-observations.doc"),
      )?.extractionStatus,
    ).toBe("unsupported");
    expect((await statusBrain(root)).onboarding).toMatchObject({
      phase: "awaiting-charter",
      nextAction: "set-charter",
    });

    const charterFile = path.join(root, ".brain", "runtime", "charter.json");
    await mkdir(path.dirname(charterFile), { recursive: true });
    await writeFile(
      charterFile,
      `${JSON.stringify(
        {
          version: 1,
          description:
            "Astronomy sources covering Keplerian orbits, orbital resonance, and retained observations.",
          purpose:
            "Answer source-backed astronomy and orbital-mechanics questions.",
          boundaries: [
            "Include every registered astronomy source and report unusable scanned or legacy files.",
          ],
          domainConventions: [
            "Preserve standard astronomy and orbital-mechanics terminology.",
          ],
          evidencePreferences: [
            "Prefer extracted primary material and explicit stable locators.",
          ],
          origin: "inferred",
        },
        null,
        2,
      )}\n`,
    );
    const charter = await runCliJson<BrainCharterResultV1>([
      "charter",
      "set",
      charterFile,
      "--root",
      root,
      "--json",
    ]);
    expect(charter.charter.origin).toBe("inferred");
    expect((await statusBrain(root)).onboarding).toMatchObject({
      phase: "ready-for-setup",
      nextAction: "begin-setup",
    });

    const setup = await beginSetup(
      root,
      {
        purpose: charter.charter.purpose,
        boundaries: charter.charter.boundaries.join(" "),
      },
      runtimeServices,
    );
    expect((await statusBrain(root)).onboarding).toMatchObject({
      phase: "setup-in-progress",
      nextAction: "resume-setup",
    });
    const batch = await nextSetupBatch(root, setup.id);
    expect(batch.sources).toHaveLength(2);
    await applySetupPages(root, setup.id, sourcePages(batch.sources));
    expect((await statusBrain(root)).onboarding.nextAction).toBe(
      "resume-setup",
    );
    expect((await nextSetupBatch(root, setup.id)).sources).toEqual([]);

    while (true) {
      const audit = await nextSemanticAuditBatch(root);
      if (audit.pageIds.length === 0) break;
      const recorded = await recordSemanticAuditBatch(root, {
        pageIds: audit.pageIds,
        summary:
          "Reviewed every cited shallow source page and its onboarding relationship.",
      });
      if (recorded.complete) break;
    }
    await finishSetup(root, setup.id, {
      summary:
        "Every ready source has a cited shallow page and the initial map is complete.",
    });

    const pages = await loadWikiPages(root);
    const readyIds = new Set(
      scan.added
        .filter((source) => source.extractionStatus === "ready")
        .map((source) => source.id),
    );
    const sourceCatalog = pages.filter((page) => page.type === "source");
    expect(sourceCatalog).toHaveLength(readyIds.size);
    for (const sourceId of readyIds) {
      const page = sourceCatalog.find((candidate) =>
        candidate.sources.some((source) => source.id === sourceId),
      );
      expect(page?.body).toContain(`[@${sourceId}#`);
      expect(page?.relations.length).toBeGreaterThan(0);
    }
    const map = await readFile(path.join(root, "wiki", "map.md"), "utf8");
    expect(map).toContain("related-to");
    expect(map).toContain("kepler-orbits");
    expect(map).toContain("Orbital Resonance");

    await rebuildSearchIndex(root);
    const smokeSearch = await searchBrain(root, {
      query: "orbital resonance",
      scope: "all",
    });
    expect(smokeSearch.length).toBeGreaterThan(0);
    expect(
      smokeSearch.some((result) =>
        /orbital-resonance|orbital resonance/iu.test(
          `${result.path} ${result.snippet}`,
        ),
      ),
    ).toBe(true);

    const finalAudit = await auditBrain(root);
    expect(finalAudit.structural.ok).toBe(true);
    expect(finalAudit.semantic).toMatchObject({ complete: true, pageIds: [] });
    const doctor = await doctorBrain(root);
    expect(doctor.ok).toBe(true);
    expect(doctor.issues.filter((issue) => issue.severity === "error")).toEqual(
      [],
    );
    const finalStatus = await statusBrain(root);
    expect(finalStatus).toMatchObject({
      onboarding: { phase: "ready", nextAction: "ask-question" },
      setup: { status: "completed", pendingSourceIds: [] },
      sources: {
        total: 4,
        ready: 2,
        unsupported: 1,
        extractionRequired: 1,
      },
      sync: { status: "synced", remote: "origin", branch },
    });
    expect(await readFile(path.join(root, "owner-draft.txt"), "utf8")).toBe(
      "This unrelated owner draft must remain untouched.\n",
    );
    expect(
      await git(root, ["status", "--short", "--", "owner-draft.txt"]),
    ).toBe("?? owner-draft.txt");

    const localLog = await git(root, ["log", "--format=%s"]);
    for (const subject of [
      "brain(identity):",
      "brain(source):",
      "brain(charter):",
      "brain(setup):",
      "brain(audit):",
    ]) {
      expect(localLog).toContain(subject);
    }
    const remoteHead = await git(remote, ["rev-parse", `refs/heads/${branch}`]);
    expect(remoteHead).toBe(await git(root, ["rev-parse", "HEAD"]));
    const remoteLog = await git(remote, [
      "log",
      "--format=%s",
      `refs/heads/${branch}`,
    ]);
    expect(remoteLog).toContain("brain(identity):");
    expect(remoteLog).toContain("brain(charter):");

    const mismatched = path.join(sandbox, "mismatched.git");
    await git(sandbox, ["init", "--bare", mismatched]);
    await git(root, ["config", "remote.origin.pushurl", mismatched]);
    await expect(attemptManagedSync(root)).resolves.toMatchObject({
      status: "manual-sync-required",
      remote: "origin",
      branch,
    });
    await expect(
      git(mismatched, ["rev-parse", `refs/heads/${branch}`]),
    ).rejects.toThrow();
  }, 90_000);

  test("pre-added sources skip the empty-source pause", async () => {
    const { root } = await materializePristineTemplate(
      "second-brain-preloaded",
    );
    await writeFile(
      path.join(root, "sources", "preloaded.md"),
      "# Preloaded evidence\n\nA source was added before onboarding began.\n",
    );

    const initialized = await runCliJson<InitCliResult>([
      "init",
      "--root",
      root,
      "--json",
    ]);

    expect(initialized.initialization.name).toBe("Second Brain Preloaded");
    expect(initialized.status.onboarding).toMatchObject({
      phase: "sources-unregistered",
      nextAction: "scan-sources",
      sourceFiles: { discovered: 1, supportedCandidates: 1 },
    });
  });
});
