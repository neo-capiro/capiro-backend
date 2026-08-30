/**
 * Bidirectional R-1 ↔ R-2 summary/detail arithmetic rule.
 *
 * R-1 and R-2 policies both require this comparison. The candidate may be
 * either exhibit and must be compared against independently proved artifacts
 * from the opposite exhibit. Required comparisons demand complete candidate
 * funding coverage. PASS checks carry every matched candidate assertion ID so
 * page-only reconciliation can clear only exact corroborated assertions.
 *
 * Phase 10B-17 Part D reconciliation bridge: a real PB2024 R-2 exhibit can
 * legitimately print its current budget year as Base/OCO/Total component
 * columns rather than a single column literally labeled "Request" --
 * `rdte-column-role-v1.ts`'s `RDTE_ROLE_ALLOWED_DISPOSITIONS` deliberately
 * keeps those `contextual_only` (never `canonical_request_candidate`), so
 * `r2-pe-funding-builder.ts` correctly emits them as `document_fact`
 * assertions (`fieldName: 'r2_total_component'`), never as `funding`
 * assertions. Before this bridge, the funding-vs-funding matching below
 * therefore had nothing to compare such a PE against and fell through to
 * NOT_RUN even when the R-2 evidence genuinely, verifiably represents the
 * same budget-year amount as the R-1 request.
 *
 * The bridge below is a SEPARATE, additive comparison path
 * (`extractR2TotalComponentEvidence`) that treats specific, narrowly-gated
 * `document_fact` evidence as "comparable to an R-1 request" for THIS
 * rule's matching purposes only. It never reads, writes, or otherwise
 * touches `assertionKind`, `disposition`, or any field the canonical
 * projection/promotion path consults -- verification evidence and
 * canonical-projection eligibility remain fully separate. See
 * `r1-r2-reconciliation-bridge.spec.ts` for a regression that proves this
 * explicitly (a PASS from this rule does not make the underlying R-2 value
 * promotable as a ProgramElementYear request value).
 */
import type { VerificationRuleV1, RuleResultV1 } from '../rule-types.js';
import { passCheck, failCheck, notRunCheck, skippedCheck, makeDiscrepancy } from '../rule-types.js';
import {
  compareWithTolerance,
  printedUnitToleranceMillions,
  absDifference,
} from './exact-arithmetic.js';
import type {
  BudgetLineIdentityV1,
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
} from '../../../contracts/extraction-artifact-v1.js';

/**
 * Extract R-2 `document_fact` evidence that is narrowly, verifiably
 * "comparable to an R-1 request" -- NOT a general reader of all R-2
 * document facts. Every gate below is required, using only metadata
 * `r2-cost-table-extractor-v1.ts`/`rdte-column-role-v1.ts` already derived
 * from the real header/column context (never inferred from the printed
 * number alone):
 *
 *   - `fieldName === 'r2_total_component'`: the column's real, classified
 *     role is `total_component` (Base + OCO = Total). `base_component` or
 *     `oco_component` alone are deliberately excluded -- they are PARTS of
 *     the budget-year amount, not the whole, and would under-represent a
 *     PE with nonzero OCO.
 *   - `value.rowKind === 'pe_total'`: the row is the PE's own aggregate
 *     total, not a sub-activity/AA line or a project row -- an R-1 request
 *     represents the whole PE, never a component of it.
 *   - `value.fiscalYear === source.fiscalYear`: the column's OWN printed
 *     fiscal year (e.g. "FY 2024 Total") matches the exhibit's own
 *     declared cycle year, guarding against a column that carries a
 *     `total_component` role for some OTHER fiscal year the document also
 *     happens to print in Base/OCO/Total form (this row-kind/role
 *     combination is not defined to be exclusive to the current year).
 *   - `source.budgetCycle === 'pb'`: only a President's Budget REQUEST
 *     cycle document is comparable to R-1's own request-cycle figure
 *     (the "request authority track" match the brief requires) -- an
 *     enacted/appropriated-cycle document is a different authority track
 *     entirely and must never be treated as comparable here.
 *
 * Any row failing ANY gate is silently excluded -- it produces "no pair"
 * for this rule, never a fabricated match. This function never modifies,
 * reclassifies, or reads back to any assertion's `assertionKind` or
 * `disposition` -- it is read-only over already-built assertions.
 */
