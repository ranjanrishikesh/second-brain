import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
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
    extractMarkdown(id, fileName, text as string);
  else if (detected.format === "text")
    extractText(id, fileName, text as string);
  else if (detected.format === "json")
    extractJson(id, fileName, text as string);
  else if (detected.format === "jsonl")
    extractJsonLines(id, fileName, text as string);
  else if (detected.format === "csv" || detected.format === "tsv")
    extractCsv(
      id,
      fileName,
      text as string,
      detected.format === "tsv" ? "\t" : ",",
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

async function readOptional(filePath: string): Promise<Buffer | undefined> {
  return await readFile(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

async function prepareArtifactPair(
  root: string,
  sourcePath: string,
  artifact: Uint8Array,
  sidecarPath: string,
  sidecar: Uint8Array,
): Promise<void> {
  const artifactPath = path.join(root, sourcePath);
  const companionPath = path.join(root, sidecarPath);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  const assertExistingPair = async () => {
    const [existingArtifact, existingSidecar] = await Promise.all([
      readOptional(artifactPath),
      readOptional(companionPath),
    ]);
    if (
      !existingArtifact ||
      !existingSidecar ||
      !bytesEqual(existingArtifact, artifact) ||
      !bytesEqual(existingSidecar, sidecar)
    ) {
      throw new Error(
        `Prepared web artifact pair bytes do not match the requested capture: ${sourcePath}, ${sidecarPath}`,
      );
    }
  };
  const [existingArtifact, existingSidecar] = await Promise.all([
    readOptional(artifactPath),
    readOptional(companionPath),
  ]);
  if (existingArtifact || existingSidecar) {
    await assertExistingPair();
    return;
  }
  try {
    await writeFile(artifactPath, artifact, { flag: "wx" });
    await writeFile(companionPath, sidecar, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertExistingPair();
  }
}

async function prepareText(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await writeFile(absolutePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(absolutePath, "utf8")) !== content) {
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
      config.sources.pdf,
      config.sources.epub,
    );
    const digest = sha256(artifactContent);
    let linkedSession: QuerySessionV1 | undefined;
    const capture = await registerWebSourceCapture(
      root,
      async () => {
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
              discoveryMatchesRetry(candidate, input, urls, initialSession),
          );
          const retrievedAt =
            input.retrievedAt ??
            retryDiscovery?.retrievedAt ??
            new Date().toISOString();
          return {
            sourceId: duplicate.id,
            discovery: discoveryFor(input, urls, initialSession, retrievedAt),
          };
        }

        const fileName = `${slugify(input.title)}-${digest.slice(0, 12)}${detected.extension}`;
        let retrievedAt = input.retrievedAt ?? new Date().toISOString();
        let sourcePath = captureRelativePath(retrievedAt, fileName);
        if (!input.retrievedAt) {
          const preparedPaths = await filesNamed(
            path.join(root, "sources", "web"),
            fileName,
          );
          if (preparedPaths.length > 1)
            throw new Error(
              `Multiple prepared web captures exist: ${fileName}`,
            );
          const preparedPath = preparedPaths[0];
          if (preparedPath) {
            sourcePath = path
              .relative(root, preparedPath)
              .split(path.sep)
              .join("/");
            const sidecar = parseWebArtifactSidecar(
              await readFile(
                path.join(root, webArtifactSidecarPath(sourcePath)),
                "utf8",
              ),
              sourcePath,
            );
            retrievedAt = sidecar.discovery.retrievedAt;
            if (captureRelativePath(retrievedAt, fileName) !== sourcePath) {
              throw new Error(
                `Prepared web evidence path does not match its retrieval time: ${sourcePath}`,
              );
            }
          }
        }
        const discovery = discoveryFor(
          input,
          urls,
          initialSession,
          retrievedAt,
        );
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
  const capture = await registerWebSourceCapture(
    root,
    async () => {
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
          discoveryMatchesRetry(candidate, input, urls, initialSession),
        );
        const retrievedAt =
          input.retrievedAt ??
          retryDiscovery?.retrievedAt ??
          new Date().toISOString();
        return {
          sourceId: duplicate.id,
          discovery: discoveryFor(input, urls, initialSession, retrievedAt),
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
        query: initialSession.question,
        captureKind: input.captureKind,
        completeness: input.completeness,
        title: input.title,
        contentSha256: bodySha256,
        ...(previous ? { supersedes: previous.id } : {}),
      };
      const captureMarkdown = `---\n${stringify(metadata).trimEnd()}\n---\n\n# ${input.title}\n\n${normalizedBody}${normalizedBody.endsWith("\n") ? "" : "\n"}`;
      if (
        Buffer.byteLength(captureMarkdown, "utf8") > config.sources.maxFileBytes
      ) {
        throw new Error(
          `Web capture exceeds configured maximum of ${config.sources.maxFileBytes} bytes`,
        );
      }
      await prepareText(root, relativePath, captureMarkdown);
      return {
        sourcePath: relativePath,
        discovery: discoveryFor(input, urls, initialSession, retrievedAt),
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
