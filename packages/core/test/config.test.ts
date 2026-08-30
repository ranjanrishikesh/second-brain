import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  doctorBrain,
  initBrain,
  loadBrainConfig,
  recoverBrain,
  scanSources,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function templateGitRepository(
  repositoryName = "second-brain-smoke",
): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "brain-init-git-"));
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
  await git(root, ["config", "user.name", "Second Brain Init Test"]);
  await git(root, ["config", "user.email", "brain-init@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial template"]);
  return root;
}

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
    expect(config.support).toEqual({
      issueTrackerUrl:
        "https://github.com/ranjanrishikesh/second-brain/issues",
    });
    expect(config.bootstrap.mode).toBe("catalog-map");
    expect(config).toMatchObject({
      web: { approvalTtlHours: 24 },
      graph: {
        semanticModel: {
          id: "Xenova/multilingual-e5-small",
          revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
        },
      },
      git: { autoPush: false },
    });
  });

  test("accepts only an absolute HTTPS issue tracker URL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-support-config-"));
    await writeFile(
      path.join(root, "brain.config.yaml"),
      [
        "version: 1",
        "brain:",
        "  name: Support test",
        "support:",
        "  issueTrackerUrl: http://example.test/issues",
        "",
      ].join("\n"),
    );

    await expect(loadBrainConfig(root)).rejects.toThrow(
      "support.issueTrackerUrl must be an absolute HTTPS URL",
    );

    await writeFile(
      path.join(root, "brain.config.yaml"),
      [
        "version: 1",
        "brain:",
        "  name: Support test",
        "support:",
        "  issueTrackerUrl: https://example.test/brain/issues",
        "",
      ].join("\n"),
    );

    await expect(loadBrainConfig(root)).resolves.toMatchObject({
      support: { issueTrackerUrl: "https://example.test/brain/issues" },
    });
  });
});

