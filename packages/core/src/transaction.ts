import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import { readBrainState, type SyncStatusV1 } from "./state.js";
import type { BrainRuntimeServices } from "./semantic.js";
import {
  assertReconciliationPlanMatches,
  assertReconciliationReceipt,
  planReconciliation,
} from "./reconciliation.js";
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
    "identity",
    "charter",
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
  setupId: z
    .string()
    .regex(/^setup_[a-f0-9]{32}$/)
    .optional(),
});

export type OperationRecordV1 = z.infer<typeof operationRecordV1Schema>;

export interface TransactionResult {
  operationId: string;
  commit?: string;
  sync?: SyncStatusV1;
  pages: WikiPageV1[];
  audit: AuditReportV1;
}

export interface TransactionTestOptions {
  /** Deterministic fault injection for recovery tests; never use in normal operation. */
  simulateCrashAfter?:
    | "prepared"
    | "files-applied"
    | "committed"
    | "journal-removed";
  /** Simulates an external commit immediately before the transaction's HEAD guard. */
  simulateHeadMovementBeforeCommit?: boolean;
  /** Simulates a rollback failure after a canonical mutation has failed. */
  simulateRollbackFailure?: boolean;
  /** Simulates a failure after the commit ref moves but before its index is published. */
  simulateIndexPublishFailure?: boolean;
  /** Runs immediately before managed files are staged; used for deterministic race tests. */
  beforeStage?: () => Promise<void> | void;
  /** Runs after a mutation completes and before its private index is staged. */
  afterMutation?: () => Promise<void> | void;
  /** Runs after a mutation completes but before its authoritative output is sealed. */
  afterMutationBeforeSeal?: () => Promise<void> | void;
  /** Runs only after this transaction owns the ordinary Git index lock. */
  afterIndexLock?: () => Promise<void> | void;
  /** Runs after the private index replaces the owned lock but before rename. */
  afterIndexCopy?: () => Promise<void> | void;
}

export interface ApplyTransactionOptions extends TransactionTestOptions {
  /** Bind this mutation to the currently open query and its active evidence tier. */
  queryId?: string;
  /** Preferred lifecycle binding for a canonical knowledge mutation. */
  context?: KnowledgeMutationContext;
  /** Dependency injection for verified local semantic reconciliation. */
  runtimeServices?: BrainRuntimeServices;
}

export interface RecoveryTestOptions {
  /** Runs after recovery acquires its replacement Git index lock. */
  afterIndexLock?: () => Promise<void> | void;
}

export type KnowledgeMutationContext =
  | { kind: "query"; id: string }
  | { kind: "setup"; id: string };

interface QueryMutationBinding {
  kind: "query";
  queryId: string;
  tier: "wiki" | "sources" | "web";
}

interface SetupMutationBinding {
  kind: "setup";
  setupId: string;
}

type MutationBinding = QueryMutationBinding | SetupMutationBinding;

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

