import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import {
  mergeCommittedWebEvidenceSource,
  type QuerySessionV1,
  readQuerySession,
} from "./query.js";
import { registerWebSourceCapture } from "./source-transaction.js";
import {
  type EpubExtractionPolicyV1,
  extractCsv,
  extractDocxWithPolicy,
  extractEpub,
  extractJson,
  extractJsonLines,
  extractMarkdown,
  extractPdf,
  extractText,
  type PdfExtractionPolicyV1,
  type TextExtractionPolicyV1,
} from "./sources/extract.js";
import { type SourceRecordV1, sourceRecordV1Schema } from "./sources/types.js";
import {
  type DetectedWebArtifactV1,
  detectWebArtifact,
  parseWebArtifactSidecar,
  parseWebCaptureMetadata,
  renderWebArtifactSidecar,
  validateWebUrlChain,
  type WebArtifactSidecarV1,
  type WebDiscoveryV1,
  webArtifactSidecarPath,
} from "./sources/web-evidence.js";
import type { TransactionTestOptions } from "./transaction.js";
import { assertWebApproval, calculateQuestionHash } from "./web-approval.js";

const legacyWebCaptureInputSchema = z.object({
  url: z.string().min(1),
  title: z.string().trim().min(1),
  captureKind: z.enum(["page", "snippet"]),
  content: z.string().min(1),
  retrievedAt: z.iso.datetime().optional(),
});

const webCaptureProvenanceSchema = z.object({
  originalUrl: z.string().min(1),
  finalUrl: z.string().min(1).optional(),
  redirectChain: z.array(z.string().min(1)).max(5).optional(),
  title: z.string().trim().min(1),
  retrievedAt: z.iso.datetime().optional(),
});

const webTextCaptureInputSchema = webCaptureProvenanceSchema
  .extend({
    representation: z.literal("text"),
    captureKind: z.enum(["page", "snippet"]),
    completeness: z.enum(["complete", "partial"]),
    content: z.string().min(1),
  })
  .superRefine((input, context) => {
    if (input.captureKind === "snippet" && input.completeness !== "partial") {
      context.addIssue({
        code: "custom",
        path: ["completeness"],
        message: "A snippet capture must be partial",
      });
    }
  });

const webArtifactCaptureInputSchema = webCaptureProvenanceSchema.extend({
  representation: z.literal("artifact"),
  fileName: z.string().min(1),
  declaredMediaType: z.string().trim().min(1).optional(),
  responseComplete: z.literal(true),
  content: z.instanceof(Uint8Array),
});

const webCaptureInputSchema = z.union([
  legacyWebCaptureInputSchema,
  webTextCaptureInputSchema,
  webArtifactCaptureInputSchema,
]);

export interface LegacyWebCaptureInput {
  url: string;
  title: string;
  captureKind: "page" | "snippet";
  content: string;
  retrievedAt?: string;
}

export interface WebCaptureProvenanceV1 {
  originalUrl: string;
  finalUrl?: string;
  redirectChain?: string[];
  title: string;
  retrievedAt?: string;
}

export interface WebTextCaptureInputV1 extends WebCaptureProvenanceV1 {
  representation: "text";
  captureKind: "page" | "snippet";
  completeness: "complete" | "partial";
  content: string;
}

export interface WebArtifactCaptureInputV1 extends WebCaptureProvenanceV1 {
  representation: "artifact";
  fileName: string;
  declaredMediaType?: string;
  responseComplete: true;
  content: Uint8Array;
}

export type WebCaptureInput =
  | LegacyWebCaptureInput
  | WebTextCaptureInputV1
  | WebArtifactCaptureInputV1;

type NormalizedWebCaptureInput =
  | WebTextCaptureInputV1
  | WebArtifactCaptureInputV1;

export interface WebCaptureResult {
  source: SourceRecordV1;
  session: QuerySessionV1;
  created: boolean;
}

export interface WebCaptureTestOptions {
  /** Deterministic fault injection; never use outside tests. */
  simulateSessionWriteFailure?: boolean;
  /** Deterministic canonical transaction faults; never use outside tests. */
  transactionTestOptions?: TransactionTestOptions;
  /** Pauses after reading a query session; used for deterministic merge races. */
  afterSessionRead?: () => Promise<void> | void;
  /** Signals that validation is complete immediately before writer waiting. */
  beforeWriterWait?: () => Promise<void> | void;
  /** Pauses after parent validation and immediately before final create validation. */
  beforePreparationCreate?: () => Promise<void> | void;
  /** Reports bounded prepared-file read progress, including the stat-only zero. */
  afterPreparedReadProgress?: (
    relativePath: string,
    bytesRead: number,
  ) => Promise<void> | void;
  /** Simulates interruption after one newly prepared artifact-pair file. */
  afterArtifactPairWrite?: (
    kind: "artifact" | "sidecar",
  ) => Promise<void> | void;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function freshWebCaptureSession(
  root: string,
  queryId: string,
): Promise<QuerySessionV1> {
  const session = await readQuerySession(root, queryId);
  if (session.status !== "open" || session.currentTier !== "web") {
    throw new Error(
      "Web evidence can only be captured for an open query at the web tier",
    );
  }
  await assertWebApproval(root, queryId);
  return session;
}

function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "web-evidence"
  );
}

