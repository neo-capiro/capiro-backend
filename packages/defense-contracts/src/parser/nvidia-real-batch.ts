export const NVIDIA_REAL_BATCH_RUNTIME_CONTRACT_V2 = 'nvidia_real_batch_v2' as const;
export const NVIDIA_BATCH_INPUT_SIDECAR_V2 = 'nvidia_batch_input_sidecar_v2' as const;
export const NVIDIA_NORMALIZED_PAGE_ARTIFACT_V2 = 'nvidia_normalized_page_artifact_v2' as const;
export const NVIDIA_REAL_BATCH_JOB_V2 = 'phase8_session5_real_batch_job_v2' as const;

export interface NvidiaLivePageIdentityV2 {
  readonly sourceSha256: string;
  readonly pageNumber: number;
  readonly provider: 'nvidia';
  readonly parserMethod: string;
  readonly modelName: string;
  readonly modelVersion: string;
  readonly parserOptionsHash: string;
  readonly renderedImageSha256: string;
  readonly providerPayloadSha256: string;
  readonly renderingConfigSha256: string;
  readonly runtimeContractVersion: typeof NVIDIA_REAL_BATCH_RUNTIME_CONTRACT_V2;
}

export interface NvidiaBatchInputSidecarRecordV2 {
  readonly lineIndex: number;
  readonly pageNumber: number;
  readonly pageClass: string;
  readonly cacheKey: string;
  readonly renderedImageSha256: string;
  readonly providerPayloadSha256: string;
  readonly renderingConfigSha256: string;
  readonly escalationReason: string;
}

export interface NvidiaBatchInputSidecarV2 {
  readonly schemaVersion: typeof NVIDIA_BATCH_INPUT_SIDECAR_V2;
  readonly batchId: string;
  readonly sourceDocumentId: string;
  readonly sourceSha256: string;
  readonly parserMethod: string;
  readonly modelName: string;
  readonly modelVersion: string;
  readonly parserOptionsHash: string;
  readonly inputContentType: 'application/json';
  readonly outputAccept: 'application/json';
  readonly records: readonly NvidiaBatchInputSidecarRecordV2[];
  readonly contentSha256: string;
}

export interface NvidiaNormalizedPageArtifactV2
  extends NvidiaLivePageIdentityV2 {
  readonly schemaVersion: typeof NVIDIA_NORMALIZED_PAGE_ARTIFACT_V2;
  readonly sourceDocumentId: string;
  readonly pageClass: string;
  readonly cacheKey: string;
  readonly providerRunIdentity: Readonly<Record<string, unknown>>;
  readonly providerRawResponseSha256: string;
  readonly text: string;
  readonly markdown: string;
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
  readonly tables: readonly Readonly<Record<string, unknown>>[];
  readonly evidencePrecision: 'page_only' | 'text_span' | 'cell_bbox';
  readonly warnings: readonly string[];
  readonly contentSha256: string;
}

export type NvidiaRealBatchJobStatusV2 =
  | 'PLANNED'
  | 'RESERVED'
  | 'MANIFEST_WRITTEN'
  | 'SUBMITTED'
  | 'RUNNING'
  | 'PROVIDER_COMPLETED'
  | 'ARTIFACT_VERIFIED'
  | 'COMPLETION_PENDING'
  | 'RESUME_PUBLISHED'
  | 'FAILED'
  | 'DLQ'
  | 'RETRY_PLANNED';

export interface NvidiaSpendReservationV1 {
  readonly reservationId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly status: 'ACTIVE' | 'SETTLED' | 'RELEASED';
  readonly reservedCostUsd: number;
  readonly reconciledCostUsd?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NvidiaSpendControlV1 {
  readonly activeJobs: number;
  /** Settled spend plus reservations for still-active provider work. */
  readonly spentAndReservedUsd: number;
  readonly settledSpendUsd: number;
}

export interface Session5SourceGroundedGoldV1 {
  readonly reviewStatus: 'accepted' | 'candidate' | 'rejected';
  readonly incomplete?: boolean;
  readonly conflicted?: boolean;
  readonly sourceEvidenceSha256: string;
}
