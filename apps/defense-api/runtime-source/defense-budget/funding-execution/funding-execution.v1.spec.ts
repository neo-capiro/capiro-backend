import { adaptFundingExecutionV1, certifyFundingExecutionV1, type FundingExecutionFactV1 } from './funding-execution.v1.js';
import { composeExecutionRecordV1, composeReprogrammingEventV1 } from '../stages/post-enactment/reprogramming-execution-v1.js';

const A = { lineKind: 'RDTE_PE' as const, peCode: '0605053A' };
const B = { lineKind: 'RDTE_PE' as const, peCode: '0603270A' };
const money = (value: string) => ({ originalValue: value, originalUnit: 'millions' as const, valueMillions: value });
function reprogram(status: 'requested' | 'approved', eventId: string, amount = '5') {
  return composeReprogrammingEventV1({ schemaVersion: 'defense_budget_reprogramming_event_v1', eventId,
    controlNumber: eventId, status, date: '2027-10-10', fiscalYear: 2027, sourceDocumentId: 'rp-doc',
    sourceSha256: 'a'.repeat(64), sourceIdentity: A, destinationIdentity: B, amount: money(amount), evidenceIds: ['e1'] });
}
function execution(id: string, value: string, cumulative: boolean) {
  return composeExecutionRecordV1({ schemaVersion: 'execution_source_profile_v1', profileId: id,
    fiscalYear: 2027, metric: 'obligations', sourceSystem: 'DFAS', sourceDocumentId: 'exec-doc',
    sourceSha256: 'b'.repeat(64), mapsToExecutedField: true }, { schemaVersion: 'execution_record_v1',
    recordId: id, identity: A, metric: 'obligations', asOfDate: '2027-12-31', budgetFiscalYear: 2027,
    amount: money(value), sourceSystem: 'DFAS', sourceDocumentId: 'exec-doc', sourceSha256: 'b'.repeat(64),
    evidenceIds: ['e2'], cumulative });
}

