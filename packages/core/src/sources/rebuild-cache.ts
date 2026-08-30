import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type BrainConfigV1,
  defaultTextExtractionPolicyV1,
  loadBrainConfig,
} from "../config.js";
import { assertCanonicalExtractedSource } from "./cache-integrity.js";
import { validateDocxArchive } from "./docx-archive.js";
import {
  assertDocxOutputPolicy,
  assertDocxOutputSize,
} from "./docx-output-budget.js";
import {
  extractCsv,
  extractDocx,
  extractEpub,
  extractHtml,
  extractJson,
  extractJsonLines,
  extractMarkdown,
  extractPdf,
  extractText,
} from "./extract.js";
import type { ExtractedSourceV1, SourceRecordV1 } from "./types.js";
import { assertWebEvidenceIntegrity } from "./web-evidence.js";
import { validateZipArchiveBudget } from "./zip-archive-budget.js";

async function readCanonicalSourceContent(
  root: string,
  source: SourceRecordV1,
  maxFileBytes: number,
): Promise<Buffer> {
  const sourcePath = path.resolve(root, source.path);
  const relativePath = path.relative(root, sourcePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Source path escapes brain root: ${source.path}`);
  }
  if (source.bytes > maxFileBytes) {
    throw new Error(
      `Source exceeds configured maximum of ${maxFileBytes} bytes: ${source.path}`,
    );
  }
  const handle = await open(sourcePath, "r");
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxFileBytes) {
      throw new Error(
        `Source exceeds configured maximum of ${maxFileBytes} bytes: ${source.path}`,
      );
    }
    while (bytes <= maxFileBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxFileBytes + 1 - bytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (bytes > maxFileBytes) {
    throw new Error(
      `Source exceeds configured maximum of ${maxFileBytes} bytes: ${source.path}`,
    );
  }
  const content = Buffer.concat(chunks, bytes);
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== source.sha256) {
    throw new Error(`Immutable source violation: ${source.path}`);
  }
  return content;
}

const extractionPolicyRevisionV1 = 3;

const cacheDirectoryRelativePath = path.join(".brain", "cache", "extracted");

function cachePath(root: string, sourceId: string): string {
  return path.join(root, cacheDirectoryRelativePath, `${sourceId}.json`);
}

function cachePolicyPath(root: string, sourceId: string): string {
  return path.join(root, cacheDirectoryRelativePath, `${sourceId}.policy`);
}

function currentExtractionPolicyRevision(
  source: SourceRecordV1,
  config: BrainConfigV1,
): string {
  const policy =
    source.extractor === "pdf-v1"
      ? config.sources.pdf
      : source.extractor === "epub-v1"
        ? config.sources.epub
        : source.extractor === "docx-v1"
          ? { maxFileBytes: config.sources.maxFileBytes }
          : {
              maxFileBytes: config.sources.maxFileBytes,
              textExtraction: config.sources.textExtraction,
            };
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: extractionPolicyRevisionV1,
        extractor: source.extractor,
        policy,
      }),
    )
    .digest("hex");
}

async function readCachedPolicyRevision(
  root: string,
  sourceId: string,
): Promise<string | undefined> {
  const policyPath = cachePolicyPath(root, sourceId);
  try {
    const metadata = await stat(policyPath);
    if (!metadata.isFile() || metadata.size > 256) return undefined;
    const revision = (await readFile(policyPath, "utf8")).trim();
    return /^[a-f0-9]{64}$/.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}

function maximumCacheBytes(
  source: SourceRecordV1,
  config: BrainConfigV1,
): number {
  const [maxExtractedBytes, maxChunks] =
    source.extractor === "pdf-v1"
      ? [config.sources.pdf.maxExtractedBytes, config.sources.pdf.maxPages]
      : source.extractor === "epub-v1"
        ? [
            config.sources.epub.maxExtractedBytes,
            config.sources.epub.maxEntries,
          ]
        : source.extractor === "docx-v1"
          ? [
              config.sources.maxFileBytes,
              defaultTextExtractionPolicyV1.maxChunks,
            ]
          : [
              config.sources.textExtraction.maxExtractedBytes,
              config.sources.textExtraction.maxChunks,
            ];
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    maxExtractedBytes * 6 + maxChunks * 512 + 65_536,
  );
}

function assertCachedTextExtractionPolicy(
  cached: ExtractedSourceV1,
  source: SourceRecordV1,
  config: BrainConfigV1,
): void {
  if (
    ![
      "markdown-v1",
      "text-v1",
      "html-v1",
      "json-v1",
      "jsonl-v1",
      "delimited-v1",
    ].includes(source.extractor)
  ) {
    return;
  }
  const policy = config.sources.textExtraction;
  if (cached.chunks.length > policy.maxChunks) {
    throw new Error(
      `Extracted source content exceeds configured maximum of ${policy.maxChunks} chunks: ${source.path}`,
    );
  }
  let retainedBytes = 0;
  const retainField = (field: string): void => {
    const fieldBytes = Buffer.byteLength(field, "utf8");
    if (fieldBytes > policy.maxExtractedBytes - retainedBytes) {
      throw new Error(
        `Extracted source content exceeds configured maximum of ${policy.maxExtractedBytes} bytes: ${source.path}`,
      );
    }
    retainedBytes += fieldBytes;
  };
  retainField(cached.title);
  retainField(cached.text);
  for (const chunk of cached.chunks) {
    retainField(chunk.locator);
    retainField(chunk.text);
  }
}

export async function rebuildExtractedSourceCache(
  root: string,
  source: SourceRecordV1,
): Promise<ExtractedSourceV1> {
  await assertWebEvidenceIntegrity(root, source);
  const config = await loadBrainConfig(root);
  const content = await readCanonicalSourceContent(
    root,
    source,
    config.sources.maxFileBytes,
  );

  const text = content.toString("utf8");
  const extracted =
    source.extractor === "markdown-v1"
      ? extractMarkdown(
          source.id,
          source.path,
          text,
          config.sources.textExtraction,
        )
      : source.extractor === "text-v1"
        ? extractText(
            source.id,
            source.path,
            text,
            config.sources.textExtraction,
          )
        : source.extractor === "html-v1"
          ? extractHtml(
              source.id,
              source.path,
              text,
              config.sources.textExtraction,
            )
          : source.extractor === "json-v1"
            ? extractJson(
                source.id,
                source.path,
                text,
                config.sources.textExtraction,
              )
            : source.extractor === "jsonl-v1"
              ? extractJsonLines(
                  source.id,
                  source.path,
                  text,
                  config.sources.textExtraction,
                )
              : source.extractor === "delimited-v1"
                ? extractCsv(
                    source.id,
                    source.path,
                    text,
                    source.mediaType === "text/tab-separated-values"
                      ? "\t"
                      : ",",
                    config.sources.textExtraction,
                  )
                : source.extractor === "pdf-v1"
                  ? await extractPdf(
                      source.id,
                      source.path,
                      new Uint8Array(content),
                      config.sources.pdf,
                    )
                  : source.extractor === "docx-v1"
                    ? await extractDocx(
                        source.id,
                        source.path,
                        new Uint8Array(content),
                        config.sources.maxFileBytes,
                      )
                    : source.extractor === "epub-v1"
                      ? await extractEpub(
                          source.id,
                          source.path,
                          new Uint8Array(content),
                          config.sources.epub,
                        )
                      : undefined;
  if (!extracted) {
    throw new Error(
      `Cannot rebuild cache for extractor ${source.extractor}: ${source.id}`,
    );
  }

  const canonicalExtracted = assertCanonicalExtractedSource(extracted, source);
  const cacheDirectory = path.join(root, cacheDirectoryRelativePath);
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(
    cachePath(root, source.id),
    `${JSON.stringify(canonicalExtracted, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    cachePolicyPath(root, source.id),
    `${currentExtractionPolicyRevision(source, config)}\n`,
    "utf8",
  );
  return canonicalExtracted;
}

export async function loadExtractedSourceCache(
  root: string,
  source: SourceRecordV1,
): Promise<ExtractedSourceV1> {
  await assertWebEvidenceIntegrity(root, source);
  const config = await loadBrainConfig(root);
  if (source.bytes > config.sources.maxFileBytes) {
    throw new Error(
      `Source exceeds configured maximum of ${config.sources.maxFileBytes} bytes: ${source.path}`,
    );
  }
  const requiredPolicyRevision = currentExtractionPolicyRevision(
    source,
    config,
  );
  if (
    (await readCachedPolicyRevision(root, source.id)) !== requiredPolicyRevision
  ) {
    return await rebuildExtractedSourceCache(root, source);
  }
  try {
    const metadata = await stat(cachePath(root, source.id));
    if (
      !metadata.isFile() ||
      metadata.size > maximumCacheBytes(source, config)
    ) {
      return await rebuildExtractedSourceCache(root, source);
    }
  } catch {
    return await rebuildExtractedSourceCache(root, source);
  }
  const content = await readCanonicalSourceContent(
    root,
    source,
    config.sources.maxFileBytes,
  );
  let cached: ExtractedSourceV1;
  try {
    cached = assertCanonicalExtractedSource(
      JSON.parse(await readFile(cachePath(root, source.id), "utf8")),
      source,
    );
  } catch {
    return await rebuildExtractedSourceCache(root, source);
  }
  assertCachedTextExtractionPolicy(cached, source, config);
  if (source.extractor === "docx-v1") {
    if (source.docxOutputPolicy) {
      await validateDocxArchive(
        new Uint8Array(content),
        config.sources.maxFileBytes,
      );
      assertDocxOutputPolicy(
        source.docxOutputPolicy,
        config.sources.maxFileBytes,
      );
    } else {
      const revalidated = await extractDocx(
        source.id,
        source.path,
        new Uint8Array(content),
        config.sources.maxFileBytes,
      );
      assertCanonicalExtractedSource(revalidated, source);
    }
    assertDocxOutputSize(cached.text, config.sources.maxFileBytes);
  }
  if (source.extractor === "epub-v1") {
    await validateZipArchiveBudget(new Uint8Array(content), {
      label: "EPUB",
      maxEntries: config.sources.epub.maxEntries,
      maxExpandedBytes: config.sources.epub.maxExpandedBytes,
    });
    if (
      Buffer.byteLength(cached.text, "utf8") >
      config.sources.epub.maxExtractedBytes
    ) {
      throw new Error(
        `Extracted EPUB content exceeds configured maximum of ${config.sources.epub.maxExtractedBytes} bytes`,
      );
    }
  }
  if (source.extractor === "pdf-v1") {
    const revalidated = await extractPdf(
      source.id,
      source.path,
      new Uint8Array(content),
      config.sources.pdf,
    );
    assertCanonicalExtractedSource(revalidated, source);
  }
  return cached;
}
