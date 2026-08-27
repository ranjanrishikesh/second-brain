import { loadBrainConfig } from "./config.js";
import { readBrainState } from "./state.js";
import { searchBrain, type SearchResult } from "./search.js";
import {
  bindEmbeddingProvider,
  semanticSearch,
  type BrainRuntimeServices,
} from "./semantic.js";
import { calculateCatalogRevision, loadWikiPages } from "./wiki/graph.js";
import {
  isCandidateChangedByMutation,
  proposeWikiPageChanges,
} from "./wiki/mutate.js";
import type {
  ChangeSetV1,
  ReconciliationPlanV1,
  ReconciliationReasonV1,
  ReconciliationReceiptV1,
  WikiPageV1,
} from "./wiki/types.js";

function normalizedName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en");
}

function nameTokens(page: WikiPageV1): Set<string>[] {
  return [page.title, ...page.aliases].map(
    (name) => new Set(normalizedName(name).match(/[\p{L}\p{N}]+/gu) ?? []),
  );
}

function names(page: WikiPageV1): Set<string> {
  return new Set([page.title, ...page.aliases].map(normalizedName));
}

function hasNearDuplicateName(
  page: WikiPageV1,
  changedPages: WikiPageV1[],
): boolean {
  return nameTokens(page).some((candidateTokens) =>
    changedPages.flatMap(nameTokens).some((changedTokens) => {
      const minimumSize = Math.min(candidateTokens.size, changedTokens.size);
      if (minimumSize < 2) return false;
      const overlap = [...candidateTokens].filter((token) =>
        changedTokens.has(token),
      ).length;
      return overlap / minimumSize >= 0.5;
    }),
  );
}

function hasSharedLocator(left: WikiPageV1, right: WikiPageV1): boolean {
  const leftLocators = new Map(
    left.sources.map((source) => [source.id, new Set(source.locators)]),
  );
  return right.sources.some((source) =>
    source.locators.some((locator) =>
      leftLocators.get(source.id)?.has(locator),
    ),
  );
}

function structuralReasons(
  candidate: WikiPageV1,
  changedPages: WikiPageV1[],
): Set<ReconciliationReasonV1> {
  const reasons = new Set<ReconciliationReasonV1>();
  const changedIds = new Set(changedPages.map((page) => page.id));
  const changedSourceIds = new Set(
    changedPages.flatMap((page) => page.sources.map((source) => source.id)),
  );
  const changedTags = new Set(changedPages.flatMap((page) => page.tags));
  const changedNames = new Set(
    changedPages.flatMap((page) => [...names(page)]),
  );
  const candidateTargetsChanged = candidate.relations.some((relation) =>
    changedIds.has(relation.targetId),
  );
  const changedTargetsCandidate = changedPages.some((page) =>
    page.relations.some((relation) => relation.targetId === candidate.id),
  );
  if (candidateTargetsChanged || changedTargetsCandidate) {
    reasons.add("graph-neighbor");
  }
  const hasContradiction =
    candidate.relations.some(
      (relation) =>
        relation.kind === "contradicts" && changedIds.has(relation.targetId),
    ) ||
    changedPages.some((page) =>
      page.relations.some(
        (relation) =>
          relation.kind === "contradicts" && relation.targetId === candidate.id,
      ),
    );
  if (hasContradiction) reasons.add("contradiction");
  if (candidate.sources.some((source) => changedSourceIds.has(source.id))) {
    reasons.add("shared-source");
  }
  if (changedPages.some((page) => hasSharedLocator(candidate, page))) {
    reasons.add("shared-locator");
  }
  if (candidate.tags.some((tag) => changedTags.has(tag))) {
    reasons.add("shared-tag");
  }
  if ([...names(candidate)].some((name) => changedNames.has(name))) {
    reasons.add("shared-alias");
  }
  if (hasNearDuplicateName(candidate, changedPages)) {
    reasons.add("near-duplicate");
  }
  return reasons;
}

function addSearchReasons(
  results: readonly SearchResult[],
  eligiblePageIds: Set<string>,
  reason: "lexical" | "semantic",
  candidateReasons: Map<string, Set<ReconciliationReasonV1>>,
): void {
  for (const result of results) {
    if (result.kind !== "wiki" || !eligiblePageIds.has(result.id)) continue;
    const reasons = candidateReasons.get(result.id) ?? new Set();
    reasons.add(reason);
    candidateReasons.set(result.id, reasons);
  }
}

async function shouldUseSemanticSearch(
  root: string,
  services: BrainRuntimeServices,
): Promise<boolean> {
  if (services.embeddings || services.embeddingProviderFactory) return true;
  const setupStatus = (await readBrainState(root)).setup.status;
  return setupStatus === "in-progress" || setupStatus === "completed";
}

/**
 * Computes the exact, revision-bound set of pages an agent must inspect before
 * a wiki mutation can be accepted. The computation is repeated under the
 * transaction writer lock, so an agent cannot omit a candidate by hand.
 */
