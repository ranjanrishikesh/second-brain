import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadBrainConfig } from "./config.js";
import { scanSources } from "./sources/scan.js";
import { supersedeSource } from "./sources/supersede.js";
import type { SourceScanResult } from "./sources/types.js";
import type { SourceRecordV1 } from "./sources/types.js";
import type { OperationRecordV1 } from "./transaction.js";

const execFile = promisify(execFileCallback);

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

async function stagedChangesExist(root: string): Promise<boolean> {
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

export async function scanAndRegisterSources(
  root: string,
): Promise<SourceScanResult> {
  const gitRepository = await isGitRepository(root);
  if (gitRepository) {
    if (await stagedChangesExist(root)) {
      throw new Error(
        "Refusing source registration while Git has staged changes",
      );
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
        `Refusing source registration with dirty managed files:\n${dirtyManaged}`,
      );
    }
  }

  const runtimePath = path.join(root, ".brain", "runtime");
  const lockPath = path.join(runtimePath, "source-scan.lock");
  await mkdir(runtimePath, { recursive: true });
  await writeFile(lockPath, "source scan\n", { flag: "wx" });
  const canonicalPaths = [
    ".brain/source-manifest.json",
    ".brain/state.json",
    ".brain/operations.jsonl",
    "wiki/log.md",
  ] as const;
  const before = new Map<string, string>();
  try {
    for (const relativePath of canonicalPaths) {
      before.set(
        relativePath,
        await readFile(path.join(root, relativePath), "utf8"),
      );
    }
    const result = await scanSources(root);
    if (result.modified.length || result.deleted.length) {
      await writeFile(
        path.join(root, ".brain", "source-manifest.json"),
        before.get(".brain/source-manifest.json") ?? "",
        "utf8",
      );
      throw new Error(
        `Immutable source violation: ${[
          ...result.modified.map((source) => source.path),
          ...result.deleted.map((source) => source.path),
        ].join(", ")}`,
      );
    }
    if (result.added.length === 0) return result;

    const now = new Date().toISOString();
    const operationId = `op_source_${randomUUID().replaceAll("-", "")}`;
    const statePath = path.join(root, ".brain", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    > & {
      bootstrap?: { status?: string; pendingSourceIds?: string[] };
    };
    const pendingSourceIds = [
      ...new Set([
        ...(state.bootstrap?.pendingSourceIds ?? []),
        ...result.added.map((source) => source.id),
      ]),
    ].sort();
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          ...state,
          bootstrap: { status: "pending", pendingSourceIds },
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
    await writeFile(
      operationsPath,
      `${before.get(".brain/operations.jsonl") ?? ""}${JSON.stringify(record)}\n`,
      "utf8",
    );
    const logPath = path.join(root, "wiki", "log.md");
    await writeFile(
      logPath,
      `${(before.get("wiki/log.md") ?? "").trimEnd()}\n\n## [${now}] source | Registered ${result.added.length} source${result.added.length === 1 ? "" : "s"}\n\n- Operation: \`${operationId}\`\n${result.added.map((source) => `- \`${source.id}\` — \`${source.path}\` (${source.extractionStatus})`).join("\n")}\n`,
      "utf8",
    );

    const config = await loadBrainConfig(root);
    if (gitRepository && config.git.autoCommit) {
      await git(root, [
        "add",
        "--",
        ...result.added.map((source) => source.path),
        ...canonicalPaths,
      ]);
      try {
        await git(root, [
          "commit",
          "-m",
          `brain(source): register ${result.added.length} source${result.added.length === 1 ? "" : "s"} [op:${operationId}]`,
        ]);
      } catch (error) {
        await execFile(
          "git",
          [
            "restore",
            "--staged",
            "--",
            ...result.added.map((source) => source.path),
            ...canonicalPaths,
          ],
          {
            cwd: root,
          },
        ).catch(() => undefined);
        for (const [relativePath, content] of before) {
          await writeFile(path.join(root, relativePath), content, "utf8");
        }
        throw error;
      }
    }
    return result;
  } finally {
    await rm(lockPath, { force: true });
  }
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
): Promise<SourceSupersessionResult> {
  await scanAndRegisterSources(root);
  const gitRepository = await isGitRepository(root);
  if (gitRepository) {
    if (await stagedChangesExist(root)) {
      throw new Error(
        "Refusing source supersession while Git has staged changes",
      );
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
        `Refusing source supersession with dirty managed files:\n${dirtyManaged}`,
      );
    }
  }
  const manifestPath = path.join(root, ".brain", "source-manifest.json");
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const logPath = path.join(root, "wiki", "log.md");
  const before = new Map<string, string>();
  for (const filePath of [manifestPath, operationsPath, logPath]) {
    before.set(filePath, await readFile(filePath, "utf8"));
  }
  const runtimePath = path.join(root, ".brain", "runtime");
  const lockPath = path.join(runtimePath, "source-supersede.lock");
  await mkdir(runtimePath, { recursive: true });
  await writeFile(lockPath, `${replacementSourceId}\n`, { flag: "wx" });
  const operationId = `op_supersede_${randomUUID().replaceAll("-", "")}`;
  try {
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
      `${before.get(operationsPath) ?? ""}${JSON.stringify(operation)}\n`,
      "utf8",
    );
    await writeFile(
      logPath,
      `${(before.get(logPath) ?? "").trimEnd()}\n\n## [${now}] source | Supersede source\n\n- Operation: \`${operationId}\`\n- Replacement: \`${replacementSourceId}\`\n- Supersedes: \`${previousSourceId}\`\n`,
      "utf8",
    );
    let commit: string | undefined;
    const config = await loadBrainConfig(root);
    if (gitRepository && config.git.autoCommit) {
      const preHead = await git(root, ["rev-parse", "HEAD"]);
      await git(root, [
        "add",
        "--",
        ".brain/source-manifest.json",
        ".brain/operations.jsonl",
        "wiki/log.md",
      ]);
      if ((await git(root, ["rev-parse", "HEAD"])) !== preHead) {
        throw new Error("Git HEAD changed during source supersession");
      }
      await git(root, [
        "commit",
        "-m",
        `brain(source): supersede ${previousSourceId} [op:${operationId}]`,
      ]);
      commit = await git(root, ["rev-parse", "HEAD"]);
    }
    return {
      source,
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
          ".brain/source-manifest.json",
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
