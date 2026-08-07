/** Phase 6 Workstream K — exact appropriations conference vehicle proof. */
import {
  APPROPRIATIONS_CONFERENCE_VEHICLE_PROOF_FIELD,
  appropriationsConferenceVehicleProofV1Schema,
} from '../../stages/appropriations/conference/appropriations-conference-facts-v1.js';
import {
  failCheck,
  makeDiscrepancy,
  passCheck,
  skippedCheck,
  type VerificationRuleV1,
} from './rule-types.js';

export const APPROPRIATIONS_CONFERENCE_VEHICLE_RULE: VerificationRuleV1 = {
  code: 'appropriations_conference_vehicle_proof',
  name: 'Appropriations conference vehicle proof',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 100,
  execute(ctx) {
    const isConference =
      ctx.input.artifact.source.authority === 'appropriations_conference' ||
      ctx.input.artifact.assertions.some(
        (assertion) => assertion.assertionKind === 'funding' && assertion.field === 'conference',
      );
    if (!isConference) {
      return {
        check: skippedCheck(
          APPROPRIATIONS_CONFERENCE_VEHICLE_RULE,
          ctx.verificationRunId,
          'not an appropriations conference artifact',
        ),
        discrepancies: [],
      };
    }
    const proofAssertions = ctx.input.artifact.assertions.filter(
      (assertion) =>
        assertion.assertionKind === 'document_fact' &&
        assertion.fieldName === APPROPRIATIONS_CONFERENCE_VEHICLE_PROOF_FIELD,
    );
    if (proofAssertions.length !== 1) {
      return {
        check: failCheck(
          APPROPRIATIONS_CONFERENCE_VEHICLE_RULE,
          ctx.verificationRunId,
          [],
          [],
          [],
          'appropriations conference requires exactly one exact vehicle proof',
          { proofAssertionCount: proofAssertions.length },
          { required: true, blocking: true, riskPoints: 100 },
        ),
        discrepancies: [
          makeDiscrepancy(
            'appropriations_conference_vehicle_proof_missing_or_ambiguous',
            'blocking',
            'conference funding cannot pass without exact conference-report proof',
            [],
            [],
            [],
            {},
          ),
        ],
      };
    }
    const parsed = appropriationsConferenceVehicleProofV1Schema.safeParse(
      proofAssertions[0]!.value,
    );
    if (!parsed.success) {
      return {
        check: failCheck(
          APPROPRIATIONS_CONFERENCE_VEHICLE_RULE,
          ctx.verificationRunId,
          [],
          [],
          [],
          'appropriations conference vehicle proof is invalid',
          undefined,
          { required: true, blocking: true, riskPoints: 100 },
        ),
        discrepancies: [],
      };
    }
    const proof = parsed.data;
    const sourceId =
      ctx.input.artifact.source.sourceDocumentId ?? ctx.input.artifact.source.manifestDocumentKey;
    if (
      proof.primary.sourceDocumentId !== sourceId ||
      proof.primary.manifestDocumentKey !== ctx.input.artifact.source.manifestDocumentKey ||
      proof.primary.sourceSha256 !== ctx.input.artifact.source.sourcePdfSha256 ||
      proof.fiscalYear !== ctx.input.artifact.source.fiscalYear ||
      proof.primary.current !== true
    ) {
      return {
        check: failCheck(
          APPROPRIATIONS_CONFERENCE_VEHICLE_RULE,
          ctx.verificationRunId,
          [],
          [],
          [],
          'conference vehicle proof does not match the exact candidate source',
          undefined,
          { required: true, blocking: true, riskPoints: 100 },
        ),
        discrepancies: [
          makeDiscrepancy(
            'appropriations_conference_vehicle_source_mismatch',
            'blocking',
            'wrong report/vehicle/source bytes for appropriations conference',
            [],
            [],
            [],
            {},
          ),
        ],
      };
    }
    return {
      check: passCheck(
        APPROPRIATIONS_CONFERENCE_VEHICLE_RULE,
        ctx.verificationRunId,
        [],
        [],
        [],
        `appropriations conference is bound to ${proof.billId}${
          proof.reportNumber != null ? ` / ${proof.reportNumber}` : ''
        }`,
        {
          billId: proof.billId,
          reportNumber: proof.reportNumber ?? null,
          vehicleStructure: proof.vehicleStructure,
          division: proof.division ?? null,
          title: proof.title ?? null,
        },
        { required: true, blocking: true },
      ),
      discrepancies: [],
    };
  },
};