export async function planReconciliation(
  root: string,
  changeSet: ChangeSetV1,
  services: BrainRuntimeServices = {},
): Promise<ReconciliationPlanV1> {
  const currentPages = await loadWikiPages(root);
  const config = await loadBrainConfig(root);
  const proposedPages = proposeWikiPageChanges(currentPages, changeSet);
  const currentById = new Map(currentPages.map((page) => [page.id, page]));
  const changedPageIds = proposedPages
    .filter((page) => currentById.get(page.id)?.revision !== page.revision)
    .map((page) => page.id)
    .sort();
  const changedIds = new Set(changedPageIds);
  const changedPages = proposedPages.filter((page) => changedIds.has(page.id));
  const eligiblePages = currentPages.filter(
    (page) => page.status === "active" && !changedIds.has(page.id),
  );
  const eligiblePageIds = new Set(eligiblePages.map((page) => page.id));
  const candidateReasons = new Map<string, Set<ReconciliationReasonV1>>();

  for (const candidate of eligiblePages) {
    const reasons = structuralReasons(candidate, changedPages);
    if (reasons.size > 0) candidateReasons.set(candidate.id, reasons);
  }

  const queries = changedPages.map(
    (page) => `${page.title}\n${page.summary}\n${page.body}`,
  );
  for (const query of queries) {
    addSearchReasons(
      await searchBrain(root, {
        query,
        scope: "wiki",
        limit: config.graph.relatedPageLimit,
        ranking: "lexical",
      }),
      eligiblePageIds,
      "lexical",
      candidateReasons,
    );
  }
  if (
    queries.length > 0 &&
    eligiblePages.length > 0 &&
    (await shouldUseSemanticSearch(root, services))
  ) {
    const semanticServices = bindEmbeddingProvider(root, services);
    for (const query of queries) {
      addSearchReasons(
        await semanticSearch(
          root,
          query,
          "wiki",
          config.graph.relatedPageLimit,
          semanticServices,
        ),
        eligiblePageIds,
        "semantic",
        candidateReasons,
      );
    }
  }

  return {
    version: 1,
    catalogRevision: calculateCatalogRevision(currentPages),
    changedPageIds,
    candidates: [...candidateReasons]
      .map(([pageId, reasons]) => {
        const page = currentById.get(pageId);
        if (!page)
          throw new Error(`Reconciliation candidate is missing: ${pageId}`);
        return {
          pageId,
          revision: page.revision,
          reasons: [...reasons].sort(),
        };
      })
      .sort((left, right) => left.pageId.localeCompare(right.pageId)),
  };
}

export function assertReconciliationPlanMatches(
  supplied: ReconciliationPlanV1,
  expected: ReconciliationPlanV1,
): void {
  if (JSON.stringify(supplied) !== JSON.stringify(expected)) {
    throw new Error("Stale or incomplete reconciliation plan");
  }
}

export function assertReconciliationReceipt(
  currentPages: WikiPageV1[],
  proposedPages: WikiPageV1[],
  receipt: ReconciliationReceiptV1,
): void {
  if (!receipt.plan) {
    throw new Error("Reconciliation plan is required");
  }
  const plan = receipt.plan;
  const candidateIds = plan.candidates.map((candidate) => candidate.pageId);
  const expectedIds = [...candidateIds].sort();
  const suppliedIds = [...receipt.candidatePageIds].sort();
  if (JSON.stringify(suppliedIds) !== JSON.stringify(expectedIds)) {
    throw new Error("Reconciliation candidate IDs must exactly match the plan");
  }
  const currentById = new Map(currentPages.map((page) => [page.id, page]));
  const receiptsById = new Map<string, typeof receipt.readReceipts>();
  for (const readReceipt of receipt.readReceipts) {
    const entries = receiptsById.get(readReceipt.pageId) ?? [];
    entries.push(readReceipt);
    receiptsById.set(readReceipt.pageId, entries);
  }
  const reviewsById = new Map<string, typeof receipt.reviewed>();
  for (const review of receipt.reviewed) {
    const entries = reviewsById.get(review.pageId) ?? [];
    entries.push(review);
    reviewsById.set(review.pageId, entries);
  }

  for (const candidate of plan.candidates) {
    const current = currentById.get(candidate.pageId);
    if (!current || current.revision !== candidate.revision) {
      throw new Error(
        `Reconciliation candidate revision is stale: ${candidate.pageId}`,
      );
    }
    const readReceipts = receiptsById.get(candidate.pageId) ?? [];
    if (
      readReceipts.length !== 1 ||
      readReceipts[0]?.revision !== candidate.revision
    ) {
      throw new Error(
        `Current read receipt is required for ${candidate.pageId}`,
      );
    }
    const reviews = reviewsById.get(candidate.pageId) ?? [];
    if (reviews.length !== 1) {
      throw new Error(
        `Reconciliation decision is required for ${candidate.pageId}`,
      );
    }
    if (
      reviews[0]?.decision === "changed" &&
      !isCandidateChangedByMutation(
        currentPages,
        proposedPages,
        candidate.pageId,
      )
    ) {
      throw new Error(
        `Reconciliation candidate marked changed is missing from the change set: ${candidate.pageId}`,
      );
    }
  }
  for (const pageId of [...receiptsById.keys(), ...reviewsById.keys()]) {
    if (!candidateIds.includes(pageId)) {
      throw new Error(
        `Reconciliation receipt references a non-candidate: ${pageId}`,
      );
    }
  }
}
