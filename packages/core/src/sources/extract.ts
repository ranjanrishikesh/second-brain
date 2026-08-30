import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { parseHTML } from "linkedom";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { defaultTextExtractionPolicyV1 } from "../config.js";
import { validateDocxArchive } from "./docx-archive.js";
import {
  assertDocxOutputSize,
  assertDocxSemanticOutputBudget,
} from "./docx-output-budget.js";
import type { DocxOutputPolicyV1, ExtractedSourceV1 } from "./types.js";
import { validateZipArchiveBudget } from "./zip-archive-budget.js";

export interface TextExtractionPolicyV1 {
  maxExtractedBytes: number;
  maxChunks: number;
}

function textExtractionPolicy(
  policy: TextExtractionPolicyV1 | undefined,
): TextExtractionPolicyV1 {
  const resolved = policy ?? defaultTextExtractionPolicyV1;
  if (
    !Number.isSafeInteger(resolved.maxExtractedBytes) ||
    resolved.maxExtractedBytes <= 0 ||
    !Number.isSafeInteger(resolved.maxChunks) ||
    resolved.maxChunks <= 0
  ) {
    throw new Error("Text extraction limits must be positive safe integers");
  }
  return resolved;
}

class RetainedTextBudget {
  readonly #policy: TextExtractionPolicyV1;
  readonly #label: string;
  #bytes = 0;
  #entries = 0;

  constructor(
    policy: TextExtractionPolicyV1,
    label: string,
    initialFields: readonly string[] = [],
  ) {
    this.#policy = policy;
    this.#label = label;
    this.retainFields(initialFields);
  }

  #retainBytes(bytes: number): void {
    if (bytes > this.#policy.maxExtractedBytes - this.#bytes) {
      throw new Error(
        `Extracted ${this.#label} content exceeds configured maximum of ${this.#policy.maxExtractedBytes} bytes`,
      );
    }
    this.#bytes += bytes;
  }

  retainFields(fields: readonly string[]): void {
    this.#retainBytes(
      fields.reduce(
        (bytes, field) => bytes + Buffer.byteLength(field, "utf8"),
        0,
      ),
    );
  }

  #retainEntry(): void {
    if (this.#entries >= this.#policy.maxChunks) {
      throw new Error(
        `Extracted ${this.#label} content exceeds configured maximum of ${this.#policy.maxChunks} chunks`,
      );
    }
    this.#entries += 1;
  }

  retainChunk(fields: readonly string[]): void {
    this.#retainEntry();
    this.retainFields(fields);
  }

  retainPrimaryEntry(
    primaryText: string,
    separator: string,
    chunkFields: readonly string[],
  ): void {
    const separatorBytes = this.#entries > 0 ? Buffer.byteLength(separator) : 0;
    this.#retainEntry();
    this.#retainBytes(separatorBytes + Buffer.byteLength(primaryText, "utf8"));
    this.retainFields(chunkFields);
  }
}

function titleFromMarkdown(text: string, filePath: string): string {
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(filePath, path.extname(filePath));
}

