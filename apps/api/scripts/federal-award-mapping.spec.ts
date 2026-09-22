import { describe, expect, it } from '@jest/globals';
import {
  type ContractAwardRecord,
  mapContractAwardRecord,
} from './federal-award-mapping.js';

// Sanitized verbatim fields from USAspending spending_by_award for W9128Z26FA001,
// captured 2026-09-21. Values are public federal award data.
const realRecord: ContractAwardRecord = {
  internal_id: 355423040,
  'Award ID': 'W9128Z26FA001',
  'Recipient Name': 'PALANTIR USG INC',
  'Award Amount': 545578476.94,
  'Action Date': null,
  'Start Date': '2025-10-15',
  'End Date': '2029-05-31',
  'Base Obligation Date': '2025-11-21',
  'Last Modified Date': '2026-05-14 13:09:08',
  generated_internal_id: 'CONT_AWD_W9128Z26FA001_9700_W519TC25D0039_9700',
};

function oldMapping(record: ContractAwardRecord) {
  const actionDate = record['Action Date'] ?? record['Last Modified Date'] ?? null;
  return {
    awardUniqueId: String(record.generated_internal_id ?? record.internal_id ?? ''),
    piid: record['Award ID'] ?? null,
    fain: null,
    awardingAgency: record['Awarding Agency'] ?? null,
    awardingSubTier: record['Awarding Sub Agency'] ?? null,
    contractorName: record['Recipient Name'] ?? null,
    recipientUei: null,
    amount: record['Award Amount'] != null ? Number(record['Award Amount']) : null,
    description: record.Description ?? null,
    popState: record['Place of Performance State Code'] ?? null,
    popCongressionalDistrict: record['Place of Performance Congressional District'] ?? null,
    recipientState: record['Recipient Location State Code'] ?? null,
    recipientCongressionalDistrict: record['Recipient Location Congressional District'] ?? null,
    actionDate: actionDate ? new Date(actionDate) : null,
    awardedAt: actionDate ? new Date(actionDate) : null,
  };
}

describe('mapContractAwardRecord', () => {
  it('keeps source date concepts distinct and preserves the verbatim record', () => {
    const mapped = mapContractAwardRecord(realRecord, '2026-09-21T12:00:00.000Z');

    expect(mapped.baseAwardSignedDate).toEqual(new Date('2025-11-21'));
    expect(mapped.latestActionDate).toBeNull();
    expect(mapped.sourceLastModifiedDate).toEqual(new Date('2026-05-14 13:09:08'));
    expect(mapped.popStartDate).toEqual(new Date('2025-10-15'));
    expect(mapped.popEndDate).toEqual(new Date('2029-05-31'));
    expect(mapped.dateSemanticsVersion).toBe(1);
    expect(mapped.sourceRecord).toEqual(realRecord);
  });

  it('does not fall back from modification dates into new semantic columns', () => {
    const record: ContractAwardRecord = {
      generated_internal_id: 'CONT_AWD_NULL_DATES',
      'Last Modified Date': '2026-05-14 13:09:08',
    };
    const mapped = mapContractAwardRecord(record, '2026-09-21T12:00:00.000Z');

    expect(mapped.latestActionDate).toBeNull();
    expect(mapped.baseAwardSignedDate).toBeNull();
    expect(mapped.popStartDate).toBeNull();
    expect(mapped.popEndDate).toBeNull();
    expect(mapped.actionDate).toEqual(new Date('2026-05-14 13:09:08'));
    expect(mapped.awardedAt).toEqual(new Date('2026-05-14 13:09:08'));
  });

  it('leaves every legacy mapped column unchanged', () => {
    const mapped = mapContractAwardRecord(realRecord, '2026-09-21T12:00:00.000Z');
    const legacy = oldMapping(realRecord);

    expect(mapped).toMatchObject(legacy);
    expect(mapped.raw).toEqual({
      generatedInternalId: legacy.awardUniqueId,
      piid: legacy.piid,
      fain: legacy.fain,
      recipientName: legacy.contractorName,
      recipientUei: legacy.recipientUei,
      amount: legacy.amount,
      description: legacy.description,
      awardingAgency: legacy.awardingAgency,
      awardingSubTier: legacy.awardingSubTier,
      actionDate: '2026-05-14 13:09:08',
      popState: legacy.popState,
      popCongressionalDistrict: legacy.popCongressionalDistrict,
      recipientState: legacy.recipientState,
      recipientCongressionalDistrict: legacy.recipientCongressionalDistrict,
    });
  });
});