describe("doctorBrain", () => {
  test("reports incomplete template onboarding as non-fatal warnings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-doctor-template-"));
    await initBrain(root, {
      name: "Portable Second Brain",
      description: "A self-maintaining personal knowledge base.",
    });

    const report = await doctorBrain(root);

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual(
      expect.arrayContaining(
        [
          "IDENTITY_TEMPLATE",
          "SOURCES_EMPTY",
          "CHARTER_PENDING",
          "SETUP_INCOMPLETE",
        ].map((code) => expect.objectContaining({ code, severity: "warning" })),
      ),
    );
  });

  test("distinguishes unregistered and registered-but-unusable sources", async () => {
    const unregisteredRoot = await mkdtemp(
      path.join(tmpdir(), "brain-doctor-unregistered-"),
    );
    await initBrain(unregisteredRoot, {
      name: "Unregistered",
      description: "Unregistered evidence",
    });
    await writeFile(
      path.join(unregisteredRoot, "sources", "facts.md"),
      "# Facts\n\nEvidence.\n",
    );
    expect((await doctorBrain(unregisteredRoot)).issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCES_UNREGISTERED",
        severity: "warning",
      }),
    );

    const blockedRoot = await mkdtemp(
      path.join(tmpdir(), "brain-doctor-blocked-"),
    );
    await initBrain(blockedRoot, {
      name: "Blocked",
      description: "Blocked evidence",
    });
    await writeFile(path.join(blockedRoot, "sources", "image.png"), "pixels");
    await scanSources(blockedRoot);
    const blocked = await doctorBrain(blockedRoot);

    expect(blocked.ok).toBe(true);
    expect(blocked.issues).toContainEqual(
      expect.objectContaining({
        code: "SOURCES_NOT_READY",
        severity: "warning",
      }),
    );
  });

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
  test("derives identity from the repository and creates a managed commit", async () => {
    const root = await templateGitRepository();

    const result = await initBrain(root);

    expect(result).toMatchObject({
      mode: "template-replaced",
      name: "Second Brain Smoke",
      description: "A source-backed knowledge brain for Second Brain Smoke.",
    });
    expect(await git(root, ["log", "-1", "--format=%B"])).toContain(
      "Brain-Managed: true",
    );
    expect(await git(root, ["log", "-1", "--format=%B"])).toContain(
      "Brain-Operation: op_identity_",
    );
    expect(
      await git(root, ["show", "--format=", "--name-only", "HEAD"]),
    ).toContain("BRAIN.md");
    expect(
      (await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toContainEqual(expect.objectContaining({ kind: "identity" }));
  });

  test("uses the Git common-directory name for a linked worktree", async () => {
    const repository = await templateGitRepository("orbital-knowledge");
    const worktreeParent = await mkdtemp(
      path.join(tmpdir(), "brain-init-worktree-"),
    );
    const worktree = path.join(worktreeParent, "kyiv");
    await git(repository, ["worktree", "add", "-b", "smoke", worktree]);

    const result = await initBrain(worktree);

    expect(result).toMatchObject({
      name: "Orbital Knowledge",
      description: "A source-backed knowledge brain for Orbital Knowledge.",
    });
  });

  test("falls back to the directory name outside Git", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "brain-init-local-"));
    const root = path.join(parent, "simple-physics");
    await mkdir(root);

    const result = await initBrain(root);

    expect(result).toMatchObject({
      name: "Simple Physics",
      description: "A source-backed knowledge brain for Simple Physics.",
    });
    expect((await loadBrainConfig(root)).brain.name).toBe("Simple Physics");
  });

  test("routes explicit non-Git initialization through the managed operation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-non-git-"));

    const result = await initBrain(root, {
      name: "Local Physics",
      description: "A local source-backed physics brain.",
    });

    expect(result).toMatchObject({
      mode: "template-replaced",
      operationId: expect.stringMatching(/^op_identity_/),
    });
    expect(result).not.toHaveProperty("commit");
    expect(
      (await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toContainEqual(expect.objectContaining({ kind: "identity" }));
  });

  test("creates the first managed identity commit in an unborn Git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-unborn-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain Init Test"]);
    await git(root, ["config", "user.email", "brain-init@example.invalid"]);

    const result = await initBrain(root, {
      name: "New Astronomy",
      description: "A new source-backed astronomy brain.",
    });

    expect(result).toMatchObject({
      mode: "template-replaced",
      operationId: expect.stringMatching(/^op_identity_/),
      commit: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(await git(root, ["log", "-1", "--format=%B"])).toContain(
      "Brain-Managed: true",
    );
    expect(await git(root, ["status", "--short"])).toBe("");
  });

  test("preserves the complete required layout when the first commit is cloned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-first-clone-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain Init Test"]);
    await git(root, ["config", "user.email", "brain-init@example.invalid"]);
    await initBrain(root, {
      name: "Cloneable Astronomy",
      description: "A cloneable source-backed astronomy brain.",
    });
    const cloneParent = await mkdtemp(
      path.join(tmpdir(), "brain-init-first-clone-copy-"),
    );
    const clone = path.join(cloneParent, "cloneable-astronomy");

    await execFile("git", ["clone", "--quiet", root, clone]);

    expect(await doctorBrain(clone)).toMatchObject({
      ok: true,
      issues: expect.not.arrayContaining([
        expect.objectContaining({ code: "LAYOUT_MISSING" }),
      ]),
    });
    expect(
      await git(root, [
        "ls-tree",
        "-r",
        "--name-only",
        "HEAD",
        "--",
        "sources",
        "wiki/pages",
      ]),
    ).toContain("sources/.gitkeep");
  });

  test("creates the first managed identity commit in an unborn SHA-256 Git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-sha256-"));
    await git(root, ["init", "--object-format=sha256", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain Init Test"]);
    await git(root, ["config", "user.email", "brain-init@example.invalid"]);

    const result = await initBrain(root, {
      name: "SHA-256 Astronomy",
      description: "A source-backed astronomy brain in SHA-256 Git.",
    });

    expect(result).toMatchObject({
      mode: "template-replaced",
      operationId: expect.stringMatching(/^op_identity_/),
      commit: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await git(root, ["rev-parse", "HEAD"])).toHaveLength(64);
    expect(await git(root, ["status", "--short"])).toBe("");
  });

  test("adds a managed identity commit to an existing uninitialized repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-existing-git-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain Init Test"]);
    await git(root, ["config", "user.email", "brain-init@example.invalid"]);
    await writeFile(path.join(root, "README.md"), "Owner repository.\n");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "owner: initial repository"]);
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);

    const result = await initBrain(root, {
      name: "Existing Repository Brain",
      description: "Knowledge in an existing repository.",
    });

    expect(result).toMatchObject({
      operationId: expect.stringMatching(/^op_identity_/),
      commit: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe(
      "Owner repository.\n",
    );
    expect(await git(root, ["rev-parse", "HEAD^1"])).toBe(beforeHead);
    expect(await git(root, ["status", "--short"])).toBe("");
  });

  test("refuses staged owner work before scaffolding an uninitialized Git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-staged-new-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain Init Test"]);
    await git(root, ["config", "user.email", "brain-init@example.invalid"]);
    await writeFile(path.join(root, "owner-notes.md"), "Keep staged work.\n");
    await git(root, ["add", "owner-notes.md"]);

    await expect(
      initBrain(root, {
        name: "Unsafe Initialization",
        description: "This must not be written.",
      }),
    ).rejects.toThrow(/staged changes/i);

    await expect(
      access(path.join(root, "brain.config.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(root, ["status", "--short", "--", "owner-notes.md"])).toBe(
      "A  owner-notes.md",
    );
  });

  test("refuses owner-created managed files before writing any first scaffold", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-owner-file-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain Init Test"]);
    await git(root, ["config", "user.email", "brain-init@example.invalid"]);
    const ownerCharter = "# Owner notes\n\nDo not overwrite this file.\n";
    await writeFile(path.join(root, "BRAIN.md"), ownerCharter);

    await expect(
      initBrain(root, {
        name: "Unsafe Initialization",
        description: "This must not be written.",
      }),
    ).rejects.toThrow(/dirty managed files/i);

    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toBe(
      ownerCharter,
    );
    for (const generatedPath of [
      "brain.config.yaml",
      "sources",
      "wiki",
      ".brain/source-manifest.json",
      ".brain/state.json",
      ".brain/operations.jsonl",
    ]) {
      await expect(
        access(path.join(root, generatedPath)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("recovers an interrupted explicit initialization before the first Git commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-unborn-crash-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain Init Test"]);
    await git(root, ["config", "user.email", "brain-init@example.invalid"]);

    await expect(
      initBrain(
        root,
        {
          name: "Recoverable New Brain",
          description: "A recoverable first initialization.",
        },
        { simulateCrashAfter: "files-applied" },
      ),
    ).rejects.toThrow(/simulated transaction crash/i);
    await expect(recoverBrain(root)).resolves.toBe("restored");
    await expect(
      git(root, ["rev-parse", "--verify", "HEAD"]),
    ).rejects.toThrow();
    await expect(
      access(path.join(root, "brain.config.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, "wiki"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(path.join(root, "sources", ".gitkeep")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      initBrain(root, {
        name: "Recoverable New Brain",
        description: "A recoverable first initialization.",
      }),
    ).resolves.toMatchObject({
      operationId: expect.stringMatching(/^op_identity_/),
      commit: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
  });

  test("publishes the first managed index after a post-commit initialization failure", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "brain-init-unborn-index-recovery-"),
    );
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Second Brain Init Test"]);
    await git(root, ["config", "user.email", "brain-init@example.invalid"]);

    await expect(
      initBrain(
        root,
        {
          name: "Committed New Brain",
          description: "A committed initialization awaiting index recovery.",
        },
        { simulateIndexPublishFailure: true },
      ),
    ).rejects.toThrow(/recovery is required/i);

    await expect(recoverBrain(root)).resolves.toBe("committed");
    expect(await git(root, ["status", "--short"])).toBe("");
    expect(await git(root, ["log", "-1", "--format=%B"])).toContain(
      "Brain-Managed: true",
    );
    expect((await loadBrainConfig(root)).brain.name).toBe(
      "Committed New Brain",
    );
  });

  test("keeps explicit identity overrides and clean reruns idempotent", async () => {
    const root = await templateGitRepository();
    const first = await initBrain(root, {
      name: "Orbital Mechanics",
      description: "A precise orbital mechanics brain.",
    });
    const firstHead = await git(root, ["rev-parse", "HEAD"]);
    const operations = await readFile(
      path.join(root, ".brain", "operations.jsonl"),
      "utf8",
    );

    const second = await initBrain(root, {
      name: "Orbital Mechanics",
      description: "A precise orbital mechanics brain.",
    });

    expect(first).toMatchObject({ mode: "template-replaced" });
    expect(second).toMatchObject({ mode: "existing" });
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(firstHead);
    expect(
      await readFile(path.join(root, ".brain", "operations.jsonl"), "utf8"),
    ).toBe(operations);
  });

  test("refuses staged work and preserves unrelated unstaged files", async () => {
    const stagedRoot = await templateGitRepository();
    await writeFile(path.join(stagedRoot, "staged.txt"), "keep staged\n");
    await git(stagedRoot, ["add", "staged.txt"]);
    await expect(initBrain(stagedRoot)).rejects.toThrow(/staged changes/i);
    expect((await loadBrainConfig(stagedRoot)).brain.name).toBe(
      "Portable Second Brain",
    );
    expect(
      await git(stagedRoot, ["status", "--short", "--", "staged.txt"]),
    ).toBe("A  staged.txt");

    const dirtyRoot = await templateGitRepository("astronomy-notes");
    await writeFile(path.join(dirtyRoot, "private-notes.txt"), "keep local\n");
    await initBrain(dirtyRoot);
    expect(
      await readFile(path.join(dirtyRoot, "private-notes.txt"), "utf8"),
    ).toBe("keep local\n");
    expect(
      await git(dirtyRoot, ["status", "--short", "--", "private-notes.txt"]),
    ).toBe("?? private-notes.txt");
  });

  test("restores identity files after an interrupted managed initialization", async () => {
    const root = await templateGitRepository("recoverable-brain");
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);

    await expect(
      initBrain(root, undefined, { simulateCrashAfter: "files-applied" }),
    ).rejects.toThrow(/simulated transaction crash/i);
    expect((await loadBrainConfig(root)).brain.name).toBe("Recoverable Brain");

    await expect(recoverBrain(root)).resolves.toBe("restored");
    expect((await loadBrainConfig(root)).brain.name).toBe(
      "Portable Second Brain",
    );
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);

    await expect(initBrain(root)).resolves.toMatchObject({
      mode: "template-replaced",
      name: "Recoverable Brain",
    });
  });

  test("creates the canonical brain layout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-init-"));

    await initBrain(root, {
      name: "Physics",
      description: "A simple physics brain",
    });

    const config = await loadBrainConfig(root);
    expect(config.brain.name).toBe("Physics");
    const charter = await readFile(path.join(root, "BRAIN.md"), "utf8");
    expect(charter).toContain("# Physics");
    expect(charter).not.toMatch(/replace this section after cloning/i);
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
