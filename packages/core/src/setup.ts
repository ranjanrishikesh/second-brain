import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import { inspectBrainCharter } from "./onboarding.js";
import { prepareSemanticModel, type BrainRuntimeServices } from "./semantic.js";
import { catalogedSourceIds } from "./source-page-coverage.js";
import { scanAndRegisterSources } from "./source-transaction.js";
import {
  readBrainState,
  renderBrainState,
  type SetupStateV1,
} from "./state.js";
import { loadExtractedSourceCache } from "./sources/rebuild-cache.js";
import { sourceRecordV1Schema, type SourceRecordV1 } from "./sources/types.js";
import {
  operationRecordV1Schema,
  recoverBrain,
  runCanonicalWrite,
  type CanonicalMutationWriter,
  type OperationRecordV1,
  type TransactionTestOptions,
} from "./transaction.js";
import { loadWikiPages, validateWikiGraph } from "./wiki/graph.js";

const setupIdV1Schema = z.string().regex(/^setup_[a-f0-9]{32}$/);

export const setupSessionV1Schema = z.object({
  version: z.literal(1),
  id: setupIdV1Schema,
  status: z.enum(["in-progress", "completed"]),
  purpose: z.string().trim().min(1),
  boundaries: z.string().trim().min(1).optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  initialSourceIds: z.array(z.string().regex(/^src_[a-f0-9]{16}$/)),
  pendingSourceIds: z.array(z.string().regex(/^src_[a-f0-9]{16}$/)),
});

export type SetupSessionV1 = z.infer<typeof setupSessionV1Schema>;

const beginSetupInputSchema = z.object({
  purpose: z.string().trim().min(1),
  boundaries: z.string().trim().min(1).optional(),
});

export type BeginSetupInput = z.infer<typeof beginSetupInputSchema>;

const finishSetupInputSchema = z.object({
  summary: z.string().trim().min(1),
});

export type FinishSetupInput = z.infer<typeof finishSetupInputSchema>;

export interface SetupSourceContextV1 {
  record: SourceRecordV1;
  extracted?: Awaited<ReturnType<typeof loadExtractedSourceCache>>;
}

export interface SetupBatchV1 {
  version: 1;
  setupId: string;
  sourceIds: string[];
  sources: SetupSourceContextV1[];
}

async function assertUsableBrainCharter(root: string): Promise<void> {
  if (!(await inspectBrainCharter(root)).configured) {
    throw new Error(
      "BRAIN.md still contains a placeholder or provisional charter; define the brain purpose before setup",
    );
  }
}

function toSession(setup: SetupStateV1): SetupSessionV1 {
  if (
    !setup.id ||
    !setup.purpose ||
    !setup.startedAt ||
    (setup.status !== "in-progress" && setup.status !== "completed")
  ) {
    throw new Error("Brain setup state is incomplete or corrupt");
  }
  return setupSessionV1Schema.parse({
    version: 1,
    id: setup.id,
    status: setup.status,
    purpose: setup.purpose,
    ...(setup.boundaries ? { boundaries: setup.boundaries } : {}),
    startedAt: setup.startedAt,
    ...(setup.completedAt ? { completedAt: setup.completedAt } : {}),
    initialSourceIds: setup.initialSourceIds,
    pendingSourceIds: setup.pendingSourceIds,
  });
}

async function sourceRecords(root: string): Promise<SourceRecordV1[]> {
  return z
    .object({ version: z.literal(1), sources: z.array(sourceRecordV1Schema) })
    .parse(
      JSON.parse(
        await readFile(
          path.join(root, ".brain", "source-manifest.json"),
          "utf8",
        ),
      ),
    ).sources;
}

export async function pendingReadySourceIds(root: string): Promise<string[]> {
  const [sources, pages] = await Promise.all([
    sourceRecords(root),
    loadWikiPages(root),
  ]);
  const coveredSourceIds = catalogedSourceIds(pages);
  return sources
    .filter(
      (source) =>
        source.extractionStatus === "ready" && !coveredSourceIds.has(source.id),
    )
    .map((source) => source.id)
    .sort();
}

