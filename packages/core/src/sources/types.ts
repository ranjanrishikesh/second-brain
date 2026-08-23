import { z } from "zod";

export const sourceRecordV1Schema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^src_[a-f0-9]{16}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().min(1),
  title: z.string().min(1),
  mediaType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  discoveredAt: z.string().datetime(),
  extractionStatus: z.enum([
    "ready",
    "unsupported",
    "extraction-required",
    "failed",
  ]),
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

export type SourceRecordV1 = z.infer<typeof sourceRecordV1Schema>;

export interface SourceChunkV1 {
  id: string;
  sourceId: string;
  ordinal: number;
  locator: string;
  text: string;
}

export interface ExtractedSourceV1 {
  version: 1;
  sourceId: string;
  title: string;
  text: string;
  chunks: SourceChunkV1[];
}

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
