import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
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
    await atomicWrite(filePath, content);
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function pristineTemplateState(root: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    ) as { sources?: unknown[] };
    if ((manifest.sources ?? []).length > 0) return false;
    if (
      (
        await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8")
      ).trim().length > 0
    ) {
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
  let identityMode: "new" | "replace-template" | "existing" = "new";
  try {
    const existing = brainConfigV1Schema.parse(
      parse(await readFile(path.join(root, "brain.config.yaml"), "utf8")),
    );
    if (
      existing.brain.name === config.brain.name &&
      existing.brain.description === config.brain.description
    ) {
      identityMode = "existing";
    } else if (
      existing.brain.name === "Portable Second Brain" &&
      existing.brain.description ===
        "A self-maintaining personal knowledge base." &&
      (await pristineTemplateState(root))
    ) {
      identityMode = "replace-template";
    } else {
      throw new Error(
        `Brain is already initialized as ${existing.brain.name}; edit BRAIN.md and brain.config.yaml deliberately to rename it`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(path.join(root, "sources"), { recursive: true });
  await mkdir(path.join(root, ".brain", "cache"), { recursive: true });
  await mkdir(path.join(root, ".brain", "runtime"), { recursive: true });
  await mkdir(path.join(root, "wiki", "reports"), { recursive: true });
  for (const directory of pageDirectories) {
    await mkdir(path.join(root, "wiki", "pages", directory), {
      recursive: true,
    });
  }

  if (identityMode === "new") {
    await writeIfMissing(
      path.join(root, "brain.config.yaml"),
      stringify(config),
    );
    await writeIfMissing(
      path.join(root, "BRAIN.md"),
      `# ${config.brain.name}\n\n${config.brain.description}\n\n## Boundaries\n\nDocument what belongs in this brain and what does not.\n`,
    );
  } else if (identityMode === "replace-template") {
    await atomicWrite(path.join(root, "brain.config.yaml"), stringify(config));
  }
  if (identityMode !== "new") {
    let charter: string;
    try {
      charter = await readFile(path.join(root, "BRAIN.md"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      charter =
        "# Portable Second Brain\n\nA self-maintaining personal knowledge base.\n";
    }
    await atomicWrite(
      path.join(root, "BRAIN.md"),
      updateCharterIdentity(
        charter,
        config.brain.name,
        config.brain.description,
      ),
    );
    const homePath = path.join(root, "wiki", "home.md");
    let home = `# ${config.brain.name}\n`;
    try {
      home = await readFile(homePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWrite(homePath, updateHomeIdentity(home, config.brain.name));
  }
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
