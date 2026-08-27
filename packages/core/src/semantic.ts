import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import { loadExtractedSourceCache } from "./sources/rebuild-cache.js";
import type { SourceRecordV1 } from "./sources/types.js";
import type { SearchResult, SearchScope } from "./search.js";
import { parseWikiPage } from "./wiki/page.js";

export interface EmbeddingProvider {
  readonly modelId: string;
  readonly modelRevision: string;
  embed(
    texts: readonly string[],
    role?: "query" | "document",
  ): Promise<readonly number[][]>;
}

export interface BrainRuntimeServices {
  embeddings?: EmbeddingProvider;
}

const semanticDocumentV1Schema = z.object({
  kind: z.enum(["wiki", "source"]),
  id: z.string().min(1),
  title: z.string().min(1),
  path: z.string().min(1),
  locator: z.string().min(1),
  text: z.string(),
  vector: z.array(z.number()),
});

const semanticIndexV1Schema = z.object({
  version: z.literal(1),
  corpusRevision: z.string().regex(/^[a-f0-9]{64}$/),
  modelId: z.string().min(1),
  modelRevision: z.string().min(1),
  dimensions: z.number().int().positive(),
  documents: z.array(semanticDocumentV1Schema),
});

type SemanticIndexV1 = z.infer<typeof semanticIndexV1Schema>;

const semanticIndexRelativePath = path.join(
  ".brain",
  "cache",
  "semantic-index.json",
);

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(absolute)));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

async function semanticCorpusRevision(root: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(
    await readFile(path.join(root, ".brain", "source-manifest.json")),
  );
  for (const absolutePath of (
    await markdownFiles(path.join(root, "wiki"))
  ).sort()) {
    hash.update(path.relative(root, absolutePath));
    hash.update(await readFile(absolutePath));
  }
  return hash.digest("hex");
}

async function semanticDocuments(
  root: string,
): Promise<Array<Omit<z.infer<typeof semanticDocumentV1Schema>, "vector">>> {
  const documents: Array<
    Omit<z.infer<typeof semanticDocumentV1Schema>, "vector">
  > = [];
  const manifest = JSON.parse(
    await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
  ) as { sources: SourceRecordV1[] };
  for (const source of manifest.sources) {
    if (source.extractionStatus !== "ready") continue;
    const extracted = await loadExtractedSourceCache(root, source);
    for (const chunk of extracted.chunks) {
      documents.push({
        kind: "source",
        id: source.id,
        title: source.title,
        path: source.path,
        locator: chunk.locator,
        text: chunk.text,
      });
    }
  }

  for (const absolutePath of (
    await markdownFiles(path.join(root, "wiki", "pages"))
  ).sort()) {
    const markdown = await readFile(absolutePath, "utf8");
    const relativePath = path
      .relative(root, absolutePath)
      .split(path.sep)
      .join("/");
    const page = parseWikiPage(markdown, relativePath);
    if (page.status === "archived") continue;
    documents.push({
      kind: "wiki",
      id: page.id,
      title: page.title,
      path: page.path,
      locator: "page",
      text: `${page.title}\n${page.summary}\n${page.body}`,
    });
  }
  return documents;
}

function normalizeVector(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  if (magnitude === 0) return [...vector];
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || left.length === 0) return 0;
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
}

function cachePath(root: string): string {
  return path.join(root, semanticIndexRelativePath);
}

