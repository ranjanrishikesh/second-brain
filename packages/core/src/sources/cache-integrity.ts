import { createHash } from "node:crypto";
import {
  extractedSourceV1Schema,
  type ExtractedSourceV1,
  type SourceRecordV1,
} from "./types.js";

export function calculateExtractedSourceSha256(
  input: ExtractedSourceV1,
): string {
  const extracted = extractedSourceV1Schema.parse(input);
  return createHash("sha256").update(JSON.stringify(extracted)).digest("hex");
}

export function assertCanonicalExtractedSource(
  input: unknown,
  source: SourceRecordV1,
): ExtractedSourceV1 {
  const extracted = extractedSourceV1Schema.parse(input);
  if (extracted.sourceId !== source.id) {
    throw new Error(`Extracted cache source ID mismatch: ${source.id}`);
  }
  if (!source.extractedSha256) {
    throw new Error(`Canonical extraction hash is missing: ${source.id}`);
  }
  const actualHash = calculateExtractedSourceSha256(extracted);
  if (actualHash !== source.extractedSha256) {
    throw new Error(`Extracted cache integrity mismatch: ${source.id}`);
  }
  return extracted;
}
