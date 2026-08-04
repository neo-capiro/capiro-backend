/**
 * Workstream I — Comparison provider.
 *
 * Bridges the reference artifact index to comparison rules. The provider
 * isolates reference lookup from the rule engine, and ensures:
 *
 * - Every reference artifact must pass its own trusted proof resolution
 *   before it can support a comparison (I1).
 * - Reference artifacts may have different SourceDocument IDs, source SHAs,
 *   artifact IDs, artifact SHAs, and parser methods (I1).
 * - Missing comparisons produce NOT_RUN, never PASS (I4).
 * - Multiple matches produce AMBIGUOUS, never silently reduced to one (I2/I4).
 */
import type { DefenseBudgetExtractionArtifactV1 } from '../../../contracts/extraction-artifact-v1.js';
import type {
  TrustedVerificationProofBundleV1,
  ProofFindingV1,
} from '../../trusted-proof/trusted-proof-types.js';
import type { ReferenceMatchResultV1, ReferenceArtifactEntryV1 } from './comparison-types.js';
import { ReferenceArtifactIndexV1 } from './reference-artifact-index.js';

/* ------------------------------------------------------------------ */
/* Comparison provider                                                  */
/* ------------------------------------------------------------------ */

export interface ComparisonProviderV1 {
  /** The underlying reference index. */
  readonly index: ReferenceArtifactIndexV1;
  /** Whether all reference artifacts passed their own trusted proof resolution. */
  readonly allReferencesProved: boolean;
  /** Proof findings from reference artifact resolution (if any failed). */
  readonly referenceFindings: readonly ProofFindingV1[];
  /** Look up a funding assertion by identity key, FY, and field. */
  lookupFunding(
    identityKey: string,
    fiscalYear: number,
    field: string,
  ): ReferenceMatchResultV1<ReferenceArtifactEntryV1>;
  /** Look up a project_funding assertion by parent PE code, project code, FY, and field. */
  lookupProjectFunding(
    parentPeCode: string,
    projectCode: string,
    fiscalYear: number,
    field: string,
  ): ReferenceMatchResultV1<ReferenceArtifactEntryV1>;
  /** Get the source SHAs for all reference artifacts (to prove independence). */
  referenceSourceShas(): readonly string[];
}

/* ------------------------------------------------------------------ */
/* Factory                                                              */
/* ------------------------------------------------------------------ */

/**
 * Build a comparison provider from resolved reference artifacts and their
 * proof bundles. Only artifacts whose proof resolution succeeded are
 * included in the index — a reference artifact with blocking proof findings
 * is excluded, and the findings are surfaced so comparison rules can emit
 * NOT_RUN or FAIL accordingly.
 */
export function createComparisonProvider(
  referenceArtifacts: readonly DefenseBudgetExtractionArtifactV1[],
  referenceProofBundles: readonly TrustedVerificationProofBundleV1[],
  referenceFindings: readonly ProofFindingV1[],
): ComparisonProviderV1 {
  // R8.2-D: surgical per-reference exclusion. Proof findings are tagged with
  // the reference's artifactId (and locator/sourceDocumentId) by the unified
  // proof path, so only the specific failed reference is excluded from the
  // index — valid references still contribute to comparisons.
  const blockingArtifactIds = new Set<string>();
  let unattributedBlocking = false;
  for (const finding of referenceFindings) {
    if (finding.severity !== 'blocking') continue;
    if (finding.artifactId) {
      blockingArtifactIds.add(finding.artifactId);
    } else {
      // A blocking finding we cannot attribute to one specific reference
      // (e.g. the reference artifact itself could not be loaded) still means
      // not all references are proved — but it must not poison the index
      // membership of references that WERE independently proved.
      unattributedBlocking = true;
    }
  }

  const allReferencesProved = blockingArtifactIds.size === 0 && !unattributedBlocking;
  const provedArtifacts = allReferencesProved
    ? referenceArtifacts
    : referenceArtifacts.filter((a) => !blockingArtifactIds.has(a.artifactId));

  const index = ReferenceArtifactIndexV1.fromArtifacts(provedArtifacts);

  const sourceShas = referenceArtifacts.map((a) => a.source.sourcePdfSha256);

  return {
    index,
    allReferencesProved,
    referenceFindings,
    lookupFunding: (identityKey, fiscalYear, field) =>
      index.lookupFunding(identityKey, fiscalYear, field),
    lookupProjectFunding: (parentPeCode, projectCode, fiscalYear, field) =>
      index.lookupProjectFunding(parentPeCode, projectCode, fiscalYear, field),
    referenceSourceShas: () => [...sourceShas],
  };
}