describe('funding/execution pure certification', () => {
  it('keeps requested and approved alias transitions in distinct proposed/enacted buckets', () => {
    const facts = adaptFundingExecutionV1([reprogram('requested', 'p1'), reprogram('approved', 'p2')]);
    const result = certifyFundingExecutionV1({ facts });
    expect(result.proposed).toHaveLength(2);
    expect(result.enacted).toHaveLength(2);
    expect(result.canonicalAnnualPromotionAllowed).toBe(false);
  });

  it('adapts source-qualified supplemental/CR/reconciliation/rescission measures by governed status', () => {
    const base = { fiscalYear: 2027, asOfDate: '2027-10-01', amountBasis: 'transaction_delta' as const, sourceSystem: 'GovInfo', sourceDocumentId: 'pl-1', sourceIdentity: 'PL-117-1',
      amountMillions: '-1.25', originalAmount: '-1250', originalUnit: 'thousands' as const, evidenceIds: ['ev-1'] };
    const facts = adaptFundingExecutionV1([], [], [
      { ...base, id: 'supp', measureType: 'supplemental', status: 'enacted', amountMillions: '12.5', originalAmount: '12500' },
      { ...base, id: 'rec', measureType: 'reconciliation', status: 'active', amountMillions: '2', originalAmount: '2000' },
      { ...base, id: 'cr', measureType: 'continuing_resolution', status: 'introduced', amountMillions: '3', originalAmount: '3000' },
      { ...base, id: 'resc', measureType: 'rescission', status: 'enacted' },
      { ...base, id: 'draft', measureType: 'emergency_supplemental', status: 'draft' },
      { ...base, id: 'rejected', measureType: 'supplemental', status: 'rejected' },
      { ...base, id: 'withdrawn', measureType: 'supplemental', status: 'withdrawn' },
    ]);
    const result = certifyFundingExecutionV1({ facts });
    expect(result.enacted.map((x) => x.recordId)).toEqual(['supp', 'rec', 'resc']);
    expect(result.proposed.map((x) => x.recordId)).toEqual(['cr', 'draft']);
    expect(facts.find((x) => x.recordId === 'resc')).toMatchObject({ actionType: 'rescission',
      amountMillions: '-1.25', originalAmount: '-1250', originalUnit: 'thousands',
      sourceDocumentId: 'pl-1', evidenceIds: ['ev-1'] });
    expect(result.findings).toEqual([]);
  });

  it('flags a positive source rescission rather than silently changing its sign', () => {
    const fact = adaptFundingExecutionV1([], [], [{ id: 'bad-resc', measureType: 'rescission', status: 'enacted',
      fiscalYear: 2027, asOfDate: '2027-10-01', amountBasis: 'transaction_delta', sourceSystem: 'GovInfo', sourceDocumentId: 'pl-2', sourceIdentity: 'PL-117-2',
      amountMillions: '1', originalAmount: '1000', originalUnit: 'thousands', evidenceIds: ['ev-2'] }]);
    expect(certifyFundingExecutionV1({ facts: fact }).findings).toEqual(['rescission_not_negative:bad-resc']);
  });

  it('retains split fanout as balanced paired actions, not a netted allocation', () => {
    const facts = adaptFundingExecutionV1([reprogram('approved', 'split-a', '4'), reprogram('approved', 'split-b', '3')]);
    const result = certifyFundingExecutionV1({ facts });
    expect(result.enacted).toHaveLength(4);
    expect(result.findings).toEqual([]);
  });

  it('keeps cumulative snapshots separate from transaction deltas and preserves negative obligations', () => {
    const facts = adaptFundingExecutionV1([], [execution('snapshot', '20', true), execution('delta', '-2', false)]);
    const result = certifyFundingExecutionV1({ facts });
    expect(result.executionSnapshots.map((x) => x.amountMillions)).toEqual(['20']);
    expect(result.executionDeltas.map((x) => x.amountMillions)).toEqual(['-2']);
  });

  it('reports candidate/unresolved/incompatible residual without inferring allocations', () => {
    const scope = { fiscalYear: 2027, account: 'A', measure: 'obligations', unit: 'millions' };
    const statement = { id: 's1', scope, statedAmountMillions: '100', evidenceIds: ['source-e'], allocations: [
      { id: 'verified', scope, amountMillions: '30', review: 'verified' as const, evidenceIds: ['v-e'], targetIdentity: 'PE-1' },
      { id: 'candidate', scope, amountMillions: '50', review: 'candidate' as const, evidenceIds: ['c-e'], targetIdentity: 'PE-2' },
      { id: 'unresolved', scope, amountMillions: '20', review: 'unresolved' as const, evidenceIds: ['u-e'] },
      { id: 'other-scope', scope: { ...scope, account: 'B' }, amountMillions: '99', review: 'verified' as const, evidenceIds: ['x-e'] },
    ] };
    const result = certifyFundingExecutionV1({ facts: [], statements: [statement] });
    expect(result.reconciliation[0]).toMatchObject({ verifiedAllocatedMillions: '30',
      unallocatedOrUnresolvedMillions: '70', candidateAllocationIds: ['candidate'],
      unresolvedAllocationIds: ['unresolved'], incompatibleAllocationIds: ['other-scope'] });
  });

  it('flags malformed transfer balance and positive rescission facts', () => {
    const facts: FundingExecutionFactV1[] = [
      { kind: 'reprogramming', recordId: 'out', fiscalYear: 2027, amountMillions: '-4', evidenceIds: [], sourceDocumentId: 'd', sourceSystem: 's', transferGroupId: 't', transferDirection: 'out' },
      { kind: 'reprogramming', recordId: 'in', fiscalYear: 2027, amountMillions: '3', evidenceIds: [], sourceDocumentId: 'd', sourceSystem: 's', transferGroupId: 't', transferDirection: 'in' },
      { kind: 'reprogramming', recordId: 'res', fiscalYear: 2027, amountMillions: '1', factKind: 'transaction_delta', evidenceIds: [], sourceDocumentId: 'd', sourceSystem: 's', actionType: 'rescission' },
    ];
    expect(certifyFundingExecutionV1({ facts }).findings).toEqual(['transfer_not_balanced:t', 'rescission_not_negative:res']);
    expect(certifyFundingExecutionV1({ facts: [{ ...facts[2]!, amountMillions: '-1' }] }).findings).toEqual([]);
  });
});