function normalizedLineCount(text: string): number {
  if (!text) return 0;
  let count = 1;
  let offset = 0;
  for (;;) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) return count;
    count += 1;
    offset = newline + 1;
  }
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
  rawPolicy?: TextExtractionPolicyV1,
): ExtractedSourceV1 {
  const policy = textExtractionPolicy(rawPolicy);
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const title = titleFromMarkdown(normalized, filePath);
  const budget = new RetainedTextBudget(policy, "Markdown", [
    title,
    normalized,
  ]);
  const lineCount = normalizedLineCount(normalized);
  const sections: Array<{ locator: string; text: string }> = [];
  const anchorCounts = new Map<string, number>();
  let currentLocator = `lines=1-${lineCount}`;
  let sectionStart = 0;
  const flush = (sectionEnd: number) => {
    const value = normalized.slice(sectionStart, sectionEnd).trim();
    if (!value) return;
    budget.retainChunk([currentLocator, value]);
    sections.push({ locator: currentLocator, text: value });
  };
  let lineStart = 0;
  while (lineStart < normalized.length) {
    const newline = normalized.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? normalized.length : newline;
    const line = normalized.slice(lineStart, lineEnd);
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1]?.trim();
    if (heading) {
      flush(lineStart);
      const baseAnchor = headingAnchor(heading) || "section";
      const count = (anchorCounts.get(baseAnchor) ?? 0) + 1;
      anchorCounts.set(baseAnchor, count);
      currentLocator = `heading=${baseAnchor}${count > 1 ? `-${count}` : ""}`;
      sectionStart = lineStart;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  flush(normalized.length);
  return {
    version: 1,
    sourceId,
    title,
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
  rawPolicy?: TextExtractionPolicyV1,
): ExtractedSourceV1 {
  const policy = textExtractionPolicy(rawPolicy);
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const title = path.basename(filePath, path.extname(filePath));
  const lineCount = normalizedLineCount(normalized);
  const locator = `lines=1-${lineCount}`;
  const budget = new RetainedTextBudget(policy, "text", [title, normalized]);
  if (normalized) budget.retainChunk([locator, normalized]);
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
            locator,
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
  rawPolicy?: TextExtractionPolicyV1,
  label = "HTML",
  includeChunk = true,
): ExtractedSourceV1 {
  const policy = textExtractionPolicy(rawPolicy);
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
  const blocks: string[] = [];
  const budget = new RetainedTextBudget(policy, label, [title]);
  for (const element of content.querySelectorAll(
    "h1,h2,h3,h4,h5,h6,p,li,pre,blockquote",
  )) {
    const heading = element.tagName.match(/^H([1-6])$/)?.[1];
    const value = element.textContent.replace(/\s+/g, " ").trim();
    if (!value) continue;
    const block = heading ? `${"#".repeat(Number(heading))} ${value}` : value;
    if (blocks.length === 0 && includeChunk) {
      budget.retainFields(["document"]);
    }
    budget.retainPrimaryEntry(block, "\n\n", includeChunk ? [block] : []);
    blocks.push(block);
  }
  const normalized = (blocks.length ? blocks.join("\n\n") : content.textContent)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (blocks.length === 0) {
    budget.retainFields([normalized]);
    if (normalized && includeChunk) {
      budget.retainChunk(["document", normalized]);
    }
  }
  return {
    version: 1,
    sourceId,
    title,
    text: normalized,
    chunks:
      includeChunk && normalized
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

interface JsonValueFrame {
  kind: "value";
  value: unknown;
  path: JsonPathNode | undefined;
}

interface JsonChildrenFrame {
  kind: "children";
  children: Iterator<JsonValueFrame>;
}

interface JsonPathNode {
  parent: JsonPathNode | undefined;
  segment: string;
  bytes: number;
}

function extendJsonPath(
  parent: JsonPathNode | undefined,
  segment: string,
  policy: TextExtractionPolicyV1,
): JsonPathNode {
  const bytes = (parent?.bytes ?? 1) + Buffer.byteLength(segment, "utf8");
  if (bytes + 2 > policy.maxExtractedBytes) {
    throw new Error(
      `Extracted JSON content exceeds configured maximum of ${policy.maxExtractedBytes} bytes`,
    );
  }
  return { parent, segment, bytes };
}

function renderJsonPath(pathNode: JsonPathNode | undefined): string {
  const segments: string[] = [];
  for (let current = pathNode; current; current = current.parent) {
    segments.push(current.segment);
  }
  segments.reverse();
  return `$${segments.join("")}`;
}

function* jsonChildren(
  value: unknown[] | Record<string, unknown>,
  pathNode: JsonPathNode | undefined,
  policy: TextExtractionPolicyV1,
): Generator<JsonValueFrame> {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      yield {
        kind: "value",
        value: value[index],
        path: extendJsonPath(pathNode, `[${index}]`, policy),
      };
    }
    return;
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const safeKey = /^[A-Za-z_$][\w$]*$/.test(key)
      ? `.${key}`
      : `[${JSON.stringify(key)}]`;
    yield {
      kind: "value",
      value: value[key],
      path: extendJsonPath(pathNode, safeKey, policy),
    };
  }
}

export function extractJson(
  sourceId: string,
  filePath: string,
  json: string,
  rawPolicy?: TextExtractionPolicyV1,
): ExtractedSourceV1 {
  const policy = textExtractionPolicy(rawPolicy);
  const entries: Array<{ locator: string; text: string }> = [];
  const title = path.basename(filePath, path.extname(filePath));
  const budget = new RetainedTextBudget(policy, "JSON", [title]);
  const stack: Array<JsonValueFrame | JsonChildrenFrame> = [
    { kind: "value", value: JSON.parse(json), path: undefined },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    if (frame.kind === "children") {
      const next = frame.children.next();
      if (!next.done) {
        stack.push(frame, next.value);
      }
      continue;
    }
    if (
      Array.isArray(frame.value) ||
      (frame.value !== null && typeof frame.value === "object")
    ) {
      stack.push({
        kind: "children",
        children: jsonChildren(
          frame.value as unknown[] | Record<string, unknown>,
          frame.path,
          policy,
        ),
      });
      continue;
    }
    const value = frame.value === null ? "null" : String(frame.value);
    const locator = renderJsonPath(frame.path);
    budget.retainPrimaryEntry(`${locator}: ${value}`, "\n", [locator, value]);
    entries.push({ locator, text: value });
  }
  return {
    version: 1,
    sourceId,
    title,
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
  rawPolicy?: TextExtractionPolicyV1,
): ExtractedSourceV1 {
  const policy = textExtractionPolicy(rawPolicy);
  const title = path.basename(filePath, path.extname(filePath));
  const budget = new RetainedTextBudget(policy, "delimited", [title]);
  let ordinal = 0;
  let structuredEntries = 0;
  const records = parseCsv(csv, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    relax_column_count: false,
    on_record: (record: Record<string, string>) => {
      const parts: string[] = [];
      for (const key in record) {
        if (!Object.hasOwn(record, key)) continue;
        if (structuredEntries >= policy.maxChunks) {
          throw new Error(
            `Extracted delimited content exceeds configured maximum of ${policy.maxChunks} chunks`,
          );
        }
        structuredEntries += 1;
        parts.push(`${key}: ${record[key]}`);
      }
      const text = parts.join(" | ");
      const locator = `row=${ordinal + 2}`;
      budget.retainPrimaryEntry(text, "\n", [locator, text]);
      const chunk = {
        id: `${sourceId}_${String(ordinal).padStart(4, "0")}`,
        sourceId,
        ordinal,
        locator,
        text,
      };
      ordinal += 1;
      return chunk;
    },
  }) as ExtractedSourceV1["chunks"];
  return {
    version: 1,
    sourceId,
    title,
    text: records.map((chunk) => chunk.text).join("\n"),
    chunks: records,
  };
}

export function extractJsonLines(
  sourceId: string,
  filePath: string,
  jsonLines: string,
  rawPolicy?: TextExtractionPolicyV1,
): ExtractedSourceV1 {
  const policy = textExtractionPolicy(rawPolicy);
  const title = path.basename(filePath, path.extname(filePath));
  const budget = new RetainedTextBudget(policy, "JSONL", [title]);
  const chunks: ExtractedSourceV1["chunks"] = [];
  let lineStart = 0;
  let lineIndex = 0;
  while (lineStart <= jsonLines.length) {
    const nextLineFeed = jsonLines.indexOf("\n", lineStart);
    const nextCarriageReturn = jsonLines.indexOf("\r", lineStart);
    const carriageReturnFirst =
      nextCarriageReturn !== -1 &&
      (nextLineFeed === -1 || nextCarriageReturn < nextLineFeed);
    const lineEnd = carriageReturnFirst
      ? nextCarriageReturn
      : nextLineFeed === -1
        ? jsonLines.length
        : nextLineFeed;
    const line = jsonLines.slice(lineStart, lineEnd);
    if (line.trim()) {
      const normalized = JSON.stringify(JSON.parse(line));
      const locator = `line=${lineIndex + 1}`;
      budget.retainPrimaryEntry(normalized, "\n", [locator, normalized]);
      chunks.push({
        id: `${sourceId}_${String(lineIndex).padStart(4, "0")}`,
        sourceId,
        ordinal: lineIndex,
        locator,
        text: normalized,
      });
    }
    if (lineEnd === jsonLines.length) break;
    lineStart =
      carriageReturnFirst && jsonLines[lineEnd + 1] === "\n"
        ? lineEnd + 2
        : lineEnd + 1;
    lineIndex += 1;
  }
  return {
    version: 1,
    sourceId,
    title,
    text: chunks.map((chunk) => chunk.text).join("\n"),
    chunks,
  };
}

export interface PdfExtractionPolicyV1 {
  maxPages: number;
  maxExtractedBytes: number;
}

export interface PdfExtractionTestOptions {
  /** Deterministic seam proving the page-count guard precedes page requests. */
  beforeGetPage?: (pageNumber: number) => Promise<void> | void;
  /** Allows focused tests to observe a real page before text extraction. */
  afterGetPage?: (page: object) => Promise<void> | void;
  /** Reports only the cumulative UTF-8 bytes retained by the extractor. */
  afterRetainedBytes?: (retainedBytes: number) => Promise<void> | void;
  /** Reports the bounded core string buffer and cumulative retained bytes. */
  afterCoreBufferChange?: (
    bufferedChunkBytes: number,
    retainedBytes: number,
  ) => Promise<void> | void;
}

export async function extractPdf(
  sourceId: string,
  filePath: string,
  bytes: Uint8Array,
  policy: PdfExtractionPolicyV1,
  testOptions: PdfExtractionTestOptions = {},
): Promise<ExtractedSourceV1> {
  const loadingTask = getDocument({
    data: bytes,
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
  });
  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    document = await loadingTask.promise;
    if (document.numPages > policy.maxPages) {
      throw new Error(
        `PDF contains ${document.numPages} pages, exceeding configured maximum of ${policy.maxPages}`,
      );
    }
    const chunks = [];
    let extractedBytes = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      await testOptions.beforeGetPage?.(pageNumber);
      const page = await document.getPage(pageNumber);
      try {
        await testOptions.afterGetPage?.(page);
        const pageTextChunks: string[] = [];
        const coreChunkLimit = Math.min(4_096, policy.maxExtractedBytes);
        let bufferedPageText = "";
        let bufferedPageBytes = 0;
        let pageHasText = false;
        const flushPageBuffer = (): void => {
          if (!bufferedPageText) return;
          pageTextChunks.push(bufferedPageText);
          bufferedPageText = "";
          bufferedPageBytes = 0;
        };
        const retainPageFragment = async (
          fragment: string,
          fragmentBytes: number,
        ): Promise<void> => {
          if (
            bufferedPageBytes > 0 &&
            fragmentBytes > coreChunkLimit - bufferedPageBytes
          ) {
            flushPageBuffer();
          }
          bufferedPageText += fragment;
          bufferedPageBytes += fragmentBytes;
          extractedBytes += fragmentBytes;
          await testOptions.afterCoreBufferChange?.(
            bufferedPageBytes,
            extractedBytes,
          );
          await testOptions.afterRetainedBytes?.(extractedBytes);
        };
        const reader = page.streamTextContent().getReader();
        let streamComplete = false;
        let streamCancelled = false;
        const rejectOutputBudget = async (): Promise<never> => {
          const budgetError = new Error(
            `Extracted PDF content exceeds configured maximum of ${policy.maxExtractedBytes} bytes`,
          );
          streamCancelled = true;
          await reader.cancel(budgetError).catch(() => undefined);
          throw budgetError;
        };
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) {
              streamComplete = true;
              break;
            }
            for (const item of next.value.items) {
              if (!("str" in item)) continue;
              let itemHasText = false;
              let pendingWhitespace = false;
              for (const codePoint of item.str) {
                if (/\s/u.test(codePoint)) {
                  if (itemHasText) pendingWhitespace = true;
                  continue;
                }
                const pageSeparatorBytes =
                  !pageHasText && chunks.length > 0 ? 2 : 0;
                const spaceRequired = pageHasText
                  ? !itemHasText || pendingWhitespace
                  : false;
                const codePointBytes = Buffer.byteLength(codePoint, "utf8");
                const retainedBytes =
                  pageSeparatorBytes + (spaceRequired ? 1 : 0) + codePointBytes;
                if (retainedBytes > policy.maxExtractedBytes - extractedBytes) {
                  await rejectOutputBudget();
                }
                if (pageSeparatorBytes > 0) {
                  extractedBytes += pageSeparatorBytes;
                  await testOptions.afterRetainedBytes?.(extractedBytes);
                }
                if (spaceRequired) await retainPageFragment(" ", 1);
                await retainPageFragment(codePoint, codePointBytes);
                pageHasText = true;
                itemHasText = true;
                pendingWhitespace = false;
              }
            }
          }
        } finally {
          if (!streamComplete && !streamCancelled) {
            await reader.cancel().catch(() => undefined);
          }
          reader.releaseLock();
        }
        if (!pageHasText) continue;
        flushPageBuffer();
        chunks.push({
          id: `${sourceId}_${String(pageNumber - 1).padStart(4, "0")}`,
          sourceId,
          ordinal: pageNumber - 1,
          locator: `page=${pageNumber}`,
          text: pageTextChunks.join(""),
        });
      } finally {
        page.cleanup();
      }
    }
    return {
      version: 1,
      sourceId,
      title: path.basename(filePath, path.extname(filePath)),
      text: chunks.map((chunk) => chunk.text).join("\n\n"),
      chunks,
    };
  } finally {
    try {
      if (document) await document.cleanup();
    } finally {
      await loadingTask.destroy();
    }
  }
}