async function filesNamed(
  directory: string,
  fileName: string,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  const matches: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory())
      matches.push(...(await filesNamed(absolutePath, fileName)));
    else if (entry.isFile() && entry.name === fileName)
      matches.push(absolutePath);
  }
  return matches;
}

async function preparedArtifactSourcePaths(
  root: string,
  fileName: string,
): Promise<string[]> {
  const directory = path.join(root, "sources", "web");
  const [artifactPaths, sidecarPaths] = await Promise.all([
    filesNamed(directory, fileName),
    filesNamed(directory, `.${fileName}.web.json`),
  ]);
  return [
    ...new Set([
      ...artifactPaths,
      ...sidecarPaths.map((sidecarPath) =>
        path.join(path.dirname(sidecarPath), fileName),
      ),
    ]),
  ]
    .map((absolutePath) =>
      path.relative(root, absolutePath).split(path.sep).join("/"),
    )
    .sort();
}

function captureRelativePath(retrievedAt: string, fileName: string): string {
  const retrievedDate = new Date(retrievedAt);
  const year = String(retrievedDate.getUTCFullYear());
  const month = String(retrievedDate.getUTCMonth() + 1).padStart(2, "0");
  return path.posix.join("sources", "web", year, month, fileName);
}

async function readSources(root: string): Promise<SourceRecordV1[]> {
  const manifest = JSON.parse(
    await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
  ) as { sources?: unknown[] };
  return (manifest.sources ?? []).map((source) =>
    sourceRecordV1Schema.parse(source),
  );
}

function normalizeInput(rawInput: WebCaptureInput): NormalizedWebCaptureInput {
  const parsed = webCaptureInputSchema.parse(rawInput);
  if (!("representation" in parsed)) {
    return {
      representation: "text",
      originalUrl: parsed.url,
      title: parsed.title,
      captureKind: parsed.captureKind,
      completeness: parsed.captureKind === "snippet" ? "partial" : "complete",
      content: parsed.content,
      ...(parsed.retrievedAt ? { retrievedAt: parsed.retrievedAt } : {}),
    };
  }
  if (parsed.representation === "text") {
    return {
      representation: "text",
      originalUrl: parsed.originalUrl,
      title: parsed.title,
      captureKind: parsed.captureKind,
      completeness: parsed.completeness,
      content: parsed.content,
      ...(parsed.finalUrl ? { finalUrl: parsed.finalUrl } : {}),
      ...(parsed.redirectChain ? { redirectChain: parsed.redirectChain } : {}),
      ...(parsed.retrievedAt ? { retrievedAt: parsed.retrievedAt } : {}),
    };
  }
  return {
    representation: "artifact",
    originalUrl: parsed.originalUrl,
    title: parsed.title,
    fileName: parsed.fileName,
    responseComplete: true,
    content: parsed.content,
    ...(parsed.declaredMediaType
      ? { declaredMediaType: parsed.declaredMediaType }
      : {}),
    ...(parsed.finalUrl ? { finalUrl: parsed.finalUrl } : {}),
    ...(parsed.redirectChain ? { redirectChain: parsed.redirectChain } : {}),
    ...(parsed.retrievedAt ? { retrievedAt: parsed.retrievedAt } : {}),
  };
}

function discoveryFor(
  input: NormalizedWebCaptureInput,
  urls: ReturnType<typeof validateWebUrlChain>,
  session: QuerySessionV1,
  retrievedAt: string,
): WebDiscoveryV1 {
  return {
    ...urls,
    retrievedAt,
    queryId: session.id,
    questionHash: calculateQuestionHash(session.question),
    query: session.question,
    representation: input.representation,
    completeness:
      input.representation === "artifact" ? "complete" : input.completeness,
    ...(input.representation === "text"
      ? { captureKind: input.captureKind }
      : {}),
  };
}

function sourceDiscoveries(source: SourceRecordV1): WebDiscoveryV1[] {
  return source.provenance.webDiscoveries ?? [];
}

