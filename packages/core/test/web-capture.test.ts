import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import {
  beginQuery,
  captureWebEvidence,
  expandQuery,
  initBrain,
  readBrainState,
  readQuerySession,
  recoverBrain,
  requestWebApproval,
  resolveWebApproval,
  scanAndRegisterSources,
  writeBrainState,
  writeQuerySession,
} from "../src/index.js";
import { runCanonicalWrite } from "../src/transaction.js";

const execFile = promisify(execFileCallback);
const encoder = new TextEncoder();

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function webFiles(root: string): Promise<string[]> {
  const base = path.join(root, "sources", "web");
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      if (entry.isFile())
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await walk(base);
  return files.sort();
}

async function approvedBrain(question = "What does the web evidence show?") {
  const root = await mkdtemp(path.join(tmpdir(), "brain-web-capture-"));
  await initBrain(root, { name: "Web capture", description: "Capture tests" });
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  const state = await readBrainState(root);
  await writeBrainState(root, {
    ...state,
    setup: {
      status: "completed",
      id: "setup_0123456789abcdef0123456789abcdef",
      purpose: "Web evidence",
      startedAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:00:00.000Z",
      initialSourceIds: [],
      pendingSourceIds: [],
    },
  });
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Capture Test"]);
  await git(root, ["config", "user.email", "capture@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial brain"]);
  const session = await beginQuery(root, question);
  await expandQuery(root, session.id, {
    tier: "sources",
    reason: "The wiki does not contain the evidence.",
  });
  await requestWebApproval(root, session.id, {
    reason: "Local sources do not answer the question.",
    hostSessionId: "fake-host",
  });
  await resolveWebApproval(root, session.id, {
    approved: true,
    decidedBy: "owner",
  });
  await expandQuery(root, session.id, {
    tier: "web",
    reason: "Approved web evidence is required.",
  });
  return { root, queryId: session.id, question };
}

async function textPdf(text = "Durable orbital evidence"): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 40, y: 700, size: 12, font });
  return await document.save();
}

async function docxBytes(): Promise<Uint8Array> {
  const archive = new JSZip();
  archive.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  archive.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  archive.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  archive.file(
    "word/styles.xml",
    '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
  );
  archive.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Web document</w:t></w:r></w:p><w:p><w:r><w:t>Exact DOCX evidence.</w:t></w:r></w:p></w:body></w:document>',
  );
  return await archive.generateAsync({ type: "uint8array" });
}

async function epubBytes(
  chapter = "<h1>Evidence</h1><p>Exact EPUB evidence.</p>",
): Promise<Uint8Array> {
  const archive = new JSZip();
  archive.file("mimetype", "application/epub+zip");
  archive.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  );
  archive.file(
    "OEBPS/content.opf",
    '<?xml version="1.0"?><package><metadata><title>Web book</title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
  );
  archive.file("OEBPS/chapter.xhtml", `<html><body>${chapter}</body></html>`);
  return await archive.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
}