export async function extractDocx(
  sourceId: string,
  filePath: string,
  bytes: Uint8Array,
  maxExpandedBytes: number,
): Promise<ExtractedSourceV1> {
  return (
    await extractDocxWithPolicy(sourceId, filePath, bytes, maxExpandedBytes)
  ).extracted;
}

export async function extractDocxWithPolicy(
  sourceId: string,
  filePath: string,
  bytes: Uint8Array,
  maxExpandedBytes: number,
): Promise<{
  extracted: ExtractedSourceV1;
  outputPolicy: DocxOutputPolicyV1;
}> {
  await validateDocxArchive(bytes, maxExpandedBytes);
  const { default: mammoth } = await import("mammoth");
  let semanticBytes: number | undefined;
  const converted = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      transformDocument: (document: unknown) =>
        assertDocxSemanticOutputBudget(
          document,
          maxExpandedBytes,
          (measuredBytes) => {
            semanticBytes = measuredBytes;
          },
        ),
    },
  );
  if (semanticBytes === undefined) {
    throw new Error("DOCX converter did not validate semantic output");
  }
  const convertedBytes = assertDocxOutputSize(
    converted.value,
    maxExpandedBytes,
  );
  const html = extractHtml(
    sourceId,
    filePath,
    `<html><body>${converted.value}</body></html>`,
    {
      maxExtractedBytes: maxExpandedBytes,
      maxChunks: defaultTextExtractionPolicyV1.maxChunks,
    },
    "DOCX",
    false,
  );
  const structured = extractMarkdown(sourceId, filePath, html.text, {
    maxExtractedBytes: maxExpandedBytes,
    maxChunks: defaultTextExtractionPolicyV1.maxChunks,
  });
  const extractedBytes = assertDocxOutputSize(
    structured.text,
    maxExpandedBytes,
  );
  return {
    extracted: { ...structured, title: html.title },
    outputPolicy: {
      version: 1,
      semanticBytes,
      convertedBytes,
      extractedBytes,
    },
  };
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

