import { z } from "zod";

const extractedSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const sourceRecordBaseV1Schema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^src_[a-f0-9]{16}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().min(1),
  title: z.string().min(1),
  mediaType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  discoveredAt: z.string().datetime(),
  extractor: z.string().min(1),
  error: z.string().optional(),
  supersedes: z.string().optional(),
  provenance: z
    .object({
      kind: z.enum(["file", "web"]),
      url: z.string().url().optional(),
      retrievedAt: z.string().datetime().optional(),
      query: z.string().optional(),
      captureKind: z.enum(["page", "snippet"]).optional(),
    })
    .default({ kind: "file" }),
});

export const sourceRecordV1Schema = z.union([
  sourceRecordBaseV1Schema.extend({
    extractionStatus: z.literal("ready"),
    extractedSha256: extractedSha256Schema,
  }),
  sourceRecordBaseV1Schema.extend({
    extractionStatus: z.enum(["unsupported", "extraction-required", "failed"]),
    extractedSha256: extractedSha256Schema.optional(),
  }),
]);

export type SourceRecordV1 = z.infer<typeof sourceRecordV1Schema>;

export const sourceChunkV1Schema = z.object({
  id: z.string().min(1),
  sourceId: z.string().regex(/^src_[a-f0-9]{16}$/),
  ordinal: z.number().int().nonnegative(),
  locator: z.string().trim().min(1),
  text: z.string(),
});

export type SourceChunkV1 = z.infer<typeof sourceChunkV1Schema>;

export const extractedSourceV1Schema = z.object({
  version: z.literal(1),
  sourceId: z.string().regex(/^src_[a-f0-9]{16}$/),
  title: z.string().min(1),
  text: z.string(),
  chunks: z.array(sourceChunkV1Schema),
});

export type ExtractedSourceV1 = z.infer<typeof extractedSourceV1Schema>;

export interface SourceScanResult {
  added: SourceRecordV1[];
  unchanged: SourceRecordV1[];
  modified: Array<{
    path: string;
    registered: SourceRecordV1;
    actualSha256: string;
  }>;
  deleted: SourceRecordV1[];
  duplicates: Array<{ path: string; sourceId: string }>;
}
