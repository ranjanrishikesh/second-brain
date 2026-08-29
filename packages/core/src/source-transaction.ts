import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
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

interface ImmutableSourceInput extends SourceDigest {
  path: string;
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
  source: ImmutableSourceInput,
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

async function assertSourceInputsAreStable(
  root: string,
  sources: readonly ImmutableSourceInput[],
  context: SourceVerificationContext,
): Promise<void> {
  for (const source of sources) {
    try {
      // The worktree is the immutable user input; checking it even for a Git
      // transaction catches a hook (or concurrent process) that changes the
      // file after the private index was initially sealed.
      const workingDigest = await digestStream(
        createReadStream(path.join(root, source.path)),
      );
      if (
        workingDigest.bytes !== source.bytes ||
        workingDigest.sha256 !== source.sha256
      ) {
        throw new Error("source bytes differ from the scanned record");
      }

      // A Git transaction must additionally prove that its private index has
      // the same immutable bytes. Pre-commit hooks inherit GIT_INDEX_FILE and
      // can otherwise replace staged source content after the initial check.
      if (context.gitRepository) {
        const stagedDigest = await stagedSourceDigest(
          root,
          source,
          context.indexPath,
        );
        if (
          stagedDigest.bytes !== source.bytes ||
          stagedDigest.sha256 !== source.sha256
        ) {
          throw new Error("staged source bytes differ from the scanned record");
        }
      }
    } catch {
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
  const transaction = await runCanonicalWrite<SourceScanResult>(
    root,
    {
      operationId,
      commitMessage: (result) =>
        result.added.length > 0
          ? `brain(source): register ${result.added.length} source${result.added.length === 1 ? "" : "s"} [op:${operationId}]`
          : `brain(source): acknowledge duplicate paths [op:${operationId}]`,
      testOptions,
    },
    async (writer) => {
      let manifestChanged = false;
      const result = await scanSources(root, async (content) => {
        manifestChanged = true;
        await writer.writeText(".brain/source-manifest.json", content);
      });
      if (result.modified.length || result.deleted.length) {
        throw new Error(
          `Immutable source violation: ${[
            ...result.modified.map((source) => source.path),
            ...result.deleted.map((source) => source.path),
          ].join(", ")}`,
        );
      }
      for (const source of result.added) {
        await writer.sealExisting(source.path, {
          bytes: source.bytes,
          sha256: source.sha256,
        });
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
        sourceDuplicates?: Array<{
          path: string;
          sourceId: string;
          sha256?: string;
          bytes?: number;
        }>;
        semanticAuditDue?: boolean;
      };
      const sourceDuplicates = result.duplicates
        .map((duplicate) => ({
          path: duplicate.path,
          sourceId: duplicate.sourceId,
          sha256: duplicate.sha256,
          bytes: duplicate.bytes,
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      const duplicateAcknowledgementsChanged =
        JSON.stringify(state.sourceDuplicates ?? []) !==
        JSON.stringify(sourceDuplicates);
      if (
        result.added.length === 0 &&
        !manifestChanged &&
        !duplicateAcknowledgementsChanged
      ) {
        return { value: result, stagePaths: [] };
      }
      if (duplicateAcknowledgementsChanged) {
        for (const duplicate of result.duplicates) {
          await writer.sealExisting(duplicate.path, {
            bytes: duplicate.bytes,
            sha256: duplicate.sha256,
          });
        }
      }
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
      await writer.writeText(
        ".brain/state.json",
        `${JSON.stringify(
          {
            ...state,
            sourceDuplicates,
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
      );
      const record: OperationRecordV1 = {
        version: 1,
        id: operationId,
        kind: "source-scan",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary:
          result.added.length > 0
            ? `Registered ${result.added.length} source${result.added.length === 1 ? "" : "s"}`
            : `Acknowledged ${sourceDuplicates.length} duplicate source path${sourceDuplicates.length === 1 ? "" : "s"}`,
        pageIds: [],
        tiersUsed: [],
      };
      const operationsPath = path.join(root, ".brain", "operations.jsonl");
      const existingOperations = await readFile(operationsPath, "utf8");
      await writer.writeText(
        ".brain/operations.jsonl",
        `${existingOperations}${JSON.stringify(record)}\n`,
      );
      const logPath = path.join(root, "wiki", "log.md");
      const existingLog = await readFile(logPath, "utf8");
      await writer.writeText(
        "wiki/log.md",
        `${existingLog.trimEnd()}\n\n## [${now}] source | ${result.added.length > 0 ? `Registered ${result.added.length} source${result.added.length === 1 ? "" : "s"}` : `Acknowledged ${sourceDuplicates.length} duplicate source path${sourceDuplicates.length === 1 ? "" : "s"}`}\n\n- Operation: \`${operationId}\`\n${result.added.map((source) => `- \`${source.id}\` — \`${source.path}\` (${source.extractionStatus})`).join("\n")}${sourceDuplicates.map((duplicate) => `\n- \`${duplicate.path}\` duplicates \`${duplicate.sourceId}\``).join("")}\n`,
      );
      return {
        value: result,
        stagePaths: [
          ...result.added.map((source) => source.path),
          ...(duplicateAcknowledgementsChanged
            ? result.duplicates.map((duplicate) => duplicate.path)
            : []),
          ...(manifestChanged ? [canonicalPaths[0]] : []),
          ...canonicalPaths.slice(1),
        ],
        verifyBeforeCommit: async (context) =>
          assertSourceInputsAreStable(
            root,
            [
              ...result.added,
              ...(duplicateAcknowledgementsChanged ? result.duplicates : []),
            ],
            context,
          ),
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
    async (writer) => {
      const source = await supersedeSource(
        root,
        previousSourceId,
        replacementSourceId,
        (content) => writer.writeText(".brain/source-manifest.json", content),
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
      await writer.writeText(
        ".brain/operations.jsonl",
        `${await readFile(operationsPath, "utf8")}${JSON.stringify(operation)}\n`,
      );
      await writer.writeText(
        "wiki/log.md",
        `${(await readFile(logPath, "utf8")).trimEnd()}\n\n## [${now}] source | Supersede source\n\n- Operation: \`${operationId}\`\n- Replacement: \`${replacementSourceId}\`\n- Supersedes: \`${previousSourceId}\`\n`,
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
