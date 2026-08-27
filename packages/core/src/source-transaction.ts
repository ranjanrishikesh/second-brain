import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scanSources } from "./sources/scan.js";
import { supersedeSource } from "./sources/supersede.js";
import type { SourceScanResult } from "./sources/types.js";
import type { SourceRecordV1 } from "./sources/types.js";
import {
  runCanonicalWrite,
  type OperationRecordV1,
  type TransactionTestOptions,
} from "./transaction.js";

interface SourceDigest {
  bytes: number;
  sha256: string;
}

interface SourceVerificationContext {
  gitRepository: boolean;
  indexPath?: string;
}

async function digestStream(
  content: AsyncIterable<Uint8Array>,
): Promise<SourceDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of content) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function stagedSourceDigest(
  root: string,
  source: SourceRecordV1,
  indexPath: string | undefined,
): Promise<SourceDigest> {
  const child = spawn("git", ["show", `:${source.path}`], {
    cwd: root,
    ...(indexPath
      ? { env: { ...process.env, GIT_INDEX_FILE: indexPath } }
      : {}),
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  const digest = digestStream(child.stdout);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const result = await digest;
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "Git could not read the staged source");
  }
  return result;
}

async function assertAddedSourcesAreStable(
  root: string,
  sources: readonly SourceRecordV1[],
  context: SourceVerificationContext,
): Promise<void> {
  for (const source of sources) {
    let digest: SourceDigest;
    try {
      digest = context.gitRepository
        ? await stagedSourceDigest(root, source, context.indexPath)
        : await digestStream(createReadStream(path.join(root, source.path)));
    } catch {
      throw new Error(
        `Source changed while registering ${source.path}; retry after its bytes are stable`,
      );
    }
    if (digest.bytes !== source.bytes || digest.sha256 !== source.sha256) {
      throw new Error(
        `Source changed while registering ${source.path}; retry after its bytes are stable`,
      );
    }
  }
}

export async function scanAndRegisterSources(
  root: string,
  testOptions: TransactionTestOptions = {},
): Promise<SourceScanResult> {
  const operationId = `op_source_${randomUUID().replaceAll("-", "")}`;
  const canonicalPaths = [
    ".brain/source-manifest.json",
    ".brain/state.json",
    ".brain/operations.jsonl",
    "wiki/log.md",
  ] as const;
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId,
      commitMessage: (result) =>
        `brain(source): register ${result.added.length} source${result.added.length === 1 ? "" : "s"} [op:${operationId}]`,
      testOptions,
    },
    async () => {
      const result = await scanSources(root);
      if (result.modified.length || result.deleted.length) {
        throw new Error(
          `Immutable source violation: ${[
            ...result.modified.map((source) => source.path),
            ...result.deleted.map((source) => source.path),
          ].join(", ")}`,
        );
      }
      if (result.added.length === 0) {
        return { value: result, stagePaths: [] };
      }

      const now = new Date().toISOString();
      const statePath = path.join(root, ".brain", "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<
        string,
        unknown
      > & {
        bootstrap?: { status?: string; pendingSourceIds?: string[] };
        setup?: {
          status?: string;
          initialSourceIds?: string[];
          pendingSourceIds?: string[];
        };
        semanticAuditDue?: boolean;
      };
      const pendingSourceIds = [
        ...new Set([
          ...(state.bootstrap?.pendingSourceIds ?? []),
          ...result.added.map((source) => source.id),
        ]),
      ].sort();
      const setup =
        state.setup?.status === "in-progress"
          ? {
              ...state.setup,
              initialSourceIds: [
                ...new Set([
                  ...(state.setup.initialSourceIds ?? []),
                  ...result.added.map((source) => source.id),
                ]),
              ].sort(),
              pendingSourceIds: [
                ...new Set([
                  ...(state.setup.pendingSourceIds ?? []),
                  ...result.added
                    .filter((source) => source.extractionStatus === "ready")
                    .map((source) => source.id),
                ]),
              ].sort(),
            }
          : state.setup;
      await writeFile(
        statePath,
        `${JSON.stringify(
          {
            ...state,
            bootstrap: { status: "pending", pendingSourceIds },
            ...(setup ? { setup } : {}),
            ...(state.setup?.status === "in-progress" &&
            result.added.some((source) => source.extractionStatus === "ready")
              ? { semanticAuditDue: true }
              : {}),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const record: OperationRecordV1 = {
        version: 1,
        id: operationId,
        kind: "source-scan",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary: `Registered ${result.added.length} source${result.added.length === 1 ? "" : "s"}`,
        pageIds: [],
        tiersUsed: [],
      };
      const operationsPath = path.join(root, ".brain", "operations.jsonl");
      const existingOperations = await readFile(operationsPath, "utf8");
      await writeFile(
        operationsPath,
        `${existingOperations}${JSON.stringify(record)}\n`,
        "utf8",
      );
      const logPath = path.join(root, "wiki", "log.md");
      const existingLog = await readFile(logPath, "utf8");
      await writeFile(
        logPath,
        `${existingLog.trimEnd()}\n\n## [${now}] source | Registered ${result.added.length} source${result.added.length === 1 ? "" : "s"}\n\n- Operation: \`${operationId}\`\n${result.added.map((source) => `- \`${source.id}\` — \`${source.path}\` (${source.extractionStatus})`).join("\n")}\n`,
        "utf8",
      );
      return {
        value: result,
        stagePaths: [
          ...result.added.map((source) => source.path),
          ...canonicalPaths,
        ],
        verifyBeforeCommit: async (context) =>
          assertAddedSourcesAreStable(root, result.added, context),
      };
    },
  );
  return transaction.value;
}

export interface SourceSupersessionResult {
  source: SourceRecordV1;
  operationId: string;
  commit?: string;
}

export async function supersedeRegisteredSource(
  root: string,
  previousSourceId: string,
  replacementSourceId: string,
  testOptions: TransactionTestOptions = {},
): Promise<SourceSupersessionResult> {
  await scanAndRegisterSources(root);
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const logPath = path.join(root, "wiki", "log.md");
  const operationId = `op_supersede_${randomUUID().replaceAll("-", "")}`;
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId,
      commitMessage: `brain(source): supersede ${previousSourceId} [op:${operationId}]`,
      testOptions,
    },
    async () => {
      const source = await supersedeSource(
        root,
        previousSourceId,
        replacementSourceId,
      );
      const now = new Date().toISOString();
      const operation: OperationRecordV1 = {
        version: 1,
        id: operationId,
        kind: "source-supersede",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary: `${replacementSourceId} supersedes ${previousSourceId}`,
        pageIds: [],
        tiersUsed: [],
      };
      await writeFile(
        operationsPath,
        `${await readFile(operationsPath, "utf8")}${JSON.stringify(operation)}\n`,
        "utf8",
      );
      await writeFile(
        logPath,
        `${(await readFile(logPath, "utf8")).trimEnd()}\n\n## [${now}] source | Supersede source\n\n- Operation: \`${operationId}\`\n- Replacement: \`${replacementSourceId}\`\n- Supersedes: \`${previousSourceId}\`\n`,
        "utf8",
      );
      return {
        value: { source, operationId },
        stagePaths: [
          ".brain/source-manifest.json",
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