function extractR2TotalComponentEvidence(source: DefenseBudgetExtractionArtifactV1): Array<{
  peCode: string;
  fiscalYear: number;
  valueMillions: string;
  assertionId: string;
  evidenceIds: readonly string[];
}> {
  if (source.source.exhibit !== 'R-2') return [];
  if (source.source.budgetCycle !== 'pb') return [];
  const evidence: Array<{
    peCode: string;
    fiscalYear: number;
    valueMillions: string;
    assertionId: string;
    evidenceIds: readonly string[];
  }> = [];
  for (const assertion of source.assertions) {
    if (assertion.assertionKind !== 'document_fact') continue;
    const fact = assertion as Extract<DefenseBudgetAssertionV1, { assertionKind: 'document_fact' }>;
    if ((fact as { fieldName?: string }).fieldName !== 'r2_total_component') continue;
    const value = (
      fact as {
        value?: {
          peCode?: string;
          fiscalYear?: number;
          rowKind?: string;
          valueMillions?: string;
        };
      }
    ).value;
    if (value?.rowKind !== 'pe_total') continue;
    if (value.fiscalYear == null || value.fiscalYear !== source.source.fiscalYear) continue;
    if (!value.peCode || value.valueMillions == null) continue;
    evidence.push({
      peCode: value.peCode,
      fiscalYear: value.fiscalYear,
      valueMillions: value.valueMillions,
      assertionId: fact.assertionId,
      evidenceIds: fact.evidenceIds,
    });
  }
  return evidence;
}

/** RDT&E PE identity carries `peCode`; other funding-line identities
 * (procurement BLIN, O&M SAG, MILCON project, ...) do not -- the bridge
 * only ever compares RDT&E PE lines, so anything else is never comparable. */
function rdtePeCodeOf(identity: BudgetLineIdentityV1): string | null {
  return identity.lineKind === 'RDTE_PE' ? identity.peCode : null;
}

