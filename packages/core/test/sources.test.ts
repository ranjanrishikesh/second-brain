import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
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
  initBrain,
  readBrainItem,
  scanSources,
  supersedeSource,
} from "../src/index.js";
import { extractPdf } from "../src/sources/extract.js";

const execFileAsync = promisify(execFile);

const webArtifactDirectory = "sources/web/2026/08";
const webDiscovery = {
  originalUrl: "https://example.com/orbits.pdf",
  finalUrl: "https://cdn.example.com/orbits.pdf",
  redirectChain: ["https://cdn.example.com/orbits.pdf"],
  retrievedAt: "2026-08-30T00:00:00.000Z",
  queryId: "qry_0123456789abcdef0123456789abcdef",
  questionHash: "c".repeat(64),
  query: "What does the orbit report conclude?",
  representation: "artifact",
  completeness: "complete",
} as const;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactSidecar(
  sourcePath: string,
  bytes: Uint8Array,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const extension = path.extname(sourcePath).toLowerCase();
  const format = extension === ".md" ? "markdown" : extension.slice(1);
  const mediaType = extension === ".md" ? "text/markdown" : "application/pdf";
  return {
    brainWebArtifact: 1,
    sourcePath,
    artifactSha256: sha256(bytes),
    artifactBytes: bytes.byteLength,
    title: "Orbital Report",
    format,
    mediaType,
    discovery: webDiscovery,
    ...overrides,
  };
}

async function writeWebArtifact(
  root: string,
  fileName: string,
  bytes: Uint8Array,
  sidecar: Record<string, unknown> = artifactSidecar(
    `${webArtifactDirectory}/${fileName}`,
    bytes,
  ),
): Promise<{ sourcePath: string; sidecarPath: string }> {
  const sourcePath = `${webArtifactDirectory}/${fileName}`;
  const sidecarPath = `${webArtifactDirectory}/.${fileName}.web.json`;
  await mkdir(path.join(root, webArtifactDirectory), { recursive: true });
  await writeFile(path.join(root, sourcePath), bytes);
  await writeFile(
    path.join(root, sidecarPath),
    `${JSON.stringify(sidecar, null, 2)}\n`,
  );
  return { sourcePath, sidecarPath };
}

async function textPdf(text = "Orbital mechanics"): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 40, y: 700, size: 14, font });
  return await document.save();
}

async function createEpub(
  chapterHtml: string,
  extraEntries: Record<string, string> = {},
): Promise<Uint8Array> {
  const archive = new JSZip();
  archive.file("mimetype", "application/epub+zip");
  archive.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  );
  archive.file(
    "OEBPS/content.opf",
    '<?xml version="1.0"?><package><metadata><title>Budget Book</title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
  );
  archive.file(
    "OEBPS/chapter.xhtml",
    `<html><body>${chapterHtml}</body></html>`,
  );
  for (const [entryPath, content] of Object.entries(extraEntries)) {
    archive.file(entryPath, content);
  }
  return await archive.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
}

