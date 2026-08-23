export { brainConfigV1Schema, loadBrainConfig } from "./config.js";
export type { BrainConfigV1 } from "./config.js";
export { initBrain } from "./init.js";
export type { InitBrainOptions } from "./init.js";
export { doctorBrain } from "./doctor.js";
export type { DoctorIssue, DoctorReport } from "./doctor.js";
export { scanSources } from "./sources/scan.js";
export { supersedeSource } from "./sources/supersede.js";
export { sourceRecordV1Schema } from "./sources/types.js";
export type {
  ExtractedSourceV1,
  SourceChunkV1,
  SourceRecordV1,
  SourceScanResult,
} from "./sources/types.js";
export { rebuildSearchIndex, searchBrain } from "./search.js";
export type { SearchOptions, SearchResult, SearchScope } from "./search.js";