function rollbackRecoveryError(operationId: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Canonical rollback failed; recovery is required for ${operationId}: ${detail}`,
  );
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
  preexistingIndexPaths: z.array(z.string()).optional(),
  /** New transactions build a private Git index and never mutate the shared one. */
  isolatedIndex: z.boolean().optional(),
  /** The private index has been atomically published as the repository index. */
  indexPublished: z.boolean().optional(),
  /** The exact standard Git lock that this journal is authorized to recover. */
  gitIndexLockPath: z.string().min(1).optional(),
  /** Independent identity for a lock whose contents may become binary index bytes. */
  gitIndexLock: z
    .object({
      path: z.string().min(1),
      token: z.string().uuid(),
      device: z.string().min(1),
      inode: z.string().min(1),
    })
    .optional(),
  canonicalCommitComplete: z.boolean().optional(),
  /** Extra root files included in this operation's snapshot and seal. */
  managedRootPaths: z.array(z.string()).optional(),
});

type TransactionJournal = z.infer<typeof transactionJournalSchema>;

const writerLockSchema = z.object({
  pid: z.number().int().positive(),
  operationId: z.string().regex(/^op_[a-z0-9_-]{3,96}$/),
  recoverable: z.boolean().optional(),
});

const gitIndexLockSchema = z.object({
  version: z.literal(1),
  operationId: z.string().regex(/^op_[a-z0-9_-]{3,96}$/),
  pid: z.number().int().positive(),
  token: z.string().uuid(),
});

const trackedBrainFiles = [
  ".brain/source-manifest.json",
  ".brain/state.json",
  ".brain/operations.jsonl",
] as const;

const allowedManagedRootFiles = new Set(["BRAIN.md", "brain.config.yaml"]);

function safeManagedRootPaths(relativePaths: readonly string[] = []): string[] {
  return [...new Set(relativePaths)].map((relativePath) => {
    if (!allowedManagedRootFiles.has(relativePath)) {
      throw new Error(`Unsafe managed root path: ${relativePath}`);
    }
    return relativePath;
  });
}

function gitEnvironment(indexPath?: string): NodeJS.ProcessEnv | undefined {
  return indexPath ? { ...process.env, GIT_INDEX_FILE: indexPath } : undefined;
}

async function git(
  root: string,
  args: string[],
  indexPath?: string,
): Promise<string> {
  return (
    await execFile("git", args, {
      cwd: root,
      ...(indexPath ? { env: gitEnvironment(indexPath) } : {}),
    })
  ).stdout.trim();
}

async function isGitRepository(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function currentGitHead(root: string): Promise<string> {
  try {
    return await git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch (error) {
    if ((error as { code?: number }).code === 128) return "";
    throw error;
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

interface HeldGitIndexLock {
  indexPath: string;
  lockPath: string;
  operationId: string;
  token: string;
  device: string;
  inode: string;
}

async function gitIndexPath(root: string): Promise<string> {
  const configuredPath = await git(root, ["rev-parse", "--git-path", "index"]);
  return path.resolve(root, configuredPath);
}

async function holdGitIndexLock(
  root: string,
  operationId: string,
): Promise<HeldGitIndexLock> {
  const indexPath = await gitIndexPath(root);
  const lockPath = `${indexPath}.lock`;
  const token = randomUUID();
  try {
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({ version: 1, operationId, pid: process.pid, token })}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Git index is busy; retry the canonical write after the other Git operation finishes",
      );
    }
    throw error;
  }
  const lockStat = await stat(lockPath);
  return {
    indexPath,
    lockPath,
    operationId,
    token,
    device: String(lockStat.dev),
    inode: String(lockStat.ino),
  };
}

async function releaseGitIndexLock(
  lock: HeldGitIndexLock | undefined,
): Promise<void> {
  if (!lock) return;
  let owned: z.infer<typeof gitIndexLockSchema>;
  try {
    owned = gitIndexLockSchema.parse(
      JSON.parse(await readFile(lock.lockPath, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      "The Git index lock changed ownership before it could be released; recovery is required",
    );
  }
  if (owned.operationId !== lock.operationId) {
    throw new Error(
      "The Git index lock belongs to another operation; recovery is required",
    );
  }
  if (owned.token !== lock.token) {
    throw new Error(
      "The Git index lock token changed before it could be released; recovery is required",
    );
  }
  const lockStat = await stat(lock.lockPath);
  if (
    String(lockStat.dev) !== lock.device ||
    String(lockStat.ino) !== lock.inode
  ) {
    throw new Error(
      "The Git index lock identity changed before it could be released; recovery is required",
    );
  }
  await rm(lock.lockPath);
}

async function publishHeldGitIndex(
  isolatedIndexPath: string,
  lock: HeldGitIndexLock,
  afterCopy?: () => Promise<void> | void,
): Promise<void> {
  await copyFile(isolatedIndexPath, lock.lockPath);
  await afterCopy?.();
  await rename(lock.lockPath, lock.indexPath);
}

async function runPreCommitHook(
  root: string,
  isolatedIndexPath: string,
): Promise<void> {
  await git(
    root,
    ["hook", "run", "--ignore-missing", "pre-commit"],
    isolatedIndexPath,
  );
}

function recordGitIndexLockOwnership(
  journal: TransactionJournal,
  lock: HeldGitIndexLock,
): void {
  journal.gitIndexLockPath = lock.lockPath;
  journal.gitIndexLock = {
    path: lock.lockPath,
    token: lock.token,
    device: lock.device,
    inode: lock.inode,
  };
}

async function publishRecoveredIsolatedIndex(
  root: string,
  transactionPath: string,
  preHead: string,
  commitHash: string,
  operationId: string,
  journalPath: string,
  journal: TransactionJournal,
  testOptions: RecoveryTestOptions = {},
): Promise<void> {
  const isolatedIndexPath = path.join(transactionPath, "git-index");
  if (!(await pathExists(isolatedIndexPath))) {
    throw new Error(
      "The private Git index needed to finish recovery is missing; manual Git recovery is required",
    );
  }
  const expectedTransactionPath = path.resolve(transactionPath);
  if (
    path.resolve(isolatedIndexPath) !==
    path.join(expectedTransactionPath, "git-index")
  ) {
    throw new Error("Unsafe private Git index path in recovery");
  }

  let indexLock: HeldGitIndexLock | undefined;
  const validationIndexPath = path.join(transactionPath, "recovery-index");
  const emptyIndexPath = path.join(transactionPath, "empty-index");
  try {
    indexLock = await holdGitIndexLock(root, operationId);
    await testOptions.afterIndexLock?.();
    recordGitIndexLockOwnership(journal, indexLock);
    await writeJournal(journalPath, journal);
    // `write-tree` may update index extensions, so inspect a copy while the
    // shared index lock prevents a concurrent caller from changing it.
    if (await pathExists(indexLock.indexPath)) {
      await copyFile(indexLock.indexPath, validationIndexPath);
    } else {
      await git(root, ["read-tree", "--empty"], validationIndexPath);
    }
    const currentTree = await git(root, ["write-tree"], validationIndexPath);
    let preHeadTree: string;
    if (preHead) {
      preHeadTree = await git(root, ["rev-parse", `${preHead}^{tree}`]);
    } else {
      await git(root, ["read-tree", "--empty"], emptyIndexPath);
      preHeadTree = await git(root, ["write-tree"], emptyIndexPath);
    }
    const commitTree = await git(root, ["rev-parse", `${commitHash}^{tree}`]);
    if (currentTree === commitTree) return;
    if (currentTree !== preHeadTree) {
      throw new Error(
        "Git staged changes appeared before recovery could publish its private index",
      );
    }
    if ((await git(root, ["write-tree"], isolatedIndexPath)) !== commitTree) {
      throw new Error(
        "The private Git index does not match the committed transaction tree",
      );
    }
    await publishHeldGitIndex(isolatedIndexPath, indexLock);
    indexLock = undefined;
  } finally {
    await releaseGitIndexLock(indexLock);
    await rm(validationIndexPath, { force: true });
    await rm(emptyIndexPath, { force: true });
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
  managedRootPaths: readonly string[] = [],
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
  for (const relativePath of safeManagedRootPaths(managedRootPaths)) {
    await cp(
      path.join(root, relativePath),
      path.join(backupPath, relativePath),
    );
  }
}

async function restoreBrainSnapshot(
  root: string,
  backupPath: string,
  managedRootPaths: readonly string[] = [],
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
  for (const relativePath of safeManagedRootPaths(managedRootPaths)) {
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

async function removeOwnedGitIndexLock(
  root: string,
  operationId: string,
  declaredLockPath?: string,
  ownership?: NonNullable<TransactionJournal["gitIndexLock"]>,
): Promise<void> {
  const expectedLockPath = `${await gitIndexPath(root)}.lock`;
  if (
    declaredLockPath &&
    path.resolve(declaredLockPath) !== path.resolve(expectedLockPath)
  ) {
    throw new Error("Unsafe Git index lock path in recovery journal");
  }
  if (
    ownership &&
    path.resolve(ownership.path) !== path.resolve(expectedLockPath)
  ) {
    throw new Error("Unsafe Git index lock ownership path in recovery journal");
  }
  if (!(await pathExists(expectedLockPath))) return;
  if (ownership) {
    const lockStat = await stat(expectedLockPath);
    if (
      String(lockStat.dev) !== ownership.device ||
      String(lockStat.ino) !== ownership.inode
    ) {
      throw new Error(
        "Git index lock identity changed after the interrupted transaction; manual Git recovery is required",
      );
    }
    await rm(expectedLockPath);
    return;
  }
  let marker: z.infer<typeof gitIndexLockSchema>;
  try {
    marker = gitIndexLockSchema.parse(
      JSON.parse(await readFile(expectedLockPath, "utf8")),
    );
  } catch {
    throw new Error(
      "Git index lock is present but cannot be safely attributed to this interrupted transaction; manual Git recovery is required",
    );
  }
  if (marker.operationId !== operationId) {
    throw new Error(
      "Git index lock belongs to another operation; manual Git recovery is required",
    );
  }
  await rm(expectedLockPath);
}

function safeStagePaths(root: string, stagePaths: string[]): string[] {
  return [...new Set(stagePaths)].map((relativePath) => {
    const normalized = relativePath.replaceAll("\\", "/");
    const absolutePath = path.resolve(root, normalized);
    if (
      path.isAbsolute(relativePath) ||
      normalized.startsWith(":") ||
      normalized !== relativePath ||
      normalized === "wiki" ||
      normalized === ".brain" ||
      normalized === "sources" ||
      !absolutePath.startsWith(`${path.resolve(root)}${path.sep}`)
    ) {
      throw new Error(`Unsafe managed stage path: ${relativePath}`);
    }
    return normalized;
  });
}

async function privateIndexTree(
  root: string,
  isolatedIndexPath: string,
): Promise<string> {
  return git(root, ["write-tree"], isolatedIndexPath);
}

async function assertPrivateIndexTree(
  root: string,
  isolatedIndexPath: string,
  expectedTree: string,
): Promise<void> {
  const actualTree = await privateIndexTree(root, isolatedIndexPath);
  if (actualTree !== expectedTree) {
    throw new Error(
      "Private Git index changed after graph validation; refusing to commit an unvalidated tree",
    );
  }
}

async function assertPrivateIndexMatchesWorktree(
  root: string,
  isolatedIndexPath: string,
  stagePaths: string[],
): Promise<void> {
  if (stagePaths.length === 0) return;
  try {
    await execFile(
      "git",
      ["diff", "--quiet", "--exit-code", "--", ...stagePaths],
      {
        cwd: root,
        env: gitEnvironment(isolatedIndexPath),
      },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 1) {
      throw new Error(
        "Managed worktree files changed after graph validation; retry the canonical write",
      );
    }
    throw error;
  }
}

interface ManagedFileFingerprint {
  relativePath: string;
  exists: boolean;
  bytes?: number;
  sha256?: string;
  mode?: "100644" | "100755";
}

async function digestFile(filePath: string): Promise<{
  bytes: number;
  sha256: string;
}> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function digestIndexedFile(
  root: string,
  indexPath: string,
  relativePath: string,
): Promise<{ bytes: number; sha256: string }> {
  const child = spawn("git", ["show", `:${relativePath}`], {
    cwd: root,
    env: gitEnvironment(indexPath),
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  const digest = (async () => {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of child.stdout) {
      bytes += chunk.byteLength;
      hash.update(chunk);
    }
    return { bytes, sha256: hash.digest("hex") };
  })();
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const result = await digest;
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Git could not read ${relativePath}`);
  }
  return result;
}

