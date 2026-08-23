import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import {
  readQuerySession,
  refreshQueryBootstrap,
  writeQuerySession,
  type QuerySessionV1,
} from "./query.js";
import type { OperationRecordV1 } from "./transaction.js";
import { loadWikiPages } from "./wiki/graph.js";

const execFile = promisify(execFileCallback);

const finishQueryOptionsSchema = z.object({
  outcome: z.enum(["answered", "partial", "unanswered"]),
  answerSummary: z.string().trim().min(1),
});

export type FinishQueryOptions = z.infer<typeof finishQueryOptionsSchema>;

export interface FinishQueryResult {
  session: QuerySessionV1;
  operationId: string;
  commit?: string;
}

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function isGitRepository(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function hasStagedChanges(root: string): Promise<boolean> {
  try {
    await execFile("git", ["diff", "--cached", "--quiet", "--exit-code"], {
      cwd: root,
    });
    return false;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return true;
    throw error;
  }
}

async function readOperations(root: string): Promise<OperationRecordV1[]> {
  const content = await readFile(
    path.join(root, ".brain", "operations.jsonl"),
    "utf8",
  );
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OperationRecordV1);
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
): Promise<string | undefined> {
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const logPath = path.join(root, "wiki", "log.md");
  const beforeOperations = await readFile(operationsPath, "utf8");
  const beforeLog = await readFile(logPath, "utf8");
  const gitRepository = await isGitRepository(root);
  const config = await loadBrainConfig(root);
  if (gitRepository) {
    if (await hasStagedChanges(root)) {
      throw new Error("Refusing query completion while Git has staged changes");
    }
    const dirtyManaged = await git(root, [
      "status",
      "--porcelain=v1",
      "--",
      "wiki",
      ".brain/source-manifest.json",
      ".brain/state.json",
      ".brain/operations.jsonl",
    ]);
    if (dirtyManaged) {
      throw new Error(
        `Refusing query completion with dirty managed files:\n${dirtyManaged}`,
      );
    }
  }

  const runtimePath = path.join(root, ".brain", "runtime");
  const lockPath = path.join(runtimePath, "query-finish.lock");
  await mkdir(runtimePath, { recursive: true });
  await writeFile(lockPath, `${session.id}\n`, { flag: "wx" });
  try {
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
    if (!gitRepository || !config.git.autoCommit) return undefined;
    const preHead = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["add", "--", ".brain/operations.jsonl", "wiki/log.md"]);
    if ((await git(root, ["rev-parse", "HEAD"])) !== preHead) {
      throw new Error("Git HEAD changed during query completion");
    }
    await git(root, [
      "commit",
      "-m",
      `brain(query): ${session.question.replace(/[\r\n\0]+/g, " ").slice(0, 100)} [op:${operation.id}]`,
    ]);
    return await git(root, ["rev-parse", "HEAD"]);
  } catch (error) {
    await writeFile(operationsPath, beforeOperations, "utf8");
    await writeFile(logPath, beforeLog, "utf8");
    if (gitRepository) {
      await execFile(
        "git",
        ["restore", "--staged", "--", ".brain/operations.jsonl", "wiki/log.md"],
        { cwd: root },
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(lockPath, { force: true });
  }
}

export async function finishQuery(
  root: string,
  queryId: string,
  rawOptions: FinishQueryOptions,
): Promise<FinishQueryResult> {
  const options = finishQueryOptionsSchema.parse(rawOptions);
  const session = await readQuerySession(root, queryId);
  if (session.status !== "open")
    throw new Error(`Query is not open: ${queryId}`);
  await refreshQueryBootstrap(root, session);
  await writeQuerySession(root, session);
  if (session.bootstrap.required) {
    throw new Error(
      `Catalog bootstrap is incomplete for ${session.bootstrap.pendingSourceIds.length} source(s)`,
    );
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
    return operation;
  });
  if (options.outcome === "unanswered") {
    const changedPageIds = new Set(
      attachedOperations.flatMap((item) => item.pageIds),
    );
    const hasGapPage = (await loadWikiPages(root)).some(
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
  const commit = await commitQueryOperation(root, session, operation);
  await writeQuerySession(root, session);
  return {
    session,
    operationId,
    ...(commit ? { commit } : {}),
  };
}
