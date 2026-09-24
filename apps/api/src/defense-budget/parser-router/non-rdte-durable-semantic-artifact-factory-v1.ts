/** Durable parser-router adapter for proof-bound Phase 5 non-RDT&E artifacts. */
import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
import { sha256Bytes } from '../contracts/canonical-json.js';
import type { ExtractionSourceV1 } from '../contracts/extraction-artifact-v1.js';
import { buildProofBoundNonRdteArtifactFromComposedOutput } from '../non-rdte/non-rdte-phase3-composed-artifact-v1.js';
import type { Phase5ParserResultProofV1 } from '../non-rdte/non-rdte-proof-bound-artifact-v1.js';
import type {
  ExtractionArtifactBridgeInput,
  ExtractionArtifactBridgeOutput,
} from './extraction-artifact-bridge.js';
import type { ExtractionArtifactStoreV1 } from './extraction-artifact-store.js';
import type { ParserArtifactStoreV1 } from './parser-artifact-store.js';
import { buildParserRunIdentityV1 } from './parser-run-identity-v1.js';
import { computeParserRunId } from './parser-runtime-contract-v1.js';

export type NonRdteArtifactFactoryV1 = (
  input: ExtractionArtifactBridgeInput,
  store: ExtractionArtifactStoreV1,
) => Promise<ExtractionArtifactBridgeOutput>;

export interface NonRdteDurableSemanticArtifactFactoryInputV1 {
  readonly document: BudgetCycleManifestDocumentV1;
  readonly source: ExtractionSourceV1;
  readonly parserArtifactStore: ParserArtifactStoreV1;
}

/**
 * Builds semantics from the selected Phase 3 pages, validates their exact
 * persisted parser-result proofs, then stores the serialized artifact bytes
 * through the same immutable durable store used by the generic bridge.
 * Proofs must be loaded and byte-hashed by the caller from the parser artifact
 * store; parserRunEntries copied into the composed output are not proofs by
 * themselves.
 */
export async function persistProofBoundNonRdteArtifactFromComposedOutputV1(input: {
  document: BudgetCycleManifestDocumentV1;
  source: ExtractionSourceV1;
  composedOutput: unknown;
  parserResultProofs: readonly Phase5ParserResultProofV1[];
  store: ExtractionArtifactStoreV1;
}): Promise<ExtractionArtifactBridgeOutput> {
  const artifact = buildProofBoundNonRdteArtifactFromComposedOutput({
    document: input.document,
    source: input.source,
    composedOutput: input.composedOutput,
    parserResultProofs: input.parserResultProofs,
  });
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const expectedByteSha256 = sha256Bytes(bytes);
  const persisted = await input.store.putImmutable({ bytes });
  if (persisted.byteSha256 !== expectedByteSha256) {
    throw new Error(
      `non-RDT&E semantic artifact byte SHA changed across durable persistence: ` +
        `expected ${expectedByteSha256}, store computed ${persisted.byteSha256}`,
    );
  }

  return {
    artifact,
    artifactId: artifact.artifactId,
    artifactContentSha256: artifact.contentSha256,
    artifactByteSha256: persisted.byteSha256,
    artifactLocator: persisted.locator,
    parserRuns: artifact.parserRuns,
    sourceFactCount: artifact.sourceFacts.length,
    assertionCount: artifact.assertions.length,
    evidenceCount: artifact.evidence.length,
    warningCount: artifact.warnings.length,
  };
}

/**
 * Parser-router-shaped production adapter. Proof objects are reconstructed
 * from the immutable parser artifact store, never trusted from the composed
 * output's in-memory pass-through result alone.
 */
export function createNonRdteDurableSemanticArtifactFactoryV1(
  input: NonRdteDurableSemanticArtifactFactoryInputV1,
): NonRdteArtifactFactoryV1 {
  return async (bridgeInput, store) => {
    const selectedRunIds = new Set(
      bridgeInput.composedOutput.pages.flatMap((page) =>
        page.selectedParserRunId == null ? [] : [page.selectedParserRunId],
      ),
    );
    const entries = bridgeInput.composedOutput.parserRunEntries ?? [];
    const entriesByRunId = new Map(entries.map((entry) => [entry.parserRunId, entry] as const));
    const parserResultProofs: Phase5ParserResultProofV1[] = [];

    for (const parserRunId of [...selectedRunIds].sort()) {
      const entry = entriesByRunId.get(parserRunId);
      if (entry == null) {
        throw new Error(`selected parser run ${parserRunId} has no composed parser-run entry`);
      }
      const identity = buildParserRunIdentityV1({
        sourceSha256: entry.sourceSha256,
        method: entry.method,
        parserVersion: entry.parserVersion,
        parserConfigSha256: entry.parserConfigSha256,
        requestedPages: entry.result.requestedPages,
      });
      const computedRunId = computeParserRunId(identity);
      if (computedRunId !== parserRunId) {
        throw new Error(
          `composed parser-run identity mismatch: expected ${parserRunId}, computed ${computedRunId}`,
        );
      }
      const descriptor = await input.parserArtifactStore.findExact(identity);
      if (descriptor == null || descriptor.parserRunId !== parserRunId) {
        throw new Error(`persisted parser-result proof ${parserRunId} was not found`);
      }
      const result = await input.parserArtifactStore.readVerified(descriptor);
      parserResultProofs.push({
        parserRunId,
        result,
        resultByteSha256: descriptor.byteSha256,
      });
    }

    return persistProofBoundNonRdteArtifactFromComposedOutputV1({
      document: input.document,
      source: input.source,
      composedOutput: bridgeInput.composedOutput,
      parserResultProofs,
      store,
    });
  };
}
