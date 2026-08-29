import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { parseHTML } from "linkedom";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { validateDocxArchive } from "./docx-archive.js";
import {
  assertDocxOutputSize,
  assertDocxSemanticOutputBudget,
} from "./docx-output-budget.js";
import type { ExtractedSourceV1 } from "./types.js";

function titleFromMarkdown(text: string, filePath: string): string {
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(filePath, path.extname(filePath));
}

function headingAnchor(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

export function extractMarkdown(
  sourceId: string,
  filePath: string,
  text: string,
): ExtractedSourceV1 {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const lines = normalized.split("\n");
  const sections: Array<{ locator: string; text: string }> = [];
  const anchorCounts = new Map<string, number>();
  let currentLines: string[] = [];
  let currentLocator = `lines=1-${lines.length}`;
  const flush = () => {
    const value = currentLines.join("\n").trim();
    if (value) sections.push({ locator: currentLocator, text: value });
    currentLines = [];
  };
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1]?.trim();
    if (heading) {
      flush();
      const baseAnchor = headingAnchor(heading) || "section";
      const count = (anchorCounts.get(baseAnchor) ?? 0) + 1;
      anchorCounts.set(baseAnchor, count);
      currentLocator = `heading=${baseAnchor}${count > 1 ? `-${count}` : ""}`;
    }
    currentLines.push(line);
  }
  flush();
  return {
    version: 1,
    sourceId,
    title: titleFromMarkdown(normalized, filePath),
    text: normalized,
    chunks: sections.map((section, ordinal) => ({
      id: `${sourceId}_${String(ordinal).padStart(4, "0")}`,
      sourceId,
      ordinal,
      locator: section.locator,
      text: section.text,
    })),
  };
}

export function extractText(
  sourceId: string,
  filePath: string,
  text: string,
): ExtractedSourceV1 {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const lineCount = normalized ? normalized.split("\n").length : 0;
  return {
    version: 1,
    sourceId,
    title: path.basename(filePath, path.extname(filePath)),
    text: normalized,
    chunks: normalized
      ? [
          {
            id: `${sourceId}_0000`,
            sourceId,
            ordinal: 0,
            locator: `lines=1-${lineCount}`,
            text: normalized,
          },
        ]
      : [],
  };
}

export function extractHtml(
  sourceId: string,
  filePath: string,
  html: string,
): ExtractedSourceV1 {
  const { document } = parseHTML(html);
  for (const unsafe of document.querySelectorAll(
    "script,style,noscript,template",
  ))
    unsafe.remove();
  const title =
    document.querySelector("h1")?.textContent?.trim() ||
    document.title.trim() ||
    path.basename(filePath, path.extname(filePath));
  const content = document.querySelector("article,main") ?? document.body;
  const blocks = Array.from(
    content.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote"),
  )
    .map((element) => {
      const value = element.textContent.replace(/\s+/g, " ").trim();
      if (!value) return "";
      const heading = element.tagName.match(/^H([1-6])$/)?.[1];
      return heading ? `${"#".repeat(Number(heading))} ${value}` : value;
    })
    .filter(Boolean);
  const normalized = (blocks.length ? blocks.join("\n\n") : content.textContent)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    version: 1,
    sourceId,
    title,
    text: normalized,
    chunks: normalized
      ? [
          {
            id: `${sourceId}_0000`,
            sourceId,
            ordinal: 0,
            locator: "document",
            text: normalized,
          },
        ]
      : [],
  };
}

function flattenJson(
  value: unknown,
  locator: string,
  entries: Array<{ locator: string; text: string }>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenJson(item, `${locator}[${index}]`, entries);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const safeKey = /^[A-Za-z_$][\w$]*$/.test(key)
        ? `.${key}`
        : `[${JSON.stringify(key)}]`;
      flattenJson(child, `${locator}${safeKey}`, entries);
    }
    return;
  }
  entries.push({ locator, text: value === null ? "null" : String(value) });
}

export function extractJson(
  sourceId: string,
  filePath: string,
  json: string,
): ExtractedSourceV1 {
  const entries: Array<{ locator: string; text: string }> = [];
  flattenJson(JSON.parse(json), "$", entries);
  return {
    version: 1,
    sourceId,
    title: path.basename(filePath, path.extname(filePath)),
    text: entries.map((entry) => `${entry.locator}: ${entry.text}`).join("\n"),
    chunks: entries.map((entry, ordinal) => ({
      id: `${sourceId}_${String(ordinal).padStart(4, "0")}`,
      sourceId,
      ordinal,
      locator: entry.locator,
      text: entry.text,
    })),
  };
}

export function extractCsv(
  sourceId: string,
  filePath: string,
  csv: string,
  delimiter: "," | "\t",
): ExtractedSourceV1 {
  const records = parseCsv(csv, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    relax_column_count: false,
  }) as Array<Record<string, string>>;
  const chunks = records.map((record, ordinal) => ({
    id: `${sourceId}_${String(ordinal).padStart(4, "0")}`,
    sourceId,
    ordinal,
    locator: `row=${ordinal + 2}`,
    text: Object.entries(record)
      .map(([key, value]) => `${key}: ${value}`)
      .join(" | "),
  }));
  return {
    version: 1,
    sourceId,
    title: path.basename(filePath, path.extname(filePath)),
    text: chunks.map((chunk) => chunk.text).join("\n"),
    chunks,
  };
}

