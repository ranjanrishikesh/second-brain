import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import { catalogedSourceIds } from "./source-page-coverage.js";
import { sourceFormatForPath } from "./sources/format.js";
import { type SourceRecordV1, sourceRecordV1Schema } from "./sources/types.js";
import { type BrainStateV1, readBrainState } from "./state.js";
import { loadWikiPages } from "./wiki/graph.js";

export const TEMPLATE_BRAIN_NAME = "Portable Second Brain";
export const TEMPLATE_BRAIN_DESCRIPTION =
  "A self-maintaining personal knowledge base.";

const execFile = promisify(execFileCallback);

const nonEmptyText = z.string().trim().min(1);

export const brainCharterV1Schema = z.object({
  version: z.literal(1),
  description: nonEmptyText,
  purpose: nonEmptyText,
  boundaries: z.array(nonEmptyText).min(1),
  domainConventions: z.array(nonEmptyText).min(1),
  evidencePreferences: z.array(nonEmptyText).min(1),
  origin: z.enum(["inferred", "owner-specified"]),
});

export type BrainCharterV1 = z.infer<typeof brainCharterV1Schema>;

export const onboardingPhaseV1Schema = z.enum([
  "needs-initialization",
  "awaiting-sources",
  "sources-unregistered",
  "sources-blocked",
  "awaiting-charter",
  "ready-for-setup",
  "setup-in-progress",
  "ready",
]);

export type OnboardingPhaseV1 = z.infer<typeof onboardingPhaseV1Schema>;

export const onboardingNextActionV1Schema = z.enum([
  "initialize",
  "add-sources",
  "scan-sources",
  "resolve-source-errors",
  "set-charter",
  "begin-setup",
  "resume-setup",
  "ask-question",
]);

export type OnboardingNextActionV1 = z.infer<
  typeof onboardingNextActionV1Schema
>;

export const onboardingStatusV1Schema = z.object({
  version: z.literal(1),
  phase: onboardingPhaseV1Schema,
  nextAction: onboardingNextActionV1Schema,
  identity: z.object({
    template: z.boolean(),
    name: nonEmptyText,
    description: nonEmptyText,
    suggestedName: nonEmptyText,
  }),
  charter: z.object({
    configured: z.boolean(),
    origin: z.enum(["pending", "inferred", "owner-specified", "legacy"]),
  }),
  sourceFiles: z.object({
    discovered: z.number().int().nonnegative(),
    supportedCandidates: z.number().int().nonnegative(),
    unsupportedCandidates: z.number().int().nonnegative(),
    registered: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    extractionRequired: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    samplePaths: z.array(z.string()).max(20),
  }),
  setup: z.object({
    status: z.enum(["not-started", "in-progress", "completed"]),
  }),
});

export type OnboardingStatusV1 = z.infer<typeof onboardingStatusV1Schema>;

export interface BrainCharterStatusV1 {
  configured: boolean;
  origin: "pending" | "inferred" | "owner-specified" | "legacy";
  invalidReason?: string;
}

function charterSection(content: string, title: string): string | undefined {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^## ${escapedTitle}\\s*\\n([\\s\\S]*?)(?=^## |$)`,
    "im",
  ).exec(content);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

