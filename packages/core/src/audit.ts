import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import type { OperationRecordV1 } from "./transaction.js";
import { loadWikiPages, validateWikiGraph } from "./wiki/graph.js";

const execFile = promisify(execFileCallback);

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
  const pendingPageIds =
    state.semanticAudit?.status === "pending"
      ? state.semanticAudit.pendingPageIds
      : await initialPendingPageIds(root);
  const config = await loadBrainConfig(root);
  return {
    version: 1,
    targetMutation:
      state.semanticAudit?.targetMutation ?? state.knowledgeMutations,
    pageIds: pendingPageIds.slice(0, config.bootstrap.batchSize),
    reviewedPageIds: state.semanticAudit?.reviewedPageIds ?? [],
    complete: pendingPageIds.length === 0,
  };
}

export async function recordSemanticAuditBatch(
  root: string,
  rawInput: RecordSemanticAuditInput,
): Promise<RecordSemanticAuditResult> {
  const input = recordAuditInputSchema.parse(rawInput);
  const statePath = path.join(root, ".brain", "state.json");
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const logPath = path.join(root, "wiki", "log.md");
  const before = new Map<string, string>();
  for (const filePath of [statePath, operationsPath, logPath]) {
    before.set(filePath, await readFile(filePath, "utf8"));
  }
  const state = await readState(root);
  if (!state.semanticAuditDue && state.semanticAudit?.status !== "pending") {
    throw new Error("A semantic audit is not due");
  }
  const now = new Date().toISOString();
  const targetMutation =
    state.semanticAudit?.targetMutation ?? state.knowledgeMutations;
  const initialPending =
    state.semanticAudit?.status === "pending"
      ? state.semanticAudit.pendingPageIds
      : await initialPendingPageIds(root);
  const requested = [...new Set(input.pageIds)];
  for (const pageId of requested) {
    if (!initialPending.includes(pageId)) {
      throw new Error(`Page is not pending semantic review: ${pageId}`);
    }
  }
  const reviewedPageIds = [
    ...new Set([...(state.semanticAudit?.reviewedPageIds ?? []), ...requested]),
  ].sort();
  const requestedIds = new Set(requested);
  const pendingPageIds = initialPending.filter(
    (pageId) => !requestedIds.has(pageId),
  );
  const complete = pendingPageIds.length === 0;
  const operationId = `op_audit_${randomUUID().replaceAll("-", "")}`;
  const operation: OperationRecordV1 = {
    version: 1,
    id: operationId,
    kind: "audit",
    status: "completed",
    startedAt: state.semanticAudit?.startedAt ?? now,
    completedAt: now,
    summary: input.summary,
    pageIds: requested,
    tiersUsed: [],
  };

  const gitRepository = await isGitRepository(root);
  if (gitRepository) {
    if (await hasStagedChanges(root)) {
      throw new Error("Refusing semantic audit while Git has staged changes");
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
        `Refusing semantic audit with dirty managed files:\n${dirtyManaged}`,
      );
    }
  }
  const runtimePath = path.join(root, ".brain", "runtime");
  const lockPath = path.join(runtimePath, "semantic-audit.lock");
  await mkdir(runtimePath, { recursive: true });
  await writeFile(lockPath, `${operationId}\n`, { flag: "wx" });
  try {
    const semanticAudit: SemanticAuditStateV1 = {
      status: complete ? "completed" : "pending",
      targetMutation,
      pendingPageIds,
      reviewedPageIds,
      startedAt: state.semanticAudit?.startedAt ?? now,
      ...(complete ? { completedAt: now } : {}),
    };
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          ...state,
          semanticAuditDue: !complete,
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
      `${before.get(operationsPath) ?? ""}${JSON.stringify(operation)}\n`,
      "utf8",
    );
    await writeFile(
      logPath,
      `${(before.get(logPath) ?? "").trimEnd()}\n\n## [${now}] audit | Semantic checkpoint\n\n- Operation: \`${operationId}\`\n- Reviewed: ${requested.map((id) => `\`${id}\``).join(", ")}\n- Remaining: ${pendingPageIds.length}\n- Summary: ${input.summary}\n`,
      "utf8",
    );
    let commit: string | undefined;
    const config = await loadBrainConfig(root);
    if (gitRepository && config.git.autoCommit) {
      const preHead = await git(root, ["rev-parse", "HEAD"]);
      await git(root, [
        "add",
        "--",
        ".brain/state.json",
        ".brain/operations.jsonl",
        "wiki/log.md",
      ]);
      if ((await git(root, ["rev-parse", "HEAD"])) !== preHead) {
        throw new Error("Git HEAD changed during semantic audit");
      }
      await git(root, [
        "commit",
        "-m",
        `brain(audit): review ${requested.length} page${requested.length === 1 ? "" : "s"} [op:${operationId}]`,
      ]);
      commit = await git(root, ["rev-parse", "HEAD"]);
    }
    return {
      version: 1,
      targetMutation,
      pageIds: pendingPageIds,
      reviewedPageIds,
      complete,
      operationId,
      ...(commit ? { commit } : {}),
    };
  } catch (error) {
    for (const [filePath, content] of before) {
      await writeFile(filePath, content, "utf8");
    }
    if (gitRepository) {
      await execFile(
        "git",
        [
          "restore",
          "--staged",
          "--",
          ".brain/state.json",
          ".brain/operations.jsonl",
          "wiki/log.md",
        ],
        { cwd: root },
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(lockPath, { force: true });
  }
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
