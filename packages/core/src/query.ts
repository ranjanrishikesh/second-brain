import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import { searchBrain, searchResultV1Schema } from "./search.js";
import { scanAndRegisterSources } from "./source-transaction.js";
import { readBrainState, syncStatusV1Schema } from "./state.js";
import { loadExtractedSourceCache } from "./sources/rebuild-cache.js";
import type { ExtractedSourceV1, SourceRecordV1 } from "./sources/types.js";
import { attemptManagedSync } from "./sync.js";
import { recoverBrain } from "./transaction.js";
import { assertWebApproval, webApprovalV1Schema } from "./web-approval.js";
import { loadWikiPages } from "./wiki/graph.js";

export const querySessionV1Schema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^qry_[a-f0-9]{32}$/),
  question: z.string().trim().min(1),
  status: z.enum(["open", "finished"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  outcome: z.enum(["answered", "partial", "unanswered"]).optional(),
  answerSummary: z.string().trim().min(1).optional(),
  currentTier: z.enum(["wiki", "sources", "web"]),
  tiersUsed: z.array(z.enum(["wiki", "sources", "web"])),
  wikiResults: z.array(searchResultV1Schema),
  sourceResults: z.array(searchResultV1Schema).default([]),
  tierAssessments: z
    .array(
      z.object({
        tier: z.enum(["wiki", "sources"]),
        status: z.enum(["sufficient", "insufficient"]),
        reason: z.string().trim().min(1),
      }),
    )
    .default([]),
  bootstrap: z.object({
    required: z.boolean(),
    pendingSourceIds: z.array(z.string()),
  }),
  setup: z
    .object({
      status: z.enum(["not-started", "in-progress", "completed"]),
      id: z
        .string()
        .regex(/^setup_[a-f0-9]{32}$/)
        .optional(),
      required: z.boolean(),
      pendingSourceIds: z.array(z.string()),
    })
    .default({
      status: "not-started",
      required: true,
      pendingSourceIds: [],
    }),
  deltaBootstrap: z
    .object({
      required: z.boolean(),
      pendingSourceIds: z.array(z.string()),
    })
    .default({ required: false, pendingSourceIds: [] }),
  sync: syncStatusV1Schema.default({ status: "unconfigured" }),
  webApproval: webApprovalV1Schema.optional(),
  webEvidenceSourceIds: z.array(z.string()).default([]),
  changeOperationIds: z.array(z.string()).default([]),
});

export type QuerySessionV1 = z.infer<typeof querySessionV1Schema>;

function sessionPath(root: string, queryId: string): string {
  return path.join(root, ".brain", "runtime", "queries", `${queryId}.json`);
}

export async function readQuerySession(
  root: string,
  queryId: string,
): Promise<QuerySessionV1> {
  return querySessionV1Schema.parse(
    JSON.parse(await readFile(sessionPath(root, queryId), "utf8")),
  );
}

