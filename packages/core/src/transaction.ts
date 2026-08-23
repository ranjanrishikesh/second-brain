import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import { searchBrain } from "./search.js";
import {
  loadWikiPages,
  validateWikiGraph,
  type AuditReportV1,
} from "./wiki/graph.js";
import { writeGeneratedWikiFiles } from "./wiki/generated.js";
import { applyWikiChangeSet } from "./wiki/mutate.js";
import { renderWikiPage } from "./wiki/page.js";
import { canonicalWikiPagePath } from "./wiki/path.js";
import {
  changeSetV1Schema,
  type ChangeSetV1,
  type WikiPageV1,
} from "./wiki/types.js";

const execFile = promisify(execFileCallback);

export const operationRecordV1Schema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^op_[a-z0-9_-]{3,96}$/),
  kind: z.enum([
    "apply",
    "query",
    "source-scan",
    "source-supersede",
    "bootstrap",
    "audit",
    "web-capture",
  ]),
  status: z.enum(["completed", "unanswered", "partial"]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  summary: z.string().trim().min(1),
  pageIds: z.array(z.string()),
  tiersUsed: z.array(z.enum(["wiki", "sources", "web"])),
  queryId: z
    .string()
    .regex(/^qry_[a-f0-9]{32}$/)
    .optional(),
});

export type OperationRecordV1 = z.infer<typeof operationRecordV1Schema>;

export interface TransactionResult {
  operationId: string;
  commit?: string;
  pages: WikiPageV1[];
  audit: AuditReportV1;
}

export interface TransactionTestOptions {
  /** Deterministic fault injection for recovery tests; never use in normal operation. */
  simulateCrashAfter?: "prepared" | "files-applied" | "committed";
  /** Simulates an external commit immediately before the transaction's HEAD guard. */
  simulateHeadMovementBeforeCommit?: boolean;
}

export interface ApplyTransactionOptions extends TransactionTestOptions {
  /** Bind this mutation to the currently open query and its active evidence tier. */
  queryId?: string;
}

interface QueryMutationBinding {
  queryId: string;
  tier: "wiki" | "sources" | "web";
}

class SimulatedTransactionCrash extends Error {
  constructor(phase: string) {
    super(`Simulated transaction crash after ${phase}`);
  }
}

function simulateCrash(
  options: TransactionTestOptions,
  phase: NonNullable<TransactionTestOptions["simulateCrashAfter"]>,
): void {
  if (options.simulateCrashAfter === phase) {
    throw new SimulatedTransactionCrash(phase);
  }
}

const transactionJournalSchema = z.object({
  version: z.literal(1),
  operationId: z.string().regex(/^op_[a-z0-9_-]{3,96}$/),
  phase: z.enum(["prepared", "files-applied", "committed"]),
  preHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})?$/),
  backupPath: z.string().min(1),
  commitHash: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .optional(),
  gitRepository: z.boolean().optional(),
  stagePaths: z.array(z.string()).optional(),
  canonicalCommitComplete: z.boolean().optional(),
});

type TransactionJournal = z.infer<typeof transactionJournalSchema>;

const writerLockSchema = z.object({
  pid: z.number().int().positive(),
  operationId: z.string().regex(/^op_[a-z0-9_-]{3,96}$/),
  recoverable: z.boolean().optional(),
});

const trackedBrainFiles = [
  ".brain/source-manifest.json",
  ".brain/state.json",
  ".brain/operations.jsonl",
] as const;

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

function safePagePath(root: string, pagePath: string): string {
  const pageRoot = path.resolve(root, "wiki", "pages");
  const canonicalPath = canonicalWikiPagePath(pagePath);
  const absolutePath = path.resolve(root, canonicalPath);
  if (
    !absolutePath.startsWith(`${pageRoot}${path.sep}`) ||
    !absolutePath.endsWith(".md")
  ) {
    throw new Error(`Unsafe wiki page path: ${pagePath}`);
  }
  return absolutePath;
}

async function copyBrainSnapshot(
  root: string,
  backupPath: string,
): Promise<void> {
  await mkdir(backupPath, { recursive: true });
  await cp(path.join(root, "wiki"), path.join(backupPath, "wiki"), {
    recursive: true,
  });
  await mkdir(path.join(backupPath, ".brain"), { recursive: true });
  for (const relativePath of trackedBrainFiles) {
    await cp(
      path.join(root, relativePath),
      path.join(backupPath, relativePath),
    );
  }
}

