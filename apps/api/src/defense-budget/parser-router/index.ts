/**
 * Barrel exports for the defense-budget parser-router module.
 */

// Workstream A: Runtime contracts and state machine
export {
  DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
  DEFENSE_BUDGET_PARSER_RESULT_SCHEMA_VERSION,
  DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION,
  PARSER_RUNTIME_ENGINE_V1_VALUES,
  parserRuntimeEngineV1Schema,
  PARSER_DOCUMENT_STATE_V1_VALUES,
  PARSER_STATE_TRANSITIONS,
  isTerminalState,
  isValidTransition,
  assertValidTransition,
  parserRuntimeJobV1Schema,
  parserRuntimeResultV1Schema,
  parserPageResultV1Schema,
  parserPageFailureV1Schema,
  parserRuntimeWarningV1Schema,
  parserRuntimeMetricsV1Schema,
  parserArtifactDescriptorV1Schema,
  layoutBlockV1Schema,
  parsedTableV1Schema,
  parsedTableCellV1Schema,
  parsedImageRegionV1Schema,
  evidencePrecisionV1Schema,
  computeParserRunCacheKey,
  computeParserRunId,
  computeParserConfigSha256,
  computeResultContentSha256,
  sealParserRuntimeResult,
  verifyResultContentSha256,
  pageRangeKey,
  parseParserRuntimeJobV1,
  parseParserRuntimeResultV1,
  parseParserArtifactDescriptorV1,
  type ParserRuntimeJobV1,
  type ParserRuntimeResultV1,
  type ParserRuntimeEngineV1,
  type ParserDocumentStateV1,
  type ParserPageResultV1,
  type ParserPageFailureV1,
  type ParserRuntimeWarningV1,
  type ParserRuntimeMetricsV1,
  type ParserArtifactDescriptorV1,
  type ParserRunIdentityV1,
  type LayoutBlockV1,
  type ParsedTableV1,
  type ParsedTableCellV1,
  type ParsedImageRegionV1,
  type EvidencePrecisionV1,
} from './parser-runtime-contract-v1.js';

// Workstream B: Page profiler
export {
  pageProfileV1Schema,
  documentProfileSummaryV1Schema,
  documentProfileResultV1Schema,
  profilingThresholdsV1Schema,
  DEFAULT_PROFILING_THRESHOLDS,
  computeProfilingConfigSha256,
  computeProfileContentSha256,
  parseDocumentProfileResultV1,
  type PageProfileV1,
  type DocumentProfileSummaryV1,
  type DocumentProfileResultV1,
  type ProfilingThresholdsV1,
} from './page-profiler.js';

// Workstream C: Route planner and escalation
export {
  parserPlanStepV1Schema,
  defenseBudgetParsePlanV1Schema,
  parserCorrectableFindingV1Schema,
  buildInitialParsePlan,
  buildEscalationPlan,
  isParserCorrectable,
  PARSER_CORRECTABLE_FINDING_CODES,
  NON_PARSER_CORRECTABLE_FINDING_CODES,
  DEFAULT_MAX_ESCALATION_ROUNDS,
  parseDefenseBudgetParsePlanV1,
  type DefenseBudgetParsePlanV1,
  type ParserPlanStepV1,
  type ParserCorrectableFindingV1,
} from './route-planner.js';

export {
  mapCorrectableFindings,
  resolveFindingPages,
  planEscalationFromVerification,
  type VerificationFindingV1,
  type VerificationResultMinimalV1,
} from './escalation-planner.js';

// Workstream D: Artifact store and replay
export {
  FilesystemParserArtifactStore,
  S3ParserArtifactStore,
  NoOpParserRunRecorder,
  reuseOrCreate,
  type ParserArtifactStoreV1,
  type ParserRunRecorderV1,
} from './parser-artifact-store.js';

export { PrismaParserRunRecorder } from './prisma-parser-run-recorder.js';

// Cost accounting
export { CostAccumulator, type ParserCostReportV1 } from './cost-accounting.js';
