import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { initBrain, scanSources, supersedeSource } from "../src/index.js";

describe("scanSources", () => {
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
