import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { access, lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ZodError, z } from "zod";
import { type BrainConfigV1, loadBrainConfig } from "./config.js";
import {
  inspectBrainCharter,
  inspectOnboarding,
  inspectSetupCompletionIntegrity,
  inspectSourceDuplicateAcknowledgements,
} from "./onboarding.js";
import {
  effectiveSourceRoots,
  inspectRepositoryEntry,
} from "./sources/path-safety.js";
import { type SourceRecordV1, sourceRecordV1Schema } from "./sources/types.js";
import { brainStateV1Schema } from "./state.js";
import { syncStatus } from "./sync.js";
import { operationRecordV1Schema } from "./transaction.js";
import { validateWikiGraph } from "./wiki/graph.js";

const execFile = promisify(execFileCallback);

export interface DoctorIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface DoctorReport {
  ok: boolean;
  issues: DoctorIssue[];
}

export interface DoctorTestOptions {
  /** Reports bounded registered-source read progress; tests only. */
  afterSourceReadProgress?: (
    sourcePath: string,
    bytesRead: number,
  ) => Promise<void> | void;
  /** Pauses after a registered source is opened and initially sealed; tests only. */
  afterSourceOpened?: (sourcePath: string) => Promise<void> | void;
}

const requiredPaths = [
  "BRAIN.md",
  "sources",
  "wiki",
  "wiki/home.md",
  "wiki/index.md",
  "wiki/map.md",
  "wiki/log.md",
  "wiki/pages",
  "wiki/reports/health.md",
  ".brain/source-manifest.json",
  ".brain/state.json",
  ".brain/operations.jsonl",
] as const;

const sourceManifestV1Schema = z.object({
  version: z.literal(1),
  sources: z.array(sourceRecordV1Schema),
});

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function sourceIssue(
  source: SourceRecordV1,
  code: string,
  message: string,
): DoctorIssue {
  return {
    code,
    severity: "error",
    message,
    path: source.path,
  };
}

function unsafeSourceRootIssue(
  sourceRoot: string,
  error: unknown,
): DoctorIssue {
  return {
    code: "SOURCE_ROOT_UNSAFE",
    severity: "error",
    message: `Configured source root is unsafe: ${errorMessage(error)}`,
    path: sourceRoot,
  };
}

