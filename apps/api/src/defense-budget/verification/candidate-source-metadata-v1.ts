/**
 * Phase 7 Gap 5, decision 1 — derive the two source-metadata facts that
 * `budget_extraction_candidate_v1` should have been recording all along.
 *
 * Both are properties of the extraction artifact, which is fully resolved and
 * hash-verified by the time a candidate row is written. Neither was stored, so
 * promotion eligibility had nothing to read: `family` is what scopes
 * `loadCandidates(cycleId, families)`, and `extractionMethod` is what
 * `deriveSegregationEvidenceV1` runs through `isHighRiskExtractionMethodV1` to
 * refuse an authorizer who also extracted.
 *
 * Kept as a pure function over the artifact, in the verification module rather
 * than the promotion module, for two reasons: the write path
 * (`persistCompletedVerification`) and the backfill
 * (`scripts/backfill-budget-candidate-source-metadata-v1.ts`) must derive
 * *identically* or a backfilled row and a freshly written one would disagree;
 * and the promotion module must not become a dependency of Phase 2.
 *
 * Everything here fails closed. There is no default family and no default
 * method — an artifact that cannot answer the question leaves the columns NULL,
 * and a NULL is a refusal downstream, not a wildcard.
 */
import {
  EXTRACTION_METHOD_RISK_PRECEDENCE_V1,
  budgetFamilyV1Schema,
  extractionMethodV1Schema,
  type BudgetFamilyV1,
  type DefenseBudgetExtractionArtifactV1,
  type ExtractionMethodV1,
} from '../contracts/extraction-artifact-v1.js';

export interface CandidateSourceMetadataV1 {
  family: BudgetFamilyV1;
  extractionMethod: ExtractionMethodV1;
}

export class CandidateSourceMetadataUnresolvedErrorV1 extends Error {
  constructor(reason: string) {
    super(`cannot derive candidate source metadata: ${reason}`);
    this.name = 'CandidateSourceMetadataUnresolvedErrorV1';
  }
}

/**
 * The method a candidate is attributed to, when its artifact carries more than
 * one parser run.
 *
 * A composed artifact legitimately has several runs — one per contributing
 * parser — and the eligibility contract names a single `extractionMethod`. The
 * rule is "the riskiest method that contributed", resolved through
 * `EXTRACTION_METHOD_RISK_PRECEDENCE_V1`.
 *
 * Note this is not a heuristic standing in for a missing fact: every listed
 * method genuinely did contribute to the artifact, and picking the riskiest is
 * the only choice that cannot understate what an authorizer would be approving.
 * It also matches what the non-RDT&E builders already do implicitly — when a
 * family extractor has no real parser lineage it synthesizes a run with
 * `method: 'manual'` (see `c1-artifact-builder-v1.ts`), the most restrictive
 * value, rather than claiming a deterministic parse.
 */
export function resolveArtifactExtractionMethodV1(
  artifact: DefenseBudgetExtractionArtifactV1,
): ExtractionMethodV1 {
  if (artifact.parserRuns.length === 0) {
    throw new CandidateSourceMetadataUnresolvedErrorV1(
      `artifact ${artifact.artifactId} carries no parser runs, so no extraction method can be ` +
        `attributed to it; refusing rather than assuming one`,
    );
  }

  const present = new Set<string>();
  for (const run of artifact.parserRuns) {
    // Re-parsed rather than trusted: this function is also fed artifacts read
    // back from storage during backfill, where the bytes are only as good as
    // the hash check that preceded them.
    present.add(extractionMethodV1Schema.parse(run.method));
  }

  for (const method of EXTRACTION_METHOD_RISK_PRECEDENCE_V1) {
    if (present.has(method)) return method;
  }

  /* Unreachable while the precedence list covers the enum, which a test
     asserts. Kept because "unreachable" and "unchecked" are different. */
  throw new CandidateSourceMetadataUnresolvedErrorV1(
    `artifact ${artifact.artifactId} names parser methods (${[...present].sort().join(', ')}) that ` +
      `are absent from EXTRACTION_METHOD_RISK_PRECEDENCE_V1`,
  );
}

/**
 * `family` comes straight from the artifact's own source block — the
 * human-reviewed manifest classification, not an inference from the filename.
 * `unknown` is a real enum member, and it is refused here: a candidate whose
 * family is literally unclassified cannot be scoped into a promotion, and
 * storing `unknown` would make it look scopeable.
 */
export function deriveCandidateSourceMetadataV1(
  artifact: DefenseBudgetExtractionArtifactV1,
): CandidateSourceMetadataV1 {
  const family = budgetFamilyV1Schema.parse(artifact.source.family);
  if (family === 'unknown') {
    throw new CandidateSourceMetadataUnresolvedErrorV1(
      `artifact ${artifact.artifactId} declares family "unknown"; an unclassified document cannot ` +
        `be scoped into a promotion`,
    );
  }
  return { family, extractionMethod: resolveArtifactExtractionMethodV1(artifact) };
}

/**
 * Non-throwing variant for the write path.
 *
 * Verification must not start failing because of a metadata concern that did
 * not exist before this column pair did — a candidate whose artifact cannot
 * answer the question is still a legitimately verified candidate, it just
 * cannot be promoted until someone looks at it. So the write path records NULL
 * and the promotion read path refuses on NULL, which keeps the failure at the
 * boundary that actually cares.
 */
export function tryDeriveCandidateSourceMetadataV1(
  artifact: DefenseBudgetExtractionArtifactV1,
): CandidateSourceMetadataV1 | null {
  try {
    return deriveCandidateSourceMetadataV1(artifact);
  } catch {
    return null;
  }
}
