import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  initBrain,
  readBrainItem,
  renderWikiPage,
  scanSources,
  statusBrain,
  type WikiPageV1,
} from "../src/index.js";

describe("brain status and reading", () => {
  test("defaults legacy state to an unconfigured setup and sync status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-status-legacy-"));
    await initBrain(root, { name: "Legacy", description: "Legacy state" });
    await writeFile(
      path.join(root, ".brain", "state.json"),
      `${JSON.stringify({
        version: 1,
        catalogRevision: "empty",
        knowledgeMutations: 0,
        lastSemanticAuditMutation: 0,
        bootstrap: { status: "pending", pendingSourceIds: [] },
      })}\n`,
    );

    expect(await statusBrain(root)).toMatchObject({
      setup: { status: "not-started", required: true },
      sync: { status: "unconfigured" },
    });
  });

  test("reports canonical counts and reads page or source records by stable ID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-status-"));
    await initBrain(root, { name: "Status", description: "Status tests" });
    await writeFile(
      path.join(root, "sources", "stars.md"),
      "# Stars\n\nStars emit light.\n",
    );
    const scan = await scanSources(root);
    const source = scan.added[0];
    if (!source) throw new Error("Expected a source");
    const page: WikiPageV1 = {
      schema: 1,
      id: "pg_stars_source",
      path: "wiki/pages/sources/stars.md",
      title: "Stars source",
      type: "source",
      status: "active",
      summary: "A source about stars.",
      aliases: [],
      tags: ["astronomy"],
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      revision: "pending",
      sources: [{ id: source.id, locators: ["heading=stars"] }],
      relations: [],
      body: `# Stars source\n\nStars emit light. [@${source.id}#heading=stars]`,
    };
    await writeFile(path.join(root, page.path), renderWikiPage(page));

    const status = await statusBrain(root);
    const pageRead = await readBrainItem(root, page.id);
    await rm(path.join(root, ".brain", "cache"), {
      recursive: true,
      force: true,
    });
    const sourceRead = await readBrainItem(root, source.id, "heading=stars");

    expect(status).toMatchObject({
      version: 1,
      brain: { name: "Status" },
      sources: { total: 1, ready: 1 },
      wiki: { pages: 1 },
      bootstrap: { required: false },
      recovery: { required: false },
    });
    expect(pageRead).toMatchObject({ kind: "wiki", page: { id: page.id } });
    expect(sourceRead).toMatchObject({
      kind: "source",
      source: { id: source.id },
      chunks: [{ locator: "heading=stars" }],
    });
    await expect(readBrainItem(root, "pg_missing_page")).rejects.toThrow(
      /not found/i,
    );
  });
});
