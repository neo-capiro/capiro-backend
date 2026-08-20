export const NVIDIA_BATCH_REQUEST_SCHEMA_V1 = 'nvidia_batch_request_v1' as const;
export const NVIDIA_BATCH_RESULT_SCHEMA_V1 = 'nvidia_batch_result_v1' as const;
export const NVIDIA_BENCHMARK_CORPUS_SCHEMA_V1 =
  'phase8_session5_benchmark_corpus_v1' as const;
export const NVIDIA_BENCHMARK_RESULT_SCHEMA_V1 =
  'phase8_session5_benchmark_result_v1' as const;

export type NvidiaRoutingMode = 'benchmark' | 'fallback' | 'preferred';

export type NvidiaRoutingDecision =
  | 'DETERMINISTIC_PRIMARY'
  | 'NVIDIA_PRIMARY'
  | 'NVIDIA_FALLBACK'
  | 'MANUAL_REVIEW';

export type NvidiaParserMethod =
  | 'nemotron_parse'
  | 'nvidia_page_elements_table_structure'
  | 'nvidia_ocr';

export type NvidiaPageClass =
  | 'clean_vector_text'
  | 'complex_table'
  | 'scanned_image'
  | 'mixed_visual_layout'
  | 'identity_banner'
  | 'unknown';

export interface NvidiaProviderIdentityV1 {
  readonly provider: 'nvidia';
  readonly parserMethod: NvidiaParserMethod;
  readonly modelName: string;
  readonly modelVersion: string;
  readonly parserOptionsHash: string;
  readonly runtimeContractVersion: string;
}

export interface NvidiaBatchPageRequestV1 {
  readonly pageNumber: number;
  readonly pageClass: NvidiaPageClass;
  readonly decision: Extract<
    NvidiaRoutingDecision,
    'NVIDIA_PRIMARY' | 'NVIDIA_FALLBACK'
  >;
  readonly escalationReason: string;
  readonly escalationApproved: true;
  readonly cacheKey: string;
}

export interface NvidiaBatchRequestV1 {
  readonly schemaVersion: typeof NVIDIA_BATCH_REQUEST_SCHEMA_V1;
  readonly batchId: string;
  readonly sourceDocumentId: string;
  readonly sourceSha256: string;
  readonly source: Readonly<{
    bucket: string;
    key: string;
    versionId?: string;
  }>;
  readonly providerIdentity: NvidiaProviderIdentityV1;
  readonly pages: readonly NvidiaBatchPageRequestV1[];
  readonly requestedAt: string;
  readonly idempotencyKey: string;
}

export interface NvidiaProviderRunIdentityV1 {
  readonly executionModel: 'sagemaker_batch_transform' | 'aws_batch_gpu';
  readonly providerJobId: string;
  readonly providerJobArn?: string;
  readonly submittedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly instanceType?: string;
  readonly instanceCount?: number;
  readonly gpuSeconds?: number;
  readonly costUsd?: number;
}

export interface NvidiaPageArtifactV1 {
  readonly pageNumber: number;
  readonly text?: string;
  readonly markdown?: string;
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
  readonly tables: readonly Readonly<Record<string, unknown>>[];
  readonly confidence?: string;
  readonly evidencePrecision: 'page_only' | 'text_span' | 'cell_bbox';
  readonly warnings: readonly string[];
}

export interface NvidiaBatchResultV1 {
  readonly schemaVersion: typeof NVIDIA_BATCH_RESULT_SCHEMA_V1;
  readonly batchId: string;
  readonly sourceDocumentId: string;
  readonly sourceSha256: string;
  readonly providerIdentity: NvidiaProviderIdentityV1;
  readonly providerRun: NvidiaProviderRunIdentityV1;
  readonly pages: readonly NvidiaPageArtifactV1[];
  readonly failures: readonly Readonly<{
    pageNumber: number;
    code: string;
    message: string;
  }>[];
  readonly contentSha256: string;
}

export interface NvidiaCostGuardV1 {
  readonly enabled: boolean;
  readonly routingMode: NvidiaRoutingMode;
  readonly maxConcurrentGpuJobs: number;
  readonly maxPagesPerJob: number;
  readonly monthlyGpuBudgetUsd: number;
  readonly projectedGpuSecondsPerPage: number;
  readonly projectedUsdPerGpuSecond: number;
}

export type Session5BenchmarkStratum =
  | 'r1_zero_native_tables'
  | 'r2_identity_banner'
  | 'r2a_project_cost_table'
  | 'scanned_image_only'
  | 'navy_ba6_duplicate_flattening'
  | 'p1_table'
  | 'o1_op5_table'
  | 'defense_wide_volume';

export interface Session5BenchmarkProviderV1 {
  readonly id: string;
  readonly kind: 'deterministic' | 'llamaparse' | 'nvidia';
  readonly modelName: string;
  readonly modelVersion: string;
  readonly parserOptionsHash?: string;
}

export interface Session5BenchmarkMoneyV1 {
  readonly value: string;
  readonly unit: string;
  readonly fy: number;
  readonly evidencePage: number;
}

export interface Session5BenchmarkObservationV1 {
  readonly status: 'succeeded' | 'failed' | 'not_run';
  readonly peIdentities?: readonly string[];
  readonly projectIdentities?: readonly string[];
  readonly lineIdentities?: readonly string[];
  readonly money?: readonly Session5BenchmarkMoneyV1[];
  readonly tableCells?: readonly string[];
  readonly phase2BlockingOmissions?: number;
  readonly falseIdentityCount?: number;
  readonly evidenceBindingRegressions?: number;
  readonly durationMillis?: number;
  readonly gpuSeconds?: number;
  readonly costUsd?: number;
}

export interface Session5BenchmarkEntryV1 {
  readonly id: string;
  readonly stratum: Session5BenchmarkStratum;
  readonly pageClass: NvidiaPageClass;
  readonly sourceSha256: string;
  readonly pageNumber: number;
  readonly gold: Readonly<{
    peIdentities: readonly string[];
    projectIdentities: readonly string[];
    lineIdentities: readonly string[];
    money: readonly Session5BenchmarkMoneyV1[];
    tableCells: readonly string[];
  }>;
  readonly observations: Readonly<
    Record<string, Session5BenchmarkObservationV1>
  >;
}

export interface Session5BenchmarkCorpusV1 {
  readonly schemaVersion: typeof NVIDIA_BENCHMARK_CORPUS_SCHEMA_V1;
  readonly runId: string;
  readonly baselineProviderId: string;
  readonly providers: readonly Session5BenchmarkProviderV1[];
  readonly entries: readonly Session5BenchmarkEntryV1[];
}

export interface Session5BenchmarkResultV1 {
  readonly schemaVersion: typeof NVIDIA_BENCHMARK_RESULT_SCHEMA_V1;
  readonly runId: string;
  readonly corpusSha256: string;
  readonly missingStrata: readonly Session5BenchmarkStratum[];
  readonly nvidiaObservationCount: number;
  readonly acceptedPageClasses: readonly NvidiaPageClass[];
  readonly liveBenchmarkAccepted: boolean;
  readonly pageClassDecisions: Readonly<
    Partial<Record<NvidiaPageClass, NvidiaRoutingDecision>>
  >;
  readonly contentSha256: string;
}
