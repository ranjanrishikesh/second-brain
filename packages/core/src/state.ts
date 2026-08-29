import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const sourceIdV1Schema = z.string().regex(/^src_[a-f0-9]{16}$/);

export const sourceDuplicateAcknowledgementV1Schema = z.object({
  path: z.string().trim().min(1),
  sourceId: sourceIdV1Schema,
});

export type SourceDuplicateAcknowledgementV1 = z.infer<
  typeof sourceDuplicateAcknowledgementV1Schema
>;

export const setupStateV1Schema = z.object({
  status: z
    .enum(["not-started", "in-progress", "completed"])
    .default("not-started"),
  id: z
    .string()
    .regex(/^setup_[a-f0-9]{32}$/)
    .optional(),
  purpose: z.string().trim().min(1).optional(),
  boundaries: z.string().trim().min(1).optional(),
  startedAt: z.string().datetime().optional(),
  initialSourceIds: z.array(sourceIdV1Schema).default([]),
  pendingSourceIds: z.array(sourceIdV1Schema).default([]),
  completedAt: z.string().datetime().optional(),
});

export type SetupStateV1 = z.infer<typeof setupStateV1Schema>;

export const syncTargetV1Schema = z.object({
  remote: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  /** Legacy remote/fetch fingerprint retained for existing brain states. */
  urlFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  /** The sole explicit destination that the user confirmed for automatic push. */
  pushUrlFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  confirmedAt: z.string().datetime(),
});

export type SyncTargetV1 = z.infer<typeof syncTargetV1Schema>;

export const syncStatusV1Schema = z.object({
  status: z.enum(["unconfigured", "synced", "pending", "manual-sync-required"]),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  remote: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
});

export type SyncStatusV1 = z.infer<typeof syncStatusV1Schema>;

export const semanticIndexMetadataV1Schema = z.object({
  version: z.literal(1),
  corpusRevision: z.string().min(1),
  model: z.object({
    id: z.string().trim().min(1),
    revision: z.string().trim().min(1),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  dimensions: z.number().int().positive(),
  builtAt: z.string().datetime(),
});

export type SemanticIndexMetadataV1 = z.infer<
  typeof semanticIndexMetadataV1Schema
>;

const bootstrapStateV1Schema = z.object({
  status: z.enum(["pending", "completed"]),
  pendingSourceIds: z.array(sourceIdV1Schema),
});

const semanticAuditStateV1Schema = z.object({
  status: z.enum(["pending", "completed"]),
  targetMutation: z.number().int().nonnegative(),
  pendingPageIds: z.array(z.string()),
  reviewedPageIds: z.array(z.string()),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export const brainStateV1Schema = z
  .object({
    version: z.literal(1),
    catalogRevision: z.string().min(1),
    knowledgeMutations: z.number().int().nonnegative(),
    lastSemanticAuditMutation: z.number().int().nonnegative(),
    bootstrap: bootstrapStateV1Schema.default({
      status: "pending",
      pendingSourceIds: [],
    }),
    sourceDuplicates: z
      .array(sourceDuplicateAcknowledgementV1Schema)
      .default([]),
    setup: setupStateV1Schema.default(() => ({
      status: "not-started" as const,
      initialSourceIds: [],
      pendingSourceIds: [],
    })),
    semanticIndex: semanticIndexMetadataV1Schema.optional(),
    syncTarget: syncTargetV1Schema.optional(),
    semanticAuditDue: z.boolean().optional(),
    semanticAudit: semanticAuditStateV1Schema.optional(),
  })
  .passthrough();

export type BrainStateV1 = z.infer<typeof brainStateV1Schema>;

export function defaultBrainState(): BrainStateV1 {
  return brainStateV1Schema.parse({
    version: 1,
    catalogRevision: "empty",
    knowledgeMutations: 0,
    lastSemanticAuditMutation: 0,
  });
}

function statePath(root: string): string {
  return path.join(root, ".brain", "state.json");
}

export async function readBrainState(root: string): Promise<BrainStateV1> {
  return brainStateV1Schema.parse(
    JSON.parse(await readFile(statePath(root), "utf8")),
  );
}

export function renderBrainState(state: BrainStateV1): string {
  return `${JSON.stringify(brainStateV1Schema.parse(state), null, 2)}\n`;
}

export async function writeBrainState(
  root: string,
  state: BrainStateV1,
): Promise<void> {
  const destination = statePath(root);
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, renderBrainState(state), "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