async function createDocx(
  body: string,
  extraEntries: Record<string, string> = {},
  mainDocumentPath = "word/document.xml",
): Promise<Uint8Array> {
  const document = new JSZip();
  document.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${mainDocumentPath}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  document.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainDocumentPath}"/></Relationships>`,
  );
  document.file(
    path.posix.join(
      path.posix.dirname(mainDocumentPath),
      "_rels",
      `${path.posix.basename(mainDocumentPath)}.rels`,
    ),
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  document.file(
    "word/styles.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
  );
  document.file(
    mainDocumentPath,
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  for (const [entryPath, content] of Object.entries(extraEntries)) {
    document.file(entryPath, content);
  }
  return await document.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
}

async function createRepeatedFootnoteDocx(): Promise<Uint8Array> {
  const references = Array.from(
    { length: 200 },
    () => '<w:r><w:footnoteReference w:id="1"/></w:r>',
  ).join("");
  return await createDocx(`<w:p>${references}</w:p>`, {
    "word/footnotes.xml":
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:footnote w:id="1"><w:p><w:r><w:t>' +
      "A".repeat(20_000) +
      "</w:t></w:r></w:p></w:footnote></w:footnotes>",
  });
}

async function createStructurallyAmplifiedFootnoteDocx(): Promise<Uint8Array> {
  const references = Array.from(
    { length: 200 },
    () => '<w:r><w:footnoteReference w:id="1"/></w:r>',
  ).join("");
  const emptyStructure = Array.from(
    { length: 100 },
    () => "<w:p><w:r><w:t></w:t></w:r></w:p>",
  ).join("");
  return await createDocx(`<w:p>${references}</w:p>`, {
    "word/footnotes.xml":
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:footnote w:id="1">${emptyStructure}</w:footnote>` +
      "</w:footnotes>",
  });
}

interface CentralDirectoryEntryLocation {
  centralOffset: number;
  centralSize: number;
  eocdOffset: number;
  entryCount: number;
  recordOffset: number;
  recordLength: number;
  localHeaderOffset: number;
}

function findCentralDirectoryEntry(
  bytes: Uint8Array,
  entryName: string,
): { buffer: Buffer; location: CentralDirectoryEntryLocation } {
  const buffer = Buffer.from(bytes);
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdOffset = buffer.lastIndexOf(eocdSignature);
  if (eocdOffset < 0) throw new Error("Test DOCX has no ZIP directory");
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralEnd = centralOffset + centralSize;
  let recordOffset = centralOffset;
  while (recordOffset < centralEnd) {
    if (buffer.readUInt32LE(recordOffset) !== 0x02014b50)
      throw new Error("Test DOCX has an invalid central record");
    const fileNameLength = buffer.readUInt16LE(recordOffset + 28);
    const extraFieldLength = buffer.readUInt16LE(recordOffset + 30);
    const commentLength = buffer.readUInt16LE(recordOffset + 32);
    const recordLength = 46 + fileNameLength + extraFieldLength + commentLength;
    const currentName = buffer
      .subarray(recordOffset + 46, recordOffset + 46 + fileNameLength)
      .toString("utf8");
    if (currentName === entryName) {
      return {
        buffer,
        location: {
          centralOffset,
          centralSize,
          eocdOffset,
          entryCount,
          recordOffset,
          recordLength,
          localHeaderOffset: buffer.readUInt32LE(recordOffset + 42),
        },
      };
    }
    recordOffset += recordLength;
  }
  throw new Error(`Test DOCX entry is missing: ${entryName}`);
}

function duplicateCentralDirectoryEntry(
  bytes: Uint8Array,
  entryName: string,
  additionalCopies: number,
): Uint8Array {
  const { buffer, location } = findCentralDirectoryEntry(bytes, entryName);
  const centralEnd = location.centralOffset + location.centralSize;
  const record = buffer.subarray(
    location.recordOffset,
    location.recordOffset + location.recordLength,
  );
  const duplicates = Buffer.alloc(record.length * additionalCopies);
  for (let index = 0; index < additionalCopies; index += 1) {
    record.copy(duplicates, index * record.length);
  }
  const output = Buffer.concat([
    buffer.subarray(0, centralEnd),
    duplicates,
    buffer.subarray(centralEnd),
  ]);
  const shiftedEocd = location.eocdOffset + duplicates.length;
  const updatedCount = location.entryCount + additionalCopies;
  output.writeUInt16LE(updatedCount, shiftedEocd + 8);
  output.writeUInt16LE(updatedCount, shiftedEocd + 10);
  output.writeUInt32LE(
    location.centralSize + duplicates.length,
    shiftedEocd + 12,
  );
  return output;
}

function overrideCentralDirectorySize(
  bytes: Uint8Array,
  entryName: string,
  declaredBytes: number,
): Uint8Array {
  const { buffer, location } = findCentralDirectoryEntry(bytes, entryName);
  buffer.writeUInt32LE(declaredBytes, location.recordOffset + 24);
  buffer.writeUInt32LE(declaredBytes, location.localHeaderOffset + 22);
  return buffer;
}

function corruptCentralDirectoryCrc(
  bytes: Uint8Array,
  entryName: string,
): Uint8Array {
  const { buffer, location } = findCentralDirectoryEntry(bytes, entryName);
  const crcOffset = location.recordOffset + 16;
  buffer.writeUInt32LE((buffer.readUInt32LE(crcOffset) ^ 1) >>> 0, crcOffset);
  return buffer;
}

describe("scanSources", () => {
  test("keeps the DOCX parser unloaded until DOCX extraction", async () => {
    const script = [
      'import { createRequire } from "node:module";',
      'await import("./packages/core/src/index.ts");',
      "const require = createRequire(import.meta.url);",
      'const loaded = Object.keys(require.cache).some((file) => file.includes("/mammoth/"));',
      "process.stdout.write(String(loaded));",
    ].join("\n");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: path.resolve(".") },
    );

    expect(stdout).toBe("false");
  });

  test("registers and extracts a new Markdown source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-sources-"));
    await initBrain(root, { name: "Test", description: "Source test" });
    await writeFile(
      path.join(root, "sources", "orbits.md"),
      "# Orbits\n\nAn orbit is a curved path around a body.\n",
    );

    const result = await scanSources(root);

    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({
      path: "sources/orbits.md",
      mediaType: "text/markdown",
      extractionStatus: "ready",
      title: "Orbits",
    });
    expect(result.added[0]?.id).toMatch(/^src_[a-f0-9]{16}$/);
    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    );
    expect(manifest.sources).toHaveLength(1);
  });

  test("extracts a plain-text source with line locators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-text-"));
    await initBrain(root, { name: "Test", description: "Text test" });
    await writeFile(
      path.join(root, "sources", "facts.txt"),
      "Alpha\nBeta\nGamma\n",
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      mediaType: "text/plain",
      extractionStatus: "ready",
      title: "facts",
    });
    const extracted = JSON.parse(
      await readFile(
        path.join(
          root,
          ".brain",
          "cache",
          "extracted",
          `${result.added[0]?.id}.json`,
        ),
        "utf8",
      ),
    );
    expect(extracted.chunks[0]).toMatchObject({
      locator: "lines=1-3",
      text: "Alpha\nBeta\nGamma",
    });
  });

  test("extracts readable HTML without executing or indexing scripts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-html-"));
    await initBrain(root, { name: "Test", description: "HTML test" });
    await writeFile(
      path.join(root, "sources", "article.html"),
      "<!doctype html><html><head><title>Stars</title></head><body><article><h1>Stars</h1><p>Stars emit light.</p></article><script>danger()</script></body></html>",
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      mediaType: "text/html",
      extractionStatus: "ready",
    });
    const extracted = JSON.parse(
      await readFile(
        path.join(
          root,
          ".brain",
          "cache",
          "extracted",
          `${result.added[0]?.id}.json`,
        ),
        "utf8",
      ),
    );
    expect(extracted.text).toContain("Stars emit light.");
    expect(extracted.text).not.toContain("danger");
  });

  test("extracts JSON values with JSONPath locators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-json-"));
    await initBrain(root, { name: "Test", description: "JSON test" });
    await writeFile(
      path.join(root, "sources", "planets.json"),
      JSON.stringify({ planets: [{ name: "Mars", moons: 2 }] }),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      mediaType: "application/json",
      extractionStatus: "ready",
    });
    const extracted = JSON.parse(
      await readFile(
        path.join(
          root,
          ".brain",
          "cache",
          "extracted",
          `${result.added[0]?.id}.json`,
        ),
        "utf8",
      ),
    );
    expect(extracted.chunks).toContainEqual(
      expect.objectContaining({ locator: "$.planets[0].name", text: "Mars" }),
    );
  });

  test("extracts CSV records with row locators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-csv-"));
    await initBrain(root, { name: "Test", description: "CSV test" });
    await writeFile(
      path.join(root, "sources", "planets.csv"),
      "name,moons\nMars,2\nEarth,1\n",
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      mediaType: "text/csv",
      extractionStatus: "ready",
    });
    const extracted = JSON.parse(
      await readFile(
        path.join(
          root,
          ".brain",
          "cache",
          "extracted",
          `${result.added[0]?.id}.json`,
        ),
        "utf8",
      ),
    );
    expect(extracted.chunks[0]).toMatchObject({
      locator: "row=2",
      text: "name: Mars | moons: 2",
    });
  });

  test("extracts JSONL records with line locators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-jsonl-"));
    await initBrain(root, { name: "Test", description: "JSONL test" });
    await writeFile(
      path.join(root, "sources", "events.jsonl"),
      '{"event":"launch"}\n{"event":"landing"}\n',
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      mediaType: "application/x-ndjson",
      extractionStatus: "ready",
    });
    const extracted = JSON.parse(
      await readFile(
        path.join(
          root,
          ".brain",
          "cache",
          "extracted",
          `${result.added[0]?.id}.json`,
        ),
        "utf8",
      ),
    );
    expect(extracted.chunks[1]).toMatchObject({
      locator: "line=2",
      text: '{"event":"landing"}',
    });
  });

  test("extracts text-based PDFs with page locators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-pdf-"));
    await initBrain(root, { name: "Test", description: "PDF test" });
    const document = await PDFDocument.create();
    const page = document.addPage();
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText("Orbital mechanics", { x: 40, y: 700, size: 14, font });
    await writeFile(
      path.join(root, "sources", "paper.pdf"),
      await document.save(),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      mediaType: "application/pdf",
      extractionStatus: "ready",
    });
    const extracted = JSON.parse(
      await readFile(
        path.join(
          root,
          ".brain",
          "cache",
          "extracted",
          `${result.added[0]?.id}.json`,
        ),
        "utf8",
      ),
    );
    expect(extracted.chunks[0]).toMatchObject({ locator: "page=1" });
    expect(extracted.chunks[0].text).toContain("Orbital mechanics");
  });

  test("fails PDF extraction when configured page or extracted-output budgets are exceeded", async () => {
    const cases = [
      {
        name: "pages",
        maxPages: 2,
        maxExtractedBytes: 1_000_000,
        build: async () => {
          const document = await PDFDocument.create();
          document.addPage();
          document.addPage();
          document.addPage();
          return await document.save();
        },
        error: /pdf contains 3 pages.*maximum of 2/i,
      },
      {
        name: "output",
        maxPages: 10,
        maxExtractedBytes: 64,
        build: async () => await textPdf("Extracted PDF words ".repeat(20)),
        error: /extracted pdf content exceeds.*64 bytes/i,
      },
    ];
    for (const item of cases) {
      const root = await mkdtemp(
        path.join(tmpdir(), `brain-pdf-${item.name}-`),
      );
      await initBrain(root, { name: "Test", description: "PDF budget" });
      const configPath = path.join(root, "brain.config.yaml");
      const config = parse(await readFile(configPath, "utf8"));
      config.sources.pdf = {
        maxPages: item.maxPages,
        maxExtractedBytes: item.maxExtractedBytes,
      };
      await writeFile(configPath, stringify(config));
      await writeFile(
        path.join(root, "sources", "budget.pdf"),
        await item.build(),
      );

      const result = await scanSources(root);

      expect(result.added[0]).toMatchObject({
        extractionStatus: "failed",
        extractor: "pdf-v1",
      });
      expect(result.added[0]?.error).toMatch(item.error);
    }
  });

  test("rejects PDF page count before requesting any page text", async () => {
    const document = await PDFDocument.create();
    document.addPage();
    document.addPage();
    let requestedPages = 0;
    const extractWithSeam = extractPdf as unknown as (
      sourceId: string,
      filePath: string,
      bytes: Uint8Array,
      policy: { maxPages: number; maxExtractedBytes: number },
      testOptions: { beforeGetPage: () => void },
    ) => Promise<unknown>;

    await expect(
      extractWithSeam(
        "src_0000000000000000",
        "bounded.pdf",
        await document.save(),
        { maxPages: 1, maxExtractedBytes: 1_000_000 },
        { beforeGetPage: () => (requestedPages += 1) },
      ),
    ).rejects.toThrow(/pdf contains 2 pages.*maximum of 1/i);
    expect(requestedPages).toBe(0);
  });

  test("normalizes one oversized PDF text item without retaining an oversized core copy", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage();
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText("kept", { x: 40, y: 700, size: 10, font });
    page.drawText("overflow ".repeat(200), {
      x: 40,
      y: 680,
      size: 10,
      font,
    });
    const bytes = await document.save({ useObjectStreams: true });
    const maxExtractedBytes = 24;
    let streamCalls = 0;
    let getTextContentCalls = 0;
    let cancelCalls = 0;
    let pageCleanupCalls = 0;
    const retainedByteObservations: number[] = [];
    const bufferedChunkObservations: number[] = [];
    type ControlledPdfPage = {
      getTextContent: () => Promise<unknown>;
      streamTextContent: () => ReadableStream<unknown>;
      cleanup: () => boolean;
    };
    const extractWithStreamSeam = extractPdf as unknown as (
      sourceId: string,
      filePath: string,
      content: Uint8Array,
      policy: { maxPages: number; maxExtractedBytes: number },
      testOptions: {
        afterGetPage: (page: object) => void;
        afterRetainedBytes: (retainedBytes: number) => void;
        afterCoreBufferChange: (
          bufferedChunkBytes: number,
          retainedBytes: number,
        ) => void;
      },
    ) => Promise<unknown>;

    await expect(
      extractWithStreamSeam(
        "src_0000000000000000",
        "streamed.pdf",
        bytes,
        { maxPages: 1, maxExtractedBytes },
        {
          afterGetPage(pageObject) {
            const pdfPage = pageObject as ControlledPdfPage;
            const originalCleanup = pdfPage.cleanup.bind(pdfPage);
            pdfPage.getTextContent = async () => {
              getTextContentCalls += 1;
              throw new Error("getTextContent must not be used");
            };
            pdfPage.streamTextContent = () => {
              streamCalls += 1;
              return new ReadableStream({
                start(controller) {
                  controller.enqueue({
                    items: [
                      {
                        str: `  kept \t${"overflow ".repeat(200)}`,
                        dir: "ltr",
                        transform: [1, 0, 0, 1, 40, 680],
                        width: 2_000,
                        height: 10,
                        fontName: "Helvetica",
                        hasEOL: false,
                      },
                    ],
                    styles: {
                      Helvetica: {
                        fontFamily: "Helvetica",
                        ascent: 0.9,
                        descent: -0.2,
                        vertical: false,
                      },
                    },
                    lang: null,
                  });
                },
                cancel() {
                  cancelCalls += 1;
                },
              });
            };
            pdfPage.cleanup = () => {
              pageCleanupCalls += 1;
              return originalCleanup();
            };
          },
          afterRetainedBytes(retainedBytes) {
            retainedByteObservations.push(retainedBytes);
          },
          afterCoreBufferChange(bufferedChunkBytes, retainedBytes) {
            bufferedChunkObservations.push(bufferedChunkBytes);
            retainedByteObservations.push(retainedBytes);
          },
        },
      ),
    ).rejects.toThrow(/extracted pdf content exceeds.*24 bytes/i);

    expect(streamCalls).toBe(1);
    expect(getTextContentCalls).toBe(0);
    expect(cancelCalls).toBe(1);
    expect(pageCleanupCalls).toBeGreaterThanOrEqual(1);
    expect(retainedByteObservations.length).toBeGreaterThan(0);
    expect(Math.max(...retainedByteObservations)).toBeLessThanOrEqual(
      maxExtractedBytes,
    );
    expect(bufferedChunkObservations.length).toBeGreaterThan(0);
    expect(Math.max(...bufferedChunkObservations)).toBeLessThanOrEqual(
      maxExtractedBytes,
    );
  });

  test.each([
    [
      "pages",
      { maxPages: 1, maxExtractedBytes: 1_000_000 },
      /pdf contains 2 pages.*maximum of 1/i,
    ],
    [
      "output",
      { maxPages: 10, maxExtractedBytes: 64 },
      /extracted pdf content exceeds.*64 bytes/i,
    ],
  ] as const)(
    "enforces a lowered PDF %s budget on cache hits and rebuilds",
    async (label, policy, expectedError) => {
      const root = await mkdtemp(path.join(tmpdir(), "brain-pdf-cache-"));
      await initBrain(root, { name: "Test", description: "PDF cache budget" });
      const document = await PDFDocument.create();
      const font = await document.embedFont(StandardFonts.Helvetica);
      for (let index = 0; index < 2; index += 1) {
        const page = document.addPage();
        page.drawText("Cached PDF words ".repeat(20), {
          x: 40,
          y: 700,
          size: 10,
          font,
        });
      }
      await writeFile(
        path.join(root, "sources", "cached.pdf"),
        await document.save(),
      );
      const source = (await scanSources(root)).added[0];
      expect(source?.extractionStatus).toBe("ready");
      if (!source) throw new Error("Expected PDF source");
      const configPath = path.join(root, "brain.config.yaml");
      const config = parse(await readFile(configPath, "utf8"));
      config.sources.pdf = policy;
      await writeFile(configPath, stringify(config));

      await expect(readBrainItem(root, source.id), label).rejects.toThrow(
        expectedError,
      );
      await rm(
        path.join(root, ".brain", "cache", "extracted", `${source.id}.json`),
      );
      await expect(readBrainItem(root, source.id), label).rejects.toThrow(
        expectedError,
      );
    },
  );

  test.each(["pdf", "epub"] as const)(
    "enforces a lowered maxFileBytes before %s cache-hit validation and rebuild",
    async (format) => {
      const root = await mkdtemp(
        path.join(tmpdir(), `brain-${format}-input-cache-`),
      );
      await initBrain(root, {
        name: "Test",
        description: `${format.toUpperCase()} input cache budget`,
      });
      const bytes =
        format === "pdf"
          ? await textPdf("Cached PDF input")
          : await createEpub("<p>Cached EPUB input</p>");
      await writeFile(path.join(root, "sources", `cached.${format}`), bytes);
      const source = (await scanSources(root)).added[0];
      expect(source?.extractionStatus).toBe("ready");
      if (!source) throw new Error(`Expected ${format.toUpperCase()} source`);
      const configPath = path.join(root, "brain.config.yaml");
      const config = parse(await readFile(configPath, "utf8"));
      config.sources.maxFileBytes = bytes.byteLength - 1;
      await writeFile(configPath, stringify(config));

      await expect(readBrainItem(root, source.id)).rejects.toThrow(
        new RegExp(`exceeds.*${bytes.byteLength - 1} bytes`, "i"),
      );
      await rm(
        path.join(root, ".brain", "cache", "extracted", `${source.id}.json`),
      );
      await expect(readBrainItem(root, source.id)).rejects.toThrow(
        new RegExp(`exceeds.*${bytes.byteLength - 1} bytes`, "i"),
      );
    },
  );

  test("registers a web artifact from its validated hidden sidecar", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-pdf-"));
    await initBrain(root, { name: "Test", description: "Web PDF test" });
    const bytes = await textPdf();
    const sourcePath = `${webArtifactDirectory}/orbits-0123456789ab.pdf`;
    const sidecarPath = `${webArtifactDirectory}/.orbits-0123456789ab.pdf.web.json`;
    await writeWebArtifact(root, "orbits-0123456789ab.pdf", bytes, {
      brainWebArtifact: 1,
      sourcePath,
      artifactSha256: sha256(bytes),
      artifactBytes: bytes.byteLength,
      title: "Orbital Report",
      format: "pdf",
      mediaType: "application/pdf",
      discovery: webDiscovery,
    });

    const result = await scanSources(root);

    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({
      path: sourcePath,
      mediaType: "application/pdf",
      extractionStatus: "ready",
      title: "Orbital Report",
      provenance: {
        kind: "web",
        url: "https://example.com/orbits.pdf",
        finalUrl: "https://cdn.example.com/orbits.pdf",
        representation: "artifact",
        sidecarPath,
        sidecarSha256: sha256(await readFile(path.join(root, sidecarPath))),
      },
    });
    expect(result.added[0]?.provenance.sidecarBytes).toBe(
      (await readFile(path.join(root, sidecarPath))).byteLength,
    );
    expect(
      result.added.some((source) => source.path.endsWith(".web.json")),
    ).toBe(false);
  });

  test("exposes the validated-path boundary for deterministic web evidence race probes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-path-probe-"));
    await initBrain(root, {
      name: "Test",
      description: "Web path race probe test",
    });
    const bytes = new TextEncoder().encode("Stable web evidence.\n");
    const { sourcePath, sidecarPath } = await writeWebArtifact(
      root,
      "orbits-0123456789ab.txt",
      bytes,
      {
        ...artifactSidecar(
          `${webArtifactDirectory}/orbits-0123456789ab.txt`,
          bytes,
        ),
        format: "text",
        mediaType: "text/plain",
      },
    );
    const boundaries: string[] = [];

    await scanSources(root, undefined, {
      afterInitialWebEvidencePathValidation: (kind, relativePath) => {
        boundaries.push(`${kind}:${relativePath}`);
      },
    });

    expect(boundaries).toEqual([
      `artifact:${sourcePath}`,
      `sidecar:${sidecarPath}`,
    ]);
  });

  test.each(["artifact", "sidecar"] as const)(
    "rejects a web %s path replaced with outside bytes after initial validation",
    async (replacedKind) => {
      const root = await mkdtemp(path.join(tmpdir(), "brain-web-path-race-"));
      await initBrain(root, {
        name: "Test",
        description: "Web path identity race test",
      });
      const insideBytes = new TextEncoder().encode("Inside evidence.\n");
      const outsideBytes = new TextEncoder().encode("Outside evidence.\n");
      const fileName = "orbits-0123456789ab.txt";
      const sourcePath = `${webArtifactDirectory}/${fileName}`;
      const declaredBytes =
        replacedKind === "artifact" ? outsideBytes : insideBytes;
      const { sidecarPath } = await writeWebArtifact(
        root,
        fileName,
        insideBytes,
        {
          ...artifactSidecar(sourcePath, declaredBytes),
          title: "Outside-controlled evidence",
          format: "text",
          mediaType: "text/plain",
        },
      );
      const outside = await mkdtemp(
        path.join(tmpdir(), "brain-web-path-race-outside-"),
      );
      let swapped = false;

      await expect(
        scanSources(root, undefined, {
          afterInitialWebEvidencePathValidation: async (kind, relativePath) => {
            if (swapped || kind !== replacedKind) return;
            swapped = true;
            if (kind === "artifact") {
              const outsideArtifact = path.join(outside, fileName);
              await writeFile(outsideArtifact, outsideBytes);
              await rm(path.join(root, relativePath));
              await symlink(outsideArtifact, path.join(root, relativePath));
              return;
            }

            await writeFile(
              path.join(outside, path.basename(sidecarPath)),
              await readFile(path.join(root, sidecarPath)),
            );
            const parent = path.dirname(path.join(root, relativePath));
            await rename(parent, `${parent}-validated`);
            await symlink(outside, parent);
          },
        }),
      ).rejects.toThrow(/changed|regular|symlink|sources tree/i);
      expect(swapped).toBe(true);
    },
  );

  test("uses a Markdown artifact sidecar instead of hostile capture frontmatter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-markdown-"));
    await initBrain(root, {
      name: "Test",
      description: "Web Markdown test",
    });
    const bytes = new TextEncoder().encode(
      "---\nbrainWebCapture: 1\nurl: file:///private/host\n---\n# Hostile title\n\nTrusted body.\n",
    );
    const sourcePath = `${webArtifactDirectory}/orbits-0123456789ab.md`;
    await writeWebArtifact(root, "orbits-0123456789ab.md", bytes, {
      ...artifactSidecar(sourcePath, bytes),
      title: "Sidecar title",
      discovery: {
        ...webDiscovery,
        originalUrl: "https://example.com/orbits.md",
        finalUrl: "https://example.com/orbits.md",
        redirectChain: [],
      },
    });

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      title: "Sidecar title",
      mediaType: "text/markdown",
      extractionStatus: "ready",
      provenance: {
        kind: "web",
        representation: "artifact",
      },
    });
  });

  test("keeps legacy Markdown web captures readable without expanded fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-legacy-"));
    await initBrain(root, { name: "Test", description: "Legacy web test" });
    const body = "# Legacy orbit page\n\nAn orbit curves around a body.\n";
    const sourcePath = path.join(root, webArtifactDirectory, "legacy.md");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      `---\nbrainWebCapture: 1\nurl: https://example.com/legacy\nretrievedAt: 2026-08-30T00:00:00.000Z\nquery: What is an orbit?\ncaptureKind: page\ntitle: Legacy orbit page\ncontentSha256: ${sha256(body)}\n---\n${body}`,
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      title: "Legacy orbit page",
      extractionStatus: "ready",
      provenance: {
        kind: "web",
        url: "https://example.com/legacy",
        captureKind: "page",
      },
    });
  });

  test.each([
    ["missing", undefined, /sidecar.*missing/i],
    ["malformed", "{not-json\n", /sidecar.*valid JSON/i],
  ])(
    "rejects a web artifact with a %s sidecar before manifest write",
    async (_condition, sidecarContent, expectedError) => {
      const root = await mkdtemp(path.join(tmpdir(), "brain-web-sidecar-"));
      await initBrain(root, {
        name: "Test",
        description: "Invalid web sidecar test",
      });
      const manifestPath = path.join(root, ".brain", "source-manifest.json");
      const before = await readFile(manifestPath, "utf8");
      const bytes = await textPdf();
      const fileName = "orbits-0123456789ab.pdf";
      const sourcePath = `${webArtifactDirectory}/${fileName}`;
      const sidecarPath = `${webArtifactDirectory}/.${fileName}.web.json`;
      await mkdir(path.join(root, webArtifactDirectory), { recursive: true });
      await writeFile(path.join(root, sourcePath), bytes);
      if (sidecarContent !== undefined) {
        await writeFile(path.join(root, sidecarPath), sidecarContent);
      }

      await expect(scanSources(root)).rejects.toThrow(expectedError);
      expect(await readFile(manifestPath, "utf8")).toBe(before);
    },
  );

  test("rejects a moved web artifact sidecar", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-moved-"));
    await initBrain(root, { name: "Test", description: "Moved sidecar test" });
    const bytes = await textPdf();
    const fileName = "orbits-0123456789ab.pdf";
    const sourcePath = `${webArtifactDirectory}/${fileName}`;
    await mkdir(path.join(root, webArtifactDirectory), { recursive: true });
    await writeFile(path.join(root, sourcePath), bytes);
    await writeFile(
      path.join(root, webArtifactDirectory, ".moved.pdf.web.json"),
      `${JSON.stringify(artifactSidecar(sourcePath, bytes), null, 2)}\n`,
    );

    await expect(scanSources(root)).rejects.toThrow(/sidecar.*missing/i);
  });

  test("rejects a web artifact sidecar symlink outside the sources tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-sidecar-link-"));
    await initBrain(root, {
      name: "Test",
      description: "Sidecar symlink test",
    });
    const bytes = await textPdf();
    const { sidecarPath } = await writeWebArtifact(
      root,
      "orbits-0123456789ab.pdf",
      bytes,
    );
    const sidecarBytes = await readFile(path.join(root, sidecarPath));
    const outside = await mkdtemp(
      path.join(tmpdir(), "brain-web-sidecar-outside-"),
    );
    const outsideSidecar = path.join(outside, "sidecar.json");
    await writeFile(outsideSidecar, sidecarBytes);
    await rm(path.join(root, sidecarPath));
    await symlink(outsideSidecar, path.join(root, sidecarPath));

    await expect(scanSources(root)).rejects.toThrow(
      /sidecar.*(?:regular|symlink|sources tree)/i,
    );
  });

  test("rejects an oversized web artifact sidecar before reading it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-sidecar-size-"));
    await initBrain(root, {
      name: "Test",
      description: "Sidecar size test",
    });
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 1_024;
    await writeFile(configPath, stringify(config));
    const bytes = new TextEncoder().encode("Small artifact.\n");
    const sourcePath = `${webArtifactDirectory}/orbits-0123456789ab.txt`;
    await writeWebArtifact(root, "orbits-0123456789ab.txt", bytes, {
      ...artifactSidecar(sourcePath, bytes),
      title: "A".repeat(2_000),
      format: "text",
      mediaType: "text/plain",
    });

    await expect(scanSources(root)).rejects.toThrow(
      /sidecar exceeds.*1024 bytes/i,
    );
  });

  test.each([
    [
      "a different source path",
      (sourcePath: string, bytes: Uint8Array) => ({
        ...artifactSidecar(sourcePath, bytes),
        sourcePath: `${webArtifactDirectory}/different.pdf`,
      }),
      /different artifact path/i,
    ],
    [
      "a different source hash",
      (sourcePath: string, bytes: Uint8Array) => ({
        ...artifactSidecar(sourcePath, bytes),
        artifactSha256: "0".repeat(64),
      }),
      /hash.*match|sha-?256.*match/i,
    ],
  ])(
    "rejects a web artifact sidecar declaring %s",
    async (_condition, makeSidecar, expectedError) => {
      const root = await mkdtemp(path.join(tmpdir(), "brain-web-identity-"));
      await initBrain(root, {
        name: "Test",
        description: "Sidecar identity test",
      });
      const bytes = await textPdf();
      const fileName = "orbits-0123456789ab.pdf";
      const sourcePath = `${webArtifactDirectory}/${fileName}`;
      await writeWebArtifact(
        root,
        fileName,
        bytes,
        makeSidecar(sourcePath, bytes),
      );

      await expect(scanSources(root)).rejects.toThrow(expectedError);
    },
  );

  test("reports a registered artifact sidecar mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-changed-"));
    await initBrain(root, {
      name: "Test",
      description: "Changed sidecar test",
    });
    const bytes = await textPdf();
    const { sourcePath, sidecarPath } = await writeWebArtifact(
      root,
      "orbits-0123456789ab.pdf",
      bytes,
    );
    const first = await scanSources(root);
    const registered = first.added[0];
    if (!registered) throw new Error("Expected artifact registration");
    await writeFile(
      path.join(root, sidecarPath),
      `${JSON.stringify(
        artifactSidecar(sourcePath, bytes, { title: "Changed title" }),
        null,
        2,
      )}\n`,
    );

    const second = await scanSources(root);

    expect(second.modified).toContainEqual(
      expect.objectContaining({ path: sidecarPath, registered }),
    );
  });

  test("rejects an oversized web artifact before manifest write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-oversize-"));
    await initBrain(root, { name: "Test", description: "Oversize web test" });
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 16;
    await writeFile(configPath, stringify(config));
    const manifestPath = path.join(root, ".brain", "source-manifest.json");
    const before = await readFile(manifestPath, "utf8");
    const bytes = new TextEncoder().encode(
      "A web artifact larger than sixteen bytes.\n",
    );
    await writeWebArtifact(root, "orbits-0123456789ab.txt", bytes, {
      ...artifactSidecar(
        `${webArtifactDirectory}/orbits-0123456789ab.txt`,
        bytes,
      ),
      format: "text",
      mediaType: "text/plain",
    });

    await expect(scanSources(root)).rejects.toThrow(/exceeds.*16 bytes/i);
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  });

  test("rejects an oversized web artifact before reading it for hashing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-size-order-"));
    await initBrain(root, {
      name: "Test",
      description: "Web size validation order test",
    });
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 16;
    await writeFile(configPath, stringify(config));
    const bytes = new TextEncoder().encode(
      "This artifact exceeds the configured maximum.\n",
    );
    const { sourcePath } = await writeWebArtifact(
      root,
      "orbits-0123456789ab.txt",
      bytes,
      {
        ...artifactSidecar(
          `${webArtifactDirectory}/orbits-0123456789ab.txt`,
          bytes,
        ),
        format: "text",
        mediaType: "text/plain",
      },
    );
    await chmod(path.join(root, sourcePath), 0o000);

    await expect(scanSources(root)).rejects.toThrow(/exceeds.*16 bytes/i);
  });

  test.each([
    ["spoofed", new TextEncoder().encode("not a PDF"), /PDF.*signature/i],
    ["malformed", new TextEncoder().encode("%PDF-1.7\nmalformed"), /pdf/i],
  ])(
    "rejects a %s web PDF before manifest write",
    async (_condition, bytes, expectedError) => {
      const root = await mkdtemp(path.join(tmpdir(), "brain-web-invalid-pdf-"));
      await initBrain(root, {
        name: "Test",
        description: "Invalid web PDF test",
      });
      const manifestPath = path.join(root, ".brain", "source-manifest.json");
      const before = await readFile(manifestPath, "utf8");
      await writeWebArtifact(root, "orbits-0123456789ab.pdf", bytes);

      await expect(scanSources(root)).rejects.toThrow(expectedError);
      expect(await readFile(manifestPath, "utf8")).toBe(before);
    },
  );

  test("rejects a malformed web artifact before duplicate classification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-duplicate-pdf-"));
    await initBrain(root, {
      name: "Test",
      description: "Malformed duplicate web PDF test",
    });
    const bytes = new TextEncoder().encode("%PDF-1.7\nmalformed");
    await writeFile(path.join(root, "sources", "malformed.pdf"), bytes);
    await scanSources(root);
    await writeWebArtifact(root, "orbits-0123456789ab.pdf", bytes);

    await expect(scanSources(root)).rejects.toThrow(
      /Invalid web artifact.*PDF/i,
    );
  });

  test.each([
    ["JSON", "json", "application/json", new TextEncoder().encode("{not-json")],
    [
      "DOCX",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]),
    ],
    [
      "EPUB",
      "epub",
      "application/epub+zip",
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]),
    ],
  ])(
    "rejects malformed %s before web duplicate classification",
    async (_label, extension, mediaType, bytes) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "brain-web-duplicate-structure-"),
      );
      await initBrain(root, {
        name: "Test",
        description: "Malformed duplicate web structure test",
      });
      await writeFile(
        path.join(root, "sources", `malformed.${extension}`),
        bytes,
      );
      await scanSources(root);
      const fileName = `orbits-0123456789ab.${extension}`;
      const sourcePath = `${webArtifactDirectory}/${fileName}`;
      await writeWebArtifact(root, fileName, bytes, {
        ...artifactSidecar(sourcePath, bytes),
        format: extension,
        mediaType,
      });

      await expect(scanSources(root)).rejects.toThrow(/Invalid web artifact/i);
    },
  );

  test("rejects a malformed web artifact before registered-path classification", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-web-registered-pdf-"),
    );
    await initBrain(root, {
      name: "Test",
      description: "Malformed registered web PDF test",
    });
    const bytes = new TextEncoder().encode("%PDF-1.7\nmalformed");
    const { sourcePath, sidecarPath } = await writeWebArtifact(
      root,
      "orbits-0123456789ab.pdf",
      bytes,
    );
    const artifactSha256 = sha256(bytes);
    const sidecarBytes = await readFile(path.join(root, sidecarPath));
    await writeFile(
      path.join(root, ".brain", "source-manifest.json"),
      `${JSON.stringify(
        {
          version: 1,
          sources: [
            {
              version: 1,
              id: `src_${artifactSha256.slice(0, 16)}`,
              sha256: artifactSha256,
              path: sourcePath,
              title: "Orbital Report",
              mediaType: "application/pdf",
              bytes: bytes.byteLength,
              discoveredAt: "2026-08-30T00:00:00.000Z",
              extractionStatus: "failed",
              extractor: "pdf-v1",
              error: "Legacy malformed artifact",
              provenance: {
                kind: "web",
                url: "https://example.com/orbits.pdf",
                retrievedAt: "2026-08-30T00:00:00.000Z",
                query: "What does the orbit report conclude?",
                completeness: "complete",
                representation: "artifact",
                sidecarPath,
                sidecarSha256: sha256(sidecarBytes),
                sidecarBytes: sidecarBytes.byteLength,
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expect(scanSources(root)).rejects.toThrow(
      /Invalid web artifact.*PDF/i,
    );
  });

  test("registers an image-only web PDF as extraction-required", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-image-pdf-"));
    await initBrain(root, {
      name: "Test",
      description: "Image-only web PDF test",
    });
    const document = await PDFDocument.create();
    document.addPage();
    await writeWebArtifact(
      root,
      "orbits-0123456789ab.pdf",
      await document.save(),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "extraction-required",
      extractor: "pdf-v1",
      provenance: { representation: "artifact" },
    });
  });

  test("extracts DOCX sections with heading locators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-docx-"));
    await initBrain(root, { name: "Test", description: "DOCX test" });
    await writeFile(
      path.join(root, "sources", "orbital-notes.docx"),
      await createDocx(
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Orbital Notes</w:t></w:r></w:p><w:p><w:r><w:t>Orbital mechanics links velocity and gravity.</w:t></w:r></w:p>',
      ),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extractionStatus: "ready",
      extractor: "docx-v1",
      title: "Orbital Notes",
    });
    const extracted = JSON.parse(
      await readFile(
        path.join(
          root,
          ".brain",
          "cache",
          "extracted",
          `${result.added[0]?.id}.json`,
        ),
        "utf8",
      ),
    );
    expect(extracted.chunks[0]).toMatchObject({
      locator: "heading=orbital-notes",
    });
    expect(extracted.chunks[0].text).toContain(
      "Orbital mechanics links velocity and gravity.",
    );
  });

  test("requires extraction for a DOCX without usable text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-empty-docx-"));
    await initBrain(root, { name: "Test", description: "Empty DOCX test" });
    await writeFile(
      path.join(root, "sources", "image-only.docx"),
      await createDocx("<w:p><w:r><w:drawing/></w:r></w:p>"),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extractionStatus: "extraction-required",
      extractor: "docx-v1",
    });
  });

  test("requires extraction for every supported format without a usable chunk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-empty-formats-"));
    await initBrain(root, {
      name: "Test",
      description: "Empty supported format test",
    });
    const emptyEpub = new JSZip();
    emptyEpub.file("mimetype", "application/epub+zip");
    emptyEpub.file(
      "META-INF/container.xml",
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    );
    emptyEpub.file(
      "OEBPS/content.opf",
      '<?xml version="1.0"?><package><metadata><title>Empty Book</title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    );
    emptyEpub.file(
      "OEBPS/chapter.xhtml",
      "<html><body><script>ignored()</script></body></html>",
    );
    const fixtures: Array<[string, string | Uint8Array, string]> = [
      ["empty.md", " \n", "markdown-v1"],
      ["empty.txt", "\t\n", "text-v1"],
      [
        "empty.html",
        "<html><body><script>ignored()</script></body></html>",
        "html-v1",
      ],
      ["empty.json", "{}", "json-v1"],
      ["empty.jsonl", "\n\n", "jsonl-v1"],
      ["empty.csv", "name,value\n", "delimited-v1"],
      ["empty.tsv", "name\tvalue\n", "delimited-v1"],
      [
        "empty.epub",
        await emptyEpub.generateAsync({ type: "uint8array" }),
        "epub-v1",
      ],
    ];
    for (const [fileName, bytes] of fixtures) {
      await writeFile(path.join(root, "sources", fileName), bytes);
    }

    const result = await scanSources(root);

    expect(result.added).toHaveLength(fixtures.length);
    for (const [fileName, , extractor] of fixtures) {
      expect(
        result.added.find((source) => source.path.endsWith(`/${fileName}`)),
      ).toMatchObject({
        extractionStatus: "extraction-required",
        extractor,
      });
    }
  });

  test("rejects DOCX archives containing traversal entry names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-unsafe-docx-"));
    await initBrain(root, { name: "Test", description: "Unsafe DOCX test" });
    await writeFile(
      path.join(root, "sources", "unsafe.docx"),
      await createDocx("<w:p><w:r><w:t>Safe visible text</w:t></w:r></w:p>", {
        "../outside.xml": "<unsafe/>",
      }),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(/unsafe docx path/i);
  });

  test("rejects DOCX archives with excessive entry counts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-large-docx-"));
    await initBrain(root, { name: "Test", description: "Large DOCX test" });
    const extraEntries = Object.fromEntries(
      Array.from({ length: 996 }, (_, index) => [
        `custom/item-${index}.xml`,
        "<item/>",
      ]),
    );
    await writeFile(
      path.join(root, "sources", "too-many-parts.docx"),
      await createDocx(
        "<w:p><w:r><w:t>Visible text</w:t></w:r></w:p>",
        extraEntries,
      ),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(/too many archive entries/i);
  });

  test("rejects DOCX archives whose expanded contents exceed the source limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-expanded-docx-"));
    await initBrain(root, {
      name: "Test",
      description: "Expanded DOCX test",
    });
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 4_096;
    await writeFile(configPath, stringify(config));
    const bytes = await createDocx(
      `<w:p><w:r><w:t>${"A".repeat(20_000)}</w:t></w:r></w:p>`,
    );
    expect(bytes.byteLength).toBeLessThan(4_096);
    await writeFile(path.join(root, "sources", "expanded.docx"), bytes);

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(
      /expanded docx content exceeds.*4096 bytes/i,
    );
  });

  test("counts extensionless DOCX parts toward the expanded source limit", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-expanded-docx-part-"),
    );
    await initBrain(root, {
      name: "Test",
      description: "Expanded DOCX part test",
    });
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 4_096;
    await writeFile(configPath, stringify(config));
    const bytes = await createDocx(
      "<w:p><w:r><w:t>Visible text</w:t></w:r></w:p>",
      { "mammoth/style-map": " ".repeat(20_000) },
    );
    expect(bytes.byteLength).toBeLessThan(4_096);
    await writeFile(path.join(root, "sources", "expanded-part.docx"), bytes);

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(
      /expanded docx content exceeds.*4096 bytes/i,
    );
  });

  test("counts mixed-case DOCX relationship targets toward the expanded source limit", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-expanded-docx-target-"),
    );
    await initBrain(root, {
      name: "Test",
      description: "Expanded DOCX target test",
    });
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 4_096;
    await writeFile(configPath, stringify(config));
    const bytes = await createDocx(
      `<w:p><w:r><w:t>${"A".repeat(20_000)}</w:t></w:r></w:p>`,
      {},
      "word/Main.XML",
    );
    expect(bytes.byteLength).toBeLessThan(4_096);
    await writeFile(path.join(root, "sources", "expanded-target.docx"), bytes);

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(
      /expanded docx content exceeds.*4096 bytes/i,
    );
  });

  test("rejects DOCX semantic output that exceeds the source limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-amplified-docx-"));
    await initBrain(root, {
      name: "Test",
      description: "Amplified DOCX output test",
    });
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 1_000_000;
    await writeFile(configPath, stringify(config));
    const bytes = await createRepeatedFootnoteDocx();
    expect(bytes.byteLength).toBeLessThan(1_000_000);
    await writeFile(path.join(root, "sources", "amplified.docx"), bytes);

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(
      /converted docx content exceeds.*1000000 bytes/i,
    );
  });

  test("counts duplicate physical DOCX directory records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-duplicate-docx-"));
    await initBrain(root, {
      name: "Test",
      description: "Duplicate DOCX record test",
    });
    const original = await createDocx(
      "<w:p><w:r><w:t>Visible text</w:t></w:r></w:p>",
      { "custom/duplicate.bin": "duplicate" },
    );
    const bytes = duplicateCentralDirectoryEntry(
      original,
      "custom/duplicate.bin",
      1_000,
    );
    await writeFile(path.join(root, "sources", "duplicates.docx"), bytes);

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(/too many archive entries/i);
  });

  test("rejects ambiguous duplicate DOCX entry names below the entry limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-ambiguous-docx-"));
    await initBrain(root, {
      name: "Test",
      description: "Ambiguous DOCX record test",
    });
    const original = await createDocx(
      "<w:p><w:r><w:t>Visible text</w:t></w:r></w:p>",
      { "custom/duplicate.bin": "duplicate" },
    );
    const bytes = duplicateCentralDirectoryEntry(
      original,
      "custom/duplicate.bin",
      1,
    );
    await writeFile(path.join(root, "sources", "ambiguous.docx"), bytes);

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(/duplicate docx archive entry/i);
  });

  test("rejects DOCX content whose actual size exceeds its declaration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-forged-docx-size-"));
    await initBrain(root, {
      name: "Test",
      description: "Forged DOCX size test",
    });
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 4_096;
    await writeFile(configPath, stringify(config));
    const original = await createDocx(
      `<w:p><w:r><w:t>${"A".repeat(2_000_000)}</w:t></w:r></w:p>`,
    );
    const bytes = overrideCentralDirectorySize(
      original,
      "word/document.xml",
      512,
    );
    expect(bytes.byteLength).toBeLessThan(4_096);
    await writeFile(path.join(root, "sources", "forged-size.docx"), bytes);

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(
      /DOCX entry size does not match its declaration/i,
    );
  });

  test("rejects DOCX entries with mismatched CRC checksums", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-docx-crc-"));
    await initBrain(root, {
      name: "Test",
      description: "DOCX CRC test",
    });
    const original = await createDocx(
      "<w:p><w:r><w:t>CRC mismatch accepted</w:t></w:r></w:p>",
    );
    const bytes = corruptCentralDirectoryCrc(original, "word/document.xml");
    await writeFile(path.join(root, "sources", "bad-crc.docx"), bytes);

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(/DOCX entry CRC mismatch/i);
  });

  test("enforces a lowered DOCX limit equally with and without cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-docx-cache-policy-"));
    await initBrain(root, {
      name: "Test",
      description: "DOCX cache policy test",
    });
    const bytes = await createDocx(
      `<w:p><w:r><w:t>${"A".repeat(20_000)}</w:t></w:r></w:p>`,
    );
    await writeFile(path.join(root, "sources", "policy.docx"), bytes);
    const scan = await scanSources(root);
    const source = scan.added[0];
    expect(source).toMatchObject({
      extractionStatus: "ready",
      extractor: "docx-v1",
      docxOutputPolicy: {
        version: 1,
      },
    });
    if (!source) throw new Error("Expected the DOCX source to be registered");

    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 4_096;
    await writeFile(configPath, stringify(config));
    const expectedError = /expanded docx content exceeds.*4096 bytes/i;

    await expect(readBrainItem(root, source.id)).rejects.toThrow(expectedError);
    await rm(
      path.join(root, ".brain", "cache", "extracted", `${source.id}.json`),
    );
    await expect(readBrainItem(root, source.id)).rejects.toThrow(expectedError);
  });

  test("enforces the DOCX semantic output limit equally with and without cache", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-docx-cache-output-policy-"),
    );
    await initBrain(root, {
      name: "Test",
      description: "DOCX cache output policy test",
    });
    await writeFile(
      path.join(root, "sources", "amplified.docx"),
      await createRepeatedFootnoteDocx(),
    );
    const scan = await scanSources(root);
    const source = scan.added[0];
    expect(source).toMatchObject({
      extractionStatus: "ready",
      extractor: "docx-v1",
    });
    if (!source) throw new Error("Expected the DOCX source to be registered");

    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 1_000_000;
    await writeFile(configPath, stringify(config));
    const expectedError = /converted docx content exceeds.*1000000 bytes/i;

    await expect(readBrainItem(root, source.id)).rejects.toThrow(expectedError);
    await rm(
      path.join(root, ".brain", "cache", "extracted", `${source.id}.json`),
    );
    await expect(readBrainItem(root, source.id)).rejects.toThrow(expectedError);
  });

  test("enforces structural DOCX semantic cost equally with and without cache", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-docx-cache-structure-policy-"),
    );
    await initBrain(root, {
      name: "Test",
      description: "DOCX cache structural policy test",
    });
    await writeFile(
      path.join(root, "sources", "structural-amplification.docx"),
      await createStructurallyAmplifiedFootnoteDocx(),
    );
    const scan = await scanSources(root);
    const source = scan.added[0];
    expect(source).toMatchObject({
      extractionStatus: "ready",
      extractor: "docx-v1",
      docxOutputPolicy: {
        version: 1,
      },
    });
    if (!source) throw new Error("Expected the DOCX source to be registered");

    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 1_000_000;
    await writeFile(configPath, stringify(config));
    const expectedError = /converted docx content exceeds.*1000000 bytes/i;

    await expect(readBrainItem(root, source.id)).rejects.toThrow(expectedError);
    const manifestPath = path.join(root, ".brain", "source-manifest.json");
    const legacyManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sources: Array<Record<string, unknown>>;
    };
    delete legacyManifest.sources[0]?.docxOutputPolicy;
    await writeFile(
      manifestPath,
      `${JSON.stringify(legacyManifest, null, 2)}\n`,
    );
    await expect(readBrainItem(root, source.id)).rejects.toThrow(expectedError);
    await rm(
      path.join(root, ".brain", "cache", "extracted", `${source.id}.json`),
    );
    await expect(readBrainItem(root, source.id)).rejects.toThrow(expectedError);
  });

  test("reports malformed DOCX archives as extraction failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-malformed-docx-"));
    await initBrain(root, {
      name: "Test",
      description: "Malformed DOCX test",
    });
    await writeFile(
      path.join(root, "sources", "malformed.docx"),
      "not a ZIP archive",
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "docx-v1",
    });
    expect(result.added[0]?.error).toMatch(/invalid docx archive/i);
  });

  test("extracts EPUB spine chapters without trusting archive paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-epub-"));
    await initBrain(root, { name: "Test", description: "EPUB test" });
    const archive = new JSZip();
    archive.file("mimetype", "application/epub+zip");
    archive.file(
      "META-INF/container.xml",
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    );
    archive.file(
      "OEBPS/content.opf",
      '<?xml version="1.0"?><package><metadata><title>Red Planet</title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    );
    archive.file(
      "OEBPS/chapter.xhtml",
      "<html><body><h1>Arrival</h1><p>The crew reached Mars.</p></body></html>",
    );
    await writeFile(
      path.join(root, "sources", "novel.epub"),
      await archive.generateAsync({ type: "uint8array" }),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      mediaType: "application/epub+zip",
      extractionStatus: "ready",
      title: "Red Planet",
    });
    const extracted = JSON.parse(
      await readFile(
        path.join(
          root,
          ".brain",
          "cache",
          "extracted",
          `${result.added[0]?.id}.json`,
        ),
        "utf8",
      ),
    );
    expect(extracted.chunks[0]).toMatchObject({ locator: "chapter=1" });
    expect(extracted.chunks[0].text).toContain("The crew reached Mars.");
  });

  test("fails EPUB extraction before decompression when entry and expanded budgets are exceeded", async () => {
    const cases = [
      {
        name: "entries",
        epub: await createEpub("<p>Visible</p>", {
          "extra/one.txt": "1",
          "extra/two.txt": "2",
        }),
        policy: { maxEntries: 5, maxExpandedBytes: 1_000_000 },
        error: /too many archive entries/i,
      },
      {
        name: "expanded bytes",
        epub: await createEpub(`<p>${"A".repeat(50_000)}</p>`),
        policy: { maxEntries: 100, maxExpandedBytes: 4_096 },
        error: /expanded epub content exceeds.*4096 bytes/i,
      },
    ];
    for (const item of cases) {
      const root = await mkdtemp(
        path.join(tmpdir(), `brain-epub-${item.name}-`),
      );
      await initBrain(root, { name: "Test", description: "EPUB budget" });
      const configPath = path.join(root, "brain.config.yaml");
      const config = parse(await readFile(configPath, "utf8"));
      config.sources.epub = {
        ...item.policy,
        maxExtractedBytes: 1_000_000,
      };
      await writeFile(configPath, stringify(config));
      await writeFile(path.join(root, "sources", "budget.epub"), item.epub);

      const result = await scanSources(root);

      expect(result.added[0]).toMatchObject({
        extractionStatus: "failed",
        extractor: "epub-v1",
      });
      expect(result.added[0]?.error).toMatch(item.error);
    }
  });

  test("fails EPUB extraction when normalized extracted output exceeds its budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-epub-output-"));
    await initBrain(root, { name: "Test", description: "EPUB output budget" });
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.epub = {
      maxEntries: 100,
      maxExpandedBytes: 1_000_000,
      maxExtractedBytes: 128,
    };
    await writeFile(configPath, stringify(config));
    await writeFile(
      path.join(root, "sources", "output.epub"),
      await createEpub(`<p>${"Extracted words ".repeat(100)}</p>`),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "epub-v1",
    });
    expect(result.added[0]?.error).toMatch(
      /extracted epub content exceeds.*128 bytes/i,
    );
  });

  test.each([
    [
      "expanded",
      { maxEntries: 100, maxExpandedBytes: 512, maxExtractedBytes: 1_000_000 },
      /expanded epub content exceeds.*512 bytes/i,
    ],
    [
      "extracted",
      {
        maxEntries: 100,
        maxExpandedBytes: 1_000_000,
        maxExtractedBytes: 128,
      },
      /extracted epub content exceeds.*128 bytes/i,
    ],
  ] as const)(
    "enforces a lowered EPUB %s budget on cache hits and rebuilds",
    async (_label, policy, expectedError) => {
      const root = await mkdtemp(path.join(tmpdir(), "brain-epub-cache-"));
      await initBrain(root, { name: "Test", description: "EPUB cache budget" });
      await writeFile(
        path.join(root, "sources", "cached.epub"),
        await createEpub(`<p>${"Cached words ".repeat(100)}</p>`),
      );
      const source = (await scanSources(root)).added[0];
      expect(source?.extractionStatus).toBe("ready");
      if (!source) throw new Error("Expected EPUB source");
      const configPath = path.join(root, "brain.config.yaml");
      const config = parse(await readFile(configPath, "utf8"));
      config.sources.epub = policy;
      await writeFile(configPath, stringify(config));

      await expect(readBrainItem(root, source.id)).rejects.toThrow(
        expectedError,
      );
      await rm(
        path.join(root, ".brain", "cache", "extracted", `${source.id}.json`),
      );
      await expect(readBrainItem(root, source.id)).rejects.toThrow(
        expectedError,
      );
    },
  );

  test("records extraction failures instead of silently omitting the source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-failed-source-"));
    await initBrain(root, { name: "Test", description: "Failure test" });
    await writeFile(path.join(root, "sources", "broken.json"), "{not-json");

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      mediaType: "application/json",
      extractionStatus: "failed",
      extractor: "json-v1",
    });
    expect(result.added[0]?.error).toContain("JSON");
  });

  test("registers but does not extract a file above the configured size limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-large-source-"));
    await initBrain(root, { name: "Test", description: "Size limit test" });
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.maxFileBytes = 16;
    await writeFile(configPath, stringify(config));
    await writeFile(
      path.join(root, "sources", "too-large.txt"),
      "This source is definitely larger than sixteen bytes.\n",
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({
      extractionStatus: "failed",
      extractor: "none",
    });
    expect(result.added[0]?.error).toMatch(/exceeds.*16 bytes/i);
  });

  test("rejects EPUB archives containing traversal entry names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-epub-traversal-"));
    await initBrain(root, { name: "Test", description: "EPUB safety test" });
    const archive = new JSZip();
    archive.file("mimetype", "application/epub+zip");
    archive.file("../outside.xhtml", "<p>Unsafe</p>");
    archive.file(
      "META-INF/container.xml",
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    );
    archive.file(
      "OEBPS/content.opf",
      '<?xml version="1.0"?><package><metadata><title>Unsafe</title></metadata><manifest></manifest><spine></spine></package>',
    );
    await writeFile(
      path.join(root, "sources", "unsafe.epub"),
      await archive.generateAsync({ type: "uint8array" }),
    );

    const result = await scanSources(root);

    expect(result.added[0]).toMatchObject({ extractionStatus: "failed" });
    expect(result.added[0]?.error).toMatch(/unsafe epub path/i);
  });

  test("supersedes an immutable source while retaining both versions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-supersede-"));
    await initBrain(root, { name: "Test", description: "Supersede test" });
    await writeFile(
      path.join(root, "sources", "facts-v1.md"),
      "# Facts\n\nOne moon.\n",
    );
    const first = await scanSources(root);
    await writeFile(
      path.join(root, "sources", "facts-v2.md"),
      "# Facts\n\nTwo moons.\n",
    );
    const second = await scanSources(root);
    const firstSource = first.added[0];
    const secondSource = second.added[0];
    if (!firstSource || !secondSource)
      throw new Error("Expected both source versions to be added");

    const replacement = await supersedeSource(
      root,
      firstSource.id,
      secondSource.id,
    );

    expect(replacement.supersedes).toBe(firstSource.id);
    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    );
    expect(manifest.sources).toHaveLength(2);
  });

  test("chunks Markdown by stable heading anchors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-markdown-chunks-"));
    await initBrain(root, { name: "Test", description: "Chunk test" });
    await writeFile(
      path.join(root, "sources", "guide.md"),
      "# Guide\n\n## Introduction\n\nFirst section.\n\n## Fine Details\n\nSecond section.\n",
    );

    const result = await scanSources(root);
    const extracted = JSON.parse(
      await readFile(
        path.join(
          root,
          ".brain",
          "cache",
          "extracted",
          `${result.added[0]?.id}.json`,
        ),
        "utf8",
      ),
    );

    expect(
      extracted.chunks.map((chunk: { locator: string }) => chunk.locator),
    ).toEqual([
      "heading=guide",
      "heading=introduction",
      "heading=fine-details",
    ]);
  });
});
