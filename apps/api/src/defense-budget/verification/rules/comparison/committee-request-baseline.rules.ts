/**
 * Phase 6 Workstream D — committee request-reference comparison.
 *
 * Later-stage authorities do not own `request`. The preferred candidate input
 * is therefore a typed `committee_request_baseline_v1` document fact. Legacy
 * request funding assertions remain readable for backward compatibility, but
 * Phase 6 composers never emit them.
 */
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
} from '../../../contracts/extraction-artifact-v1.js';
import {
  COMMITTEE_REQUEST_BASELINE_FIELD,
  parseCommitteeRequestBaselineV1,
  type CommitteeRequestComparableV1,
} from '../../../stages/authorization/committee-stage-facts-v1.js';
import {
  absDifference,
  compareWithTolerance,
  printedUnitToleranceMillions,
} from '../arithmetic/exact-arithmetic.js';
import {
  failCheck,
  makeDiscrepancy,
  notRunCheck,
  passCheck,
  skippedCheck,
  type RuleResultV1,
  type VerificationRuleV1,
} from '../rule-types.js';
import { ReferenceArtifactIndexV1 } from './reference-artifact-index.js';

export function committeeRequestComparablesV1(
  artifact: DefenseBudgetExtractionArtifactV1,
): CommitteeRequestComparableV1[] {
  const out: CommitteeRequestComparableV1[] = [];
  for (const assertion of artifact.assertions) {
    if (assertion.assertionKind === 'funding' && assertion.field === 'request') {
      out.push({
        assertionId: assertion.assertionId,
        evidenceIds: assertion.evidenceIds,
        identity: assertion.identity,
        fiscalYear: assertion.fiscalYear,
        money: assertion.money,
      });
      continue;
    }
    if (
      assertion.assertionKind !== 'document_fact' ||
      assertion.fieldName !== COMMITTEE_REQUEST_BASELINE_FIELD
    ) {
      continue;
    }
    const parsed = parseCommitteeRequestBaselineV1(assertion.value);
    out.push({
      assertionId: assertion.assertionId,
      evidenceIds: assertion.evidenceIds,
      identity: parsed.identity,
      fiscalYear: parsed.fiscalYear,
      money: parsed.money,
    });
  }
  return out;
}

