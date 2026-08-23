import { z } from "zod";
import { operationRecordV1Schema } from "./transaction.js";
import { brainConfigV1Schema } from "./config.js";
import { querySessionV1Schema } from "./query.js";
import { sourceRecordV1Schema } from "./sources/types.js";
import { auditReportV1Schema } from "./wiki/graph.js";
import {
  changeSetV1Schema,
  relationV1Schema,
  wikiPageV1Schema,
} from "./wiki/types.js";

export type PublicSchemaNameV1 =
  | "AuditReportV1"
  | "BrainConfigV1"
  | "ChangeSetV1"
  | "OperationRecordV1"
  | "QuerySessionV1"
  | "RelationV1"
  | "SourceRecordV1"
  | "WikiPageV1";

function jsonSchema(
  name: PublicSchemaNameV1,
  schema: z.ZodType,
): Record<string, unknown> {
  return {
    ...z.toJSONSchema(schema, { target: "draft-2020-12" }),
    $id: `https://portable-second-brain.dev/schemas/v1/${name}.schema.json`,
    title: name,
  };
}

export const brainJsonSchemasV1: Record<
  PublicSchemaNameV1,
  Record<string, unknown>
> = {
  AuditReportV1: jsonSchema("AuditReportV1", auditReportV1Schema),
  BrainConfigV1: jsonSchema("BrainConfigV1", brainConfigV1Schema),
  ChangeSetV1: jsonSchema("ChangeSetV1", changeSetV1Schema),
  OperationRecordV1: jsonSchema("OperationRecordV1", operationRecordV1Schema),
  QuerySessionV1: jsonSchema("QuerySessionV1", querySessionV1Schema),
  RelationV1: jsonSchema("RelationV1", relationV1Schema),
  SourceRecordV1: jsonSchema("SourceRecordV1", sourceRecordV1Schema),
  WikiPageV1: jsonSchema("WikiPageV1", wikiPageV1Schema),
};
