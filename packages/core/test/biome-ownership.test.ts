import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const biomeExecutable = path.join(
  repositoryRoot,
  "node_modules",
  ".bin",
  "biome",
);

async function runBiome(root: string): Promise<{
  exitCode: number;
  output: string;
}> {
  try {
    const result = await execFile(biomeExecutable, ["format", "."], {
      cwd: root,
    });
    return { exitCode: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describe("Biome ownership boundary", () => {
  test("ignores brain-owned and Git-ignored files while checking software files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-biome-ownership-"));
    await writeFile(
      path.join(root, "biome.json"),
      await readFile(path.join(repositoryRoot, "biome.json"), "utf8"),
    );
    await writeFile(path.join(root, ".gitignore"), "ignored-workspace/\n");
    await execFile("git", ["init", "--quiet"], { cwd: root });

    for (const relativePath of [
      ".brain/state.json",
      "sources/raw.json",
      "wiki/generated.json",
      "ignored-workspace/scratch.json",
    ]) {
      const absolutePath = path.join(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, '{"items":["one"]}\n');
    }
    await writeFile(path.join(root, "BRAIN.md"), "#Brain\n");
    await writeFile(path.join(root, "brain.config.yaml"), "brain:{name:x}\n");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "owned.json"), "{}\n");

    const ignoredResult = await runBiome(root);
    expect(ignoredResult).toMatchObject({ exitCode: 0 });

    await writeFile(
      path.join(root, "src", "owned.json"),
      '{"items":["one"]}\n',
    );
    const ownedResult = await runBiome(root);
    expect(ownedResult.exitCode).not.toBe(0);
    expect(ownedResult.output).toContain("src/owned.json");
  });
});
