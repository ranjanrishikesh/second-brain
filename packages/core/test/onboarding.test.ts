import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  beginSetup,
  initBrain,
  inspectOnboarding,
  loadBrainConfig,
  recoverBrain,
  scanAndRegisterSources,
  scanSources,
  setBrainCharter,
  type BrainCharterV1,
} from "../src/index.js";
import { deterministicEmbeddings } from "./helpers/embeddings.js";

const execFile = promisify(execFileCallback);
const services = { embeddings: deterministicEmbeddings({}) };

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

const astronomyCharter: BrainCharterV1 = {
  version: 1,
  description: "Astronomy observations and orbital mechanics.",
  purpose: "Answer source-backed astronomy questions.",
  boundaries: ["Include all registered astronomy sources."],
  domainConventions: ["Preserve standard astronomical terminology."],
  evidencePreferences: ["Prefer primary sources and explicit citations."],
  origin: "inferred",
};

async function initializedGitBrain(
  repositoryName = "astronomy-brain",
): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "brain-charter-git-"));
  const root = path.join(parent, repositoryName);
  await mkdir(root);
  await initBrain(root, {
    name: "Portable Second Brain",
    description: "A self-maintaining personal knowledge base.",
  });
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Second Brain Charter Test"]);
  await git(root, ["config", "user.email", "brain-charter@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial template"]);
  await initBrain(root);
  await writeFile(
    path.join(root, "sources", "orbits.md"),
    "# Orbits\n\nBodies follow orbital paths.\n",
  );
  await scanAndRegisterSources(root);
  return root;
}

describe("managed brain charter", () => {
  test("persists a source-informed charter and configuration in one managed commit", async () => {
    const root = await initializedGitBrain();

    const result = await setBrainCharter(root, astronomyCharter);

    expect(result).toMatchObject({
      version: 1,
      charter: astronomyCharter,
      operationId: expect.stringMatching(/^op_charter_/),
      commit: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toBe(
      `---\nbrainCharter: 1\norigin: inferred\n---\n\n# Astronomy Brain\n\nAstronomy observations and orbital mechanics.\n\n## Purpose\n\nAnswer source-backed astronomy questions.\n\n## Boundaries\n\n- Include all registered astronomy sources.\n\n## Domain conventions\n\n- Preserve standard astronomical terminology.\n\n## Evidence preferences\n\n- Prefer primary sources and explicit citations.\n`,
    );
    expect((await loadBrainConfig(root)).brain.description).toBe(
      astronomyCharter.description,
    );
    expect(await inspectOnboarding(root)).toMatchObject({
      phase: "ready-for-setup",
      charter: { configured: true, origin: "inferred" },
    });
    expect(await git(root, ["show", "--format=", "--name-only", "HEAD"])).toBe(
      [
        ".brain/operations.jsonl",
        "BRAIN.md",
        "brain.config.yaml",
        "wiki/log.md",
      ].join("\n"),
    );
    expect(await git(root, ["log", "-1", "--format=%B"])).toContain(
      "Brain-Operation: op_charter_",
    );
  });

  test("rejects malformed input, template identity, and a brain without ready sources", async () => {
    const emptyRoot = await mkdtemp(
      path.join(tmpdir(), "brain-charter-empty-"),
    );
    await initBrain(emptyRoot, {
      name: "Empty",
      description: "No ready evidence yet.",
    });
    await expect(
      setBrainCharter(emptyRoot, {
        ...astronomyCharter,
        purpose: "",
      }),
    ).rejects.toThrow();
    await expect(setBrainCharter(emptyRoot, astronomyCharter)).rejects.toThrow(
      /ready source/i,
    );

    const templateRoot = await mkdtemp(
      path.join(tmpdir(), "brain-charter-template-"),
    );
    await initBrain(templateRoot, {
      name: "Portable Second Brain",
      description: "A self-maintaining personal knowledge base.",
    });
    await writeFile(
      path.join(templateRoot, "sources", "facts.md"),
      "# Facts\n\nEvidence.\n",
    );
    await scanSources(templateRoot);
    await expect(
      setBrainCharter(templateRoot, astronomyCharter),
    ).rejects.toThrow(/initialize.*identity/i);
  });

  test("treats an explicit legacy charter as configured and refuses changes after setup starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-charter-legacy-"));
    await initBrain(root, {
      name: "Legacy Astronomy",
      description: "Owner-configured astronomy evidence.",
    });
    await writeFile(
      path.join(root, "sources", "stars.md"),
      "# Stars\n\nEvidence.\n",
    );
    await scanSources(root);

    expect(await inspectOnboarding(root)).toMatchObject({
      phase: "ready-for-setup",
      charter: { configured: true, origin: "legacy" },
    });
    await beginSetup(root, { purpose: "Catalog astronomy" }, services);

    await expect(setBrainCharter(root, astronomyCharter)).rejects.toThrow(
      /setup.*already started/i,
    );
  });

  test("refuses dirty managed identity files without changing HEAD", async () => {
    const root = await initializedGitBrain("dirty-charter");
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    const beforeConfig = await readFile(
      path.join(root, "brain.config.yaml"),
      "utf8",
    );
    await writeFile(path.join(root, "BRAIN.md"), "# Local draft\n");

    await expect(setBrainCharter(root, astronomyCharter)).rejects.toThrow(
      /dirty managed files/i,
    );

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await readFile(path.join(root, "brain.config.yaml"), "utf8")).toBe(
      beforeConfig,
    );
    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toBe(
      "# Local draft\n",
    );
  });

  test("recovers an interrupted charter transaction without changing canonical state or HEAD", async () => {
    const root = await initializedGitBrain("recover-charter");
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    const beforeCharter = await readFile(path.join(root, "BRAIN.md"), "utf8");
    const beforeConfig = await readFile(
      path.join(root, "brain.config.yaml"),
      "utf8",
    );

    await expect(
      setBrainCharter(root, astronomyCharter, {
        simulateCrashAfter: "files-applied",
      }),
    ).rejects.toThrow(/simulated transaction crash/i);
    await expect(recoverBrain(root)).resolves.toBe("restored");

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toBe(
      beforeCharter,
    );
    expect(await readFile(path.join(root, "brain.config.yaml"), "utf8")).toBe(
      beforeConfig,
    );
  });
});
