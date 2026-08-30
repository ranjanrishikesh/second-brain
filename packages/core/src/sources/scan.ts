import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadBrainConfig } from "../config.js";
import { calculateExtractedSourceSha256 } from "./cache-integrity.js";
import {
  extractCsv,
  extractDocxWithPolicy,
  extractEpub,
  extractHtml,
  extractJson,
  extractJsonLines,
  extractMarkdown,
  extractPdf,
  extractText,
} from "./extract.js";
import {
  sourceRecordV1Schema,
  type DocxOutputPolicyV1,
  type ExtractedSourceV1,
  type SourceRecordV1,
  type SourceScanResult,
} from "./types.js";
import { sourceFormatForPath } from "./format.js";
import {
  parseWebArtifactSidecar,
  parseWebCaptureMetadata,
  validateWebArtifact,
  webArtifactSidecarPath,
  type ValidatedWebArtifactV1,
} from "./web-evidence.js";

interface SourceManifestV1 {
  version: 1;
  sources: SourceRecordV1[];
}

export type SourceManifestWriter = (content: string) => Promise<void>;

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readManifest(root: string): Promise<SourceManifestV1> {
  const raw = JSON.parse(
    await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
  );
  return {
    version: 1,
    sources: (raw.sources ?? []).map((source: unknown) =>
      sourceRecordV1Schema.parse(source),
    ),
  };
}

