import { describe, expect, test } from "vitest";
import { auditReportV1Schema, operationRecordV1Schema } from "../src/index.js";

describe("versioned public schemas", () => {
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
});