function discoveryMatchesRetry(
  discovery: WebDiscoveryV1,
  input: NormalizedWebCaptureInput,
  urls: ReturnType<typeof validateWebUrlChain>,
  session: QuerySessionV1,
): boolean {
  return (
    discovery.queryId === session.id &&
    discovery.originalUrl === urls.originalUrl &&
    discovery.finalUrl === urls.finalUrl &&
    JSON.stringify(discovery.redirectChain) ===
      JSON.stringify(urls.redirectChain) &&
    discovery.representation === input.representation &&
    (input.representation === "artifact" ||
      (discovery.captureKind === input.captureKind &&
        discovery.completeness === input.completeness))
  );
}

function newestMatchingSource(
  sources: SourceRecordV1[],
  urls: ReturnType<typeof validateWebUrlChain>,
  excludedId?: string,
): SourceRecordV1 | undefined {
  const targetUrls = new Set([urls.originalUrl, urls.finalUrl]);
  return sources
    .filter((source) => source.id !== excludedId)
    .filter((source) => {
      const sourceUrls = new Set([
        source.provenance.url,
        source.provenance.finalUrl,
        ...sourceDiscoveries(source).flatMap((item) => [
          item.originalUrl,
          item.finalUrl,
        ]),
      ]);
      return [...targetUrls].some((url) => sourceUrls.has(url));
    })
    .sort((left, right) =>
      newestDiscoveryTime(right).localeCompare(newestDiscoveryTime(left)),
    )[0];
}

function newestDiscoveryTime(source: SourceRecordV1): string {
  return [
    source.discoveredAt,
    source.provenance.retrievedAt ?? "",
    ...sourceDiscoveries(source).map((item) => item.retrievedAt),
  ]
    .sort()
    .at(-1) as string;
}

const extractorByFormat: Readonly<
  Record<DetectedWebArtifactV1["format"], string>
> = {
  markdown: "markdown-v1",
  text: "text-v1",
  json: "json-v1",
  jsonl: "jsonl-v1",
  csv: "delimited-v1",
  tsv: "delimited-v1",
  pdf: "pdf-v1",
  docx: "docx-v1",
  epub: "epub-v1",
};

async function assertArtifactStructure(
  detected: DetectedWebArtifactV1,
  fileName: string,
  content: Uint8Array,
  maxFileBytes: number,
  textPolicy: TextExtractionPolicyV1,
  pdfPolicy: PdfExtractionPolicyV1,
  epubPolicy: EpubExtractionPolicyV1,
): Promise<void> {
  const id = "src_0000000000000000";
  const text =
    detected.format === "markdown" ||
    detected.format === "text" ||
    detected.format === "json" ||
    detected.format === "jsonl" ||
    detected.format === "csv" ||
    detected.format === "tsv"
      ? new TextDecoder("utf-8", { fatal: true }).decode(content)
      : undefined;
  if (detected.format === "markdown")
    extractMarkdown(id, fileName, text as string, textPolicy);
  else if (detected.format === "text")
    extractText(id, fileName, text as string, textPolicy);
  else if (detected.format === "json")
    extractJson(id, fileName, text as string, textPolicy);
  else if (detected.format === "jsonl")
    extractJsonLines(id, fileName, text as string, textPolicy);
  else if (detected.format === "csv" || detected.format === "tsv")
    extractCsv(
      id,
      fileName,
      text as string,
      detected.format === "tsv" ? "\t" : ",",
      textPolicy,
    );
  else if (detected.format === "pdf")
    await extractPdf(id, fileName, content, pdfPolicy);
  else if (detected.format === "docx")
    await extractDocxWithPolicy(id, fileName, content, maxFileBytes);
  else await extractEpub(id, fileName, content, epubPolicy);
}