describe("durable web evidence capture", () => {
  test("serializes concurrent alternate-URL artifact capture into one canonical pair", async () => {
    const { root, queryId } = await approvedBrain();
    const bytes = await textPdf("Concurrent mirror evidence");
    let enteredWriter: (() => void) | undefined;
    const writerEntered = new Promise<void>((resolve) => {
      enteredWriter = resolve;
    });
    let releaseWriter: (() => void) | undefined;
    const writerReleased = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const first = captureWebEvidence(
      root,
      queryId,
      {
        representation: "artifact",
        originalUrl: "https://a.example.test/concurrent.pdf",
        title: "Concurrent primary",
        fileName: "primary.pdf",
        responseComplete: true,
        content: bytes,
        retrievedAt: "2026-08-30T00:10:00.000Z",
      },
      {
        transactionTestOptions: {
          afterMutationBeforeSeal: async () => {
            enteredWriter?.();
            await writerReleased;
          },
        },
      },
    );
    await writerEntered;
    const second = captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl: "https://b.example.test/concurrent.pdf",
      title: "Concurrent mirror",
      fileName: "mirror.pdf",
      responseComplete: true,
      content: bytes,
      retrievedAt: "2026-08-30T00:11:00.000Z",
    });
    releaseWriter?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.source.id).toBe(secondResult.source.id);
    const captures = await webFiles(root);
    expect(captures.filter((item) => !item.endsWith(".web.json"))).toHaveLength(
      1,
    );
    expect(captures.filter((item) => item.endsWith(".web.json"))).toHaveLength(
      1,
    );
    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    );
    expect(manifest.sources).toHaveLength(1);
    expect(
      manifest.sources[0].provenance.webDiscoveries.map(
        (item: { originalUrl: string }) => item.originalUrl,
      ),
    ).toEqual([
      "https://a.example.test/concurrent.pdf",
      "https://b.example.test/concurrent.pdf",
    ]);
    expect((await readBrainState(root)).sourceDuplicates).toEqual([]);
  });

  test("serializes concurrent changed bytes into one linear supersession chain", async () => {
    const { root, queryId } = await approvedBrain();
    const originalUrl = "https://example.test/serial-report.txt";
    const base = await captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl,
      title: "Serial base",
      fileName: "serial.txt",
      responseComplete: true,
      content: encoder.encode("base version\n"),
      retrievedAt: "2026-08-30T00:20:00.000Z",
    });
    let enteredWriter: (() => void) | undefined;
    const writerEntered = new Promise<void>((resolve) => {
      enteredWriter = resolve;
    });
    let releaseWriter: (() => void) | undefined;
    const writerReleased = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const first = captureWebEvidence(
      root,
      queryId,
      {
        representation: "artifact",
        originalUrl,
        title: "Serial middle",
        fileName: "serial.txt",
        responseComplete: true,
        content: encoder.encode("middle version\n"),
        retrievedAt: "2026-08-30T00:21:00.000Z",
      },
      {
        transactionTestOptions: {
          afterMutationBeforeSeal: async () => {
            enteredWriter?.();
            await writerReleased;
          },
        },
      },
    );
    await writerEntered;
    const second = captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl,
      title: "Serial newest",
      fileName: "serial.txt",
      responseComplete: true,
      content: encoder.encode("newest version\n"),
      retrievedAt: "2026-08-30T00:22:00.000Z",
    });
    releaseWriter?.();

    const [middle, newest] = await Promise.all([first, second]);
    expect(middle.source.supersedes).toBe(base.source.id);
    expect(newest.source.supersedes).toBe(middle.source.id);
    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    );
    expect(manifest.sources).toHaveLength(3);
    expect((await readBrainState(root)).sourceDuplicates).toEqual([]);
    expect(
      (await webFiles(root)).filter((item) => !item.endsWith(".web.json")),
    ).toHaveLength(3);
  });

  test.each([
    ["artifact", "finished"],
    ["text", "approval-removed"],
  ] as const)(
    "revalidates %s capture lifecycle after waiting when the query is %s",
    async (representation, lifecycleChange) => {
      const { root, queryId } = await approvedBrain(
        `Fresh ${representation} lifecycle?`,
      );
      let writerEntered!: () => void;
      const writerHeld = new Promise<void>((resolve) => {
        writerEntered = resolve;
      });
      let releaseWriter!: () => void;
      const writerReleased = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      const blocker = runCanonicalWrite(
        root,
        {
          operationId: `op_test_${representation}_lifecycle_blocker`,
          commitMessage: "test: hold canonical writer",
          testOptions: {
            afterMutationBeforeSeal: async () => {
              writerEntered();
              await writerReleased;
            },
          },
        },
        async () => ({ value: null, stagePaths: [] }),
      );
      await writerHeld;
      const manifestBefore = await readFile(
        path.join(root, ".brain", "source-manifest.json"),
        "utf8",
      );
      const operationsBefore = await readFile(
        path.join(root, ".brain", "operations.jsonl"),
        "utf8",
      );
      const headBefore = await git(root, ["rev-parse", "HEAD"]);
      let initialValidationReached!: () => void;
      const initialValidation = new Promise<void>((resolve) => {
        initialValidationReached = resolve;
      });
      const captureWithBarrier = captureWebEvidence as unknown as (
        root: string,
        queryId: string,
        input: Parameters<typeof captureWebEvidence>[2],
        options: {
          beforeWriterWait: () => void;
        },
      ) => ReturnType<typeof captureWebEvidence>;
      const input =
        representation === "artifact"
          ? {
              representation: "artifact" as const,
              originalUrl: "https://example.test/fresh-lifecycle.txt",
              title: "Fresh artifact lifecycle",
              fileName: "fresh.txt",
              responseComplete: true as const,
              content: encoder.encode("must not be captured\n"),
              retrievedAt: "2026-08-30T11:00:00.000Z",
            }
          : {
              representation: "text" as const,
              originalUrl: "https://example.test/fresh-lifecycle",
              title: "Fresh text lifecycle",
              captureKind: "page" as const,
              completeness: "complete" as const,
              content: "must not be captured",
              retrievedAt: "2026-08-30T11:00:00.000Z",
            };
      const pendingCapture = captureWithBarrier(root, queryId, input, {
        beforeWriterWait: initialValidationReached,
      }).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      const barrierObserved = await Promise.race([
        initialValidation.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      const session = await readQuerySession(root, queryId);
      if (lifecycleChange === "finished") {
        await writeQuerySession(root, {
          ...session,
          status: "finished",
          completedAt: "2026-08-30T11:00:01.000Z",
          outcome: "unanswered",
          answerSummary: "The query ended before capture.",
        });
      } else {
        const { webApproval: _removedApproval, ...withoutApproval } = session;
        await writeQuerySession(root, withoutApproval);
      }
      releaseWriter();
      await blocker;
      const outcome = await pendingCapture;

      expect(outcome.value).toBeUndefined();
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toMatch(/open query|approval/i);
      await expect(recoverBrain(root)).resolves.toBe("clean");
      expect(await webFiles(root)).toEqual([]);
      expect(
        await readFile(
          path.join(root, ".brain", "source-manifest.json"),
          "utf8",
        ),
      ).toBe(manifestBefore);
      expect(
        await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8"),
      ).toBe(operationsBefore);
      expect(await git(root, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(barrierObserved).toBe(true);
    },
  );

  test("atomically merges concurrent evidence links for one query", async () => {
    const { root, queryId } = await approvedBrain("Concurrent links?");
    let arrivals = 0;
    let firstSessionRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      firstSessionRead = resolve;
    });
    let releaseWrites!: () => void;
    const writesReleased = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const options = {
      afterSessionRead: async () => {
        arrivals += 1;
        if (arrivals === 1) {
          firstSessionRead();
          await writesReleased;
        }
      },
    };

    const first = captureWebEvidence(
      root,
      queryId,
      {
        representation: "artifact",
        originalUrl: "https://example.test/link-a.txt",
        title: "Link A",
        fileName: "link-a.txt",
        responseComplete: true,
        content: encoder.encode("evidence a\n"),
        retrievedAt: "2026-08-30T00:23:00.000Z",
      },
      options,
    );
    await firstRead;
    const second = captureWebEvidence(
      root,
      queryId,
      {
        representation: "artifact",
        originalUrl: "https://example.test/link-b.txt",
        title: "Link B",
        fileName: "link-b.txt",
        responseComplete: true,
        content: encoder.encode("evidence b\n"),
        retrievedAt: "2026-08-30T00:24:00.000Z",
      },
      options,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(arrivals).toBe(1);
    releaseWrites();
    const captures = await Promise.all([first, second]);

    const session = await readQuerySession(root, queryId);
    expect(session.webEvidenceSourceIds).toEqual(
      captures.map((capture) => capture.source.id).sort(),
    );
    expect(new Set(session.webEvidenceSourceIds).size).toBe(2);
    expect(
      (await readdir(path.join(root, ".brain", "runtime", "queries"))).filter(
        (entry) => entry.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  test("does not link evidence from a rolled-back canonical mutation", async () => {
    const { root, queryId } = await approvedBrain("Rolled back link?");
    await expect(
      captureWebEvidence(
        root,
        queryId,
        {
          representation: "artifact",
          originalUrl: "https://example.test/rolled-back.txt",
          title: "Rolled back",
          fileName: "rolled-back.txt",
          responseComplete: true,
          content: encoder.encode("must not link\n"),
          retrievedAt: "2026-08-30T00:25:00.000Z",
        },
        {
          transactionTestOptions: {
            simulateCrashAfter: "files-applied",
          },
        },
      ),
    ).rejects.toThrow(/simulated.*crash/i);
    expect(
      (await readQuerySession(root, queryId)).webEvidenceSourceIds,
    ).toEqual([]);
  });

  test("rejects approval and lifecycle failures before preparing sources/web", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-gate-"));
    await initBrain(root, { name: "Gate", description: "Gate test" });
    const session = await beginQuery(root, "What is gated?");
    await expect(
      captureWebEvidence(root, session.id, {
        representation: "text",
        originalUrl: "https://example.test/gated",
        title: "Gated",
        captureKind: "page",
        completeness: "complete",
        content: "Never prepared.",
      }),
    ).rejects.toThrow(/web tier/i);
    expect(await webFiles(root)).toEqual([]);

    await expandQuery(root, session.id, {
      tier: "sources",
      reason: "No local evidence.",
    });
    const current = await readQuerySession(root, session.id);
    current.currentTier = "web";
    current.tiersUsed.push("web");
    await writeFile(
      path.join(root, ".brain", "runtime", "queries", `${session.id}.json`),
      `${JSON.stringify(current, null, 2)}\n`,
    );
    await expect(
      captureWebEvidence(root, session.id, {
        representation: "text",
        originalUrl: "https://example.test/gated",
        title: "Gated",
        captureKind: "page",
        completeness: "complete",
        content: "Never prepared.",
      }),
    ).rejects.toThrow(/approval/i);
    expect(await webFiles(root)).toEqual([]);
  });

  test("rejects artifact preparation through a sources/web symlink without writing outside the brain", async () => {
    const { root, queryId } = await approvedBrain("Contained artifact?");
    const outside = await mkdtemp(path.join(tmpdir(), "brain-web-outside-"));
    await symlink(outside, path.join(root, "sources", "web"), "dir");

    try {
      await expect(
        captureWebEvidence(root, queryId, {
          representation: "artifact",
          originalUrl: "https://example.test/contained-artifact.txt",
          title: "Contained artifact",
          fileName: "contained-artifact.txt",
          responseComplete: true,
          content: encoder.encode("must stay inside the brain\n"),
          retrievedAt: "2026-08-30T00:40:00.000Z",
        }),
      ).rejects.toThrow(/path|source|symlink|contain|safe/i);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("revalidates text preparation after sources/web is swapped to an outside symlink", async () => {
    const { root, queryId } = await approvedBrain("Contained text?");
    const outside = await mkdtemp(path.join(tmpdir(), "brain-web-outside-"));
    const webPath = path.join(root, "sources", "web");
    await mkdir(webPath);

    try {
      await expect(
        captureWebEvidence(
          root,
          queryId,
          {
            representation: "text",
            originalUrl: "https://example.test/contained-text",
            title: "Contained text",
            captureKind: "page",
            completeness: "complete",
            content: "must stay inside the brain",
            retrievedAt: "2026-08-30T00:41:00.000Z",
          },
          {
            beforePreparationCreate: async () => {
              await rename(
                webPath,
                path.join(root, "sources", "web-before-swap"),
              );
              await symlink(outside, webPath, "dir");
            },
          },
        ),
      ).rejects.toThrow(/path|source|symlink|contain|safe/i);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects an oversized prepared artifact before reading its bytes", async () => {
    const { root, queryId } = await approvedBrain("Bound artifact retry?");
    const content = encoder.encode("expected artifact\n");
    const sourcePath = `sources/web/2026/08/bound-artifact-${sha256(content).slice(0, 12)}.txt`;
    await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
    await writeFile(
      path.join(root, sourcePath),
      Buffer.alloc(128 * 1024, 0x61),
    );
    const readProgress: Array<{ path: string; bytes: number }> = [];

    await expect(
      captureWebEvidence(
        root,
        queryId,
        {
          representation: "artifact",
          originalUrl: "https://example.test/bound-artifact.txt",
          title: "Bound artifact",
          fileName: "bound-artifact.txt",
          responseComplete: true,
          content,
          retrievedAt: "2026-08-30T00:42:00.000Z",
        },
        {
          afterPreparedReadProgress(relativePath, bytesRead) {
            readProgress.push({ path: relativePath, bytes: bytesRead });
          },
        },
      ),
    ).rejects.toThrow(/prepared web capture exceeds requested byte length/i);
    expect(readProgress).toEqual([{ path: sourcePath, bytes: 0 }]);
  });

  test("rejects oversized prepared text before reading its bytes", async () => {
    const { root, queryId } = await approvedBrain("Bound text retry?");
    const originalUrl = "https://example.test/bound-text";
    const body = "expected text";
    const logicalDigest = sha256(
      JSON.stringify([originalUrl, originalUrl, [], "page", "complete", body]),
    );
    const sourcePath = `sources/web/2026/08/bound-text-${logicalDigest.slice(0, 12)}.md`;
    await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
    await writeFile(
      path.join(root, sourcePath),
      Buffer.alloc(128 * 1024, 0x62),
    );
    const readProgress: Array<{ path: string; bytes: number }> = [];

    await expect(
      captureWebEvidence(
        root,
        queryId,
        {
          representation: "text",
          originalUrl,
          title: "Bound text",
          captureKind: "page",
          completeness: "complete",
          content: body,
          retrievedAt: "2026-08-30T00:42:00.000Z",
        },
        {
          afterPreparedReadProgress(relativePath, bytesRead) {
            readProgress.push({ path: relativePath, bytes: bytesRead });
          },
        },
      ),
    ).rejects.toThrow(/prepared web capture exceeds requested byte length/i);
    expect(readProgress).toEqual([{ path: sourcePath, bytes: 0 }]);
  });

  test("keeps legacy text calls and preserves body bytes except line endings", async () => {
    const { root, queryId } = await approvedBrain();
    const body = "  leading\r\ninternal  spacing\rtail  ";
    const result = await captureWebEvidence(root, queryId, {
      url: "https://example.test/legacy",
      title: "Legacy page",
      captureKind: "page",
      content: body,
      retrievedAt: "2026-08-30T01:00:00.000Z",
    });
    const markdown = await readFile(
      path.join(root, result.source.path),
      "utf8",
    );
    expect(markdown).toContain(
      "\n---\n\n# Legacy page\n\n  leading\ninternal  spacing\ntail  \n",
    );
    expect(result.source.provenance).toMatchObject({
      representation: "text",
      completeness: "complete",
      captureKind: "page",
    });
  });

  test("distinguishes complete pages from partial pages and snippets when reusing", async () => {
    const { root, queryId } = await approvedBrain();
    const shared = {
      representation: "text" as const,
      originalUrl: "https://example.test/shared",
      title: "Shared",
      content: "The same accessible body.",
      retrievedAt: "2026-08-30T02:00:00.000Z",
    };
    const completePage = await captureWebEvidence(root, queryId, {
      ...shared,
      captureKind: "page",
      completeness: "complete",
    });
    const reused = await captureWebEvidence(root, queryId, {
      ...shared,
      title: "Different title",
      retrievedAt: "2026-08-30T02:01:00.000Z",
      captureKind: "page",
      completeness: "complete",
    });
    const partialPage = await captureWebEvidence(root, queryId, {
      ...shared,
      retrievedAt: "2026-08-30T02:02:00.000Z",
      captureKind: "page",
      completeness: "partial",
    });
    const snippet = await captureWebEvidence(root, queryId, {
      ...shared,
      retrievedAt: "2026-08-30T02:03:00.000Z",
      captureKind: "snippet",
      completeness: "partial",
    });
    expect(reused).toMatchObject({
      created: false,
      source: { id: completePage.source.id },
    });
    expect(
      new Set([
        completePage.source.id,
        partialPage.source.id,
        snippet.source.id,
      ]).size,
    ).toBe(3);
    await expect(
      captureWebEvidence(root, queryId, {
        ...shared,
        captureKind: "snippet",
        completeness: "complete",
      }),
    ).rejects.toThrow(/snippet|partial/i);
  });

  test.each([
    ["csv", "tsv"],
    ["tsv", "csv"],
  ] as const)(
    "rejects identical bytes registered as %s when requested as %s",
    async (firstFormat, secondFormat) => {
      const { root, queryId } = await approvedBrain(
        `${firstFormat} versus ${secondFormat}?`,
      );
      const bytes = encoder.encode("name,value\nalpha,1\n");
      await captureWebEvidence(root, queryId, {
        representation: "artifact",
        originalUrl: `https://example.test/table.${firstFormat}`,
        title: `Table ${firstFormat}`,
        fileName: `table.${firstFormat}`,
        responseComplete: true,
        content: bytes,
        retrievedAt: "2026-08-30T02:10:00.000Z",
      });

      await expect(
        captureWebEvidence(root, queryId, {
          representation: "artifact",
          originalUrl: `https://example.test/table.${secondFormat}`,
          title: `Table ${secondFormat}`,
          fileName: `table.${secondFormat}`,
          responseComplete: true,
          content: bytes,
          retrievedAt: "2026-08-30T02:11:00.000Z",
        }),
      ).rejects.toThrow(/compatible|format|csv|tsv/i);
      expect(
        JSON.parse(
          await readFile(
            path.join(root, ".brain", "source-manifest.json"),
            "utf8",
          ),
        ).sources,
      ).toHaveLength(1);
    },
  );

  test("validates the final Markdown wrapper against maxFileBytes", async () => {
    const { root, queryId } = await approvedBrain();
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 300;
    await writeFile(configPath, stringify(config));
    await expect(
      captureWebEvidence(root, queryId, {
        representation: "text",
        originalUrl: "https://example.test/wrapper",
        title: "Wrapper",
        captureKind: "page",
        completeness: "complete",
        content: "x".repeat(250),
        retrievedAt: "2026-08-30T03:00:00.000Z",
      }),
    ).rejects.toThrow(/maximum|bytes|size/i);
    expect(await webFiles(root)).toEqual([]);
  });

  test("rejects an EPUB amplification before preparing canonical artifacts", async () => {
    const { root, queryId } = await approvedBrain("EPUB amplification?");
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.epub = {
      maxEntries: 100,
      maxExpandedBytes: 4_096,
      maxExtractedBytes: 4_096,
    };
    await writeFile(configPath, stringify(config));
    const bytes = await epubBytes(`<p>${"A".repeat(50_000)}</p>`);
    expect(bytes.byteLength).toBeLessThan(4_096);

    await expect(
      captureWebEvidence(root, queryId, {
        representation: "artifact",
        originalUrl: "https://example.test/amplified.epub",
        title: "Amplified EPUB",
        fileName: "amplified.epub",
        responseComplete: true,
        content: bytes,
        retrievedAt: "2026-08-30T03:01:00.000Z",
      }),
    ).rejects.toThrow(/expanded epub content exceeds.*4096 bytes/i);
    expect(await webFiles(root)).toEqual([]);
  });

  test("rejects an over-page PDF before preparing canonical artifacts", async () => {
    const { root, queryId } = await approvedBrain("PDF amplification?");
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.pdf = { maxPages: 2, maxExtractedBytes: 1_000_000 };
    await writeFile(configPath, stringify(config));
    const document = await PDFDocument.create();
    document.addPage();
    document.addPage();
    document.addPage();

    await expect(
      captureWebEvidence(root, queryId, {
        representation: "artifact",
        originalUrl: "https://example.test/too-many-pages.pdf",
        title: "Too many pages",
        fileName: "too-many-pages.pdf",
        responseComplete: true,
        content: await document.save(),
        retrievedAt: "2026-08-30T03:02:00.000Z",
      }),
    ).rejects.toThrow(/pdf contains 3 pages.*maximum of 2/i);
    expect(await webFiles(root)).toEqual([]);
  });

  test.each([
    [
      "unsafe URL",
      {
        fileName: "report.txt",
        originalUrl: "http://127.0.0.1/report",
        content: encoder.encode("text"),
      },
    ],
    [
      "HTTPS downgrade",
      {
        fileName: "report.txt",
        originalUrl: "https://example.test/report",
        finalUrl: "http://example.test/report",
        content: encoder.encode("text"),
      },
    ],
    [
      "traversal name",
      { fileName: "../report.pdf", content: encoder.encode("%PDF-1.7\n") },
    ],
    [
      "malformed UTF-8",
      { fileName: "report.txt", content: Uint8Array.from([0xc3, 0x28]) },
    ],
    [
      "malformed JSON",
      { fileName: "report.json", content: encoder.encode("{") },
    ],
    [
      "media conflict",
      {
        fileName: "report.pdf",
        declaredMediaType: "text/plain",
        content: encoder.encode("%PDF-1.7\n"),
      },
    ],
    [
      "format spoof",
      { fileName: "report.pdf", content: encoder.encode("not pdf") },
    ],
    [
      "HTML artifact",
      { fileName: "report.html", content: encoder.encode("<p>page</p>") },
    ],
    [
      "image",
      { fileName: "report.png", content: Uint8Array.from([137, 80, 78, 71]) },
    ],
    ["executable", { fileName: "report.exe", content: encoder.encode("MZ") }],
  ])(
    "rejects %s artifacts without a canonical capture",
    async (_label, overrides) => {
      const { root, queryId } = await approvedBrain();
      await expect(
        captureWebEvidence(root, queryId, {
          representation: "artifact",
          originalUrl: "https://example.test/report",
          title: "Report",
          responseComplete: true,
          ...overrides,
        }),
      ).rejects.toThrow();
      expect(await webFiles(root)).toEqual([]);
    },
  );

  test("preserves exact bytes and extraction behavior for every supported artifact", async () => {
    const fixtures = [
      ["report.pdf", await textPdf(), "pdf-v1", "page=1"],
      ["report.docx", await docxBytes(), "docx-v1", "heading=web-document"],
      ["report.epub", await epubBytes(), "epub-v1", "chapter=1"],
      [
        "report.md",
        encoder.encode("# Markdown\n\nExact evidence.\n"),
        "markdown-v1",
        "heading=markdown",
      ],
      [
        "report.txt",
        encoder.encode("Exact text evidence.\n"),
        "text-v1",
        "lines=1-1",
      ],
      [
        "report.json",
        encoder.encode('{"fact":"exact"}\n'),
        "json-v1",
        "$.fact",
      ],
      [
        "report.jsonl",
        encoder.encode('{"fact":"exact"}\n'),
        "jsonl-v1",
        "line=1",
      ],
      [
        "report.csv",
        encoder.encode("fact,value\nexact,1\n"),
        "delimited-v1",
        "row=2",
      ],
      [
        "report.tsv",
        encoder.encode("fact\tvalue\nexact\t1\n"),
        "delimited-v1",
        "row=2",
      ],
    ] as const;
    for (const [fileName, bytes, extractor, locator] of fixtures) {
      const { root, queryId } = await approvedBrain(
        `What does ${fileName} say?`,
      );
      const result = await captureWebEvidence(root, queryId, {
        representation: "artifact",
        originalUrl: `https://example.test/${fileName}`,
        title: fileName,
        fileName,
        responseComplete: true,
        content: bytes,
        retrievedAt: "2026-08-30T04:00:00.000Z",
      });
      expect(await readFile(path.join(root, result.source.path))).toEqual(
        Buffer.from(bytes),
      );
      expect(result.source).toMatchObject({
        extractionStatus: "ready",
        extractor,
      });
      const extracted = JSON.parse(
        await readFile(
          path.join(
            root,
            ".brain",
            "cache",
            "extracted",
            `${result.source.id}.json`,
          ),
          "utf8",
        ),
      );
      expect(
        extracted.chunks.map((chunk: { locator: string }) => chunk.locator),
        fileName,
      ).toContain(locator);
    }
  }, 60_000);

  test("reuses artifact bytes, enriches alternate URLs, and preserves sealed bytes", async () => {
    const { root, queryId } = await approvedBrain();
    const bytes = await textPdf();
    const first = await captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl: "https://z.example.test/report.pdf",
      title: "Report",
      fileName: "report.pdf",
      responseComplete: true,
      content: bytes,
      retrievedAt: "2026-08-30T05:02:00.000Z",
    });
    const sourceBytes = await readFile(path.join(root, first.source.path));
    const sidecarPath = first.source.provenance.sidecarPath;
    if (!sidecarPath) throw new Error("Expected artifact sidecar");
    const sidecarBytes = await readFile(path.join(root, sidecarPath));
    const sameUrl = await captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl: "https://z.example.test/report.pdf",
      title: "Report mirror",
      fileName: "mirror.pdf",
      responseComplete: true,
      content: bytes,
      retrievedAt: "2026-08-30T05:03:00.000Z",
    });
    const alternate = await captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl: "https://a.example.test/report.pdf",
      title: "Report alternate",
      fileName: "alternate.pdf",
      responseComplete: true,
      content: bytes,
      retrievedAt: "2026-08-30T05:01:00.000Z",
    });
    expect(sameUrl).toMatchObject({
      created: false,
      source: { id: first.source.id },
    });
    expect(alternate).toMatchObject({
      created: false,
      source: { id: first.source.id },
    });
    expect(await readFile(path.join(root, first.source.path))).toEqual(
      sourceBytes,
    );
    expect(await readFile(path.join(root, sidecarPath))).toEqual(sidecarBytes);
    expect(
      alternate.source.provenance.webDiscoveries?.map(
        (item) => item.originalUrl,
      ),
    ).toEqual([
      "https://a.example.test/report.pdf",
      "https://z.example.test/report.pdf",
      "https://z.example.test/report.pdf",
    ]);
    expect(
      (await git(root, ["show", "--pretty=format:", "--name-only", "HEAD"]))
        .split("\n")
        .filter(Boolean)
        .sort(),
    ).toEqual([
      ".brain/operations.jsonl",
      ".brain/source-manifest.json",
      "wiki/log.md",
    ]);
  });

  test("revalidates registered artifact integrity before reuse", async () => {
    const { root, queryId } = await approvedBrain();
    const bytes = await textPdf("Integrity-bound evidence");
    const input = {
      representation: "artifact" as const,
      originalUrl: "https://example.test/integrity.pdf",
      title: "Integrity",
      fileName: "integrity.pdf",
      responseComplete: true as const,
      content: bytes,
      retrievedAt: "2026-08-30T05:30:00.000Z",
    };
    const first = await captureWebEvidence(root, queryId, input);
    const sidecarPath = first.source.provenance.sidecarPath;
    if (!sidecarPath) throw new Error("Expected artifact sidecar");
    await writeFile(path.join(root, sidecarPath), "{}\n");

    await expect(captureWebEvidence(root, queryId, input)).rejects.toThrow(
      /immutable|invalid|sidecar/i,
    );
  });

  test("reuses compatible local bytes without changing primary provenance", async () => {
    const { root, queryId } = await approvedBrain();
    const bytes = encoder.encode("Locally registered evidence.\n");
    await writeFile(path.join(root, "sources", "local.txt"), bytes);
    const local = (await scanAndRegisterSources(root)).added[0];
    if (!local) throw new Error("Expected local source");
    const reused = await captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl: "https://example.test/local.txt",
      title: "Local mirror",
      fileName: "local.txt",
      responseComplete: true,
      content: bytes,
      retrievedAt: "2026-08-30T06:00:00.000Z",
    });
    expect(reused).toMatchObject({
      created: false,
      source: { id: local.id, provenance: { kind: "file" } },
    });
    expect(reused.source.provenance.webDiscoveries).toHaveLength(1);
    expect(await webFiles(root)).toEqual([]);
    await expect(
      captureWebEvidence(root, queryId, {
        representation: "artifact",
        originalUrl: "https://example.test/local.md",
        title: "Conflicting mirror",
        fileName: "local.md",
        responseComplete: true,
        content: bytes,
        retrievedAt: "2026-08-30T06:01:00.000Z",
      }),
    ).rejects.toThrow(/format|extractor|representation|compatible/i);
  });

  test("does not reuse an unrelated local source that only matches the text digest suffix", async () => {
    const { root, queryId } = await approvedBrain();
    const originalUrl = "https://example.test/suffix-collision";
    const content = "Canonical web body.";
    const digest = sha256(
      JSON.stringify([
        originalUrl,
        originalUrl,
        [],
        "page",
        "complete",
        content,
      ]),
    );
    await writeFile(
      path.join(root, "sources", `unrelated-${digest.slice(0, 12)}.md`),
      "# Unrelated local source\n\nThese bytes are not the web capture.\n",
    );
    const local = (await scanAndRegisterSources(root)).added[0];
    if (!local) throw new Error("Expected local source");

    const captured = await captureWebEvidence(root, queryId, {
      representation: "text",
      originalUrl,
      title: "Suffix collision",
      captureKind: "page",
      completeness: "complete",
      content,
      retrievedAt: "2026-08-30T06:30:00.000Z",
    });

    expect(captured.source.id).not.toBe(local.id);
    expect(captured.source.provenance.kind).toBe("web");
    const refreshedLocal = (
      await readFile(
        path.join(root, ".brain", "source-manifest.json"),
        "utf8",
      ).then((value) => JSON.parse(value).sources)
    ).find((source: { id: string }) => source.id === local.id);
    expect(refreshedLocal.provenance).toEqual({ kind: "file" });
  });

  test("versions changed bytes from a shared original or final URL", async () => {
    const { root, queryId } = await approvedBrain();
    const first = await captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl: "https://example.test/report.txt",
      finalUrl: "https://cdn.example.test/report.txt",
      title: "First",
      fileName: "report.txt",
      responseComplete: true,
      content: encoder.encode("version one\n"),
      retrievedAt: "2026-08-30T07:00:00.000Z",
    });
    const second = await captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl: "https://mirror.example.test/report.txt",
      finalUrl: "https://cdn.example.test/report.txt",
      title: "Second",
      fileName: "report.txt",
      responseComplete: true,
      content: encoder.encode("version two\n"),
      retrievedAt: "2026-08-30T07:01:00.000Z",
    });
    expect(second.source).toMatchObject({ supersedes: first.source.id });
  });

  test("keeps image-only PDF linked but out of ready bootstrap", async () => {
    const { root, queryId } = await approvedBrain();
    const document = await PDFDocument.create();
    document.addPage();
    const result = await captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl: "https://example.test/image-only.pdf",
      title: "Image only",
      fileName: "image-only.pdf",
      responseComplete: true,
      content: await document.save(),
      retrievedAt: "2026-08-30T08:00:00.000Z",
    });
    expect(result.source.extractionStatus).toBe("extraction-required");
    expect(result.session.webEvidenceSourceIds).toContain(result.source.id);
    expect(result.session.bootstrap.pendingSourceIds).not.toContain(
      result.source.id,
    );
  });

  test("fails closed on incomplete or mismatched prepared artifact pairs", async () => {
    const cases = ["artifact-only", "sidecar-only", "mismatched"] as const;
    for (const failure of cases) {
      const { root, queryId } = await approvedBrain(`Prepared ${failure}?`);
      const bytes = encoder.encode("prepared bytes\n");
      const digest = sha256(bytes).slice(0, 12);
      const sourcePath = `sources/web/2026/08/prepared-${digest}.txt`;
      const sidecarPath = `sources/web/2026/08/.prepared-${digest}.txt.web.json`;
      await mkdir(path.dirname(path.join(root, sourcePath)), {
        recursive: true,
      });
      if (failure !== "sidecar-only")
        await writeFile(
          path.join(root, sourcePath),
          failure === "mismatched" ? "wrong\n" : bytes,
        );
      if (failure !== "artifact-only")
        await writeFile(path.join(root, sidecarPath), "{}\n");
      await expect(
        captureWebEvidence(root, queryId, {
          representation: "artifact",
          originalUrl: "https://example.test/prepared.txt",
          title: "Prepared",
          fileName: "prepared.txt",
          responseComplete: true,
          content: bytes,
          retrievedAt: "2026-08-30T09:00:00.000Z",
        }),
      ).rejects.toThrow(/prepared|pair|bytes|sidecar/i);
      expect(await webFiles(root)).toContain(
        failure === "sidecar-only" ? sidecarPath : sourcePath,
      );
    }
  });

  test("retries omitted timestamps, writer locks, crashes, and session writes deterministically", async () => {
    const { root, queryId } = await approvedBrain();
    const input = {
      representation: "artifact" as const,
      originalUrl: "https://example.test/retry.txt",
      title: "Retry",
      fileName: "retry.txt",
      responseComplete: true as const,
      content: encoder.encode("retry evidence\n"),
    };
    await writeFile(
      path.join(root, ".brain", "runtime", "writer.lock"),
      `${JSON.stringify({ pid: 2_147_483_647, operationId: "op_stale", recoverable: false })}\n`,
    );
    await expect(captureWebEvidence(root, queryId, input)).rejects.toThrow(
      /recover|stale|writer/i,
    );
    expect(await webFiles(root)).toEqual([]);
    await rm(path.join(root, ".brain", "runtime", "writer.lock"));
    await expect(
      captureWebEvidence(root, queryId, input, {
        transactionTestOptions: { simulateCrashAfter: "files-applied" },
      }),
    ).rejects.toThrow(/simulated.*crash/i);
    const prepared = await webFiles(root);
    expect(prepared).toHaveLength(2);
    await recoverBrain(root);
    await expect(
      captureWebEvidence(root, queryId, input, {
        simulateSessionWriteFailure: true,
      }),
    ).rejects.toThrow(/session write failure/i);
    expect(
      (await readQuerySession(root, queryId)).webEvidenceSourceIds,
    ).toEqual([]);
    await expect(recoverBrain(root)).resolves.toBe("committed");
    const recovered = await captureWebEvidence(root, queryId, input);
    expect(recovered.created).toBe(false);
    expect(recovered.session.webEvidenceSourceIds).toEqual([
      recovered.source.id,
    ]);
    expect(await webFiles(root)).toEqual(prepared);
  });

  test("never stages disposable runtime input", async () => {
    const { root, queryId } = await approvedBrain();
    const runtimePath = path.join(root, ".brain", "runtime", "download.pdf");
    const bytes = await textPdf();
    await writeFile(runtimePath, bytes);
    await captureWebEvidence(root, queryId, {
      representation: "artifact",
      originalUrl: "https://example.test/runtime.pdf",
      title: "Runtime",
      fileName: path.basename(runtimePath),
      responseComplete: true,
      content: await readFile(runtimePath),
      retrievedAt: "2026-08-30T10:00:00.000Z",
    });
    expect(await stat(runtimePath)).toBeDefined();
    expect(
      await git(root, ["show", "--pretty=format:", "--name-only", "HEAD"]),
    ).not.toContain(".brain/runtime");
  });
});