export const RDTE_SUMMARY_DETAIL_RULE: VerificationRuleV1 = {
  code: 'rdte_summary_detail',
  name: 'R-1 ↔ R-2 Summary/Detail',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 30,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ctx.verificationRunId;
    const { artifact, referenceArtifacts } = input;
    const isRequired = policy.requiredComparisonRules.includes('rdte_summary_detail');
    const overrides = {
      required: isRequired,
      blocking: isRequired || RDTE_SUMMARY_DETAIL_RULE.blocking,
    };

    if (!policy.arithmeticRules.includes('rdte_summary_detail')) {
      return {
        check: skippedCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          'rdte_summary_detail not in policy.arithmeticRules',
          overrides,
        ),
        discrepancies: [],
      };
    }

    const candidateExhibit = artifact.source.exhibit;
    if (candidateExhibit !== 'R-1' && candidateExhibit !== 'R-2') {
      return {
        check: skippedCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          'candidate is neither R-1 nor R-2',
          overrides,
        ),
        discrepancies: [],
      };
    }

    const requiredReferenceExhibit = candidateExhibit === 'R-1' ? 'R-2' : 'R-1';
    const oppositeReferences = referenceArtifacts.filter(
      (reference) => reference.source.exhibit === requiredReferenceExhibit,
    );
    if (oppositeReferences.length === 0) {
      return {
        check: notRunCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          [],
          [],
          [],
          `no independently proved ${requiredReferenceExhibit} reference artifact available`,
          {
            candidateExhibit,
            requiredReferenceExhibit,
          },
          overrides,
        ),
        discrepancies: [],
      };
    }

    const candidateFunding = artifact.assertions.filter(
      (assertion): assertion is Extract<
        DefenseBudgetAssertionV1,
        { assertionKind: 'funding' }
      > => assertion.assertionKind === 'funding',
    );
    const referenceFunding = oppositeReferences.flatMap((reference) =>
      reference.assertions
        .filter(
          (assertion): assertion is Extract<
            DefenseBudgetAssertionV1,
            { assertionKind: 'funding' }
          > => assertion.assertionKind === 'funding',
        )
        .map((assertion) => ({ assertion, artifactId: reference.artifactId })),
    );
    const referenceArtifactIds = oppositeReferences
      .map((reference) => reference.artifactId)
      .sort();
    const matchedAssertionIds: string[] = [];
    const matchedEvidenceIds: string[] = [];
    const unmatchedAssertionIds: string[] = [];
    const ambiguousAssertionIds: string[] = [];
    const mismatchAssertionIds: string[] = [];
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];

    for (const candidate of candidateFunding) {
      const key = JSON.stringify({
        identity: candidate.identity,
        fiscalYear: candidate.fiscalYear,
        field: candidate.field,
      });
      const matches = referenceFunding.filter(
        ({ assertion }) =>
          JSON.stringify({
            identity: assertion.identity,
            fiscalYear: assertion.fiscalYear,
            field: assertion.field,
          }) === key,
      );

      if (matches.length === 0) {
        unmatchedAssertionIds.push(candidate.assertionId);
        continue;
      }
      if (matches.length > 1) {
        ambiguousAssertionIds.push(candidate.assertionId);
        continue;
      }

      const match = matches[0]!;
      matchedAssertionIds.push(candidate.assertionId);
      matchedEvidenceIds.push(...candidate.evidenceIds);
      const candidateValue = candidate.money.valueMillions;
      const referenceValue = match.assertion.money.valueMillions;
      const tolerance = printedUnitToleranceMillions(1);
      if (compareWithTolerance(candidateValue, referenceValue, tolerance) !== 0) {
        mismatchAssertionIds.push(candidate.assertionId);
        const difference = absDifference(candidateValue, referenceValue);
        discrepancies.push(
          makeDiscrepancy(
            'rdte_summary_detail_mismatch',
            'blocking',
            `${candidateExhibit}/${requiredReferenceExhibit} mismatch for ` +
              `${candidate.assertionId}: candidate=${candidateValue}M ` +
              `reference=${referenceValue}M tolerance=${tolerance}M ` +
              `difference=${difference}M`,
            [candidate.assertionId, match.assertion.assertionId],
            [...candidate.evidenceIds, ...match.assertion.evidenceIds],
            [match.artifactId],
          ),
        );
      }
    }

    // Phase 10B-17 Part D reconciliation bridge. Only engaged for candidate
    // funding assertions the phase-1 loop above found NO funding-kind match
    // for, and only against narrowly-gated R-2 total-component evidence
    // (see `extractR2TotalComponentEvidence`) -- never overrides or
    // duplicates a phase-1 match.
    const stillUnmatchedAssertionIds: string[] = [];
    let bridgedComparableCount = 0;
    if (unmatchedAssertionIds.length > 0) {
      const referenceR2Evidence = oppositeReferences
        .filter((reference) => reference.source.exhibit === 'R-2')
        .flatMap((reference) =>
          extractR2TotalComponentEvidence(reference).map((evidence) => ({
            ...evidence,
            artifactId: reference.artifactId,
          })),
        );
      for (const assertionId of unmatchedAssertionIds) {
        const candidate = candidateFunding.find((c) => c.assertionId === assertionId)!;
        const candidatePeCode = rdtePeCodeOf(candidate.identity);
        const bridgeMatches =
          candidatePeCode == null
            ? []
            : referenceR2Evidence.filter(
                (evidence) =>
                  evidence.peCode === candidatePeCode && evidence.fiscalYear === candidate.fiscalYear,
              );
        if (bridgeMatches.length === 0) {
          stillUnmatchedAssertionIds.push(assertionId);
          continue;
        }
        if (bridgeMatches.length > 1) {
          ambiguousAssertionIds.push(assertionId);
          continue;
        }
        bridgedComparableCount += 1;
        const bridgeMatch = bridgeMatches[0]!;
        const candidateValue = candidate.money.valueMillions;
        const referenceValue = bridgeMatch.valueMillions;
        const tolerance = printedUnitToleranceMillions(1);
        if (compareWithTolerance(candidateValue, referenceValue, tolerance) !== 0) {
          mismatchAssertionIds.push(assertionId);
          const difference = absDifference(candidateValue, referenceValue);
          discrepancies.push(
            makeDiscrepancy(
              'rdte_summary_detail_mismatch',
              'blocking',
              `${candidateExhibit}/${requiredReferenceExhibit} mismatch for ` +
                `${assertionId}: candidate=${candidateValue}M ` +
                `reference=${referenceValue}M tolerance=${tolerance}M ` +
                `difference=${difference}M (via R-2 total-component reconciliation bridge)`,
              [assertionId, bridgeMatch.assertionId],
              [...candidate.evidenceIds, ...bridgeMatch.evidenceIds],
              [bridgeMatch.artifactId],
            ),
          );
          continue;
        }
        matchedAssertionIds.push(assertionId);
        matchedEvidenceIds.push(...candidate.evidenceIds, ...bridgeMatch.evidenceIds);
      }
    }
    unmatchedAssertionIds.length = 0;
    unmatchedAssertionIds.push(...stillUnmatchedAssertionIds);

    // Reverse direction: the candidate itself is the R-2 artifact (real
    // orientation whenever R-2 is verified with R-1 supplied as the
    // reference). `candidateFunding` is empty in this case by design (see
    // module doc comment) -- extract the CANDIDATE's own eligible
    // total-component evidence and match it against the reference's real
    // funding assertions.
    let candidateR2EvidenceCount = 0;
    if (candidateExhibit === 'R-2') {
      const candidateR2Evidence = extractR2TotalComponentEvidence(artifact);
      candidateR2EvidenceCount = candidateR2Evidence.length;
      for (const evidence of candidateR2Evidence) {
        const bridgeMatches = referenceFunding.filter(
          ({ assertion }) =>
            rdtePeCodeOf(assertion.identity) === evidence.peCode &&
            assertion.fiscalYear === evidence.fiscalYear,
        );
        if (bridgeMatches.length === 0) {
          unmatchedAssertionIds.push(evidence.assertionId);
          continue;
        }
        if (bridgeMatches.length > 1) {
          ambiguousAssertionIds.push(evidence.assertionId);
          continue;
        }
        bridgedComparableCount += 1;
        const bridgeMatch = bridgeMatches[0]!;
        const candidateValue = evidence.valueMillions;
        const referenceValue = bridgeMatch.assertion.money.valueMillions;
        const tolerance = printedUnitToleranceMillions(1);
        if (compareWithTolerance(candidateValue, referenceValue, tolerance) !== 0) {
          mismatchAssertionIds.push(evidence.assertionId);
          const difference = absDifference(candidateValue, referenceValue);
          discrepancies.push(
            makeDiscrepancy(
              'rdte_summary_detail_mismatch',
              'blocking',
              `${candidateExhibit}/${requiredReferenceExhibit} mismatch for ` +
                `${evidence.assertionId}: candidate=${candidateValue}M ` +
                `reference=${referenceValue}M tolerance=${tolerance}M ` +
                `difference=${difference}M (via R-2 total-component reconciliation bridge)`,
              [evidence.assertionId, bridgeMatch.assertion.assertionId],
              [...evidence.evidenceIds, ...bridgeMatch.assertion.evidenceIds],
              [bridgeMatch.artifactId],
            ),
          );
          continue;
        }
        matchedAssertionIds.push(evidence.assertionId);
        matchedEvidenceIds.push(...evidence.evidenceIds, ...bridgeMatch.assertion.evidenceIds);
      }
    }

    const candidateAssertionCount = candidateFunding.length + candidateR2EvidenceCount;
    const matchedAssertionCount = matchedAssertionIds.length;
    const coveragePercent =
      candidateAssertionCount === 0
        ? 0
        : Math.round((matchedAssertionCount / candidateAssertionCount) * 100);
    const details = {
      bridgedComparableCount,
      candidateExhibit,
      requiredReferenceExhibit,
      candidateAssertionCount,
      matchedAssertionCount,
      unmatchedAssertionIds,
      ambiguousAssertionIds,
      mismatchAssertionIds,
      referenceAssertionCount: referenceFunding.length,
      coveragePercent,
    };

    if (ambiguousAssertionIds.length > 0) {
      return {
        check: failCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          ambiguousAssertionIds,
          [],
          referenceArtifactIds,
          `multiple ${requiredReferenceExhibit} assertions match one or more ` +
            `${candidateExhibit} assertions`,
          details,
          overrides,
        ),
        discrepancies: [
          ...discrepancies,
          ...ambiguousAssertionIds.map((assertionId) =>
            makeDiscrepancy(
              'rdte_summary_detail_ambiguous',
              'blocking',
              `multiple ${requiredReferenceExhibit} assertions match candidate assertion ${assertionId}`,
              [assertionId],
              [],
              referenceArtifactIds,
            ),
          ),
        ],
      };
    }

    if (mismatchAssertionIds.length > 0) {
      return {
        check: failCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          mismatchAssertionIds,
          matchedEvidenceIds,
          referenceArtifactIds,
          `${mismatchAssertionIds.length} R-1/R-2 value mismatches found`,
          details,
          overrides,
        ),
        discrepancies,
      };
    }

    if (candidateAssertionCount === 0 || matchedAssertionCount === 0) {
      return {
        check: notRunCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          [],
          [],
          referenceArtifactIds,
          'no matching R-1/R-2 assertion pairs found',
          details,
          overrides,
        ),
        discrepancies: [],
      };
    }

    if (isRequired && unmatchedAssertionIds.length > 0) {
      return {
        check: notRunCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          matchedAssertionIds,
          matchedEvidenceIds,
          referenceArtifactIds,
          `required R-1/R-2 coverage incomplete: ` +
            `${matchedAssertionCount}/${candidateAssertionCount} assertions matched`,
          details,
          overrides,
        ),
        discrepancies: unmatchedAssertionIds.map((assertionId) =>
          makeDiscrepancy(
            'rdte_summary_detail_unmatched',
            'review',
            `required comparison has no ${requiredReferenceExhibit} match for ` +
              `candidate assertion ${assertionId}`,
            [assertionId],
            [],
            referenceArtifactIds,
          ),
        ),
      };
    }

    return {
      check: passCheck(
        RDTE_SUMMARY_DETAIL_RULE,
        runId,
        matchedAssertionIds,
        [...new Set(matchedEvidenceIds)],
        referenceArtifactIds,
        `${matchedAssertionCount} R-1/R-2 assertion pairs match within tolerance`,
        details,
        overrides,
      ),
      discrepancies: [],
    };
  },
};
