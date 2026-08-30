import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  initBrain,
  rebuildSearchIndex,
  renderWikiPage,
  scanSources,
  searchBrain,
  type WikiPageV1,
} from "../src/index.js";
import { loadExtractedSourceCache } from "../src/sources/rebuild-cache.js";

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function registeredWebTextArtifact(
  root: string,
  fileName = "cache-parity.txt",
) {
  const directory = "sources/web/2026/08";
  const sourcePath = `${directory}/${fileName}`;
  const sidecarPath = `${directory}/.${fileName}.web.json`;
  const markdown = fileName.endsWith(".md");
  const artifact = new TextEncoder().encode("Cache parity evidence.\n");
  const sidecar = {
    brainWebArtifact: 1,
    sourcePath,
    artifactSha256: sha256(artifact),
    artifactBytes: artifact.byteLength,
    title: "Cache parity evidence",
    format: markdown ? "markdown" : "text",
    mediaType: markdown ? "text/markdown" : "text/plain",
    discovery: {
      originalUrl: "https://example.com/cache-parity.txt",
      finalUrl: "https://example.com/cache-parity.txt",
      redirectChain: [],
      retrievedAt: "2026-08-30T00:00:00.000Z",
      queryId: "qry_0123456789abcdef0123456789abcdef",
      questionHash: "c".repeat(64),
      query: "What does the cache parity evidence say?",
      representation: "artifact",
      completeness: "complete",
    },
  };
  await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, sourcePath), artifact);
  await writeFile(
    path.join(root, sidecarPath),
    `${JSON.stringify(sidecar, null, 2)}\n`,
  );
  const source = (await scanSources(root)).added[0];
  if (!source) throw new Error("Expected registered web artifact");
  return { source, sidecarPath };
}

