import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test } from "vitest";
import {
  initBrain,
  recoverBrain,
  scanAndRegisterSources,
  supersedeRegisteredSource,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

const artifactPath = "sources/web/2026/08/orbits-0123456789ab.pdf";
const sidecarPath = "sources/web/2026/08/.orbits-0123456789ab.pdf.web.json";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createArtifactFiles(root: string): Promise<{
  artifactBytes: Uint8Array;
  sidecarBytes: Uint8Array;
}> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Orbital mechanics", { x: 40, y: 700, size: 14, font });
  const artifactBytes = await document.save();
  const sidecar = {
    brainWebArtifact: 1,
    sourcePath: artifactPath,
    artifactSha256: sha256(artifactBytes),
    artifactBytes: artifactBytes.byteLength,
    title: "Orbital Report",
    format: "pdf",
    mediaType: "application/pdf",
    discovery: {
      originalUrl: "https://example.com/orbits.pdf",
      finalUrl: "https://cdn.example.com/orbits.pdf",
      redirectChain: ["https://cdn.example.com/orbits.pdf"],
      retrievedAt: "2026-08-30T00:00:00.000Z",
      queryId: "qry_0123456789abcdef0123456789abcdef",
      questionHash: "c".repeat(64),
      query: "What does the orbit report conclude?",
      representation: "artifact",
      completeness: "complete",
    },
  };
  const sidecarBytes = new TextEncoder().encode(
    `${JSON.stringify(sidecar, null, 2)}\n`,
  );
  await mkdir(path.join(root, path.dirname(artifactPath)), { recursive: true });
  await writeFile(path.join(root, artifactPath), artifactBytes);
  await writeFile(path.join(root, sidecarPath), sidecarBytes);
  return { artifactBytes, sidecarBytes };
}

async function initGitBrain(root: string, description: string): Promise<void> {
  await initBrain(root, { name: "Sources", description });
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Second Brain Test"]);
  await git(root, ["config", "user.email", "brain-test@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial brain"]);
}

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

  test("rejects a pre-commit hook that re-stages changed source bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-source-hook-"));
    await initBrain(root, { name: "Sources", description: "Hook test" });
    await writeFile(
      path.join(root, ".gitignore"),
      ".brain/cache/\n.brain/runtime/\n",
    );
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "Second Brain Test"]);
    await git(root, ["config", "user.email", "brain-test@example.invalid"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial brain"]);
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    const manifestPath = path.join(root, ".brain", "source-manifest.json");
    const beforeManifest = await readFile(manifestPath, "utf8");
    await writeFile(
      path.join(root, "sources", "facts.md"),
      "# Facts\n\nOriginal source bytes.\n",
    );
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await writeFile(
      hook,
      "#!/bin/sh\nprintf '# Facts\\n\\nHook replacement bytes.\\n' > sources/facts.md\ngit add -- sources/facts.md\n",
    );
    await chmod(hook, 0o755);

    await expect(scanAndRegisterSources(root)).rejects.toThrow(
      /source.*changed|private Git index changed/i,
    );

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
    expect(
      await readFile(path.join(root, "sources", "facts.md"), "utf8"),
    ).toContain("Hook replacement bytes.");
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

  test("commits an artifact and sidecar with only the exact registration paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-commit-"));
    await initGitBrain(root, "Web commit test");
    await createArtifactFiles(root);

    const result = await scanAndRegisterSources(root);

    expect(result.added).toHaveLength(1);
    expect(
      (
        await git(root, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "HEAD",
        ])
      )
        .split("\n")
        .sort(),
    ).toEqual(
      [
        ".brain/operations.jsonl",
        ".brain/source-manifest.json",
        ".brain/state.json",
        artifactPath,
        sidecarPath,
        "wiki/log.md",
      ].sort(),
    );
  });

  test.each([
    ["artifact", artifactPath, "afterMutationBeforeSeal"],
    ["sidecar", sidecarPath, "afterMutationBeforeSeal"],
    ["artifact", artifactPath, "beforeStage"],
    ["sidecar", sidecarPath, "beforeStage"],
  ] as const)(
    "rejects %s mutation of %s during %s without moving HEAD",
    async (_input, targetPath, seam) => {
      const root = await mkdtemp(path.join(tmpdir(), "brain-web-mutation-"));
      await initGitBrain(root, "Web mutation test");
      await createArtifactFiles(root);
      const beforeHead = await git(root, ["rev-parse", "HEAD"]);
      const manifestPath = path.join(root, ".brain", "source-manifest.json");
      const beforeManifest = await readFile(manifestPath, "utf8");
      const mutate = async () => {
        await writeFile(path.join(root, targetPath), "changed bytes\n");
      };

      await expect(
        scanAndRegisterSources(root, { [seam]: mutate }),
      ).rejects.toThrow(/changed/i);

      expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
    },
  );

  test.each([
    ["artifact", artifactPath],
    ["sidecar", sidecarPath],
  ] as const)(
    "rejects a pre-commit hook that replaces the web %s",
    async (_input, targetPath) => {
      const root = await mkdtemp(path.join(tmpdir(), "brain-web-hook-"));
      await initGitBrain(root, "Web hook test");
      await createArtifactFiles(root);
      const beforeHead = await git(root, ["rev-parse", "HEAD"]);
      const manifestPath = path.join(root, ".brain", "source-manifest.json");
      const beforeManifest = await readFile(manifestPath, "utf8");
      const hook = path.join(root, ".git", "hooks", "pre-commit");
      await writeFile(
        hook,
        `#!/bin/sh\nprintf 'changed bytes\\n' > '${targetPath}'\ngit add -- '${targetPath}'\n`,
      );
      await chmod(hook, 0o755);

      await expect(scanAndRegisterSources(root)).rejects.toThrow(/changed/i);

      expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
    },
  );

  test("recovers canonical state while retaining both prepared web inputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-recover-"));
    await initGitBrain(root, "Web recovery test");
    const { artifactBytes, sidecarBytes } = await createArtifactFiles(root);
    const canonicalPaths = [
      ".brain/source-manifest.json",
      ".brain/state.json",
      ".brain/operations.jsonl",
      "wiki/log.md",
    ];
    const before = new Map(
      await Promise.all(
        canonicalPaths.map(
          async (relativePath) =>
            [
              relativePath,
              await readFile(path.join(root, relativePath), "utf8"),
            ] as const,
        ),
      ),
    );

    await expect(
      scanAndRegisterSources(root, { simulateCrashAfter: "files-applied" }),
    ).rejects.toThrow("Simulated transaction crash");
    await expect(recoverBrain(root)).resolves.toBe("restored");

    for (const [relativePath, content] of before) {
      expect(await readFile(path.join(root, relativePath), "utf8")).toBe(
        content,
      );
    }
    expect(await readFile(path.join(root, artifactPath))).toEqual(
      Buffer.from(artifactBytes),
    );
    expect(await readFile(path.join(root, sidecarPath))).toEqual(
      Buffer.from(sidecarBytes),
    );
    await expect(scanAndRegisterSources(root)).resolves.toMatchObject({
      added: [{ path: artifactPath }],
    });
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
