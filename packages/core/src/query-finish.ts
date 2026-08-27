import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  readQuerySession,
  refreshQueryBootstrap,
  writeQuerySession,
  type QuerySessionV1,
} from "./query.js";
import type { SyncStatusV1 } from "./state.js";
import { attemptManagedSync } from "./sync.js";
import {
  operationRecordV1Schema,
  recoverBrain,
  runCanonicalWrite,
  type OperationRecordV1,
  type TransactionTestOptions,
} from "./transaction.js";
import { sourceRecordV1Schema } from "./sources/types.js";
import { assertWebApproval } from "./web-approval.js";
import { loadWikiPages } from "./wiki/graph.js";

const finishQueryOptionsSchema = z.object({
  outcome: z.enum(["answered", "partial", "unanswered"]),
  answerSummary: z.string().trim().min(1),
});

export type FinishQueryOptions = z.infer<typeof finishQueryOptionsSchema>;

export interface FinishQueryResult {
  session: QuerySessionV1;
  operationId: string;
  commit?: string;
  sync?: SyncStatusV1;
}

async function readOperations(root: string): Promise<OperationRecordV1[]> {
  const content = await readFile(
    path.join(root, ".brain", "operations.jsonl"),
    "utf8",
  );
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => operationRecordV1Schema.parse(JSON.parse(line)));
}

export async function attachQueryChange(
  root: string,
  queryId: string,
  operationId: string,
): Promise<QuerySessionV1> {
  const session = await readQuerySession(root, queryId);
  if (session.status !== "open")
    throw new Error(`Query is not open: ${queryId}`);
  const operation = (await readOperations(root)).find(
    (candidate) => candidate.id === operationId,
  );
  if (operation?.kind !== "apply" || operation.pageIds.length === 0) {
    throw new Error(`Not a durable wiki mutation operation: ${operationId}`);
  }
  if (operation.queryId !== session.id) {
    throw new Error(
      `Wiki mutation ${operationId} is not bound to query ${session.id}`,
    );
  }
  if (
    operation.tiersUsed.length !== 1 ||
    !session.tiersUsed.includes(operation.tiersUsed[0] ?? "wiki")
  ) {
    throw new Error(
      `Wiki mutation ${operationId} has no valid query evidence tier`,
    );
  }
  if (!session.changeOperationIds.includes(operationId)) {
    session.changeOperationIds.push(operationId);
  }
  await refreshQueryBootstrap(root, session);
  await writeQuerySession(root, session);
  return session;
}

