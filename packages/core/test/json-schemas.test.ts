import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { brainJsonSchemasV1 } from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const expectedSchemas = [
  "AuditReportV1",
  "BrainConfigV1",
  "BrainStateV1",
  "ChangeSetV1",
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
  "SyncStatusV1",
  "SyncTargetV1",
  "WebApprovalRequestV1",
  "WebApprovalV1",
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
});
