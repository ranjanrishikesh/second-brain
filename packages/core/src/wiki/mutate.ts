import { calculateCatalogRevision } from "./graph.js";
import { canonicalWikiPagePathKey } from "./path.js";
import { calculatePageRevision } from "./page.js";
import {
  changeSetV1Schema,
  type ChangeSetV1,
  type WikiPageV1,
} from "./types.js";

export function buildReconciliationCandidates(
  pages: WikiPageV1[],
  changedPageIds: string[],
): string[] {
  const changedIds = new Set(changedPageIds);
  const changedPages = pages.filter((page) => changedIds.has(page.id));
  const changedSources = new Set(
    changedPages.flatMap((page) => page.sources.map((source) => source.id)),
  );
  const changedTags = new Set(changedPages.flatMap((page) => page.tags));
  const directTargets = new Set([
    ...changedPages.flatMap((page) =>
      page.relations.map((relation) => relation.targetId),
    ),
    ...pages.flatMap((page) =>
      page.relations.some((relation) => changedIds.has(relation.targetId))
        ? [page.id]
        : [],
    ),
  ]);
  const nameTokens = (page: WikiPageV1): Set<string>[] =>
    [page.title, ...page.aliases].map(
      (name) =>
        new Set(
          name
            .normalize("NFKC")
            .toLocaleLowerCase("en")
            .match(/[\p{L}\p{N}]+/gu) ?? [],
        ),
    );
  const changedNameTokens = changedPages.flatMap(nameTokens);
  const isNearDuplicate = (page: WikiPageV1): boolean =>
    nameTokens(page).some((candidateTokens) =>
      changedNameTokens.some((changedTokens) => {
        const minimumSize = Math.min(candidateTokens.size, changedTokens.size);
        if (minimumSize < 2) return false;
        const overlap = [...candidateTokens].filter((token) =>
          changedTokens.has(token),
        ).length;
        return overlap / minimumSize >= 0.5;
      }),
    );
  return pages
    .filter((page) => {
      if (changedIds.has(page.id) || page.status === "archived") return false;
      if (directTargets.has(page.id)) return true;
      if (page.sources.some((source) => changedSources.has(source.id)))
        return true;
      if (page.tags.some((tag) => changedTags.has(tag))) return true;
      return isNearDuplicate(page);
    })
    .map((page) => page.id)
    .sort();
}

