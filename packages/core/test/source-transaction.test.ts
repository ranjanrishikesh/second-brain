import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  initBrain,
  recoverBrain,
  scanAndRegisterSources,
  supersedeRegisteredSource,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

describe("registered source transactions", () => {
  test("shares the canonical writer lock with wiki mutations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-source-lock-"));
    await initBrain(root, { name: "Sources", description: "Lock test" });
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "Second Brain Test"]);
    await git(root, ["config", "user.email", "brain-test@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial brain"]);
    await writeFile(path.join(root, "sources", "facts.md"), "# Facts\n");
    await writeFile(
      path.join(root, ".brain", "runtime", "writer.lock"),
      "busy\n",
    );

    await expect(scanAndRegisterSources(root)).rejects.toThrow(/exist|lock/i);
  });

  test("recovers a source registration interrupted after canonical files change", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-source-recover-"));
    await initBrain(root, { name: "Sources", description: "Recovery test" });
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "Second Brain Test"]);
    await git(root, ["config", "user.email", "brain-test@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial brain"]);
    const manifestPath = path.join(root, ".brain", "source-manifest.json");
    const before = await readFile(manifestPath, "utf8");
    const sourcePath = path.join(root, "sources", "facts.md");
    await writeFile(sourcePath, "# Facts\n\nRecover me.\n");

    await expect(
      scanAndRegisterSources(root, { simulateCrashAfter: "files-applied" }),
    ).rejects.toThrow("Simulated transaction crash");
    expect(await readFile(manifestPath, "utf8")).not.toBe(before);

    await expect(recoverBrain(root)).resolves.toBe("restored");
    expect(await readFile(manifestPath, "utf8")).toBe(before);
    expect(await readFile(sourcePath, "utf8")).toContain("Recover me");
    await expect(scanAndRegisterSources(root)).resolves.toMatchObject({
      added: [{ path: "sources/facts.md" }],
    });
  });

  test("rejects bytes changed after scanning before source staging", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-source-stable-"));
    await initBrain(root, { name: "Sources", description: "Stability test" });
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "Second Brain Test"]);
    await git(root, ["config", "user.email", "brain-test@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial brain"]);
    const sourcePath = path.join(root, "sources", "facts.md");
    const manifestPath = path.join(root, ".brain", "source-manifest.json");
    const beforeManifest = await readFile(manifestPath, "utf8");
    await writeFile(sourcePath, "# Facts\n\nOriginal source bytes.\n");

    await expect(
      scanAndRegisterSources(root, {
        beforeStage: async () => {
          await writeFile(sourcePath, "# Facts\n\nChanged source bytes.\n");
        },
      }),
    ).rejects.toThrow(/source.*changed|staged.*source/i);

    expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
    expect(await readFile(sourcePath, "utf8")).toContain(
      "Changed source bytes.",
    );
    expect(
      await git(root, ["status", "--short", "--", "sources/facts.md"]),
    ).toBe("?? sources/facts.md");
  });

  test("registers a source larger than Git exec buffering without loading its staged bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-source-large-"));
    await initBrain(root, { name: "Sources", description: "Large source" });
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "Second Brain Test"]);
    await git(root, ["config", "user.email", "brain-test@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial brain"]);

    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
    await writeFile(path.join(root, "sources", "large.txt"), bytes);

    const result = await scanAndRegisterSources(root);

    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.bytes).toBe(bytes.byteLength);
    expect(
      await git(root, ["status", "--short", "--", "sources/large.txt"]),
    ).toBe("");
  });

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
