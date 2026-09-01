import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadExtractedSourceCache } from "./sources/rebuild-cache.js";
import {
  inspectUnregisteredSourceIdentities,
  scanSources,
} from "./sources/scan.js";
import {
  sourceReviewDecisionBatchV1Schema,
  sourceReviewV1Schema,
  type SourceReviewCandidateV1,
  type SourceReviewDecisionBatchV1,
  type SourceReviewReceiptV1,
  type SourceReviewV1,
} from "./sources/review-types.js";
import { sourceRecordV1Schema, type SourceRecordV1 } from "./sources/types.js";
import {
  readBrainState,
  renderBrainState,
  type SyncStatusV1,
} from "./state.js";
import {
  runCanonicalWrite,
  type OperationRecordV1,
  type TransactionTestOptions,
} from "./transaction.js";

const representativeChunkLimit = 3;
const representativeChunkTextLimit = 2_000;

async function sourceRecords(root: string): Promise<SourceRecordV1[]> {
  const manifest = JSON.parse(
    await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
  ) as { sources?: unknown[] };
  return (manifest.sources ?? []).map((source) =>
    sourceRecordV1Schema.parse(source),
  );
}

function representativeIndexes(length: number, limit: number): number[] {
  if (length <= 0 || limit <= 0) return [];
  if (length <= limit) return Array.from({ length }, (_, index) => index);
  return [
    ...new Set(
      Array.from({ length: limit }, (_, index) =>
        Math.round((index * (length - 1)) / (limit - 1)),
      ),
    ),
  ];
}

async function candidateFromRecord(
  root: string,
  pathOverride: string,
  record: SourceRecordV1,
  existingDecision?: SourceReviewReceiptV1,
): Promise<SourceReviewCandidateV1> {
  const extracted =
    record.extractionStatus === "ready"
      ? await loadExtractedSourceCache(root, record)
      : undefined;
  const representativeChunks = representativeIndexes(
    extracted?.chunks.length ?? 0,
    representativeChunkLimit,
  ).map((index) => {
    const chunk = extracted?.chunks[index];
    if (!chunk) throw new Error("Representative source chunk disappeared");
    return {
      locator: chunk.locator,
      text: chunk.text.slice(0, representativeChunkTextLimit),
    };
  });
  return {
    path: pathOverride,
    sha256: record.sha256,
    bytes: record.bytes,
    title: record.title,
    mediaType: record.mediaType,
    extractionStatus: record.extractionStatus,
    ...(record.error ? { error: record.error } : {}),
    representativeChunks,
    ...(existingDecision ? { existingDecision } : {}),
  };
}

/** Safely previews ordinary unregistered candidates without canonical writes. */
export async function reviewSourceCandidates(
  root: string,
): Promise<SourceReviewV1> {
  const [state, registered] = await Promise.all([
    readBrainState(root),
    sourceRecords(root),
  ]);
  const scan = await scanSources(root, async () => undefined);
  if (scan.modified.length > 0 || scan.deleted.length > 0) {
    throw new Error(
      `Immutable source violation: ${[
        ...scan.modified.map((source) => source.path),
        ...scan.deleted.map((source) => source.path),
      ].join(", ")}`,
    );
  }
  const records = new Map(
    [...registered, ...scan.added].map((record) => [record.id, record]),
  );
  const acknowledgedDuplicatePaths = new Set(
    state.sourceDuplicates.map((duplicate) => duplicate.path),
  );
  const candidateRecords: Array<{
    path: string;
    record: SourceRecordV1;
  }> = [
    ...scan.added
      .filter((record) => !record.path.startsWith("sources/web/"))
      .map((record) => ({ path: record.path, record })),
    ...scan.duplicates.flatMap((duplicate) => {
      if (
        duplicate.path.startsWith("sources/web/") ||
        acknowledgedDuplicatePaths.has(duplicate.path)
      ) {
        return [];
      }
      const record = records.get(duplicate.sourceId);
      if (!record) {
        throw new Error(
          `Duplicate source record disappeared: ${duplicate.sourceId}`,
        );
      }
      return [{ path: duplicate.path, record }];
    }),
  ];
  const candidates = await Promise.all(
    candidateRecords
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path: sourcePath, record }) =>
        candidateFromRecord(
          root,
          sourcePath,
          record,
          state.sourceReviews.find(
            (receipt) =>
              receipt.path === sourcePath && receipt.sha256 === record.sha256,
          ),
        ),
      ),
  );
  return sourceReviewV1Schema.parse({ version: 1, candidates });
}

export interface SourceReviewStatusV1 {
  pending: SourceReviewCandidateV1[];
  admitted: SourceReviewCandidateV1[];
  excluded: SourceReviewCandidateV1[];
}

export async function inspectSourceReviewStatus(
  root: string,
): Promise<SourceReviewStatusV1> {
  const review = await reviewSourceCandidates(root);
  return {
    pending: review.candidates.filter(
      (candidate) => !candidate.existingDecision,
    ),
    admitted: review.candidates.filter(
      (candidate) => candidate.existingDecision?.decision === "include",
    ),
    excluded: review.candidates.filter(
      (candidate) => candidate.existingDecision?.decision === "exclude",
    ),
  };
}