async function commitQueryOperation(
  root: string,
  session: QuerySessionV1,
  operation: OperationRecordV1,
  testOptions: TransactionTestOptions,
): Promise<{ commit?: string; sync?: SyncStatusV1 }> {
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const logPath = path.join(root, "wiki", "log.md");
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId: operation.id,
      commitMessage: `brain(query): ${session.question.replace(/[\r\n\0]+/g, " ").slice(0, 100)} [op:${operation.id}]`,
      testOptions,
    },
    async () => {
      const beforeOperations = await readFile(operationsPath, "utf8");
      const beforeLog = await readFile(logPath, "utf8");
      await writeFile(
        operationsPath,
        `${beforeOperations}${JSON.stringify(operation)}\n`,
        "utf8",
      );
      await writeFile(
        logPath,
        `${beforeLog.trimEnd()}\n\n## [${operation.completedAt}] query | ${session.question}\n\n- Operation: \`${operation.id}\`\n- Outcome: **${session.outcome}**\n- Tiers: ${session.tiersUsed.join(" → ")}\n- Summary: ${session.answerSummary}\n- Knowledge changes: ${session.changeOperationIds.map((id) => `\`${id}\``).join(", ") || "none"}\n`,
        "utf8",
      );
      return {
        value: undefined,
        stagePaths: [".brain/operations.jsonl", "wiki/log.md"],
      };
    },
  );
  return {
    ...(transaction.commit ? { commit: transaction.commit } : {}),
    ...(transaction.sync ? { sync: transaction.sync } : {}),
  };
}

export async function finishQuery(
  root: string,
  queryId: string,
  rawOptions: FinishQueryOptions,
  testOptions: TransactionTestOptions = {},
): Promise<FinishQueryResult> {
  const options = finishQueryOptionsSchema.parse(rawOptions);
  await recoverBrain(root);
  const session = await readQuerySession(root, queryId);
  const existingQueryOperation = (await readOperations(root)).find(
    (operation) =>
      operation.kind === "query" && operation.queryId === session.id,
  );
  if (existingQueryOperation) {
    const existingOutcome =
      existingQueryOperation.status === "completed"
        ? "answered"
        : existingQueryOperation.status;
    if (
      existingOutcome !== options.outcome ||
      existingQueryOperation.summary !== options.answerSummary
    ) {
      throw new Error(
        `Query ${queryId} was already completed with a different outcome or summary`,
      );
    }
    session.status = "finished";
    session.completedAt = existingQueryOperation.completedAt;
    session.outcome = existingOutcome;
    session.answerSummary = existingQueryOperation.summary;
    session.sync = await attemptManagedSync(root);
    await writeQuerySession(root, session);
    return {
      session,
      operationId: existingQueryOperation.id,
      sync: session.sync,
    };
  }
  if (session.status !== "open")
    throw new Error(`Query is not open: ${queryId}`);
  await refreshQueryBootstrap(root, session);
  await writeQuerySession(root, session);
  if (session.setup.required) {
    throw new Error(
      "Initial brain setup must be complete before finishing a query",
    );
  }
  if (
    session.deltaBootstrap.required &&
    (session.currentTier === "sources" || session.currentTier === "web")
  ) {
    throw new Error(
      `Catalog delta bootstrap is incomplete for ${session.deltaBootstrap.pendingSourceIds.length} source(s)`,
    );
  }
  const maintenanceState = z
    .object({
      semanticAuditDue: z.boolean().optional(),
      semanticAudit: z
        .object({ status: z.enum(["pending", "completed"]) })
        .optional(),
    })
    .passthrough()
    .parse(
      JSON.parse(
        await readFile(path.join(root, ".brain", "state.json"), "utf8"),
      ),
    );
  if (
    maintenanceState.semanticAuditDue ||
    maintenanceState.semanticAudit?.status === "pending"
  ) {
    throw new Error(
      "Semantic audit maintenance must be completed before finishing a query",
    );
  }
  if (session.currentTier === "web") {
    await assertWebApproval(root, queryId);
  }
  if (
    session.currentTier === "web" &&
    session.webEvidenceSourceIds.length === 0
  ) {
    throw new Error("A web-backed answer requires captured web evidence");
  }
  if (
    session.tiersUsed.some((tier) => tier === "sources" || tier === "web") &&
    session.changeOperationIds.length === 0
  ) {
    throw new Error(
      "A raw- or web-backed answer requires a durable wiki mutation",
    );
  }

  const operations = await readOperations(root);
  const attachedOperations = session.changeOperationIds.map((operationId) => {
    const operation = operations.find(
      (candidate) => candidate.id === operationId,
    );
    if (operation?.kind !== "apply" || operation.pageIds.length === 0) {
      throw new Error(
        `Query references an invalid wiki mutation: ${operationId}`,
      );
    }
    if (
      operation.queryId !== session.id ||
      operation.tiersUsed.length !== 1 ||
      !session.tiersUsed.includes(operation.tiersUsed[0] ?? "wiki")
    ) {
      throw new Error(
        `Query references a wiki mutation that is not bound to this lifecycle: ${operationId}`,
      );
    }
    return operation;
  });
  const pages = await loadWikiPages(root);
  if (
    options.outcome !== "unanswered" &&
    (session.currentTier === "sources" || session.currentTier === "web")
  ) {
    const evidenceTierOperations = attachedOperations.filter((operation) =>
      operation.tiersUsed.includes(session.currentTier),
    );
    if (evidenceTierOperations.length === 0) {
      throw new Error(
        `A ${session.currentTier}-backed answer requires a wiki mutation bound to the ${session.currentTier} tier`,
      );
    }
    const evidencePageIds = new Set(
      evidenceTierOperations.flatMap((operation) => operation.pageIds),
    );
    const citedSourceIds = new Set(
      pages
        .filter((page) => evidencePageIds.has(page.id))
        .flatMap((page) => page.sources.map((source) => source.id)),
    );
    if (session.currentTier === "web") {
      if (
        !session.webEvidenceSourceIds.some((sourceId) =>
          citedSourceIds.has(sourceId),
        )
      ) {
        throw new Error(
          "A web-backed answer must cite captured web evidence in its wiki mutation",
        );
      }
    } else {
      const manifest = z
        .object({
          version: z.literal(1),
          sources: z.array(sourceRecordV1Schema),
        })
        .parse(
          JSON.parse(
            await readFile(
              path.join(root, ".brain", "source-manifest.json"),
              "utf8",
            ),
          ),
        );
      if (
        !manifest.sources.some(
          (source) =>
            source.provenance.kind === "file" && citedSourceIds.has(source.id),
        )
      ) {
        throw new Error(
          "A raw-source-backed answer must cite an immutable local source in its wiki mutation",
        );
      }
    }
  }
  if (options.outcome === "unanswered") {
    const changedPageIds = new Set(
      attachedOperations.flatMap((item) => item.pageIds),
    );
    const hasGapPage = pages.some(
      (page) => page.type === "question" && changedPageIds.has(page.id),
    );
    if (!hasGapPage) {
      throw new Error(
        "An unanswered query requires a durable question gap page",
      );
    }
  }

  const now = new Date().toISOString();
  session.status = "finished";
  session.completedAt = now;
  session.outcome = options.outcome;
  session.answerSummary = options.answerSummary;
  const operationId = `op_query_${randomUUID().replaceAll("-", "")}`;
  const operation: OperationRecordV1 = {
    version: 1,
    id: operationId,
    kind: "query",
    status: options.outcome === "answered" ? "completed" : options.outcome,
    startedAt: session.startedAt,
    completedAt: now,
    summary: options.answerSummary,
    pageIds: [...new Set(attachedOperations.flatMap((item) => item.pageIds))],
    tiersUsed: session.tiersUsed,
    queryId: session.id,
  };
  const committed = await commitQueryOperation(
    root,
    session,
    operation,
    testOptions,
  );
  session.sync = committed.sync ?? (await attemptManagedSync(root));
  await writeQuerySession(root, session);
  return {
    session,
    operationId,
    ...(committed.commit ? { commit: committed.commit } : {}),
    sync: session.sync,
  };
}
