import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initBrain, type SourceRecordV1 } from "../src/index.js";
import { inspectWebEvidenceIntegrity } from "../src/sources/web-evidence.js";

const retrievedAt = "2026-08-30T00:00:00.000Z";
const sourceUrl = "https://example.com/orbits";
const query = "What does the orbit page say?";
const title = "Orbit evidence";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function currentCapture(body: string): string {
  return `---
brainWebCapture: 1
url: ${sourceUrl}
originalUrl: ${sourceUrl}
finalUrl: ${sourceUrl}
redirectChain: []
retrievedAt: ${retrievedAt}
query: ${query}
captureKind: page
completeness: complete
title: ${title}
contentSha256: ${sha256(body)}
---

# ${title}

${body}${body.endsWith("\n") ? "" : "\n"}`;
}

function historicalCapture(body: string): string {
  return `---
brainWebCapture: 1
url: ${sourceUrl}
retrievedAt: ${retrievedAt}
query: ${query}
captureKind: page
title: ${title}
contentSha256: ${sha256(body)}
---
${body}`;
}

async function expectValidCapture(
  content: string,
  format: "current" | "historical" = "current",
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-web-text-integrity-"));
  try {
    await initBrain(root, {
      name: "Web text integrity",
      description: "Web text integrity evidence.",
    });
    const sourcePath = "sources/web/2026/08/orbit-evidence.md";
    await mkdir(path.join(root, path.dirname(sourcePath)), { recursive: true });
    await writeFile(path.join(root, sourcePath), content);
    const sourceSha256 = sha256(content);
    const source: SourceRecordV1 = {
      version: 1,
      id: `src_${sourceSha256.slice(0, 16)}`,
      sha256: sourceSha256,
      path: sourcePath,
      title,
      mediaType: "text/markdown",
      bytes: Buffer.byteLength(content),
      discoveredAt: retrievedAt,
      extractor: "markdown-v1",
      extractionStatus: "ready",
      extractedSha256: "a".repeat(64),
      provenance: {
        kind: "web",
        url: sourceUrl,
        ...(format === "current"
          ? { finalUrl: sourceUrl, redirectChain: [] }
          : {}),
        retrievedAt,
        query,
        captureKind: "page",
        ...(format === "current" ? { representation: "text" as const } : {}),
        completeness: "complete",
      },
    };

    await expect(inspectWebEvidenceIntegrity(root, source)).resolves.toEqual(
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("web text evidence integrity", () => {
  test.each([
    ["zero trailing newlines", "Orbit facts."],
    ["one trailing newline", "Orbit facts.\n"],
    ["multiple trailing newlines", "Orbit facts.\n\n"],
    ["leading and trailing spaces", "  Orbit facts with exact spaces.  "],
  ])("preserves current capture bodies with %s", async (_label, body) => {
    await expectValidCapture(currentCapture(body));
  });

  test("keeps historical captures whose hash covers their exact legacy body", async () => {
    const body = `# ${title}\n\n  Historical orbit facts.  \n\n`;

    await expectValidCapture(historicalCapture(body), "historical");
  });
});
