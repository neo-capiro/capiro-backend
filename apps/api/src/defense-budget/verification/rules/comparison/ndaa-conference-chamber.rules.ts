/** Phase 6 Workstream G — exact HASC/SASC -> NDAA conference reconciliation. */
import type { DefenseBudgetExtractionArtifactV1 } from '../../../contracts/extraction-artifact-v1.js';
import {
  NDAA_CONFERENCE_CHAMBER_POSITIONS_FIELD,
  parseNdaaConferenceChamberPositionsV1,
} from '../../../stages/authorization/ndaa-conference/ndaa-conference-facts-v1.js';
import {
  absDifference,
  compareWithTolerance,
  printedUnitToleranceMillions,
  subtractDecimals,
} from '../arithmetic/exact-arithmetic.js';
import {
  failCheck,
  makeDiscrepancy,
  notRunCheck,
  passCheck,
  skippedCheck,
  type VerificationRuleV1,
} from '../rule-types.js';
import { ReferenceArtifactIndexV1 } from './reference-artifact-index.js';

interface ConferenceComparable {
  assertionId: string;
  evidenceIds: string[];
  value: ReturnType<typeof parseNdaaConferenceChamberPositionsV1>;
}

export function ndaaConferenceComparablesV1(
  artifact: DefenseBudgetExtractionArtifactV1,
): ConferenceComparable[] {
  return artifact.assertions.flatMap((assertion) => {
    if (
      assertion.assertionKind !== 'document_fact' ||
      assertion.fieldName !== NDAA_CONFERENCE_CHAMBER_POSITIONS_FIELD
    ) {
      return [];
    }
    return [
      {
        assertionId: assertion.assertionId,
        evidenceIds: assertion.evidenceIds,
        value: parseNdaaConferenceChamberPositionsV1(assertion.value),
      },
    ];
  });
}

