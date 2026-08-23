import { execFile as execFileCallback } from "node:child_process";
import {
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
import {
  loadWikiPages,
  validateWikiGraph,
  type AuditReportV1,
} from "./wiki/graph.js";
import { writeGeneratedWikiFiles } from "./wiki/generated.js";
import { applyWikiChangeSet } from "./wiki/mutate.js";
import { renderWikiPage } from "./wiki/page.js";
import type { ChangeSetV1, WikiPageV1 } from "./wiki/types.js";

const execFile = promisify(execFileCallback);

export const operationRecordV1Schema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1),
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

interface TransactionJournal {
  version: 1;
  operationId: string;
  phase: "prepared" | "files-applied" | "committed";
  preHead: string;
  backupPath: string;
}

const trackedBrainFiles = [
  ".brain/source-manifest.json",
  ".brain/state.json",
  ".brain/operations.jsonl",
] as const;

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
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
  const absolutePath = path.resolve(root, pagePath);
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

async function appendOperation(
  root: string,
  changeSet: ChangeSetV1,
  now: string,
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
    tiersUsed: [],
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

function safeCommitText(value: string): string {
  return value
    .replace(/[\r\n\0]+/g, " ")
    .trim()
    .slice(0, 120);
}

export async function applyChangeSetTransaction(
  root: string,
  changeSet: ChangeSetV1,
  testOptions: TransactionTestOptions = {},
): Promise<TransactionResult> {
  const repositoryRoot = await git(root, ["rev-parse", "--show-toplevel"]);
  if ((await realpath(repositoryRoot)) !== (await realpath(root))) {
    throw new Error("Brain root must be the Git repository root");
  }
  if (await hasStagedChanges(root)) {
    throw new Error("Refusing brain mutation while Git has staged changes");
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
      `Refusing brain mutation with dirty managed files:\n${dirtyManaged}`,
    );
  }

  const runtimePath = path.join(root, ".brain", "runtime");
  const transactionPath = path.join(
    runtimePath,
    "transactions",
    changeSet.operationId,
  );
  const backupPath = path.join(transactionPath, "backup");
  const lockPath = path.join(runtimePath, "mutation.lock");
  const journalPath = path.join(runtimePath, "transaction.json");
  await mkdir(runtimePath, { recursive: true });
  await writeFile(lockPath, `${changeSet.operationId}\n`, { flag: "wx" });
  const preHead = await git(root, ["rev-parse", "HEAD"]);
  let committed = false;
  try {
    await copyBrainSnapshot(root, backupPath);
    const journal: TransactionJournal = {
      version: 1,
      operationId: changeSet.operationId,
      phase: "prepared",
      preHead,
      backupPath,
    };
    await writeJournal(journalPath, journal);
    simulateCrash(testOptions, "prepared");

    const currentPages = await loadWikiPages(root);
    const proposedPages = applyWikiChangeSet(currentPages, changeSet);
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
    const config = await loadBrainConfig(root);
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          ...state,
          catalogRevision: audit.catalogRevision,
          knowledgeMutations,
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
    await appendOperation(root, changeSet, now);
    journal.phase = "files-applied";
    await writeJournal(journalPath, journal);
    simulateCrash(testOptions, "files-applied");

    let commit: string | undefined;
    if (config.git.autoCommit) {
      if (testOptions.simulateHeadMovementBeforeCommit) {
        await git(root, [
          "commit",
          "--allow-empty",
          "-m",
          "test: concurrent HEAD movement",
        ]);
      }
      if ((await git(root, ["rev-parse", "HEAD"])) !== preHead) {
        throw new Error("Git HEAD changed during the brain transaction");
      }
      await git(root, ["add", "--", "wiki", ...trackedBrainFiles]);
      await git(root, [
        "commit",
        "-m",
        `brain(apply): ${safeCommitText(changeSet.reason)} [op:${safeCommitText(changeSet.operationId)}]`,
      ]);
      commit = await git(root, ["rev-parse", "HEAD"]);
      committed = true;
      journal.phase = "committed";
      await writeJournal(journalPath, journal);
      simulateCrash(testOptions, "committed");
    }
    await rm(transactionPath, { recursive: true, force: true });
    await rm(journalPath, { force: true });
    await rm(lockPath, { force: true });
    return {
      operationId: changeSet.operationId,
      ...(commit ? { commit } : {}),
      pages: proposedPages,
      audit,
    };
  } catch (error) {
    if (error instanceof SimulatedTransactionCrash) throw error;
    if (!committed) {
      await restoreBrainSnapshot(root, backupPath).catch(() => undefined);
      await execFile(
        "git",
        ["restore", "--staged", "--", "wiki", ...trackedBrainFiles],
        { cwd: root },
      ).catch(() => undefined);
    }
    await rm(transactionPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await rm(journalPath, { force: true }).catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function recoverBrain(
  root: string,
): Promise<"clean" | "restored" | "committed"> {
  const runtimePath = path.join(root, ".brain", "runtime");
  const journalPath = path.join(runtimePath, "transaction.json");
  let journal: TransactionJournal;
  try {
    journal = JSON.parse(
      await readFile(journalPath, "utf8"),
    ) as TransactionJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "clean";
    throw error;
  }
  const head = await git(root, ["rev-parse", "HEAD"]);
  const outcome =
    journal.phase === "committed" || head !== journal.preHead
      ? "committed"
      : "restored";
  if (outcome === "restored")
    await restoreBrainSnapshot(root, journal.backupPath);
  await rm(path.dirname(journal.backupPath), { recursive: true, force: true });
  await rm(journalPath, { force: true });
  await rm(path.join(runtimePath, "mutation.lock"), { force: true });
  return outcome;
}
