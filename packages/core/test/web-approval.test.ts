import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  beginQuery,
  captureWebEvidence,
  expandQuery,
  finishQuery,
  initBrain,
  readBrainState,
  readQuerySession,
  writeBrainState,
  writeQuerySession,
} from "../src/index.js";

async function sourceTierQuery(): Promise<{ root: string; queryId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-web-approval-"));
  await initBrain(root, {
    name: "Research",
    description: "Web approval tests",
  });
  const query = await beginQuery(root, "What did Project Zephyr discover?");
  await expandQuery(root, query.id, {
    tier: "sources",
    reason: "The wiki has no evidence about Project Zephyr.",
  });
  return { root, queryId: query.id };
}

afterEach(() => vi.useRealTimers());

describe("question-scoped web approval", () => {
  test("requires an approval bound to the active query before entering web", async () => {
    const { root, queryId } = await sourceTierQuery();

    await expect(
      expandQuery(root, queryId, {
        tier: "web",
        reason: "Local evidence is insufficient.",
      }),
    ).rejects.toThrow(/web approval/i);
  });

  test("permits several captures under one approved active question", async () => {
    const { root, queryId } = await sourceTierQuery();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    expect(exports).toHaveProperty("requestWebApproval");
    expect(exports).toHaveProperty("resolveWebApproval");
    const requestWebApproval = exports.requestWebApproval as (
      root: string,
      queryId: string,
      input: { reason: string; hostSessionId: string },
    ) => Promise<unknown>;
    const resolveWebApproval = exports.resolveWebApproval as (
      root: string,
      queryId: string,
      input: { approved: boolean; decidedBy: string },
    ) => Promise<unknown>;
    const captureWebEvidence = exports.captureWebEvidence as (
      root: string,
      queryId: string,
      input: {
        url: string;
        title: string;
        captureKind: "snippet";
        content: string;
        retrievedAt: string;
      },
    ) => Promise<{ source: { id: string } }>;

    await requestWebApproval(root, queryId, {
      reason: "Local sources do not answer the question.",
      hostSessionId: "host-session-123",
    });
    await resolveWebApproval(root, queryId, {
      approved: true,
      decidedBy: "owner",
    });
    await expandQuery(root, queryId, {
      tier: "web",
      reason: "The approved local-evidence gap remains unresolved.",
    });

    const first = await captureWebEvidence(root, queryId, {
      url: "https://example.test/zephyr-report",
      title: "Zephyr report",
      captureKind: "snippet",
      content: "The report describes an unverified possible biosignature.",
      retrievedAt: "2026-08-27T00:00:00.000Z",
    });
    const second = await captureWebEvidence(root, queryId, {
      url: "https://example.test/zephyr-data",
      title: "Zephyr data",
      captureKind: "snippet",
      content: "The data release contains no confirmed life detection.",
      retrievedAt: "2026-08-27T00:01:00.000Z",
    });

    expect(first.source.id).not.toBe(second.source.id);
  });

  test("keeps a denied request at the local sources tier", async () => {
    const { root, queryId } = await sourceTierQuery();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const requestWebApproval = exports.requestWebApproval as (
      root: string,
      queryId: string,
      input: { reason: string; hostSessionId: string },
    ) => Promise<unknown>;
    const resolveWebApproval = exports.resolveWebApproval as (
      root: string,
      queryId: string,
      input: { approved: boolean; decidedBy: string },
    ) => Promise<unknown>;

    await requestWebApproval(root, queryId, {
      reason: "Local sources are insufficient.",
      hostSessionId: "host-session-123",
    });
    await resolveWebApproval(root, queryId, {
      approved: false,
      decidedBy: "owner",
    });

    await expect(
      expandQuery(root, queryId, {
        tier: "web",
        reason: "The owner denied web research for this question.",
      }),
    ).rejects.toThrow(/denied|web approval/i);
    expect((await readQuerySession(root, queryId)).currentTier).toBe("sources");
  });

  test("does not replace an approved full-question grant with a new request", async () => {
    const { root, queryId } = await sourceTierQuery();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const requestWebApproval = exports.requestWebApproval as (
      root: string,
      queryId: string,
      input: { reason: string; hostSessionId: string },
    ) => Promise<unknown>;
    const resolveWebApproval = exports.resolveWebApproval as (
      root: string,
      queryId: string,
      input: { approved: boolean; decidedBy: string },
    ) => Promise<unknown>;
    await requestWebApproval(root, queryId, {
      reason: "Local sources are insufficient.",
      hostSessionId: "host-session-123",
    });
    await resolveWebApproval(root, queryId, {
      approved: true,
      decidedBy: "owner",
    });

    await expect(
      requestWebApproval(root, queryId, {
        reason: "A second request must not replace the active grant.",
        hostSessionId: "host-session-123",
      }),
    ).rejects.toThrow(/already approved/i);
    expect((await readQuerySession(root, queryId)).webApproval).toMatchObject({
      status: "approved",
    });
  });

  test("rejects a direct web capture without an approved grant", async () => {
    const { root, queryId } = await sourceTierQuery();
    const session = await readQuerySession(root, queryId);
    session.currentTier = "web";
    session.tiersUsed.push("web");
    await writeQuerySession(root, session);

    await expect(
      captureWebEvidence(root, queryId, {
        url: "https://example.test/zephyr-report",
        title: "Zephyr report",
        captureKind: "snippet",
        content: "An unapproved capture must not become evidence.",
        retrievedAt: "2026-08-27T00:00:00.000Z",
      }),
    ).rejects.toThrow(/web approval/i);
    await expect(
      readdir(path.join(root, "sources", "web")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects an approved request after its 24-hour lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    const { root, queryId } = await sourceTierQuery();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const requestWebApproval = exports.requestWebApproval as (
      root: string,
      queryId: string,
      input: { reason: string; hostSessionId: string },
    ) => Promise<unknown>;
    const resolveWebApproval = exports.resolveWebApproval as (
      root: string,
      queryId: string,
      input: { approved: boolean; decidedBy: string },
    ) => Promise<unknown>;
    await requestWebApproval(root, queryId, {
      reason: "Local sources are insufficient.",
      hostSessionId: "host-session-123",
    });
    await resolveWebApproval(root, queryId, {
      approved: true,
      decidedBy: "owner",
    });
    vi.setSystemTime(new Date("2026-08-28T00:00:00.001Z"));

    await expect(
      expandQuery(root, queryId, {
        tier: "web",
        reason: "The local-evidence gap remains unresolved.",
      }),
    ).rejects.toThrow(/expired/i);
  });

  test("reports an expiry when the owner decides after the request lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    const { root, queryId } = await sourceTierQuery();
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const requestWebApproval = exports.requestWebApproval as (
      root: string,
      queryId: string,
      input: { reason: string; hostSessionId: string },
    ) => Promise<unknown>;
    const resolveWebApproval = exports.resolveWebApproval as (
      root: string,
      queryId: string,
      input: { approved: boolean; decidedBy: string },
    ) => Promise<unknown>;
    await requestWebApproval(root, queryId, {
      reason: "Local sources are insufficient.",
      hostSessionId: "host-session-123",
    });
    vi.setSystemTime(new Date("2026-08-28T00:00:00.001Z"));

    await expect(
      resolveWebApproval(root, queryId, {
        approved: true,
        decidedBy: "owner",
      }),
    ).rejects.toThrow(/expired/i);
  });

  test("rejects a web-tier finish after its approval expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    const { root, queryId } = await sourceTierQuery();
    const state = await readBrainState(root);
    await writeBrainState(root, {
      ...state,
      setup: {
        status: "completed",
        id: "setup_0123456789abcdef0123456789abcdef",
        purpose: "Research evidence",
        startedAt: "2026-08-27T00:00:00.000Z",
        completedAt: "2026-08-27T00:00:00.000Z",
        initialSourceIds: [],
        pendingSourceIds: [],
      },
    });
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;
    const requestWebApproval = exports.requestWebApproval as (
      root: string,
      queryId: string,
      input: { reason: string; hostSessionId: string },
    ) => Promise<unknown>;
    const resolveWebApproval = exports.resolveWebApproval as (
      root: string,
      queryId: string,
      input: { approved: boolean; decidedBy: string },
    ) => Promise<unknown>;
    await requestWebApproval(root, queryId, {
      reason: "Local sources are insufficient.",
      hostSessionId: "host-session-123",
    });
    await resolveWebApproval(root, queryId, {
      approved: true,
      decidedBy: "owner",
    });
    await expandQuery(root, queryId, {
      tier: "web",
      reason: "The local-evidence gap remains unresolved.",
    });
    vi.setSystemTime(new Date("2026-08-28T00:00:00.001Z"));

    await expect(
      finishQuery(root, queryId, {
        outcome: "unanswered",
        answerSummary:
          "The web evidence was not captured before approval expired.",
      }),
    ).rejects.toThrow(/expired/i);
  });
});
