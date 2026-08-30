export { brainConfigV1Schema, loadBrainConfig } from "./config.js";
export {
  defaultIssueTrackerUrl,
  defaultSemanticModelV1,
} from "./config.js";
export type { BrainConfigV1 } from "./config.js";
export {
  beginSetup,
  attachSetupChange,
  finishSetup,
  nextSetupBatch,
  pendingReadySourceIds,
  setupSessionV1Schema,
} from "./setup.js";
export type {
  BeginSetupInput,
  FinishSetupInput,
  SetupBatchV1,
  SetupSourceContextV1,
  SetupSessionV1,
} from "./setup.js";
export {
  brainStateV1Schema,
  defaultBrainState,
  readBrainState,
  semanticIndexMetadataV1Schema,
  setupStateV1Schema,
  syncStatusV1Schema,
  syncTargetV1Schema,
  writeBrainState,
} from "./state.js";
export type {
  BrainStateV1,
  SemanticIndexMetadataV1,
  SetupStateV1,
  SyncStatusV1,
  SyncTargetV1,
} from "./state.js";
export { initBrain } from "./init.js";
export type { InitBrainOptions, InitBrainResultV1 } from "./init.js";
export { renderBrainCharter, setBrainCharter } from "./charter.js";
export type { BrainCharterResultV1 } from "./charter.js";
export {
  brainCharterV1Schema,
  inspectOnboarding,
  onboardingNextActionV1Schema,
  onboardingPhaseV1Schema,
  onboardingStatusV1Schema,
} from "./onboarding.js";
export type {
  BrainCharterV1,
  OnboardingNextActionV1,
  OnboardingPhaseV1,
  OnboardingStatusV1,
} from "./onboarding.js";
export { doctorBrain } from "./doctor.js";
export type { DoctorIssue, DoctorReport } from "./doctor.js";
export { scanSources } from "./sources/scan.js";
export { supersedeSource } from "./sources/supersede.js";
export {
  docxOutputPolicyV1Schema,
  sourceRecordV1Schema,
} from "./sources/types.js";
export type {
  DocxOutputPolicyV1,
  ExtractedSourceV1,
  SourceChunkV1,
  SourceRecordV1,
  SourceScanResult,
} from "./sources/types.js";
export {
  rebuildSearchIndex,
  searchBrain,
  searchResultV1Schema,
} from "./search.js";
export type { SearchOptions, SearchResult, SearchScope } from "./search.js";
export {
  createLocalEmbeddingProvider,
  prepareSemanticModel,
  rebuildSemanticIndex,
  semanticSearch,
} from "./semantic.js";
export type { BrainRuntimeServices, EmbeddingProvider } from "./semantic.js";
export {
  calculatePageRevision,
  extractCitations,
  extractHeadingAnchors,
  extractWikiLinks,
  parseWikiPage,
  renderWikiPage,
} from "./wiki/page.js";
export type { WikiLinkV1 } from "./wiki/page.js";
export {
  changeSetV1Schema,
  citationV1Schema,
  pageMutationV1Schema,
  readReceiptV1Schema,
  reconciliationCandidateV1Schema,
  reconciliationPlanV1Schema,
  reconciliationReasonV1Schema,
  reconciliationReceiptV1Schema,
  relationV1Schema,
  wikiPageV1Schema,
} from "./wiki/types.js";
export {
  auditIssueV1Schema,
  auditReportV1Schema,
  calculateCatalogRevision,
  loadWikiPages,
  validateWikiGraph,
} from "./wiki/graph.js";
export type { AuditIssueV1, AuditReportV1 } from "./wiki/graph.js";
export { writeGeneratedWikiFiles } from "./wiki/generated.js";
export {
  applyWikiChangeSet,
  buildReconciliationCandidates,
  proposeWikiPageChanges,
} from "./wiki/mutate.js";
export type {
  ChangeSetV1,
  CitationV1,
  PageMutationV1,
  ReadReceiptV1,
  ReconciliationCandidateV1,
  ReconciliationPlanV1,
  ReconciliationReasonV1,
  ReconciliationReceiptV1,
  RelationV1,
  WikiPageV1,
} from "./wiki/types.js";
export {
  assertReconciliationPlanMatches,
  assertReconciliationReceipt,
  planReconciliation,
} from "./reconciliation.js";
export {
  applyChangeSetTransaction,
  operationRecordV1Schema,
  recoverBrain,
} from "./transaction.js";
export type {
  ApplyTransactionOptions,
  KnowledgeMutationContext,
  OperationRecordV1,
  TransactionResult,
  TransactionTestOptions,
} from "./transaction.js";
export {
  beginQuery,
  expandQuery,
  nextBootstrapBatch,
  querySessionV1Schema,
  readQueryItem,
  readQuerySession,
  writeQuerySession,
} from "./query.js";
export type { QueryReadResultV1, QuerySessionV1 } from "./query.js";
export type { ExpandQueryOptions } from "./query.js";
export type {
  BootstrapBatchV1,
  BootstrapSourceContextV1,
} from "./query.js";
export {
  assertWebApproval,
  calculateQuestionHash,
  requestWebApproval,
  resolveWebApproval,
  webApprovalRequestV1Schema,
  webApprovalV1Schema,
} from "./web-approval.js";
export type {
  RequestWebApprovalInput,
  ResolveWebApprovalInput,
  WebApprovalRequestV1,
  WebApprovalV1,
} from "./web-approval.js";
export {
  attemptManagedSync,
  configureSyncTarget,
  fingerprintRemoteUrl,
  formatSyncWarning,
  syncStatus,
} from "./sync.js";
export type {
  ConfigureSyncTargetInput,
  ConfigureSyncTargetResult,
} from "./sync.js";
export {
  scanAndRegisterSources,
  supersedeRegisteredSource,
} from "./source-transaction.js";
export type { SourceSupersessionResult } from "./source-transaction.js";
export { captureWebEvidence } from "./web-capture.js";
export type {
  WebCaptureInput,
  WebCaptureResult,
  WebCaptureTestOptions,
} from "./web-capture.js";
export { attachQueryChange, finishQuery } from "./query-finish.js";
export type {
  FinishQueryOptions,
  FinishQueryResult,
} from "./query-finish.js";
export {
  auditBrain,
  nextSemanticAuditBatch,
  recordSemanticAuditBatch,
} from "./audit.js";
export { readBrainItem, statusBrain } from "./status-read.js";
export type { BrainReadResultV1, BrainStatusV1 } from "./status-read.js";
export type {
  RecordSemanticAuditInput,
  RecordSemanticAuditResult,
  SemanticAuditBatchV1,
} from "./audit.js";
export { brainJsonSchemasV1 } from "./json-schemas.js";
export type { PublicSchemaNameV1 } from "./json-schemas.js";