async function inspectConfiguredSourceRoots(
  root: string,
  sourceRoots: readonly string[],
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  for (const sourceRoot of effectiveSourceRoots(sourceRoots)) {
    try {
      await inspectRepositoryEntry(
        root,
        sourceRoot,
        "directory",
        `Source root ${sourceRoot}`,
        true,
      );
    } catch (error) {
      issues.push(unsafeSourceRootIssue(sourceRoot, error));
    }
  }
  return issues;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isContained(parent: string, candidate: string): boolean {
  return candidate.startsWith(`${parent}${path.sep}`);
}

async function inspectRegisteredSource(
  root: string,
  source: SourceRecordV1,
  maxFileBytes: number,
  testOptions: DoctorTestOptions,
): Promise<DoctorIssue | undefined> {
  const lexicalRoot = path.resolve(root);
  const absolutePath = path.resolve(root, source.path);
  if (!isContained(lexicalRoot, absolutePath)) {
    return sourceIssue(
      source,
      "SOURCE_PATH_UNSAFE",
      `Registered source path escapes the brain root: ${source.path}`,
    );
  }

  let metadata: BigIntStats;
  try {
    metadata = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    return sourceIssue(
      source,
      "SOURCE_MISSING",
      `Registered source cannot be read: ${source.path} (${errorMessage(error)})`,
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return sourceIssue(
      source,
      "SOURCE_PATH_UNSAFE",
      `Registered source must be a non-symlink file: ${source.path}`,
    );
  }

  let realRoot: string;
  let realFile: string;
  try {
    [realRoot, realFile] = await Promise.all([
      realpath(lexicalRoot),
      realpath(absolutePath),
    ]);
  } catch (error) {
    return sourceIssue(
      source,
      "SOURCE_MISSING",
      `Registered source cannot be resolved: ${source.path} (${errorMessage(error)})`,
    );
  }
  if (!isContained(realRoot, realFile)) {
    return sourceIssue(
      source,
      "SOURCE_PATH_UNSAFE",
      `Registered source resolves outside the brain root: ${source.path}`,
    );
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    await testOptions.afterSourceReadProgress?.(source.path, 0);
    if (!opened.isFile() || !sameFileIdentity(metadata, opened)) {
      return sourceIssue(
        source,
        "SOURCE_CHANGED_DURING_CHECK",
        `Registered source changed while Doctor opened it: ${source.path}`,
      );
    }
    if (source.bytes > maxFileBytes) {
      return sourceIssue(
        source,
        "SOURCE_SIZE_MISMATCH",
        `Registered source exceeds configured maximum of ${maxFileBytes} bytes: ${source.path}`,
      );
    }
    if (opened.size !== BigInt(source.bytes)) {
      return sourceIssue(
        source,
        "SOURCE_SIZE_MISMATCH",
        `Registered source size changed: ${source.path} (expected ${source.bytes}, found ${opened.size})`,
      );
    }

    await testOptions.afterSourceOpened?.(source.path);
    const afterOpen = await handle.stat({ bigint: true });
    const [afterOpenPath, afterOpenRealFile] = await Promise.all([
      lstat(absolutePath, { bigint: true }).catch(() => undefined),
      realpath(absolutePath).catch(() => undefined),
    ]);
    if (
      !unchangedFile(opened, afterOpen) ||
      !afterOpenPath?.isFile() ||
      afterOpenPath.isSymbolicLink() ||
      !sameFileIdentity(opened, afterOpenPath) ||
      !afterOpenRealFile ||
      !isContained(realRoot, afterOpenRealFile)
    ) {
      return sourceIssue(
        source,
        "SOURCE_CHANGED_DURING_CHECK",
        `Registered source changed after Doctor opened it: ${source.path}`,
      );
    }

    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(64 * 1024, source.bytes));
    let bytesRead = 0;
    while (bytesRead < source.bytes) {
      const requested = Math.min(buffer.byteLength, source.bytes - bytesRead);
      const result = await handle.read(buffer, 0, requested, null);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
      await testOptions.afterSourceReadProgress?.(source.path, bytesRead);
    }

    const finalOpened = await handle.stat({ bigint: true });
    const [finalPath, finalRealFile] = await Promise.all([
      lstat(absolutePath, { bigint: true }).catch(() => undefined),
      realpath(absolutePath).catch(() => undefined),
    ]);
    if (
      bytesRead !== source.bytes ||
      !unchangedFile(opened, finalOpened) ||
      !finalPath?.isFile() ||
      finalPath.isSymbolicLink() ||
      !sameFileIdentity(opened, finalPath) ||
      !finalRealFile ||
      !isContained(realRoot, finalRealFile)
    ) {
      return sourceIssue(
        source,
        "SOURCE_CHANGED_DURING_CHECK",
        `Registered source changed while Doctor read it: ${source.path}`,
      );
    }
    if (hash.digest("hex") !== source.sha256) {
      return sourceIssue(
        source,
        "SOURCE_HASH_MISMATCH",
        `Registered source bytes changed: ${source.path}`,
      );
    }
    return undefined;
  } catch (error) {
    const unsafe = (error as NodeJS.ErrnoException).code === "ELOOP";
    return sourceIssue(
      source,
      unsafe ? "SOURCE_PATH_UNSAFE" : "SOURCE_MISSING",
      `Registered source cannot be read: ${source.path} (${errorMessage(error)})`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function doctorBrain(
  root: string,
  testOptions: DoctorTestOptions = {},
): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  let config: BrainConfigV1 | undefined;
  let maxFileBytes = 0;
  try {
    config = await loadBrainConfig(root);
    maxFileBytes = config.sources.maxFileBytes;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    issues.push({
      code: missing ? "CONFIG_MISSING" : "CONFIG_INVALID",
      severity: "error",
      message: missing ? "brain.config.yaml is missing" : errorMessage(error),
      path: "brain.config.yaml",
    });
  }

  for (const relativePath of requiredPaths) {
    try {
      await access(path.join(root, relativePath));
    } catch {
      issues.push({
        code: "LAYOUT_MISSING",
        severity: "error",
        message: `Required brain path is missing: ${relativePath}`,
        path: relativePath,
      });
    }
  }

  let manifest: z.infer<typeof sourceManifestV1Schema> | undefined;
  try {
    manifest = sourceManifestV1Schema.parse(
      JSON.parse(
        await readFile(
          path.join(root, ".brain", "source-manifest.json"),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    issues.push({
      code: "SOURCE_MANIFEST_INVALID",
      severity: "error",
      message: errorMessage(error),
      path: ".brain/source-manifest.json",
    });
  }

  let state: z.infer<typeof brainStateV1Schema> | undefined;
  try {
    state = brainStateV1Schema.parse(
      JSON.parse(
        await readFile(path.join(root, ".brain", "state.json"), "utf8"),
      ),
    );
  } catch (error) {
    issues.push({
      code: "STATE_INVALID",
      severity: "error",
      message: errorMessage(error),
      path: ".brain/state.json",
    });
  }

  try {
    const operationLines = (
      await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8")
    )
      .split("\n")
      .filter(Boolean);
    operationLines.forEach((line, index) => {
      try {
        operationRecordV1Schema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`line ${index + 1}: ${errorMessage(error)}`);
      }
    });
  } catch (error) {
    issues.push({
      code: "OPERATIONS_INVALID",
      severity: "error",
      message: errorMessage(error),
      path: ".brain/operations.jsonl",
    });
  }

  for (const source of manifest?.sources ?? []) {
    const issue = await inspectRegisteredSource(
      root,
      source,
      maxFileBytes,
      testOptions,
    );
    if (issue) issues.push(issue);
  }

  if (manifest && state) {
    const duplicateIntegrity = await inspectSourceDuplicateAcknowledgements(
      root,
      state,
      manifest.sources,
    );
    issues.push(
      ...duplicateIntegrity.invalid.map((duplicate) => ({
        code: "SOURCE_DUPLICATE_MISMATCH",
        severity: "error" as const,
        message: `Duplicate source acknowledgement is invalid: ${duplicate.reason}`,
        path: duplicate.path,
      })),
    );
  }

  try {
    await access(path.join(root, ".brain", "runtime", "transaction.json"));
    issues.push({
      code: "RECOVERY_REQUIRED",
      severity: "error",
      message: "An interrupted canonical write must be recovered",
      path: ".brain/runtime/transaction.json",
    });
  } catch {
    // No recovery journal is the healthy state.
  }

  try {
    await access(path.join(root, ".brain", "runtime", "writer.lock"));
    issues.push({
      code: "WRITER_LOCK_PRESENT",
      severity: "error",
      message:
        "A canonical writer lock is present; wait for the writer or run recovery",
      path: ".brain/runtime/writer.lock",
    });
  } catch {
    // No writer lock is the healthy state.
  }

  try {
    const gitIndex = (
      await execFile("git", ["rev-parse", "--git-path", "index"], {
        cwd: root,
      })
    ).stdout.trim();
    const indexLock = `${path.resolve(root, gitIndex)}.lock`;
    try {
      await access(indexLock);
      const relativeLock = path
        .relative(root, indexLock)
        .replaceAll(path.sep, "/");
      issues.push({
        code: "GIT_INDEX_LOCK_PRESENT",
        severity: "error",
        message:
          "A Git index lock is present; recover an owned transaction or resolve the Git operation before writing canonical knowledge",
        path: relativeLock,
      });
    } catch {
      // No Git index lock is the healthy state.
    }
  } catch {
    // A non-Git brain has no shared Git index to inspect.
  }

  try {
    const sync = await syncStatus(root);
    if (sync.status === "pending" || sync.status === "manual-sync-required") {
      issues.push({
        code:
          sync.status === "pending" ? "SYNC_PENDING" : "SYNC_MANUAL_REQUIRED",
        severity: "warning",
        message: sync.reason ?? "Brain synchronization needs attention.",
        path: ".brain/state.json",
      });
    }
  } catch (error) {
    issues.push({
      code: "SYNC_STATUS_UNAVAILABLE",
      severity: "warning",
      message: errorMessage(error),
      path: ".brain/state.json",
    });
  }

  if (manifest) {
    try {
      const graph = await validateWikiGraph(root);
      issues.push(
        ...graph.issues.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
          ...(issue.path ? { path: issue.path } : {}),
        })),
      );
    } catch (error) {
      issues.push({
        code: "WIKI_INVALID",
        severity: "error",
        message: errorMessage(error),
        path: "wiki/pages",
      });
    }
  }

  try {
    const [onboarding, charter] = await Promise.all([
      inspectOnboarding(root),
      inspectBrainCharter(root),
    ]);
    if (onboarding.identity.template) {
      issues.push({
        code: "IDENTITY_TEMPLATE",
        severity: "warning",
        message:
          "The cloned template still needs its independent brain identity.",
        path: "brain.config.yaml",
      });
    }
    if (onboarding.sourceFiles.discovered === 0) {
      issues.push({
        code: "SOURCES_EMPTY",
        severity: "warning",
        message: "No source files have been added yet.",
        path: "sources",
      });
    }
    if (onboarding.phase === "sources-unregistered") {
      issues.push({
        code: "SOURCES_UNREGISTERED",
        severity: "warning",
        message: "Source files are waiting to be scanned and registered.",
        path: "sources",
      });
    }
    if (
      onboarding.sourceFiles.registered > 0 &&
      onboarding.sourceFiles.ready === 0
    ) {
      issues.push({
        code: "SOURCES_NOT_READY",
        severity: "warning",
        message:
          "Registered sources are unsupported, need extraction, or failed extraction.",
        path: ".brain/source-manifest.json",
      });
    }
    if (!onboarding.charter.configured) {
      issues.push({
        code: "CHARTER_PENDING",
        severity: "warning",
        message: "The source-informed brain charter has not been configured.",
        path: "BRAIN.md",
      });
    }
    if (charter.invalidReason) {
      issues.push({
        code: "CHARTER_INVALID",
        severity: "error",
        message: charter.invalidReason,
        path: "BRAIN.md",
      });
    }
    const setupIntegrity = state
      ? await inspectSetupCompletionIntegrity(
          root,
          state,
          manifest?.sources ?? [],
        )
      : { valid: true };
    if (
      state?.setup.status === "completed" &&
      (onboarding.sourceFiles.ready === 0 ||
        !onboarding.charter.configured ||
        !setupIntegrity.valid)
    ) {
      issues.push({
        code: "SETUP_STATE_INVALID",
        severity: "error",
        message: setupIntegrity.reason
          ? `Completed setup is invalid: ${setupIntegrity.reason}`
          : "Completed setup is inconsistent with the current ready-source and charter requirements",
        path: ".brain/state.json",
      });
    }
    if (onboarding.setup.status !== "completed") {
      issues.push({
        code: "SETUP_INCOMPLETE",
        severity: "warning",
        message:
          onboarding.setup.status === "in-progress"
            ? "Initial catalog-and-map setup is in progress."
            : "Initial catalog-and-map setup has not started.",
        path: ".brain/state.json",
      });
    }
  } catch {
    if (config) {
      issues.push(
        ...(await inspectConfiguredSourceRoots(root, config.sources.roots)),
      );
    }
    // Existing fatal configuration, manifest, or state issues already explain
    // other unavailable derived onboarding diagnostics. Unsafe source roots
    // are classified above by the canonical source-path validator.
  }

  return { ok: issues.every((issue) => issue.severity !== "error"), issues };
}
