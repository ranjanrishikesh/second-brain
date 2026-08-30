import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import type { SearchResult, SearchScope } from "./search.js";
import { loadExtractedSourceCache } from "./sources/rebuild-cache.js";
import type { SourceRecordV1 } from "./sources/types.js";
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
  /** Lets a host own a local embedding runtime without sharing it across brains. */
  embeddingProviderFactory?: (root: string) => EmbeddingProvider;
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
  const config = await loadBrainConfig(root);
  hash.update("semantic-corpus-v2\0");
  hash.update(JSON.stringify(config.sources));
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

const pinnedSemanticModelSupportFiles = [
  {
    path: "config.json",
    sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
  },
  {
    path: "tokenizer.json",
    sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  },
  {
    path: "tokenizer_config.json",
    sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
  },
  {
    path: "sentencepiece.bpe.model",
    sha256: "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865",
  },
  {
    path: "special_tokens_map.json",
    sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
  },
  {
    path: "quant_config.json",
    sha256: "59d175f15264115f18c698d76e443b5d49fc6c8c599911c421405ef4f236e87d",
  },
] as const;

function pinnedModelDirectory(
  root: string,
  model: { id: string; revision: string },
): string {
  const modelPath = model.id.split("/");
  if (
    modelPath.length !== 2 ||
    modelPath.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment)) ||
    !/^[a-f0-9]{40}$/.test(model.revision)
  ) {
    throw new Error("Pinned semantic model identity is invalid");
  }
  return path.join(
    root,
    ".brain",
    "cache",
    "models",
    ...modelPath,
    model.revision,
  );
}

function assertModelArtifactChecksum(
  bytes: Uint8Array,
  expectedSha256: string,
): void {
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Pinned semantic model checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
    );
  }
}

/** Writes a response atomically while validating its bytes without buffering it. */
export async function streamVerifiedResponse(
  filePath: string,
  response: Response,
  expectedSha256: string,
): Promise<void> {
  if (!response.ok) {
    throw new Error(
      `Pinned semantic model artifact download failed with HTTP ${response.status}`,
    );
  }
  if (!response.body) {
    throw new Error(
      "Pinned semantic model artifact download has no response body",
    );
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  try {
    const handle = await open(temporary, "wx");
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await handle.write(value);
      }
    } finally {
      await handle.close();
    }
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `Pinned semantic model checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`,
      );
    }
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function pinnedModelFilePath(directory: string, relativePath: string): string {
  const parts = relativePath.split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))
  ) {
    throw new Error("Pinned semantic model file path is invalid");
  }
  return path.join(directory, ...parts);
}

async function ensurePinnedModelFile(
  directory: string,
  model: { id: string; revision: string },
  relativePath: string,
  expectedSha256: string,
): Promise<void> {
  const destination = pinnedModelFilePath(directory, relativePath);
  try {
    assertModelArtifactChecksum(await readFile(destination), expectedSha256);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await globalThis.fetch(
    `https://huggingface.co/${model.id}/resolve/${model.revision}/${relativePath}`,
  );
  if (!response.ok) {
    throw new Error(
      `Pinned semantic model file ${relativePath} download failed with HTTP ${response.status}`,
    );
  }
  await streamVerifiedResponse(destination, response, expectedSha256);
}

async function ensurePinnedModelFiles(
  root: string,
  model: { id: string; revision: string; artifactSha256: string },
): Promise<string> {
  const directory = pinnedModelDirectory(root, model);
  const files = [
    { path: "onnx/model_quantized.onnx", sha256: model.artifactSha256 },
    ...pinnedSemanticModelSupportFiles,
  ];
  for (const file of files) {
    await ensurePinnedModelFile(directory, model, file.path, file.sha256);
  }
  return directory;
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
          const modelDirectory = await ensurePinnedModelFiles(
            root,
            config.graph.semanticModel,
          );
          const { pipeline } = await import("@huggingface/transformers");
          const extractor = await pipeline(
            "feature-extraction",
            modelDirectory,
            {
              dtype: "q8",
              local_files_only: true,
            },
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
  return (
    services.embeddings ??
    services.embeddingProviderFactory?.(root) ??
    createLocalEmbeddingProvider(root)
  );
}

/** Binds one provider to a multi-search operation. */
export function bindEmbeddingProvider(
  root: string,
  services: BrainRuntimeServices = {},
): BrainRuntimeServices {
  if (services.embeddings) return services;
  return { ...services, embeddings: resolveEmbeddingProvider(root, services) };
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
  await rebuildSemanticIndexWithProvider(root, provider);
}

async function rebuildSemanticIndexWithProvider(
  root: string,
  provider: EmbeddingProvider,
): Promise<void> {
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
  provider: EmbeddingProvider,
): Promise<SemanticIndexV1> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await readCurrentSemanticIndex(root, provider);
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await rebuildSemanticIndexWithProvider(root, provider);
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
    loadSemanticIndex(root, provider),
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
