import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  initBrain,
  scanAndRegisterSources,
  supersedeRegisteredSource,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

describe("registered source transactions", () => {
  test("commits explicit supersession while retaining both immutable versions", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-source-transaction-"),
    );
    await initBrain(root, {
      name: "Sources",
      description: "Source transactions",
    });
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "Second Brain Test"]);
    await git(root, ["config", "user.email", "brain-test@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial brain"]);
    await writeFile(
      path.join(root, "sources", "facts-v1.md"),
      "# Facts\n\nOne moon.\n",
    );
    await writeFile(
      path.join(root, "sources", "facts-v2.md"),
      "# Facts\n\nTwo moons.\n",
    );
    const scan = await scanAndRegisterSources(root);
    const previous = scan.added.find((source) => source.path.endsWith("v1.md"));
    const replacement = scan.added.find((source) =>
      source.path.endsWith("v2.md"),
    );
    if (!previous || !replacement) throw new Error("Expected source versions");

    const result = await supersedeRegisteredSource(
      root,
      previous.id,
      replacement.id,
    );

    expect(result.source.supersedes).toBe(previous.id);
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(root, ["log", "-1", "--pretty=%s"])).toContain(
      "supersede",
    );
    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    );
    expect(manifest.sources).toHaveLength(2);
    expect(
      await git(root, [
        "status",
        "--short",
        "--",
        "sources",
        ".brain",
        "wiki/log.md",
      ]),
    ).toBe("");
  });
});
