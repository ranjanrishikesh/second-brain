import { createHash } from "node:crypto";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  sourceFormatForPath,
  type WebArtifactSourceFormatV1,
} from "./format.js";

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
