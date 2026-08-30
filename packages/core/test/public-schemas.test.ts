import { describe, expect, test } from "vitest";
import {
  auditReportV1Schema,
  brainCharterV1Schema,
  onboardingStatusV1Schema,
  operationRecordV1Schema,
  webArtifactSidecarV1Schema,
} from "../src/index.js";

describe("versioned public schemas", () => {
  test("exports reconciliation contracts for host agents", async () => {
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;

    expect(exports).toHaveProperty("reconciliationPlanV1Schema");
    expect(exports).toHaveProperty("reconciliationReceiptV1Schema");
    expect(exports).toHaveProperty("readReceiptV1Schema");
  });

  test("exports state contracts that default omitted v1 fields safely", async () => {
    const exports = (await import("../src/index.js")) as Record<
      string,
      unknown
    >;

    expect(exports).toHaveProperty("brainStateV1Schema");
    const stateSchema = exports.brainStateV1Schema as {
      parse(value: unknown): unknown;
    };
    expect(
      stateSchema.parse({
        version: 1,
        catalogRevision: "empty",
        knowledgeMutations: 0,
        lastSemanticAuditMutation: 0,
        bootstrap: { status: "pending", pendingSourceIds: [] },
      }),
    ).toMatchObject({
      setup: { status: "not-started", pendingSourceIds: [] },
    });
  });

  test("validates operation and audit records at the package boundary", () => {
    expect(
      operationRecordV1Schema.parse({
        version: 1,
        id: "op_test",
        kind: "query",
        status: "completed",
        startedAt: "2026-08-23T00:00:00.000Z",
        completedAt: "2026-08-23T00:00:01.000Z",
        summary: "Answered a question",
        pageIds: [],
        tiersUsed: ["wiki"],
        queryId: "qry_0123456789abcdef0123456789abcdef",
      }),
    ).toMatchObject({ version: 1, kind: "query" });
    expect(
      auditReportV1Schema.parse({
        version: 1,
        ok: true,
        catalogRevision: "empty",
        pageCount: 0,
        edgeCount: 0,
        orphanPageIds: [],
        issues: [],
      }),
    ).toMatchObject({ version: 1, ok: true });
    expect(() => operationRecordV1Schema.parse({ version: 2 })).toThrow();
  });

  test("validates versioned onboarding and charter contracts", () => {
    expect(
      brainCharterV1Schema.parse({
        version: 1,
        description: "Astronomy observations and orbital mechanics.",
        purpose: "Answer source-backed astronomy questions.",
        boundaries: ["Include registered astronomy sources."],
        domainConventions: ["Preserve astronomical terminology."],
        evidencePreferences: ["Prefer primary sources."],
        origin: "inferred",
      }),
    ).toMatchObject({ version: 1, origin: "inferred" });
    expect(() => onboardingStatusV1Schema.parse({ version: 2 })).toThrow();
  });

  test("exports the durable web artifact sidecar contract", () => {
    expect(
      webArtifactSidecarV1Schema.parse({
        brainWebArtifact: 1,
        sourcePath: "sources/web/2026/08/orbits-0716f9264c9f.pdf",
        artifactSha256:
          "0716f9264c9fe19f5d7455276107f3ddcc1d3497f63d60689a73558ae8a1bf5e",
        artifactBytes: 9,
        title: "Orbits",
        format: "pdf",
        mediaType: "application/pdf",
        discovery: {
          originalUrl: "https://example.com/orbits.pdf",
          finalUrl: "https://example.com/orbits.pdf",
          redirectChain: [],
          retrievedAt: "2026-08-30T00:00:00.000Z",
          queryId: "qry_0123456789abcdef0123456789abcdef",
          questionHash: "c".repeat(64),
          query: "What does the orbit report conclude?",
          representation: "artifact",
          completeness: "complete",
        },
      }),
    ).toMatchObject({ brainWebArtifact: 1, format: "pdf" });
  });
});
