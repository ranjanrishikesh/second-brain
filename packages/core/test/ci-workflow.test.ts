import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

type WorkflowStep = {
  run?: unknown;
  uses?: unknown;
  with?: unknown;
};

type Workflow = {
  on?: {
    push?: unknown;
    pull_request?: unknown;
  };
  jobs?: {
    "core-and-cli"?: {
      strategy?: {
        matrix?: {
          node?: unknown;
        };
      };
      steps?: WorkflowStep[];
    };
  };
};

describe("derived-brain CI workflow", () => {
  test("runs the supported CI contract without requiring a full Git checkout", async () => {
    const workflow = parse(
      await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    ) as Workflow;
    const job = workflow.jobs?.["core-and-cli"];
    const steps = job?.steps ?? [];
    const runSteps = steps.flatMap((step) =>
      typeof step.run === "string" ? [step.run] : [],
    );

    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on?.push).toEqual({ branches: ["main"] });
    expect(job?.strategy?.matrix?.node).toEqual(["22.22.3", "24.15.0"]);
    expect(steps.find((step) => step.uses === "actions/checkout@v4")).toEqual({
      uses: "actions/checkout@v4",
    });
    expect(runSteps).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm verify",
      "pnpm test:e2e",
      "pnpm brain doctor",
      "pnpm brain audit",
      "pnpm schemas:generate",
      "git diff --exit-code -- schemas",
    ]);
  });
});