export async function nextSetupBatch(
  root: string,
  setupId: string,
): Promise<SetupBatchV1> {
  setupIdV1Schema.parse(setupId);
  await scanAndRegisterSources(root, { requireReview: true });
  const state = await readBrainState(root);
  if (state.setup.status !== "in-progress" || state.setup.id !== setupId) {
    throw new Error(`Setup is not in progress: ${setupId}`);
  }
  const config = await loadBrainConfig(root);
  const sourceIds = state.setup.pendingSourceIds.slice(
    0,
    config.bootstrap.batchSize,
  );
  const records = new Map(
    (await sourceRecords(root)).map((source) => [source.id, source]),
  );
  const sources: SetupSourceContextV1[] = [];
  for (const sourceId of sourceIds) {
    const record = records.get(sourceId);
    if (!record) {
      throw new Error(`Setup source is missing from the manifest: ${sourceId}`);
    }
    const extracted =
      record.extractionStatus === "ready"
        ? await loadExtractedSourceCache(root, record)
        : undefined;
    sources.push({ record, ...(extracted ? { extracted } : {}) });
  }
  return { version: 1, setupId, sourceIds, sources };
}

async function readOperations(root: string): Promise<OperationRecordV1[]> {
  return (await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => operationRecordV1Schema.parse(JSON.parse(line)));
}

/** Records that a source-page mutation has been accepted by the active setup. */
export async function attachSetupChange(
  root: string,
  setupId: string,
  operationId: string,
  testOptions: TransactionTestOptions = {},
): Promise<SetupSessionV1> {
  setupIdV1Schema.parse(setupId);
  if (!/^op_[a-z0-9_-]{3,96}$/.test(operationId)) {
    throw new Error(`Invalid operation ID: ${operationId}`);
  }
  await recoverBrain(root);
  const attached = (await readOperations(root)).find(
    (operation) => operation.id === operationId,
  );
  if (
    attached?.kind !== "apply" ||
    attached.pageIds.length === 0 ||
    attached.setupId !== setupId
  ) {
    throw new Error(
      `Wiki mutation ${operationId} is not bound to setup ${setupId}`,
    );
  }
  const checkpointOperationId = `op_setup_${randomUUID().replaceAll("-", "")}`;
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId: checkpointOperationId,
      commitMessage: `brain(setup): checkpoint source pages [op:${checkpointOperationId}]`,
      testOptions,
    },
    async (writer) => {
      const [state, sources, pendingSourceIds] = await Promise.all([
        readBrainState(root),
        sourceRecords(root),
        pendingReadySourceIds(root),
      ]);
      if (state.setup.status !== "in-progress" || state.setup.id !== setupId) {
        throw new Error(`Setup is not in progress: ${setupId}`);
      }
      const setup = {
        ...state.setup,
        initialSourceIds: [
          ...new Set([
            ...state.setup.initialSourceIds,
            ...sources.map((source) => source.id),
          ]),
        ].sort(),
        pendingSourceIds,
      };
      await writer.writeText(
        ".brain/state.json",
        renderBrainState({ ...state, setup }),
      );
      const now = new Date().toISOString();
      const operation: OperationRecordV1 = {
        version: 1,
        id: checkpointOperationId,
        kind: "bootstrap",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary: `Checkpointed setup mutation ${operationId}`,
        pageIds: attached.pageIds,
        tiersUsed: [],
        setupId,
      };
      await appendSetupOperation(root, operation, writer);
      return {
        value: toSession(setup),
        stagePaths: [
          ".brain/state.json",
          ".brain/operations.jsonl",
          "wiki/log.md",
        ],
      };
    },
  );
  return transaction.value;
}

function appendSetupOperation(
  root: string,
  operation: OperationRecordV1,
  writer: CanonicalMutationWriter,
): Promise<void> {
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const logPath = path.join(root, "wiki", "log.md");
  return Promise.all([
    readFile(operationsPath, "utf8").then((existing) =>
      writer.writeText(
        ".brain/operations.jsonl",
        `${existing}${JSON.stringify(operation)}\n`,
      ),
    ),
    readFile(logPath, "utf8").then((existing) =>
      writer.writeText(
        "wiki/log.md",
        `${existing.trimEnd()}\n\n## [${operation.completedAt}] setup | ${operation.summary}\n\n- Operation: \`${operation.id}\`\n`,
      ),
    ),
  ]).then(() => undefined);
}

