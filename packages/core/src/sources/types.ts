import { z } from "zod";
import {
  webCaptureCompletenessV1Schema,
  webCaptureRepresentationV1Schema,
  webDiscoveryV1Schema,
} from "./web-evidence.js";

const extractedSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const docxOutputPolicyV1Schema = z.object({
  version: z.literal(1),
  semanticBytes: z.number().int().nonnegative(),
  convertedBytes: z.number().int().nonnegative(),
  extractedBytes: z.number().int().nonnegative(),
});

export type DocxOutputPolicyV1 = z.infer<typeof docxOutputPolicyV1Schema>;

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
  docxOutputPolicy: docxOutputPolicyV1Schema.optional(),
  supersedes: z
    .string()
    .regex(/^src_[a-f0-9]{16}$/)
    .optional(),
  provenance: z
    .object({
      kind: z.enum(["file", "web"]),
      url: z.string().url().optional(),
      finalUrl: z.string().url().optional(),
      redirectChain: z.array(z.string().url()).max(5).optional(),
      retrievedAt: z.string().datetime().optional(),
      query: z.string().optional(),
      captureKind: z.enum(["page", "snippet"]).optional(),
      completeness: webCaptureCompletenessV1Schema.optional(),
      representation: webCaptureRepresentationV1Schema.optional(),
      sidecarPath: z.string().min(1).optional(),
      sidecarSha256: extractedSha256Schema.optional(),
      sidecarBytes: z.number().int().nonnegative().optional(),
      webDiscoveries: z.array(webDiscoveryV1Schema).optional(),
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
  duplicates: Array<{
    path: string;
    sourceId: string;
    sha256: string;
    bytes: number;
  }>;
}