export interface SourceReviewDecisionResultV1 {
  version: 1;
  changed: boolean;
  receipts: SourceReviewReceiptV1[];
  operationId?: string;
  commit?: string;
  sync?: SyncStatusV1;
}

function sameDecision(
  receipt: SourceReviewReceiptV1,
  decision: SourceReviewDecisionBatchV1["decisions"][number],
): boolean {
  return (
    receipt.path === decision.path &&
    receipt.sha256 === decision.sha256 &&
    receipt.decision === decision.decision &&
    receipt.basis === decision.basis &&
    receipt.reason === decision.reason
  );
}

/** Records agent-owned relevance decisions for exact unregistered bytes. */
export async function recordSourceReviewDecisions(
  root: string,
  rawBatch: SourceReviewDecisionBatchV1,
  testOptions: TransactionTestOptions = {},
): Promise<SourceReviewDecisionResultV1> {
  const batch = sourceReviewDecisionBatchV1Schema.parse(rawBatch);
  const uniquePaths = new Set(batch.decisions.map((decision) => decision.path));
  if (uniquePaths.size !== batch.decisions.length) {
    throw new Error("A source review batch cannot decide one path twice");
  }
  const operationId = `op_source_review_${randomUUID().replaceAll("-", "")}`;
  const transaction = await runCanonicalWrite<SourceReviewDecisionResultV1>(
    root,
    {
      operationId,
      commitMessage: `brain(source): review ${batch.decisions.length} candidate${batch.decisions.length === 1 ? "" : "s"} [op:${operationId}]`,
      testOptions,
    },
    async (writer) => {
      const [state, review] = await Promise.all([
        readBrainState(root),
        reviewSourceCandidates(root),
      ]);
      const candidates = new Map(
        review.candidates.map((candidate) => [candidate.path, candidate]),
      );
      for (const decision of batch.decisions) {
        const candidate = candidates.get(decision.path);
        if (!candidate) {
          throw new Error(
            `Source review candidate is not available: ${decision.path}`,
          );
        }
        if (candidate.sha256 !== decision.sha256) {
          throw new Error(`Source review candidate changed: ${decision.path}`);
        }
      }
      const now = new Date().toISOString();
      const receipts = batch.decisions.map((decision) => {
        const existing = state.sourceReviews.find((receipt) =>
          sameDecision(receipt, decision),
        );
        return existing ?? { ...decision, decidedAt: now };
      });
      const changed = batch.decisions.some(
        (decision) =>
          !state.sourceReviews.some((receipt) =>
            sameDecision(receipt, decision),
          ),
      );
      const verifyBeforeCommit = async () => {
        const identities = new Map(
          (await inspectUnregisteredSourceIdentities(root)).map((identity) => [
            identity.path,
            identity,
          ]),
        );
        for (const decision of batch.decisions) {
          const identity = identities.get(decision.path);
          if (
            !identity ||
            identity.sha256 !== decision.sha256 ||
            identity.bytes !== candidates.get(decision.path)?.bytes
          ) {
            throw new Error(
              `Source review candidate changed: ${decision.path}`,
            );
          }
        }
      };
      if (!changed) {
        return {
          value: { version: 1, changed: false, receipts },
          stagePaths: [],
          verifyBeforeCommit,
        };
      }
      const decidedPaths = new Set(batch.decisions.map((item) => item.path));
      const sourceReviews = [
        ...state.sourceReviews.filter(
          (receipt) => !decidedPaths.has(receipt.path),
        ),
        ...receipts,
      ].sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.sha256.localeCompare(right.sha256),
      );
      await writer.writeText(
        ".brain/state.json",
        renderBrainState({ ...state, sourceReviews }),
      );
      const operation: OperationRecordV1 = {
        version: 1,
        id: operationId,
        kind: "source-review",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary: `Recorded ${receipts.length} source relevance decision${receipts.length === 1 ? "" : "s"}`,
        pageIds: [],
        tiersUsed: [],
      };
      const operationsPath = path.join(root, ".brain", "operations.jsonl");
      await writer.writeText(
        ".brain/operations.jsonl",
        `${await readFile(operationsPath, "utf8")}${JSON.stringify(operation)}\n`,
      );
      const logPath = path.join(root, "wiki", "log.md");
      await writer.writeText(
        "wiki/log.md",
        `${(await readFile(logPath, "utf8")).trimEnd()}\n\n## [${now}] source-review | Recorded relevance decisions\n\n- Operation: \`${operationId}\`\n- Included: ${receipts.filter((receipt) => receipt.decision === "include").length}\n- Excluded: ${receipts.filter((receipt) => receipt.decision === "exclude").length}\n`,
      );
      return {
        value: {
          version: 1,
          changed: true,
          receipts,
          operationId,
        },
        stagePaths: [
          ".brain/state.json",
          ".brain/operations.jsonl",
          "wiki/log.md",
        ],
        verifyBeforeCommit,
      };
    },
  );
  return {
    ...transaction.value,
    ...(transaction.commit ? { commit: transaction.commit } : {}),
    ...(transaction.sync ? { sync: transaction.sync } : {}),
  };
}
