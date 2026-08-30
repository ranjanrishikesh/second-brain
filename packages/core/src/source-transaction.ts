import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadBrainConfig } from "./config.js";
import {
  type SupportedSourceFormatV1,
  sourceFormatForPath,
} from "./sources/format.js";
import {
  digestStableRepositoryFile,
  effectiveSourceRoots,
} from "./sources/path-safety.js";
import { scanSources } from "./sources/scan.js";
import { supersedeSource } from "./sources/supersede.js";
import type { SourceScanResult } from "./sources/types.js";
import { type SourceRecordV1, sourceRecordV1Schema } from "./sources/types.js";
import {
  type WebDiscoveryV1,
  webDiscoveryV1Schema,
} from "./sources/web-evidence.js";
import { readBrainState } from "./state.js";
import {
  type CanonicalMutationResult,
  type CanonicalMutationWriter,
  type OperationRecordV1,
  runCanonicalWrite,
  type TransactionTestOptions,
} from "./transaction.js";

interface SourceDigest {
  bytes: number;
  sha256: string;
}

interface ImmutableSourceInput extends SourceDigest {
  path: string;
}

interface DuplicateSourceInput extends ImmutableSourceInput {
  sourceId: string;
  sidecarPath?: string;
  sidecarSha256?: string;
  sidecarBytes?: number;
}

function immutableInputs(source: SourceRecordV1): ImmutableSourceInput[] {
  const sidecar =
    source.provenance.sidecarPath &&
    source.provenance.sidecarSha256 &&
    source.provenance.sidecarBytes !== undefined
      ? [
          {
            path: source.provenance.sidecarPath,
            bytes: source.provenance.sidecarBytes,
            sha256: source.provenance.sidecarSha256,
          },
        ]
      : [];
  return [
    { path: source.path, bytes: source.bytes, sha256: source.sha256 },
    ...sidecar,
  ];
}

function duplicateImmutableInputs(
  duplicate: DuplicateSourceInput,
): ImmutableSourceInput[] {
  const sidecar =
    duplicate.sidecarPath &&
    duplicate.sidecarSha256 &&
    duplicate.sidecarBytes !== undefined
      ? [
          {
            path: duplicate.sidecarPath,
            bytes: duplicate.sidecarBytes,
            sha256: duplicate.sidecarSha256,
          },
        ]
      : [];
  return [
    {
      path: duplicate.path,
      bytes: duplicate.bytes,
      sha256: duplicate.sha256,
    },
    ...sidecar,
  ];
}

interface SourceVerificationContext {
  gitRepository: boolean;
  indexPath?: string;
}

const sourceEncodingByFormat: Readonly<
  Record<SupportedSourceFormatV1, { extractor: string; mediaType: string }>
> = {
  markdown: { extractor: "markdown-v1", mediaType: "text/markdown" },
  text: { extractor: "text-v1", mediaType: "text/plain" },
  html: { extractor: "html-v1", mediaType: "text/html" },
  json: { extractor: "json-v1", mediaType: "application/json" },
  jsonl: {
    extractor: "jsonl-v1",
    mediaType: "application/x-ndjson",
  },
  csv: { extractor: "delimited-v1", mediaType: "text/csv" },
  tsv: {
    extractor: "delimited-v1",
    mediaType: "text/tab-separated-values",
  },
  pdf: { extractor: "pdf-v1", mediaType: "application/pdf" },
  docx: {
    extractor: "docx-v1",
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  epub: { extractor: "epub-v1", mediaType: "application/epub+zip" },
};

function assertPreparedSourceCompatibility(
  source: SourceRecordV1,
  preparedPath: string,
): void {
  const format = sourceFormatForPath(preparedPath);
  const expected = format ? sourceEncodingByFormat[format] : undefined;
  if (
    !expected ||
    source.extractor !== expected.extractor ||
    source.mediaType !== expected.mediaType
  ) {
    throw new Error(
      `Existing source format ${source.mediaType} (${source.extractor}) is not compatible with prepared web evidence at ${preparedPath}`,
    );
  }
}

async function digestStream(
  content: AsyncIterable<Uint8Array>,
): Promise<SourceDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of content) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function stagedSourceDigest(
  root: string,
  source: ImmutableSourceInput,
  indexPath: string | undefined,
): Promise<SourceDigest> {
  const child = spawn("git", ["show", `:${source.path}`], {
    cwd: root,
    ...(indexPath
      ? { env: { ...process.env, GIT_INDEX_FILE: indexPath } }
      : {}),
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  const digest = digestStream(child.stdout);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const result = await digest;
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "Git could not read the staged source");
  }
  return result;
}

