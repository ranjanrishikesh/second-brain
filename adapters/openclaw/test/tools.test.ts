import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  configureSyncTarget,
  initBrain,
  readBrainState,
  writeBrainState,
} from "@second-brain/core";
import { OpenClawSchema } from "openclaw/plugin-sdk/config-schema";
import plugin from "../src/index.js";
import { brainToolNames, createBrainToolHandlers } from "../src/tools.js";

const execFile = promisify(execFileCallback);

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd: root })).stdout.trim();
}

async function hostedGitBrain(): Promise<{ root: string; remote: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-openclaw-sync-"));
  const remote = await mkdtemp(
    path.join(tmpdir(), "brain-openclaw-sync-remote-"),
  );
  await initBrain(root, { name: "Hosted", description: "OpenClaw adapter" });
  const state = await readBrainState(root);
  await writeBrainState(root, {
    ...state,
    setup: {
      status: "completed",
      id: "setup_0123456789abcdef0123456789abcdef",
      purpose: "Hosted sync test",
      startedAt: "2026-08-27T00:00:00.000Z",
      completedAt: "2026-08-27T00:00:00.000Z",
      initialSourceIds: [],
      pendingSourceIds: [],
    },
  });
  await writeFile(
    path.join(root, ".gitignore"),
    ".brain/cache/\n.brain/runtime/\n",
  );
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Second Brain Test"]);
  await git(root, ["config", "user.email", "brain-test@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial brain"]);
  await git(remote, ["init", "--bare"]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["push", "-u", "origin", "main"]);
  await configureSyncTarget(root, {
    remote: "origin",
    branch: "main",
    confirm: true,
  });
  return { root, remote };
}

