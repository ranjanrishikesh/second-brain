import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { loadBrainConfig } from "./config.js";
import { pendingBootstrapSourceIds } from "./query.js";
import { readBrainState, type SyncStatusV1 } from "./state.js";
import { loadExtractedSourceCache } from "./sources/rebuild-cache.js";
import {
  sourceRecordV1Schema,
  type ExtractedSourceV1,
  type SourceChunkV1,
  type SourceRecordV1,
} from "./sources/types.js";
import { loadWikiPages } from "./wiki/graph.js";
import type { WikiPageV1 } from "./wiki/types.js";
import { syncStatus } from "./sync.js";

export interface BrainStatusV1 {
  version: 1;
  brain: { name: string; description: string; language: string };
  sources: {
    total: number;
    ready: number;
    unsupported: number;
    extractionRequired: number;
    failed: number;
  };
  wiki: { pages: number; active: number; relations: number };
  bootstrap: { required: boolean; pendingSourceIds: string[] };
  setup: {
    status: "not-started" | "in-progress" | "completed";
    required: boolean;
    pendingSourceIds: string[];
  };
  sync: SyncStatusV1;
  semanticAudit: {
    due: boolean;
    knowledgeMutations: number;
    lastCompletedMutation: number;
    pendingPageIds: string[];
  };
  recovery: { required: boolean };
}

export type BrainReadResultV1 =
  | { version: 1; kind: "wiki"; page: WikiPageV1 }
  | {
      version: 1;
      kind: "source";
      source: SourceRecordV1;
      chunks: SourceChunkV1[];
      text?: string;
    };

async function sourceRecords(root: string): Promise<SourceRecordV1[]> {
  const manifest = JSON.parse(
    await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
  ) as { sources?: unknown[] };
  return (manifest.sources ?? []).map((source) =>
    sourceRecordV1Schema.parse(source),
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function statusBrain(root: string): Promise<BrainStatusV1> {
  const [
    config,
    sources,
    pages,
    state,
    pendingSourceIds,
    recoveryRequired,
    sync,
  ] = await Promise.all([
    loadBrainConfig(root),
    sourceRecords(root),
    loadWikiPages(root),
    readBrainState(root),
    pendingBootstrapSourceIds(root),
    pathExists(path.join(root, ".brain", "runtime", "transaction.json")),
    syncStatus(root),
  ]);
  const extractionCount = (status: SourceRecordV1["extractionStatus"]) =>
    sources.filter((source) => source.extractionStatus === status).length;
  return {
    version: 1,
    brain: config.brain,
    sources: {
      total: sources.length,
      ready: extractionCount("ready"),
      unsupported: extractionCount("unsupported"),
      extractionRequired: extractionCount("extraction-required"),
      failed: extractionCount("failed"),
    },
    wiki: {
      pages: pages.length,
      active: pages.filter((page) => page.status === "active").length,
      relations: pages.reduce((sum, page) => sum + page.relations.length, 0),
    },
    bootstrap: {
      required: pendingSourceIds.length > 0,
      pendingSourceIds,
    },
    setup: {
      status: state.setup.status,
      required: state.setup.status !== "completed",
      pendingSourceIds: state.setup.pendingSourceIds,
    },
    sync,
    semanticAudit: {
      due: state.semanticAuditDue ?? false,
      knowledgeMutations: state.knowledgeMutations,
      lastCompletedMutation: state.lastSemanticAuditMutation,
      pendingPageIds: state.semanticAudit?.pendingPageIds ?? [],
    },
    recovery: { required: recoveryRequired },
  };
}

export async function readBrainItem(
  root: string,
  reference: string,
  locator?: string,
): Promise<BrainReadResultV1> {
  const normalized = reference.trim();
  const pages = await loadWikiPages(root);
  const page = pages.find(
    (candidate) =>
      candidate.id === normalized ||
      candidate.path === normalized ||
      candidate.title.toLocaleLowerCase("en") ===
        normalized.toLocaleLowerCase("en") ||
      candidate.aliases.some(
        (alias) =>
          alias.toLocaleLowerCase("en") === normalized.toLocaleLowerCase("en"),
      ),
  );
  if (page) return { version: 1, kind: "wiki", page };

  const source = (await sourceRecords(root)).find(
    (candidate) => candidate.id === normalized || candidate.path === normalized,
  );
  if (!source) throw new Error(`Brain item not found: ${reference}`);
  const extracted: ExtractedSourceV1 | undefined =
    source.extractionStatus === "ready"
      ? await loadExtractedSourceCache(root, source)
      : undefined;
  const chunks = locator
    ? (extracted?.chunks.filter((chunk) => chunk.locator === locator) ?? [])
    : (extracted?.chunks ?? []);
  if (locator && chunks.length === 0) {
    throw new Error(`Source locator not found: ${source.id}#${locator}`);
  }
  return {
    version: 1,
    kind: "source",
    source,
    chunks,
    ...(!locator && extracted ? { text: extracted.text } : {}),
  };
}
