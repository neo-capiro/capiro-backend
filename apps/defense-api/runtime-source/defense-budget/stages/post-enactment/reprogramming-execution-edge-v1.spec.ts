import { composeExecutionRecordV1, composeReprogrammingEventV1 } from './reprogramming-execution-v1.js';

const SHA = 'a'.repeat(64);
const PE1 = { lineKind: 'RDTE_PE' as const, peCode: '0605053A' };
const PE2 = { lineKind: 'RDTE_PE' as const, peCode: '0603270A' };
const money = (value: string, unit: 'millions' | 'thousands' = 'millions') => ({
  originalValue: value,
  originalUnit: unit,
  valueMillions: unit === 'millions' ? value : String(Number(value) / 1000),
});

describe('Phase 6 M exact post-enactment edge semantics', () => {
  it('refuses policy-derived reprogramming arithmetic across printed units', () => {
    expect(() =>
      composeReprogrammingEventV1({
        schemaVersion: 'defense_budget_reprogramming_event_v1', eventId: 'r1', controlNumber: 'R-1', status: 'approved', date: '2027-10-01', fiscalYear: 2027,
        sourceDocumentId: 'doc', sourceSha256: SHA, sourceIdentity: PE1, destinationIdentity: PE2,
        amount: money('5', 'millions'), sourceBefore: money('100000', 'thousands'), policyAllowsDerivedRevisedTotal: true, evidenceIds: ['e1'],
      }),
    ).toThrow(/unit mismatch/);
  });

  it('keeps transfer actions separate even when revised totals are explicit', () => {
    const result = composeReprogrammingEventV1({
      schemaVersion: 'defense_budget_reprogramming_event_v1', eventId: 'r2', controlNumber: 'R-2', status: 'approved', date: '2027-10-02', fiscalYear: 2027,
      sourceDocumentId: 'doc', sourceSha256: SHA, sourceIdentity: PE1, destinationIdentity: PE2,
      amount: money('5'), sourceAfter: money('95'), destinationAfter: money('55'), evidenceIds: ['e1'],
    });
    expect(result.actions.map((action) => action.actionType).sort()).toEqual(['transfer_in', 'transfer_out']);
    expect(result.revisedPositions).toHaveLength(2);
    expect(result.revisedPositions.every((position) => position.revisedTotalBasis === 'explicit_after')).toBe(true);
  });

  it('keeps cumulative and period execution records semantically distinct', () => {
    const profile = { schemaVersion: 'execution_source_profile_v1', profileId: 'exec', fiscalYear: 2027, metric: 'obligations', sourceSystem: 'DFAS', sourceDocumentId: 'exec-doc', sourceSha256: SHA, mapsToExecutedField: true };
    const base = { schemaVersion: 'execution_record_v1', recordId: 'e1', identity: PE1, metric: 'obligations', asOfDate: '2027-12-31', budgetFiscalYear: 2027, amount: money('10'), sourceSystem: 'DFAS', sourceDocumentId: 'exec-doc', sourceSha256: SHA, evidenceIds: ['e1'] };
    expect(composeExecutionRecordV1(profile, { ...base, cumulative: true }).executedPosition?.cumulative).toBe(true);
    expect(composeExecutionRecordV1(profile, { ...base, recordId: 'e2', cumulative: false }).executedPosition?.cumulative).toBe(false);
  });
});
