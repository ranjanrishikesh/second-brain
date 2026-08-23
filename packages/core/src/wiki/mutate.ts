import { calculateCatalogRevision } from "./graph.js";
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
  return pages
    .filter((page) => {
      if (changedIds.has(page.id) || page.status === "archived") return false;
      if (directTargets.has(page.id)) return true;
      if (page.sources.some((source) => changedSources.has(source.id)))
        return true;
      return page.tags.some((tag) => changedTags.has(tag));
    })
    .map((page) => page.id)
    .sort();
}

export function applyWikiChangeSet(
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
  for (const candidatePageId of changeSet.reconciliation.candidatePageIds) {
    if (!reviewedPageIds.has(candidatePageId)) {
      throw new Error(
        `Reconciliation decision is missing for ${candidatePageId}`,
      );
    }
  }
  return proposedPages;
}
