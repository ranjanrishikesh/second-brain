import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("Conductor repository settings", () => {
  it("exposes only repository-local maintenance commands", async () => {
    const settings = await readFile(
      resolve(repositoryRoot, ".conductor/settings.toml"),
      "utf8",
    );

    expect(settings).toContain(
      '"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"',
    );
    expect(settings).toContain('setup = "pnpm install --frozen-lockfile"');
    expect(settings).toContain('run_mode = "concurrent"');
    expect(settings).toContain("pnpm test:watch");
    expect(settings).toContain("pnpm verify");
    expect(settings).toContain("pnpm brain doctor");
    expect(settings.match(/\[scripts\.run\.[^\]]+\]/g)).toEqual([
      "[scripts.run.test-watch]",
      "[scripts.run.verify]",
      "[scripts.run.doctor]",
    ]);
  });

  it("does not retain legacy conductor.json", async () => {
    await expect(
      access(resolve(repositoryRoot, "conductor.json")),
    ).rejects.toThrow();
  });
});
