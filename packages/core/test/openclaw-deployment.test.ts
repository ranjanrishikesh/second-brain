import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("OpenClaw deployment", () => {
  it("pins the supported runtime and keeps the canonical repository separate", async () => {
    const dockerfile = await readFile(
      resolve(repositoryRoot, "deploy/openclaw/Dockerfile"),
      "utf8",
    );
    const compose = parse(
      await readFile(
        resolve(repositoryRoot, "deploy/openclaw/compose.yaml"),
        "utf8",
      ),
    );

    expect(dockerfile).toContain("FROM node:24.15.0-bookworm-slim");
    expect(dockerfile).toContain(
      "pnpm --filter @second-brain/openclaw-adapter build",
    );

    const gateway = compose.services["brain-gateway"];
    expect(gateway.ports).toContain(
      `127.0.0.1:\${OPENCLAW_GATEWAY_PORT:-18789}:18789`,
    );
    expect(gateway.volumes).toContain("../..:/brain");
    expect(gateway.volumes).toContain("openclaw-runtime:/home/node/.openclaw");
    expect(gateway.healthcheck.test.join(" ")).toContain("/readyz");
    expect(gateway.command.join(" ")).toContain("--bind lan");
    expect(compose.volumes).toHaveProperty("openclaw-runtime");
  });

  it("loads only the shared brain adapter and never enables a second wiki", async () => {
    const config = JSON.parse(
      await readFile(
        resolve(repositoryRoot, "deploy/openclaw/openclaw.json"),
        "utf8",
      ),
    );

    expect(config.plugins.load.paths).toEqual(["/app/adapters/openclaw"]);
    expect(config.plugins.entries["second-brain"]).toMatchObject({
      enabled: true,
      hooks: {
        allowConversationAccess: true,
        allowPromptInjection: true,
      },
      config: { brainRoot: "/brain" },
    });
    expect(config.tools).toMatchObject({
      profile: "minimal",
      allow: expect.arrayContaining([
        "second-brain",
        "web_search",
        "web_fetch",
      ]),
    });
    expect(JSON.stringify(config).toLowerCase()).not.toContain("memory wiki");
  });
});
