import { execFile as execFileCallback } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { loadBrainConfig } from "./config.js";
import { readBrainState } from "./state.js";
import { sourceFormatForPath } from "./sources/format.js";
import { sourceRecordV1Schema, type SourceRecordV1 } from "./sources/types.js";

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
  const registeredPaths = new Set([
    ...records.map((record) => record.path),
    ...state.sourceDuplicates
      .filter((duplicate) => registeredSourceIds.has(duplicate.sourceId))
      .map((duplicate) => duplicate.path),
  ]);
  const phase = phaseAndAction({
    template,
    setupStatus: state.setup.status,
    discoveredPaths,
    registeredPaths,
    ready: extractionCount("ready"),
    charterConfigured: charter.configured,
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
