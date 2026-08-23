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

  test("names a pristine cloned template without replacing its charter sections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-template-init-"));
    await initBrain(root, {
      name: "Portable Second Brain",
      description: "A self-maintaining personal knowledge base.",
    });
    await writeFile(
      path.join(root, "BRAIN.md"),
      "# Portable Second Brain\n\nA self-maintaining personal knowledge base.\n\n## Purpose\n\nKeep this section.\n",
    );

    await initBrain(root, {
      name: "Astronomy",
      description: "Stars, planets, and observational evidence.",
    });

    expect((await loadBrainConfig(root)).brain).toMatchObject({
      name: "Astronomy",
      description: "Stars, planets, and observational evidence.",
    });
    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toBe(
      "# Astronomy\n\nStars, planets, and observational evidence.\n\n## Purpose\n\nKeep this section.\n",
    );
  });

  test("is idempotent but refuses to rename a populated brain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-repeat-init-"));
    await initBrain(root, {
      name: "Physics",
      description: "Physical science.",
    });
    await writeFile(
      path.join(root, "BRAIN.md"),
      "# Physics\n\nPhysical science.\n\n## Boundaries\n\nCustom boundary.\n",
    );

    await initBrain(root, {
      name: "Physics",
      description: "Physical science.",
    });
    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toContain(
      "Custom boundary.",
    );
    await expect(
      initBrain(root, { name: "Fiction", description: "Books." }),
    ).rejects.toThrow(/already initialized as Physics/i);
  });
});
