import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  readBrainState,
  syncStatusV1Schema,
  syncTargetV1Schema,
  writeBrainState,
  type SyncStatusV1,
  type SyncTargetV1,
} from "./state.js";
import { runCanonicalWrite } from "./transaction.js";

const execFile = promisify(execFileCallback);

const configureSyncTargetInputSchema = z.object({
  remote: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  confirm: z.literal(true),
});

export type ConfigureSyncTargetInput = z.infer<
  typeof configureSyncTargetInputSchema
>;

export interface ConfigureSyncTargetResult {
  target: SyncTargetV1;
  commit?: string;
  sync: SyncStatusV1;
}

interface ReadySync {
  kind: "ready";
  target: SyncTargetV1;
  head: string;
}

interface SettledSync {
  kind: "settled";
  status: SyncStatusV1;
}

type SyncEvaluation = ReadySync | SettledSync;

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

function canonicalRemoteUrl(value: string): string {
  const normalized = value.trim();
  try {
    const url = new URL(normalized);
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return normalized.replace(/^[^@\s]+@/, "").replace(/\/+$|\\+$/g, "");
  }
}

export function fingerprintRemoteUrl(url: string): string {
  return createHash("sha256").update(canonicalRemoteUrl(url)).digest("hex");
}

function safeFailureReason(error: unknown, fallback: string): string {
  const text = [
    error instanceof Error ? error.message : "",
    String((error as { stderr?: unknown })?.stderr ?? ""),
  ]
    .join("\n")
    .toLocaleLowerCase("en");
  if (text.includes("authentication")) return "Remote authentication failed.";
  if (text.includes("pre-receive") || text.includes("hook declined")) {
    return "The remote rejected the push.";
  }
  if (text.includes("non-fast-forward") || text.includes("fetch first")) {
    return "The remote branch advanced and needs manual synchronization.";
  }
  return fallback;
}

function targetStatus(
  target: SyncTargetV1,
  status: SyncStatusV1["status"],
  commit?: string,
  reason?: string,
): SyncStatusV1 {
  return syncStatusV1Schema.parse({
    status,
    remote: target.remote,
    branch: target.branch,
    ...(commit ? { commit } : {}),
    ...(reason ? { reason } : {}),
  });
}

async function checkedTarget(root: string): Promise<SyncTargetV1 | undefined> {
  return (await readBrainState(root)).syncTarget;
}

async function currentHead(root: string): Promise<string> {
  return git(root, ["rev-parse", "HEAD"]);
}

async function verifyTarget(
  root: string,
  target: SyncTargetV1,
  head: string,
): Promise<SettledSync | undefined> {
  let branch: string;
  try {
    branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    return {
      kind: "settled",
      status: targetStatus(
        target,
        "manual-sync-required",
        head,
        "The brain is not on the configured branch.",
      ),
    };
  }
  if (branch !== target.branch) {
    return {
      kind: "settled",
      status: targetStatus(
        target,
        "manual-sync-required",
        head,
        `The current branch (${branch}) is not the configured sync branch.`,
      ),
    };
  }
  let remoteUrl: string;
  try {
    remoteUrl = await git(root, ["remote", "get-url", target.remote]);
  } catch {
    return {
      kind: "settled",
      status: targetStatus(
        target,
        "manual-sync-required",
        head,
        "The configured Git remote is unavailable.",
      ),
    };
  }
  if (fingerprintRemoteUrl(remoteUrl) !== target.urlFingerprint) {
    return {
      kind: "settled",
      status: targetStatus(
        target,
        "manual-sync-required",
        head,
        "The configured remote URL no longer matches the confirmed target.",
      ),
    };
  }
  return undefined;
}

async function remoteBranchHead(
  root: string,
  target: SyncTargetV1,
): Promise<string | undefined> {
  const ref = `refs/heads/${target.branch}`;
  const remoteRefs = await git(root, [
    "ls-remote",
    "--heads",
    target.remote,
    ref,
  ]);
  const remoteHead = remoteRefs.split(/\s+/)[0];
  if (!remoteHead) return undefined;
  await git(root, ["fetch", "--no-tags", "--quiet", target.remote, ref]);
  return remoteHead;
}

async function hasOnlyManagedCommits(
  root: string,
  remoteHead: string,
): Promise<boolean> {
  const commits = (
    await git(root, ["rev-list", "--reverse", `${remoteHead}..HEAD`])
  )
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const message = await git(root, ["show", "-s", "--format=%B", commit]);
    if (
      !/(?:^|\n)Brain-Managed:\s*true\s*$/im.test(message) ||
      !/(?:^|\n)Brain-Operation:\s*op_[a-z0-9_-]{3,96}\s*$/im.test(message)
    ) {
      return false;
    }
  }
  return true;
}

