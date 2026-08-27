import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z, ZodError } from "zod";
import { loadBrainConfig } from "./config.js";
import { brainStateV1Schema } from "./state.js";
import { sourceRecordV1Schema } from "./sources/types.js";
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

export async function doctorBrain(root: string): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  try {
    await loadBrainConfig(root);
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

  try {
    brainStateV1Schema.parse(
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
    const absolutePath = path.resolve(root, source.path);
    if (!absolutePath.startsWith(`${path.resolve(root)}${path.sep}`)) {
      issues.push({
        code: "SOURCE_PATH_UNSAFE",
        severity: "error",
        message: `Registered source path escapes the brain root: ${source.path}`,
        path: source.path,
      });
      continue;
    }
    try {
      const content = await readFile(absolutePath);
      const actualHash = createHash("sha256").update(content).digest("hex");
      if (actualHash !== source.sha256) {
        issues.push({
          code: "SOURCE_HASH_MISMATCH",
          severity: "error",
          message: `Registered source bytes changed: ${source.path}`,
          path: source.path,
        });
      }
    } catch (error) {
      issues.push({
        code: "SOURCE_MISSING",
        severity: "error",
        message: `Registered source cannot be read: ${source.path} (${errorMessage(error)})`,
        path: source.path,
      });
    }
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

  return { ok: issues.every((issue) => issue.severity !== "error"), issues };
}