export function extractJsonLines(
  sourceId: string,
  filePath: string,
  jsonLines: string,
): ExtractedSourceV1 {
  const lines = jsonLines.replace(/\r\n?/g, "\n").split("\n");
  const chunks = lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    const normalized = JSON.stringify(JSON.parse(line));
    return [
      {
        id: `${sourceId}_${String(index).padStart(4, "0")}`,
        sourceId,
        ordinal: index,
        locator: `line=${index + 1}`,
        text: normalized,
      },
    ];
  });
  return {
    version: 1,
    sourceId,
    title: path.basename(filePath, path.extname(filePath)),
    text: chunks.map((chunk) => chunk.text).join("\n"),
    chunks,
  };
}

export async function extractPdf(
  sourceId: string,
  filePath: string,
  bytes: Uint8Array,
): Promise<ExtractedSourceV1> {
  const document = await getDocument({ data: bytes, verbosity: 0 }).promise;
  const chunks = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .flatMap((item) =>
        "str" in item && item.str.trim() ? [item.str.trim()] : [],
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    chunks.push({
      id: `${sourceId}_${String(pageNumber - 1).padStart(4, "0")}`,
      sourceId,
      ordinal: pageNumber - 1,
      locator: `page=${pageNumber}`,
      text,
    });
  }
  return {
    version: 1,
    sourceId,
    title: path.basename(filePath, path.extname(filePath)),
    text: chunks.map((chunk) => chunk.text).join("\n\n"),
    chunks,
  };
}

export async function extractDocx(
  sourceId: string,
  filePath: string,
  bytes: Uint8Array,
  maxExpandedBytes: number,
): Promise<ExtractedSourceV1> {
  await validateDocxArchive(bytes, maxExpandedBytes);
  const { default: mammoth } = await import("mammoth");
  const converted = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      transformDocument: (document: unknown) =>
        assertDocxSemanticOutputBudget(document, maxExpandedBytes),
    },
  );
  assertDocxOutputSize(converted.value, maxExpandedBytes);
  const html = extractHtml(
    sourceId,
    filePath,
    `<html><body>${converted.value}</body></html>`,
  );
  const structured = extractMarkdown(sourceId, filePath, html.text);
  assertDocxOutputSize(structured.text, maxExpandedBytes);
  return { ...structured, title: html.title };
}

function xmlChild(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const entry = Object.entries(value).find(
    ([key]) => key === name || key.endsWith(`:${name}`),
  );
  return entry?.[1];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function safeZipPath(value: string): string {
  if (value.includes("\\")) throw new Error(`Unsafe EPUB path: ${value}`);
  const normalized = path.posix.normalize(value);
  if (
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized === ".."
  ) {
    throw new Error(`Unsafe EPUB path: ${value}`);
  }
  return normalized;
}

export async function extractEpub(
  sourceId: string,
  filePath: string,
  bytes: Uint8Array,
): Promise<ExtractedSourceV1> {
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries = Object.keys(archive.files);
  if (entries.length > 10_000)
    throw new Error("EPUB contains too many archive entries");
  entries.forEach(safeZipPath);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
  });
  const containerText = await archive
    .file("META-INF/container.xml")
    ?.async("string");
  if (!containerText) throw new Error("EPUB container.xml is missing");
  const container = parser.parse(containerText) as unknown;
  const rootfiles = xmlChild(xmlChild(container, "container"), "rootfiles");
  const rootfile = asArray(xmlChild(rootfiles, "rootfile"))[0] as
    | Record<string, unknown>
    | undefined;
  const packagePath = safeZipPath(String(rootfile?.["@full-path"] ?? ""));
  if (!packagePath) throw new Error("EPUB package path is missing");
  const packageText = await archive.file(packagePath)?.async("string");
  if (!packageText) throw new Error(`EPUB package is missing: ${packagePath}`);
  const packageDocument = xmlChild(parser.parse(packageText), "package");
  const metadata = xmlChild(packageDocument, "metadata");
  const rawTitle = xmlChild(metadata, "title");
  const title =
    (typeof rawTitle === "string"
      ? rawTitle
      : String((rawTitle as Record<string, unknown>)?.["#text"] ?? "")) ||
    path.basename(filePath, path.extname(filePath));
  const manifest = xmlChild(packageDocument, "manifest");
  const items = asArray(xmlChild(manifest, "item")) as Array<
    Record<string, unknown>
  >;
  const hrefById = new Map(
    items.map((item) => [String(item["@id"]), String(item["@href"])] as const),
  );
  const spine = xmlChild(packageDocument, "spine");
  const itemRefs = asArray(xmlChild(spine, "itemref")) as Array<
    Record<string, unknown>
  >;
  const packageDirectory = path.posix.dirname(packagePath);
  const chunks = [];
  let totalCharacters = 0;
  for (const [ordinal, itemRef] of itemRefs.entries()) {
    const href = hrefById.get(String(itemRef["@idref"]));
    if (!href) continue;
    const chapterPath = safeZipPath(path.posix.join(packageDirectory, href));
    const chapterHtml = await archive.file(chapterPath)?.async("string");
    if (!chapterHtml)
      throw new Error(`EPUB spine item is missing: ${chapterPath}`);
    totalCharacters += chapterHtml.length;
    if (totalCharacters > 100_000_000)
      throw new Error("EPUB extracted content exceeds 100 MB");
    const chapter = extractHtml(sourceId, chapterPath, chapterHtml);
    if (!chapter.text) continue;
    chunks.push({
      id: `${sourceId}_${String(ordinal).padStart(4, "0")}`,
      sourceId,
      ordinal,
      locator: `chapter=${ordinal + 1}`,
      text: chapter.text,
    });
  }
  return {
    version: 1,
    sourceId,
    title: title.trim(),
    text: chunks.map((chunk) => chunk.text).join("\n\n"),
    chunks,
  };
}
