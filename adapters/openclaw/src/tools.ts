import {
  applyChangeSetTransaction,
  attachQueryChange,
  attachSetupChange,
  attemptManagedSync,
  auditBrain,
  beginQuery,
  beginSetup,
  captureWebEvidence,
  expandQuery,
  finishQuery,
  finishSetup,
  formatSyncWarning,
  nextBootstrapBatch,
  nextSetupBatch,
  planReconciliation,
  readBrainItem,
  readQueryItem,
  readQuerySession,
  recordSemanticAuditBatch,
  requestWebApproval,
  resolveWebApproval,
  searchBrain,
  statusBrain,
  type ChangeSetV1,
  type SearchScope,
  type SyncStatusV1,
} from "@second-brain/core";

export const brainToolNames = [
  "brain_status",
  "brain_begin_setup",
  "brain_next_setup",
  "brain_finish_setup",
  "brain_begin_query",
  "brain_expand_query",
  "brain_bootstrap_next",
  "brain_query_read",
  "brain_search",
  "brain_read",
  "brain_plan_reconciliation",
  "brain_request_web_approval",
  "brain_resolve_web_approval",
  "brain_capture_web",
  "brain_apply",
  "brain_finish_query",
  "brain_audit",
  "brain_sync",
] as const;

export interface BrainToolHandlerOptions {
  /** Trusted OpenClaw session identity, never supplied by the model. */
  hostSessionId?: string;
  /** Limits hosted tools to the one active question in that host session. */
  activeQueryId?: () => string | undefined;
  onQueryBegin?: (queryId: string) => void;
  onQueryFinish?: (queryId: string) => void;
}

function assertActiveQuery(
  options: BrainToolHandlerOptions,
  queryId: string,
): void {
  if (!options.activeQueryId) return;
  if (options.activeQueryId() !== queryId) {
    throw new Error(
      "This query is not the active second-brain question for the hosted session",
    );
  }
}

function withSyncWarning<T extends { sync?: SyncStatusV1 }>(
  result: T,
): T & {
  syncWarning?: string;
} {
  const warning = result.sync ? formatSyncWarning(result.sync) : undefined;
  return warning ? { ...result, syncWarning: warning } : result;
}

function withDirectSyncWarning<T extends SyncStatusV1>(
  sync: T,
): T & {
  syncWarning?: string;
} {
  const warning = formatSyncWarning(sync);
  return warning ? { ...sync, syncWarning: warning } : sync;
}

export function createBrainToolHandlers(
  root: string,
  options: BrainToolHandlerOptions = {},
) {
  const hostSessionId = options.hostSessionId ?? "openclaw:unbound";
  return {
    brain_status: async (_input: Record<string, never>) => {
      const status = await statusBrain(root);
      return withSyncWarning(status);
    },
    brain_begin_setup: async (input: {
      purpose: string;
      boundaries?: string;
    }) => beginSetup(root, input),
    brain_next_setup: async (input: { setupId: string }) =>
      nextSetupBatch(root, input.setupId),
    brain_finish_setup: async (input: { setupId: string; summary: string }) =>
      finishSetup(root, input.setupId, { summary: input.summary }),
    brain_begin_query: async (input: { question: string }) => {
      const session = withSyncWarning(await beginQuery(root, input.question));
      options.onQueryBegin?.(session.id);
      return session;
    },
    brain_expand_query: async (input: {
      queryId: string;
      tier: "sources" | "web";
      reason: string;
    }) => {
      assertActiveQuery(options, input.queryId);
      return expandQuery(root, input.queryId, input);
    },
    brain_bootstrap_next: async (input: { queryId: string }) => {
      assertActiveQuery(options, input.queryId);
      return nextBootstrapBatch(root, input.queryId);
    },
    brain_query_read: async (input: {
      queryId: string;
      reference: string;
      locator?: string;
    }) => {
      assertActiveQuery(options, input.queryId);
      return readQueryItem(root, input.queryId, input.reference, input.locator);
    },
    brain_search: async (input: {
      query: string;
      scope?: SearchScope;
      limit?: number;
    }) => searchBrain(root, input),
    brain_read: async (input: { reference: string; locator?: string }) =>
      readBrainItem(root, input.reference, input.locator),
    brain_plan_reconciliation: async (input: { changeSet: ChangeSetV1 }) =>
      planReconciliation(root, input.changeSet),
    brain_request_web_approval: async (input: {
      queryId: string;
      reason: string;
    }) => {
      assertActiveQuery(options, input.queryId);
      return requestWebApproval(root, input.queryId, {
        reason: input.reason,
        hostSessionId,
      });
    },
    brain_resolve_web_approval: async (input: {
      queryId: string;
      approved: boolean;
      denialReason?: string;
    }) => {
      assertActiveQuery(options, input.queryId);
      return resolveWebApproval(root, input.queryId, {
        approved: input.approved,
        decidedBy: `openclaw:${hostSessionId}`,
        ...(!input.approved && input.denialReason
          ? { denialReason: input.denialReason }
          : {}),
      });
    },
    brain_capture_web: async (input: {
      queryId: string;
      url: string;
      title: string;
      captureKind: "page" | "snippet";
      content: string;
      retrievedAt?: string;
    }) => {
      assertActiveQuery(options, input.queryId);
      return captureWebEvidence(root, input.queryId, {
        url: input.url,
        title: input.title,
        captureKind: input.captureKind,
        content: input.content,
        ...(input.retrievedAt ? { retrievedAt: input.retrievedAt } : {}),
      });
    },
    brain_apply: async (input: {
      changeSet: ChangeSetV1;
      queryId?: string;
      setupId?: string;
    }) => {
      if (input.queryId && input.setupId) {
        throw new Error("Use either a query ID or a setup ID, not both");
      }
      if (input.queryId) assertActiveQuery(options, input.queryId);
      const query = input.queryId
        ? await readQuerySession(root, input.queryId)
        : undefined;
      const candidatePageIds = new Set(
        input.changeSet.reconciliation.candidatePageIds,
      );
      const changeSet = query
        ? {
            ...input.changeSet,
            reconciliation: {
              ...input.changeSet.reconciliation,
              readReceipts: query.readReceipts.filter((receipt) =>
                candidatePageIds.has(receipt.pageId),
              ),
            },
          }
        : input.changeSet;
      const result = await applyChangeSetTransaction(
        root,
        changeSet,
        input.queryId
          ? { queryId: input.queryId }
          : input.setupId
            ? { context: { kind: "setup", id: input.setupId } }
            : {},
      );
      if (input.queryId) {
        await attachQueryChange(root, input.queryId, result.operationId);
      }
      if (input.setupId) {
        await attachSetupChange(root, input.setupId, result.operationId);
      }
      return withSyncWarning(result);
    },
    brain_finish_query: async (input: {
      queryId: string;
      outcome: "answered" | "partial" | "unanswered";
      answerSummary: string;
      operationIds?: string[];
    }) => {
      assertActiveQuery(options, input.queryId);
      for (const operationId of input.operationIds ?? []) {
        await attachQueryChange(root, input.queryId, operationId);
      }
      const result = withSyncWarning(
        await finishQuery(root, input.queryId, input),
      );
      options.onQueryFinish?.(input.queryId);
      return result;
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
    brain_sync: async (_input: Record<string, never>) =>
      withDirectSyncWarning(await attemptManagedSync(root)),
  };
}

export type BrainToolHandlers = ReturnType<typeof createBrainToolHandlers>;
