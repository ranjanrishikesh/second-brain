import { z } from "zod";

const sourceDigestV1Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceReviewPathV1Schema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((segment) => segment === ".."),
    "Source review paths must be normalized repository-relative paths",
  );

const sourceReviewDecisionSharedV1Shape = {
  path: sourceReviewPathV1Schema,
  sha256: sourceDigestV1Schema,
  reason: z.string().trim().min(1),
};

function sourceReviewDecisionShape<
  const Decision extends "include" | "exclude",
  const Basis extends "agent-in-scope" | "owner-exception" | "owner-declined",
>(decision: Decision, basis: Basis) {
  return {
    ...sourceReviewDecisionSharedV1Shape,
    decision: z.literal(decision),
    basis: z.literal(basis),
  };
}

export const sourceReviewDecisionInputV1Schema = z.discriminatedUnion("basis", [
  z.strictObject(sourceReviewDecisionShape("include", "agent-in-scope")),
  z.strictObject(sourceReviewDecisionShape("include", "owner-exception")),
  z.strictObject(sourceReviewDecisionShape("exclude", "owner-declined")),
]);

export type SourceReviewDecisionInputV1 = z.infer<
  typeof sourceReviewDecisionInputV1Schema
>;

export const sourceReviewDecisionBatchV1Schema = z.strictObject({
  version: z.literal(1),
  decisions: z.array(sourceReviewDecisionInputV1Schema).min(1).max(1_000),
});

export type SourceReviewDecisionBatchV1 = z.infer<
  typeof sourceReviewDecisionBatchV1Schema
>;

export const sourceReviewReceiptV1Schema = z.discriminatedUnion("basis", [
  z.strictObject({
    ...sourceReviewDecisionShape("include", "agent-in-scope"),
    decidedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...sourceReviewDecisionShape("include", "owner-exception"),
    decidedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...sourceReviewDecisionShape("exclude", "owner-declined"),
    decidedAt: z.iso.datetime(),
  }),
]);

export type SourceReviewReceiptV1 = z.infer<typeof sourceReviewReceiptV1Schema>;

export const sourceReviewCandidateV1Schema = z.strictObject({
  path: sourceReviewPathV1Schema,
  sha256: sourceDigestV1Schema,
  bytes: z.number().int().nonnegative(),
  title: z.string().trim().min(1),
  mediaType: z.string().trim().min(1),
  extractionStatus: z.enum([
    "ready",
    "unsupported",
    "extraction-required",
    "failed",
  ]),
  error: z.string().trim().min(1).optional(),
  representativeChunks: z
    .array(
      z.strictObject({
        locator: z.string().trim().min(1),
        text: z.string(),
      }),
    )
    .max(5),
  existingDecision: sourceReviewReceiptV1Schema.optional(),
});

export type SourceReviewCandidateV1 = z.infer<
  typeof sourceReviewCandidateV1Schema
>;

export const sourceReviewV1Schema = z.strictObject({
  version: z.literal(1),
  candidates: z.array(sourceReviewCandidateV1Schema),
});

export type SourceReviewV1 = z.infer<typeof sourceReviewV1Schema>;

export interface SourceReviewIdentityV1 {
  path: string;
  sha256: string;
  bytes: number;
}
