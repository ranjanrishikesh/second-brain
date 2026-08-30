import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
        expect(
          index,
          `missing or out-of-order marker: ${marker}`,
        ).toBeGreaterThan(previousIndex);
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

  it.each(["AGENTS.md", ".agents/skills/second-brain/SKILL.md"])(
    "%s separates knowledge gaps, capability gaps, and unexpected failures",
    async (path) => {
      const contract = await readRepositoryFile(path);

      for (const marker of [
        "knowledge gap",
        "unsupported capability",
        "unexpected failure",
        "support.issueTrackerUrl",
        "privacy-safe",
        "explicit approval",
        "may be considered for a future release",
      ]) {
        expect(contract).toContain(marker);
      }

      expect(contract).toContain("Your second brain is ready.");
      expect(contract).toContain("Never promise");
      expect(contract).not.toMatch(/\bv2\b/iu);
      expect(contract).not.toMatch(/shall we plan/iu);
    },
  );

  it.each(["AGENTS.md", ".agents/skills/second-brain/SKILL.md"])(
    "%s keeps external issue creation owner-approved and private",
    async (path) => {
      const contract = await readRepositoryFile(path);

      for (const forbiddenDisclosure of [
        "source bytes",
        "source excerpts",
        "personal filenames",
        "absolute local paths",
        "credentials",
        "private brain content",
      ]) {
        expect(contract).toContain(forbiddenDisclosure);
      }

      expect(contract).toContain("exact destination and sanitized draft");
      expect(contract).toContain("authenticated host tooling");
      expect(contract).toContain("not the cloned repository's `origin`");
    },
  );

  it("provides a privacy-safe capability request form", async () => {
    const form = parse(
      await readRepositoryFile(
        ".github/ISSUE_TEMPLATE/capability-request.yml",
      ),
    ) as {
      name: string;
      description: string;
      title: string;
      labels: string[];
      body: unknown[];
    };

    expect(form).toMatchObject({
      name: "Capability request",
      description:
        "Suggest a missing capability for the second-brain template",
      title: "[Capability]: ",
      labels: ["enhancement"],
    });

    const formText = JSON.stringify(form);
    expect(formText).toContain("What are you trying to accomplish?");
    expect(formText).toContain("What happens with the template today?");
    expect(formText).toContain("What behavior would help?");
    expect(formText).toContain(
      "I removed private source content, credentials, and personal paths",
    );
    expect(formText).toContain(
      "Requests are considered; no release or delivery date is promised.",
    );
  });

  it("documents the zero-command path before manual CLI reference", async () => {
    const readme = (await readRepositoryFile("README.md")).toLowerCase();
    const zeroCommand = readme.indexOf("say “initialize this second brain.”");
    const manualReference = readme.indexOf("## manual cli reference");

    expect(zeroCommand).toBeGreaterThan(-1);
    expect(manualReference).toBeGreaterThan(zeroCommand);
  });

  it("starts both live-host smokes from pristine clones with only the onboarding prompt", async () => {
    const checklist = (
      await readRepositoryFile("docs/V1_EXIT_CHECKLIST.md")
    ).toLowerCase();

    expect(checklist).toContain("initialize this second brain.");
    expect(checklist).toContain("empty `sources/`");
    expect(checklist).toContain("pdf and docx");
    expect(checklist).toContain("second disposable pristine clone");
    expect(checklist).toContain(
      "do not infer claude code success from codex success",
    );
  });
});
