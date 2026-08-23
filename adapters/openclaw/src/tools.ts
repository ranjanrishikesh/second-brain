import {
  applyChangeSetTransaction,
  attachQueryChange,
  auditBrain,
  beginQuery,
  captureWebEvidence,
  expandQuery,
  finishQuery,
  readBrainItem,
  recordSemanticAuditBatch,
  searchBrain,
  statusBrain,
  type ChangeSetV1,
  type SearchScope,
} from "@second-brain/core";

export const brainToolNames = [
  "brain_status",
  "brain_begin_query",
  "brain_expand_query",
  "brain_search",
  "brain_read",
  "brain_capture_web",
  "brain_apply",
  "brain_finish_query",
  "brain_audit",
] as const;

export function createBrainToolHandlers(root: string) {
  return {
    brain_status: async (_input: Record<string, never>) => statusBrain(root),
    brain_begin_query: async (input: { question: string }) =>
      beginQuery(root, input.question),
    brain_expand_query: async (input: {
      queryId: string;
      tier: "sources" | "web";
      reason: string;
    }) => expandQuery(root, input.queryId, input),
    brain_search: async (input: {
      query: string;
      scope?: SearchScope;
      limit?: number;
    }) => searchBrain(root, input),
    brain_read: async (input: { reference: string; locator?: string }) =>
      readBrainItem(root, input.reference, input.locator),
    brain_capture_web: async (input: {
      queryId: string;
      url: string;
      title: string;
      captureKind: "page" | "snippet";
      content: string;
      retrievedAt?: string;
    }) =>
      captureWebEvidence(root, input.queryId, {
        url: input.url,
        title: input.title,
        captureKind: input.captureKind,
        content: input.content,
        ...(input.retrievedAt ? { retrievedAt: input.retrievedAt } : {}),
      }),
    brain_apply: async (input: {
      changeSet: ChangeSetV1;
      queryId?: string;
    }) => {
      const result = await applyChangeSetTransaction(root, input.changeSet);
      if (input.queryId) {
        await attachQueryChange(root, input.queryId, result.operationId);
      }
      return result;
    },
    brain_finish_query: async (input: {
      queryId: string;
      outcome: "answered" | "partial" | "unanswered";
      answerSummary: string;
      operationIds?: string[];
    }) => {
      for (const operationId of input.operationIds ?? []) {
        await attachQueryChange(root, input.queryId, operationId);
      }
      return finishQuery(root, input.queryId, input);
    },
    brain_audit: async (input: {
      reviewedPageIds?: string[];
      summary?: string;
    }) => {
      if (input.reviewedPageIds?.length) {
        if (!input.summary) {
          throw new Error("Semantic audit review requires a summary");
        }
        return recordSemanticAuditBatch(root, {
          pageIds: input.reviewedPageIds,
          summary: input.summary,
        });
      }
      return auditBrain(root);
    },
  };
}

export type BrainToolHandlers = ReturnType<typeof createBrainToolHandlers>;
