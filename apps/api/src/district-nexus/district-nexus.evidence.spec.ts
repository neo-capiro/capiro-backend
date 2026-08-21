import { describe, expect, test } from '@jest/globals';
import {
  assistanceRowToEvidence,
  contractRowToEvidence,
  facilityRowToEvidence,
  relationshipRowToEvidence,
  type AssistanceEvidenceSourceRow,
  type ContractEvidenceSourceRow,
  type FacilityEvidenceSourceRow,
  type RelationshipEvidenceSourceRow,
} from './district-nexus.evidence.js';

function contractRow(partial: Partial<ContractEvidenceSourceRow> = {}): ContractEvidenceSourceRow {
  return {
    id: 'award-1',
    contractorName: 'Acme Defense LLC',
    state: 'TX',
    district: '23',
    amount: 5_000_000,
    actionDate: '2026-03-01T00:00:00.000Z',
    lastSyncedAt: '2026-07-20T00:00:00.000Z',
    ...partial,
  };
}

function assistanceRow(partial: Partial<AssistanceEvidenceSourceRow> = {}): AssistanceEvidenceSourceRow {
  return {
    id: 'faa-1',
    recipientUei: 'K2QB7VNX9DM4',
    recipientName: 'Acme Research Institute',
    state: 'TX',
    district: '23',
    basis: 'place_of_performance',
    totalObligated: 1_200_000,
    startDate: '2026-01-15T00:00:00.000Z',
    lastSyncedAt: '2026-07-20T00:00:00.000Z',
    popCdVintage: 'original',
    ...partial,
  };
}

function facilityRow(partial: Partial<FacilityEvidenceSourceRow> = {}): FacilityEvidenceSourceRow {
  return {
    id: 'fac-1',
    name: 'Acme HQ',
    state: 'TX',
    districtCode: '23',
    employeeCount: 420,
    geocodeStatus: 'matched',
    districtSource: 'geocoded',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...partial,
  };
}

