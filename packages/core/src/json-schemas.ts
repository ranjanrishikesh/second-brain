import { z } from "zod";
import { operationRecordV1Schema } from "./transaction.js";
import {
  brainCharterV1Schema,
  onboardingStatusV1Schema,
} from "./onboarding.js";
import { brainConfigV1Schema } from "./config.js";
import { querySessionV1Schema } from "./query.js";
import { setupSessionV1Schema } from "./setup.js";
import { sourceRecordV1Schema } from "./sources/types.js";
import {
  sourceReviewDecisionBatchV1Schema,
  sourceReviewV1Schema,
} from "./sources/review-types.js";
import { webArtifactSidecarV1Schema } from "./sources/web-evidence.js";
import {
  webApprovalRequestV1Schema,
  webApprovalV1Schema,
} from "./web-approval.js";
import {
  brainStateV1Schema,
  semanticIndexMetadataV1Schema,
  setupStateV1Schema,
  syncStatusV1Schema,
  syncTargetV1Schema,
} from "./state.js";
import { auditReportV1Schema } from "./wiki/graph.js";
import {
  changeSetV1Schema,
  readReceiptV1Schema,
  reconciliationPlanV1Schema,
  reconciliationReceiptV1Schema,
  relationV1Schema,
  wikiPageV1Schema,
} from "./wiki/types.js";

export type PublicSchemaNameV1 =
  | "AuditReportV1"
  | "BrainConfigV1"
  | "BrainCharterV1"
  | "BrainStateV1"
  | "ChangeSetV1"
  | "OperationRecordV1"
  | "OnboardingStatusV1"
  | "QuerySessionV1"
  | "ReadReceiptV1"
  | "ReconciliationPlanV1"
  | "ReconciliationReceiptV1"
  | "RelationV1"
  | "SourceRecordV1"
  | "SourceReviewDecisionBatchV1"
  | "SourceReviewV1"
  | "SemanticIndexMetadataV1"
  | "SetupSessionV1"
  | "SetupStateV1"
  | "SyncStatusV1"
  | "SyncTargetV1"
  | "WebApprovalRequestV1"
  | "WebApprovalV1"
  | "WebArtifactSidecarV1"
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
  BrainCharterV1: jsonSchema("BrainCharterV1", brainCharterV1Schema),
  BrainStateV1: jsonSchema("BrainStateV1", brainStateV1Schema),
  ChangeSetV1: jsonSchema("ChangeSetV1", changeSetV1Schema),
  OperationRecordV1: jsonSchema("OperationRecordV1", operationRecordV1Schema),
  OnboardingStatusV1: jsonSchema(
    "OnboardingStatusV1",
    onboardingStatusV1Schema,
  ),
  QuerySessionV1: jsonSchema("QuerySessionV1", querySessionV1Schema),
  ReadReceiptV1: jsonSchema("ReadReceiptV1", readReceiptV1Schema),
  ReconciliationPlanV1: jsonSchema(
    "ReconciliationPlanV1",
    reconciliationPlanV1Schema,
  ),
  ReconciliationReceiptV1: jsonSchema(
    "ReconciliationReceiptV1",
    reconciliationReceiptV1Schema,
  ),
  RelationV1: jsonSchema("RelationV1", relationV1Schema),
  SourceRecordV1: jsonSchema("SourceRecordV1", sourceRecordV1Schema),
  SourceReviewDecisionBatchV1: jsonSchema(
    "SourceReviewDecisionBatchV1",
    sourceReviewDecisionBatchV1Schema,
  ),
  SourceReviewV1: jsonSchema("SourceReviewV1", sourceReviewV1Schema),
  SemanticIndexMetadataV1: jsonSchema(
    "SemanticIndexMetadataV1",
    semanticIndexMetadataV1Schema,
  ),
  SetupSessionV1: jsonSchema("SetupSessionV1", setupSessionV1Schema),
  SetupStateV1: jsonSchema("SetupStateV1", setupStateV1Schema),
  SyncStatusV1: jsonSchema("SyncStatusV1", syncStatusV1Schema),
  SyncTargetV1: jsonSchema("SyncTargetV1", syncTargetV1Schema),
  WebApprovalRequestV1: jsonSchema(
    "WebApprovalRequestV1",
    webApprovalRequestV1Schema,
  ),
  WebApprovalV1: jsonSchema("WebApprovalV1", webApprovalV1Schema),
  WebArtifactSidecarV1: jsonSchema(
    "WebArtifactSidecarV1",
    webArtifactSidecarV1Schema,
  ),
  WikiPageV1: jsonSchema("WikiPageV1", wikiPageV1Schema),
};