/** Starts or resumes the one-time, source-only setup lifecycle. */
export async function beginSetup(
  root: string,
  rawInput: BeginSetupInput,
  services: BrainRuntimeServices = {},
  testOptions: TransactionTestOptions = {},
): Promise<SetupSessionV1> {
  const input = beginSetupInputSchema.parse(rawInput);
  await recoverBrain(root);
  await assertUsableBrainCharter(root);
  await scanAndRegisterSources(root, {
    ...testOptions,
    requireReview: true,
  });
  const [existing, registeredSources] = await Promise.all([
    readBrainState(root),
    sourceRecords(root),
  ]);
  if (existing.setup.status === "completed") {
    throw new Error("Initial setup is already complete");
  }
  if (
    !registeredSources.some((source) => source.extractionStatus === "ready")
  ) {
    const diagnostics =
      registeredSources.length === 0
        ? "no sources are registered"
        : registeredSources
            .map((source) => `${source.path} (${source.extractionStatus})`)
            .join(", ");
    throw new Error(
      `Initial setup requires at least one registered ready source; ${diagnostics}`,
    );
  }
  await prepareSemanticModel(root, services);
  const operationId = `op_setup_${randomUUID().replaceAll("-", "")}`;
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId,
      commitMessage: `brain(setup): begin initial catalog [op:${operationId}]`,
      testOptions,
    },
    async (writer) => {
      const [state, sources, pendingSourceIds, pages] = await Promise.all([
        readBrainState(root),
        sourceRecords(root),
        pendingReadySourceIds(root),
        loadWikiPages(root),
      ]);
      const now = new Date().toISOString();
      const previous =
        state.setup.status === "in-progress" ? state.setup : undefined;
      const setup = {
        status: "in-progress" as const,
        id: previous?.id ?? `setup_${randomUUID().replaceAll("-", "")}`,
        purpose: previous?.purpose ?? input.purpose,
        ...((previous?.boundaries ?? input.boundaries)
          ? { boundaries: previous?.boundaries ?? input.boundaries }
          : {}),
        startedAt: previous?.startedAt ?? now,
        initialSourceIds: [
          ...new Set([
            ...(previous?.initialSourceIds ?? []),
            ...sources.map((source) => source.id),
          ]),
        ].sort(),
        pendingSourceIds,
      };
      await writer.writeText(
        ".brain/state.json",
        renderBrainState({
          ...state,
          setup,
          semanticAuditDue:
            pendingSourceIds.length > 0 ||
            pages.some((page) => page.status === "active"),
        }),
      );
      const operation: OperationRecordV1 = {
        version: 1,
        id: operationId,
        kind: "bootstrap",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary: `Started setup for ${setup.purpose}`,
        pageIds: [],
        tiersUsed: [],
      };
      await appendSetupOperation(root, operation, writer);
      return {
        value: toSession(setup),
        stagePaths: [
          ".brain/state.json",
          ".brain/operations.jsonl",
          "wiki/log.md",
        ],
      };
    },
  );
  return transaction.value;
}

export async function finishSetup(
  root: string,
  setupId: string,
  rawInput: FinishSetupInput,
  testOptions: TransactionTestOptions = {},
): Promise<SetupSessionV1> {
  const input = finishSetupInputSchema.parse(rawInput);
  setupIdV1Schema.parse(setupId);
  await recoverBrain(root);
  await scanAndRegisterSources(root, { requireReview: true });
  const operationId = `op_setup_${randomUUID().replaceAll("-", "")}`;
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId,
      commitMessage: `brain(setup): finish initial catalog [op:${operationId}]`,
      testOptions,
    },
    async (writer) => {
      const [state, sources, pendingSourceIds] = await Promise.all([
        readBrainState(root),
        sourceRecords(root),
        pendingReadySourceIds(root),
      ]);
      if (state.setup.status !== "in-progress" || state.setup.id !== setupId) {
        throw new Error(`Setup is not in progress: ${setupId}`);
      }
      if (pendingSourceIds.length > 0) {
        const missingPaths = new Map(
          sources.map((source) => [source.id, source.path]),
        );
        throw new Error(
          `Setup needs a source page for: ${pendingSourceIds
            .map((sourceId) => missingPaths.get(sourceId) ?? sourceId)
            .join(", ")}`,
        );
      }
      const graph = await validateWikiGraph(root);
      if (!graph.ok) {
        throw new Error(
          "Setup requires a healthy wiki graph before completion",
        );
      }
      if (state.semanticAuditDue || state.semanticAudit?.status === "pending") {
        throw new Error(
          "Setup requires a completed semantic audit before completion",
        );
      }
      const now = new Date().toISOString();
      const setup = {
        ...state.setup,
        status: "completed" as const,
        pendingSourceIds: [],
        completedAt: now,
      };
      await writer.writeText(
        ".brain/state.json",
        renderBrainState({ ...state, setup }),
      );
      const operation: OperationRecordV1 = {
        version: 1,
        id: operationId,
        kind: "bootstrap",
        status: "completed",
        startedAt: state.setup.startedAt ?? now,
        completedAt: now,
        summary: input.summary,
        pageIds: [],
        tiersUsed: [],
      };
      await appendSetupOperation(root, operation, writer);
      return {
        value: toSession(setup),
        stagePaths: [
          ".brain/state.json",
          ".brain/operations.jsonl",
          "wiki/log.md",
        ],
      };
    },
  );
  return transaction.value;
}
