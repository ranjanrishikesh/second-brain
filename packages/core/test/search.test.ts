import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  initBrain,
  rebuildSearchIndex,
  scanSources,
  searchBrain,
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
});
