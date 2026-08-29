import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBrainConfig } from "../config.js";
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
import { assertCanonicalExtractedSource } from "./cache-integrity.js";
import type { ExtractedSourceV1, SourceRecordV1 } from "./types.js";

export async function rebuildExtractedSourceCache(
  root: string,
  source: SourceRecordV1,
): Promise<ExtractedSourceV1> {
  const sourcePath = path.resolve(root, source.path);
  const relativePath = path.relative(root, sourcePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Source path escapes brain root: ${source.path}`);
  }
  const content = await readFile(sourcePath);
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== source.sha256) {
    throw new Error(`Immutable source violation: ${source.path}`);
  }

  const text = content.toString("utf8");
  const extracted =
    source.extractor === "markdown-v1"
      ? extractMarkdown(source.id, source.path, text)
      : source.extractor === "text-v1"
        ? extractText(source.id, source.path, text)
        : source.extractor === "html-v1"
          ? extractHtml(source.id, source.path, text)
          : source.extractor === "json-v1"
            ? extractJson(source.id, source.path, text)
            : source.extractor === "jsonl-v1"
              ? extractJsonLines(source.id, source.path, text)
              : source.extractor === "delimited-v1"
                ? extractCsv(
                    source.id,
                    source.path,
                    text,
                    source.mediaType === "text/tab-separated-values"
                      ? "\t"
                      : ",",
                  )
                : source.extractor === "pdf-v1"
                  ? await extractPdf(
                      source.id,
                      source.path,
                      new Uint8Array(content),
                    )
                  : source.extractor === "docx-v1"
                    ? await extractDocx(
                        source.id,
                        source.path,
                        new Uint8Array(content),
                        (await loadBrainConfig(root)).sources.maxFileBytes,
                      )
                    : source.extractor === "epub-v1"
                      ? await extractEpub(
                          source.id,
                          source.path,
                          new Uint8Array(content),
                        )
                      : undefined;
  if (!extracted) {
    throw new Error(
      `Cannot rebuild cache for extractor ${source.extractor}: ${source.id}`,
    );
  }

  const canonicalExtracted = assertCanonicalExtractedSource(extracted, source);
  const cacheDirectory = path.join(root, ".brain", "cache", "extracted");
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(
    path.join(cacheDirectory, `${source.id}.json`),
    `${JSON.stringify(canonicalExtracted, null, 2)}\n`,
    "utf8",
  );
  return canonicalExtracted;
}

export async function loadExtractedSourceCache(
  root: string,
  source: SourceRecordV1,
): Promise<ExtractedSourceV1> {
  try {
    return assertCanonicalExtractedSource(
      JSON.parse(
        await readFile(
          path.join(root, ".brain", "cache", "extracted", `${source.id}.json`),
          "utf8",
        ),
      ),
      source,
    );
  } catch {
    return await rebuildExtractedSourceCache(root, source);
  }
}