async function writeSemanticIndex(
  root: string,
  index: SemanticIndexV1,
): Promise<void> {
  const destination = cachePath(root);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(index)}\n`, "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function filesRecursively(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesRecursively(absolute)));
    if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function verifyModelArtifact(
  root: string,
  expectedSha256: string,
): Promise<void> {
  const modelDirectory = path.join(root, ".brain", "cache", "models");
  const artifact = (await filesRecursively(modelDirectory)).find(
    (filePath) => path.basename(filePath) === "model_quantized.onnx",
  );
  if (!artifact) {
    throw new Error(
      "Pinned semantic model artifact model_quantized.onnx is missing",
    );
  }
  const actualSha256 = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Pinned semantic model checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
    );
  }
}

export function createLocalEmbeddingProvider(root: string): EmbeddingProvider {
  let pipelinePromise: Promise<EmbeddingProvider["embed"]> | undefined;
  return {
    modelId: "Xenova/multilingual-e5-small",
    modelRevision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    async embed(texts, role = "document") {
      const config = await loadBrainConfig(root);
      if (!pipelinePromise) {
        pipelinePromise = (async () => {
          const { pipeline } = await import("@huggingface/transformers");
          const extractor = await pipeline(
            "feature-extraction",
            config.graph.semanticModel.id,
            {
              cache_dir: path.join(root, ".brain", "cache", "models"),
              revision: config.graph.semanticModel.revision,
              dtype: "q8",
            },
          );
          await verifyModelArtifact(
            root,
            config.graph.semanticModel.artifactSha256,
          );
          return async (values, embeddingRole = "document") => {
            const prefixed = values.map(
              (value) =>
                `${embeddingRole === "query" ? "query" : "passage"}: ${value}`,
            );
            const tensor = await extractor(prefixed, {
              pooling: "mean",
              normalize: true,
            });
            const dimensions = tensor.dims.at(-1);
            if (!dimensions || tensor.dims[0] !== values.length) {
              throw new Error(
                "Pinned semantic model returned an invalid embedding shape",
              );
            }
            const valuesArray = Array.from(tensor.data as Float32Array);
            return values.map((_, index) =>
              valuesArray.slice(index * dimensions, (index + 1) * dimensions),
            );
          };
        })();
      }
      return (await pipelinePromise)(texts, role);
    },
  };
}

function resolveEmbeddingProvider(
  root: string,
  services: BrainRuntimeServices,
): EmbeddingProvider {
  return services.embeddings ?? createLocalEmbeddingProvider(root);
}

export async function prepareSemanticModel(
  root: string,
  services: BrainRuntimeServices = {},
): Promise<{ modelId: string; modelRevision: string }> {
  const provider = resolveEmbeddingProvider(root, services);
  await provider.embed(["second brain semantic model check"], "document");
  return {
    modelId: provider.modelId,
    modelRevision: provider.modelRevision,
  };
}

export async function rebuildSemanticIndex(
  root: string,
  services: BrainRuntimeServices = {},
): Promise<void> {
  const provider = resolveEmbeddingProvider(root, services);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const corpusRevision = await semanticCorpusRevision(root);
    const documents = await semanticDocuments(root);
    const vectors = documents.length
      ? await provider.embed(
          documents.map((document) => document.text),
          "document",
        )
      : [];
    if (vectors.length !== documents.length) {
      throw new Error(
        "Semantic provider returned the wrong number of embeddings",
      );
    }
    const dimensions = vectors[0]?.length ?? 1;
    if (vectors.some((vector) => vector.length !== dimensions)) {
      throw new Error(
        "Semantic provider returned embeddings with inconsistent dimensions",
      );
    }
    if ((await semanticCorpusRevision(root)) !== corpusRevision) continue;
    await writeSemanticIndex(root, {
      version: 1,
      corpusRevision,
      modelId: provider.modelId,
      modelRevision: provider.modelRevision,
      dimensions,
      documents: documents.map((document, index) => ({
        ...document,
        vector: normalizeVector(vectors[index] ?? []),
      })),
    });
    if ((await semanticCorpusRevision(root)) === corpusRevision) return;
  }
  throw new Error(
    "Semantic corpus changed during index rebuild; retry when canonical writes are idle",
  );
}

async function readCurrentSemanticIndex(
  root: string,
  provider: EmbeddingProvider,
): Promise<SemanticIndexV1> {
  const expectedCorpusRevision = await semanticCorpusRevision(root);
  const index = semanticIndexV1Schema.parse(
    JSON.parse(await readFile(cachePath(root), "utf8")),
  );
  if (
    index.corpusRevision !== expectedCorpusRevision ||
    index.modelId !== provider.modelId ||
    index.modelRevision !== provider.modelRevision
  ) {
    throw new Error("Semantic index metadata is stale");
  }
  if ((await semanticCorpusRevision(root)) !== expectedCorpusRevision) {
    throw new Error("Semantic corpus changed while reading the index");
  }
  return index;
}

async function loadSemanticIndex(
  root: string,
  services: BrainRuntimeServices,
): Promise<SemanticIndexV1> {
  const provider = resolveEmbeddingProvider(root, services);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await readCurrentSemanticIndex(root, provider);
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await rebuildSemanticIndex(root, services);
    }
  }
  throw lastError;
}

export async function semanticSearch(
  root: string,
  query: string,
  scope: SearchScope,
  limit: number,
  services: BrainRuntimeServices = {},
): Promise<SearchResult[]> {
  const provider = resolveEmbeddingProvider(root, services);
  const [index, queryVector] = await Promise.all([
    loadSemanticIndex(root, services),
    provider.embed([query], "query"),
  ]);
  const vector = normalizeVector(queryVector[0] ?? []);
  const expectedKind = scope === "sources" ? "source" : "wiki";
  return index.documents
    .filter((document) => scope === "all" || document.kind === expectedKind)
    .map((document) => ({
      kind: document.kind,
      id: document.id,
      title: document.title,
      path: document.path,
      locator: document.locator,
      snippet: document.text.slice(0, 240),
      score: cosineSimilarity(vector, document.vector),
    }))
    .filter((result) => result.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.path.localeCompare(right.path) ||
        left.locator.localeCompare(right.locator),
    )
    .slice(0, limit);
}
