import { z } from "zod";

const pageIdV1Schema = z.string().regex(/^pg_[a-z0-9_]{3,64}$/);

export const relationV1Schema = z.object({
  targetId: pageIdV1Schema,
  kind: z.string().trim().min(1),
  anchor: z.string().trim().min(1).optional(),
  note: z.string().trim().min(1).optional(),
  sourceIds: z.array(z.string().regex(/^src_[a-f0-9]{16}$/)).default([]),
});

export type RelationV1 = z.infer<typeof relationV1Schema>;

export const citationV1Schema = z.object({
  sourceId: z.string().regex(/^src_[a-f0-9]{16}$/),
  locator: z.string().trim().min(1).optional(),
});

export type CitationV1 = z.infer<typeof citationV1Schema>;

export const wikiPageV1Schema = z.object({
  schema: z.literal(1),
  id: z.string().regex(/^pg_[a-z0-9_]{3,64}$/),
  path: z.string().regex(/^wiki\/.+\.md$/),
  title: z.string().trim().min(1),
  type: z.string().trim().min(1),
  status: z.enum(["active", "superseded", "archived"]),
  summary: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).default([]),
  tags: z.array(z.string().trim().min(1)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revision: z.string().min(1),
  sources: z
    .array(
      z.object({
        id: z.string().regex(/^src_[a-f0-9]{16}$/),
        locators: z.array(z.string().trim().min(1)).default([]),
      }),
    )
    .default([]),
  relations: z.array(relationV1Schema).default([]),
  body: z.string().trim().min(1),
});

export type WikiPageV1 = z.infer<typeof wikiPageV1Schema>;

export const reconciliationReasonV1Schema = z.enum([
  "graph-neighbor",
  "shared-source",
  "shared-locator",
  "shared-tag",
  "shared-alias",
  "near-duplicate",
  "contradiction",
  "lexical",
  "semantic",
]);

export type ReconciliationReasonV1 = z.infer<
  typeof reconciliationReasonV1Schema
>;

export const reconciliationCandidateV1Schema = z.object({
  pageId: pageIdV1Schema,
  revision: z.string().min(1),
  reasons: z.array(reconciliationReasonV1Schema).min(1),
});

export type ReconciliationCandidateV1 = z.infer<
  typeof reconciliationCandidateV1Schema
>;

export const reconciliationPlanV1Schema = z.object({
  version: z.literal(1),
  catalogRevision: z.string().min(1),
  changedPageIds: z.array(pageIdV1Schema),
  candidates: z.array(reconciliationCandidateV1Schema),
});

export type ReconciliationPlanV1 = z.infer<typeof reconciliationPlanV1Schema>;

export const readReceiptV1Schema = z.object({
  pageId: pageIdV1Schema,
  revision: z.string().min(1),
  anchor: z.string().trim().min(1).optional(),
  readAt: z.string().datetime(),
});

export type ReadReceiptV1 = z.infer<typeof readReceiptV1Schema>;

export const reconciliationReceiptV1Schema = z.object({
  candidatePageIds: z.array(pageIdV1Schema).default([]),
  plan: reconciliationPlanV1Schema.optional(),
  readReceipts: z.array(readReceiptV1Schema).default([]),
  reviewed: z
    .array(
      z.object({
        pageId: pageIdV1Schema,
        decision: z.enum(["changed", "no-change"]),
        reason: z.string().trim().min(1),
      }),
    )
    .default([]),
});

export type ReconciliationReceiptV1 = z.infer<
  typeof reconciliationReceiptV1Schema
>;

export const pageMutationV1Schema = z.object({
  action: z.enum(["create", "update", "rename", "merge", "archive"]),
  expectedRevision: z.string().optional(),
  mergeSourceIds: z.array(pageIdV1Schema).optional(),
  page: wikiPageV1Schema,
});

export type PageMutationV1 = z.infer<typeof pageMutationV1Schema>;

export const changeSetV1Schema = z.object({
  version: z.literal(1),
  operationId: z.string().regex(/^op_[a-z0-9_-]{3,96}$/),
  catalogRevision: z.string().min(1),
  reason: z.string().trim().min(1),
  pages: z.array(pageMutationV1Schema),
  reconciliation: reconciliationReceiptV1Schema,
});

export type ChangeSetV1 = z.infer<typeof changeSetV1Schema>;
