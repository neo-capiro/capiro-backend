import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';
import type {
  ParserArtifactDescriptorV1,
  ParserRunIdentityV1,
  ParserRuntimeResultV1,
} from './parser-runtime-contract-v1.js';
import type { ParserArtifactStoreV1 } from './parser-artifact-store.js';

/**
 * Route parser artifacts by method. Local parser output may use a shared
 * filesystem root while LlamaParse output uses immutable versioned S3.
 */
export class MethodRoutingParserArtifactStore implements ParserArtifactStoreV1 {
  constructor(
    private readonly defaultStore: ParserArtifactStoreV1,
    private readonly methodStores: Partial<Record<ExtractionMethodV1, ParserArtifactStoreV1>>,
  ) {}

  findExact(identity: ParserRunIdentityV1) {
    return this.storeFor(identity.method).findExact(identity);
  }

  readVerified(descriptor: ParserArtifactDescriptorV1) {
    return this.storeFor(descriptor.method).readVerified(descriptor);
  }

  putVerified(input: {
    identity: ParserRunIdentityV1;
    result: ParserRuntimeResultV1;
    resultJson: string;
  }) {
    return this.storeFor(input.identity.method).putVerified(input);
  }

  private storeFor(method: ExtractionMethodV1): ParserArtifactStoreV1 {
    return this.methodStores[method] ?? this.defaultStore;
  }
}
