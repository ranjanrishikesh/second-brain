import {
  recordSourceReviewDecisions,
  reviewSourceCandidates,
} from "@second-brain/core";

/** Models the fake host automatically judging every pending fixture in scope. */
export async function admitPendingFixtureSources(root: string): Promise<void> {
  const review = await reviewSourceCandidates(root);
  const candidates = review.candidates.filter(
    (candidate) => !candidate.existingDecision,
  );
  if (candidates.length === 0) return;
  await recordSourceReviewDecisions(root, {
    version: 1,
    decisions: candidates.map((candidate) => ({
      path: candidate.path,
      sha256: candidate.sha256,
      decision: "include",
      basis: "agent-in-scope",
      reason: "The fake host judged this synthetic fixture in scope.",
    })),
  });
}
