import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { brainJsonSchemasV1 } from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const expectedSchemas = [
  "AuditReportV1",
  "BrainCharterV1",
  "BrainConfigV1",
  "BrainStateV1",
  "ChangeSetV1",
  "OnboardingStatusV1",
  "OperationRecordV1",
  "QuerySessionV1",
  "ReadReceiptV1",
  "ReconciliationPlanV1",
  "ReconciliationReceiptV1",
  "RelationV1",
  "SemanticIndexMetadataV1",
  "SetupSessionV1",
  "SetupStateV1",
  "SourceRecordV1",
  "SourceReviewDecisionBatchV1",
  "SourceReviewV1",
  "SyncStatusV1",
  "SyncTargetV1",
  "WebApprovalRequestV1",
  "WebApprovalV1",
  "WebArtifactSidecarV1",
  "WikiPageV1",
] as const;

describe("public JSON schemas", () => {
  it("exports and checks in every versioned public contract", async () => {
    expect(Object.keys(brainJsonSchemasV1).sort()).toEqual(expectedSchemas);

    for (const name of expectedSchemas) {
      const schema = JSON.parse(
        await readFile(
          resolve(repositoryRoot, `schemas/v1/${name}.schema.json`),
          "utf8",
        ),
      );
      expect(schema).toEqual(brainJsonSchemasV1[name]);
      expect(schema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `https://portable-second-brain.dev/schemas/v1/${name}.schema.json`,
        title: name,
      });
    }
  });

  it("emits complete duplicate companion fingerprints as an all-or-none shape", () => {
    const emittedBrainState = z.fromJSONSchema(
      brainJsonSchemasV1.BrainStateV1 as Parameters<typeof z.fromJSONSchema>[0],
    );
    const state = {
      version: 1,
      catalogRevision: "empty",
      knowledgeMutations: 0,
      lastSemanticAuditMutation: 0,
      sourceDuplicates: [
        {
          path: "sources/web/2026/08/copy.txt",
          sourceId: "src_0123456789abcdef",
          sha256: "a".repeat(64),
          bytes: 12,
          sidecarPath: "sources/web/2026/08/.copy.txt.web.json",
        },
      ],
    };

    expect(emittedBrainState.safeParse(state).success).toBe(false);
    expect(
      emittedBrainState.safeParse({
        ...state,
        sourceDuplicates: [
          {
            path: "sources/copy.txt",
            sourceId: "src_0123456789abcdef",
            sha256: "a".repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      emittedBrainState.safeParse({
        ...state,
        sourceDuplicates: [
          {
            ...state.sourceDuplicates[0],
            sidecarSha256: "b".repeat(64),
            sidecarBytes: 34,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("emits exact source-review decision combinations", () => {
    const emittedDecisionBatch = z.fromJSONSchema(
      brainJsonSchemasV1.SourceReviewDecisionBatchV1 as Parameters<
        typeof z.fromJSONSchema
      >[0],
    );
    const decision = {
      version: 1,
      decisions: [
        {
          path: "sources/astronomy.md",
          sha256: "a".repeat(64),
          decision: "include",
          basis: "agent-in-scope",
          reason: "Directly supports the astronomy scope.",
        },
      ],
    };

    expect(emittedDecisionBatch.safeParse(decision).success).toBe(true);
    expect(
      emittedDecisionBatch.safeParse({
        ...decision,
        decisions: [
          {
            ...decision.decisions[0],
            decision: "exclude",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