async function restoreBrainSnapshot(
  root: string,
  backupPath: string,
): Promise<void> {
  await rm(path.join(root, "wiki"), { recursive: true, force: true });
  await cp(path.join(backupPath, "wiki"), path.join(root, "wiki"), {
    recursive: true,
  });
  for (const relativePath of trackedBrainFiles) {
    await cp(
      path.join(backupPath, relativePath),
      path.join(root, relativePath),
    );
  }
}

async function writeJournal(
  journalPath: string,
  journal: TransactionJournal,
): Promise<void> {
  const temporaryPath = `${journalPath}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(journal, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, journalPath);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeStagePaths(root: string, stagePaths: string[]): string[] {
  return [...new Set(stagePaths)].map((relativePath) => {
    const normalized = relativePath.replaceAll("\\", "/");
    const absolutePath = path.resolve(root, normalized);
    if (
      path.isAbsolute(relativePath) ||
      normalized.startsWith(":") ||
      !absolutePath.startsWith(`${path.resolve(root)}${path.sep}`)
    ) {
      throw new Error(`Unsafe managed stage path: ${relativePath}`);
    }
    return normalized;
  });
}

export interface CanonicalWriteResult<T> {
  value: T;
  commit?: string;
}

export interface CanonicalMutationResult<T> {
  value: T;
  stagePaths: string[];
}

export interface CanonicalWriteOptions<T> {
  operationId: string;
  commitMessage: string | ((value: T) => string);
  testOptions?: TransactionTestOptions;
}

export async function runCanonicalWrite<T>(
  root: string,
  options: CanonicalWriteOptions<T>,
  mutate: () => Promise<CanonicalMutationResult<T>>,
): Promise<CanonicalWriteResult<T>> {
  if (!/^op_[a-z0-9_-]{3,96}$/.test(options.operationId)) {
    throw new Error(`Invalid operationId: ${options.operationId}`);
  }
  const runtimePath = path.join(root, ".brain", "runtime");
  const journalPath = path.join(runtimePath, "transaction.json");
  if (await pathExists(journalPath)) {
    throw new Error(
      "Brain recovery is required before another canonical write",
    );
  }
  const gitRepository = await isGitRepository(root);
  if (gitRepository) {
    const repositoryRoot = await git(root, ["rev-parse", "--show-toplevel"]);
    if ((await realpath(repositoryRoot)) !== (await realpath(root))) {
      throw new Error("Brain root must be the Git repository root");
    }
    if (await hasStagedChanges(root)) {
      throw new Error("Refusing canonical write while Git has staged changes");
    }
    const dirtyManaged = await git(root, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      "wiki",
      ...trackedBrainFiles,
    ]);
    if (dirtyManaged) {
      throw new Error(
        `Refusing canonical write with dirty managed files:\n${dirtyManaged}`,
      );
    }
  }

  const transactionRoot = path.resolve(runtimePath, "transactions");
  const transactionPath = path.resolve(transactionRoot, options.operationId);
  if (!transactionPath.startsWith(`${transactionRoot}${path.sep}`)) {
    throw new Error(`Unsafe operationId: ${options.operationId}`);
  }
  const backupPath = path.join(transactionPath, "backup");
  const lockPath = path.join(runtimePath, "writer.lock");
  await mkdir(runtimePath, { recursive: true });
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: process.pid,
      operationId: options.operationId,
      recoverable: false,
    })}\n`,
    { flag: "wx" },
  );
  let committed = false;
  let stagePaths: string[] = [];
  let snapshotPrepared = false;
  try {
    const preHead = gitRepository ? await git(root, ["rev-parse", "HEAD"]) : "";
    await mkdir(transactionRoot, { recursive: true });
    const realRuntime = await realpath(runtimePath);
    const realTransactionRoot = await realpath(transactionRoot);
    if (!realTransactionRoot.startsWith(`${realRuntime}${path.sep}`)) {
      throw new Error("Unsafe canonical transaction root");
    }
    await mkdir(transactionPath);
    await copyBrainSnapshot(root, backupPath);
    snapshotPrepared = true;
    const journal: TransactionJournal = {
      version: 1,
      operationId: options.operationId,
      phase: "prepared",
      preHead,
      backupPath,
      gitRepository,
      stagePaths,
    };
    await writeJournal(journalPath, journal);
    simulateCrash(options.testOptions ?? {}, "prepared");

    const mutation = await mutate();
    stagePaths = safeStagePaths(root, mutation.stagePaths);
    journal.stagePaths = stagePaths;
    journal.phase = "files-applied";
    await writeJournal(journalPath, journal);
    simulateCrash(options.testOptions ?? {}, "files-applied");

    const config = await loadBrainConfig(root);
    let commit: string | undefined;
    if (gitRepository && config.git.autoCommit && stagePaths.length > 0) {
      if (options.testOptions?.simulateHeadMovementBeforeCommit) {
        await git(root, [
          "commit",
          "--allow-empty",
          "-m",
          "test: concurrent HEAD movement",
        ]);
      }
      if ((await git(root, ["rev-parse", "HEAD"])) !== preHead) {
        throw new Error("Git HEAD changed during the canonical write");
      }
      if (await hasStagedChanges(root)) {
        throw new Error(
          "Git index changed during the canonical write; refusing to commit",
        );
      }
      await git(root, ["add", "--", ...stagePaths]);
      if ((await git(root, ["rev-parse", "HEAD"])) !== preHead) {
        throw new Error("Git HEAD changed during the canonical write");
      }
      const commitMessage =
        typeof options.commitMessage === "function"
          ? options.commitMessage(mutation.value)
          : options.commitMessage;
      await git(root, ["commit", "-m", commitMessage]);
      commit = await git(root, ["rev-parse", "HEAD"]);
      committed = true;
      journal.commitHash = commit;
    } else {
      committed = true;
    }
    journal.canonicalCommitComplete = true;
    journal.phase = "committed";
    await writeJournal(journalPath, journal);
    simulateCrash(options.testOptions ?? {}, "committed");

    await rm(transactionPath, { recursive: true, force: true });
    await rm(journalPath, { force: true });
    await rm(lockPath, { force: true });
    return {
      value: mutation.value,
      ...(commit ? { commit } : {}),
    };
  } catch (error) {
    if (error instanceof SimulatedTransactionCrash) {
      await writeFile(
        lockPath,
        `${JSON.stringify({
          pid: process.pid,
          operationId: options.operationId,
          recoverable: true,
        })}\n`,
        "utf8",
      ).catch(() => undefined);
      throw error;
    }
    if (!committed && snapshotPrepared) {
      await restoreBrainSnapshot(root, backupPath).catch(() => undefined);
      if (gitRepository && stagePaths.length > 0) {
        await execFile("git", ["restore", "--staged", "--", ...stagePaths], {
          cwd: root,
        }).catch(() => undefined);
      }
    }
    await rm(transactionPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await rm(journalPath, { force: true }).catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function appendOperation(
  root: string,
  changeSet: ChangeSetV1,
  now: string,
  binding?: QueryMutationBinding,
): Promise<void> {
  const record: OperationRecordV1 = {
    version: 1,
    id: changeSet.operationId,
    kind: "apply",
    status: "completed",
    startedAt: now,
    completedAt: now,
    summary: changeSet.reason,
    pageIds: changeSet.pages.map((mutation) => mutation.page.id),
    tiersUsed: binding ? [binding.tier] : [],
    ...(binding ? { queryId: binding.queryId } : {}),
  };
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const existing = await readFile(operationsPath, "utf8");
  await writeFile(
    operationsPath,
    `${existing}${JSON.stringify(record)}\n`,
    "utf8",
  );
  const logPath = path.join(root, "wiki", "log.md");
  const log = await readFile(logPath, "utf8");
  await writeFile(
    logPath,
    `${log.trimEnd()}\n\n## [${now}] apply | ${changeSet.reason}\n\n- Operation: \`${changeSet.operationId}\`\n- Pages: ${record.pageIds.map((id) => `\`${id}\``).join(", ") || "none"}\n`,
    "utf8",
  );
}

async function readQueryMutationBinding(
  root: string,
  queryId: string,
): Promise<QueryMutationBinding> {
  if (!/^qry_[a-f0-9]{32}$/.test(queryId)) {
    throw new Error(`Invalid query ID: ${queryId}`);
  }
  const session = z
    .object({
      id: z.literal(queryId),
      status: z.literal("open"),
      currentTier: z.enum(["wiki", "sources", "web"]),
    })
    .parse(
      JSON.parse(
        await readFile(
          path.join(root, ".brain", "runtime", "queries", `${queryId}.json`),
          "utf8",
        ),
      ),
    );
  return { queryId: session.id, tier: session.currentTier };
}

function safeCommitText(value: string): string {
  return value
    .replace(/[\r\n\0]+/g, " ")
    .trim()
    .slice(0, 120);
}

export async function applyChangeSetTransaction(
  root: string,
  rawChangeSet: ChangeSetV1,
  options: ApplyTransactionOptions = {},
): Promise<TransactionResult> {
  const changeSet = changeSetV1Schema.parse(rawChangeSet);
  const result = await runCanonicalWrite(
    root,
    {
      operationId: changeSet.operationId,
      commitMessage: `brain(apply): ${safeCommitText(changeSet.reason)} [op:${safeCommitText(changeSet.operationId)}]`,
      testOptions: options,
    },
    async () => {
      const binding = options.queryId
        ? await readQueryMutationBinding(root, options.queryId)
        : undefined;
      const currentPages = await loadWikiPages(root);
      const proposedPages = applyWikiChangeSet(currentPages, changeSet);
      const config = await loadBrainConfig(root);
      const changedPageIds = new Set(
        changeSet.pages.map((mutation) => mutation.page.id),
      );
      const proposedById = new Map(
        proposedPages.map((page) => [page.id, page]),
      );
      const declaredCandidates = new Set(
        changeSet.reconciliation.candidatePageIds,
      );
      for (const mutation of changeSet.pages) {
        const relatedResults = await searchBrain(root, {
          query: `${mutation.page.title} ${mutation.page.summary}`,
          scope: "wiki",
          limit: config.graph.relatedPageLimit,
        });
        for (const result of relatedResults) {
          const candidate = proposedById.get(result.id);
          if (
            !candidate ||
            changedPageIds.has(candidate.id) ||
            candidate.status === "archived"
          ) {
            continue;
          }
          if (!declaredCandidates.has(candidate.id)) {
            throw new Error(
              `Reconciliation related-page search candidate is missing: ${candidate.id}`,
            );
          }
        }
      }
      const proposedPaths = new Set(proposedPages.map((page) => page.path));
      for (const page of proposedPages) safePagePath(root, page.path);
      for (const currentPage of currentPages) {
        if (!proposedPaths.has(currentPage.path)) {
          await rm(safePagePath(root, currentPage.path), { force: true });
        }
      }
      for (const page of proposedPages) {
        const absolutePath = safePagePath(root, page.path);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, renderWikiPage(page), "utf8");
      }
      await writeGeneratedWikiFiles(root);
      const audit = await validateWikiGraph(root);
      if (!audit.ok) {
        throw new Error(
          `Wiki graph validation failed:\n${audit.issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => `${issue.code}: ${issue.message}`)
            .join("\n")}`,
        );
      }

      const statePath = path.join(root, ".brain", "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<
        string,
        unknown
      > & {
        knowledgeMutations?: number;
        lastSemanticAuditMutation?: number;
      };
      const knowledgeMutations =
        (state.knowledgeMutations ?? 0) + (changeSet.pages.length ? 1 : 0);
      const sourceManifest = z
        .object({
          sources: z.array(z.object({ id: z.string() })),
        })
        .parse(
          JSON.parse(
            await readFile(
              path.join(root, ".brain", "source-manifest.json"),
              "utf8",
            ),
          ),
        );
      const catalogedSourceIds = new Set(
        proposedPages
          .filter((page) => page.type === "source")
          .flatMap((page) => page.sources.map((source) => source.id)),
      );
      const pendingSourceIds = sourceManifest.sources
        .map((source) => source.id)
        .filter((sourceId) => !catalogedSourceIds.has(sourceId))
        .sort();
      await writeFile(
        statePath,
        `${JSON.stringify(
          {
            ...state,
            catalogRevision: audit.catalogRevision,
            knowledgeMutations,
            bootstrap: {
              status: pendingSourceIds.length ? "pending" : "completed",
              pendingSourceIds,
            },
            semanticAuditDue:
              knowledgeMutations - (state.lastSemanticAuditMutation ?? 0) >=
              config.graph.semanticAuditEvery,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const now = new Date().toISOString();
      await appendOperation(root, changeSet, now, binding);
      return {
        value: {
          operationId: changeSet.operationId,
          pages: proposedPages,
          audit,
        },
        stagePaths: ["wiki", ...trackedBrainFiles],
      };
    },
  );
  return {
    ...result.value,
    ...(result.commit ? { commit: result.commit } : {}),
  };
}

export async function recoverBrain(
  root: string,
): Promise<"clean" | "restored" | "committed"> {
  const runtimePath = path.join(root, ".brain", "runtime");
  const journalPath = path.join(runtimePath, "transaction.json");
  const lockPath = path.join(runtimePath, "writer.lock");
  let writerLock: z.infer<typeof writerLockSchema> | undefined;
  try {
    writerLock = writerLockSchema.parse(
      JSON.parse(await readFile(lockPath, "utf8")),
    );
    if (!writerLock.recoverable) {
      try {
        process.kill(writerLock.pid, 0);
        throw new Error(
          `Canonical writer is active for ${writerLock.operationId}`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let journal: TransactionJournal;
  try {
    journal = transactionJournalSchema.parse(
      JSON.parse(await readFile(journalPath, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (writerLock) {
        await rm(
          path.join(runtimePath, "transactions", writerLock.operationId),
          { recursive: true, force: true },
        );
        await rm(lockPath, { force: true });
      }
      return "clean";
    }
    throw error;
  }
  const transactionRoot = path.resolve(runtimePath, "transactions");
  const expectedBackupPath = path.join(
    transactionRoot,
    journal.operationId,
    "backup",
  );
  if (path.resolve(journal.backupPath) !== expectedBackupPath) {
    throw new Error("Unsafe recovery journal backup path");
  }
  const realRuntime = await realpath(runtimePath);
  const realTransactionRoot = await realpath(transactionRoot);
  const realBackupPath = await realpath(expectedBackupPath);
  if (
    !realTransactionRoot.startsWith(`${realRuntime}${path.sep}`) ||
    !realBackupPath.startsWith(`${realTransactionRoot}${path.sep}`)
  ) {
    throw new Error("Unsafe recovery journal filesystem target");
  }
  safeStagePaths(root, journal.stagePaths ?? []);
  const gitRepository = journal.gitRepository ?? true;
  const head = gitRepository ? await git(root, ["rev-parse", "HEAD"]) : "";
  let transactionCommitExists = false;
  if (journal.phase === "committed" && journal.commitHash) {
    transactionCommitExists = await execFile(
      "git",
      ["merge-base", "--is-ancestor", journal.commitHash, head],
      { cwd: root },
    )
      .then(() => true)
      .catch(() => false);
  } else if (journal.phase === "committed" && journal.canonicalCommitComplete) {
    transactionCommitExists = true;
  } else if (
    gitRepository &&
    journal.phase !== "prepared" &&
    journal.preHead !== head
  ) {
    const matchingCommits = await git(root, [
      "log",
      "--format=%H",
      "--fixed-strings",
      `--grep=[op:${journal.operationId}]`,
      `${journal.preHead}..${head}`,
    ]).catch(() => "");
    transactionCommitExists = matchingCommits.length > 0;
  }
  const outcome = transactionCommitExists ? "committed" : "restored";
  if (outcome === "restored") {
    await restoreBrainSnapshot(root, journal.backupPath);
    if (gitRepository && (journal.stagePaths?.length ?? 0) > 0) {
      await execFile(
        "git",
        ["restore", "--staged", "--", ...(journal.stagePaths ?? [])],
        { cwd: root },
      ).catch(() => undefined);
    }
  }
  await rm(path.dirname(journal.backupPath), { recursive: true, force: true });
  await rm(journalPath, { force: true });
  await rm(path.join(runtimePath, "mutation.lock"), { force: true });
  await rm(lockPath, { force: true });
  return outcome;
}
