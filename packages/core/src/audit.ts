import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import {
  runCanonicalWrite,
  type OperationRecordV1,
  type TransactionTestOptions,
} from "./transaction.js";
import { loadWikiPages, validateWikiGraph } from "./wiki/graph.js";

interface SemanticAuditStateV1 {
  status: "pending" | "completed";
  targetMutation: number;
  pendingPageIds: string[];
  reviewedPageIds: string[];
  startedAt: string;
  completedAt?: string;
}

interface BrainStateV1 extends Record<string, unknown> {
  version: 1;
  knowledgeMutations: number;
  lastSemanticAuditMutation: number;
  semanticAuditDue?: boolean;
  semanticAudit?: SemanticAuditStateV1;
}

export interface SemanticAuditBatchV1 {
  version: 1;
  targetMutation: number;
  pageIds: string[];
  reviewedPageIds: string[];
  complete: boolean;
}

const recordAuditInputSchema = z.object({
  pageIds: z.array(z.string().min(1)).min(1),
  summary: z.string().trim().min(1),
});

export type RecordSemanticAuditInput = z.infer<typeof recordAuditInputSchema>;

export interface RecordSemanticAuditResult extends SemanticAuditBatchV1 {
  operationId: string;
  commit?: string;
}

async function readState(root: string): Promise<BrainStateV1> {
  return JSON.parse(
    await readFile(path.join(root, ".brain", "state.json"), "utf8"),
  ) as BrainStateV1;
}

async function initialPendingPageIds(root: string): Promise<string[]> {
  return (await loadWikiPages(root))
    .filter((page) => page.status === "active")
    .map((page) => page.id)
    .sort();
}

export async function nextSemanticAuditBatch(
  root: string,
): Promise<SemanticAuditBatchV1> {
  const state = await readState(root);
  if (!state.semanticAuditDue && state.semanticAudit?.status !== "pending") {
    return {
      version: 1,
      targetMutation: state.knowledgeMutations,
      pageIds: [],
      reviewedPageIds: state.semanticAudit?.reviewedPageIds ?? [],
      complete: true,
    };
  }
  const activeAudit =
    state.semanticAudit?.status === "pending" ? state.semanticAudit : undefined;
  const pendingPageIds = activeAudit
    ? activeAudit.pendingPageIds
    : await initialPendingPageIds(root);
  const config = await loadBrainConfig(root);
  return {
    version: 1,
    targetMutation: activeAudit?.targetMutation ?? state.knowledgeMutations,
    pageIds: pendingPageIds.slice(0, config.bootstrap.batchSize),
    reviewedPageIds: activeAudit?.reviewedPageIds ?? [],
    complete: pendingPageIds.length === 0,
  };
}

export async function recordSemanticAuditBatch(
  root: string,
  rawInput: RecordSemanticAuditInput,
  testOptions: TransactionTestOptions = {},
): Promise<RecordSemanticAuditResult> {
  const input = recordAuditInputSchema.parse(rawInput);
  const operationId = `op_audit_${randomUUID().replaceAll("-", "")}`;
  const statePath = path.join(root, ".brain", "state.json");
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const logPath = path.join(root, "wiki", "log.md");
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId,
      commitMessage: `brain(audit): review ${input.pageIds.length} page${input.pageIds.length === 1 ? "" : "s"} [op:${operationId}]`,
      testOptions,
    },
    async () => {
      const state = await readState(root);
      if (
        !state.semanticAuditDue &&
        state.semanticAudit?.status !== "pending"
      ) {
        throw new Error("A semantic audit is not due");
      }
      const now = new Date().toISOString();
      const activeAudit =
        state.semanticAudit?.status === "pending"
          ? state.semanticAudit
          : undefined;
      const targetMutation =
        activeAudit?.targetMutation ?? state.knowledgeMutations;
      const initialPending = activeAudit
        ? activeAudit.pendingPageIds
        : await initialPendingPageIds(root);
      const requested = [...new Set(input.pageIds)];
      for (const pageId of requested) {
        if (!initialPending.includes(pageId)) {
          throw new Error(`Page is not pending semantic review: ${pageId}`);
        }
      }
      const reviewedPageIds = [
        ...new Set([...(activeAudit?.reviewedPageIds ?? []), ...requested]),
      ].sort();
      const requestedIds = new Set(requested);
      const pendingPageIds = initialPending.filter(
        (pageId) => !requestedIds.has(pageId),
      );
      const complete = pendingPageIds.length === 0;
      const config = await loadBrainConfig(root);
      const nextAuditDue = complete
        ? state.knowledgeMutations - targetMutation >=
          config.graph.semanticAuditEvery
        : true;
      const operation: OperationRecordV1 = {
        version: 1,
        id: operationId,
        kind: "audit",
        status: "completed",
        startedAt: activeAudit?.startedAt ?? now,
        completedAt: now,
        summary: input.summary,
        pageIds: requested,
        tiersUsed: [],
      };

      const semanticAudit: SemanticAuditStateV1 = {
        status: complete ? "completed" : "pending",
        targetMutation,
        pendingPageIds,
        reviewedPageIds,
        startedAt: activeAudit?.startedAt ?? now,
        ...(complete ? { completedAt: now } : {}),
      };
      await writeFile(
        statePath,
        `${JSON.stringify(
          {
            ...state,
            semanticAuditDue: nextAuditDue,
            ...(complete ? { lastSemanticAuditMutation: targetMutation } : {}),
            semanticAudit,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        operationsPath,
        `${await readFile(operationsPath, "utf8")}${JSON.stringify(operation)}\n`,
        "utf8",
      );
      await writeFile(
        logPath,
        `${(await readFile(logPath, "utf8")).trimEnd()}\n\n## [${now}] audit | Semantic checkpoint\n\n- Operation: \`${operationId}\`\n- Reviewed: ${requested.map((id) => `\`${id}\``).join(", ")}\n- Remaining: ${pendingPageIds.length}\n- Summary: ${input.summary}\n`,
        "utf8",
      );
      return {
        value: {
          version: 1 as const,
          targetMutation,
          pageIds: pendingPageIds,
          reviewedPageIds,
          complete,
          operationId,
        },
        stagePaths: [
          ".brain/state.json",
          ".brain/operations.jsonl",
          "wiki/log.md",
        ],
      };
    },
  );
  return {
    ...transaction.value,
    ...(transaction.commit ? { commit: transaction.commit } : {}),
  };
}

export async function auditBrain(root: string): Promise<{
  version: 1;
  structural: Awaited<ReturnType<typeof validateWikiGraph>>;
  semantic: SemanticAuditBatchV1;
}> {
  const [structural, semantic] = await Promise.all([
    validateWikiGraph(root),
    nextSemanticAuditBatch(root),
  ]);
  return { version: 1, structural, semantic };
}