export interface EpubExtractionPolicyV1 {
  maxEntries: number;
  maxExpandedBytes: number;
  maxExtractedBytes: number;
}

export async function extractEpub(
  sourceId: string,
  filePath: string,
  bytes: Uint8Array,
  policy: EpubExtractionPolicyV1,
): Promise<ExtractedSourceV1> {
  await validateZipArchiveBudget(bytes, {
    label: "EPUB",
    maxEntries: policy.maxEntries,
    maxExpandedBytes: policy.maxExpandedBytes,
  });
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries = Object.keys(archive.files);
  if (entries.length > policy.maxEntries)
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
  const normalizedTitle = title.trim();
  if (Buffer.byteLength(normalizedTitle, "utf8") > policy.maxExtractedBytes) {
    throw new Error(
      `Extracted EPUB content exceeds configured maximum of ${policy.maxExtractedBytes} bytes`,
    );
  }
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
  let extractedBytes = 0;
  for (const [ordinal, itemRef] of itemRefs.entries()) {
    const href = hrefById.get(String(itemRef["@idref"]));
    if (!href) continue;
    const chapterPath = safeZipPath(path.posix.join(packageDirectory, href));
    const chapterHtml = await archive.file(chapterPath)?.async("string");
    if (!chapterHtml)
      throw new Error(`EPUB spine item is missing: ${chapterPath}`);
    const separatorBytes = chunks.length > 0 ? 2 : 0;
    const remainingExtractedBytes =
      policy.maxExtractedBytes - extractedBytes - separatorBytes;
    if (remainingExtractedBytes <= 0) {
      throw new Error(
        `Extracted EPUB content exceeds configured maximum of ${policy.maxExtractedBytes} bytes`,
      );
    }
    const chapter = extractHtml(
      sourceId,
      chapterPath,
      chapterHtml,
      {
        maxExtractedBytes: remainingExtractedBytes,
        maxChunks: defaultTextExtractionPolicyV1.maxChunks,
      },
      "EPUB",
      false,
    );
    if (!chapter.text) continue;
    const chapterBytes = Buffer.byteLength(chapter.text, "utf8");
    if (
      chapterBytes + separatorBytes >
      policy.maxExtractedBytes - extractedBytes
    ) {
      throw new Error(
        `Extracted EPUB content exceeds configured maximum of ${policy.maxExtractedBytes} bytes`,
      );
    }
    extractedBytes += separatorBytes + chapterBytes;
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
    title: normalizedTitle,
    text: chunks.map((chunk) => chunk.text).join("\n\n"),
    chunks,
  };
}
