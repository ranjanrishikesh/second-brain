import {
  assertWebApproval,
  attemptManagedSync,
  formatSyncWarning,
  resolveWebApproval,
  statusBrain,
} from "@second-brain/core";
import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { createBrainToolHandlers, type BrainToolHandlers } from "./tools.js";

const sourceId = Type.String({ pattern: "^src_[a-f0-9]{16}$" });
const pageId = Type.String({ pattern: "^pg_[a-z0-9_]{3,64}$" });
const operationId = Type.String({ pattern: "^op_[a-z0-9_-]{3,96}$" });
const nonempty = Type.String({ minLength: 1 });

const relation = Type.Object(
  {
    targetId: pageId,
    kind: nonempty,
    anchor: Type.Optional(nonempty),
    note: Type.Optional(nonempty),
    sourceIds: Type.Optional(Type.Array(sourceId)),
  },
  { additionalProperties: false },
);

const wikiPage = Type.Object(
  {
    schema: Type.Literal(1),
    id: pageId,
    path: Type.String({ pattern: "^wiki/.+\\.md$" }),
    title: nonempty,
    type: nonempty,
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("superseded"),
      Type.Literal("archived"),
    ]),
    summary: nonempty,
    aliases: Type.Optional(Type.Array(nonempty)),
    tags: Type.Optional(Type.Array(nonempty)),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    revision: nonempty,
    sources: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: sourceId,
            locators: Type.Optional(Type.Array(nonempty)),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    relations: Type.Optional(Type.Array(relation)),
    body: nonempty,
  },
  { additionalProperties: false },
);

const reconciliationReason = Type.Union([
  Type.Literal("graph-neighbor"),
  Type.Literal("shared-source"),
  Type.Literal("shared-locator"),
  Type.Literal("shared-tag"),
  Type.Literal("shared-alias"),
  Type.Literal("near-duplicate"),
  Type.Literal("contradiction"),
  Type.Literal("lexical"),
  Type.Literal("semantic"),
]);