describe("OpenClaw brain tools", () => {
  test("returns the exact pending-sync warning when a hosted query finishes locally", async () => {
    const { root, remote } = await hostedGitBrain();
    const tools = createBrainToolHandlers(root);
    const session = await tools.brain_begin_query({
      question: "What remains available locally?",
    });
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    const result = (await tools.brain_finish_query({
      queryId: session.id,
      outcome: "answered",
      answerSummary: "The existing wiki required no additional mutation.",
    })) as { commit?: string; syncWarning?: string };

    if (!result.commit) throw new Error("Expected a local query commit");
    expect(result.syncWarning).toBe(
      `⚠ Sync pending — knowledge is safely committed locally at ${result.commit}, but it has not yet been pushed to origin/main: The remote rejected the push.`,
    );
  });

  test("exposes setup, reconciliation, approval, and sync handlers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-openclaw-tools-"));
    await initBrain(root, { name: "Hosted", description: "OpenClaw adapter" });

    const handlers = createBrainToolHandlers(root) as Record<string, unknown>;

    expect(Object.keys(handlers)).toEqual(
      expect.arrayContaining([
        "brain_begin_setup",
        "brain_next_setup",
        "brain_finish_setup",
        "brain_bootstrap_next",
        "brain_query_read",
        "brain_plan_reconciliation",
        "brain_request_web_approval",
        "brain_resolve_web_approval",
        "brain_sync",
      ]),
    );
    expect(brainToolNames).toEqual(
      expect.arrayContaining([
        "brain_begin_setup",
        "brain_next_setup",
        "brain_finish_setup",
        "brain_bootstrap_next",
        "brain_query_read",
        "brain_plan_reconciliation",
        "brain_request_web_approval",
        "brain_resolve_web_approval",
        "brain_sync",
      ]),
    );
  });

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

  test("does not allow an OpenClaw web transition before the query approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-openclaw-web-"));
    await initBrain(root, { name: "Hosted", description: "OpenClaw adapter" });
    const tools = createBrainToolHandlers(root);
    const session = await tools.brain_begin_query({
      question: "What approved evidence exists?",
    });
    await tools.brain_expand_query({
      queryId: session.id,
      tier: "sources",
      reason: "The wiki has no answer.",
    });

    await expect(
      tools.brain_expand_query({
        queryId: session.id,
        tier: "web",
        reason: "The local source catalog is insufficient.",
      }),
    ).rejects.toThrow(/approval/i);
  });

  test("blocks native web tools until the active hosted query is approved", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-openclaw-hook-"));
    await initBrain(root, { name: "Hosted", description: "OpenClaw adapter" });
    const registeredTools: unknown[] = [];
    const hooks = new Map<string, (...args: never[]) => unknown>();

    plugin.register({
      pluginConfig: { brainRoot: root },
      registerTool(tool: unknown) {
        registeredTools.push(tool);
      },
      on(name: string, handler: (...args: never[]) => unknown) {
        hooks.set(name, handler);
      },
      logger: { warn() {} },
    } as never);

    expect(registeredTools).toHaveLength(1);
    expect(typeof registeredTools[0]).toBe("function");
    const factory = registeredTools[0] as (context: {
      sessionKey?: string;
    }) => Array<{
      name: string;
      execute(
        toolCallId: string,
        params: unknown,
      ): Promise<{ details: unknown }>;
    }>;
    const tools = factory({ sessionKey: "host-session-1" });
    const begin = tools.find((tool) => tool.name === "brain_begin_query");
    const expand = tools.find((tool) => tool.name === "brain_expand_query");
    if (!begin || !expand) throw new Error("Expected hosted query tools");
    const started = await begin.execute("call-begin", {
      question: "Can I search the web?",
    });
    const session = started.details as { id: string };
    await expand.execute("call-expand", {
      queryId: session.id,
      tier: "sources",
      reason: "The wiki has no answer.",
    });

    const guard = hooks.get("before_tool_call");
    expect(guard).toBeDefined();
    await expect(
      guard?.(
        { toolName: "web_search", params: {} },
        { toolName: "web_search", sessionKey: "host-session-1" },
      ),
    ).resolves.toMatchObject({ block: true });
  });

  test("allows native web tools only after the host approves the active query", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-openclaw-approved-"));
    await initBrain(root, { name: "Hosted", description: "OpenClaw adapter" });
    const registeredTools: unknown[] = [];
    const hooks = new Map<string, (...args: never[]) => unknown>();

    plugin.register({
      pluginConfig: { brainRoot: root },
      registerTool(tool: unknown) {
        registeredTools.push(tool);
      },
      on(name: string, handler: (...args: never[]) => unknown) {
        hooks.set(name, handler);
      },
      logger: { warn() {} },
    } as never);

    const factory = registeredTools[0] as (context: {
      sessionKey?: string;
    }) => Array<{
      name: string;
      execute(
        toolCallId: string,
        params: unknown,
      ): Promise<{ details: unknown }>;
    }>;
    const tools = factory({ sessionKey: "host-session-2" });
    const begin = tools.find((tool) => tool.name === "brain_begin_query");
    const expand = tools.find((tool) => tool.name === "brain_expand_query");
    const request = tools.find(
      (tool) => tool.name === "brain_request_web_approval",
    );
    const resolve = tools.find(
      (tool) => tool.name === "brain_resolve_web_approval",
    );
    if (!begin || !expand || !request || !resolve) {
      throw new Error("Expected hosted web approval tools");
    }
    const session = (
      await begin.execute("call-begin", { question: "Can I search the web?" })
    ).details as { id: string };
    await expand.execute("call-expand", {
      queryId: session.id,
      tier: "sources",
      reason: "The wiki has no answer.",
    });
    await request.execute("call-request", {
      queryId: session.id,
      reason: "The local source catalog is insufficient.",
    });

    const guard = hooks.get("before_tool_call");
    const approval = (await guard?.(
      {
        toolName: "brain_resolve_web_approval",
        params: { queryId: session.id, approved: true },
      },
      { toolName: "brain_resolve_web_approval", sessionKey: "host-session-2" },
    )) as {
      requireApproval?: { onResolution?: (decision: string) => Promise<void> };
    };
    expect(approval.requireApproval).toBeDefined();
    await approval.requireApproval?.onResolution?.("allow-once");
    await resolve.execute("call-resolve", {
      queryId: session.id,
      approved: true,
    });

    await expect(
      guard?.(
        { toolName: "web_search", params: {} },
        { toolName: "web_search", sessionKey: "host-session-2" },
      ),
    ).resolves.toBeUndefined();
  });

  test("retries an eligible pending sync when the hosted gateway starts", async () => {
    const { root, remote } = await hostedGitBrain();
    const tools = createBrainToolHandlers(root);
    const session = await tools.brain_begin_query({
      question: "What remains available locally?",
    });
    const hook = path.join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const local = await tools.brain_finish_query({
      queryId: session.id,
      outcome: "answered",
      answerSummary: "The existing wiki required no additional mutation.",
    });
    if (!local.commit) throw new Error("Expected a local query commit");
    await writeFile(hook, "#!/bin/sh\nexit 0\n");

    const hooks = new Map<string, (...args: never[]) => unknown>();
    plugin.register({
      pluginConfig: { brainRoot: root },
      registerTool() {},
      on(name: string, handler: (...args: never[]) => unknown) {
        hooks.set(name, handler);
      },
      logger: { warn() {} },
    } as never);

    const startup = hooks.get("gateway_start");
    expect(startup).toBeDefined();
    await startup?.({ port: 4312 }, {});

    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      local.commit,
    );
  });

  test("injects setup and sync status into the hosted prompt context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-openclaw-context-"));
    await initBrain(root, { name: "Hosted", description: "OpenClaw adapter" });
    const hooks = new Map<string, (...args: never[]) => unknown>();

    plugin.register({
      pluginConfig: { brainRoot: root },
      registerTool() {},
      on(name: string, handler: (...args: never[]) => unknown) {
        hooks.set(name, handler);
      },
      logger: { warn() {} },
    } as never);

    const hook = hooks.get("before_prompt_build");
    expect(hook).toBeDefined();
    await expect(
      hook?.({ prompt: "", messages: [] }, {}),
    ).resolves.toMatchObject({
      prependSystemContext: expect.stringContaining("setup=not-started"),
    });
    await expect(
      hook?.({ prompt: "", messages: [] }, {}),
    ).resolves.toMatchObject({
      prependSystemContext: expect.stringContaining("sync=unconfigured"),
    });
  });

  test("registers a structural schema for brain change sets", () => {
    const registered: unknown[] = [];
    plugin.register({
      pluginConfig: { brainRoot: "/brain" },
      registerTool(tool: unknown) {
        registered.push(tool);
      },
      on() {},
      logger: { warn() {} },
    } as never);

    expect(registered).toHaveLength(1);
    const factory = registered[0] as (context: {
      sessionKey?: string;
    }) => Array<{
      name: string;
      parameters: unknown;
    }>;
    const apply = factory({ sessionKey: "schema-session" }).find(
      (tool) => tool.name === "brain_apply",
    );
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
