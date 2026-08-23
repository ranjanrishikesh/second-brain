import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("brain search", () => {
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