export async function writeQuerySession(
  root: string,
  session: QuerySessionV1,
): Promise<void> {
  const filePath = sessionPath(root, session.id);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export async function pendingBootstrapSourceIds(
  root: string,
): Promise<string[]> {
  const manifest = JSON.parse(
    await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
  ) as { sources: SourceRecordV1[] };
  const pages = await loadWikiPages(root);
  const catalogedSourceIds = new Set(
    pages
      .filter((page) => page.type === "source")
      .flatMap((page) => page.sources.map((source) => source.id)),
  );
  return manifest.sources
    .filter(
      (source) =>
        source.extractionStatus === "ready" &&
        !catalogedSourceIds.has(source.id),
    )
    .map((source) => source.id)
    .sort();
}

export async function refreshQueryBootstrap(
  root: string,
  session: QuerySessionV1,
): Promise<QuerySessionV1> {
  const [pendingSourceIds, state] = await Promise.all([
    pendingBootstrapSourceIds(root),
    readBrainState(root),
  ]);
  session.bootstrap = {
    required: pendingSourceIds.length > 0,
    pendingSourceIds,
  };
  session.setup = {
    status: state.setup.status,
    ...(state.setup.id ? { id: state.setup.id } : {}),
    required: state.setup.status !== "completed",
    pendingSourceIds:
      state.setup.status === "completed"
        ? []
        : [
            ...new Set([...state.setup.pendingSourceIds, ...pendingSourceIds]),
          ].sort(),
  };
  session.deltaBootstrap = {
    required: state.setup.status === "completed" && pendingSourceIds.length > 0,
    pendingSourceIds:
      state.setup.status === "completed" ? pendingSourceIds : [],
  };
  return session;
}

export async function beginQuery(
  root: string,
  question: string,
): Promise<QuerySessionV1> {
  const normalizedQuestion = question.trim();
  if (!normalizedQuestion) throw new Error("Question cannot be empty");
  await recoverBrain(root);
  await scanAndRegisterSources(root);
  const sync = await attemptManagedSync(root);
  const wikiResults = await searchBrain(root, {
    query: normalizedQuestion,
    scope: "wiki",
    limit: 10,
  });
  const [pendingSourceIds, state] = await Promise.all([
    pendingBootstrapSourceIds(root),
    readBrainState(root),
  ]);
  const session: QuerySessionV1 = querySessionV1Schema.parse({
    version: 1,
    id: `qry_${randomUUID().replaceAll("-", "")}`,
    question: normalizedQuestion,
    status: "open",
    startedAt: new Date().toISOString(),
    currentTier: "wiki",
    tiersUsed: ["wiki"],
    wikiResults,
    sourceResults: [],
    tierAssessments: [],
    bootstrap: {
      required: pendingSourceIds.length > 0,
      pendingSourceIds,
    },
    setup: {
      status: state.setup.status,
      ...(state.setup.id ? { id: state.setup.id } : {}),
      required: state.setup.status !== "completed",
      pendingSourceIds:
        state.setup.status === "completed"
          ? []
          : [
              ...new Set([
                ...state.setup.pendingSourceIds,
                ...pendingSourceIds,
              ]),
            ].sort(),
    },
    deltaBootstrap: {
      required:
        state.setup.status === "completed" && pendingSourceIds.length > 0,
      pendingSourceIds:
        state.setup.status === "completed" ? pendingSourceIds : [],
    },
    sync,
    webEvidenceSourceIds: [],
    changeOperationIds: [],
  });
  await writeQuerySession(root, session);
  return session;
}

export interface ExpandQueryOptions {
  tier: "sources" | "web";
  reason: string;
}

export async function expandQuery(
  root: string,
  queryId: string,
  options: ExpandQueryOptions,
): Promise<QuerySessionV1> {
  const session = await readQuerySession(root, queryId);
  if (session.status !== "open")
    throw new Error(`Query is not open: ${queryId}`);
  const reason = options.reason.trim();
  if (!reason) throw new Error("An insufficiency reason is required");
  if (options.tier === "sources") {
    if (session.currentTier !== "wiki") {
      throw new Error(`Cannot expand from ${session.currentTier} to sources`);
    }
    session.tierAssessments.push({
      tier: "wiki",
      status: "insufficient",
      reason,
    });
    session.sourceResults = await searchBrain(root, {
      query: session.question,
      scope: "sources",
      limit: 20,
    });
  } else {
    if (session.currentTier !== "sources") {
      throw new Error(`Cannot expand from ${session.currentTier} to web`);
    }
    await assertWebApproval(root, queryId);
    session.tierAssessments.push({
      tier: "sources",
      status: "insufficient",
      reason,
    });
  }
  session.currentTier = options.tier;
  if (!session.tiersUsed.includes(options.tier))
    session.tiersUsed.push(options.tier);
  await writeQuerySession(root, session);
  return session;
}

export interface BootstrapSourceContextV1 {
  record: SourceRecordV1;
  extracted?: ExtractedSourceV1;
}

export interface BootstrapBatchV1 {
  version: 1;
  queryId: string;
  sourceIds: string[];
  sources: BootstrapSourceContextV1[];
}

export async function nextBootstrapBatch(
  root: string,
  queryId: string,
): Promise<BootstrapBatchV1> {
  const session = await readQuerySession(root, queryId);
  if (session.status !== "open")
    throw new Error(`Query is not open: ${queryId}`);
  const config = await loadBrainConfig(root);
  const sourceIds = session.bootstrap.pendingSourceIds.slice(
    0,
    config.bootstrap.batchSize,
  );
  const manifest = JSON.parse(
    await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
  ) as { sources: SourceRecordV1[] };
  const records = new Map(
    manifest.sources.map((source) => [source.id, source]),
  );
  const sources: BootstrapSourceContextV1[] = [];
  for (const sourceId of sourceIds) {
    const record = records.get(sourceId);
    if (!record)
      throw new Error(
        `Bootstrap source is missing from the manifest: ${sourceId}`,
      );
    const extracted =
      record.extractionStatus === "ready"
        ? await loadExtractedSourceCache(root, record)
        : undefined;
    sources.push({ record, ...(extracted ? { extracted } : {}) });
  }
  return { version: 1, queryId, sourceIds, sources };
}
