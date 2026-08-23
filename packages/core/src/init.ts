import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { brainConfigV1Schema } from "./config.js";

export interface InitBrainOptions {
  name: string;
  description: string;
}

const pageDirectories = [
  "sources",
  "topics",
  "entities",
  "concepts",
  "syntheses",
  "questions",
] as const;

async function writeIfMissing(
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(filePath, content, "utf8");
  }
}

export async function initBrain(
  root: string,
  options: InitBrainOptions,
): Promise<void> {
  const config = brainConfigV1Schema.parse({
    version: 1,
    brain: {
      name: options.name,
      description: options.description,
      language: "en",
    },
  });

  await mkdir(root, { recursive: true });
  await mkdir(path.join(root, "sources"), { recursive: true });
  await mkdir(path.join(root, ".brain", "cache"), { recursive: true });
  await mkdir(path.join(root, ".brain", "runtime"), { recursive: true });
  await mkdir(path.join(root, "wiki", "reports"), { recursive: true });
  for (const directory of pageDirectories) {
    await mkdir(path.join(root, "wiki", "pages", directory), {
      recursive: true,
    });
  }

  await writeIfMissing(path.join(root, "brain.config.yaml"), stringify(config));
  await writeIfMissing(
    path.join(root, "BRAIN.md"),
    `# ${config.brain.name}\n\n${config.brain.description}\n\n## Boundaries\n\nDocument what belongs in this brain and what does not.\n`,
  );
  await writeIfMissing(
    path.join(root, ".brain", "source-manifest.json"),
    `${JSON.stringify({ version: 1, sources: [] }, null, 2)}\n`,
  );
  await writeIfMissing(
    path.join(root, ".brain", "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        catalogRevision: "empty",
        knowledgeMutations: 0,
        lastSemanticAuditMutation: 0,
        bootstrap: { status: "pending", pendingSourceIds: [] },
      },
      null,
      2,
    )}\n`,
  );
  await writeIfMissing(path.join(root, ".brain", "operations.jsonl"), "");
  await writeIfMissing(
    path.join(root, "wiki", "home.md"),
    `# ${config.brain.name}\n`,
  );
  await writeIfMissing(path.join(root, "wiki", "index.md"), "# Wiki Index\n");
  await writeIfMissing(path.join(root, "wiki", "map.md"), "# Knowledge Map\n");
  await writeIfMissing(path.join(root, "wiki", "log.md"), "# Brain Log\n");
  await writeIfMissing(
    path.join(root, "wiki", "reports", "health.md"),
    "# Brain Health\n",
  );
}