async function linkSource(
  root: string,
  queryId: string,
  source: SourceRecordV1,
  testOptions: WebCaptureTestOptions,
): Promise<QuerySessionV1> {
  return await mergeCommittedWebEvidenceSource(root, queryId, source.id, {
    ...(testOptions.simulateSessionWriteFailure
      ? { simulateSessionWriteFailure: true }
      : {}),
    ...(testOptions.afterSessionRead
      ? { afterSessionRead: testOptions.afterSessionRead }
      : {}),
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    Buffer.from(left).equals(Buffer.from(right))
  );
}

interface WebPreparationPaths {
  root: string;
  sources: string;
  web: string;
  realRoot: string;
  realSources: string;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isContained(parent: string, candidate: string): boolean {
  return candidate.startsWith(`${parent}${path.sep}`);
}

async function webPreparationPaths(root: string): Promise<WebPreparationPaths> {
  const lexicalRoot = path.resolve(root);
  const sources = path.join(lexicalRoot, "sources");
  const metadata = await lstat(sources, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      "Web capture sources parent must be a non-symlink directory",
    );
  }
  const [realRoot, realSources] = await Promise.all([
    realpath(lexicalRoot),
    realpath(sources),
  ]);
  if (!isContained(realRoot, realSources)) {
    throw new Error("Web capture sources parent must stay inside the brain");
  }
  return {
    root: lexicalRoot,
    sources,
    web: path.join(sources, "web"),
    realRoot,
    realSources,
  };
}

function webPreparationAbsolutePath(
  paths: WebPreparationPaths,
  relativePath: string,
): string {
  const absolutePath = path.resolve(paths.root, relativePath);
  if (!isContained(paths.web, absolutePath)) {
    throw new Error(
      `Web capture path must stay below sources/web: ${relativePath}`,
    );
  }
  return absolutePath;
}

async function assertSourcesAnchor(paths: WebPreparationPaths): Promise<void> {
  const metadata = await lstat(paths.sources, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Web capture sources parent changed during preparation");
  }
  if ((await realpath(paths.sources)) !== paths.realSources) {
    throw new Error("Web capture sources parent changed during preparation");
  }
}

async function assertWebDirectoryChain(
  paths: WebPreparationPaths,
  directory: string,
): Promise<void> {
  await assertSourcesAnchor(paths);
  const relative = path.relative(paths.sources, directory);
  const components = relative.split(path.sep).filter(Boolean);
  if (components[0] !== "web" || path.isAbsolute(relative)) {
    throw new Error("Web capture parent must stay below sources/web");
  }
  let current = paths.sources;
  for (const component of components) {
    if (component === "." || component === "..") {
      throw new Error("Web capture parent must stay below sources/web");
    }
    current = path.join(current, component);
    const metadata = await lstat(current, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        `Web capture parent must be a non-symlink directory: ${current}`,
      );
    }
    const realDirectory = await realpath(current);
    if (!isContained(paths.realSources, realDirectory)) {
      throw new Error(
        "Web capture parent must stay inside the brain sources tree",
      );
    }
  }
}

async function ensureWebPreparationParent(
  root: string,
  relativePath: string,
): Promise<{ paths: WebPreparationPaths; absolutePath: string }> {
  const paths = await webPreparationPaths(root);
  const absolutePath = webPreparationAbsolutePath(paths, relativePath);
  const directory = path.dirname(absolutePath);
  const relativeDirectory = path.relative(paths.sources, directory);
  const components = relativeDirectory.split(path.sep).filter(Boolean);
  if (components[0] !== "web" || path.isAbsolute(relativeDirectory)) {
    throw new Error("Web capture parent must stay below sources/web");
  }
  let current = paths.sources;
  for (const component of components) {
    if (component === "." || component === "..") {
      throw new Error("Web capture parent must stay below sources/web");
    }
    if (current === paths.sources) await assertSourcesAnchor(paths);
    else await assertWebDirectoryChain(paths, current);
    current = path.join(current, component);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertWebDirectoryChain(paths, current);
  }
  await assertWebDirectoryChain(paths, directory);
  return { paths, absolutePath };
}

interface PreparedWebFile {
  content: Buffer;
  modifiedAt: string;
}

