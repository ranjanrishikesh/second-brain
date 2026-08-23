import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { initBrain } from "@second-brain/core";
import { OpenClawSchema } from "openclaw/plugin-sdk/config-schema";
import plugin from "../src/index.js";
import { brainToolNames, createBrainToolHandlers } from "../src/tools.js";

describe("OpenClaw brain tools", () => {
  test("exposes the shared core lifecycle without a second knowledge store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-openclaw-"));
    await initBrain(root, { name: "Hosted", description: "OpenClaw adapter" });
    const tools = createBrainToolHandlers(root);

    expect(Object.keys(tools).sort()).toEqual([...brainToolNames].sort());
    await expect(tools.brain_status({})).resolves.toMatchObject({
      version: 1,
      brain: { name: "Hosted" },
    });
    const session = await tools.brain_begin_query({
      question: "What is a pulsar?",
    });
    expect(session).toMatchObject({ currentTier: "wiki", tiersUsed: ["wiki"] });
    await expect(
      tools.brain_expand_query({
        queryId: session.id,
        tier: "sources",
        reason: "The wiki has no answer.",
      }),
    ).resolves.toMatchObject({ currentTier: "sources" });
  });

  test("keeps the manifest tool contract synchronized with runtime handlers", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(import.meta.dirname, "..", "openclaw.plugin.json"),
        "utf8",
      ),
    );

    expect(manifest.contracts.tools.sort()).toEqual([...brainToolNames].sort());
    expect(manifest.configSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  test("registers a structural schema for brain change sets", () => {
    const registered: Array<{ name: string; parameters: unknown }> = [];
    plugin.register({
      pluginConfig: { brainRoot: "/brain" },
      registerTool(tool: { name: string; parameters: unknown }) {
        registered.push(tool);
      },
      on() {},
      logger: { warn() {} },
    } as never);

    const apply = registered.find((tool) => tool.name === "brain_apply");
    expect(apply?.parameters).toMatchObject({
      type: "object",
      required: ["changeSet"],
      properties: {
        changeSet: {
          type: "object",
          required: [
            "version",
            "operationId",
            "catalogRevision",
            "reason",
            "pages",
            "reconciliation",
          ],
        },
      },
    });
  });

  test("ships a configuration accepted by the pinned OpenClaw schema", async () => {
    const config = JSON.parse(
      await readFile(
        path.join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "deploy",
          "openclaw",
          "openclaw.json",
        ),
        "utf8",
      ),
    );

    expect(OpenClawSchema.safeParse(config)).toMatchObject({ success: true });
  });
});