export const NDAA_CONFERENCE_CHAMBER_REFERENCE_RULE: VerificationRuleV1 = {
  code: 'ndaa_conference_chamber_reference',
  name: 'NDAA conference chamber reference',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: false,
  riskPoints: 35,

  execute(ctx) {
    const required = ctx.policy.requiredComparisonRules.includes(this.code);
    const review = ctx.policy.reviewComparisonRules.includes(this.code);
    if (!required && !review) {
      return {
        check: skippedCheck(this, ctx.verificationRunId, `${this.code} not in policy`),
        discrepancies: [],
      };
    }
    const overrides = { required, blocking: required };
    const referenceIds = ctx.input.referenceArtifacts.map((artifact) => artifact.artifactId);
    if (ctx.input.referenceArtifactsFindings.some((finding) => finding.severity === 'blocking')) {
      return {
        check: notRunCheck(
          this,
          ctx.verificationRunId,
          [],
          [],
          referenceIds,
          'reference proof failed before chamber reconciliation',
          undefined,
          overrides,
        ),
        discrepancies: [],
      };
    }

    const candidates = ndaaConferenceComparablesV1(ctx.input.artifact);
    if (candidates.length === 0) {
      return {
        check: notRunCheck(
          this,
          ctx.verificationRunId,
          [],
          [],
          referenceIds,
          'no NDAA conference chamber-position facts to reconcile',
          undefined,
          overrides,
        ),
        discrepancies: required
          ? [
              makeDiscrepancy(
                'ndaa_conference_comparison_missing',
                'blocking',
                'required chamber comparison fact missing',
                [],
                [],
                referenceIds,
              ),
            ]
          : [],
      };
    }

    const index = ReferenceArtifactIndexV1.fromArtifacts(ctx.input.referenceArtifacts);
    const details: Record<string, import('../../verification-contract-v1.js').JsonValue> = {};
    const missing: string[] = [];
    const ambiguous: string[] = [];
    const mismatched: string[] = [];
    const discrepancyList: ReturnType<typeof makeDiscrepancy>[] = [];
    const tolerance = printedUnitToleranceMillions(1);

    for (const candidate of candidates) {
      const identityKey = JSON.stringify(candidate.value.identity);
      const house = index.lookupFunding(identityKey, candidate.value.fiscalYear, 'hascMark');
      const senate = index.lookupFunding(identityKey, candidate.value.fiscalYear, 'sascMark');
      const rowDetails: Record<string, import('../../verification-contract-v1.js').JsonValue> = {};

      for (const [chamber, match, printed] of [
        ['house', house, candidate.value.house],
        ['senate', senate, candidate.value.senate],
      ] as const) {
        if (match.kind === 'zero') {
          missing.push(`${candidate.assertionId}:${chamber}`);
          rowDetails[chamber] = { outcome: 'NOT_RUN' };
          continue;
        }
        if (match.kind === 'multiple') {
          ambiguous.push(`${candidate.assertionId}:${chamber}`);
          rowDetails[chamber] = { outcome: 'FAIL', reason: 'multiple_exact_references' };
          continue;
        }
        const referenceValue = match.value.valueMillions;
        if (referenceValue == null) {
          missing.push(`${candidate.assertionId}:${chamber}`);
          rowDetails[chamber] = { outcome: 'NOT_RUN', reason: 'reference_has_no_money' };
          continue;
        }
        if (
          printed.status === 'PRINTED' &&
          compareWithTolerance(printed.money.valueMillions, referenceValue, tolerance) !== 0
        ) {
          mismatched.push(`${candidate.assertionId}:${chamber}`);
          rowDetails[chamber] = {
            outcome: 'FAIL',
            printedValue: printed.money.valueMillions,
            referenceValue,
            difference: absDifference(printed.money.valueMillions, referenceValue),
          };
          continue;
        }
        rowDetails[chamber] = {
          outcome: 'PASS',
          referenceValue,
          conferenceValue: candidate.value.conference.money.valueMillions,
          deltaToConference: signedDifference(
            candidate.value.conference.money.valueMillions,
            referenceValue,
          ),
          ...(printed.status === 'PRINTED' ? { printedValue: printed.money.valueMillions } : {}),
        };
      }

      if (
        house.kind === 'one' &&
        senate.kind === 'one' &&
        house.value.valueMillions != null &&
        senate.value.valueMillions != null
      ) {
        rowDetails.houseVsSenateDelta = signedDifference(
          senate.value.valueMillions,
          house.value.valueMillions,
        );
      }
      details[candidate.assertionId] = rowDetails;
    }

    if (ambiguous.length > 0 || mismatched.length > 0) {
      const failing = [...ambiguous, ...mismatched];
      discrepancyList.push(
        makeDiscrepancy(
          'ndaa_conference_chamber_reference_conflict',
          required ? 'blocking' : 'review',
          'one or more exact chamber references are ambiguous or disagree with printed conference columns',
          candidates.map((item) => item.assertionId),
          candidates.flatMap((item) => item.evidenceIds),
          referenceIds,
          { failing },
        ),
      );
      return {
        check: failCheck(
          this,
          ctx.verificationRunId,
          candidates.map((item) => item.assertionId),
          candidates.flatMap((item) => item.evidenceIds),
          referenceIds,
          'NDAA conference chamber reconciliation failed',
          details,
          overrides,
        ),
        discrepancies: discrepancyList,
      };
    }

    if (missing.length > 0) {
      return {
        check: notRunCheck(
          this,
          ctx.verificationRunId,
          candidates.map((item) => item.assertionId),
          candidates.flatMap((item) => item.evidenceIds),
          referenceIds,
          `NDAA conference chamber reconciliation incomplete: ${missing.length} chamber positions NOT_RUN`,
          { ...details, missing },
          overrides,
        ),
        discrepancies: missing.map((value) =>
          makeDiscrepancy(
            'ndaa_conference_chamber_reference_not_run',
            required ? 'blocking' : 'review',
            `${value} has no exact chamber reference; absence is NOT_RUN, never zero`,
            candidates.map((item) => item.assertionId),
            [],
            referenceIds,
          ),
        ),
      };
    }

    return {
      check: passCheck(
        this,
        ctx.verificationRunId,
        candidates.map((item) => item.assertionId),
        candidates.flatMap((item) => item.evidenceIds),
        referenceIds,
        'HASC, SASC, and NDAA conference positions reconcile by exact identity and fiscal year',
        details,
        overrides,
      ),
      discrepancies: [],
    };
  },
};

function signedDifference(left: string, right: string): string {
  return subtractDecimals(left, right);
}