describe("brain search", () => {
  test.each([
    ["cached extraction", false],
    ["rebuilt extraction", true],
  ])("rejects corrupt web evidence for %s", async (_label, removeCache) => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-search-web-cache-"));
    await initBrain(root, { name: "Search", description: "Cache parity" });
    const { source, sidecarPath } = await registeredWebTextArtifact(root);
    await loadExtractedSourceCache(root, source);
    await writeFile(path.join(root, sidecarPath), "{}\n");
    if (removeCache) {
      await rm(path.join(root, ".brain", "cache"), {
        recursive: true,
        force: true,
      });
    }

    await expect(loadExtractedSourceCache(root, source)).rejects.toThrow(
      /web artifact sidecar/i,
    );
  });

  test("cannot bypass cache integrity by removing the artifact representation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-search-web-signal-"));
    await initBrain(root, {
      name: "Search",
      description: "Artifact classification",
    });
    const { source, sidecarPath } = await registeredWebTextArtifact(root);
    const manifestPath = path.join(root, ".brain", "source-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.sources[0].provenance.representation;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const tamperedSource = manifest.sources[0];
    await writeFile(path.join(root, sidecarPath), "{}\n");

    await expect(
      loadExtractedSourceCache(root, tamperedSource),
    ).rejects.toThrow(/web artifact|artifact provenance/i);
    expect(source.provenance.sidecarPath).toBe(sidecarPath);
  });

  test.each(["cache-parity.txt", "original-download.md"])(
    "cannot bypass %s artifact integrity by stripping every optional signal",
    async (fileName) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "brain-search-web-stripped-"),
      );
      await initBrain(root, {
        name: "Search",
        description: "Stripped artifact classification",
      });
      await registeredWebTextArtifact(root, fileName);
      const manifestPath = path.join(root, ".brain", "source-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const provenance = manifest.sources[0].provenance;
      delete provenance.representation;
      delete provenance.sidecarPath;
      delete provenance.sidecarSha256;
      delete provenance.sidecarBytes;
      delete provenance.webDiscoveries;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await expect(
        loadExtractedSourceCache(root, manifest.sources[0]),
      ).rejects.toThrow(/web artifact|artifact provenance|source mismatch/i);
    },
  );

  test("keeps a marked legacy web text capture cache-readable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-search-web-legacy-"));
    await initBrain(root, { name: "Search", description: "Legacy web text" });
    const directory = "sources/web/2026/08";
    const sourcePath = `${directory}/legacy.md`;
    const body = "# Legacy evidence\n\nA legacy captured fact.\n";
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(
      path.join(root, sourcePath),
      `---\nbrainWebCapture: 1\nurl: https://example.com/legacy\nretrievedAt: 2026-08-30T00:00:00.000Z\nquery: What is the legacy fact?\ncaptureKind: page\ntitle: Legacy evidence\ncontentSha256: ${sha256(body)}\n---\n${body}`,
    );
    const source = (await scanSources(root)).added[0];
    if (!source) throw new Error("Expected legacy web capture");

    await expect(loadExtractedSourceCache(root, source)).resolves.toMatchObject(
      { sourceId: source.id },
    );
  });

  test("keeps a reused local source cache-readable after web discovery enrichment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-search-local-web-"));
    await initBrain(root, { name: "Search", description: "Local web reuse" });
    await writeFile(
      path.join(root, "sources", "local.md"),
      "# Local\n\nLocally supplied evidence.\n",
    );
    const source = (await scanSources(root)).added[0];
    if (!source) throw new Error("Expected local source");
    source.provenance.webDiscoveries = [
      {
        originalUrl: "https://example.com/local-copy.md",
        finalUrl: "https://example.com/local-copy.md",
        redirectChain: [],
        retrievedAt: "2026-08-30T00:00:00.000Z",
        queryId: "qry_0123456789abcdef0123456789abcdef",
        questionHash: "c".repeat(64),
        query: "What does the local source say?",
        representation: "artifact",
        completeness: "complete",
      },
    ];

    await expect(loadExtractedSourceCache(root, source)).resolves.toMatchObject(
      { sourceId: source.id },
    );
  });

  test("finds extracted source chunks with stable locators", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-search-"));
    await initBrain(root, { name: "Search", description: "Search test" });
    await writeFile(
      path.join(root, "sources", "orbits.md"),
      "# Orbits\n\nOrbital velocity depends on distance from the central body.\n",
    );
    await scanSources(root);
    await rebuildSearchIndex(root);

    const results = await searchBrain(root, {
      query: "orbital velocity",
      scope: "sources",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "source",
      locator: "heading=orbits",
    });
    expect(results[0]?.snippet).toContain("Orbital velocity");
    await rm(root, { recursive: true, force: true });
  });

  test("rebuilds a stale cache after new sources are scanned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-search-stale-"));
    await initBrain(root, { name: "Search", description: "Stale cache test" });
    await writeFile(
      path.join(root, "sources", "first.md"),
      "# First\n\nGalaxies contain stars.\n",
    );
    await scanSources(root);
    await rebuildSearchIndex(root);
    await writeFile(
      path.join(root, "sources", "second.md"),
      "# Second\n\nNebulae contain gas.\n",
    );
    await scanSources(root);

    const results = await searchBrain(root, {
      query: "nebulae gas",
      scope: "sources",
    });

    expect(results[0]?.path).toBe("sources/second.md");
    await rm(root, { recursive: true, force: true });
  });

  test("recreates equivalent source search after the entire cache is deleted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-search-rebuild-"));
    await initBrain(root, { name: "Search", description: "Rebuild test" });
    await writeFile(
      path.join(root, "sources", "recoverable.md"),
      "# Recoverable\n\nA magnetar has an intense magnetic field.\n",
    );
    await scanSources(root);
    const before = await searchBrain(root, {
      query: "magnetar magnetic field",
      scope: "sources",
    });

    await rm(path.join(root, ".brain", "cache"), {
      recursive: true,
      force: true,
    });
    const after = await searchBrain(root, {
      query: "magnetar magnetic field",
      scope: "sources",
    });

    expect(after).toEqual(before);
    await rm(root, { recursive: true, force: true });
  });

  test("coalesces concurrent searches that discover a missing cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-search-concurrent-"));
    await initBrain(root, {
      name: "Search",
      description: "Concurrent rebuild",
    });
    await writeFile(
      path.join(root, "sources", "magnetar.md"),
      "# Magnetar\n\nA magnetar has an intense magnetic field.\n",
    );
    await scanSources(root);
    await rm(path.join(root, ".brain", "cache"), {
      recursive: true,
      force: true,
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        searchBrain(root, {
          query: "magnetar magnetic field",
          scope: "sources",
        }),
      ),
    );

    expect(results.every((result) => result[0]?.title === "Magnetar")).toBe(
      true,
    );
    await rm(root, { recursive: true, force: true });
  });

  test("indexes authored wiki sections under stable page IDs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-search-wiki-"));
    await initBrain(root, { name: "Search", description: "Wiki search test" });
    const page: WikiPageV1 = {
      schema: 1,
      id: "pg_quasar_concept",
      path: "wiki/pages/concepts/quasar.md",
      title: "Quasar",
      type: "concept",
      status: "active",
      summary: "An extremely luminous active galactic nucleus.",
      aliases: [],
      tags: ["astronomy"],
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      revision: "pending",
      sources: [],
      relations: [],
      body: "# Quasar\n\n## Emissions\n\nA quasar can emit powerful radio jets.",
    };
    await writeFile(path.join(root, page.path), renderWikiPage(page));

    const results = await searchBrain(root, {
      query: "radio jets",
      scope: "wiki",
    });

    expect(results[0]).toMatchObject({
      id: page.id,
      path: page.path,
      locator: "heading=emissions",
    });
    await rm(root, { recursive: true, force: true });
  });
});