export const COMMITTEE_REQUEST_REFERENCE_RULE: VerificationRuleV1 = {
  code: 'committee_request_reference',
  name: 'Committee request reference',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: false,
  riskPoints: 15,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ctx.verificationRunId;
    const isRequired = policy.requiredComparisonRules.includes('committee_request_reference');
    const isReview = policy.reviewComparisonRules.includes('committee_request_reference');
    if (!isRequired && !isReview) {
      return {
        check: skippedCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          'committee_request_reference not in policy',
        ),
        discrepancies: [],
      };
    }
    const overrides = { required: isRequired, blocking: isRequired };
    const referenceIds = input.referenceArtifacts.map((artifact) => artifact.artifactId);

    if (input.referenceArtifactsFindings.some((finding) => finding.severity === 'blocking')) {
      return {
        check: notRunCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          [],
          [],
          referenceIds,
          'reference proof failed',
          undefined,
          overrides,
        ),
        discrepancies: [],
      };
    }
    if (input.referenceArtifacts.length === 0) {
      return {
        check: notRunCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          [],
          [],
          [],
          isRequired
            ? 'no reference artifacts for required committee_request_reference'
            : 'no reference artifacts available',
          undefined,
          overrides,
        ),
        discrepancies: isRequired
          ? [
              makeDiscrepancy(
                'committee_request_reference_missing',
                'review',
                'required comparison missing',
                [],
                [],
                [],
              ),
            ]
          : [],
      };
    }

    const candidates = committeeRequestComparablesV1(input.artifact);
    if (candidates.length === 0) {
      return {
        check: notRunCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          [],
          [],
          referenceIds,
          'no printed committee request baselines to compare',
          undefined,
          overrides,
        ),
        discrepancies: isRequired
          ? [
              makeDiscrepancy(
                'committee_request_baseline_missing',
                'review',
                'required committee request comparison has no printed baseline fact',
                [],
                [],
                referenceIds,
              ),
            ]
          : [],
      };
    }

    const index = ReferenceArtifactIndexV1.fromArtifacts(input.referenceArtifacts);
    const matched: string[] = [];
    const unmatched: string[] = [];
    const ambiguous: string[] = [];
    const mismatches: Array<{
      assertionId: string;
      evidenceId: string;
      referenceArtifactId: string;
      referenceAssertionId: string;
      candidateValue: string;
      referenceValue: string;
      tolerance: string;
      difference: string;
    }> = [];

    for (const candidate of candidates) {
      const match = index.lookupFunding(
        JSON.stringify(candidate.identity),
        candidate.fiscalYear,
        'request',
      );
      if (match.kind === 'zero') {
        unmatched.push(candidate.assertionId);
        continue;
      }
      if (match.kind === 'multiple') {
        ambiguous.push(candidate.assertionId);
        continue;
      }
      const reference = match.value;
      if (reference.valueMillions == null) {
        unmatched.push(candidate.assertionId);
        continue;
      }
      matched.push(candidate.assertionId);
      const tolerance = printedUnitToleranceMillions(1);
      if (compareWithTolerance(candidate.money.valueMillions, reference.valueMillions, tolerance) !== 0) {
        mismatches.push({
          assertionId: candidate.assertionId,
          evidenceId: candidate.evidenceIds[0] ?? '',
          referenceArtifactId: reference.artifactId,
          referenceAssertionId: reference.assertionId,
          candidateValue: candidate.money.valueMillions,
          referenceValue: reference.valueMillions,
          tolerance,
          difference: absDifference(candidate.money.valueMillions, reference.valueMillions),
        });
      }
    }

    const details = {
      candidateAssertionCount: candidates.length,
      matchedAssertionCount: matched.length,
      unmatchedAssertionIds: unmatched,
      ambiguousAssertionIds: ambiguous,
      coveragePercent: Math.round((matched.length / candidates.length) * 100),
    };
    if (ambiguous.length > 0) {
      return {
        check: failCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          ambiguous,
          [],
          referenceIds,
          'ambiguous request-reference matches',
          details,
          overrides,
        ),
        discrepancies: [
          makeDiscrepancy(
            'committee_request_reference_ambiguous',
            isRequired ? 'blocking' : 'review',
            'multiple request assertions match the same committee baseline',
            ambiguous,
            [],
            referenceIds,
          ),
        ],
      };
    }
    if (mismatches.length > 0) {
      return {
        check: failCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          mismatches.map((item) => item.assertionId),
          mismatches.map((item) => item.evidenceId).filter(Boolean),
          referenceIds,
          `${mismatches.length} committee request baseline mismatches`,
          { ...details, mismatches: JSON.parse(JSON.stringify(mismatches)) },
          overrides,
        ),
        discrepancies: mismatches.map((item) =>
          makeDiscrepancy(
            'committee_request_reference_mismatch',
            isRequired ? 'blocking' : 'review',
            `candidate ${item.candidateValue} vs request reference ${item.referenceValue}`,
            [item.assertionId],
            item.evidenceId ? [item.evidenceId] : [],
            [item.referenceArtifactId],
            item as unknown as Record<
              string,
              import('../../verification-contract-v1.js').JsonValue
            >,
          ),
        ),
      };
    }
    if (isRequired && matched.length < candidates.length) {
      return {
        check: notRunCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          matched,
          [],
          referenceIds,
          `required comparison coverage incomplete: ${matched.length}/${candidates.length}`,
          details,
          overrides,
        ),
        discrepancies: unmatched.map((assertionId) =>
          makeDiscrepancy(
            'committee_request_reference_unmatched',
            'review',
            `committee request baseline ${assertionId} has no exact request reference`,
            [assertionId],
            [],
            referenceIds,
          ),
        ),
      };
    }
    if (!isRequired && matched.length === 0) {
      return {
        check: notRunCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          [],
          [],
          referenceIds,
          'no committee request baselines matched a reference artifact',
          details,
          overrides,
        ),
        discrepancies: [],
      };
    }
    return {
      check: passCheck(
        COMMITTEE_REQUEST_REFERENCE_RULE,
        runId,
        matched,
        [],
        referenceIds,
        `${matched.length} committee request baselines matched exact request references`,
        details,
        overrides,
      ),
      discrepancies: [],
    };
  },
};

/** Compile-time assertion that legacy request funding remains a supported input. */
const _legacyAssertionCompatibility: DefenseBudgetAssertionV1['assertionKind'] = 'funding';
void _legacyAssertionCompatibility;
