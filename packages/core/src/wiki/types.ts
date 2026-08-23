import { z } from "zod";

export const relationV1Schema = z.object({
  targetId: z.string().regex(/^pg_[a-z0-9_]{3,64}$/),
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

export const changeSetV1Schema = z.object({
  version: z.literal(1),
  operationId: z.string().min(1),
  catalogRevision: z.string().min(1),
  reason: z.string().trim().min(1),
  pages: z.array(
    z.object({
      action: z.enum(["create", "update", "rename", "merge", "archive"]),
      expectedRevision: z.string().optional(),
      mergeSourceIds: z
        .array(z.string().regex(/^pg_[a-z0-9_]{3,64}$/))
        .optional(),
      page: wikiPageV1Schema,
    }),
  ),
  reconciliation: z.object({
    candidatePageIds: z.array(z.string()),
    reviewed: z.array(
      z.object({
        pageId: z.string(),
        decision: z.enum(["changed", "no-change"]),
        reason: z.string().min(1),
      }),
    ),
  }),
});

export type ChangeSetV1 = z.infer<typeof changeSetV1Schema>;