async function assertSourceInputsAreStable(
  root: string,
  sources: readonly ImmutableSourceInput[],
  context: SourceVerificationContext,
): Promise<void> {
  for (const source of sources) {
    try {
      // The worktree is the immutable user input; checking it even for a Git
      // transaction catches a hook (or concurrent process) that changes the
      // file after the private index was initially sealed.
      const workingDigest = await digestStableRepositoryFile(
        root,
        source.path,
        "Source input",
        source.bytes,
      );
      if (
        workingDigest.bytes !== source.bytes ||
        workingDigest.sha256 !== source.sha256
      ) {
        throw new Error("source bytes differ from the scanned record");
      }

      // A Git transaction must additionally prove that its private index has
      // the same immutable bytes. Pre-commit hooks inherit GIT_INDEX_FILE and
      // can otherwise replace staged source content after the initial check.
      if (context.gitRepository) {
        const stagedDigest = await stagedSourceDigest(
          root,
          source,
          context.indexPath,
        );
        if (
          stagedDigest.bytes !== source.bytes ||
          stagedDigest.sha256 !== source.sha256
        ) {
          throw new Error("staged source bytes differ from the scanned record");
        }
      }
    } catch {
      throw new Error(
        `Source changed while registering ${source.path}; retry after its bytes are stable`,
      );
    }
  }
}

