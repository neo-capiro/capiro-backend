/** Phase 6 Workstream K — independent appropriations conference certification. */
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
} from '../../../contracts/extraction-artifact-v1.js';
import { ReferenceArtifactIndexV1 } from '../../../verification/rules/comparison/reference-artifact-index.js';
import {
  APPROPRIATIONS_CONFERENCE_CHAMBER_POSITIONS_FIELD,
  APPROPRIATIONS_CONFERENCE_VEHICLE_PROOF_FIELD,
  appropriationsConferenceChamberPositionsV1Schema,
  appropriationsConferenceVehicleProofV1Schema,
} from './appropriations-conference-facts-v1.js';

type DocumentFactAssertionV1 = Extract<DefenseBudgetAssertionV1, { assertionKind: 'document_fact' }>;

export interface AppropriationsConferenceCertificationV1 {
  schemaVersion: 'appropriations_conference_certification_v1';
  status: 'CERTIFIED' | 'NOT_RUN' | 'BLOCKED';
  findings: string[];
  conferenceAssertionIds: string[];
}

export function certifyAppropriationsConferenceV1(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  referenceArtifacts: readonly DefenseBudgetExtractionArtifactV1[];
}): AppropriationsConferenceCertificationV1 {
  const findings: string[] = [];
  if (input.artifact.source.authority !== 'appropriations_conference') {
    findings.push('wrong_track_or_vehicle');
  }
  const funding = input.artifact.assertions.filter((assertion) => assertion.assertionKind === 'funding');
  const wrongFields = funding.filter((assertion) => assertion.field !== 'conference');
  if (wrongFields.length > 0) findings.push('conference_field_ownership_violation');
  const conference = funding.filter((assertion) => assertion.field === 'conference');
  if (conference.length === 0) findings.push('conference_position_missing');

  const proofAssertions = input.artifact.assertions.filter(
    (assertion): assertion is DocumentFactAssertionV1 =>
      assertion.assertionKind === 'document_fact' &&
      assertion.fieldName === APPROPRIATIONS_CONFERENCE_VEHICLE_PROOF_FIELD,
  );
  if (proofAssertions.length !== 1) findings.push('vehicle_proof_missing_or_ambiguous');
  else if (!appropriationsConferenceVehicleProofV1Schema.safeParse(proofAssertions[0]!.value).success) {
    findings.push('vehicle_proof_invalid');
  }

  const chamberFacts = input.artifact.assertions.flatMap((assertion) => {
    if (
      assertion.assertionKind !== 'document_fact' ||
      assertion.fieldName !== APPROPRIATIONS_CONFERENCE_CHAMBER_POSITIONS_FIELD
    ) return [];
    const parsed = appropriationsConferenceChamberPositionsV1Schema.safeParse(assertion.value);
    return parsed.success ? [parsed.data] : [];
  });
  const index = ReferenceArtifactIndexV1.fromArtifacts(input.referenceArtifacts);
  let missingComparison = false;
  for (const fact of chamberFacts) {
    const key = JSON.stringify(fact.identity);
    for (const chamber of [
      { field: 'hacDMark', printed: fact.hacd },
      { field: 'sacDMark', printed: fact.sacd },
    ] as const) {
      const match = index.lookupFunding(key, fact.fiscalYear, chamber.field);
      if (match.kind === 'zero') {
        missingComparison = true;
        continue;
      }
      if (match.kind === 'multiple') {
        findings.push(`ambiguous_${chamber.field}`);
        continue;
      }
      if (chamber.printed.status === 'PRINTED' && match.value.valueMillions !== chamber.printed.money.valueMillions) {
        findings.push(`printed_${chamber.field}_mismatch`);
      }
    }
  }
  if (chamberFacts.length !== conference.length) findings.push('conference_chamber_fact_coverage_mismatch');

  const blocking = findings.length > 0;
  return {
    schemaVersion: 'appropriations_conference_certification_v1',
    status: blocking ? 'BLOCKED' : missingComparison ? 'NOT_RUN' : 'CERTIFIED',
    findings,
    conferenceAssertionIds: conference.map((assertion) => assertion.assertionId).sort(),
  };
}
