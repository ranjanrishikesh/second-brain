import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { loadBrainConfig } from "./config.js";
import {
  brainCharterV1Schema,
  inspectOnboarding,
  type BrainCharterV1,
} from "./onboarding.js";
import type { SyncStatusV1 } from "./state.js";
import {
  recoverBrain,
  runCanonicalWrite,
  type OperationRecordV1,
  type TransactionTestOptions,
} from "./transaction.js";

export interface BrainCharterResultV1 {
  version: 1;
  charter: BrainCharterV1;
  operationId: string;
  commit?: string;
  sync?: SyncStatusV1;
}

function renderList(items: string[]): string {
  return items.map((item) => `- ${item.replace(/\r?\n/g, "\n  ")}`).join("\n");
}

export function renderBrainCharter(
  name: string,
  charter: BrainCharterV1,
): string {
  return `---\nbrainCharter: 1\norigin: ${charter.origin}\n---\n\n# ${name}\n\n${charter.description}\n\n## Purpose\n\n${charter.purpose}\n\n## Boundaries\n\n${renderList(charter.boundaries)}\n\n## Domain conventions\n\n${renderList(charter.domainConventions)}\n\n## Evidence preferences\n\n${renderList(charter.evidencePreferences)}\n`;
}

export async function setBrainCharter(
  root: string,
  rawCharter: BrainCharterV1,
  testOptions: TransactionTestOptions = {},
): Promise<BrainCharterResultV1> {
  const charter = brainCharterV1Schema.parse(rawCharter);
  await recoverBrain(root);
  const onboarding = await inspectOnboarding(root);
  if (onboarding.identity.template) {
    throw new Error(
      "Initialize the brain identity before setting its source-informed charter",
    );
  }
  if (onboarding.setup.status !== "not-started") {
    throw new Error("Brain setup has already started; its charter is sealed");
  }
  if (onboarding.sourceFiles.ready === 0) {
    throw new Error(
      "At least one registered ready source is required before setting the brain charter",
    );
  }

  const config = await loadBrainConfig(root);
  const nextConfig = {
    ...config,
    brain: { ...config.brain, description: charter.description },
  };
  const operationId = `op_charter_${randomUUID().replaceAll("-", "")}`;
  const transaction = await runCanonicalWrite(
    root,
    {
      operationId,
      commitMessage: `brain(charter): define ${config.brain.name} [op:${operationId}]`,
      managedRootPaths: ["BRAIN.md", "brain.config.yaml"],
      testOptions,
    },
    async (writer) => {
      const now = new Date().toISOString();
      const operation: OperationRecordV1 = {
        version: 1,
        id: operationId,
        kind: "charter",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary: `Defined the source-informed charter for ${config.brain.name}`,
        pageIds: [],
        tiersUsed: ["sources"],
      };
      await writer.writeText(
        "BRAIN.md",
        renderBrainCharter(config.brain.name, charter),
      );
      await writer.writeText("brain.config.yaml", stringify(nextConfig));
      await writer.writeText(
        ".brain/operations.jsonl",
        `${await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8")}${JSON.stringify(operation)}\n`,
      );
      const existingLog = await readFile(
        path.join(root, "wiki", "log.md"),
        "utf8",
      );
      await writer.writeText(
        "wiki/log.md",
        `${existingLog.trimEnd()}\n\n## [${now}] charter | Defined source-informed scope\n\n- Operation: \`${operationId}\`\n- Origin: \`${charter.origin}\`\n`,
      );
      return {
        value: { version: 1 as const, charter, operationId },
        stagePaths: [
          "BRAIN.md",
          "brain.config.yaml",
          ".brain/operations.jsonl",
          "wiki/log.md",
        ],
      };
    },
  );
  return {
    ...transaction.value,
    ...(transaction.commit ? { commit: transaction.commit } : {}),
    ...(transaction.sync ? { sync: transaction.sync } : {}),
  };
}
