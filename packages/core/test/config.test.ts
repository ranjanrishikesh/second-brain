import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  doctorBrain,
  initBrain,
  loadBrainConfig,
  scanSources,
} from "../src/index.js";

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

  test("reports corrupt operations, immutable source changes, and pending recovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-doctor-integrity-"));
    await initBrain(root, { name: "Doctor", description: "Integrity checks" });
    const sourcePath = path.join(root, "sources", "facts.md");
    await writeFile(sourcePath, "# Facts\n\nOriginal bytes.\n");
    await scanSources(root);
    await writeFile(sourcePath, "# Facts\n\nChanged bytes.\n");
    await writeFile(
      path.join(root, ".brain", "operations.jsonl"),
      "not-json\n",
    );
    await writeFile(
      path.join(root, ".brain", "runtime", "transaction.json"),
      "{}\n",
    );

    const report = await doctorBrain(root);

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "OPERATIONS_INVALID" }),
        expect.objectContaining({ code: "SOURCE_HASH_MISMATCH" }),
        expect.objectContaining({ code: "RECOVERY_REQUIRED" }),
      ]),
    );
  });

  test("reports a writer lock even when no recovery journal exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-doctor-lock-"));
    await initBrain(root, { name: "Doctor", description: "Writer checks" });
    await writeFile(
      path.join(root, ".brain", "runtime", "writer.lock"),
      `${JSON.stringify({
        pid: process.pid,
        operationId: "op_doctor_writer",
        recoverable: false,
      })}\n`,
    );

    const report = await doctorBrain(root);

    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "WRITER_LOCK_PRESENT",
        severity: "error",
      }),
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

  test("repairs partially written identity files on same-identity initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-repair-"));
    await initBrain(root, {
      name: "Physics",
      description: "Physical science.",
    });
    await writeFile(
      path.join(root, "BRAIN.md"),
      "# Wrong Name\n\nWrong description.\n\n## Boundaries\n\nKeep this boundary.\n",
    );
    await writeFile(
      path.join(root, "wiki", "home.md"),
      "# Wrong Name\n\nKeep this home content.\n",
    );

    await initBrain(root, {
      name: "Physics",
      description: "Physical science.",
    });

    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toBe(
      "# Physics\n\nPhysical science.\n\n## Boundaries\n\nKeep this boundary.\n",
    );
    expect(await readFile(path.join(root, "wiki", "home.md"), "utf8")).toBe(
      "# Physics\n\nKeep this home content.\n",
    );
  });
});
