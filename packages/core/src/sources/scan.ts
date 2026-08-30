import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
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
import { sourceFormatForPath } from "./format.js";
import {
  effectiveSourceRoots,
  type InspectedRepositoryEntry,
  inspectRepositoryEntry,
  openStableRepositoryFile,
  sameFileIdentity,
  unchangedRepositoryEntry,
  walkSourceFiles,
} from "./path-safety.js";
import {
  type DocxOutputPolicyV1,
  type ExtractedSourceV1,
  type SourceRecordV1,
  type SourceScanResult,
  sourceRecordV1Schema,
} from "./types.js";
import {
  parseWebArtifactSidecar,
  parseWebCaptureMetadata,
  type ValidatedWebArtifactV1,
  validateWebArtifact,
  webArtifactSidecarPath,
} from "./web-evidence.js";

interface SourceManifestV1 {
  version: 1;
  sources: SourceRecordV1[];
}

export type SourceManifestWriter = (content: string) => Promise<void>;

export interface SourceScanTestOptions {
  /** Deterministic seam for replacing a managed web-evidence path after its initial validation. */
  afterInitialWebEvidencePathValidation?: (
    kind: "artifact" | "sidecar",
    relativePath: string,
  ) => Promise<void> | void;
  /** Deterministic seam for replacing an ordinary source after discovery. */
  beforeLocalSourceRead?: (relativePath: string) => Promise<void> | void;
  /** Deterministic seam for changing an ordinary source after an opened-handle read. */
  afterLocalSourceChunkRead?: (
    relativePath: string,
    cumulativeBytesRead: number,
  ) => Promise<void> | void;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readOrdinarySource(
  root: string,
  relativePath: string,
  discovered: InspectedRepositoryEntry,
  maxFileBytes: number,
  testOptions: SourceScanTestOptions,
): Promise<{ bytes: number; digest: string; content?: Buffer }> {
  await testOptions.beforeLocalSourceRead?.(relativePath);
  let inspected: InspectedRepositoryEntry | undefined;
  try {
    inspected = await inspectRepositoryEntry(
      root,
      relativePath,
      "file",
      `Source path ${relativePath}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/symbolic link|outside the brain root/i.test(message)) throw error;
    throw new Error(
      `Source changed while scanning ${relativePath}; retry after its bytes are stable`,
    );
  }
  if (
    !inspected ||
    !unchangedRepositoryEntry(discovered.metadata, inspected.metadata) ||
    discovered.realPath !== inspected.realPath
  ) {
    throw new Error(
      `Source changed while scanning ${relativePath}; retry after its bytes are stable`,
    );
  }
  let openedFile: Awaited<ReturnType<typeof openStableRepositoryFile>>;
  try {
    openedFile = await openStableRepositoryFile(inspected);
  } catch {
    throw new Error(
      `Source changed while scanning ${relativePath}; retry after its bytes are stable`,
    );
  }
  const { handle, metadata: opened } = openedFile;
  try {
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let bytes = 0;
    const retainContent = opened.size <= BigInt(maxFileBytes);
    const readLimitBigInt = retainContent
      ? BigInt(maxFileBytes) + 1n
      : opened.size + 1n;
    if (readLimitBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `Source exceeds the safely supported size limit while scanning ${relativePath}`,
      );
    }
    const readLimit = Number(readLimitBigInt);
    while (bytes <= readLimit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, readLimit - bytes));
      if (chunk.byteLength === 0) break;
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      const readChunk = chunk.subarray(0, result.bytesRead);
      bytes += result.bytesRead;
      hash.update(readChunk);
      if (retainContent) chunks.push(readChunk);
      await testOptions.afterLocalSourceChunkRead?.(relativePath, bytes);
      if (retainContent && bytes > maxFileBytes) break;
    }
    const finalOpened = await handle.stat({ bigint: true });
    let finalPath: InspectedRepositoryEntry | undefined;
    try {
      finalPath = await inspectRepositoryEntry(
        root,
        relativePath,
        "file",
        `Source path ${relativePath}`,
      );
    } catch {
      throw new Error(
        `Source changed while scanning ${relativePath}; retry after its bytes are stable`,
      );
    }
    if (
      (retainContent && bytes > maxFileBytes) ||
      finalOpened.size !== BigInt(bytes) ||
      !unchangedRepositoryEntry(opened, finalOpened) ||
      !finalPath ||
      !unchangedRepositoryEntry(opened, finalPath.metadata) ||
      finalPath.realPath !== inspected.realPath
    ) {
      throw new Error(
        `Source changed while scanning ${relativePath}; retry after its bytes are stable`,
      );
    }
    return {
      bytes,
      digest: hash.digest("hex"),
      ...(retainContent ? { content: Buffer.concat(chunks, bytes) } : {}),
    };
  } finally {
    await handle.close();
  }
}

async function readBoundedWebEvidenceFile(
  root: string,
  relativePath: string,
  maxFileBytes: number,
  kind: "artifact" | "sidecar",
  testOptions: SourceScanTestOptions,
): Promise<Buffer | undefined> {
  const label = kind === "artifact" ? "Web artifact" : "Web artifact sidecar";
  const absolutePath = path.resolve(root, relativePath);
  const lexicalSources = path.resolve(root, "sources");
  if (!absolutePath.startsWith(`${lexicalSources}${path.sep}`)) {
    throw new Error(
      `${label} must stay inside the brain sources tree: ${relativePath}`,
    );
  }
  let metadata: BigIntStats;
  try {
    metadata = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      kind === "sidecar"
    ) {
      return undefined;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `${label} must be a regular non-symlink file: ${relativePath}`,
    );
  }
  if (metadata.size > BigInt(maxFileBytes)) {
    throw new Error(
      `${label} exceeds configured maximum of ${maxFileBytes} bytes: ${relativePath}`,
    );
  }
  const [realRoot, realSources, realEvidence] = await Promise.all([
    realpath(root),
    realpath(path.join(root, "sources")),
    realpath(absolutePath),
  ]);
  if (
    !realSources.startsWith(`${realRoot}${path.sep}`) ||
    !realEvidence.startsWith(`${realSources}${path.sep}`)
  ) {
    throw new Error(
      `${label} must stay inside the brain sources tree: ${relativePath}`,
    );
  }
  await testOptions.afterInitialWebEvidencePathValidation?.(kind, relativePath);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new Error(`${label} path changed while scanning: ${relativePath}`);
  }
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    if (
      !openedMetadata.isFile() ||
      !sameFileIdentity(metadata, openedMetadata)
    ) {
      throw new Error(`${label} path changed while scanning: ${relativePath}`);
    }
    if (openedMetadata.size > BigInt(maxFileBytes)) {
      throw new Error(
        `${label} exceeds configured maximum of ${maxFileBytes} bytes: ${relativePath}`,
      );
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= maxFileBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxFileBytes + 1 - bytes));
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
    }
    if (bytes > maxFileBytes) {
      throw new Error(
        `${label} exceeds configured maximum of ${maxFileBytes} bytes: ${relativePath}`,
      );
    }
    const finalMetadata = await handle.stat({ bigint: true });
    if (
      !unchangedRepositoryEntry(openedMetadata, finalMetadata) ||
      finalMetadata.size !== BigInt(bytes)
    ) {
      throw new Error(`${label} changed while scanning: ${relativePath}`);
    }
    const finalRealEvidence = await realpath(absolutePath).catch(
      () => undefined,
    );
    if (!finalRealEvidence?.startsWith(`${realSources}${path.sep}`)) {
      throw new Error(
        `${label} must stay inside the brain sources tree: ${relativePath}`,
      );
    }
    const finalPathMetadata = await lstat(absolutePath, { bigint: true }).catch(
      () => undefined,
    );
    if (
      !finalPathMetadata?.isFile() ||
      finalPathMetadata.isSymbolicLink() ||
      !sameFileIdentity(openedMetadata, finalPathMetadata)
    ) {
      throw new Error(`${label} path changed while scanning: ${relativePath}`);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await handle.close();
  }
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
  testOptions: SourceScanTestOptions = {},
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

  const candidates = new Map<string, InspectedRepositoryEntry>();
  for (const candidate of await walkSourceFiles(
    root,
    effectiveSourceRoots(config.sources.roots),
  )) {
    candidates.set(candidate.relativePath, candidate.entry);
  }

  const orderedCandidateGroups = [
    [...candidates.entries()].filter(
      ([relativePath]) => !relativePath.startsWith("sources/web/"),
    ),
    [...candidates.entries()].filter(([relativePath]) =>
      relativePath.startsWith("sources/web/"),
    ),
  ].map((group) =>
    group.sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),
  );
  for (const candidateGroup of orderedCandidateGroups) {
    for (const [relativePath, candidate] of candidateGroup) {
      const absolutePath = candidate.absolutePath;
      seenPaths.add(relativePath);
      const sourceFormat = sourceFormatForPath(absolutePath);
      const markdown = sourceFormat === "markdown";
      const isManagedWebEvidence = relativePath.startsWith("sources/web/");
      const managedContent = isManagedWebEvidence
        ? await readBoundedWebEvidenceFile(
            root,
            relativePath,
            config.sources.maxFileBytes,
            "artifact",
            testOptions,
          )
        : undefined;
      const ordinarySource = isManagedWebEvidence
        ? undefined
        : await readOrdinarySource(
            root,
            relativePath,
            candidate,
            config.sources.maxFileBytes,
            testOptions,
          );
      const sourceBytes =
        managedContent?.byteLength ?? ordinarySource?.bytes ?? 0;
      const exceedsSizeLimit = sourceBytes > config.sources.maxFileBytes;
      const content = exceedsSizeLimit
        ? undefined
        : (managedContent ?? ordinarySource?.content);
      const digest =
        ordinarySource?.digest ?? sha256(content ?? new Uint8Array());
      let webArtifact: ValidatedWebArtifactV1 | undefined;
      let webCapture: ReturnType<typeof parseWebCaptureMetadata>;
      if (isManagedWebEvidence) {
        const relativeSidecarPath = webArtifactSidecarPath(relativePath);
        const sidecarContent = await readBoundedWebEvidenceFile(
          root,
          relativeSidecarPath,
          config.sources.maxFileBytes,
          "sidecar",
          testOptions,
        );
        if (sidecarContent) {
          try {
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
          } catch (error) {
            throw new Error(
              `Invalid web artifact ${relativePath}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
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
      const extractCurrentSource = async (failClosed: boolean) => {
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
                    config.sources.textExtraction,
                  )
                : plainText
                  ? extractText(
                      id,
                      relativePath,
                      content?.toString("utf8") ?? "",
                      config.sources.textExtraction,
                    )
                  : html
                    ? extractHtml(
                        id,
                        relativePath,
                        content?.toString("utf8") ?? "",
                        config.sources.textExtraction,
                      )
                    : json
                      ? extractJson(
                          id,
                          relativePath,
                          content?.toString("utf8") ?? "",
                          config.sources.textExtraction,
                        )
                      : jsonLines
                        ? extractJsonLines(
                            id,
                            relativePath,
                            content?.toString("utf8") ?? "",
                            config.sources.textExtraction,
                          )
                        : csv || tsv
                          ? extractCsv(
                              id,
                              relativePath,
                              content?.toString("utf8") ?? "",
                              tsv ? "\t" : ",",
                              config.sources.textExtraction,
                            )
                          : pdf
                            ? await extractPdf(
                                id,
                                relativePath,
                                new Uint8Array(content ?? []),
                                config.sources.pdf,
                              )
                            : epub
                              ? await extractEpub(
                                  id,
                                  relativePath,
                                  new Uint8Array(content ?? []),
                                  config.sources.epub,
                                )
                              : undefined;
          }
        } catch (error) {
          if (failClosed) {
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
      };
      if (webArtifact) await extractCurrentSource(true);
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
          bytes: sourceBytes,
          ...(webArtifact
            ? {
                sidecarPath: webArtifactSidecarPath(relativePath),
                sidecarSha256: webArtifact.sidecarSha256,
                sidecarBytes: webArtifact.sidecarBytes,
              }
            : {}),
        });
        continue;
      }
      if (!webArtifact) await extractCurrentSource(false);
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
        bytes: content?.byteLength ?? sourceBytes,
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