export async function scanSources(
  root: string,
  writeManifest?: SourceManifestWriter,
): Promise<SourceScanResult> {
  const config = await loadBrainConfig(root);
  const manifest = await readManifest(root);
  const registeredByPath = new Map(
    manifest.sources.map((source) => [source.path, source]),
  );
  const registeredByHash = new Map(
    manifest.sources.map((source) => [source.sha256, source]),
  );
  const seenPaths = new Set<string>();
  const result: SourceScanResult = {
    added: [],
    unchanged: [],
    modified: [],
    deleted: [],
    duplicates: [],
  };

  for (const sourceRoot of config.sources.roots) {
    const absoluteRoot = path.join(root, sourceRoot);
    const files = await walk(absoluteRoot);
    for (const absolutePath of files.sort()) {
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join("/");
      seenPaths.add(relativePath);
      const fileStats = await stat(absolutePath);
      const exceedsSizeLimit = fileStats.size > config.sources.maxFileBytes;
      const content = exceedsSizeLimit
        ? undefined
        : await readFile(absolutePath);
      const digest = content ? sha256(content) : await sha256File(absolutePath);
      const sourceFormat = sourceFormatForPath(absolutePath);
      const markdown = sourceFormat === "markdown";
      const isManagedWebEvidence = relativePath.startsWith("sources/web/");
      let webArtifact: ValidatedWebArtifactV1 | undefined;
      let webCapture: ReturnType<typeof parseWebCaptureMetadata>;
      if (isManagedWebEvidence) {
        const relativeSidecarPath = webArtifactSidecarPath(relativePath);
        let sidecarContent: Buffer | undefined;
        try {
          sidecarContent = await readFile(path.join(root, relativeSidecarPath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (sidecarContent) {
          parseWebArtifactSidecar(
            sidecarContent.toString("utf8"),
            relativePath,
          );
          if (exceedsSizeLimit || !content) {
            throw new Error(
              `Web artifact exceeds configured maximum of ${config.sources.maxFileBytes} bytes`,
            );
          }
          webArtifact = validateWebArtifact({
            sourcePath: relativePath,
            artifactContent: content,
            sidecarContent,
            maxFileBytes: config.sources.maxFileBytes,
          });
        } else {
          webCapture = markdown
            ? parseWebCaptureMetadata(content?.toString("utf8") ?? "")
            : undefined;
          if (!webCapture) {
            throw new Error(
              `Web artifact sidecar is missing: ${relativeSidecarPath}`,
            );
          }
        }
      } else {
        webCapture = markdown
          ? parseWebCaptureMetadata(content?.toString("utf8") ?? "")
          : undefined;
      }
      const registered = registeredByPath.get(relativePath);
      if (registered) {
        if (registered.sha256 !== digest) {
          result.modified.push({
            path: relativePath,
            registered,
            actualSha256: digest,
          });
        } else if (
          webArtifact &&
          (registered.provenance.sidecarPath !==
            webArtifactSidecarPath(relativePath) ||
            registered.provenance.sidecarSha256 !== webArtifact.sidecarSha256 ||
            registered.provenance.sidecarBytes !== webArtifact.sidecarBytes)
        ) {
          result.modified.push({
            path: webArtifactSidecarPath(relativePath),
            registered,
            actualSha256: webArtifact.sidecarSha256,
          });
        } else {
          result.unchanged.push(registered);
        }
        continue;
      }
      const duplicate = registeredByHash.get(digest);
      if (duplicate) {
        result.duplicates.push({
          path: relativePath,
          sourceId: duplicate.id,
          sha256: digest,
          bytes: fileStats.size,
        });
        continue;
      }

      const id = `src_${digest.slice(0, 16)}`;
      const plainText = sourceFormat === "text";
      const html = sourceFormat === "html";
      const json = sourceFormat === "json";
      const jsonLines = sourceFormat === "jsonl";
      const csv = sourceFormat === "csv";
      const tsv = sourceFormat === "tsv";
      const pdf = sourceFormat === "pdf";
      const docx = sourceFormat === "docx";
      const epub = sourceFormat === "epub";
      let extracted: ExtractedSourceV1 | undefined;
      let docxOutputPolicy: DocxOutputPolicyV1 | undefined;
      let extractionError = exceedsSizeLimit
        ? `Source exceeds configured maximum of ${config.sources.maxFileBytes} bytes`
        : undefined;
      try {
        if (!exceedsSizeLimit && docx) {
          const docxResult = await extractDocxWithPolicy(
            id,
            relativePath,
            new Uint8Array(content ?? []),
            config.sources.maxFileBytes,
          );
          extracted = docxResult.extracted;
          docxOutputPolicy = docxResult.outputPolicy;
        } else {
          extracted = exceedsSizeLimit
            ? undefined
            : markdown
              ? extractMarkdown(
                  id,
                  relativePath,
                  content?.toString("utf8") ?? "",
                )
              : plainText
                ? extractText(id, relativePath, content?.toString("utf8") ?? "")
                : html
                  ? extractHtml(
                      id,
                      relativePath,
                      content?.toString("utf8") ?? "",
                    )
                  : json
                    ? extractJson(
                        id,
                        relativePath,
                        content?.toString("utf8") ?? "",
                      )
                    : jsonLines
                      ? extractJsonLines(
                          id,
                          relativePath,
                          content?.toString("utf8") ?? "",
                        )
                      : csv || tsv
                        ? extractCsv(
                            id,
                            relativePath,
                            content?.toString("utf8") ?? "",
                            tsv ? "\t" : ",",
                          )
                        : pdf
                          ? await extractPdf(
                              id,
                              relativePath,
                              new Uint8Array(content ?? []),
                            )
                          : epub
                            ? await extractEpub(
                                id,
                                relativePath,
                                new Uint8Array(content ?? []),
                              )
                            : undefined;
        }
      } catch (error) {
        if (webArtifact) {
          throw new Error(
            `Invalid web artifact ${relativePath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        extractionError =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
      }
      const record = sourceRecordV1Schema.parse({
        version: 1,
        id,
        sha256: digest,
        path: relativePath,
        title:
          webArtifact?.sidecar.title ??
          webCapture?.title ??
          extracted?.title ??
          path.basename(relativePath),
        mediaType: webArtifact
          ? webArtifact.sidecar.mediaType
          : markdown
            ? "text/markdown"
            : plainText
              ? "text/plain"
              : html
                ? "text/html"
                : json
                  ? "application/json"
                  : jsonLines
                    ? "application/x-ndjson"
                    : csv
                      ? "text/csv"
                      : tsv
                        ? "text/tab-separated-values"
                        : pdf
                          ? "application/pdf"
                          : docx
                            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                            : epub
                              ? "application/epub+zip"
                              : "application/octet-stream",
        bytes: content?.byteLength ?? fileStats.size,
        discoveredAt: new Date().toISOString(),
        extractionStatus: extractionError
          ? "failed"
          : extracted
            ? !extracted.chunks.some((chunk) => chunk.text.trim().length > 0)
              ? "extraction-required"
              : "ready"
            : "unsupported",
        extractor: exceedsSizeLimit
          ? "none"
          : markdown
            ? "markdown-v1"
            : plainText
              ? "text-v1"
              : html
                ? "html-v1"
                : json
                  ? "json-v1"
                  : jsonLines
                    ? "jsonl-v1"
                    : csv || tsv
                      ? "delimited-v1"
                      : pdf
                        ? "pdf-v1"
                        : docx
                          ? "docx-v1"
                          : epub
                            ? "epub-v1"
                            : "none",
        ...(extracted
          ? { extractedSha256: calculateExtractedSourceSha256(extracted) }
          : {}),
        ...(docxOutputPolicy ? { docxOutputPolicy } : {}),
        provenance: webArtifact
          ? {
              kind: "web",
              url: webArtifact.sidecar.discovery.originalUrl,
              finalUrl: webArtifact.sidecar.discovery.finalUrl,
              redirectChain: webArtifact.sidecar.discovery.redirectChain,
              retrievedAt: webArtifact.sidecar.discovery.retrievedAt,
              query: webArtifact.sidecar.discovery.query,
              completeness: webArtifact.sidecar.discovery.completeness,
              representation: webArtifact.sidecar.discovery.representation,
              sidecarPath: webArtifactSidecarPath(relativePath),
              sidecarSha256: webArtifact.sidecarSha256,
              sidecarBytes: webArtifact.sidecarBytes,
              webDiscoveries: [webArtifact.sidecar.discovery],
            }
          : webCapture
            ? {
                kind: "web",
                url: webCapture.originalUrl ?? webCapture.url,
                ...(webCapture.finalUrl
                  ? { finalUrl: webCapture.finalUrl }
                  : {}),
                ...(webCapture.redirectChain
                  ? { redirectChain: webCapture.redirectChain }
                  : {}),
                retrievedAt: webCapture.retrievedAt,
                query: webCapture.query,
                captureKind: webCapture.captureKind,
                completeness:
                  webCapture.completeness ??
                  (webCapture.captureKind === "snippet"
                    ? "partial"
                    : "complete"),
                representation: "text",
              }
            : { kind: "file" },
        ...(webArtifact?.sidecar.supersedes || webCapture?.supersedes
          ? {
              supersedes:
                webArtifact?.sidecar.supersedes ?? webCapture?.supersedes,
            }
          : {}),
        ...(extractionError ? { error: extractionError } : {}),
      });
      result.added.push(record);
      manifest.sources.push(record);
      registeredByHash.set(digest, record);
      if (extracted) {
        const cacheDirectory = path.join(root, ".brain", "cache", "extracted");
        await mkdir(cacheDirectory, { recursive: true });
        await writeFile(
          path.join(cacheDirectory, `${id}.json`),
          `${JSON.stringify(extracted, null, 2)}\n`,
        );
      }
    }
  }

  result.deleted = manifest.sources.filter(
    (source) => !seenPaths.has(source.path),
  );
  manifest.sources.sort((left, right) => left.path.localeCompare(right.path));
  if (result.added.length === 0) return result;
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  if (writeManifest) await writeManifest(manifestContent);
  else
    await writeFile(
      path.join(root, ".brain", "source-manifest.json"),
      manifestContent,
    );
  return result;
}