export function proposeWikiPageChanges(
  currentPages: WikiPageV1[],
  input: ChangeSetV1,
): WikiPageV1[] {
  const changeSet = changeSetV1Schema.parse(input);
  const actualCatalogRevision = calculateCatalogRevision(currentPages);
  if (changeSet.catalogRevision !== actualCatalogRevision) {
    throw new Error(
      `Stale catalog revision: expected ${actualCatalogRevision}, received ${changeSet.catalogRevision}`,
    );
  }
  const pagesById = new Map(currentPages.map((page) => [page.id, page]));
  const mergeTargets = new Map<string, string>();
  for (const mutation of changeSet.pages) {
    const existing = pagesById.get(mutation.page.id);
    if (mutation.action === "create") {
      if (existing)
        throw new Error(`Wiki page already exists: ${mutation.page.id}`);
    } else {
      if (!existing)
        throw new Error(`Wiki page does not exist: ${mutation.page.id}`);
      if (
        !mutation.expectedRevision ||
        mutation.expectedRevision !== existing.revision
      ) {
        throw new Error(`Stale page revision: ${mutation.page.id}`);
      }
    }
    const page = { ...mutation.page, relations: [...mutation.page.relations] };
    if (mutation.action === "merge") {
      if (!mutation.mergeSourceIds?.length) {
        throw new Error("Merge requires at least one source page");
      }
      for (const sourcePageId of mutation.mergeSourceIds) {
        if (sourcePageId === page.id)
          throw new Error("A page cannot be merged into itself");
        const sourcePage = pagesById.get(sourcePageId);
        if (!sourcePage)
          throw new Error(`Merge source page does not exist: ${sourcePageId}`);
        mergeTargets.set(sourcePageId, page.id);
        const supersededPage = {
          ...sourcePage,
          status: "superseded" as const,
          updatedAt: page.updatedAt,
        };
        supersededPage.revision = calculatePageRevision(supersededPage);
        pagesById.set(sourcePageId, supersededPage);
        if (
          !page.relations.some(
            (relation) =>
              relation.targetId === sourcePageId &&
              relation.kind === "supersedes",
          )
        ) {
          page.relations.push({
            targetId: sourcePageId,
            kind: "supersedes",
            sourceIds: [],
          });
        }
      }
    }
    page.revision = calculatePageRevision(page);
    pagesById.set(page.id, page);
  }
  if (mergeTargets.size > 0) {
    for (const [pageId, originalPage] of pagesById) {
      const relations = originalPage.relations.map((relation) => {
        const mergeTarget = mergeTargets.get(relation.targetId);
        if (!mergeTarget || relation.kind === "supersedes") return relation;
        return { ...relation, targetId: mergeTarget };
      });
      const deduplicated = relations.filter(
        (relation, index) =>
          relations.findIndex(
            (candidate) =>
              candidate.targetId === relation.targetId &&
              candidate.kind === relation.kind &&
              candidate.anchor === relation.anchor,
          ) === index,
      );
      const page = { ...originalPage, relations: deduplicated };
      page.revision = calculatePageRevision(page);
      pagesById.set(pageId, page);
    }
  }
  const proposedPages = [...pagesById.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const paths = new Map<string, string>();
  for (const page of proposedPages) {
    const normalizedPath = canonicalWikiPagePathKey(page.path);
    const existingPageId = paths.get(normalizedPath);
    if (existingPageId && existingPageId !== page.id) {
      throw new Error(
        `Duplicate wiki page path: ${page.path} (${existingPageId}, ${page.id})`,
      );
    }
    paths.set(normalizedPath, page.id);
  }
  const originalRevisions = new Map(
    currentPages.map((page) => [page.id, page.revision]),
  );
  const proposedRevisions = new Map(
    proposedPages.map((page) => [page.id, page.revision]),
  );
  for (const mutation of changeSet.pages) {
    if (
      mutation.action !== "create" &&
      originalRevisions.get(mutation.page.id) ===
        proposedRevisions.get(mutation.page.id)
    ) {
      throw new Error(
        `Wiki mutation makes no canonical change: ${mutation.page.id}`,
      );
    }
  }
  return proposedPages;
}

function relationFingerprint(page: WikiPageV1, targetId: string): string[] {
  return page.relations
    .filter((relation) => relation.targetId === targetId)
    .map((relation) => JSON.stringify(relation))
    .sort();
}

/**
 * A reviewed candidate is durably changed either by changing that page itself
 * or by adding, removing, or rewriting a relation that points to it. The
 * latter is important because generated backlinks update automatically.
 */
export function isCandidateChangedByMutation(
  currentPages: WikiPageV1[],
  proposedPages: WikiPageV1[],
  candidatePageId: string,
): boolean {
  const currentById = new Map(currentPages.map((page) => [page.id, page]));
  const proposedCandidate = proposedPages.find(
    (page) => page.id === candidatePageId,
  );
  if (
    proposedCandidate?.revision !== currentById.get(candidatePageId)?.revision
  ) {
    return true;
  }
  for (const proposedPage of proposedPages) {
    const currentPage = currentById.get(proposedPage.id);
    const before = currentPage
      ? relationFingerprint(currentPage, candidatePageId)
      : [];
    const after = relationFingerprint(proposedPage, candidatePageId);
    if (JSON.stringify(before) !== JSON.stringify(after)) return true;
  }
  return false;
}

export function applyWikiChangeSet(
  currentPages: WikiPageV1[],
  input: ChangeSetV1,
): WikiPageV1[] {
  const changeSet = changeSetV1Schema.parse(input);
  const proposedPages = proposeWikiPageChanges(currentPages, changeSet);
  const declaredCandidateIds = new Set(
    changeSet.reconciliation.candidatePageIds,
  );
  const requiredCandidateIds = buildReconciliationCandidates(
    proposedPages,
    changeSet.pages.map((mutation) => mutation.page.id),
  );
  for (const requiredPageId of requiredCandidateIds) {
    if (!declaredCandidateIds.has(requiredPageId)) {
      throw new Error(`Reconciliation candidate is missing: ${requiredPageId}`);
    }
  }
  const reviewedPageIds = new Set(
    changeSet.reconciliation.reviewed.map((review) => review.pageId),
  );
  const proposedPageIds = new Set(proposedPages.map((page) => page.id));
  for (const candidatePageId of changeSet.reconciliation.candidatePageIds) {
    if (!proposedPageIds.has(candidatePageId)) {
      throw new Error(
        `Reconciliation candidate does not exist: ${candidatePageId}`,
      );
    }
  }
  for (const review of changeSet.reconciliation.reviewed) {
    if (
      review.decision === "changed" &&
      !isCandidateChangedByMutation(currentPages, proposedPages, review.pageId)
    ) {
      throw new Error(
        `Reconciliation candidate marked changed is missing from the change set: ${review.pageId}`,
      );
    }
  }
  for (const candidatePageId of changeSet.reconciliation.candidatePageIds) {
    if (!reviewedPageIds.has(candidatePageId)) {
      throw new Error(
        `Reconciliation decision is missing for ${candidatePageId}`,
      );
    }
  }
  return proposedPages;
}
