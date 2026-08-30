import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { loadBrainConfig } from "../config.js";
import {
  sourceFormatForPath,
  type WebArtifactSourceFormatV1,
} from "./format.js";
import type { SourceRecordV1 } from "./types.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceIdSchema = z.string().regex(/^src_[a-f0-9]{16}$/);
const queryIdSchema = z.string().regex(/^qry_[a-f0-9]{32}$/);
const webCaptureKindV1Schema = z.enum(["page", "snippet"]);
const absoluteHttpUrlWithoutCredentialsPattern =
  /^https?:\/\/(?![^/?#\s]*@)[^/?#\s]+(?:[/?#].*)?$/;

export const webHttpUrlV1Schema = z
  .url()
  .regex(absoluteHttpUrlWithoutCredentialsPattern);

export const webCaptureRepresentationV1Schema = z.enum(["text", "artifact"]);
export type WebCaptureRepresentationV1 = z.infer<
  typeof webCaptureRepresentationV1Schema
>;

export const webCaptureCompletenessV1Schema = z.enum(["complete", "partial"]);
export type WebCaptureCompletenessV1 = z.infer<
  typeof webCaptureCompletenessV1Schema
>;

export const webDiscoveryV1Schema = z
  .object({
    originalUrl: webHttpUrlV1Schema,
    finalUrl: webHttpUrlV1Schema,
    redirectChain: z.array(webHttpUrlV1Schema).max(5),
    retrievedAt: z.string().datetime(),
    queryId: queryIdSchema,
    questionHash: sha256Schema,
    query: z.string().trim().min(1),
    representation: webCaptureRepresentationV1Schema,
    completeness: webCaptureCompletenessV1Schema,
    captureKind: webCaptureKindV1Schema.optional(),
  })
  .strict()
  .superRefine((discovery, context) => {
    try {
      validateWebUrlChain(discovery);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
export type WebDiscoveryV1 = z.infer<typeof webDiscoveryV1Schema>;

const webArtifactSidecarBaseV1Schema = z.object({
  brainWebArtifact: z.literal(1),
  artifactSha256: sha256Schema,
  artifactBytes: z.number().int().nonnegative(),
  title: z.string().trim().min(1),
  mediaType: z.string().trim().min(1),
  discovery: webDiscoveryV1Schema,
  supersedes: sourceIdSchema.optional(),
});
const reservedSidecarSuffixPattern = "[wW][eE][bB]\\.[jJ][sS][oO][nN]";

function caseInsensitiveExtensionPattern(extensions: string): string {
  return extensions
    .split("|")
    .map((extension) =>
      [...extension]
        .map((character) =>
          character >= "a" && character <= "z"
            ? `[${character}${character.toUpperCase()}]`
            : character,
        )
        .join(""),
    )
    .join("|");
}

function webArtifactSourcePathSchema(extensionPattern: string) {
  return z
    .string()
    .regex(
      new RegExp(
        `^sources/web/(?:[^./\\\\][^/\\\\]*/)*(?![^/\\\\]*\\.${reservedSidecarSuffixPattern}$)[^./\\\\][^/\\\\]*\\.(?:${caseInsensitiveExtensionPattern(extensionPattern)})$`,
      ),
    );
}

function webArtifactSidecarVariant(
  format: WebArtifactSourceFormatV1,
  extensionPattern: string,
) {
  return webArtifactSidecarBaseV1Schema
    .extend({
      format: z.literal(format),
      sourcePath: webArtifactSourcePathSchema(extensionPattern),
    })
    .strict();
}

export const webArtifactSidecarV1Schema = z
  .union([
    webArtifactSidecarVariant("markdown", "md|markdown"),
    webArtifactSidecarVariant("text", "txt"),
    webArtifactSidecarVariant("json", "json"),
    webArtifactSidecarVariant("jsonl", "jsonl"),
    webArtifactSidecarVariant("csv", "csv"),
    webArtifactSidecarVariant("tsv", "tsv"),
    webArtifactSidecarVariant("pdf", "pdf"),
    webArtifactSidecarVariant("docx", "docx"),
    webArtifactSidecarVariant("epub", "epub"),
  ])
  .superRefine((sidecar, context) => {
    try {
      assertWebArtifactSourcePath(sidecar.sourcePath);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["sourcePath"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const sourceFormat = sourceFormatForPath(sidecar.sourcePath);
    if (sourceFormat !== sidecar.format) {
      context.addIssue({
        code: "custom",
        path: ["sourcePath"],
        message: "Web artifact sidecar format must match its source path",
      });
    }
  });
export type WebArtifactSidecarV1 = z.infer<typeof webArtifactSidecarV1Schema>;

export interface DetectedWebArtifactV1 {
  format: WebArtifactSourceFormatV1;
  extension: string;
  mediaType: string;
}

export interface ValidatedWebArtifactV1 {
  sidecar: WebArtifactSidecarV1;
  detected: DetectedWebArtifactV1;
  artifactSha256: string;
  artifactBytes: number;
  sidecarSha256: string;
  sidecarBytes: number;
}

export interface WebEvidenceIntegrityIssueV1 {
  code:
    | "WEB_ARTIFACT_SIDECAR_MISSING"
    | "WEB_ARTIFACT_SIDECAR_INVALID"
    | "WEB_ARTIFACT_SIDECAR_PATH_MISMATCH"
    | "WEB_ARTIFACT_SIDECAR_HASH_MISMATCH"
    | "WEB_ARTIFACT_SOURCE_MISMATCH";
  message: string;
  path: string;
}

/**
 * Markdown frontmatter used by web text evidence. `url` remains required for
 * legacy readability; new captures may additionally record the explicit URL
 * chain fields without changing old capture bytes.
 */
export const webCaptureMetadataV1Schema = z
  .object({
    brainWebCapture: z.literal(1),
    url: webHttpUrlV1Schema,
    originalUrl: webHttpUrlV1Schema.optional(),
    finalUrl: webHttpUrlV1Schema.optional(),
    redirectChain: z.array(webHttpUrlV1Schema).max(5).optional(),
    retrievedAt: z.string().datetime(),
    query: z.string().trim().min(1),
    captureKind: webCaptureKindV1Schema,
    completeness: webCaptureCompletenessV1Schema.optional(),
    title: z.string().trim().min(1),
    contentSha256: sha256Schema,
    supersedes: sourceIdSchema.optional(),
  })
  .strict()
  .superRefine((metadata, context) => {
    try {
      validateWebUrlChain({ originalUrl: metadata.url });
      validateWebUrlChain({
        originalUrl: metadata.originalUrl ?? metadata.url,
        ...(metadata.finalUrl ? { finalUrl: metadata.finalUrl } : {}),
        ...(metadata.redirectChain
          ? { redirectChain: metadata.redirectChain }
          : {}),
      });
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
export type WebCaptureMetadataV1 = z.infer<typeof webCaptureMetadataV1Schema>;

const mediaTypeByFormat: Readonly<Record<WebArtifactSourceFormatV1, string>> = {
  markdown: "text/markdown",
  text: "text/plain",
  json: "application/json",
  jsonl: "application/x-ndjson",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
};

function unsafeIpv4(parts: number[]): boolean {
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function unsafeIpv4MappedIpv6(hostname: string): boolean {
  if (!hostname.startsWith("::ffff:")) return false;
  const mapped = hostname.slice("::ffff:".length);
  const dotted = mapped.split(".").map(Number);
  if (
    dotted.length === 4 &&
    dotted.every(
      (segment) => Number.isInteger(segment) && segment >= 0 && segment <= 255,
    )
  ) {
    return unsafeIpv4(dotted);
  }
  const groups = mapped.split(":");
  if (groups.length !== 2) return false;
  const high = Number.parseInt(groups[0] ?? "", 16);
  const low = Number.parseInt(groups[1] ?? "", 16);
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return false;
  }
  return unsafeIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
}

function unsafeHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal")
  ) {
    return true;
  }

  const ipv4 = host.split(".").map(Number);
  if (
    ipv4.length === 4 &&
    ipv4.every(
      (segment) => Number.isInteger(segment) && segment >= 0 && segment <= 255,
    )
  ) {
    return unsafeIpv4(ipv4);
  }

  const normalizedIpv6 = host.replace(/%.*$/, "");
  return (
    normalizedIpv6 === "::1" ||
    unsafeIpv4MappedIpv6(normalizedIpv6) ||
    normalizedIpv6.startsWith("fc") ||
    normalizedIpv6.startsWith("fd") ||
    normalizedIpv6.startsWith("fe8") ||
    normalizedIpv6.startsWith("fe9") ||
    normalizedIpv6.startsWith("fea") ||
    normalizedIpv6.startsWith("feb")
  );
}

function assertSafeWebUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  if (unsafeHost(parsed.hostname)) {
    throw new Error(`${label} must not target a local or private host`);
  }
  return parsed;
}

export function validateWebUrlChain(input: {
  originalUrl: string;
  finalUrl?: string;
  redirectChain?: string[];
}): { originalUrl: string; finalUrl: string; redirectChain: string[] } {
  const redirectChain = input.redirectChain ?? [];
  if (redirectChain.length > 5) {
    throw new Error(
      "Web evidence redirect chains may contain at most five hops",
    );
  }
  const original = assertSafeWebUrl(input.originalUrl, "Original URL");
  const finalUrl = input.finalUrl ?? input.originalUrl;
  const urls = [
    ...redirectChain.map((url, index) =>
      assertSafeWebUrl(url, `Redirect URL ${index + 1}`),
    ),
    assertSafeWebUrl(finalUrl, "Final URL"),
  ];
  let sawHttps = original.protocol === "https:";
  for (const url of urls) {
    if (sawHttps && url.protocol === "http:") {
      throw new Error(
        "Web evidence redirects must not downgrade HTTPS to HTTP",
      );
    }
    if (url.protocol === "https:") sawHttps = true;
  }
  return {
    originalUrl: input.originalUrl,
    finalUrl,
    redirectChain: [...redirectChain],
  };
}

function hasPdfMagic(content: Uint8Array): boolean {
  return (
    content.length >= 5 &&
    content[0] === 0x25 &&
    content[1] === 0x50 &&
    content[2] === 0x44 &&
    content[3] === 0x46 &&
    content[4] === 0x2d
  );
}

function hasZipMagic(content: Uint8Array): boolean {
  return (
    content.length >= 4 &&
    content[0] === 0x50 &&
    content[1] === 0x4b &&
    ((content[2] === 0x03 && content[3] === 0x04) ||
      (content[2] === 0x05 && content[3] === 0x06) ||
      (content[2] === 0x07 && content[3] === 0x08))
  );
}

function validateUtf8(content: Uint8Array): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error("Web artifact text must be valid UTF-8");
  }
}

function normalizedDeclaredMediaType(
  declaredMediaType?: string,
): string | undefined {
  if (declaredMediaType === undefined) return undefined;
  const mediaType = declaredMediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType) throw new Error("Declared media type must not be empty");
  return mediaType;
}

export function detectWebArtifact(input: {
  fileName: string;
  declaredMediaType?: string;
  content: Uint8Array;
}): DetectedWebArtifactV1 {
  const extension = path.extname(input.fileName).toLowerCase();
  const sourceFormat = sourceFormatForPath(input.fileName);
  if (!sourceFormat || sourceFormat === "html") {
    throw new Error("Web artifact format is unsupported");
  }
  const format: WebArtifactSourceFormatV1 = sourceFormat;
  if (format === "pdf" && !hasPdfMagic(input.content)) {
    throw new Error("Web artifact PDF bytes are missing the %PDF- signature");
  }
  if ((format === "docx" || format === "epub") && !hasZipMagic(input.content)) {
    throw new Error("Web artifact archive bytes are missing the ZIP signature");
  }
  if (
    format === "markdown" ||
    format === "text" ||
    format === "json" ||
    format === "jsonl" ||
    format === "csv" ||
    format === "tsv"
  ) {
    validateUtf8(input.content);
  }

  const declaredMediaType = normalizedDeclaredMediaType(
    input.declaredMediaType,
  );
  const mediaType = mediaTypeByFormat[format];
  if (
    declaredMediaType &&
    declaredMediaType !== "application/octet-stream" &&
    declaredMediaType !== mediaType
  ) {
    throw new Error(
      "Declared media type conflicts with the detected artifact format",
    );
  }
  return { format, extension, mediaType };
}

function assertWebArtifactSourcePath(sourcePath: string): void {
  if (
    !sourcePath.startsWith("sources/web/") ||
    sourcePath.includes("\\") ||
    sourcePath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(
      "Web artifact source path must be a safe path below sources/web/",
    );
  }
  const fileName = path.posix.basename(sourcePath);
  if (
    fileName.startsWith(".") ||
    fileName.toLowerCase().endsWith(".web.json")
  ) {
    throw new Error("Web artifact source path must name a visible artifact");
  }
  const format = sourceFormatForPath(sourcePath);
  if (!format || format === "html") {
    throw new Error(
      "Web artifact source path must use a supported artifact extension",
    );
  }
}

export function webArtifactSidecarPath(sourcePath: string): string {
  assertWebArtifactSourcePath(sourcePath);
  return path.posix.join(
    path.posix.dirname(sourcePath),
    `.${path.posix.basename(sourcePath)}.web.json`,
  );
}

export function parseWebArtifactSidecar(
  content: string,
  expectedSourcePath?: string,
): WebArtifactSidecarV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("Web artifact sidecar must be valid JSON");
  }
  const sidecar = webArtifactSidecarV1Schema.parse(raw);
  webArtifactSidecarPath(sidecar.sourcePath);
  if (expectedSourcePath && sidecar.sourcePath !== expectedSourcePath) {
    throw new Error(
      "Web artifact sidecar was derived from a different artifact path",
    );
  }
  return sidecar;
}

export function validateWebArtifact(input: {
  sourcePath: string;
  artifactContent: Uint8Array;
  sidecarContent: Uint8Array;
  maxFileBytes: number;
}): ValidatedWebArtifactV1 {
  validateUtf8(input.sidecarContent);
  const sidecar = parseWebArtifactSidecar(
    new TextDecoder("utf-8", { fatal: true }).decode(input.sidecarContent),
    input.sourcePath,
  );
  if (input.artifactContent.byteLength > input.maxFileBytes) {
    throw new Error(
      `Web artifact exceeds configured maximum of ${input.maxFileBytes} bytes`,
    );
  }
  if (
    sidecar.discovery.representation !== "artifact" ||
    sidecar.discovery.completeness !== "complete"
  ) {
    throw new Error(
      "Web artifact sidecar must describe a complete artifact representation",
    );
  }
  const detected = detectWebArtifact({
    fileName: input.sourcePath,
    declaredMediaType: sidecar.mediaType,
    content: input.artifactContent,
  });
  if (detected.format !== sidecar.format) {
    throw new Error(
      "Web artifact sidecar format must match the detected artifact format",
    );
  }
  const artifactSha256 = createHash("sha256")
    .update(input.artifactContent)
    .digest("hex");
  if (sidecar.artifactBytes !== input.artifactContent.byteLength) {
    throw new Error(
      "Web artifact byte length does not match its sidecar declaration",
    );
  }
  if (sidecar.artifactSha256 !== artifactSha256) {
    throw new Error(
      "Web artifact SHA-256 does not match its sidecar declaration",
    );
  }
  return {
    sidecar,
    detected,
    artifactSha256,
    artifactBytes: input.artifactContent.byteLength,
    sidecarSha256: createHash("sha256")
      .update(input.sidecarContent)
      .digest("hex"),
    sidecarBytes: input.sidecarContent.byteLength,
  };
}

export function parseWebCaptureMetadata(
  content: string,
): WebCaptureMetadataV1 | undefined {
  if (!content.startsWith("---\n")) return undefined;
  const closingMarker = content.indexOf("\n---\n", 4);
  if (closingMarker < 0) return undefined;
  const frontmatter = content.slice(4, closingMarker);
  let metadata: unknown;
  try {
    metadata = parse(frontmatter);
  } catch (error) {
    if (!/^brainWebCapture\s*:/mu.test(frontmatter)) return undefined;
    throw new Error(
      `Invalid web capture metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("brainWebCapture" in metadata)
  ) {
    return undefined;
  }
  const parsed = webCaptureMetadataV1Schema.safeParse(metadata);
  if (!parsed.success) {
    throw new Error(`Invalid web capture metadata: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function renderWebArtifactSidecar(
  sidecar: WebArtifactSidecarV1,
): string {
  const parsed = webArtifactSidecarV1Schema.parse(sidecar);
  webArtifactSidecarPath(parsed.sourcePath);
  const canonical = {
    brainWebArtifact: parsed.brainWebArtifact,
    sourcePath: parsed.sourcePath,
    artifactSha256: parsed.artifactSha256,
    artifactBytes: parsed.artifactBytes,
    title: parsed.title,
    format: parsed.format,
    mediaType: parsed.mediaType,
    discovery: parsed.discovery,
    ...(parsed.supersedes ? { supersedes: parsed.supersedes } : {}),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedOpenFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readIntegrityFile(
  root: string,
  relativePath: string,
  maxFileBytes: number,
  label: string,
): Promise<Buffer> {
  const absolutePath = path.resolve(root, relativePath);
  const lexicalSources = path.resolve(root, "sources");
  if (!absolutePath.startsWith(`${lexicalSources}${path.sep}`)) {
    throw new Error(`${label} must stay inside the brain sources tree`);
  }
  const metadata = await lstat(absolutePath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (metadata.size > BigInt(maxFileBytes)) {
    throw new Error(`${label} exceeds the configured size limit`);
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
    throw new Error(`${label} must stay inside the brain sources tree`);
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error(`${label} path changed during integrity inspection`);
  }
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    if (
      !openedMetadata.isFile() ||
      !sameFileIdentity(metadata, openedMetadata)
    ) {
      throw new Error(`${label} path changed during integrity inspection`);
    }
    if (openedMetadata.size > BigInt(maxFileBytes)) {
      throw new Error(`${label} exceeds the configured size limit`);
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
      throw new Error(`${label} exceeds the configured size limit`);
    }
    const finalMetadata = await handle.stat({ bigint: true });
    if (
      !unchangedOpenFile(openedMetadata, finalMetadata) ||
      finalMetadata.size !== BigInt(bytes)
    ) {
      throw new Error(`${label} changed during integrity inspection`);
    }
    const [finalRealEvidence, finalPathMetadata] = await Promise.all([
      realpath(absolutePath).catch(() => undefined),
      lstat(absolutePath, { bigint: true }).catch(() => undefined),
    ]);
    if (
      !finalRealEvidence?.startsWith(`${realSources}${path.sep}`) ||
      !finalPathMetadata?.isFile() ||
      finalPathMetadata.isSymbolicLink() ||
      !sameFileIdentity(openedMetadata, finalPathMetadata)
    ) {
      throw new Error(`${label} path changed during integrity inspection`);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await handle.close();
  }
}

function sameDiscovery(left: WebDiscoveryV1, right: WebDiscoveryV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function primaryDiscoveryMatches(
  source: SourceRecordV1,
  sidecar: WebArtifactSidecarV1,
): boolean {
  const discovery = sidecar.discovery;
  const provenance = source.provenance;
  return (
    provenance.kind === "web" &&
    provenance.url === discovery.originalUrl &&
    provenance.finalUrl === discovery.finalUrl &&
    JSON.stringify(provenance.redirectChain ?? []) ===
      JSON.stringify(discovery.redirectChain) &&
    provenance.retrievedAt === discovery.retrievedAt &&
    provenance.query === discovery.query &&
    provenance.representation === discovery.representation &&
    provenance.completeness === discovery.completeness &&
    (provenance.webDiscoveries?.some((candidate) =>
      sameDiscovery(candidate, discovery),
    ) ??
      false)
  );
}

export async function inspectWebEvidenceIntegrity(
  root: string,
  source: SourceRecordV1,
): Promise<WebEvidenceIntegrityIssueV1[]> {
  const issues: WebEvidenceIntegrityIssueV1[] = [];
  const provenance = source.provenance;
  const companionFields = [
    provenance.sidecarPath,
    provenance.sidecarSha256,
    provenance.sidecarBytes,
  ];
  const hasCompanionSignal = companionFields.some(
    (value) => value !== undefined,
  );
  const hasArtifactDiscovery = provenance.webDiscoveries?.some(
    (discovery) => discovery.representation === "artifact",
  );
  if (
    provenance.representation !== "artifact" &&
    !hasCompanionSignal &&
    !hasArtifactDiscovery
  ) {
    return [];
  }
  const hasCompleteCompanion = companionFields.every(
    (value) => value !== undefined,
  );
  if (provenance.representation !== "artifact" || !hasCompleteCompanion) {
    issues.push({
      code: "WEB_ARTIFACT_SOURCE_MISMATCH",
      message:
        "Registered web artifact provenance is inconsistent or incomplete",
      path: source.path,
    });
  }
  if (!hasCompleteCompanion) return issues;

  let expectedSidecarPath: string;
  try {
    expectedSidecarPath = webArtifactSidecarPath(source.path);
  } catch (error) {
    return [
      {
        code: "WEB_ARTIFACT_SOURCE_MISMATCH",
        message: `Registered web artifact path is invalid: ${error instanceof Error ? error.message : String(error)}`,
        path: source.path,
      },
    ];
  }
  if (source.provenance.sidecarPath !== expectedSidecarPath) {
    return [
      {
        code: "WEB_ARTIFACT_SIDECAR_PATH_MISMATCH",
        message: `Registered web artifact sidecar path does not match ${source.path}`,
        path: source.provenance.sidecarPath ?? expectedSidecarPath,
      },
    ];
  }

  const config = await loadBrainConfig(root);
  let sidecarContent: Buffer;
  try {
    sidecarContent = await readIntegrityFile(
      root,
      expectedSidecarPath,
      config.sources.maxFileBytes,
      "Web artifact sidecar",
    );
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return [
      {
        code: missing
          ? "WEB_ARTIFACT_SIDECAR_MISSING"
          : "WEB_ARTIFACT_SIDECAR_INVALID",
        message: missing
          ? `Registered web artifact sidecar is missing: ${expectedSidecarPath}`
          : `Registered web artifact sidecar is invalid: ${error instanceof Error ? error.message : String(error)}`,
        path: expectedSidecarPath,
      },
    ];
  }

  const actualSidecarSha256 = createHash("sha256")
    .update(sidecarContent)
    .digest("hex");
  if (
    source.provenance.sidecarBytes !== sidecarContent.byteLength ||
    source.provenance.sidecarSha256 !== actualSidecarSha256
  ) {
    issues.push({
      code: "WEB_ARTIFACT_SIDECAR_HASH_MISMATCH",
      message: `Registered web artifact sidecar bytes changed: ${expectedSidecarPath}`,
      path: expectedSidecarPath,
    });
  }

  let sidecar: WebArtifactSidecarV1;
  try {
    sidecar = parseWebArtifactSidecar(
      sidecarContent.toString("utf8"),
      source.path,
    );
  } catch (error) {
    issues.push({
      code: "WEB_ARTIFACT_SIDECAR_INVALID",
      message: `Registered web artifact sidecar is invalid: ${error instanceof Error ? error.message : String(error)}`,
      path: expectedSidecarPath,
    });
    return issues;
  }

  try {
    const artifactContent = await readIntegrityFile(
      root,
      source.path,
      config.sources.maxFileBytes,
      "Web artifact",
    );
    const validated = validateWebArtifact({
      sourcePath: source.path,
      artifactContent,
      sidecarContent,
      maxFileBytes: config.sources.maxFileBytes,
    });
    if (
      validated.artifactSha256 !== source.sha256 ||
      validated.artifactBytes !== source.bytes ||
      validated.detected.mediaType !== source.mediaType ||
      !primaryDiscoveryMatches(source, sidecar)
    ) {
      throw new Error(
        "artifact bytes or primary discovery metadata do not match the registered source",
      );
    }
  } catch (error) {
    const sourceIssue: WebEvidenceIntegrityIssueV1 = {
      code: "WEB_ARTIFACT_SOURCE_MISMATCH",
      message: `Registered web artifact does not match its sidecar: ${error instanceof Error ? error.message : String(error)}`,
      path: source.path,
    };
    if (
      !issues.some(
        (issue) =>
          issue.code === sourceIssue.code && issue.path === sourceIssue.path,
      )
    ) {
      issues.push(sourceIssue);
    }
  }
  return issues;
}

export async function assertWebEvidenceIntegrity(
  root: string,
  source: SourceRecordV1,
): Promise<void> {
  const issues = await inspectWebEvidenceIntegrity(root, source);
  if (issues.length === 0) return;
  throw new Error(
    `Web artifact sidecar integrity failure: ${issues
      .map((issue) => `${issue.code}: ${issue.message}`)
      .join("; ")}`,
  );
}