function gitRegularFileMode(mode: number): "100644" | "100755" {
  return mode & 0o111 ? "100755" : "100644";
}

function canonicalManagedPath(
  root: string,
  relativePath: string,
  managedRootPaths: ReadonlySet<string>,
): string {
  const [safePath] = safeStagePaths(root, [relativePath]);
  if (
    !safePath ||
    (!safePath.startsWith("wiki/") &&
      !safePath?.startsWith("sources/") &&
      !trackedBrainFiles.includes(
        safePath as (typeof trackedBrainFiles)[number],
      ) &&
      !managedRootPaths.has(safePath))
  ) {
    throw new Error(`Unsafe canonical file path: ${relativePath}`);
  }
  return path.join(root, safePath);
}

export interface CanonicalMutationWriter {
  writeText(relativePath: string, content: string): Promise<void>;
  writeBytes(relativePath: string, content: Uint8Array): Promise<void>;
  remove(relativePath: string): Promise<void>;
  /** Seals an immutable user-provided file against its independently known digest. */
  sealExisting(
    relativePath: string,
    expected: { bytes: number; sha256: string },
  ): Promise<void>;
}

class TransactionCanonicalWriter implements CanonicalMutationWriter {
  private readonly expected = new Map<string, ManagedFileFingerprint>();

  private constructor(
    private readonly root: string,
    private readonly realRoot: string,
    private readonly managedRootPaths: ReadonlySet<string>,
  ) {}

  static async create(
    root: string,
    managedRootPaths: readonly string[],
  ): Promise<TransactionCanonicalWriter> {
    return new TransactionCanonicalWriter(
      root,
      await realpath(root),
      new Set(managedRootPaths),
    );
  }

