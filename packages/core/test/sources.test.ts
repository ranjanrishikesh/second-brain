import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const execFileAsync = promisify(execFile);

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
