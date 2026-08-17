import type {
  RetrievalDomain,
  RetrievalRequest,
  RetrievalSourceResult,
  SemanticDatasetDescriptor,
} from './retrieval-v2.types.js';

export const RETRIEVAL_SOURCE_ADAPTERS = Symbol('RETRIEVAL_SOURCE_ADAPTERS');

export interface RetrievalSourceAdapter {
  readonly key: string;
  readonly domains: readonly RetrievalDomain[];

  retrieve(
    dataset: SemanticDatasetDescriptor,
    request: RetrievalRequest,
    cursor?: string,
  ): Promise<RetrievalSourceResult>;
}
