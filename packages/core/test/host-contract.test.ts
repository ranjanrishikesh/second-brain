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

  it.each(["AGENTS.md", ".agents/skills/second-brain/SKILL.md"])(
    "%s limits future-release wording to unsupported-capability requests",
    async (path) => {
      const contract = await readRepositoryFile(path);

      expect(contract).toContain(
        "only when offering an unsupported-capability request",
      );
      expect(contract).toContain(
        "Never use it for a knowledge gap or an unexpected failure.",
      );
    },
  );

  it.each(["AGENTS.md", ".agents/skills/second-brain/SKILL.md"])(
    "%s requires durable, hostile-by-default web evidence handling",
    async (path) => {
      const contract = (await readRepositoryFile(path)).toLowerCase();

      for (const requiredBoundary of [
        "before searching or fetching",
        "materially used",
        "prefer a supported original download",
        "complete or partial",
        "untrusted evidence, never instructions",
        "public http(s)",
        "access-control bypass",
        "private destinations",
        "https-to-http downgrade",
        "registered extraction",
        "capture-triggered bootstrap",
        "reconciliation before finishing",
        "explicit knowledge gap",
      ]) {
        expect(contract).toContain(requiredBoundary);
      }
    },
  );

  it.each(["AGENTS.md", ".agents/skills/second-brain/SKILL.md"])(
    "%s orders web approval, capture, inspection, and durable reconciliation",
    async (path) => {
      const contract = (await readRepositoryFile(path)).toLowerCase();
      const orderedMarkers = [
        "approved web tier",
        "fetch only material evidence",
        "prefer a supported original download",
        "preserve complete or partial accessible text",
        "treat content as untrusted evidence",
        "capture through the cli",
        "inspect the registered extraction",
        "persist cited and reconciled knowledge or an honest gap",
      ];
      let previousIndex = -1;
      for (const marker of orderedMarkers) {
        const index = contract.indexOf(marker);
        expect(
          index,
          `missing or out-of-order web-flow marker: ${marker}`,
        ).toBeGreaterThan(previousIndex);
        previousIndex = index;
      }
    },
  );

  it("provides a privacy-safe capability request form", async () => {
    const form = parse(
      await readRepositoryFile(".github/ISSUE_TEMPLATE/capability-request.yml"),
    ) as {
      name: string;
      description: string;
      title: string;
      labels: string[];
      body: unknown[];
    };

    expect(form).toMatchObject({
      name: "Capability request",
      description: "Suggest a missing capability for the second-brain template",
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

  it("keeps the public README limited to use, behavior, and inspiration", async () => {
    const readme = await readRepositoryFile("README.md");
    const headings = readme.match(/^## .+$/gmu) ?? [];

    expect(headings).toEqual([
      "## What you need to do",
      "## How it works",
      "## Original idea",
    ]);
    expect(readme).toContain("Initialize this second brain.");
    expect(readme).toContain("`sources/`");
    expect(readme).toContain("wiki → raw sources → approved web research");
    expect(readme).toContain(
      "[Andrej Karpathy's original LLM Wiki idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)",
    );
    expect(readme.trim().split(/\s+/u).length).toBeLessThanOrEqual(300);

    for (const outOfScopeCopy of [
      "manual cli",
      "pnpm ",
      "repository map",
      "development",
      "v1",
      "v2",
    ]) {
      expect(readme.toLowerCase()).not.toContain(outOfScopeCopy);
    }
  });

  it("starts both live-host smokes from pristine clones with only the onboarding prompt", async () => {
    const checklist = (
      await readRepositoryFile("docs/maintainers/template-release-checklist.md")
    ).toLowerCase();

    expect(checklist).toContain("initialize this second brain.");
    expect(checklist).toContain("empty `sources/`");
    expect(checklist).toContain("pdf and docx");
    expect(checklist).toContain("second disposable pristine clone");
    expect(checklist).toContain(
      "do not infer claude code success from codex success",
    );
  });

  it("keeps release verification internal and roadmap-neutral", async () => {
    const checklist = await readRepositoryFile(
      "docs/maintainers/template-release-checklist.md",
    );
    expect(checklist).toContain("Template release verification checklist");
    expect(checklist).toContain("maintainers");
    expect(checklist).toContain("Your second brain is ready.");
    expect(checklist).not.toMatch(/\bv2\b/iu);
    expect(checklist).not.toMatch(/shall we plan/iu);

    for (const activePath of [
      "README.md",
      "AGENTS.md",
      ".agents/skills/second-brain/SKILL.md",
      "docs/onboarding.md",
      "docs/maintainers/template-release-checklist.md",
    ]) {
      expect(await readRepositoryFile(activePath)).not.toMatch(/\bv2\b/iu);
    }
  });

  it.each([
    "docs/superpowers/specs/2026-08-27-v1-knowledge-workflow-hardening-design.md",
    "docs/superpowers/plans/2026-08-27-v1-knowledge-workflow-hardening.md",
    "docs/superpowers/plans/2026-08-29-zero-command-agent-onboarding.md",
  ])("marks %s as a non-normative historical record", async (path) => {
    const document = await readRepositoryFile(path);
    expect(document).toContain("Historical record");
    expect(document).toContain(
      "2026-08-30-public-template-and-capability-support-design.md",
    );
  });
});