const reconciliationPlan = Type.Object(
  {
    version: Type.Literal(1),
    catalogRevision: nonempty,
    changedPageIds: Type.Array(pageId),
    candidates: Type.Array(
      Type.Object(
        {
          pageId,
          revision: nonempty,
          reasons: Type.Array(reconciliationReason, { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const readReceipt = Type.Object(
  {
    pageId,
    revision: nonempty,
    anchor: Type.Optional(nonempty),
    readAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

const changeSet = Type.Object(
  {
    version: Type.Literal(1),
    operationId,
    catalogRevision: nonempty,
    reason: nonempty,
    pages: Type.Array(
      Type.Object(
        {
          action: Type.Union([
            Type.Literal("create"),
            Type.Literal("update"),
            Type.Literal("rename"),
            Type.Literal("merge"),
            Type.Literal("archive"),
          ]),
          expectedRevision: Type.Optional(Type.String()),
          mergeSourceIds: Type.Optional(Type.Array(pageId)),
          page: wikiPage,
        },
        { additionalProperties: false },
      ),
    ),
    reconciliation: Type.Object(
      {
        candidatePageIds: Type.Array(pageId),
        plan: Type.Optional(reconciliationPlan),
        readReceipts: Type.Optional(Type.Array(readReceipt)),
        reviewed: Type.Optional(
          Type.Array(
            Type.Object(
              {
                pageId,
                decision: Type.Union([
                  Type.Literal("changed"),
                  Type.Literal("no-change"),
                ]),
                reason: nonempty,
              },
              { additionalProperties: false },
            ),
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

function textResult(details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function input<T>(params: unknown): T {
  return params as T;
}

function hostedSessionKey(context: {
  sessionKey?: string;
  sessionId?: string;
}): string | undefined {
  return context.sessionKey ?? context.sessionId;
}

function queryIdFromParams(
  params: Record<string, unknown>,
): string | undefined {
  const queryId = params.queryId;
  return typeof queryId === "string" && queryId.trim() ? queryId : undefined;
}

function toolDefinitions(tools: BrainToolHandlers) {
  return [
    {
      name: "brain_status",
      label: "Brain status",
      description:
        "Read source, wiki, setup, sync, audit, and recovery status.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return textResult(await tools.brain_status({}));
      },
    },
    {
      name: "brain_begin_setup",
      label: "Begin initial brain setup",
      description:
        "Start or resume the one-time, source-only initial catalog and map.",
      parameters: Type.Object(
        {
          purpose: nonempty,
          boundaries: Type.Optional(nonempty),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_begin_setup(
            input<{ purpose: string; boundaries?: string }>(params),
          ),
        );
      },
    },
    {
      name: "brain_next_setup",
      label: "Read next setup batch",
      description: "Read the next source batch for initial cataloging.",
      parameters: Type.Object(
        { setupId: nonempty },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_next_setup(input<{ setupId: string }>(params)),
        );
      },
    },
    {
      name: "brain_finish_setup",
      label: "Finish initial brain setup",
      description:
        "Finish setup only after every source has an interconnected source page.",
      parameters: Type.Object(
        { setupId: nonempty, summary: nonempty },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_finish_setup(
            input<{ setupId: string; summary: string }>(params),
          ),
        );
      },
    },
    {
      name: "brain_begin_query",
      label: "Begin brain query",
      description:
        "Begin a knowledge query at the wiki tier and scan new sources.",
      parameters: Type.Object(
        { question: nonempty },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_begin_query(input<{ question: string }>(params)),
        );
      },
    },
    {
      name: "brain_expand_query",
      label: "Expand brain query",
      description:
        "Declare a tier insufficient and expand to raw sources or approved web evidence.",
      parameters: Type.Object(
        {
          queryId: nonempty,
          tier: Type.Union([Type.Literal("sources"), Type.Literal("web")]),
          reason: nonempty,
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_expand_query(
            input<{
              queryId: string;
              tier: "sources" | "web";
              reason: string;
            }>(params),
          ),
        );
      },
    },
    {
      name: "brain_bootstrap_next",
      label: "Read next query bootstrap batch",
      description:
        "Read the next shallow delta-catalog source batch required by the query.",
      parameters: Type.Object(
        { queryId: nonempty },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_bootstrap_next(input<{ queryId: string }>(params)),
        );
      },
    },
    {
      name: "brain_query_read",
      label: "Read and receipt a query item",
      description:
        "Read a wiki page or source item and persist the revision-bound query receipt.",
      parameters: Type.Object(
        {
          queryId: nonempty,
          reference: nonempty,
          locator: Type.Optional(nonempty),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_query_read(
            input<{ queryId: string; reference: string; locator?: string }>(
              params,
            ),
          ),
        );
      },
    },
    {
      name: "brain_search",
      label: "Search brain",
      description:
        "Search canonical wiki pages, immutable source chunks, or both.",
      parameters: Type.Object(
        {
          query: nonempty,
          scope: Type.Optional(
            Type.Union([
              Type.Literal("wiki"),
              Type.Literal("sources"),
              Type.Literal("all"),
            ]),
          ),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_search(
            input<{
              query: string;
              scope?: "wiki" | "sources" | "all";
              limit?: number;
            }>(params),
          ),
        );
      },
    },
    {
      name: "brain_read",
      label: "Read brain item",
      description:
        "Read a wiki page or extracted source chunk by stable reference.",
      parameters: Type.Object(
        {
          reference: nonempty,
          locator: Type.Optional(nonempty),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_read(
            input<{ reference: string; locator?: string }>(params),
          ),
        );
      },
    },
    {
      name: "brain_plan_reconciliation",
      label: "Plan whole-graph reconciliation",
      description:
        "Compute the complete revision-bound neighbor and duplicate review plan before mutation.",
      parameters: Type.Object({ changeSet }, { additionalProperties: false }),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_plan_reconciliation(
            input<{
              changeSet: Parameters<
                typeof tools.brain_plan_reconciliation
              >[0]["changeSet"];
            }>(params),
          ),
        );
      },
    },
    {
      name: "brain_request_web_approval",
      label: "Request web research approval",
      description:
        "Request one owner decision for all web research needed by the active question.",
      parameters: Type.Object(
        { queryId: nonempty, reason: nonempty },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_request_web_approval(
            input<{ queryId: string; reason: string }>(params),
          ),
        );
      },
    },
    {
      name: "brain_resolve_web_approval",
      label: "Resolve web research approval",
      description:
        "Record the owner's approval or denial. Approving triggers OpenClaw's host approval control.",
      parameters: Type.Object(
        {
          queryId: nonempty,
          approved: Type.Boolean(),
          denialReason: Type.Optional(nonempty),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_resolve_web_approval(
            input<{
              queryId: string;
              approved: boolean;
              denialReason?: string;
            }>(params),
          ),
        );
      },
    },
    {
      name: "brain_capture_web",
      label: "Capture web evidence",
      description:
        "Capture immutable, query-linked web evidence after the owner has approved web research.",
      parameters: Type.Object(
        {
          queryId: nonempty,
          url: Type.String({ format: "uri" }),
          title: nonempty,
          captureKind: Type.Union([
            Type.Literal("page"),
            Type.Literal("snippet"),
          ]),
          content: nonempty,
          retrievedAt: Type.Optional(Type.String({ format: "date-time" })),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_capture_web(
            input<{
              queryId: string;
              url: string;
              title: string;
              captureKind: "page" | "snippet";
              content: string;
              retrievedAt?: string;
            }>(params),
          ),
        );
      },
    },
    {
      name: "brain_apply",
      label: "Apply brain change set",
      description:
        "Apply and commit a validated, whole-graph reconciled wiki change set.",
      parameters: Type.Object(
        {
          changeSet,
          queryId: Type.Optional(nonempty),
          setupId: Type.Optional(nonempty),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        const parsed = input<{
          changeSet: Parameters<typeof tools.brain_apply>[0]["changeSet"];
          queryId?: string;
          setupId?: string;
        }>(params);
        return textResult(
          await tools.brain_apply({
            changeSet: parsed.changeSet,
            ...(parsed.queryId ? { queryId: parsed.queryId } : {}),
            ...(parsed.setupId ? { setupId: parsed.setupId } : {}),
          }),
        );
      },
    },
    {
      name: "brain_finish_query",
      label: "Finish brain query",
      description:
        "Validate durable-learning requirements, log, commit, sync if configured, and close a query.",
      parameters: Type.Object(
        {
          queryId: nonempty,
          outcome: Type.Union([
            Type.Literal("answered"),
            Type.Literal("partial"),
            Type.Literal("unanswered"),
          ]),
          answerSummary: nonempty,
          operationIds: Type.Optional(Type.Array(operationId)),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_finish_query(
            input<{
              queryId: string;
              outcome: "answered" | "partial" | "unanswered";
              answerSummary: string;
              operationIds?: string[];
            }>(params),
          ),
        );
      },
    },
    {
      name: "brain_audit",
      label: "Audit brain",
      description: "Read structural health or checkpoint a due semantic audit.",
      parameters: Type.Object(
        {
          reviewedPageIds: Type.Optional(Type.Array(pageId)),
          summary: Type.Optional(nonempty),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: unknown) {
        return textResult(
          await tools.brain_audit(
            input<{ reviewedPageIds?: string[]; summary?: string }>(params),
          ),
        );
      },
    },
    {
      name: "brain_sync",
      label: "Synchronize confirmed brain history",
      description:
        "Safely push only confirmed, fast-forward, managed brain commits.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return textResult(await tools.brain_sync({}));
      },
    },
  ];
}

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "second-brain",
  name: "Portable Second Brain",
  description: "Expose a repository-backed second brain to OpenClaw agents",
  register(api) {
    const pluginConfig = api.pluginConfig as { brainRoot?: unknown };
    const root =
      typeof pluginConfig.brainRoot === "string"
        ? pluginConfig.brainRoot
        : process.env.BRAIN_ROOT || "/brain";
    const activeQueries = new Map<string, string>();

    api.on("gateway_start", async () => {
      try {
        const sync = await attemptManagedSync(root);
        const warning = formatSyncWarning(sync);
        if (warning) api.logger.warn(warning);
      } catch (error) {
        api.logger.warn(
          `Second-brain startup synchronization failed: ${String(error)}`,
        );
      }
    });

    api.registerTool((context) => {
      const sessionKey = hostedSessionKey(context);
      const tools = createBrainToolHandlers(root, {
        ...(sessionKey
          ? {
              hostSessionId: sessionKey,
              activeQueryId: () => activeQueries.get(sessionKey),
              onQueryBegin: (queryId) => activeQueries.set(sessionKey, queryId),
              onQueryFinish: (queryId) => {
                if (activeQueries.get(sessionKey) === queryId) {
                  activeQueries.delete(sessionKey);
                }
              },
            }
          : {}),
      });
      return toolDefinitions(tools);
    });

    api.on("before_tool_call", async (event, context) => {
      const sessionKey = hostedSessionKey(context);
      const queryId = queryIdFromParams(event.params);
      if (
        event.toolName === "brain_resolve_web_approval" &&
        event.params.approved === true
      ) {
        if (
          !sessionKey ||
          !queryId ||
          activeQueries.get(sessionKey) !== queryId
        ) {
          return {
            block: true,
            blockReason:
              "Web approval can only be resolved for the active hosted second-brain query.",
          };
        }
        return {
          requireApproval: {
            title: "Allow web research for this question?",
            description:
              "This grants the active second-brain question access to web_search and web_fetch until its query-specific approval expires.",
            severity: "warning",
            timeoutMs: 5 * 60 * 1000,
            timeoutBehavior: "deny",
            timeoutReason: "Web research approval timed out.",
            allowedDecisions: ["allow-once", "deny"],
            pluginId: "second-brain",
            onResolution: async (decision) => {
              if (decision === "allow-once") return;
              await resolveWebApproval(root, queryId, {
                approved: false,
                decidedBy: `openclaw:${sessionKey}`,
                denialReason:
                  decision === "timeout"
                    ? "The owner did not approve web research before the timeout."
                    : "The owner denied web research for this question.",
              }).catch((error) => {
                api.logger.warn(
                  `Could not record web approval denial: ${String(error)}`,
                );
              });
            },
          },
        };
      }
      if (event.toolName !== "web_search" && event.toolName !== "web_fetch") {
        return undefined;
      }
      const activeQueryId = sessionKey
        ? activeQueries.get(sessionKey)
        : undefined;
      if (!activeQueryId) {
        return {
          block: true,
          blockReason:
            "Web research is blocked until the active second-brain question records owner approval.",
        };
      }
      try {
        await assertWebApproval(root, activeQueryId);
        return undefined;
      } catch {
        return {
          block: true,
          blockReason:
            "Web research requires unexpired owner approval for the active second-brain question.",
        };
      }
    });

    api.on("before_prompt_build", async () => {
      try {
        const status = await statusBrain(root);
        return {
          prependSystemContext: `[Second brain: ${status.brain.name}; sources=${status.sources.total}; pages=${status.wiki.pages}; setup=${status.setup.status}; setup_pending=${status.setup.pendingSourceIds.length}; bootstrap_pending=${status.bootstrap.pendingSourceIds.length}; sync=${status.sync.status}; semantic_audit_due=${status.semanticAudit.due}; recovery_required=${status.recovery.required}] For domain knowledge questions, use the second-brain skill and brain_* lifecycle tools. Native web_search and web_fetch remain blocked until this active question has explicit owner approval.`,
        };
      } catch (error) {
        api.logger.warn(`Second-brain status unavailable: ${String(error)}`);
        return {
          prependSystemContext:
            "[Second brain unavailable: run brain_status before answering a domain knowledge question.]",
        };
      }
    });
  },
});

export default plugin;