  private async canonicalParent(absolutePath: string): Promise<string> {
    const directory = path.dirname(absolutePath);
    await mkdir(directory, { recursive: true });
    const realDirectory = await realpath(directory);
    if (
      realDirectory !== this.realRoot &&
      !realDirectory.startsWith(`${this.realRoot}${path.sep}`)
    ) {
      throw new Error(`Unsafe canonical file parent: ${absolutePath}`);
    }
    return directory;
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    await this.writeBytes(relativePath, Buffer.from(content, "utf8"));
  }

  async writeBytes(relativePath: string, content: Uint8Array): Promise<void> {
    const absolutePath = canonicalManagedPath(
      this.root,
      relativePath,
      this.managedRootPaths,
    );
    const directory = await this.canonicalParent(absolutePath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(absolutePath)}.brain-write-${randomUUID()}`,
    );
    const bytes = Buffer.from(content);
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o644 });
      await chmod(temporaryPath, 0o644);
      await rename(temporaryPath, absolutePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    this.expected.set(relativePath, {
      relativePath,
      exists: true,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode: "100644",
    });
  }

  async remove(relativePath: string): Promise<void> {
    const absolutePath = canonicalManagedPath(
      this.root,
      relativePath,
      this.managedRootPaths,
    );
    try {
      await this.canonicalParent(absolutePath);
      await rm(absolutePath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.expected.set(relativePath, { relativePath, exists: false });
  }

  async sealExisting(
    relativePath: string,
    expected: { bytes: number; sha256: string },
  ): Promise<void> {
    const absolutePath = canonicalManagedPath(
      this.root,
      relativePath,
      this.managedRootPaths,
    );
    await this.canonicalParent(absolutePath);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile()) {
      throw new Error(
        `Managed canonical file must be regular before staging: ${relativePath}`,
      );
    }
    this.expected.set(relativePath, {
      relativePath,
      exists: true,
      ...expected,
      mode: gitRegularFileMode(metadata.mode),
    });
  }

  assertStagePaths(stagePaths: string[]): void {
    const expectedPaths = [...this.expected.keys()].sort();
    const expectedSet = new Set(expectedPaths);
    const stagedSet = new Set(stagePaths);
    const missing = stagePaths.filter(
      (relativePath) => !expectedSet.has(relativePath),
    );
    const unstaged = expectedPaths.filter(
      (relativePath) => !stagedSet.has(relativePath),
    );
    if (missing.length > 0 || unstaged.length > 0) {
      throw new Error(
        `Canonical mutation must provide authoritative expected files (missing: ${missing.join(", ") || "none"}; unstaged: ${unstaged.join(", ") || "none"})`,
      );
    }
  }

  async assertWorktree(): Promise<void> {
    for (const expected of this.expected.values()) {
      const absolutePath = canonicalManagedPath(
        this.root,
        expected.relativePath,
        this.managedRootPaths,
      );
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (!expected.exists) continue;
          throw new Error(
            `Managed canonical file changed after graph validation; refusing to commit an unvalidated tree: ${expected.relativePath}`,
          );
        }
        throw error;
      }
      if (!expected.exists) {
        throw new Error(
          `Managed canonical file changed after graph validation; refusing to commit an unvalidated tree: ${expected.relativePath}`,
        );
      }
      if (!metadata.isFile()) {
        throw new Error(
          `Managed canonical file is not a regular file after graph validation: ${expected.relativePath}`,
        );
      }
      const digest = await digestFile(absolutePath);
      if (
        digest.bytes !== expected.bytes ||
        digest.sha256 !== expected.sha256 ||
        gitRegularFileMode(metadata.mode) !== expected.mode
      ) {
        throw new Error(
          `Managed canonical file changed after graph validation; refusing to commit an unvalidated tree: ${expected.relativePath}`,
        );
      }
    }
  }

  async assertPrivateIndex(indexPath: string): Promise<void> {
    for (const expected of this.expected.values()) {
      const entry = await this.indexEntry(indexPath, expected.relativePath);
      if (!expected.exists) {
        if (entry) {
          throw new Error(
            `Private Git index changed after graph validation; refusing to commit an unvalidated tree: ${expected.relativePath}`,
          );
        }
        continue;
      }
      if (!entry || entry.mode !== expected.mode) {
        throw new Error(
          `Private Git index has an unexpected object mode after graph validation: ${expected.relativePath}`,
        );
      }
      const digest = await digestIndexedFile(
        this.root,
        indexPath,
        expected.relativePath,
      );
      if (
        digest.bytes !== expected.bytes ||
        digest.sha256 !== expected.sha256
      ) {
        throw new Error(
          `Private Git index changed after graph validation; refusing to commit an unvalidated tree: ${expected.relativePath}`,
        );
      }
    }
  }

  private async indexEntry(
    indexPath: string,
    relativePath: string,
  ): Promise<{ mode: string } | undefined> {
    const { stdout } = await execFile(
      "git",
      ["ls-files", "--stage", "-z", "--", relativePath],
      { cwd: this.root, env: gitEnvironment(indexPath), encoding: "buffer" },
    );
    const record = stdout.toString("utf8").split("\0")[0];
    if (!record) return undefined;
    const match = /^(\d+) [a-f0-9]+ 0\t/.exec(record);
    if (!match) {
      throw new Error(`Unexpected private Git index entry: ${relativePath}`);
    }
    return { mode: match[1] ?? "" };
  }
}

interface CanonicalWorktreeChange {
  status: string;
  path: string;
}

async function changedCanonicalWorktreeEntries(
  root: string,
  managedRootPaths: readonly string[] = [],
): Promise<CanonicalWorktreeChange[]> {
  const { stdout } = await execFile(
    "git",
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      "wiki",
      ...trackedBrainFiles,
      ...managedRootPaths,
    ],
    { cwd: root, encoding: "buffer" },
  );
  const records = stdout.toString("utf8").split("\0");
  const changes = new Map<string, CanonicalWorktreeChange>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const relativePath = record.slice(3);
    if (relativePath) changes.set(relativePath, { status, path: relativePath });
    if (status.includes("R") || status.includes("C")) {
      const originalPath = records[index + 1];
      if (originalPath)
        changes.set(originalPath, { status, path: originalPath });
      index += 1;
    }
  }
  return [...changes.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

async function changedCanonicalWorktreePaths(
  root: string,
  managedRootPaths: readonly string[] = [],
): Promise<string[]> {
  return (await changedCanonicalWorktreeEntries(root, managedRootPaths)).map(
    (change) => change.path,
  );
}

async function assertNoUnexpectedCanonicalWorktreeChanges(
  root: string,
  stagePaths: string[],
  managedRootPaths: readonly string[] = [],
): Promise<void> {
  const allowedPaths = new Set(stagePaths);
  const unexpected = (
    await changedCanonicalWorktreePaths(root, managedRootPaths)
  ).filter((relativePath) => !allowedPaths.has(relativePath));
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected managed worktree path after graph validation: ${unexpected.join(", ")}`,
    );
  }
}

