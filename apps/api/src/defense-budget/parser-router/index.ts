/** Public Phase 3 parser-router API. */
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

export { ROUTER_STATE_TRANSITIONS, assertRouterStateTransition } from './router-state-machine.js';

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

export {
  FilesystemParserArtifactStore,
  S3ParserArtifactStore,
  NoOpParserRunRecorder,
  reuseOrCreate,
  type ParserArtifactStoreV1,
  type ParserArtifactObjectStoreV1,
  type ParserRunRecorderV1,
} from './parser-artifact-store.js';
export { MethodRoutingParserArtifactStore } from './method-routing-parser-artifact-store.js';
export {
  ProofBoundParserRunRecorder,
  type ParserOutputByteReaderV1,
} from './proof-bound-parser-run-recorder.js';
export {
  AwsParserArtifactObjectStore,
  createS3ParserArtifactStore,
} from './s3-parser-artifact-store.js';
export { PrismaParserRunRecorder } from './prisma-parser-run-recorder.js';
export {
  createProductionParserVerificationContext,
  type ProductionParserVerificationContextV1,
} from './production-parser-verification-context.js';
export { getDefaultParserConfig } from './parser-engine-defaults.js';
export {
  LocalParserRuntimeClient,
  type LocalParserRuntimeClientOptions,
  type ExecuteJobResult,
  type ParserRuntimeVersionInfoV1,
} from './local-parser-runtime-client.js';

export { CostAccumulator, type ParserCostReportV1 } from './cost-accounting.js';

export {
  pagesToContiguousRanges,
  buildContributingParserRuns,
  buildExtractionArtifact,
  type ExtractionArtifactBridgeInput,
  type ExtractionArtifactBridgeOutput,
} from './extraction-artifact-bridge.js';

export {
  verifyNativeStructuredCompanion,
  type NativeStructuredCompanionResultV1,
} from './native-structured-companion.js';

export {
  ParserRouterV1Service,
  type ParserRouterConfigV1,
  type ParserRouterDependencies,
  type ParserRouterTerminalOutputV1,
  type ExecutionRoundReportV1,
} from './parser-router-v1.service.js';