async function readContainedOptional(
  paths: WebPreparationPaths,
  relativePath: string,
  expectedBytes: number,
  afterReadProgress?: (
    relativePath: string,
    bytesRead: number,
  ) => Promise<void> | void,
): Promise<PreparedWebFile | undefined> {
  const absolutePath = webPreparationAbsolutePath(paths, relativePath);
  await assertWebDirectoryChain(paths, path.dirname(absolutePath));
  let metadata: BigIntStats;
  try {
    metadata = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Prepared web capture must be a non-symlink file: ${relativePath}`,
    );
  }
  const realFile = await realpath(absolutePath);
  if (!isContained(paths.realSources, realFile)) {
    throw new Error(
      `Prepared web capture must stay inside sources: ${relativePath}`,
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new Error(`Prepared web capture path changed: ${relativePath}`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(metadata, opened)) {
      throw new Error(`Prepared web capture path changed: ${relativePath}`);
    }
    await afterReadProgress?.(relativePath, 0);
    if (opened.size > BigInt(expectedBytes)) {
      throw new Error(
        `Prepared web capture exceeds requested byte length: ${relativePath}`,
      );
    }
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= expectedBytes) {
      const chunk = Buffer.alloc(
        Math.min(64 * 1024, expectedBytes + 1 - bytesRead),
      );
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
      await afterReadProgress?.(relativePath, bytesRead);
      if (bytesRead > expectedBytes) {
        throw new Error(
          `Prepared web capture exceeds requested byte length: ${relativePath}`,
        );
      }
    }
    const content = Buffer.concat(chunks, bytesRead);
    const finalOpened = await handle.stat({ bigint: true });
    const [finalPath, finalRealFile] = await Promise.all([
      lstat(absolutePath, { bigint: true }).catch(() => undefined),
      realpath(absolutePath).catch(() => undefined),
    ]);
    await assertWebDirectoryChain(paths, path.dirname(absolutePath));
    if (
      !unchangedFile(opened, finalOpened) ||
      finalOpened.size !== BigInt(content.byteLength) ||
      !finalPath?.isFile() ||
      finalPath.isSymbolicLink() ||
      !sameFileIdentity(opened, finalPath) ||
      !finalRealFile ||
      !isContained(paths.realSources, finalRealFile)
    ) {
      throw new Error(`Prepared web capture path changed: ${relativePath}`);
    }
    return {
      content,
      modifiedAt: new Date(
        Number(finalOpened.mtimeNs / 1_000_000n),
      ).toISOString(),
    };
  } finally {
    await handle.close();
  }
}

async function createContainedFile(
  paths: WebPreparationPaths,
  relativePath: string,
  content: Uint8Array,
): Promise<void> {
  const absolutePath = webPreparationAbsolutePath(paths, relativePath);
  const directory = path.dirname(absolutePath);
  await assertWebDirectoryChain(paths, directory);
  const handle = await open(
    absolutePath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o644,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const [createdPath, realFile] = await Promise.all([
      lstat(absolutePath, { bigint: true }),
      realpath(absolutePath),
    ]);
    await assertWebDirectoryChain(paths, directory);
    if (
      !opened.isFile() ||
      !createdPath.isFile() ||
      createdPath.isSymbolicLink() ||
      !sameFileIdentity(opened, createdPath) ||
      !isContained(paths.realSources, realFile)
    ) {
      throw new Error(
        `Web capture path changed before writing: ${relativePath}`,
      );
    }
    await handle.writeFile(content);
    const finalOpened = await handle.stat({ bigint: true });
    const [finalPath, finalRealFile] = await Promise.all([
      lstat(absolutePath, { bigint: true }).catch(() => undefined),
      realpath(absolutePath).catch(() => undefined),
    ]);
    await assertWebDirectoryChain(paths, directory);
    if (
      finalOpened.size !== BigInt(content.byteLength) ||
      !finalPath?.isFile() ||
      finalPath.isSymbolicLink() ||
      !sameFileIdentity(opened, finalOpened) ||
      !sameFileIdentity(opened, finalPath) ||
      !finalRealFile ||
      !isContained(paths.realSources, finalRealFile)
    ) {
      throw new Error(
        `Web capture path changed while writing: ${relativePath}`,
      );
    }
  } finally {
    await handle.close();
  }
}

async function prepareArtifactPair(
  root: string,
  sourcePath: string,
  artifact: Uint8Array,
  sidecarPath: string,
  sidecar: Uint8Array,
  beforeCreate?: () => Promise<void> | void,
  afterReadProgress?: (
    relativePath: string,
    bytesRead: number,
  ) => Promise<void> | void,
  afterWrite?: (kind: "artifact" | "sidecar") => Promise<void> | void,
): Promise<void> {
  const { paths } = await ensureWebPreparationParent(root, sourcePath);
  const companion = await ensureWebPreparationParent(root, sidecarPath);
  if (companion.paths.realSources !== paths.realSources) {
    throw new Error("Web artifact pair parents changed during preparation");
  }
  const readPair = async () => {
    const [existingArtifact, existingSidecar] = await Promise.all([
      readContainedOptional(
        paths,
        sourcePath,
        artifact.byteLength,
        afterReadProgress,
      ),
      readContainedOptional(
        paths,
        sidecarPath,
        sidecar.byteLength,
        afterReadProgress,
      ),
    ]);
    return { existingArtifact, existingSidecar };
  };
  const assertExistingPair = async () => {
    const { existingArtifact, existingSidecar } = await readPair();
    if (
      !existingArtifact ||
      !existingSidecar ||
      !bytesEqual(existingArtifact.content, artifact) ||
      !bytesEqual(existingSidecar.content, sidecar)
    ) {
      throw new Error(
        `Prepared web artifact pair bytes do not match the requested capture: ${sourcePath}, ${sidecarPath}`,
      );
    }
  };
  const { existingArtifact, existingSidecar } = await readPair();
  if (
    (existingArtifact && !bytesEqual(existingArtifact.content, artifact)) ||
    (existingSidecar && !bytesEqual(existingSidecar.content, sidecar))
  ) {
    throw new Error(
      `Prepared web artifact pair bytes do not match the requested capture: ${sourcePath}, ${sidecarPath}`,
    );
  }
  if (existingArtifact && existingSidecar) {
    return;
  }
  await beforeCreate?.();
  await assertWebDirectoryChain(
    paths,
    path.dirname(webPreparationAbsolutePath(paths, sourcePath)),
  );
  try {
    if (!existingSidecar) {
      await createContainedFile(paths, sidecarPath, sidecar);
      await afterWrite?.("sidecar");
    }
    if (!existingArtifact) {
      await assertWebDirectoryChain(
        paths,
        path.dirname(webPreparationAbsolutePath(paths, sourcePath)),
      );
      await createContainedFile(paths, sourcePath, artifact);
      await afterWrite?.("artifact");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertExistingPair();
  }
}

async function prepareText(
  root: string,
  relativePath: string,
  content: string,
  beforeCreate?: () => Promise<void> | void,
  afterReadProgress?: (
    relativePath: string,
    bytesRead: number,
  ) => Promise<void> | void,
): Promise<void> {
  const { paths } = await ensureWebPreparationParent(root, relativePath);
  const contentBytes = Buffer.from(content, "utf8");
  const existing = await readContainedOptional(
    paths,
    relativePath,
    contentBytes.byteLength,
    afterReadProgress,
  );
  if (existing) {
    if (existing.content.toString("utf8") !== content) {
      throw new Error(
        `Prepared web evidence bytes do not match the requested capture: ${relativePath}`,
      );
    }
    return;
  }
  await beforeCreate?.();
  await assertWebDirectoryChain(
    paths,
    path.dirname(webPreparationAbsolutePath(paths, relativePath)),
  );
  try {
    await createContainedFile(paths, relativePath, contentBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (
      (
        await readContainedOptional(
          paths,
          relativePath,
          contentBytes.byteLength,
          afterReadProgress,
        )
      )?.content.toString("utf8") !== content
    ) {
      throw new Error(
        `Prepared web evidence bytes do not match the requested capture: ${relativePath}`,
      );
    }
  }
}

async function findLegacyTextDuplicate(
  root: string,
  sources: SourceRecordV1[],
  input: WebTextCaptureInputV1,
  urls: ReturnType<typeof validateWebUrlChain>,
  bodySha256: string,
): Promise<SourceRecordV1 | undefined> {
  for (const source of sources) {
    if (
      source.provenance.kind !== "web" ||
      source.provenance.representation === "artifact"
    )
      continue;
    if (source.provenance.url !== urls.originalUrl) continue;
    const markdown = await readFile(path.join(root, source.path), "utf8").catch(
      () => undefined,
    );
    if (!markdown) continue;
    const metadata = parseWebCaptureMetadata(markdown);
    if (!metadata) continue;
    if (
      metadata.contentSha256 === bodySha256 &&
      metadata.captureKind === input.captureKind &&
      (metadata.completeness ??
        (metadata.captureKind === "snippet" ? "partial" : "complete")) ===
        input.completeness &&
      (metadata.finalUrl ?? metadata.originalUrl ?? metadata.url) ===
        urls.finalUrl &&
      JSON.stringify(metadata.redirectChain ?? []) ===
        JSON.stringify(urls.redirectChain)
    ) {
      return source;
    }
  }
  return undefined;
}

export async function captureWebEvidence(
  root: string,
  queryId: string,
  rawInput: WebCaptureInput,
  testOptions: WebCaptureTestOptions = {},
): Promise<WebCaptureResult> {
  const initialSession = await readQuerySession(root, queryId);
  if (
    initialSession.status !== "open" ||
    initialSession.currentTier !== "web"
  ) {
    throw new Error(
      "Web evidence can only be captured for an open query at the web tier",
    );
  }
  await assertWebApproval(root, queryId);
  const input = normalizeInput(rawInput);
  const urls = validateWebUrlChain(input);
  const config = await loadBrainConfig(root);

  if (input.representation === "artifact") {
    const artifactContent = Uint8Array.from(input.content);
    if (
      input.fileName !== path.basename(input.fileName) ||
      input.fileName.includes("\\") ||
      input.fileName.startsWith(".")
    ) {
      throw new Error("Web artifact filename must be a safe basename");
    }
    if (artifactContent.byteLength > config.sources.maxFileBytes) {
      throw new Error(
        `Web artifact exceeds configured maximum of ${config.sources.maxFileBytes} bytes`,
      );
    }
    const detected = detectWebArtifact({
      fileName: input.fileName,
      ...(input.declaredMediaType
        ? { declaredMediaType: input.declaredMediaType }
        : {}),
      content: artifactContent,
    });
    await assertArtifactStructure(
      detected,
      input.fileName,
      Uint8Array.from(artifactContent),
      config.sources.maxFileBytes,
      config.sources.textExtraction,
      config.sources.pdf,
      config.sources.epub,
    );
    const digest = sha256(artifactContent);
    let linkedSession: QuerySessionV1 | undefined;
    await testOptions.beforeWriterWait?.();
    const capture = await registerWebSourceCapture(
      root,
      async () => {
        const freshSession = await freshWebCaptureSession(root, queryId);
        const sources = await readSources(root);
        const duplicate = sources.find((source) => source.sha256 === digest);
        if (duplicate) {
          if (
            duplicate.extractor !== extractorByFormat[detected.format] ||
            duplicate.mediaType !== detected.mediaType
          ) {
            throw new Error(
              `Existing source format ${duplicate.mediaType} (${duplicate.extractor}) is not compatible with ${detected.format} web evidence (${detected.mediaType})`,
            );
          }
          const retryDiscovery = sourceDiscoveries(duplicate).find(
            (candidate) =>
              discoveryMatchesRetry(candidate, input, urls, freshSession),
          );
          const retrievedAt =
            input.retrievedAt ??
            retryDiscovery?.retrievedAt ??
            new Date().toISOString();
          return {
            sourceId: duplicate.id,
            discovery: discoveryFor(input, urls, freshSession, retrievedAt),
          };
        }

        const fileName = `${slugify(input.title)}-${digest.slice(0, 12)}${detected.extension}`;
        let retrievedAt = input.retrievedAt ?? new Date().toISOString();
        let sourcePath = captureRelativePath(retrievedAt, fileName);
        if (!input.retrievedAt) {
          const preparedPaths = await preparedArtifactSourcePaths(
            root,
            fileName,
          );
          if (preparedPaths.length > 1)
            throw new Error(
              `Multiple prepared web captures exist: ${fileName}`,
            );
          const preparedSourcePath = preparedPaths[0];
          if (preparedSourcePath) {
            sourcePath = preparedSourcePath;
            const sidecarPath = webArtifactSidecarPath(sourcePath);
            const { paths } = await ensureWebPreparationParent(
              root,
              sourcePath,
            );
            const preparedSidecar = await readContainedOptional(
              paths,
              sidecarPath,
              config.sources.maxFileBytes,
              testOptions.afterPreparedReadProgress,
            );
            if (preparedSidecar) {
              retrievedAt = parseWebArtifactSidecar(
                preparedSidecar.content.toString("utf8"),
                sourcePath,
              ).discovery.retrievedAt;
            } else {
              const preparedArtifact = await readContainedOptional(
                paths,
                sourcePath,
                artifactContent.byteLength,
                testOptions.afterPreparedReadProgress,
              );
              if (
                !preparedArtifact ||
                !bytesEqual(preparedArtifact.content, artifactContent)
              ) {
                throw new Error(
                  `Prepared web artifact bytes do not match the requested capture: ${sourcePath}`,
                );
              }
              retrievedAt = preparedArtifact.modifiedAt;
            }
            if (captureRelativePath(retrievedAt, fileName) !== sourcePath) {
              throw new Error(
                `Prepared web evidence path does not match its retrieval time: ${sourcePath}`,
              );
            }
          }
        }
        const discovery = discoveryFor(input, urls, freshSession, retrievedAt);
        const previous = newestMatchingSource(sources, urls);
        const sidecar: WebArtifactSidecarV1 = {
          brainWebArtifact: 1,
          sourcePath,
          artifactSha256: digest,
          artifactBytes: artifactContent.byteLength,
          title: input.title,
          format: detected.format,
          mediaType: detected.mediaType,
          discovery,
          ...(previous ? { supersedes: previous.id } : {}),
        };
        const sidecarPath = webArtifactSidecarPath(sourcePath);
        const sidecarBytes = Buffer.from(
          renderWebArtifactSidecar(sidecar),
          "utf8",
        );
        if (sidecarBytes.byteLength > config.sources.maxFileBytes) {
          throw new Error(
            `Web artifact sidecar exceeds configured maximum of ${config.sources.maxFileBytes} bytes`,
          );
        }
        await prepareArtifactPair(
          root,
          sourcePath,
          artifactContent,
          sidecarPath,
          sidecarBytes,
          testOptions.beforePreparationCreate,
          testOptions.afterPreparedReadProgress,
          testOptions.afterArtifactPairWrite,
        );
        return { sourcePath, discovery };
      },
      testOptions.transactionTestOptions,
      async ({ source }) => {
        linkedSession = await linkSource(root, queryId, source, testOptions);
      },
    );
    if (!linkedSession)
      throw new Error("Web evidence query linkage did not run");
    return {
      source: capture.source,
      session: linkedSession,
      created: capture.created,
    };
  }

  const normalizedBody = input.content.replace(/\r\n?/g, "\n");
  const bodySha256 = sha256(normalizedBody);
  const logicalDigest = sha256(
    JSON.stringify([
      urls.originalUrl,
      urls.finalUrl,
      urls.redirectChain,
      input.captureKind,
      input.completeness,
      normalizedBody,
    ]),
  );
  const fileName = `${slugify(input.title)}-${logicalDigest.slice(0, 12)}.md`;
  let linkedSession: QuerySessionV1 | undefined;
  await testOptions.beforeWriterWait?.();
  const capture = await registerWebSourceCapture(
    root,
    async () => {
      const freshSession = await freshWebCaptureSession(root, queryId);
      const sources = await readSources(root);
      const duplicate = await findLegacyTextDuplicate(
        root,
        sources,
        input,
        urls,
        bodySha256,
      );
      if (duplicate) {
        const retryDiscovery = sourceDiscoveries(duplicate).find((candidate) =>
          discoveryMatchesRetry(candidate, input, urls, freshSession),
        );
        const retrievedAt =
          input.retrievedAt ??
          retryDiscovery?.retrievedAt ??
          new Date().toISOString();
        return {
          sourceId: duplicate.id,
          discovery: discoveryFor(input, urls, freshSession, retrievedAt),
        };
      }

      let retrievedAt = input.retrievedAt ?? new Date().toISOString();
      let relativePath = captureRelativePath(retrievedAt, fileName);
      if (!input.retrievedAt) {
        const preparedPaths = await filesNamed(
          path.join(root, "sources", "web"),
          fileName,
        );
        if (preparedPaths.length > 1)
          throw new Error(`Multiple prepared web captures exist: ${fileName}`);
        const preparedPath = preparedPaths[0];
        if (preparedPath) {
          relativePath = path
            .relative(root, preparedPath)
            .split(path.sep)
            .join("/");
          const prepared = await readFile(preparedPath, "utf8");
          const metadata = parseWebCaptureMetadata(prepared);
          if (!metadata) {
            throw new Error(
              `Prepared web evidence bytes do not match the requested capture: ${relativePath}`,
            );
          }
          retrievedAt = metadata.retrievedAt;
          if (captureRelativePath(retrievedAt, fileName) !== relativePath) {
            throw new Error(
              `Prepared web evidence path does not match its retrieval time: ${relativePath}`,
            );
          }
        }
      }
      const previous = newestMatchingSource(sources, urls);
      const metadata = {
        brainWebCapture: 1,
        url: urls.originalUrl,
        originalUrl: urls.originalUrl,
        finalUrl: urls.finalUrl,
        redirectChain: urls.redirectChain,
        retrievedAt,
        query: freshSession.question,
        captureKind: input.captureKind,
        completeness: input.completeness,
        title: input.title,
        contentSha256: bodySha256,
        ...(previous ? { supersedes: previous.id } : {}),
      };
      const captureMarkdown = `---\n${stringify(metadata).trimEnd()}\n---\n\n# ${input.title}\n\n${normalizedBody}${normalizedBody.endsWith("\n") ? "" : "\n"}`;
      const currentConfig = await loadBrainConfig(root);
      if (
        Buffer.byteLength(captureMarkdown, "utf8") >
        currentConfig.sources.maxFileBytes
      ) {
        throw new Error(
          `Web capture exceeds configured maximum of ${currentConfig.sources.maxFileBytes} bytes`,
        );
      }
      extractMarkdown(
        "src_0000000000000000",
        relativePath,
        captureMarkdown,
        currentConfig.sources.textExtraction,
      );
      await prepareText(
        root,
        relativePath,
        captureMarkdown,
        testOptions.beforePreparationCreate,
        testOptions.afterPreparedReadProgress,
      );
      return {
        sourcePath: relativePath,
        discovery: discoveryFor(input, urls, freshSession, retrievedAt),
      };
    },
    testOptions.transactionTestOptions,
    async ({ source }) => {
      linkedSession = await linkSource(root, queryId, source, testOptions);
    },
  );
  if (!linkedSession) throw new Error("Web evidence query linkage did not run");
  return {
    source: capture.source,
    session: linkedSession,
    created: capture.created,
  };
}
