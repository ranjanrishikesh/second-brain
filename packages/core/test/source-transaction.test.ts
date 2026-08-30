import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import {
  enrichSourceWebDiscovery,
  initBrain,
  recoverBrain,
  scanAndRegisterSources,
  supersedeRegisteredSource,
} from "../src/index.js";
import { registerWebSourceCapture } from "../src/source-transaction.js";

const execFile = promisify(execFileCallback);

const artifactPath = "sources/web/2026/08/orbits-0123456789ab.pdf";
const sidecarPath = "sources/web/2026/08/.orbits-0123456789ab.pdf.web.json";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeArtifactFiles(
  root: string,
  sourcePath: string,
  artifactBytes: Uint8Array,
): Promise<Uint8Array> {
  const companionPath = path.posix.join(
    path.posix.dirname(sourcePath),
    `.${path.posix.basename(sourcePath)}.web.json`,
  );
  const fileName = path.posix.basename(sourcePath);
  const originalUrl = `https://example.com/${fileName}`;
  const sidecar = {
    brainWebArtifact: 1,
    sourcePath,
    artifactSha256: sha256(artifactBytes),
    artifactBytes: artifactBytes.byteLength,
    title: "Orbital Report",
    format: "pdf",
    mediaType: "application/pdf",
    discovery: {
      originalUrl,
      finalUrl: originalUrl,
      redirectChain: [],
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
  await mkdir(path.join(root, path.dirname(sourcePath)), { recursive: true });
  await writeFile(path.join(root, sourcePath), artifactBytes);
  await writeFile(path.join(root, companionPath), sidecarBytes);
  return sidecarBytes;
}

async function createArtifactFiles(root: string): Promise<{
  artifactBytes: Uint8Array;
  sidecarBytes: Uint8Array;
}> {
  const artifactBytes = await createPdfBytes("Orbital mechanics");
  const sidecarBytes = await writeArtifactFiles(
    root,
    artifactPath,
    artifactBytes,
  );
  return { artifactBytes, sidecarBytes };
}

async function createPdfBytes(text: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 40, y: 700, size: 14, font });
  return await document.save();
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
  test("rejects partial duplicate companion state before scanning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-duplicate-state-"));
    await initBrain(root, {
      name: "Sources",
      description: "Partial duplicate state test",
    });
    const statePath = path.join(root, ".brain", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.sourceDuplicates = [
      {
        path: "sources/web/2026/08/copy.txt",
        sourceId: "src_0123456789abcdef",
        sha256: "a".repeat(64),
        bytes: 12,
        sidecarPath: "sources/web/2026/08/.copy.txt.web.json",
      },
    ];
    const partialState = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(statePath, partialState);

    await expect(scanAndRegisterSources(root)).rejects.toThrow(/sidecar/i);
    expect(await readFile(statePath, "utf8")).toBe(partialState);
  });

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

  test("rejects a same-byte source reached through a swapped ancestor symlink without changing canonical state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-source-ancestor-"));
    await initBrain(root, {
      name: "Sources",
      description: "Source ancestor containment test",
    });
    const sourceBytes = "# Facts\n\nOriginal source bytes.\n";
    await writeFile(path.join(root, "sources", "facts.md"), sourceBytes);
    const outside = await mkdtemp(
      path.join(tmpdir(), "brain-source-ancestor-outside-"),
    );
    await writeFile(path.join(outside, "facts.md"), sourceBytes);
    const canonicalPaths = [
      ".brain/source-manifest.json",
      ".brain/state.json",
      ".brain/operations.jsonl",
      "wiki/log.md",
    ];
    const before = await Promise.all(
      canonicalPaths.map((relativePath) =>
        readFile(path.join(root, relativePath), "utf8"),
      ),
    );

    await expect(
      scanAndRegisterSources(root, {
        afterMutation: async () => {
          await rename(
            path.join(root, "sources"),
            path.join(root, "sources-original"),
          );
          await symlink(outside, path.join(root, "sources"));
        },
      }),
    ).rejects.toThrow(/symbolic link|outside.*brain root|changed/i);

    expect(
      await Promise.all(
        canonicalPaths.map((relativePath) =>
          readFile(path.join(root, relativePath), "utf8"),
        ),
      ),
    ).toEqual(before);
    expect(await readFile(path.join(outside, "facts.md"), "utf8")).toBe(
      sourceBytes,
    );
    await expect(
      readFile(path.join(root, ".brain", "runtime", "transaction.json")),
    ).rejects.toThrow();
  });

  test("rejects a same-byte source inode replacement and preserves HEAD and unrelated work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-source-inode-"));
    await initGitBrain(root, "Source inode stability test");
    const sourceBytes = "# Facts\n\nOriginal source bytes.\n";
    const sourcePath = path.join(root, "sources", "facts.md");
    await writeFile(sourcePath, sourceBytes);
    await writeFile(path.join(root, "private-notes.txt"), "Keep me.\n");
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    const manifestPath = path.join(root, ".brain", "source-manifest.json");
    const beforeManifest = await readFile(manifestPath, "utf8");

    await expect(
      scanAndRegisterSources(root, {
        afterMutation: async () => {
          await rename(sourcePath, path.join(root, "original-facts.md"));
          await writeFile(sourcePath, sourceBytes);
        },
      }),
    ).rejects.toThrow(/changed|unvalidated|identity/i);

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
    expect(await readFile(path.join(root, "private-notes.txt"), "utf8")).toBe(
      "Keep me.\n",
    );
  });

  test("revalidates an idempotently reused source through its contained path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-source-reuse-path-"));
    await initGitBrain(root, "Idempotent source reuse containment test");
    const sourceBytes = "# Facts\n\nReusable source bytes.\n";
    await writeFile(path.join(root, "sources", "facts.md"), sourceBytes);
    const source = (await scanAndRegisterSources(root)).added[0];
    if (!source) throw new Error("Expected a registered source");
    const discovery = {
      originalUrl: "https://example.com/facts.md",
      finalUrl: "https://example.com/facts.md",
      redirectChain: [],
      retrievedAt: "2026-08-30T00:00:00.000Z",
      queryId: "qry_0123456789abcdef0123456789abcdef",
      questionHash: "c".repeat(64),
      query: "What do the reusable facts say?",
      representation: "artifact" as const,
      completeness: "complete" as const,
    };
    await enrichSourceWebDiscovery(root, source.id, discovery);
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    const outside = await mkdtemp(
      path.join(tmpdir(), "brain-source-reuse-outside-"),
    );
    await writeFile(path.join(outside, "facts.md"), sourceBytes);

    await expect(
      registerWebSourceCapture(
        root,
        async () => ({ sourceId: source.id, discovery }),
        {
          afterMutation: async () => {
            await rename(
              path.join(root, "sources"),
              path.join(root, "sources-original"),
            );
            await symlink(outside, path.join(root, "sources"));
          },
        },
      ),
    ).rejects.toThrow(/source.*changed|symbolic link|outside.*brain root/i);

    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await readFile(path.join(outside, "facts.md"), "utf8")).toBe(
      sourceBytes,
    );
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

  test.each(["a-local.pdf", "z-local.pdf"])(
    "keeps an ordinary %s source canonical when identical managed web bytes are scanned",
    async (localName) => {
      const root = await mkdtemp(path.join(tmpdir(), "brain-local-priority-"));
      await initGitBrain(root, "Local source priority test");
      const { artifactBytes } = await createArtifactFiles(root);
      const localPath = `sources/${localName}`;
      await writeFile(path.join(root, localPath), artifactBytes);

      const result = await scanAndRegisterSources(root);

      expect(result.added).toEqual([
        expect.objectContaining({
          path: localPath,
          provenance: { kind: "file" },
        }),
      ]);
      expect(result.duplicates).toEqual([
        expect.objectContaining({
          path: artifactPath,
          sourceId: result.added[0]?.id,
          sidecarPath,
        }),
      ]);
      const manifest = JSON.parse(
        await readFile(
          path.join(root, ".brain", "source-manifest.json"),
          "utf8",
        ),
      );
      expect(manifest.sources).toEqual([
        expect.objectContaining({
          path: localPath,
          provenance: { kind: "file" },
        }),
      ]);
    },
  );

  test("always scans managed web evidence when configured source roots are elsewhere", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-custom-roots-"));
    await initGitBrain(root, "Custom source roots test");
    const configPath = path.join(root, "brain.config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.sources.roots = ["knowledge/local"];
    await writeFile(configPath, stringify(config));
    await mkdir(path.join(root, "knowledge", "local"), { recursive: true });
    await git(root, ["add", "brain.config.yaml"]);
    await git(root, ["commit", "-m", "test: use custom source root"]);
    const { artifactBytes } = await createArtifactFiles(root);
    await writeFile(
      path.join(root, "knowledge", "local", "z-local.pdf"),
      artifactBytes,
    );

    const result = await scanAndRegisterSources(root);

    expect(result.added).toEqual([
      expect.objectContaining({
        path: "knowledge/local/z-local.pdf",
        provenance: { kind: "file" },
      }),
    ]);
    expect(result.duplicates).toEqual([
      expect.objectContaining({
        path: artifactPath,
        sourceId: result.added[0]?.id,
        sidecarPath,
      }),
    ]);
  });

  test("acknowledges a duplicate web artifact with its immutable sidecar", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-web-duplicate-"));
    await initGitBrain(root, "Web duplicate test");
    const { artifactBytes } = await createArtifactFiles(root);
    await scanAndRegisterSources(root);
    const duplicatePath = "sources/web/2026/08/orbits-copy.pdf";
    const duplicateSidecarPath =
      "sources/web/2026/08/.orbits-copy.pdf.web.json";
    const duplicateSidecarBytes = await writeArtifactFiles(
      root,
      duplicatePath,
      artifactBytes,
    );

    const result = await scanAndRegisterSources(root);

    expect(result.duplicates).toEqual([
      expect.objectContaining({
        path: duplicatePath,
        sidecarPath: duplicateSidecarPath,
        sidecarSha256: sha256(duplicateSidecarBytes),
        sidecarBytes: duplicateSidecarBytes.byteLength,
      }),
    ]);
    const state = JSON.parse(
      await readFile(path.join(root, ".brain", "state.json"), "utf8"),
    );
    expect(state.sourceDuplicates).toEqual([
      expect.objectContaining({
        path: duplicatePath,
        sidecarPath: duplicateSidecarPath,
        sidecarSha256: sha256(duplicateSidecarBytes),
        sidecarBytes: duplicateSidecarBytes.byteLength,
      }),
    ]);
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
        ".brain/state.json",
        duplicatePath,
        duplicateSidecarPath,
        "wiki/log.md",
      ].sort(),
    );

    const cloneParent = await mkdtemp(
      path.join(tmpdir(), "brain-web-duplicate-clone-"),
    );
    const checkout = path.join(cloneParent, "checkout");
    await git(root, ["clone", "--quiet", root, checkout]);
    await expect(scanAndRegisterSources(checkout)).resolves.toMatchObject({
      duplicates: [{ path: duplicatePath }],
    });
    expect(await git(checkout, ["status", "--short"])).toBe("");
  });

  test.each([
    "changed artifact and sidecar",
    "changed artifact only",
    "deleted artifact",
    "changed sidecar",
    "deleted sidecar",
  ] as const)(
    "rejects a previously acknowledged duplicate web %s as immutable",
    async (mutation) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "brain-web-duplicate-mutation-"),
      );
      await initGitBrain(root, "Web duplicate mutation test");
      const { artifactBytes } = await createArtifactFiles(root);
      await scanAndRegisterSources(root);
      const duplicatePath = "sources/web/2026/08/orbits-copy.pdf";
      const duplicateSidecarPath =
        "sources/web/2026/08/.orbits-copy.pdf.web.json";
      await writeArtifactFiles(root, duplicatePath, artifactBytes);
      await scanAndRegisterSources(root);
      const beforeHead = await git(root, ["rev-parse", "HEAD"]);

      if (mutation === "changed artifact and sidecar") {
        await writeArtifactFiles(
          root,
          duplicatePath,
          await createPdfBytes("Changed orbital mechanics"),
        );
      } else if (mutation === "changed artifact only") {
        await writeFile(
          path.join(root, duplicatePath),
          await createPdfBytes("Changed orbital mechanics"),
        );
      } else if (mutation === "deleted artifact") {
        await rm(path.join(root, duplicatePath));
      } else if (mutation === "changed sidecar") {
        const sidecar = JSON.parse(
          await readFile(path.join(root, duplicateSidecarPath), "utf8"),
        );
        sidecar.title = "Changed sidecar title";
        await writeFile(
          path.join(root, duplicateSidecarPath),
          `${JSON.stringify(sidecar, null, 2)}\n`,
        );
      } else {
        await rm(path.join(root, duplicateSidecarPath));
      }

      await expect(scanAndRegisterSources(root)).rejects.toThrow(
        /Immutable source violation/,
      );
      expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    },
  );

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