function relationshipRow(
  partial: Partial<RelationshipEvidenceSourceRow> = {},
): RelationshipEvidenceSourceRow {
  return {
    id: 'rel-1',
    relationshipType: 'subrecipient',
    counterparty: 'Acme Research Institute',
    state: 'TX',
    district: '23',
    geographyBasis: 'place_of_performance',
    status: 'inferred',
    confidence: null,
    externalUseApproved: false,
    popCdVintage: 'original',
    obligatedAmount: 250_000,
    sourceUpdatedAt: '2026-07-20T00:00:00.000Z',
    observedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('contractRowToEvidence', () => {
  test('maps a well-formed name-matched row to inferred, unverified-vintage evidence', () => {
    const out = contractRowToEvidence(contractRow());
    expect(out?.districtKey).toBe('TX-23');
    expect(out?.evidence).toEqual({
      component: 'contractPlaceOfPerformance',
      sourceType: 'federal_award',
      label: 'Acme Defense LLC',
      sourceRecordId: 'award-1',
      sourceUpdatedAt: '2026-07-20T00:00:00.000Z',
      observedAt: '2026-03-01T00:00:00.000Z',
      geographyBasis: 'place_of_performance',
      // No matchBasis on the row (or 'contractor_name' explicitly) is honestly inferred.
      verificationStatus: 'inferred',
      confidence: null,
      externalUseApproved: true,
      // federal_award carries no CD-vintage or Congress-number column at all.
      boundaryVintage: 'unknown',
      boundaryCongress: null,
      amount: 5_000_000,
    });
  });

  test('a UEI-matched row (Release 1) is source-verified with full confidence', () => {
    const out = contractRowToEvidence(contractRow({ matchBasis: 'uei' }));
    expect(out?.evidence.verificationStatus).toBe('source_verified');
    expect(out?.evidence.confidence).toBe(1);
  });

  test('falls back to a generic label when the contractor name is missing', () => {
    expect(contractRowToEvidence(contractRow({ contractorName: null }))?.evidence.label).toBe(
      'Federal contract award',
    );
  });

  test('a sentinel or missing state/district produces no evidence row', () => {
    expect(contractRowToEvidence(contractRow({ district: '90' }))).toBeNull();
    expect(contractRowToEvidence(contractRow({ state: null }))).toBeNull();
  });

  test('never fabricates a confidence number for a name-only match', () => {
    expect(contractRowToEvidence(contractRow())?.evidence.confidence).toBeNull();
  });
});

describe('assistanceRowToEvidence', () => {
  test('matchBasis "uei" is source-verified with full confidence', () => {
    const out = assistanceRowToEvidence(assistanceRow({ matchBasis: 'uei' }));
    expect(out?.evidence.verificationStatus).toBe('source_verified');
    expect(out?.evidence.confidence).toBe(1);
  });

  test('matchBasis "recipient_name" is inferred, even though the row has a UEI on file', () => {
    // The row still HAS a UEI, but the caller's query says it matched some
    // other way — it must not borrow the stronger status just because a UEI
    // happens to be present on the record.
    const out = assistanceRowToEvidence(assistanceRow({ matchBasis: 'recipient_name' }));
    expect(out?.evidence.verificationStatus).toBe('inferred');
    expect(out?.evidence.confidence).toBeNull();
  });

  test('an absent matchBasis defaults to recipient_name — the conservative direction', () => {
    const out = assistanceRowToEvidence(assistanceRow());
    expect(out?.evidence.verificationStatus).toBe('inferred');
  });

  test('geographyBasis passes through the row basis verbatim', () => {
    expect(
      assistanceRowToEvidence(assistanceRow({ basis: 'recipient_location' }))?.evidence.geographyBasis,
    ).toBe('recipient_location');
  });

  test.each([
    ['original', 'original'],
    ['current', 'current'],
    [null, 'unknown'],
    ['garbage', 'unknown'],
  ])('popCdVintage %p maps to boundaryVintage %p', (raw, expected) => {
    expect(assistanceRowToEvidence(assistanceRow({ popCdVintage: raw }))?.evidence.boundaryVintage).toBe(
      expected,
    );
  });

  test('boundaryCongress is always null — federal_assistance_award carries no Congress-number column', () => {
    expect(assistanceRowToEvidence(assistanceRow({ matchBasis: 'uei' }))?.evidence.boundaryCongress).toBeNull();
  });

  test('a sentinel district produces no evidence row', () => {
    expect(assistanceRowToEvidence(assistanceRow({ district: 'ZZ' }))).toBeNull();
  });
});

describe('facilityRowToEvidence', () => {
  test('a geocoded facility is geocode_verified with full confidence, on both slots', () => {
    const out = facilityRowToEvidence(facilityRow());
    expect(out?.districtKey).toBe('TX-23');
    expect(out?.facility.component).toBe('verifiedFacility');
    expect(out?.facility.verificationStatus).toBe('geocode_verified');
    expect(out?.facility.confidence).toBe(1);
    expect(out?.employees?.component).toBe('verifiedEmployees');
    expect(out?.employees?.verificationStatus).toBe('geocode_verified');
  });

  test('a hand-typed district is user_provided with no fabricated confidence', () => {
    const out = facilityRowToEvidence(
      facilityRow({ districtSource: 'user', geocodeStatus: null }),
    );
    expect(out?.facility.verificationStatus).toBe('user_provided');
    expect(out?.facility.confidence).toBeNull();
  });

  test('a web-imported district is trusted the same as user-typed, not a third tier', () => {
    const webImport = facilityRowToEvidence(
      facilityRow({ districtSource: 'web_import', geocodeStatus: null }),
    );
    const userTyped = facilityRowToEvidence(
      facilityRow({ districtSource: 'user', geocodeStatus: null }),
    );
    expect(webImport?.facility.verificationStatus).toBe(userTyped?.facility.verificationStatus);
  });

  test('geocodeStatus=matched counts even if districtSource says otherwise is absent', () => {
    const out = facilityRowToEvidence(facilityRow({ districtSource: null, geocodeStatus: 'matched' }));
    expect(out?.facility.verificationStatus).toBe('geocode_verified');
  });

  test('facility data is never externally approved by default', () => {
    // Client-supplied facts require an approval workflow this repo does not
    // have yet (plan §8.5 / the deferred §6.3 evidence table).
    const out = facilityRowToEvidence(facilityRow());
    expect(out?.facility.externalUseApproved).toBe(false);
    expect(out?.employees?.externalUseApproved).toBe(false);
  });

  test('a null employee count produces no employees evidence — absence, not zero', () => {
    const out = facilityRowToEvidence(facilityRow({ employeeCount: null }));
    expect(out?.facility).toBeTruthy();
    expect(out?.employees).toBeNull();
  });

  test('neither evidence slot carries a fabricated amount — facilities are not money', () => {
    const out = facilityRowToEvidence(facilityRow());
    expect(out?.facility.amount).toBeNull();
    expect(out?.employees?.amount).toBeNull();
  });

  test('an unresolvable district produces no evidence at all', () => {
    expect(facilityRowToEvidence(facilityRow({ districtCode: '90' }))).toBeNull();
    expect(facilityRowToEvidence(facilityRow({ state: null }))).toBeNull();
  });

  test('boundaryCongress carries the stored congressionalDistrictCongress verbatim', () => {
    const out = facilityRowToEvidence(facilityRow({ congressionalDistrictCongress: 119 }));
    expect(out?.facility.boundaryCongress).toBe(119);
  });

  test('boundaryCongress is null when the facility carries none — never guessed', () => {
    const out = facilityRowToEvidence(facilityRow({ congressionalDistrictCongress: null }));
    expect(out?.facility.boundaryCongress).toBeNull();
  });
});

describe('relationshipRowToEvidence (audit F4)', () => {
  test('maps a well-formed row, labelling the role and counterparty', () => {
    const out = relationshipRowToEvidence(relationshipRow());
    expect(out?.districtKey).toBe('TX-23');
    expect(out?.evidence).toEqual({
      component: 'grantPlaceOfPerformance',
      sourceType: 'client_grant_nexus',
      label: 'Subrecipient — Acme Research Institute',
      sourceRecordId: 'rel-1',
      sourceUpdatedAt: '2026-07-20T00:00:00.000Z',
      observedAt: '2026-01-01T00:00:00.000Z',
      geographyBasis: 'place_of_performance',
      verificationStatus: 'inferred',
      confidence: null,
      externalUseApproved: false,
      boundaryVintage: 'original',
      boundaryCongress: null,
      amount: 250_000,
    });
  });

  test('a partner/beneficiary role maps to the partnerBeneficiary component', () => {
    expect(
      relationshipRowToEvidence(relationshipRow({ relationshipType: 'beneficiary' }))?.evidence.component,
    ).toBe('partnerBeneficiary');
  });

  test('an unrecognised relationship type produces no evidence row', () => {
    expect(relationshipRowToEvidence(relationshipRow({ relationshipType: 'something_new' }))).toBeNull();
  });

  test('a sentinel or missing state/district produces no evidence row', () => {
    expect(relationshipRowToEvidence(relationshipRow({ district: '90' }))).toBeNull();
    expect(relationshipRowToEvidence(relationshipRow({ state: null }))).toBeNull();
  });

  test('a facility-supplied district is always boundaryVintage current, regardless of the award vintage', () => {
    const out = relationshipRowToEvidence(
      relationshipRow({ geographyBasis: 'project_site', popCdVintage: 'original' }),
    );
    expect(out?.evidence.boundaryVintage).toBe('current');
  });

  test('a project-site relationship carries the linked facility’s boundaryCongress', () => {
    const out = relationshipRowToEvidence(
      relationshipRow({ geographyBasis: 'project_site', boundaryCongress: 119 }),
    );
    expect(out?.evidence.boundaryCongress).toBe(119);
  });

  test('an award-sourced relationship never carries a facility boundaryCongress', () => {
    const out = relationshipRowToEvidence(
      relationshipRow({ geographyBasis: 'place_of_performance', boundaryCongress: 119 }),
    );
    expect(out?.evidence.boundaryCongress).toBeNull();
  });

  test.each([
    ['original', 'original'],
    ['current', 'current'],
    [null, 'unknown'],
    ['garbage', 'unknown'],
  ])('when geography is award-sourced, popCdVintage %p maps to boundaryVintage %p', (raw, expected) => {
    expect(
      relationshipRowToEvidence(relationshipRow({ geographyBasis: 'place_of_performance', popCdVintage: raw }))
        ?.evidence.boundaryVintage,
    ).toBe(expected);
  });

  test('never hardcodes externalUseApproved — it is the reviewer\'s own flag, not decoration', () => {
    expect(
      relationshipRowToEvidence(relationshipRow({ externalUseApproved: true }))?.evidence.externalUseApproved,
    ).toBe(true);
    expect(
      relationshipRowToEvidence(relationshipRow({ externalUseApproved: false }))?.evidence.externalUseApproved,
    ).toBe(false);
  });

  test('falls back to a role-only label when there is no counterparty', () => {
    expect(relationshipRowToEvidence(relationshipRow({ counterparty: null }))?.evidence.label).toBe(
      'Subrecipient',
    );
  });

  test('status/confidence pass through verbatim — they come from relationshipTier via the caller, never recomputed here', () => {
    const out = relationshipRowToEvidence(relationshipRow({ status: 'source_verified', confidence: 1 }));
    expect(out?.evidence.verificationStatus).toBe('source_verified');
    expect(out?.evidence.confidence).toBe(1);
  });
});
