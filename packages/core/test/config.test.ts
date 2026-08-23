import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { doctorBrain, initBrain, loadBrainConfig } from "../src/index.js";

describe("loadBrainConfig", () => {
  test("loads a valid version 1 configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-config-"));
    await writeFile(
      path.join(root, "brain.config.yaml"),
      [
        "version: 1",
        "brain:",
        "  name: Astronomy",
        "  description: A personal astronomy brain",
        "",
      ].join("\n"),
    );

    const config = await loadBrainConfig(root);

    expect(config.version).toBe(1);
    expect(config.brain.name).toBe("Astronomy");
    expect(config.bootstrap.mode).toBe("catalog-map");
  });
});

describe("doctorBrain", () => {
  test("reports a missing configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-doctor-"));

    const report = await doctorBrain(root);

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "CONFIG_MISSING", severity: "error" }),
    );
  });
});

describe("initBrain", () => {
  test("creates the canonical brain layout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-"));

    await initBrain(root, {
      name: "Physics",
      description: "A simple physics brain",
    });

    const config = await loadBrainConfig(root);
    expect(config.brain.name).toBe("Physics");
    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toContain(
      "# Physics",
    );
    await expect(
      access(path.join(root, ".brain", "source-manifest.json")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(root, "wiki", "pages", "concepts")),
    ).resolves.toBeUndefined();
  });
});
