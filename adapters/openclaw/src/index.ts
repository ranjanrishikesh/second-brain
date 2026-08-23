import { statusBrain } from "@second-brain/core";
import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { createBrainToolHandlers } from "./tools.js";

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
        candidatePageIds: Type.Array(Type.String()),
        reviewed: Type.Array(
          Type.Object(
            {
              pageId: Type.String(),
              decision: Type.Union([
                Type.Literal("changed"),
                Type.Literal("no-change"),
              ]),
              reason: nonempty,
            },
            { additionalProperties: false },
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
    const tools = createBrainToolHandlers(root);

    api.registerTool({
      name: "brain_status",
      label: "Brain status",
      description: "Read source, wiki, bootstrap, audit, and recovery status.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return textResult(await tools.brain_status({}));
      },
    });
    api.registerTool({
      name: "brain_begin_query",
      label: "Begin brain query",
      description:
        "Begin a knowledge query at the wiki tier and scan new sources.",
      parameters: Type.Object(
        { question: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        return textResult(
          await tools.brain_begin_query(input<{ question: string }>(params)),
        );
      },
    });
    api.registerTool({
      name: "brain_expand_query",
      label: "Expand brain query",
      description:
        "Declare a tier insufficient and expand to raw sources or web.",
      parameters: Type.Object(
        {
          queryId: Type.String(),
          tier: Type.Union([Type.Literal("sources"), Type.Literal("web")]),
          reason: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
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
    });
    api.registerTool({
      name: "brain_search",
      label: "Search brain",
      description:
        "Search canonical wiki pages, immutable source chunks, or both.",
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1 }),
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
      async execute(_id, params) {
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
    });
    api.registerTool({
      name: "brain_read",
      label: "Read brain item",
      description:
        "Read a wiki page or extracted source chunk by stable reference.",
      parameters: Type.Object(
        {
          reference: Type.String({ minLength: 1 }),
          locator: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        return textResult(
          await tools.brain_read(
            input<{ reference: string; locator?: string }>(params),
          ),
        );
      },
    });
    api.registerTool({
      name: "brain_capture_web",
      label: "Capture web evidence",
      description:
        "Capture immutable, query-linked web evidence at the web tier.",
      parameters: Type.Object(
        {
          queryId: Type.String(),
          url: Type.String({ format: "uri" }),
          title: Type.String({ minLength: 1 }),
          captureKind: Type.Union([
            Type.Literal("page"),
            Type.Literal("snippet"),
          ]),
          content: Type.String({ minLength: 1 }),
          retrievedAt: Type.Optional(Type.String({ format: "date-time" })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
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
    });
    api.registerTool({
      name: "brain_apply",
      label: "Apply brain change set",
      description: "Apply and commit a validated, reconciled wiki change set.",
      parameters: Type.Object(
        {
          changeSet,
          queryId: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const parsed = input<{
          changeSet: Parameters<typeof tools.brain_apply>[0]["changeSet"];
          queryId?: string;
        }>(params);
        return textResult(
          await tools.brain_apply({
            changeSet: parsed.changeSet,
            ...(parsed.queryId ? { queryId: parsed.queryId } : {}),
          }),
        );
      },
    });
    api.registerTool({
      name: "brain_finish_query",
      label: "Finish brain query",
      description:
        "Validate durable-learning requirements, log, commit, and close a query.",
      parameters: Type.Object(
        {
          queryId: Type.String(),
          outcome: Type.Union([
            Type.Literal("answered"),
            Type.Literal("partial"),
            Type.Literal("unanswered"),
          ]),
          answerSummary: Type.String({ minLength: 1 }),
          operationIds: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
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
    });
    api.registerTool({
      name: "brain_audit",
      label: "Audit brain",
      description: "Read structural health or checkpoint a due semantic audit.",
      parameters: Type.Object(
        {
          reviewedPageIds: Type.Optional(Type.Array(Type.String())),
          summary: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        return textResult(
          await tools.brain_audit(
            input<{ reviewedPageIds?: string[]; summary?: string }>(params),
          ),
        );
      },
    });

    api.on("before_prompt_build", async () => {
      try {
        const status = await statusBrain(root);
        return {
          prependSystemContext: `[Second brain: ${status.brain.name}; sources=${status.sources.total}; pages=${status.wiki.pages}; bootstrap_pending=${status.bootstrap.pendingSourceIds.length}; semantic_audit_due=${status.semanticAudit.due}; recovery_required=${status.recovery.required}] For domain knowledge questions, use the second-brain skill and brain_* lifecycle tools.`,
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
