import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { brainConfigV1Schema, type BrainConfigV1 } from "./config.js";
import {
  suggestBrainName,
  TEMPLATE_BRAIN_DESCRIPTION,
  TEMPLATE_BRAIN_NAME,
} from "./onboarding.js";
import { defaultBrainState, type SyncStatusV1 } from "./state.js";
import {
  runCanonicalWrite,
  type OperationRecordV1,
  type TransactionTestOptions,
} from "./transaction.js";

const execFile = promisify(execFileCallback);

export interface InitBrainOptions {
  name?: string;
  description?: string;
}

export interface InitBrainResultV1 {
  version: 1;
  mode: "template-replaced" | "repaired" | "existing";
  name: string;
  description: string;
  operationId?: string;
  commit?: string;
  sync?: SyncStatusV1;
}

const pageDirectories = [
  "sources",
  "topics",
  "entities",
  "concepts",
  "syntheses",
  "questions",
] as const;

const pageKeepPaths = pageDirectories.map(
  (directory) => `wiki/pages/${directory}/.gitkeep`,
);

const initialScaffoldStagePaths = [
  "BRAIN.md",
  "brain.config.yaml",
  "wiki/home.md",
  "wiki/index.md",
  "wiki/map.md",
  "wiki/log.md",
  "wiki/reports/health.md",
  ".brain/source-manifest.json",
  ".brain/state.json",
  ".brain/operations.jsonl",
  "sources/.gitkeep",
  ...pageKeepPaths,
] as const;

const templateCharter = `# ${TEMPLATE_BRAIN_NAME}

${TEMPLATE_BRAIN_DESCRIPTION}

## Purpose

Replace this section after cloning with the one primary domain, questions, and outcomes this brain should support.

## Boundaries

Document what belongs in this primary scope and what should remain outside it unless the owner approves an exact one-time exception.

## Domain conventions

Add domain-specific terminology, entity types, relationship types, and evidence preferences here.
`;

function renderLegacyCharter(identity: {
  name: string;
  description: string;
}): string {
  return `# ${identity.name}

${identity.description}

## Purpose

${identity.description}

## Boundaries

Include source material relevant to ${identity.name}.
`;
}

async function readOrDefault(
  filePath: string,
  defaultContent: string,
): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return defaultContent;
  }
}

async function assertNoStagedOwnerWork(root: string): Promise<void> {
  try {
    await execFile("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
    });
  } catch {
    return;
  }
  try {
    await execFile("git", ["diff", "--cached", "--quiet", "--exit-code"], {
      cwd: root,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 1) {
      throw new Error(
        "Refusing brain initialization while Git has staged changes",
      );
    }
    throw error;
  }
}

async function isUnbornGitRepository(root: string): Promise<boolean> {
  try {
    await execFile("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
    });
  } catch {
    return false;
  }
  try {
    await execFile("git", ["rev-parse", "--verify", "HEAD"], { cwd: root });
    return false;
  } catch (error) {
    if ((error as { code?: number }).code === 128) return true;
    throw error;
  }
}