function zeroDelimitedPaths(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

async function indexedPaths(
  root: string,
  stagePaths: string[],
): Promise<string[]> {
  if (stagePaths.length === 0) return [];
  const { stdout } = await execFile(
    "git",
    ["ls-files", "-z", "--", ...stagePaths],
    { cwd: root },
  );
  return zeroDelimitedPaths(stdout).sort();
}

async function restoreStagedIndex(
  root: string,
  stagePaths: string[],
  preexistingIndexPaths: string[],
): Promise<void> {
  if (stagePaths.length === 0) return;
  const before = new Set(preexistingIndexPaths);
  const current = await indexedPaths(root, stagePaths);
  const newlyIndexed = current.filter(
    (relativePath) => !before.has(relativePath),
  );
  if (newlyIndexed.length > 0) {
    await git(root, [
      "rm",
      "--cached",
      "--ignore-unmatch",
      "--",
      ...newlyIndexed,
    ]);
  }
  if (preexistingIndexPaths.length > 0) {
    await git(root, ["restore", "--staged", "--", ...preexistingIndexPaths]);
  }
}

export interface CanonicalWriteResult<T> {
  value: T;
  commit?: string;
  sync?: SyncStatusV1;
}

export interface CanonicalMutationResult<T> {
  value: T;
  stagePaths: string[];
  /** Verifies immutable inputs after staging, or before completion outside Git. */
  verifyBeforeCommit?: (context: {
    gitRepository: boolean;
    /** The transaction's private index when Git is enabled. */
    indexPath?: string;
  }) => Promise<void>;
  /** Re-checks mutation-specific expected canonical data after private staging. */
  verifySealedState?: () => Promise<void>;
}

export interface CanonicalWriteOptions<T> {
  operationId: string;
  commitMessage: string | ((value: T) => string);
  testOptions?: TransactionTestOptions;
  /** Exact root files this operation may snapshot, write, stage, and restore. */
  managedRootPaths?: string[];
  /** Exact missing scaffold files that this operation may adopt as untracked. */
  allowUntrackedPaths?: string[];
}

export async function runCanonicalWrite<T>(
  root: string,
  options: CanonicalWriteOptions<T>,
  mutate: (
    writer: CanonicalMutationWriter,
  ) => Promise<CanonicalMutationResult<T>>,
): Promise<CanonicalWriteResult<T>> {
  if (!/^op_[a-z0-9_-]{3,96}$/.test(options.operationId)) {
    throw new Error(`Invalid operationId: ${options.operationId}`);
  }
  const managedRootPaths = safeManagedRootPaths(options.managedRootPaths);
  const managedRootPathSet = new Set(managedRootPaths);
  const allowUntrackedPaths = new Set(
    safeStagePaths(root, options.allowUntrackedPaths ?? []),
  );
  for (const relativePath of allowUntrackedPaths) {
    canonicalManagedPath(root, relativePath, managedRootPathSet);
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
    const dirtyManaged = (
      await changedCanonicalWorktreeEntries(root, managedRootPaths)
    ).filter(
      (change) =>
        change.status !== "??" || !allowUntrackedPaths.has(change.path),
    );
    if (dirtyManaged.length > 0) {
      throw new Error(
        `Refusing canonical write with dirty managed files:\n${dirtyManaged
          .map((change) => `${change.status} ${change.path}`)
          .join("\n")}`,
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
  let headUpdated = false;
  let stagePaths: string[] = [];
  let snapshotPrepared = false;
  let journal: TransactionJournal | undefined;
  try {
    const preHead = gitRepository ? await currentGitHead(root) : "";
    await mkdir(transactionRoot, { recursive: true });
    const realRuntime = await realpath(runtimePath);
    const realTransactionRoot = await realpath(transactionRoot);
    if (!realTransactionRoot.startsWith(`${realRuntime}${path.sep}`)) {
      throw new Error("Unsafe canonical transaction root");
    }
    await mkdir(transactionPath);
    await copyBrainSnapshot(root, backupPath, managedRootPaths);
    snapshotPrepared = true;
    journal = {
      version: 1,
      operationId: options.operationId,
      phase: "prepared",
      preHead,
      backupPath,
      gitRepository,
      stagePaths,
      managedRootPaths,
    };
    await writeJournal(journalPath, journal);
    simulateCrash(options.testOptions ?? {}, "prepared");

    const writer = await TransactionCanonicalWriter.create(
      root,
      managedRootPaths,
    );
    const mutation = await mutate(writer);
    stagePaths = safeStagePaths(root, mutation.stagePaths);
    writer.assertStagePaths(stagePaths);
    await options.testOptions?.afterMutationBeforeSeal?.();
    await writer.assertWorktree();
    await options.testOptions?.afterMutation?.();
    await writer.assertWorktree();
    journal.stagePaths = stagePaths;
    // New transactions never write the caller's Git index. Older journals use
    // preexistingIndexPaths during recovery and remain backward-compatible.
    journal.isolatedIndex = gitRepository;
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
      if ((await currentGitHead(root)) !== preHead) {
        throw new Error("Git HEAD changed during the canonical write");
      }
      if (await hasStagedChanges(root)) {
        throw new Error(
          "Git staged changes appeared during the canonical write; refusing to commit",
        );
      }
      await assertNoUnexpectedCanonicalWorktreeChanges(
        root,
        stagePaths,
        managedRootPaths,
      );
      await writer.assertWorktree();
      let indexLock: HeldGitIndexLock | undefined;
      try {
        // Build the complete transaction tree before yielding to anything
        // external. This private index is the exact, graph-validated snapshot
        // we will later commit; the shared index is never used as staging.
        const isolatedIndexPath = path.join(transactionPath, "git-index");
        await git(
          root,
          preHead ? ["read-tree", preHead] : ["read-tree", "--empty"],
          isolatedIndexPath,
        );
        await git(root, ["add", "-A", "--", ...stagePaths], isolatedIndexPath);
        await mutation.verifyBeforeCommit?.({
          gitRepository: true,
          indexPath: isolatedIndexPath,
        });
        await assertPrivateIndexMatchesWorktree(
          root,
          isolatedIndexPath,
          stagePaths,
        );
        await assertNoUnexpectedCanonicalWorktreeChanges(
          root,
          stagePaths,
          managedRootPaths,
        );
        await writer.assertWorktree();
        await writer.assertPrivateIndex(isolatedIndexPath);
        await mutation.verifySealedState?.();
        await assertPrivateIndexMatchesWorktree(
          root,
          isolatedIndexPath,
          stagePaths,
        );
        await assertNoUnexpectedCanonicalWorktreeChanges(
          root,
          stagePaths,
          managedRootPaths,
        );
        await writer.assertWorktree();
        await writer.assertPrivateIndex(isolatedIndexPath);
        const validatedTree = await privateIndexTree(root, isolatedIndexPath);

        // This deterministic seam represents work that can occur after the
        // canonical graph has been validated. It must not change the sealed
        // private tree or introduce staged user work in the shared index.
        await options.testOptions?.beforeStage?.();
        if (await hasStagedChanges(root)) {
          throw new Error(
            "Git staged changes appeared during the canonical write; refusing to commit",
          );
        }
        await assertNoUnexpectedCanonicalWorktreeChanges(
          root,
          stagePaths,
          managedRootPaths,
        );
        await mutation.verifyBeforeCommit?.({
          gitRepository: true,
          indexPath: isolatedIndexPath,
        });
        await writer.assertWorktree();
        await assertPrivateIndexMatchesWorktree(
          root,
          isolatedIndexPath,
          stagePaths,
        );
        await mutation.verifySealedState?.();
        await assertNoUnexpectedCanonicalWorktreeChanges(
          root,
          stagePaths,
          managedRootPaths,
        );
        await writer.assertWorktree();
        await writer.assertPrivateIndex(isolatedIndexPath);
        await assertPrivateIndexTree(root, isolatedIndexPath, validatedTree);
        if ((await currentGitHead(root)) !== preHead) {
          throw new Error("Git HEAD changed during the canonical write");
        }

        // Hold the ordinary index lock before checking it again. This closes
        // the gap where a user starts staging after the check but before we
        // publish the sealed private index.
        journal.gitIndexLockPath = `${await gitIndexPath(root)}.lock`;
        await writeJournal(journalPath, journal);
        indexLock = await holdGitIndexLock(root, options.operationId);
        recordGitIndexLockOwnership(journal, indexLock);
        await writeJournal(journalPath, journal);
        await options.testOptions?.afterIndexLock?.();
        if (await hasStagedChanges(root)) {
          throw new Error(
            "Git staged changes appeared during the canonical write; refusing to commit",
          );
        }
        if ((await currentGitHead(root)) !== preHead) {
          throw new Error("Git HEAD changed during the canonical write");
        }
        await runPreCommitHook(root, isolatedIndexPath);
        await mutation.verifyBeforeCommit?.({
          gitRepository: true,
          indexPath: isolatedIndexPath,
        });
        await assertPrivateIndexMatchesWorktree(
          root,
          isolatedIndexPath,
          stagePaths,
        );
        await mutation.verifySealedState?.();
        await assertNoUnexpectedCanonicalWorktreeChanges(
          root,
          stagePaths,
          managedRootPaths,
        );
        await writer.assertWorktree();
        await writer.assertPrivateIndex(isolatedIndexPath);
        await assertPrivateIndexTree(root, isolatedIndexPath, validatedTree);
        const commitMessage =
          typeof options.commitMessage === "function"
            ? options.commitMessage(mutation.value)
            : options.commitMessage;
        const messagePath = path.join(transactionPath, "commit-message.txt");
        await writeFile(
          messagePath,
          `${commitMessage}\n\nBrain-Managed: true\nBrain-Operation: ${options.operationId}\n`,
          "utf8",
        );
        commit = await git(
          root,
          [
            "commit-tree",
            validatedTree,
            ...(preHead ? ["-p", preHead] : []),
            "-F",
            messagePath,
          ],
          isolatedIndexPath,
        );
        // Persist the hash before moving the branch so an interrupted CAS can
        // always identify and finish (or reject) its private-index recovery.
        journal.commitHash = commit;
        await writeJournal(journalPath, journal);
        const headRef = await git(root, ["symbolic-ref", "--quiet", "HEAD"]);
        await git(root, [
          "update-ref",
          headRef,
          commit,
          preHead || "0000000000000000000000000000000000000000",
        ]);
        headUpdated = true;

        // The shared index was clean when its lock was acquired, so replacing
        // it with the private transaction index is safe and leaves the worktree
        // clean against the newly published commit. A concurrent `git add`
        // either completed before the final check (and was refused) or cannot
        // write while this lock exists.
        if (options.testOptions?.simulateIndexPublishFailure) {
          throw new Error("Simulated private Git index publication failure");
        }
        await publishHeldGitIndex(
          isolatedIndexPath,
          indexLock,
          options.testOptions?.afterIndexCopy,
        );
        indexLock = undefined;
        journal.indexPublished = true;
        await writeJournal(journalPath, journal);
        committed = true;
      } finally {
        await releaseGitIndexLock(indexLock);
      }
    } else {
      await options.testOptions?.beforeStage?.();
      await mutation.verifyBeforeCommit?.({ gitRepository: false });
      await mutation.verifySealedState?.();
      await writer.assertWorktree();
      committed = true;
    }
    journal.canonicalCommitComplete = true;
    journal.phase = "committed";
    await writeJournal(journalPath, journal);
    simulateCrash(options.testOptions ?? {}, "committed");

    await rm(journalPath, { force: true });
    simulateCrash(options.testOptions ?? {}, "journal-removed");
    await rm(lockPath, { force: true });
    await rm(transactionPath, { recursive: true, force: true });
    let sync: SyncStatusV1 | undefined;
    if (commit) {
      try {
        const { attemptManagedSync } = await import("./sync.js");
        sync = await attemptManagedSync(root);
      } catch {
        // Synchronization happens only after the canonical commit is durable.
        // A sync failure must never roll back or hide that local commit.
      }
    }
    return {
      value: mutation.value,
      ...(commit ? { commit } : {}),
      ...(sync ? { sync } : {}),
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
    if (headUpdated && snapshotPrepared) {
      await writeFile(
        lockPath,
        `${JSON.stringify({
          pid: process.pid,
          operationId: options.operationId,
          recoverable: true,
        })}\n`,
        "utf8",
      ).catch(() => undefined);
      throw new Error(
        `Canonical commit completed but recovery is required for ${options.operationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!committed && snapshotPrepared) {
      try {
        if (options.testOptions?.simulateRollbackFailure) {
          throw new Error("Simulated rollback failure");
        }
        await restoreBrainSnapshot(root, backupPath, managedRootPaths);
        if (gitRepository && stagePaths.length > 0 && !journal?.isolatedIndex) {
          await restoreStagedIndex(
            root,
            stagePaths,
            journal?.preexistingIndexPaths ?? [],
          );
        }
      } catch (rollbackError) {
        await writeFile(
          lockPath,
          `${JSON.stringify({
            pid: process.pid,
            operationId: options.operationId,
            recoverable: true,
          })}\n`,
          "utf8",
        ).catch(() => undefined);
        throw rollbackRecoveryError(options.operationId, rollbackError);
      }
    }
    await rm(journalPath, { force: true }).catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    await rm(transactionPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

async function appendOperation(
  root: string,
  changeSet: ChangeSetV1,
  now: string,
  writer: CanonicalMutationWriter,
  binding?: MutationBinding,
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
    tiersUsed: binding?.kind === "query" ? [binding.tier] : [],
    ...(binding?.kind === "query" ? { queryId: binding.queryId } : {}),
    ...(binding?.kind === "setup" ? { setupId: binding.setupId } : {}),
  };
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const existing = await readFile(operationsPath, "utf8");
  await writer.writeText(
    ".brain/operations.jsonl",
    `${existing}${JSON.stringify(record)}\n`,
  );
  const logPath = path.join(root, "wiki", "log.md");
  const log = await readFile(logPath, "utf8");
  await writer.writeText(
    "wiki/log.md",
    `${log.trimEnd()}\n\n## [${now}] apply | ${changeSet.reason}\n\n- Operation: \`${changeSet.operationId}\`\n- Pages: ${record.pageIds.map((id) => `\`${id}\``).join(", ") || "none"}\n`,
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
  return { kind: "query", queryId: session.id, tier: session.currentTier };
}

async function readSetupMutationBinding(
  root: string,
  setupId: string,
): Promise<SetupMutationBinding> {
  if (!/^setup_[a-f0-9]{32}$/.test(setupId)) {
    throw new Error(`Invalid setup ID: ${setupId}`);
  }
  const setup = (await readBrainState(root)).setup;
  if (setup.status !== "in-progress" || setup.id !== setupId) {
    throw new Error(`Setup is not in progress: ${setupId}`);
  }
  return { kind: "setup", setupId };
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
    async (writer) => {
      if (options.context && options.queryId) {
        throw new Error("Use either context or queryId, not both");
      }
      const context: KnowledgeMutationContext | undefined =
        options.context ??
        (options.queryId ? { kind: "query", id: options.queryId } : undefined);
      const binding = context
        ? context.kind === "query"
          ? await readQueryMutationBinding(root, context.id)
          : await readSetupMutationBinding(root, context.id)
        : undefined;
      const currentPages = await loadWikiPages(root);
      const expectedPlan = await planReconciliation(
        root,
        changeSet,
        options.runtimeServices,
      );
      if (
        expectedPlan.candidates.length > 0 &&
        !changeSet.reconciliation.plan
      ) {
        throw new Error(
          `Reconciliation plan is required for discovered candidates: ${expectedPlan.candidates
            .map((candidate) => candidate.pageId)
            .join(", ")}`,
        );
      }
      const proposedPages = applyWikiChangeSet(currentPages, changeSet);
      if (changeSet.reconciliation.plan) {
        assertReconciliationPlanMatches(
          changeSet.reconciliation.plan,
          expectedPlan,
        );
        assertReconciliationReceipt(
          currentPages,
          proposedPages,
          changeSet.reconciliation,
        );
      }
      const config = await loadBrainConfig(root);
      const proposedPaths = new Set(proposedPages.map((page) => page.path));
      for (const page of proposedPages) safePagePath(root, page.path);
      for (const currentPage of currentPages) {
        if (!proposedPaths.has(currentPage.path)) {
          await writer.remove(currentPage.path);
        }
      }
      for (const page of proposedPages) {
        await writer.writeText(page.path, renderWikiPage(page));
      }
      await writeGeneratedWikiFiles(root, (relativePath, content) =>
        writer.writeText(relativePath, content),
      );
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
        semanticAuditDue?: boolean;
        semanticAudit?: {
          status?: "pending" | "completed";
          targetMutation?: number;
          pendingPageIds?: string[];
          reviewedPageIds?: string[];
          startedAt?: string;
          completedAt?: string;
        };
      };
      const knowledgeMutations =
        (state.knowledgeMutations ?? 0) + (changeSet.pages.length ? 1 : 0);
      const now = new Date().toISOString();
      const semanticAudit =
        changeSet.pages.length > 0 && state.semanticAudit?.status === "pending"
          ? {
              status: "pending" as const,
              targetMutation: knowledgeMutations,
              pendingPageIds: proposedPages
                .filter((page) => page.status === "active")
                .map((page) => page.id)
                .sort(),
              reviewedPageIds: [],
              startedAt: now,
            }
          : state.semanticAudit;
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
      await writer.writeText(
        ".brain/state.json",
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
              semanticAudit?.status === "pending" ||
              Boolean(state.semanticAuditDue) ||
              knowledgeMutations - (state.lastSemanticAuditMutation ?? 0) >=
                config.graph.semanticAuditEvery,
            ...(semanticAudit ? { semanticAudit } : {}),
          },
          null,
          2,
        )}\n`,
      );
      await appendOperation(root, changeSet, now, writer, binding);
      const generatedPaths = [
        "wiki/index.md",
        "wiki/map.md",
        "wiki/log.md",
        "wiki/reports/health.md",
      ];
      return {
        value: {
          operationId: changeSet.operationId,
          pages: proposedPages,
          audit,
        },
        stagePaths: [
          ...new Set([
            ...currentPages.map((page) => page.path),
            ...proposedPages.map((page) => page.path),
            ...generatedPaths,
            ".brain/state.json",
            ".brain/operations.jsonl",
          ]),
        ],
        verifySealedState: async () => {
          const sealedPages = await loadWikiPages(root);
          if (JSON.stringify(sealedPages) !== JSON.stringify(proposedPages)) {
            throw new Error(
              "Canonical wiki pages changed after graph validation; refusing an unvalidated mutation",
            );
          }
        },
      };
    },
  );
  return {
    ...result.value,
    ...(result.commit ? { commit: result.commit } : {}),
    ...(result.sync ? { sync: result.sync } : {}),
  };
}

export async function recoverBrain(
  root: string,
  testOptions: RecoveryTestOptions = {},
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
        if (await isGitRepository(root)) {
          await removeOwnedGitIndexLock(root, writerLock.operationId);
        }
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
  const managedRootPaths = safeManagedRootPaths(journal.managedRootPaths);
  const gitRepository = journal.gitRepository ?? true;
  if (gitRepository && (journal.gitIndexLockPath || journal.gitIndexLock)) {
    await removeOwnedGitIndexLock(
      root,
      journal.operationId,
      journal.gitIndexLockPath,
      journal.gitIndexLock,
    );
    // The recovered transaction may acquire a fresh lock. Persisting this
    // reset makes a crash between acquisition and the new identity record
    // recoverable through the JSON marker rather than a stale inode.
    delete journal.gitIndexLock;
    await writeJournal(journalPath, journal);
  }
  const head = gitRepository ? await currentGitHead(root) : "";
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
      ...(journal.preHead ? [`${journal.preHead}..${head}`] : [head]),
    ]).catch(() => "");
    transactionCommitExists = matchingCommits.length > 0;
  }
  const outcome = transactionCommitExists ? "committed" : "restored";
  if (
    outcome === "committed" &&
    gitRepository &&
    journal.isolatedIndex &&
    !journal.indexPublished &&
    journal.commitHash
  ) {
    if (head !== journal.commitHash) {
      throw new Error(
        "Git HEAD advanced before recovery could publish its private index; manual Git recovery is required",
      );
    }
    await publishRecoveredIsolatedIndex(
      root,
      path.dirname(journal.backupPath),
      journal.preHead,
      journal.commitHash,
      journal.operationId,
      journalPath,
      journal,
      testOptions,
    );
    journal.indexPublished = true;
    await writeJournal(journalPath, journal);
  }
  if (outcome === "restored") {
    await restoreBrainSnapshot(root, journal.backupPath, managedRootPaths);
    if (
      gitRepository &&
      (journal.stagePaths?.length ?? 0) > 0 &&
      !journal.isolatedIndex
    ) {
      await restoreStagedIndex(
        root,
        journal.stagePaths ?? [],
        journal.preexistingIndexPaths ?? [],
      );
    }
  }
  await rm(journalPath, { force: true });
  await rm(path.join(runtimePath, "mutation.lock"), { force: true });
  await rm(lockPath, { force: true });
  await rm(path.dirname(journal.backupPath), { recursive: true, force: true });
  return outcome;
}
