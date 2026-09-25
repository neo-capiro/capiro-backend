/** Durable persistence wrapper for the bounded Package 3 congressional seam. */
import type { BudgetFamilyV1 } from '../contracts/extraction-artifact-v1.js';
import { sha256Bytes } from '../contracts/canonical-json.js';
import type { Phase5ParserResultProofV1 } from '../non-rdte/non-rdte-proof-bound-artifact-v1.js';
import {
  resolveCongressionalSemanticArtifactFactoryV1,
  type CongressionalSemanticFactoryContextV1,
} from '../stages/congressional-semantic-artifact-factory-v1.js';
import type { ExtractionArtifactBridgeOutput } from './extraction-artifact-bridge.js';
import type { ExtractionArtifactStoreV1 } from './extraction-artifact-store.js';
import type { CommitteeArtifactV1Input } from '../contracts/adapters/committee-artifact-v1.adapter.js';

/**
 * Persist one explicitly supplied structured artifact after profile and
 * persisted parser-proof checks. This is a callable seam only: there is no
 * source-document handoff/provider selecting governed congressional inputs.
 */
export async function persistProofBoundCongressionalArtifactV1(input: {
  budgetFamily: BudgetFamilyV1 | string;
  factoryContext: CongressionalSemanticFactoryContextV1;
  input: CommitteeArtifactV1Input;
  parserResultProofs: readonly Phase5ParserResultProofV1[];
  store: ExtractionArtifactStoreV1;
}): Promise<ExtractionArtifactBridgeOutput> {
  const factory = resolveCongressionalSemanticArtifactFactoryV1(
    input.budgetFamily,
    input.factoryContext,
  );
  if (factory == null) {
    throw new Error(
      `no congressional semantic factory is defined for budget family ${input.budgetFamily}`,
    );
  }
  const artifact = factory(input.input, input.parserResultProofs);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const expectedByteSha256 = sha256Bytes(bytes);
  const persisted = await input.store.putImmutable({ bytes });
  if (persisted.byteSha256 !== expectedByteSha256) {
    throw new Error(
      `congressional semantic artifact byte SHA changed across durable persistence: ` +
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