async function sourceRegistrationMutation(
  root: string,
  operationId: string,
  writer: CanonicalMutationWriter,
): Promise<CanonicalMutationResult<SourceScanResult>> {
  const canonicalPaths = [
    ".brain/source-manifest.json",
    ".brain/state.json",
    ".brain/operations.jsonl",
    "wiki/log.md",
  ] as const;
  const state = await readBrainState(root);
  const protectedWebDuplicates = state.sourceDuplicates.filter(
    (duplicate) =>
      duplicate.sidecarPath !== undefined &&
      duplicate.sidecarSha256 !== undefined &&
      duplicate.sidecarBytes !== undefined,
  );
  let manifestChanged = false;
  let result: SourceScanResult;
  try {
    result = await scanSources(root, async (content) => {
      manifestChanged = true;
      await writer.writeText(".brain/source-manifest.json", content);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const affected = protectedWebDuplicates.find(
      (duplicate) =>
        message.includes(duplicate.path) ||
        (duplicate.sidecarPath
          ? message.includes(duplicate.sidecarPath)
          : false),
    );
    if (affected) {
      throw new Error(
        `Immutable source violation: ${affected.path}${
          affected.sidecarPath ? `, ${affected.sidecarPath}` : ""
        }`,
      );
    }
    throw error;
  }
  const currentDuplicatesByPath = new Map(
    result.duplicates.map((duplicate) => [duplicate.path, duplicate]),
  );
  const changedAcknowledgements = protectedWebDuplicates.filter((previous) => {
    const current = currentDuplicatesByPath.get(previous.path);
    return (
      !current ||
      current.sourceId !== previous.sourceId ||
      current.sha256 !== previous.sha256 ||
      current.bytes !== previous.bytes ||
      current.sidecarPath !== previous.sidecarPath ||
      current.sidecarSha256 !== previous.sidecarSha256 ||
      current.sidecarBytes !== previous.sidecarBytes
    );
  });
  if (changedAcknowledgements.length > 0) {
    throw new Error(
      `Immutable source violation: ${changedAcknowledgements
        .flatMap((duplicate) => [
          duplicate.path,
          ...(duplicate.sidecarPath ? [duplicate.sidecarPath] : []),
        ])
        .join(", ")}`,
    );
  }
  if (result.modified.length || result.deleted.length) {
    throw new Error(
      `Immutable source violation: ${[
        ...result.modified.map((source) => source.path),
        ...result.deleted.map((source) => source.path),
      ].join(", ")}`,
    );
  }
  const addedInputs = result.added.flatMap(immutableInputs);
  for (const source of addedInputs) {
    await writer.sealExisting(source.path, {
      bytes: source.bytes,
      sha256: source.sha256,
    });
  }

  const now = new Date().toISOString();
  const sourceDuplicates = result.duplicates
    .map((duplicate) => ({
      path: duplicate.path,
      sourceId: duplicate.sourceId,
      sha256: duplicate.sha256,
      bytes: duplicate.bytes,
      ...(duplicate.sidecarPath &&
      duplicate.sidecarSha256 &&
      duplicate.sidecarBytes !== undefined
        ? {
            sidecarPath: duplicate.sidecarPath,
            sidecarSha256: duplicate.sidecarSha256,
            sidecarBytes: duplicate.sidecarBytes,
          }
        : {}),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const duplicateAcknowledgementsChanged =
    JSON.stringify(state.sourceDuplicates ?? []) !==
    JSON.stringify(sourceDuplicates);
  if (
    result.added.length === 0 &&
    !manifestChanged &&
    !duplicateAcknowledgementsChanged
  ) {
    return { value: result, stagePaths: [] };
  }
  if (duplicateAcknowledgementsChanged) {
    for (const duplicate of result.duplicates.flatMap(
      duplicateImmutableInputs,
    )) {
      await writer.sealExisting(duplicate.path, {
        bytes: duplicate.bytes,
        sha256: duplicate.sha256,
      });
    }
  }
  const pendingSourceIds = [
    ...new Set([
      ...(state.bootstrap?.pendingSourceIds ?? []),
      ...result.added.map((source) => source.id),
    ]),
  ].sort();
  const setup =
    state.setup?.status === "in-progress"
      ? {
          ...state.setup,
          initialSourceIds: [
            ...new Set([
              ...(state.setup.initialSourceIds ?? []),
              ...result.added.map((source) => source.id),
            ]),
          ].sort(),
          pendingSourceIds: [
            ...new Set([
              ...(state.setup.pendingSourceIds ?? []),
              ...result.added
                .filter((source) => source.extractionStatus === "ready")
                .map((source) => source.id),
            ]),
          ].sort(),
        }
      : state.setup;
  await writer.writeText(
    ".brain/state.json",
    `${JSON.stringify(
      {
        ...state,
        sourceDuplicates,
        bootstrap: { status: "pending", pendingSourceIds },
        ...(setup ? { setup } : {}),
        ...(state.setup?.status === "in-progress" &&
        result.added.some((source) => source.extractionStatus === "ready")
          ? { semanticAuditDue: true }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
  const record: OperationRecordV1 = {
    version: 1,
    id: operationId,
    kind: "source-scan",
    status: "completed",
    startedAt: now,
    completedAt: now,
    summary:
      result.added.length > 0
        ? `Registered ${result.added.length} source${result.added.length === 1 ? "" : "s"}`
        : `Acknowledged ${sourceDuplicates.length} duplicate source path${sourceDuplicates.length === 1 ? "" : "s"}`,
    pageIds: [],
    tiersUsed: [],
  };
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const existingOperations = await readFile(operationsPath, "utf8");
  await writer.writeText(
    ".brain/operations.jsonl",
    `${existingOperations}${JSON.stringify(record)}\n`,
  );
  const logPath = path.join(root, "wiki", "log.md");
  const existingLog = await readFile(logPath, "utf8");
  await writer.writeText(
    "wiki/log.md",
    `${existingLog.trimEnd()}\n\n## [${now}] source | ${result.added.length > 0 ? `Registered ${result.added.length} source${result.added.length === 1 ? "" : "s"}` : `Acknowledged ${sourceDuplicates.length} duplicate source path${sourceDuplicates.length === 1 ? "" : "s"}`}\n\n- Operation: \`${operationId}\`\n${result.added.map((source) => `- \`${source.id}\` — \`${source.path}\` (${source.extractionStatus})`).join("\n")}${sourceDuplicates.map((duplicate) => `\n- \`${duplicate.path}\` duplicates \`${duplicate.sourceId}\``).join("")}\n`,
  );
  return {
    value: result,
    stagePaths: [
      ...addedInputs.map((source) => source.path),
      ...(duplicateAcknowledgementsChanged
        ? result.duplicates
            .flatMap(duplicateImmutableInputs)
            .map((duplicate) => duplicate.path)
        : []),
      ...(manifestChanged ? [canonicalPaths[0]] : []),
      ...canonicalPaths.slice(1),
    ],
    verifyBeforeCommit: async (context) =>
      assertSourceInputsAreStable(
        root,
        [
          ...addedInputs,
          ...(duplicateAcknowledgementsChanged
            ? result.duplicates.flatMap(duplicateImmutableInputs)
            : []),
        ],
        context,
      ),
  };
}

export async function scanAndRegisterSources(
  root: string,
  testOptions: TransactionTestOptions = {},
): Promise<SourceScanResult> {
  const operationId = `op_source_${randomUUID().replaceAll("-", "")}`;
  const config = await loadBrainConfig(root);
  const transaction = await runCanonicalWrite<SourceScanResult>(
    root,
    {
      operationId,
      commitMessage: (result) =>
        result.added.length > 0
          ? `brain(source): register ${result.added.length} source${result.added.length === 1 ? "" : "s"} [op:${operationId}]`
          : `brain(source): acknowledge duplicate paths [op:${operationId}]`,
      testOptions,
      immutableInputRootPaths: effectiveSourceRoots(config.sources.roots),
    },
    (writer) => sourceRegistrationMutation(root, operationId, writer),
  );
  return transaction.value;
}

export interface SourceWebDiscoveryEnrichmentResult {
  source: SourceRecordV1;
  operationId?: string;
  commit?: string;
  changed: boolean;
}

export interface PreparedWebSourceCapture {
  /** Existing canonical source selected from a manifest read under the lock. */
  sourceId?: string;
  /** Newly prepared source path to resolve after the in-transaction scan. */
  sourcePath?: string;
  discovery: WebDiscoveryV1;
}

export interface RegisteredWebSourceCapture {
  source: SourceRecordV1;
  created: boolean;
  commit?: string;
}

export type CommittedWebSourceCaptureHandler = (
  result: Pick<RegisteredWebSourceCapture, "source" | "created">,
) => Promise<void>;

function compareWebDiscoveries(
  left: WebDiscoveryV1,
  right: WebDiscoveryV1,
): number {
  return (
    left.retrievedAt.localeCompare(right.retrievedAt) ||
    left.originalUrl.localeCompare(right.originalUrl) ||
    left.queryId.localeCompare(right.queryId) ||
    left.finalUrl.localeCompare(right.finalUrl) ||
    JSON.stringify(left.redirectChain).localeCompare(
      JSON.stringify(right.redirectChain),
    )
  );
}

/**
 * Adds one immutable evidence discovery without changing the source or its
 * sealed artifact sidecar. The manifest is re-read only after the canonical
 * writer lock is held, so concurrent enrichments cannot replace one another.
 */
async function sourceWebDiscoveryMutation(
  root: string,
  sourceId: string,
  discovery: WebDiscoveryV1,
  operationId: string,
  writer: CanonicalMutationWriter,
): Promise<
  CanonicalMutationResult<{
    source: SourceRecordV1;
    changed: boolean;
  }>
> {
  const manifestPath = path.join(root, ".brain", "source-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: 1;
    sources: unknown[];
  };
  const sources = manifest.sources.map((item) =>
    sourceRecordV1Schema.parse(item),
  );
  const index = sources.findIndex((source) => source.id === sourceId);
  if (index < 0) throw new Error(`Unknown source: ${sourceId}`);
  const current = sources[index] as SourceRecordV1;
  const existing = current.provenance.webDiscoveries ?? [];
  if (
    existing.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(discovery),
    )
  ) {
    return {
      value: { source: current, changed: false },
      stagePaths: [],
    };
  }
  const updated = sourceRecordV1Schema.parse({
    ...current,
    provenance: {
      ...current.provenance,
      webDiscoveries: [...existing, discovery].sort(compareWebDiscoveries),
    },
  });
  sources[index] = updated;
  await writer.writeText(
    ".brain/source-manifest.json",
    `${JSON.stringify({ version: 1, sources }, null, 2)}\n`,
  );
  const now = new Date().toISOString();
  const operation: OperationRecordV1 = {
    version: 1,
    id: operationId,
    kind: "web-capture",
    status: "completed",
    startedAt: now,
    completedAt: now,
    summary: `Recorded web discovery for ${sourceId}`,
    pageIds: [],
    tiersUsed: ["web"],
    queryId: discovery.queryId,
  };
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  await writer.writeText(
    ".brain/operations.jsonl",
    `${await readFile(operationsPath, "utf8")}${JSON.stringify(operation)}\n`,
  );
  const logPath = path.join(root, "wiki", "log.md");
  await writer.writeText(
    "wiki/log.md",
    `${(await readFile(logPath, "utf8")).trimEnd()}\n\n## [${now}] web-capture | Recorded discovery\n\n- Operation: \`${operationId}\`\n- Source: \`${sourceId}\`\n- Query: \`${discovery.queryId}\`\n- URL: ${discovery.originalUrl}\n`,
  );
  return {
    value: { source: updated, changed: true },
    stagePaths: [
      ".brain/source-manifest.json",
      ".brain/operations.jsonl",
      "wiki/log.md",
    ],
  };
}

export async function enrichSourceWebDiscovery(
  root: string,
  sourceId: string,
  rawDiscovery: WebDiscoveryV1,
  testOptions: TransactionTestOptions = {},
): Promise<SourceWebDiscoveryEnrichmentResult> {
  const discovery = webDiscoveryV1Schema.parse(rawDiscovery);
  const operationId = `op_web_capture_${randomUUID().replaceAll("-", "")}`;
  const transaction = await runCanonicalWrite<{
    source: SourceRecordV1;
    changed: boolean;
  }>(
    root,
    {
      operationId,
      commitMessage: `brain(web): record discovery for ${sourceId} [op:${operationId}]`,
      testOptions,
    },
    (writer) =>
      sourceWebDiscoveryMutation(
        root,
        sourceId,
        discovery,
        operationId,
        writer,
      ),
  );
  return {
    ...transaction.value,
    ...(transaction.value.changed ? { operationId } : {}),
    ...(transaction.commit ? { commit: transaction.commit } : {}),
  };
}

/**
 * Serializes the entire capture identity lifecycle with canonical source
 * registration. The preparation callback runs only after the recovery-aware
 * writer lock is held, so it must re-read the manifest before selecting reuse
 * or supersession.
 */
export async function registerWebSourceCapture(
  root: string,
  prepare: () => Promise<PreparedWebSourceCapture>,
  testOptions: TransactionTestOptions = {},
  afterCanonicalCommit?: CommittedWebSourceCaptureHandler,
): Promise<RegisteredWebSourceCapture> {
  const operationId = `op_web_capture_${randomUUID().replaceAll("-", "")}`;
  const scanOperationId = `op_source_${randomUUID().replaceAll("-", "")}`;
  const discoveryOperationId = `op_web_capture_${randomUUID().replaceAll("-", "")}`;
  const config = await loadBrainConfig(root);
  const transaction = await runCanonicalWrite<{
    source: SourceRecordV1;
    created: boolean;
  }>(
    root,
    {
      operationId,
      commitMessage: (result) =>
        result.created
          ? `brain(web): capture ${result.source.id} [op:${operationId}]`
          : `brain(web): record discovery for ${result.source.id} [op:${operationId}]`,
      testOptions,
      waitForWriter: { timeoutMs: 30_000 },
      immutableInputRootPaths: effectiveSourceRoots(config.sources.roots),
      ...(afterCanonicalCommit ? { afterCanonicalCommit } : {}),
    },
    async (writer) => {
      const prepared = await prepare();
      if (
        (!prepared.sourceId && !prepared.sourcePath) ||
        (prepared.sourceId && prepared.sourcePath)
      ) {
        throw new Error(
          "Prepared web capture must identify exactly one source ID or source path",
        );
      }
      const discovery = webDiscoveryV1Schema.parse(prepared.discovery);
      const scan = await sourceRegistrationMutation(
        root,
        scanOperationId,
        writer,
      );
      const manifest = JSON.parse(
        await readFile(
          path.join(root, ".brain", "source-manifest.json"),
          "utf8",
        ),
      ) as { sources?: unknown[] };
      const sources = (manifest.sources ?? []).map((item) =>
        sourceRecordV1Schema.parse(item),
      );
      const preparedDuplicate = prepared.sourcePath
        ? scan.value.duplicates.find(
            (candidate) => candidate.path === prepared.sourcePath,
          )
        : undefined;
      const source = prepared.sourceId
        ? sources.find((candidate) => candidate.id === prepared.sourceId)
        : (sources.find(
            (candidate) => candidate.path === prepared.sourcePath,
          ) ??
          sources.find(
            (candidate) => candidate.id === preparedDuplicate?.sourceId,
          ));
      if (!source) {
        throw new Error(
          prepared.sourceId
            ? `Registered source disappeared: ${prepared.sourceId}`
            : `Captured source was not registered: ${prepared.sourcePath}`,
        );
      }
      if (
        preparedDuplicate &&
        (source.sha256 !== preparedDuplicate.sha256 ||
          source.bytes !== preparedDuplicate.bytes)
      ) {
        throw new Error(
          `Captured source identity does not match prepared bytes: ${preparedDuplicate.path}`,
        );
      }
      if (preparedDuplicate) {
        assertPreparedSourceCompatibility(source, preparedDuplicate.path);
      }
      const enrichment = await sourceWebDiscoveryMutation(
        root,
        source.id,
        discovery,
        discoveryOperationId,
        writer,
      );
      const reusedInputs = immutableInputs(source);
      const changedStagePaths = [
        ...new Set([...scan.stagePaths, ...enrichment.stagePaths]),
      ];
      if (changedStagePaths.length > 0) {
        for (const input of reusedInputs) {
          await writer.sealExisting(input.path, {
            bytes: input.bytes,
            sha256: input.sha256,
          });
        }
      }
      const stagePaths =
        changedStagePaths.length > 0
          ? [
              ...new Set([
                ...changedStagePaths,
                ...reusedInputs.map((input) => input.path),
              ]),
            ]
          : [];
      return {
        value: {
          source: enrichment.value.source,
          created: scan.value.added.some((item) => item.id === source.id),
        },
        stagePaths,
        verifyBeforeCommit: async (context) => {
          await scan.verifyBeforeCommit?.(context);
          await enrichment.verifyBeforeCommit?.(context);
          await assertSourceInputsAreStable(root, reusedInputs, context);
        },
        verifySealedState: async () => {
          await scan.verifySealedState?.();
          await enrichment.verifySealedState?.();
        },
      };
    },
  );
  return {
    ...transaction.value,
    ...(transaction.commit ? { commit: transaction.commit } : {}),
  };
}

export interface SourceSupersessionResult {
  source: SourceRecordV1;
  operationId: string;
  commit?: string;
}

export async function supersedeRegisteredSource(
  root: string,
  previousSourceId: string,
  replacementSourceId: string,
  testOptions: TransactionTestOptions = {},
): Promise<SourceSupersessionResult> {
  await scanAndRegisterSources(root);
  const operationsPath = path.join(root, ".brain", "operations.jsonl");
  const logPath = path.join(root, "wiki", "log.md");
  const operationId = `op_supersede_${randomUUID().replaceAll("-", "")}`;
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId,
      commitMessage: `brain(source): supersede ${previousSourceId} [op:${operationId}]`,
      testOptions,
    },
    async (writer) => {
      const source = await supersedeSource(
        root,
        previousSourceId,
        replacementSourceId,
        (content) => writer.writeText(".brain/source-manifest.json", content),
      );
      const now = new Date().toISOString();
      const operation: OperationRecordV1 = {
        version: 1,
        id: operationId,
        kind: "source-supersede",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary: `${replacementSourceId} supersedes ${previousSourceId}`,
        pageIds: [],
        tiersUsed: [],
      };
      await writer.writeText(
        ".brain/operations.jsonl",
        `${await readFile(operationsPath, "utf8")}${JSON.stringify(operation)}\n`,
      );
      await writer.writeText(
        "wiki/log.md",
        `${(await readFile(logPath, "utf8")).trimEnd()}\n\n## [${now}] source | Supersede source\n\n- Operation: \`${operationId}\`\n- Replacement: \`${replacementSourceId}\`\n- Supersedes: \`${previousSourceId}\`\n`,
      );
      return {
        value: { source, operationId },
        stagePaths: [
          ".brain/source-manifest.json",
          ".brain/operations.jsonl",
          "wiki/log.md",
        ],
      };
    },
  );
  return {
    ...transaction.value,
    ...(transaction.commit ? { commit: transaction.commit } : {}),
  };
}
