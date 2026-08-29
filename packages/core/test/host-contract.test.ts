import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("shared Codex and Claude onboarding contract", () => {
  it("keeps AGENTS.md as Claude Code's only imported project contract", async () => {
    await expect(readRepositoryFile("CLAUDE.md")).resolves.toBe("@AGENTS.md\n");
  });

  it.each(["AGENTS.md", ".agents/skills/second-brain/SKILL.md"])(
    "%s recognizes natural-language onboarding and preserves the required route",
    async (path) => {
      const contract = (await readRepositoryFile(path)).toLowerCase();
      expect(contract).toContain("initialize this second brain");

      const orderedMarkers = [
        "check runtime and dependencies",
        "recover",
        "doctor and status",
        "initialize identity",
        "add sources",
        "scan sources",
        "infer and persist the charter",
        "complete or resume setup",
        "complete the semantic audit",
        "rebuild and smoke-search",
        "final doctor and status",
        "safe sync",
        "report readiness",
      ];

      let previousIndex = -1;
      for (const marker of orderedMarkers) {
        const index = contract.indexOf(marker);
        expect(index, `missing or out-of-order marker: ${marker}`).toBeGreaterThan(
          previousIndex,
        );
        previousIndex = index;
      }
    },
  );

  it.each(["AGENTS.md", ".agents/skills/second-brain/SKILL.md"])(
    "%s makes dependency setup agent-owned and never delegates routine CLI work",
    async (path) => {
      const contract = (await readRepositoryFile(path)).toLowerCase();
      expect(contract).toContain("pnpm install --frozen-lockfile");
      expect(contract).toContain("corepack pnpm");
      expect(contract).toContain("never ask the user to run routine");

      for (const operation of [
        "init",
        "scan",
        "doctor",
        "status",
        "search",
        "rebuild",
        "audit",
        "recover",
        "setup",
        "commit",
        "eligible sync",
      ]) {
        expect(contract).toContain(operation);
      }
    },
  );

  it("documents the zero-command path before manual CLI reference", async () => {
    const readme = (await readRepositoryFile("README.md")).toLowerCase();
    const zeroCommand = readme.indexOf('say “initialize this second brain.”');
    const manualReference = readme.indexOf("## manual cli reference");

    expect(zeroCommand).toBeGreaterThan(-1);
    expect(manualReference).toBeGreaterThan(zeroCommand);
  });
});
