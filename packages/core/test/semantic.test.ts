import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  initBrain,
  createLocalEmbeddingProvider,
  renderWikiPage,
  scanSources,
  searchBrain,
  semanticSearch,
  type BrainRuntimeServices,
  type WikiPageV1,
} from "../src/index.js";
import { streamVerifiedResponse } from "../src/semantic.js";
import { deterministicEmbeddings } from "./helpers/embeddings.js";

function page(
  id: string,
  title: string,
  body: string,
  pathSuffix: string,
): WikiPageV1 {
  return {
    schema: 1,
    id,
    path: `wiki/pages/concepts/${pathSuffix}.md`,
    title,
    type: "concept",
    status: "active",
    summary: body,
    aliases: [],
    tags: ["astronomy"],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    revision: "pending",
    sources: [],
    relations: [],
    body: `# ${title}\n\n${body}`,
  };
}

describe("local semantic search", () => {
  test("streams a verified model download without retaining its response body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-semantic-stream-"));
    const destination = path.join(root, "model", "artifact.bin");
    const bytes = new TextEncoder().encode("streamed model artifact");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 8));
          controller.enqueue(bytes.slice(8));
          controller.close();
        },
      }),
    );
    Object.defineProperty(response, "arrayBuffer", {
      value: async () => {
        throw new Error("The downloader must stream rather than buffer models");
      },
    });
    await streamVerifiedResponse(destination, response, expectedSha256);

    expect(await readFile(destination, "utf8")).toBe("streamed model artifact");
  });

  test("rejects a corrupt pinned artifact before initializing the model", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-semantic-model-"));
    await initBrain(root, { name: "Semantic", description: "Semantic test" });
    const artifact = path.join(
      root,
      ".brain",
      "cache",
      "models",
      "Xenova",
      "multilingual-e5-small",
      "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
      "onnx",
      "model_quantized.onnx",
    );
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, "corrupt model bytes", "utf8");

    const { env } = await import("@huggingface/transformers");
    const allowRemoteModels = env.allowRemoteModels;
    env.allowRemoteModels = false;
    try {
      await expect(
        createLocalEmbeddingProvider(root).embed(["semantic probe"]),
      ).rejects.toThrow(
        /Pinned semantic model checksum mismatch: expected f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193/,
      );
    } finally {
      env.allowRemoteModels = allowRemoteModels;
    }
  });

  test("finds a wiki page when lexical terms do not overlap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-semantic-wiki-"));
    await initBrain(root, { name: "Semantic", description: "Semantic test" });
    const blackHole = page(
      "pg_black_hole",
      "Black hole",
      "An event horizon traps light around a collapsed star.",
      "black-hole",
    );
    const accretion = page(
      "pg_accretion_disk",
      "Accretion disk",
      "Matter spirals around a compact object.",
      "accretion-disk",
    );
    await writeFile(path.join(root, blackHole.path), renderWikiPage(blackHole));
    await writeFile(path.join(root, accretion.path), renderWikiPage(accretion));

    const results = await searchBrain(
      root,
      { query: "gravity well", scope: "wiki", ranking: "hybrid" },
      {
        embeddings: deterministicEmbeddings({
          "gravity well": [1, 0],
          "event horizon": [1, 0],
          "accretion disk": [0, 1],
        }),
      },
    );

    expect(results[0]?.id).toBe("pg_black_hole");
  });

  test("resolves an embedding provider once for a semantic search", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-semantic-owner-"));
    await initBrain(root, { name: "Semantic", description: "Semantic test" });
    const blackHole = page(
      "pg_semantic_owner",
      "Black hole",
      "An event horizon traps light around a collapsed star.",
      "semantic-owner",
    );
    await writeFile(path.join(root, blackHole.path), renderWikiPage(blackHole));
    const provider = deterministicEmbeddings({
      "gravity well": [1, 0],
      "event horizon": [1, 0],
    });
    let providerResolutions = 0;
    const services = {} as BrainRuntimeServices;
    Object.defineProperty(services, "embeddings", {
      get() {
        providerResolutions += 1;
        return provider;
      },
    });

    await semanticSearch(root, "gravity well", "wiki", 10, services);

    expect(providerResolutions).toBe(1);
  });

  test("rebuilds semantic source search after the semantic cache is deleted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-semantic-source-"));
    await initBrain(root, { name: "Semantic", description: "Semantic test" });
    await writeFile(
      path.join(root, "sources", "pulsar.md"),
      "# Pulsar\n\nA rapidly spinning neutron star emits radio pulses.\n",
    );
    const scan = await scanSources(root);
    const sourceId = scan.added[0]?.id;
    if (!sourceId) throw new Error("Expected a registered source");
    const services = {
      embeddings: deterministicEmbeddings({
        "stellar lighthouse": [0, 1],
        "rapidly spinning": [0, 1],
      }),
    };

    const before = await searchBrain(
      root,
      { query: "stellar lighthouse", scope: "sources", ranking: "hybrid" },
      services,
    );
    await rm(path.join(root, ".brain", "cache", "semantic-index.json"), {
      force: true,
    });
    const after = await searchBrain(
      root,
      { query: "stellar lighthouse", scope: "sources", ranking: "hybrid" },
      services,
    );

    expect(before[0]?.id).toBe(sourceId);
    expect(after).toEqual(before);
  });

  test("retries a semantic rebuild when the corpus changes during embedding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-semantic-race-"));
    await initBrain(root, { name: "Semantic", description: "Semantic test" });
    const existing = page(
      "pg_existing_semantic",
      "Existing concept",
      "A stable concept that is not a stellar nursery.",
      "existing",
    );
    const addedDuringEmbedding = page(
      "pg_added_during_embedding",
      "Stellar nursery",
      "A stellar nursery is a region where stars form.",
      "stellar-nursery",
    );
    await writeFile(path.join(root, existing.path), renderWikiPage(existing));

    let changedCorpus = false;
    const results = await semanticSearch(root, "where stars form", "wiki", 10, {
      embeddings: {
        modelId: "test/race-aware",
        modelRevision: "test-revision",
        async embed(texts, role = "document") {
          if (role === "document" && !changedCorpus) {
            changedCorpus = true;
            await writeFile(
              path.join(root, addedDuringEmbedding.path),
              renderWikiPage(addedDuringEmbedding),
            );
          }
          return texts.map((text) =>
            text.toLocaleLowerCase("en").includes("stellar nursery") ||
            text.toLocaleLowerCase("en").includes("where stars form")
              ? [1, 0]
              : [0, 1],
          );
        },
      },
    });

    expect(changedCorpus).toBe(true);
    expect(results.map((result) => result.id)).toContain(
      "pg_added_during_embedding",
    );
  });
});