async function evaluateSync(root: string): Promise<SyncEvaluation> {
  const target = await checkedTarget(root);
  if (!target) {
    return {
      kind: "settled",
      status: syncStatusV1Schema.parse({ status: "unconfigured" }),
    };
  }
  let head: string;
  try {
    head = await currentHead(root);
  } catch {
    return {
      kind: "settled",
      status: targetStatus(
        target,
        "manual-sync-required",
        undefined,
        "The brain is not a Git repository.",
      ),
    };
  }
  const invalidTarget = await verifyTarget(root, target, head);
  if (invalidTarget) return invalidTarget;
  let remoteHead: string | undefined;
  try {
    remoteHead = await remoteBranchHead(root, target);
  } catch (error) {
    return {
      kind: "settled",
      status: targetStatus(
        target,
        "pending",
        head,
        safeFailureReason(error, "The remote could not be contacted."),
      ),
    };
  }
  if (!remoteHead) {
    return {
      kind: "settled",
      status: targetStatus(
        target,
        "manual-sync-required",
        head,
        "The configured remote branch does not exist.",
      ),
    };
  }
  const remoteIsAncestor = await execFile(
    "git",
    ["merge-base", "--is-ancestor", remoteHead, head],
    { cwd: root },
  )
    .then(() => true)
    .catch(() => false);
  if (!remoteIsAncestor) {
    return {
      kind: "settled",
      status: targetStatus(
        target,
        "manual-sync-required",
        head,
        "The remote branch is not an ancestor of the local brain branch.",
      ),
    };
  }
  if (remoteHead === head) {
    return {
      kind: "settled",
      status: targetStatus(target, "synced", head),
    };
  }
  if (!(await hasOnlyManagedCommits(root, remoteHead))) {
    return {
      kind: "settled",
      status: targetStatus(
        target,
        "manual-sync-required",
        head,
        "An unrelated local commit is ahead of the configured remote.",
      ),
    };
  }
  return { kind: "ready", target, head };
}

/** Returns the current derived sync status without pushing. */
export async function syncStatus(root: string): Promise<SyncStatusV1> {
  const evaluation = await evaluateSync(root);
  if (evaluation.kind === "settled") return evaluation.status;
  return targetStatus(
    evaluation.target,
    "pending",
    evaluation.head,
    "Managed brain commits are ready for a safe push.",
  );
}

/** Pushes only confirmed, fast-forward, entirely managed brain history. */
export async function attemptManagedSync(root: string): Promise<SyncStatusV1> {
  const evaluation = await evaluateSync(root);
  if (evaluation.kind === "settled") return evaluation.status;
  try {
    await git(root, [
      "push",
      evaluation.target.remote,
      `HEAD:refs/heads/${evaluation.target.branch}`,
    ]);
    return targetStatus(evaluation.target, "synced", evaluation.head);
  } catch (error) {
    return targetStatus(
      evaluation.target,
      "pending",
      evaluation.head,
      safeFailureReason(error, "The push failed; retry synchronization later."),
    );
  }
}

/** Confirms an existing Git remote as this independent brain's only auto-sync target. */
export async function configureSyncTarget(
  root: string,
  rawInput: ConfigureSyncTargetInput,
): Promise<ConfigureSyncTargetResult> {
  const input = configureSyncTargetInputSchema.parse(rawInput);
  await git(root, ["rev-parse", "--is-inside-work-tree"]);
  await git(root, ["check-ref-format", "--branch", input.branch]);
  const remoteUrl = await git(root, ["remote", "get-url", input.remote]);
  const target = syncTargetV1Schema.parse({
    remote: input.remote,
    branch: input.branch,
    urlFingerprint: fingerprintRemoteUrl(remoteUrl),
    confirmedAt: new Date().toISOString(),
  });
  const operationId = `op_sync_${randomUUID().replaceAll("-", "")}`;
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId,
      commitMessage: `brain(sync): confirm ${target.remote}/${target.branch} [op:${operationId}]`,
    },
    async () => {
      const state = await readBrainState(root);
      await writeBrainState(root, { ...state, syncTarget: target });
      return {
        value: target,
        stagePaths: [".brain/state.json"],
      };
    },
  );
  return {
    target: transaction.value,
    ...(transaction.commit ? { commit: transaction.commit } : {}),
    sync: transaction.sync ?? (await syncStatus(root)),
  };
}

export function formatSyncWarning(sync: SyncStatusV1): string | undefined {
  if (
    (sync.status !== "pending" && sync.status !== "manual-sync-required") ||
    !sync.commit ||
    !sync.remote ||
    !sync.branch
  ) {
    return undefined;
  }
  return `⚠ Sync pending — knowledge is safely committed locally at ${sync.commit}, but it has not yet been pushed to ${sync.remote}/${sync.branch}: ${sync.reason ?? "manual synchronization is required."}`;
}