function hasMeaningfulCharterBody(content: string, managed: boolean): boolean {
  const normalized = content.trim();
  const heading = /^# ([^\n]*)\n/.exec(normalized);
  if (!heading?.[1]?.trim()) return false;
  const afterHeading = normalized.slice(heading[0].length);
  const firstSection = afterHeading.search(/^## /m);
  const description = (
    firstSection < 0 ? afterHeading : afterHeading.slice(0, firstSection)
  ).trim();
  if (!description || !charterSection(normalized, "Purpose")) return false;
  if (!managed) return true;
  return ["Boundaries", "Domain conventions", "Evidence preferences"].every(
    (title) => charterSection(normalized, title),
  );
}

function displayName(value: string): string {
  const normalized = value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return TEMPLATE_BRAIN_NAME;
  return normalized
    .split(" ")
    .map((word) => word.charAt(0).toLocaleUpperCase("en") + word.slice(1))
    .join(" ");
}

export function fallbackBrainName(root: string): string {
  return displayName(path.basename(path.resolve(root)));
}

export async function suggestBrainName(root: string): Promise<string> {
  try {
    const commonDirectory = (
      await execFile("git", ["rev-parse", "--git-common-dir"], { cwd: root })
    ).stdout.trim();
    const resolvedCommonDirectory = path.resolve(root, commonDirectory);
    const repositoryPath = resolvedCommonDirectory.endsWith(`${path.sep}.git`)
      ? path.dirname(resolvedCommonDirectory)
      : resolvedCommonDirectory.replace(/\.git$/i, "");
    return displayName(path.basename(repositoryPath));
  } catch {
    return fallbackBrainName(root);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkSourceFiles(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) return [];
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkSourceFiles(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function readSourceRecords(root: string): Promise<SourceRecordV1[]> {
  const manifest = z
    .object({ version: z.literal(1), sources: z.array(sourceRecordV1Schema) })
    .parse(
      JSON.parse(
        await readFile(
          path.join(root, ".brain", "source-manifest.json"),
          "utf8",
        ),
      ),
    );
  return manifest.sources;
}

export interface InvalidSourceDuplicateV1 {
  path: string;
  reason: string;
}

async function digestFile(filePath: string): Promise<{
  bytes: number;
  sha256: string;
}> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function inspectSourceDuplicateAcknowledgements(
  root: string,
  state: BrainStateV1,
  records: SourceRecordV1[],
  options: { verifyBytes?: boolean } = {},
): Promise<{
  validPaths: Set<string>;
  invalid: InvalidSourceDuplicateV1[];
}> {
  const validPaths = new Set<string>();
  const invalid: InvalidSourceDuplicateV1[] = [];
  if (state.sourceDuplicates.length === 0) return { validPaths, invalid };
  const rootPath = path.resolve(root);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  for (const duplicate of state.sourceDuplicates) {
    const canonical = recordsById.get(duplicate.sourceId);
    const absolutePath = path.resolve(root, duplicate.path);
    const companionValues = [
      duplicate.sidecarPath,
      duplicate.sidecarSha256,
      duplicate.sidecarBytes,
    ];
    const hasCompanion = companionValues.some((value) => value !== undefined);
    const hasCompleteCompanion = companionValues.every(
      (value) => value !== undefined,
    );
    let reason: string | undefined;
    if (!absolutePath.startsWith(`${rootPath}${path.sep}`)) {
      reason = "duplicate source path escapes the brain root";
    } else if (
      duplicate.sha256 === undefined ||
      duplicate.bytes === undefined
    ) {
      reason = "legacy duplicate acknowledgement is not sealed to source bytes";
    } else if (
      !canonical ||
      duplicate.sha256 !== canonical.sha256 ||
      duplicate.bytes !== canonical.bytes
    ) {
      reason = "duplicate acknowledgement does not match its canonical source";
    } else {
      try {
        const metadata = await lstat(absolutePath);
        if (!metadata.isFile()) {
          reason = "duplicate source path is not a regular file";
        } else if (metadata.size !== duplicate.bytes) {
          reason = "duplicate source size changed after acknowledgement";
        } else if (options.verifyBytes ?? true) {
          const actual = await digestFile(absolutePath);
          if (
            actual.bytes !== duplicate.bytes ||
            actual.sha256 !== duplicate.sha256
          ) {
            reason = "duplicate source bytes changed after acknowledgement";
          }
        }
      } catch {
        reason = "duplicate source cannot be read";
      }
    }
    if (!reason && hasCompanion && !hasCompleteCompanion) {
      reason = "duplicate sidecar acknowledgement is incomplete";
    }
    if (
      !reason &&
      hasCompleteCompanion &&
      duplicate.sidecarPath &&
      duplicate.sidecarSha256 &&
      duplicate.sidecarBytes !== undefined
    ) {
      const absoluteSidecarPath = path.resolve(root, duplicate.sidecarPath);
      const sourcesPath = path.resolve(root, "sources");
      if (!absoluteSidecarPath.startsWith(`${sourcesPath}${path.sep}`)) {
        reason = "duplicate sidecar path escapes the brain sources tree";
      } else {
        try {
          const [realRootPath, realSourcesPath, realSidecarPath] =
            await Promise.all([
              realpath(root),
              realpath(path.join(root, "sources")),
              realpath(absoluteSidecarPath),
            ]);
          if (
            !realSourcesPath.startsWith(`${realRootPath}${path.sep}`) ||
            !realSidecarPath.startsWith(`${realSourcesPath}${path.sep}`)
          ) {
            reason =
              "duplicate sidecar resolves outside the brain sources tree";
          }
          const metadata = await lstat(absoluteSidecarPath);
          if (!reason && !metadata.isFile()) {
            reason = "duplicate sidecar path is not a regular file";
          } else if (!reason && metadata.size !== duplicate.sidecarBytes) {
            reason = "duplicate sidecar size changed after acknowledgement";
          } else if (!reason && (options.verifyBytes ?? true)) {
            const actual = await digestFile(absoluteSidecarPath);
            if (
              actual.bytes !== duplicate.sidecarBytes ||
              actual.sha256 !== duplicate.sidecarSha256
            ) {
              reason = "duplicate sidecar bytes changed after acknowledgement";
            }
          }
        } catch {
          reason = "duplicate sidecar cannot be read";
        }
      }
    }
    if (reason) invalid.push({ path: duplicate.path, reason });
    else validPaths.add(duplicate.path);
  }
  return { validPaths, invalid };
}

export interface SetupCompletionIntegrityV1 {
  valid: boolean;
  reason?: string;
}

export async function inspectSetupCompletionIntegrity(
  root: string,
  state: BrainStateV1,
  records: SourceRecordV1[],
): Promise<SetupCompletionIntegrityV1> {
  if (state.setup.status !== "completed") return { valid: true };
  if (
    !state.setup.id ||
    !state.setup.purpose ||
    !state.setup.startedAt ||
    !state.setup.completedAt
  ) {
    return {
      valid: false,
      reason: "completed setup is missing required session fields",
    };
  }
  if (state.setup.pendingSourceIds.length > 0) {
    return {
      valid: false,
      reason: "completed setup still has pending initial sources",
    };
  }
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const initialRecords = state.setup.initialSourceIds.map((sourceId) =>
    recordsById.get(sourceId),
  );
  if (initialRecords.some((record) => !record)) {
    return {
      valid: false,
      reason: "completed setup references a source missing from the manifest",
    };
  }
  const readyInitialSourceIds = initialRecords
    .filter(
      (record): record is SourceRecordV1 =>
        record?.extractionStatus === "ready",
    )
    .map((record) => record.id);
  if (readyInitialSourceIds.length === 0) {
    return {
      valid: false,
      reason: "completed setup has no ready initial source",
    };
  }
  const representedSourceIds = catalogedSourceIds(await loadWikiPages(root));
  const missingSourceIds = readyInitialSourceIds.filter(
    (sourceId) => !representedSourceIds.has(sourceId),
  );
  if (missingSourceIds.length > 0) {
    return {
      valid: false,
      reason: `completed setup is missing source pages for: ${missingSourceIds.join(", ")}`,
    };
  }
  return { valid: true };
}

export async function inspectBrainCharter(
  root: string,
): Promise<BrainCharterStatusV1> {
  let content: string;
  try {
    content = await readFile(path.join(root, "BRAIN.md"), "utf8");
  } catch {
    return { configured: false, origin: "pending" };
  }
  if (!content.trim()) {
    return {
      configured: false,
      origin: "pending",
      invalidReason: "BRAIN.md is empty",
    };
  }
  if (content.startsWith("---\n")) {
    const closingMarker = content.indexOf("\n---\n", 4);
    if (closingMarker < 0) {
      return {
        configured: false,
        origin: "pending",
        invalidReason: "BRAIN.md has unterminated charter frontmatter",
      };
    }
    try {
      const metadata = parse(content.slice(4, closingMarker)) as Record<
        string,
        unknown
      >;
      if (
        metadata.brainCharter === 1 &&
        (metadata.origin === "inferred" ||
          metadata.origin === "owner-specified") &&
        hasMeaningfulCharterBody(
          content.slice(closingMarker + "\n---\n".length),
          true,
        )
      ) {
        return { configured: true, origin: metadata.origin };
      }
    } catch {
      // The diagnostic below covers malformed YAML and invalid metadata alike.
    }
    return {
      configured: false,
      origin: "pending",
      invalidReason:
        "BRAIN.md has invalid managed-charter metadata or missing required sections",
    };
  }
  if (
    /replace\s+this\s+section\s+after\s+cloning/i.test(content) ||
    /document\s+what\s+belongs\s+in\s+this\s+brain/i.test(content)
  ) {
    return { configured: false, origin: "pending" };
  }
  return hasMeaningfulCharterBody(content, false)
    ? { configured: true, origin: "legacy" }
    : {
        configured: false,
        origin: "pending",
        invalidReason:
          "Legacy BRAIN.md must include a title, description, and non-empty Purpose section",
      };
}

function phaseAndAction(input: {
  template: boolean;
  setupStatus: "not-started" | "in-progress" | "completed";
  discoveredPaths: string[];
  registeredPaths: Set<string>;
  ready: number;
  charterConfigured: boolean;
  setupCompletionValid: boolean;
}): { phase: OnboardingPhaseV1; nextAction: OnboardingNextActionV1 } {
  if (input.template) {
    return { phase: "needs-initialization", nextAction: "initialize" };
  }
  if (input.discoveredPaths.length === 0 && input.registeredPaths.size === 0) {
    return { phase: "awaiting-sources", nextAction: "add-sources" };
  }
  if (
    input.discoveredPaths.some(
      (sourcePath) => !input.registeredPaths.has(sourcePath),
    )
  ) {
    return { phase: "sources-unregistered", nextAction: "scan-sources" };
  }
  if (input.ready === 0) {
    return {
      phase: "sources-blocked",
      nextAction: "resolve-source-errors",
    };
  }
  if (!input.charterConfigured) {
    return { phase: "awaiting-charter", nextAction: "set-charter" };
  }
  if (input.setupStatus === "in-progress") {
    return { phase: "setup-in-progress", nextAction: "resume-setup" };
  }
  if (input.setupStatus === "completed") {
    if (!input.setupCompletionValid) {
      return { phase: "setup-in-progress", nextAction: "resume-setup" };
    }
    return { phase: "ready", nextAction: "ask-question" };
  }
  return { phase: "ready-for-setup", nextAction: "begin-setup" };
}

export async function inspectOnboarding(
  root: string,
): Promise<OnboardingStatusV1> {
  const [config, records, state, charter, suggestedName] = await Promise.all([
    loadBrainConfig(root),
    readSourceRecords(root),
    readBrainState(root),
    inspectBrainCharter(root),
    suggestBrainName(root),
  ]);
  const discoveredAbsolutePaths = (
    await Promise.all(
      config.sources.roots.map((sourceRoot) =>
        walkSourceFiles(path.join(root, sourceRoot)),
      ),
    )
  ).flat();
  const discoveredPaths = discoveredAbsolutePaths
    .map((absolutePath) =>
      path.relative(root, absolutePath).split(path.sep).join("/"),
    )
    .sort((left, right) => left.localeCompare(right));
  const extractionCount = (status: SourceRecordV1["extractionStatus"]) =>
    records.filter((record) => record.extractionStatus === status).length;
  const template =
    config.brain.name === TEMPLATE_BRAIN_NAME &&
    config.brain.description === TEMPLATE_BRAIN_DESCRIPTION;
  const registeredSourceIds = new Set(records.map((record) => record.id));
  const duplicateIntegrity = await inspectSourceDuplicateAcknowledgements(
    root,
    state,
    records,
    { verifyBytes: false },
  );
  const registeredPaths = new Set([
    ...records.map((record) => record.path),
    ...state.sourceDuplicates
      .filter(
        (duplicate) =>
          registeredSourceIds.has(duplicate.sourceId) &&
          duplicateIntegrity.validPaths.has(duplicate.path),
      )
      .map((duplicate) => duplicate.path),
  ]);
  const setupIntegrity = await inspectSetupCompletionIntegrity(
    root,
    state,
    records,
  );
  const phase = phaseAndAction({
    template,
    setupStatus: state.setup.status,
    discoveredPaths,
    registeredPaths,
    ready: extractionCount("ready"),
    charterConfigured: charter.configured,
    setupCompletionValid: setupIntegrity.valid,
  });
  return onboardingStatusV1Schema.parse({
    version: 1,
    ...phase,
    identity: {
      template,
      name: config.brain.name,
      description: config.brain.description,
      suggestedName,
    },
    charter,
    sourceFiles: {
      discovered: discoveredPaths.length,
      supportedCandidates: discoveredPaths.filter(sourceFormatForPath).length,
      unsupportedCandidates: discoveredPaths.filter(
        (sourcePath) => !sourceFormatForPath(sourcePath),
      ).length,
      registered: records.length,
      ready: extractionCount("ready"),
      unsupported: extractionCount("unsupported"),
      extractionRequired: extractionCount("extraction-required"),
      failed: extractionCount("failed"),
      samplePaths: discoveredPaths.slice(0, 20),
    },
    setup: { status: state.setup.status },
  });
}
