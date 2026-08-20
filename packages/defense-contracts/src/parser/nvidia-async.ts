export const NVIDIA_ASYNC_INFERENCE_RUNTIME_CONTRACT_V1 =
  'nvidia_async_inference_v1' as const;
export const NVIDIA_ASYNC_INPUT_SIDECAR_V1 =
  'nvidia_async_input_sidecar_v1' as const;

export interface NvidiaAsyncEndpointIdentityV1 {
  readonly executionModel: 'sagemaker_async_inference';
  readonly endpointName: string;
  readonly endpointConfigName: string;
  readonly identitySha256: string;
  readonly corpusSha256: string;
  readonly modelPackageArn: string;
  readonly modelVersion: string;
  readonly runtimeContractVersion:
    typeof NVIDIA_ASYNC_INFERENCE_RUNTIME_CONTRACT_V1;
}

export interface NvidiaAsyncInvocationV1 {
  readonly executionModel: 'sagemaker_async_inference';
  readonly endpointName: string;
  readonly endpointConfigName: string;
  readonly inferenceId: string;
  readonly inputLocation: string;
  readonly outputLocation?: string;
  readonly rawOutputSha256?: string;
  readonly normalizedOutputSha256?: string;
  readonly provenance: Readonly<{
    sourceSha256: string;
    pageNumber: number;
    renderedImageSha256: string;
    providerPayloadSha256: string;
    renderingConfigSha256: string;
    modelName: string;
    modelVersion: string;
    parserOptionsHash: string;
    cacheKey: string;
    requestedParserMethod: string;
    parserMethod: 'nemotron_parse';
  }>;
}

export type NvidiaAsyncJobStatusV1 =
  | 'PLANNED'
  | 'CAPACITY_RESERVED'
  | 'ENDPOINT_CREATING'
  | 'ENDPOINT_READY'
  | 'REQUESTS_SUBMITTED'
  | 'REQUESTS_RECONCILING'
  | 'ARTIFACT_VERIFIED'
  | 'COMPLETION_PENDING'
  | 'RESUME_PUBLISHED'
  | 'ENDPOINT_DRAINING'
  | 'ENDPOINT_DELETED'
  | 'COMPLETE';

export interface NvidiaAsyncSpendReservationV1 {
  readonly reservationId: string;
  readonly resourceKind: 'async_endpoint';
  readonly endpointName: string;
  readonly status: 'ACTIVE' | 'SETTLED';
  readonly reservedCostUsd: number;
  readonly reconciledCostUsd?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NvidiaAsyncZeroIdleProofV1 {
  readonly activeJobs: 0;
  readonly spentAndReservedUsd: number;
  readonly persistentEndpoints: readonly [];
  readonly zeroIdleGpu: true;
  readonly checkedAt: string;
}
