import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  beginQuery,
  initBrain,
  inspectOnboarding,
  readBrainState,
  recordSourceReviewDecisions,
  reviewSourceCandidates,
  scanAndRegisterSources,
  setBrainCharter,
  sourceReviewDecisionBatchV1Schema,
} from "../src/index.js";

const execFile = promisify(execFileCallback);

async function initializedBrain(name = "Astronomy"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-source-review-"));
  await initBrain(root, {
    name,
    description: `${name} source-backed knowledge.`,
  });
  return root;
}

async function initializedGitBrain(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-source-review-git-"));
  await execFile("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
  });
  await execFile("git", ["config", "user.name", "Source Review Test"], {
    cwd: root,
  });
  await execFile(
    "git",
    ["config", "user.email", "source-review@example.invalid"],
    { cwd: root },
  );
  await initBrain(root, {
    name: "Astronomy",
    description: "Astronomy source-backed knowledge.",
  });
  return root;
}

async function canonicalSnapshot(root: string): Promise<string[]> {
  return Promise.all(
    [
      ".brain/source-manifest.json",
      ".brain/state.json",
      ".brain/operations.jsonl",
      "wiki/log.md",
    ].map((relativePath) => readFile(path.join(root, relativePath), "utf8")),
  );
}

describe("agent-owned source relevance review", () => {
  test("previews stable representative content without canonical writes", async () => {
    const root = await initializedGitBrain();
    await writeFile(
      path.join(root, "sources", "orbits.md"),
      "# Orbital Resonance\n\nPlanets can occupy stable resonant orbits.\n",
    );
    const before = await canonicalSnapshot(root);
    const { stdout: headBefore } = await execFile(
      "git",
      ["rev-parse", "HEAD"],
      {
        cwd: root,
      },
    );

    const review = await reviewSourceCandidates(root);

    expect(review).toEqual({
      version: 1,
      candidates: [
        expect.objectContaining({
          path: "sources/orbits.md",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          title: "Orbital Resonance",
          extractionStatus: "ready",
          representativeChunks: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining("resonant orbits"),
            }),
          ]),
        }),
      ],
    });
    expect(await canonicalSnapshot(root)).toEqual(before);
    const { stdout: headAfter } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    expect(headAfter).toBe(headBefore);
  });

  test("registers agent-admitted bytes and leaves owner-declined bytes outside the brain", async () => {
    const root = await initializedBrain();
    await writeFile(
      path.join(root, "sources", "orbits.md"),
      "# Orbits\n\nOrbital evidence.\n",
    );
    const orbitCandidate = (await reviewSourceCandidates(root)).candidates[0];
    if (!orbitCandidate) throw new Error("Expected orbit candidate");
    await recordSourceReviewDecisions(root, {
      version: 1,
      decisions: [
        {
          path: orbitCandidate.path,
          sha256: orbitCandidate.sha256,
          decision: "include",
          basis: "agent-in-scope",
          reason: "Directly supports the astronomy brain.",
        },
      ],
    });
    const included = await scanAndRegisterSources(root, {
      requireReview: true,
    });
    expect(included.added).toEqual([
      expect.objectContaining({ path: "sources/orbits.md" }),
    ]);

    await writeFile(
      path.join(root, "sources", "recipes.md"),
      "# Pasta Recipes\n\nBoil salted water.\n",
    );
    const recipeCandidate = (
      await reviewSourceCandidates(root)
    ).candidates.find((candidate) => candidate.path === "sources/recipes.md");
    if (!recipeCandidate) throw new Error("Expected recipe candidate");
    await recordSourceReviewDecisions(root, {
      version: 1,
      decisions: [
        {
          path: recipeCandidate.path,
          sha256: recipeCandidate.sha256,
          decision: "exclude",
          basis: "owner-declined",
          reason: "Owner declined this unrelated cooking source.",
        },
      ],
    });
    const excluded = await scanAndRegisterSources(root, {
      requireReview: true,
    });
    expect(excluded.excluded).toEqual([
      {
        path: "sources/recipes.md",
        sha256: recipeCandidate.sha256,
        bytes: recipeCandidate.bytes,
      },
    ]);
    const manifest = JSON.parse(
      await readFile(path.join(root, ".brain", "source-manifest.json"), "utf8"),
    ) as { sources: Array<{ path: string }> };
    expect(manifest.sources.map((source) => source.path)).toEqual([
      "sources/orbits.md",
    ]);
    expect(await inspectOnboarding(root)).toMatchObject({
      phase: "ready-for-setup",
      sourceFiles: { excluded: 1, pendingReview: 0 },
    });
  });

  test("requires a fresh decision when declined bytes change", async () => {
    const root = await initializedBrain();
    const sourcePath = path.join(root, "sources", "recipes.md");
    await writeFile(sourcePath, "# Recipes\n\nFirst version.\n");
    const candidate = (await reviewSourceCandidates(root)).candidates[0];
    if (!candidate) throw new Error("Expected candidate");
    await recordSourceReviewDecisions(root, {
      version: 1,
      decisions: [
        {
          path: candidate.path,
          sha256: candidate.sha256,
          decision: "exclude",
          basis: "owner-declined",
          reason: "Owner declined unrelated material.",
        },
      ],
    });
    await writeFile(sourcePath, "# Recipes\n\nChanged version.\n");

    await expect(inspectOnboarding(root)).resolves.toMatchObject({
      phase: "sources-review-required",
      nextAction: "review-sources",
      sourceFiles: { pendingReview: 1, excluded: 0 },
    });
    await expect(
      scanAndRegisterSources(root, { requireReview: true }),
    ).rejects.toThrow(/source review is required.*recipes\.md/i);
    await expect(beginQuery(root, "What is in the brain?")).rejects.toThrow(
      /source review is required.*recipes\.md/i,
    );
  });

  test("keeps an approved unrelated source as an exact one-time exception", async () => {
    const root = await initializedBrain();
    await writeFile(
      path.join(root, "sources", "orbits.md"),
      "# Orbits\n\nAstronomy evidence.\n",
    );
    const orbit = (await reviewSourceCandidates(root)).candidates[0];
    if (!orbit) throw new Error("Expected orbit candidate");
    await recordSourceReviewDecisions(root, {
      version: 1,
      decisions: [
        {
          path: orbit.path,
          sha256: orbit.sha256,
          decision: "include",
          basis: "agent-in-scope",
          reason: "Direct astronomy evidence.",
        },
      ],
    });
    await scanAndRegisterSources(root, { requireReview: true });
    await setBrainCharter(root, {
      version: 1,
      description: "Astronomy evidence about orbital systems.",
      purpose: "Answer source-backed astronomy questions.",
      boundaries: ["Keep the primary scope limited to astronomy."],
      domainConventions: ["Preserve astronomical terminology."],
      evidencePreferences: ["Prefer primary orbital evidence."],
      origin: "inferred",
    });
    const charterBefore = await readFile(path.join(root, "BRAIN.md"), "utf8");
    await writeFile(
      path.join(root, "sources", "recipes.md"),
      "# Recipes\n\nAn owner-approved cooking exception.\n",
    );
    const recipe = (await reviewSourceCandidates(root)).candidates.find(
      (candidate) => candidate.path === "sources/recipes.md",
    );
    if (!recipe) throw new Error("Expected recipe candidate");
    await recordSourceReviewDecisions(root, {
      version: 1,
      decisions: [
        {
          path: recipe.path,
          sha256: recipe.sha256,
          decision: "include",
          basis: "owner-exception",
          reason: "Owner approved this exact source as a one-time exception.",
        },
      ],
    });
    await scanAndRegisterSources(root, { requireReview: true });

    expect(await readFile(path.join(root, "BRAIN.md"), "utf8")).toBe(
      charterBefore,
    );
    expect((await readBrainState(root)).sourceReviews).toContainEqual(
      expect.objectContaining({
        path: "sources/recipes.md",
        sha256: recipe.sha256,
        decision: "include",
        basis: "owner-exception",
      }),
    );
    await writeFile(
      path.join(root, "sources", "desserts.md"),
      "# Desserts\n\nA similar but separately presented cooking source.\n",
    );
    await expect(inspectOnboarding(root)).resolves.toMatchObject({
      phase: "sources-review-required",
      sourceFiles: { pendingReview: 1 },
    });
    await expect(
      scanAndRegisterSources(root, { requireReview: true }),
    ).rejects.toThrow(/source review is required.*desserts\.md/i);
  });

  test("rejects contradictory decision and basis combinations", () => {
    expect(
      sourceReviewDecisionBatchV1Schema.safeParse({
        version: 1,
        decisions: [
          {
            path: "sources/recipes.md",
            sha256: "a".repeat(64),
            decision: "exclude",
            basis: "agent-in-scope",
            reason: "Contradictory input.",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
