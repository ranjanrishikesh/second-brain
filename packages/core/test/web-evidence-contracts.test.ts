import { describe, expect, test } from "vitest";
import {
  brainJsonSchemasV1,
  detectWebArtifact,
  parseWebCaptureMetadata,
  renderWebArtifactSidecar,
  sourceRecordV1Schema,
  validateWebUrlChain,
  webArtifactSidecarPath,
  webArtifactSidecarV1Schema,
  webCaptureMetadataV1Schema,
  webDiscoveryV1Schema,
} from "../src/index.js";

const pdfBytes = new TextEncoder().encode("%PDF-1.7\n");
const pdfSha256 =
  "0716f9264c9fe19f5d7455276107f3ddcc1d3497f63d60689a73558ae8a1bf5e";

describe("durable web evidence contracts", () => {
  test("keeps legacy source records readable", () => {
    expect(
      sourceRecordV1Schema.parse({
        version: 1,
        id: "src_0123456789abcdef",
        sha256: "a".repeat(64),
        path: "sources/legacy.md",
        title: "Legacy",
        mediaType: "text/markdown",
        bytes: 12,
        discoveredAt: "2026-08-30T00:00:00.000Z",
        extractor: "markdown-v1",
        extractionStatus: "ready",
        extractedSha256: "b".repeat(64),
        provenance: { kind: "file" },
      }),
    ).toMatchObject({ provenance: { kind: "file" } });
  });

  test.each([
    ["a non-HTTP source URL", { url: "file:///tmp/orbits.pdf" }],
    [
      "credentials in a source URL",
      { url: "https://user:pass@example.com/orbits.pdf" },
    ],
    [
      "a private final URL",
      {
        url: "https://example.com/orbits.pdf",
        finalUrl: "https://192.168.1.8/orbits.pdf",
      },
    ],
    [
      "an overlong redirect chain",
      {
        url: "https://example.com/orbits.pdf",
        redirectChain: [
          "https://one.example/orbits.pdf",
          "https://two.example/orbits.pdf",
          "https://three.example/orbits.pdf",
          "https://four.example/orbits.pdf",
          "https://five.example/orbits.pdf",
          "https://six.example/orbits.pdf",
        ],
      },
    ],
    [
      "an HTTPS downgrade",
      {
        url: "https://example.com/orbits.pdf",
        finalUrl: "http://example.com/orbits.pdf",
      },
    ],
  ])("rejects unsafe web source provenance: %s", (_reason, provenance) => {
    expect(() =>
      sourceRecordV1Schema.parse({
        version: 1,
        id: "src_0123456789abcdef",
        sha256: "a".repeat(64),
        path: "sources/web/2026/08/orbits.pdf",
        title: "Orbits",
        mediaType: "application/pdf",
        bytes: 9,
        discoveredAt: "2026-08-30T00:00:00.000Z",
        extractor: "pdf-v1",
        extractionStatus: "extraction-required",
        provenance: { kind: "web", ...provenance },
      }),
    ).toThrow();
  });

  test("round-trips structured artifact provenance and its sidecar", () => {
    const discovery = {
      originalUrl: "https://example.com/orbits.pdf",
      finalUrl: "https://cdn.example.com/orbits.pdf",
      redirectChain: ["https://cdn.example.com/orbits.pdf"],
      retrievedAt: "2026-08-30T00:00:00.000Z",
      queryId: "qry_0123456789abcdef0123456789abcdef",
      questionHash: "c".repeat(64),
      query: "What does the orbit report conclude?",
      representation: "artifact",
      completeness: "complete",
    } as const;
    const sidecar = {
      brainWebArtifact: 1,
      sourcePath: "sources/web/2026/08/orbits-0716f9264c9f.pdf",
      artifactSha256: pdfSha256,
      artifactBytes: 9,
      title: "Orbits",
      format: "pdf",
      mediaType: "application/pdf",
      discovery,
    } as const;

    expect(webArtifactSidecarV1Schema.parse(sidecar)).toEqual(sidecar);
    expect(
      sourceRecordV1Schema.parse({
        version: 1,
        id: "src_0716f9264c9fe19f",
        sha256: pdfSha256,
        path: sidecar.sourcePath,
        title: sidecar.title,
        mediaType: sidecar.mediaType,
        bytes: sidecar.artifactBytes,
        discoveredAt: discovery.retrievedAt,
        extractor: "pdf-v1",
        extractionStatus: "extraction-required",
        provenance: {
          kind: "web",
          url: discovery.originalUrl,
          finalUrl: discovery.finalUrl,
          redirectChain: discovery.redirectChain,
          retrievedAt: discovery.retrievedAt,
          query: discovery.query,
          completeness: discovery.completeness,
          representation: discovery.representation,
          sidecarPath: "sources/web/2026/08/.orbits-0716f9264c9f.pdf.web.json",
          sidecarSha256: "d".repeat(64),
          sidecarBytes: 563,
          webDiscoveries: [discovery],
        },
      }),
    ).toMatchObject({
      provenance: {
        representation: "artifact",
        webDiscoveries: [discovery],
      },
    });
    expect(renderWebArtifactSidecar(sidecar)).toBe(
      `${JSON.stringify(sidecar, null, 2)}\n`,
    );
  });

  test("rejects unknown fields in public web contracts", () => {
    const discovery = {
      originalUrl: "https://example.com/orbits.pdf",
      finalUrl: "https://example.com/orbits.pdf",
      redirectChain: [],
      retrievedAt: "2026-08-30T00:00:00.000Z",
      queryId: "qry_0123456789abcdef0123456789abcdef",
      questionHash: "c".repeat(64),
      query: "What does the orbit report conclude?",
      representation: "artifact",
      completeness: "complete",
    };
    const sidecar = {
      brainWebArtifact: 1,
      sourcePath: "sources/web/2026/08/orbits-0716f9264c9f.pdf",
      artifactSha256: pdfSha256,
      artifactBytes: 9,
      title: "Orbits",
      format: "pdf",
      mediaType: "application/pdf",
      discovery,
    };

    expect(
      webDiscoveryV1Schema.safeParse({ ...discovery, unexpected: true })
        .success,
    ).toBe(false);
    expect(
      webArtifactSidecarV1Schema.safeParse({ ...sidecar, unexpected: true })
        .success,
    ).toBe(false);
  });

  test("publishes structural URL and artifact-path constraints", () => {
    const schema = brainJsonSchemasV1.WebArtifactSidecarV1 as {
      anyOf?: Array<{
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
      }>;
    };
    const pdfVariant = schema.anyOf?.find(
      (variant) =>
        (variant.properties?.format as { const?: unknown } | undefined)
          ?.const === "pdf",
    );
    const discovery = pdfVariant?.properties?.discovery as
      | { properties?: Record<string, unknown>; additionalProperties?: boolean }
      | undefined;

    expect(pdfVariant?.additionalProperties).toBe(false);
    expect(pdfVariant?.properties?.sourcePath).toMatchObject({
      pattern: expect.stringContaining("pdf"),
    });
    expect(discovery?.additionalProperties).toBe(false);
    expect(discovery?.properties?.originalUrl).toMatchObject({
      pattern: expect.stringContaining("^https?"),
    });

    const sourceSchema = brainJsonSchemasV1.SourceRecordV1 as {
      anyOf?: Array<{ properties?: Record<string, unknown> }>;
    };
    const provenance = sourceSchema.anyOf?.[0]?.properties?.provenance as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(provenance?.properties?.url).toMatchObject({
      pattern: expect.stringContaining("^https?"),
    });
  });

  test("derives a deterministic hidden sidecar path", () => {
    expect(
      webArtifactSidecarPath("sources/web/2026/08/orbits-0716f9264c9f.pdf"),
    ).toBe("sources/web/2026/08/.orbits-0716f9264c9f.pdf.web.json");
  });

  test("rejects a sidecar whose declared format disagrees with its artifact path", () => {
    expect(() =>
      webArtifactSidecarV1Schema.parse({
        brainWebArtifact: 1,
        sourcePath: "sources/web/2026/08/orbits-0716f9264c9f.txt",
        artifactSha256: pdfSha256,
        artifactBytes: 9,
        title: "Orbits",
        format: "pdf",
        mediaType: "application/pdf",
        discovery: {
          originalUrl: "https://example.com/orbits.pdf",
          finalUrl: "https://example.com/orbits.pdf",
          redirectChain: [],
          retrievedAt: "2026-08-30T00:00:00.000Z",
          queryId: "qry_0123456789abcdef0123456789abcdef",
          questionHash: "c".repeat(64),
          query: "What does the orbit report conclude?",
          representation: "artifact",
          completeness: "complete",
        },
      }),
    ).toThrow();
  });

  test.each([
    "sources/private/orbits-0716f9264c9f.pdf",
    "sources/web/2026/08/../orbits-0716f9264c9f.pdf",
    "sources/web/2026/08/.orbits-0716f9264c9f.pdf",
  ])("rejects an unsafe sidecar source path: %s", (sourcePath) => {
    expect(() =>
      webArtifactSidecarV1Schema.parse({
        brainWebArtifact: 1,
        sourcePath,
        artifactSha256: pdfSha256,
        artifactBytes: 9,
        title: "Orbits",
        format: "pdf",
        mediaType: "application/pdf",
        discovery: {
          originalUrl: "https://example.com/orbits.pdf",
          finalUrl: "https://example.com/orbits.pdf",
          redirectChain: [],
          retrievedAt: "2026-08-30T00:00:00.000Z",
          queryId: "qry_0123456789abcdef0123456789abcdef",
          questionHash: "c".repeat(64),
          query: "What does the orbit report conclude?",
          representation: "artifact",
          completeness: "complete",
        },
      }),
    ).toThrow();
  });

  test.each([
    ["an unsafe original URL", { originalUrl: "file:///tmp/orbits.pdf" }],
    [
      "a URL-canonicalized loopback final URL",
      { finalUrl: "https://2130706433/orbits" },
    ],
    [
      "an IPv4-mapped loopback redirect URL",
      { redirectChain: ["https://[::ffff:127.0.0.1]/orbits"] },
    ],
  ])("rejects %s while parsing structured discoveries", (_reason, override) => {
    expect(() =>
      webDiscoveryV1Schema.parse({
        originalUrl: "https://example.com/orbits",
        finalUrl: "https://example.com/orbits",
        redirectChain: [],
        retrievedAt: "2026-08-30T00:00:00.000Z",
        queryId: "qry_0123456789abcdef0123456789abcdef",
        questionHash: "c".repeat(64),
        query: "What does the orbit report conclude?",
        representation: "artifact",
        completeness: "complete",
        ...override,
      }),
    ).toThrow();
  });

  test("rejects unsafe URLs while parsing text capture metadata", () => {
    expect(() =>
      webCaptureMetadataV1Schema.parse({
        brainWebCapture: 1,
        url: "https://example.com/orbits",
        finalUrl: "http://192.168.1.8/orbits",
        retrievedAt: "2026-08-30T00:00:00.000Z",
        query: "What does the orbit report conclude?",
        captureKind: "page",
        title: "Orbits",
        contentSha256: pdfSha256,
      }),
    ).toThrow();
  });

  test("rejects an unsafe legacy URL even when an explicit original URL is safe", () => {
    expect(() =>
      webCaptureMetadataV1Schema.parse({
        brainWebCapture: 1,
        url: "file:///tmp/orbits",
        originalUrl: "https://example.com/orbits",
        retrievedAt: "2026-08-30T00:00:00.000Z",
        query: "What does the orbit report conclude?",
        captureKind: "page",
        title: "Orbits",
        contentSha256: pdfSha256,
      }),
    ).toThrow();
  });

  test("fails closed for marked invalid web capture metadata", () => {
    expect(() =>
      parseWebCaptureMetadata(
        "---\nbrainWebCapture: 1\nurl: file:///tmp/orbits\n---\n# Orbits\n",
      ),
    ).toThrow("Invalid web capture metadata");
  });

  test("ignores ordinary non-web frontmatter", () => {
    expect(
      parseWebCaptureMetadata("---\ntitle: Orbits\n---\n# Orbits\n"),
    ).toBeUndefined();
  });

  test.each([
    ["file URL", { originalUrl: "file:///tmp/orbits.pdf" }],
    ["data URL", { originalUrl: "data:text/plain,orbits" }],
    [
      "credential-bearing URL",
      { originalUrl: "https://user:pass@example.com" },
    ],
    ["localhost", { originalUrl: "https://localhost/orbits" }],
    ["loopback IPv4", { originalUrl: "https://127.0.0.1/orbits" }],
    ["private IPv4", { originalUrl: "https://192.168.1.8/orbits" }],
    ["link-local IPv4", { originalUrl: "https://169.254.169.254/latest" }],
    ["loopback IPv6", { originalUrl: "https://[::1]/orbits" }],
    ["private IPv6", { originalUrl: "https://[fd12::1]/orbits" }],
    ["link-local IPv6", { originalUrl: "https://[fe80::1]/orbits" }],
    [
      "too many redirects",
      {
        originalUrl: "https://example.com/orbits",
        redirectChain: [
          "https://one.example/orbits",
          "https://two.example/orbits",
          "https://three.example/orbits",
          "https://four.example/orbits",
          "https://five.example/orbits",
          "https://six.example/orbits",
        ],
      },
    ],
    [
      "HTTPS downgrade",
      {
        originalUrl: "https://example.com/orbits",
        finalUrl: "http://example.com/orbits",
      },
    ],
  ])("rejects unsafe URL chains: %s", (_reason, input) => {
    expect(() => validateWebUrlChain(input)).toThrow();
  });

  test("normalizes a safe URL chain without inventing redirects", () => {
    expect(
      validateWebUrlChain({
        originalUrl: "https://example.com/orbits",
        finalUrl: "https://cdn.example.com/orbits",
        redirectChain: ["https://cdn.example.com/orbits"],
      }),
    ).toEqual({
      originalUrl: "https://example.com/orbits",
      finalUrl: "https://cdn.example.com/orbits",
      redirectChain: ["https://cdn.example.com/orbits"],
    });
  });

  test("detects PDF artifacts from validated bytes", () => {
    expect(
      detectWebArtifact({
        fileName: "orbits.pdf",
        declaredMediaType: "application/pdf",
        content: pdfBytes,
      }),
    ).toEqual({
      format: "pdf",
      extension: ".pdf",
      mediaType: "application/pdf",
    });
  });

  test.each([
    ["HTML", "orbits.html", undefined, "<html>orbits</html>"],
    ["image", "orbits.png", "image/png", "\u0089PNG\r\n\u001a\n"],
    ["executable", "orbits.exe", "application/octet-stream", "MZ"],
    ["invalid UTF-8", "orbits.txt", "text/plain", new Uint8Array([0xff])],
    ["conflicting media type", "orbits.pdf", "text/plain", "%PDF-1.7\n"],
  ])(
    "rejects unsupported or misleading artifacts: %s",
    (_reason, fileName, declaredMediaType, content) => {
      expect(() =>
        detectWebArtifact({
          fileName,
          declaredMediaType,
          content:
            content instanceof Uint8Array
              ? content
              : new TextEncoder().encode(content),
        }),
      ).toThrow();
    },
  );
});