async function missingPaths(
  root: string,
  relativePaths: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const relativePath of relativePaths) {
    try {
      await access(path.join(root, relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(relativePath);
    }
  }
  return missing;
}

async function pristineTemplateState(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    ) as { sources?: unknown[] };
    if ((manifest.sources ?? []).length > 0) return false;
    const operations = (
      await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8")
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind?: unknown });
    if (operations.some((operation) => operation.kind !== "identity")) {
      return false;
    }
    for (const directory of pageDirectories) {
      try {
        if (
          (await readdir(path.join(root, "wiki", "pages", directory))).some(
            (entry) => entry.endsWith(".md"),
          )
        ) {
          return false;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function updateCharterIdentity(
  content: string,
  name: string,
  description: string,
): string {
  if (content.startsWith("---\n")) {
    const closingMarker = content.indexOf("\n---\n", 4);
    if (closingMarker >= 0) {
      const metadata = parse(content.slice(4, closingMarker)) as Record<
        string,
        unknown
      >;
      if (
        metadata.brainCharter === 1 &&
        (metadata.origin === "inferred" ||
          metadata.origin === "owner-specified")
      ) {
        return content;
      }
    }
  }
  const lines = content.trimEnd().split("\n");
  lines[0] = `# ${name}`;
  const descriptionIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() && !line.startsWith("## "),
  );
  if (descriptionIndex >= 0) lines[descriptionIndex] = description;
  else lines.splice(1, 0, "", description);
  return `${lines.join("\n")}\n`;
}

function updateHomeIdentity(content: string, name: string): string {
  const lines = content.trimEnd().split("\n");
  lines[0] = `# ${name}`;
  return `${lines.join("\n")}\n`;
}

function scaffoldDefaults(): Map<string, string> {
  const scaffoldIdentity = {
    name: TEMPLATE_BRAIN_NAME,
    description: TEMPLATE_BRAIN_DESCRIPTION,
  };
  const templateConfig = brainConfigV1Schema.parse({
    version: 1,
    brain: {
      ...scaffoldIdentity,
      language: "en",
    },
  });
  return new Map([
    ["brain.config.yaml", stringify(templateConfig)],
    ["BRAIN.md", templateCharter],
    [
      ".brain/source-manifest.json",
      `${JSON.stringify({ version: 1, sources: [] }, null, 2)}\n`,
    ],
    [".brain/state.json", `${JSON.stringify(defaultBrainState(), null, 2)}\n`],
    [".brain/operations.jsonl", ""],
    ["wiki/home.md", `# ${scaffoldIdentity.name}\n`],
    ["wiki/index.md", "# Wiki Index\n"],
    ["wiki/map.md", "# Knowledge Map\n"],
    ["wiki/log.md", "# Brain Log\n"],
    ["wiki/reports/health.md", "# Brain Health\n"],
    ["sources/.gitkeep", ""],
    ...pageKeepPaths.map((relativePath) => [relativePath, ""] as const),
  ]);
}

function requestedIdentity(
  options: InitBrainOptions | undefined,
  suggestedName: string,
): { name: string; description: string } {
  const name =
    options?.name === undefined
      ? suggestedName
      : z.string().trim().min(1).parse(options.name);
  const description =
    options?.description === undefined
      ? `A source-backed knowledge brain for ${name}.`
      : z.string().trim().min(1).parse(options.description);
  return { name, description };
}

function identityConfig(
  existing: BrainConfigV1,
  identity: { name: string; description: string },
): BrainConfigV1 {
  return brainConfigV1Schema.parse({
    ...existing,
    brain: { ...existing.brain, ...identity },
  });
}

export async function initBrain(
  root: string,
  options?: InitBrainOptions,
  testOptions: TransactionTestOptions = {},
): Promise<InitBrainResultV1> {
  await mkdir(root, { recursive: true });
  let hadConfiguration = true;
  let configuredIdentity: BrainConfigV1 | undefined;
  try {
    configuredIdentity = brainConfigV1Schema.parse(
      parse(await readFile(path.join(root, "brain.config.yaml"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hadConfiguration = false;
  }
  const suggestedName =
    options?.name === undefined ? await suggestBrainName(root) : options.name;
  const identity =
    options === undefined &&
    configuredIdentity &&
    (configuredIdentity.brain.name !== TEMPLATE_BRAIN_NAME ||
      configuredIdentity.brain.description !== TEMPLATE_BRAIN_DESCRIPTION)
      ? {
          name: configuredIdentity.brain.name,
          description: configuredIdentity.brain.description,
        }
      : requestedIdentity(options, suggestedName);
  if (!hadConfiguration) await assertNoStagedOwnerWork(root);
  const adoptExistingUnbornScaffold =
    hadConfiguration &&
    configuredIdentity?.brain.name === TEMPLATE_BRAIN_NAME &&
    configuredIdentity.brain.description === TEMPLATE_BRAIN_DESCRIPTION &&
    (await pristineTemplateState(root)) &&
    (await isUnbornGitRepository(root));
  const missingScaffoldPaths = await missingPaths(
    root,
    initialScaffoldStagePaths,
  );
  const scaffoldPathsToWrite =
    !hadConfiguration || adoptExistingUnbornScaffold
      ? [...initialScaffoldStagePaths]
      : missingScaffoldPaths;
  const adoptableScaffoldPaths = adoptExistingUnbornScaffold
    ? [...initialScaffoldStagePaths]
    : missingScaffoldPaths;
  const defaults = scaffoldDefaults();
  const scaffoldContents = new Map<string, string>();
  for (const relativePath of initialScaffoldStagePaths) {
    const defaultContent = defaults.get(relativePath);
    if (defaultContent === undefined) {
      throw new Error(`Missing scaffold default: ${relativePath}`);
    }
    scaffoldContents.set(
      relativePath,
      await readOrDefault(path.join(root, relativePath), defaultContent),
    );
  }
  const existing =
    configuredIdentity ??
    brainConfigV1Schema.parse(
      parse(scaffoldContents.get("brain.config.yaml") ?? ""),
    );
  const targetConfig = identityConfig(existing, identity);
  const sameIdentity =
    existing.brain.name === identity.name &&
    existing.brain.description === identity.description;
  let mode: InitBrainResultV1["mode"];
  if (sameIdentity) {
    mode = hadConfiguration ? "repaired" : "template-replaced";
  } else if (
    existing.brain.name === TEMPLATE_BRAIN_NAME &&
    existing.brain.description === TEMPLATE_BRAIN_DESCRIPTION &&
    (await pristineTemplateState(root))
  ) {
    mode = "template-replaced";
  } else {
    throw new Error(
      `Brain is already initialized as ${existing.brain.name}; use the managed charter workflow to change its scope`,
    );
  }

  const currentCharter = scaffoldContents.get("BRAIN.md") ?? "";
  const currentHome = scaffoldContents.get("wiki/home.md") ?? "";
  const identityCharter = updateCharterIdentity(
    currentCharter,
    identity.name,
    identity.description,
  );
  const explicitLegacyCharter =
    options?.name !== undefined &&
    options.description !== undefined &&
    (identity.name !== TEMPLATE_BRAIN_NAME ||
      identity.description !== TEMPLATE_BRAIN_DESCRIPTION);
  const nextCharter =
    explicitLegacyCharter &&
    (/replace\s+this\s+section\s+after\s+cloning/i.test(identityCharter) ||
      /document\s+what\s+belongs\s+in\s+this\s+brain/i.test(identityCharter))
      ? renderLegacyCharter(identity)
      : identityCharter;
  const nextHome = updateHomeIdentity(currentHome, identity.name);
  if (
    scaffoldPathsToWrite.length === 0 &&
    sameIdentity &&
    nextCharter === currentCharter &&
    nextHome === currentHome
  ) {
    return {
      version: 1,
      mode: hadConfiguration ? "existing" : "template-replaced",
      ...identity,
    };
  }

  const operationId = `op_identity_${randomUUID().replaceAll("-", "")}`;
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId,
      commitMessage: `brain(identity): initialize ${identity.name} [op:${operationId}]`,
      managedRootPaths: ["BRAIN.md", "brain.config.yaml"],
      managedFilePaths: scaffoldPathsToWrite.includes("sources/.gitkeep")
        ? ["sources/.gitkeep"]
        : [],
      allowUntrackedPaths: adoptableScaffoldPaths,
      testOptions,
    },
    async (writer) => {
      const now = new Date().toISOString();
      const operation: OperationRecordV1 = {
        version: 1,
        id: operationId,
        kind: "identity",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary: `Initialized brain identity as ${identity.name}`,
        pageIds: [],
        tiersUsed: [],
      };
      const finalContents = new Map(scaffoldContents);
      finalContents.set("BRAIN.md", nextCharter);
      finalContents.set("brain.config.yaml", stringify(targetConfig));
      finalContents.set("wiki/home.md", nextHome);
      finalContents.set(
        ".brain/operations.jsonl",
        `${scaffoldContents.get(".brain/operations.jsonl") ?? ""}${JSON.stringify(operation)}\n`,
      );
      finalContents.set(
        "wiki/log.md",
        `${(scaffoldContents.get("wiki/log.md") ?? "# Brain Log\n").trimEnd()}\n\n## [${now}] identity | Initialized ${identity.name}\n\n- Operation: \`${operationId}\`\n`,
      );
      const stagePaths = [
        ...new Set([
          "BRAIN.md",
          "brain.config.yaml",
          "wiki/home.md",
          "wiki/log.md",
          ".brain/operations.jsonl",
          ...scaffoldPathsToWrite,
        ]),
      ];
      for (const relativePath of stagePaths) {
        const content = finalContents.get(relativePath);
        if (content === undefined) {
          throw new Error(`Missing final scaffold content: ${relativePath}`);
        }
        await writer.writeText(relativePath, content);
      }
      return {
        value: { version: 1 as const, mode, ...identity, operationId },
        stagePaths,
      };
    },
  );
  return {
    ...transaction.value,
    ...(transaction.commit ? { commit: transaction.commit } : {}),
    ...(transaction.sync ? { sync: transaction.sync } : {}),
  };
}
