/**
 * Phase 10B-10 -- adapts `createRdteSemanticArtifactFactory` (the existing,
 * already-tested RDT&E R-1/R-2/R-2A/R-3/R-4 semantic extractor pipeline) into
 * the `ParserRouterDependencies.artifactFactory` seam that
 * `ParserRouterV1Service` already exposes.
 *
 * `createRdteSemanticArtifactFactory`'s own `factory(bridgeInput, outputDir)`
 * persists its serialized artifact to a LOCAL scratch file
 * (`writeFileSync`) -- correct for the batch cycle-certification pipeline
 * that calls it directly, but wrong for this seam: `artifactFactory` here
 * must return a locator durable across container restarts (S3-versioned in
 * production), or the governed one-shot ingestion worker's
 * `persistVerificationAudit: true` guarantee is silently defeated -- the
 * artifact would vanish with the ephemeral container exactly like the
 * pre-Phase-10B-1 filesystem-only mode this bridge was built to replace.
 *
 * This adapter does NOT reimplement extraction. It calls the real factory
 * into a throwaway scratch directory, reads back the exact bytes it wrote,
 * and pushes those exact bytes through the durable
 * `ExtractionArtifactStoreV1.putImmutable()` the default
 * `buildExtractionArtifact` already uses -- so the durability guarantee and
 * the semantic extraction are each provided by the one place that already
 * implements them correctly.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { ExtractionSourceV1 } from '../contracts/extraction-artifact-v1.js';
import { createRdteSemanticArtifactFactory } from '../rdte/cycle/rdte-phase3-semantic-artifact-factory-v1.js';
import type {
  ExtractionArtifactBridgeInput,
  ExtractionArtifactBridgeOutput,
} from './extraction-artifact-bridge.js';
import type { ExtractionArtifactStoreV1 } from './extraction-artifact-store.js';

export interface RdteDurableSemanticArtifactFactoryInputV1 {
  document: BudgetCycleManifestDocumentV1;
  source: ExtractionSourceV1 & { sourceDocumentId: string };
  fiscalYear: number;
}

export type ArtifactFactoryV1 = (
  input: ExtractionArtifactBridgeInput,
  store: ExtractionArtifactStoreV1,
) => Promise<ExtractionArtifactBridgeOutput>;

/**
 * Returns a `ParserRouterDependencies['artifactFactory']`-shaped function
 * that produces a REAL RDT&E semantic artifact (R-1 PE identities, R-2
 * narrative/funding, R-2A project rows, R-3 performers, R-4 milestones --
 * whichever the manifest document's `exhibit` selects) and persists it
 * through the caller-supplied durable store, never through the raw
 * scratch-file path the underlying factory writes internally.
 */
export function createRdteDurableSemanticArtifactFactoryV1(
  input: RdteDurableSemanticArtifactFactoryInputV1,
): ArtifactFactoryV1 {
  const { factory } = createRdteSemanticArtifactFactory(input);
  return async (bridgeInput, store) => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'capiro-rdte-semantic-artifact-'));
    try {
      const localResult = factory(bridgeInput, scratchDir);
      // Read back the EXACT bytes the factory itself serialized and wrote --
      // never re-serialize `localResult.artifact` independently here, so
      // there is no risk of the durable copy silently diverging (key
      // ordering, whitespace, a future field) from what the factory actually
      // produced and hashed as `artifactContentSha256`/`artifactByteSha256`.
      const bytes = await readFile(localResult.artifactLocator);
      const persisted = await store.putImmutable({ bytes });
      if (persisted.byteSha256 !== localResult.artifactByteSha256) {
        throw new Error(
          `RDT&E semantic artifact byte SHA changed across durable persistence: ` +
            `factory computed ${localResult.artifactByteSha256}, store computed ${persisted.byteSha256}`,
        );
      }
      return {
        artifact: localResult.artifact,
        artifactId: localResult.artifactId,
        artifactContentSha256: localResult.artifactContentSha256,
        artifactByteSha256: persisted.byteSha256,
        // The only field that changes vs. the raw factory result: the
        // scratch path is replaced by the durable store's locator. Every
        // consumer of `ExtractionArtifactBridgeOutput` (verification
        // persistence, promotion eligibility) reads `artifactLocator`, never
        // a factory-internal path, so this is the one seam that matters.
        artifactLocator: persisted.locator,
        parserRuns: localResult.parserRuns,
        sourceFactCount: localResult.sourceFactCount,
        assertionCount: localResult.assertionCount,
        evidenceCount: localResult.evidenceCount,
        warningCount: localResult.warningCount,
      };
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  };
}

/**
 * The one place that decides which families get a durable semantic factory.
 * Phase 10B-10 scope is RDT&E only -- every other family falls through to
 * `undefined`, which is exactly the pre-existing behavior
 * (`ParserRouterV1Service` then defaults to the generic lineage-only
 * `buildExtractionArtifact`, unchanged). Extracted as a pure function so
 * "non-RDT&E families are untouched" is independently unit-testable without
 * driving the full parser-handoff pipeline.
 */
export function resolveArtifactFactoryForFamilyV1(
  budgetFamily: string,
  input: RdteDurableSemanticArtifactFactoryInputV1,
): ArtifactFactoryV1 | undefined {
  if (budgetFamily !== 'rdte') return undefined;
  return createRdteDurableSemanticArtifactFactoryV1(input);
}
