import {
  recordSourceReviewDecisions,
  reviewSourceCandidates,
  type SourceReviewReceiptV1,
} from "../../src/index.js";

/** Records the test fixture's pending local sources as agent-judged in scope. */
export async function admitPendingTestSources(
  root: string,
): Promise<SourceReviewReceiptV1[]> {
  const review = await reviewSourceCandidates(root);
  const candidates = review.candidates.filter(
    (candidate) => !candidate.existingDecision,
  );
  if (candidates.length === 0) return [];
  const result = await recordSourceReviewDecisions(root, {
    version: 1,
    decisions: candidates.map((candidate) => ({
      path: candidate.path,
      sha256: candidate.sha256,
      decision: "include",
      basis: "agent-in-scope",
      reason: "The test fixture declares this candidate in scope.",
    })),
  });
  return result.receipts;
}
