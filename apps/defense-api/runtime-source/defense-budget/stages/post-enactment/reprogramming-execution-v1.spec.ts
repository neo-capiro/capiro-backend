import type { BudgetLineIdentityV1 } from '../../contracts/extraction-artifact-v1.js';
import {
  composeExecutionRecordV1,
  composeReprogrammingEventV1,
} from './reprogramming-execution-v1.js';
import {
  lifecyclePositionV1Schema,
  reconcileLifecyclePairV1,
} from './lifecycle-reconciliation-v1.js';

const A: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0605053A' };
const B: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0603270A' };
const money = (value: string) => ({
  originalValue: value,
  originalUnit: 'millions' as const,
  valueMillions: value,
});
function reprogram(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'defense_budget_reprogramming_event_v1',
    eventId: 'rp-1',
    controlNumber: 'FY27-001',
    status: 'approved',
    date: '2027-10-10',
    fiscalYear: 2027,
    sourceDocumentId: 'rp-doc',
    sourceSha256: 'a'.repeat(64),
    sourceIdentity: A,
    destinationIdentity: B,
    amount: money('5'),
    purpose: 'realign funds',
    evidenceIds: ['e1'],
    ...overrides,
  };
}
function executionProfile(metric: 'obligations' | 'outlays', mapsToExecutedField = true) {
  return {
    schemaVersion: 'execution_source_profile_v1',
    profileId: `exec-${metric}`,
    fiscalYear: 2027,
    metric,
    sourceSystem: 'DFAS',
    sourceDocumentId: 'exec-doc',
    sourceSha256: 'b'.repeat(64),
    mapsToExecutedField,
  };
}
function executionRecord(metric: 'obligations' | 'outlays', cumulative = true) {
  return {
    schemaVersion: 'execution_record_v1',
    recordId: `rec-${metric}-${cumulative}`,
    identity: A,
    metric,
    asOfDate: '2027-12-31',
    budgetFiscalYear: 2027,
    amount: money('75'),
    sourceSystem: 'DFAS',
    sourceDocumentId: 'exec-doc',
    sourceSha256: 'b'.repeat(64),
    evidenceIds: ['e2'],
    cumulative,
  };
}

describe('Phase 6 Workstream M post-enactment', () => {
  it('keeps a reprogramming transfer with no revised total as actions only', () => {
    const result = composeReprogrammingEventV1(reprogram());
    expect(result.actions).toHaveLength(2);
    expect(result.revisedPositions).toHaveLength(0);
    expect(result.actions.map((a) => a.actionType).sort()).toEqual(['transfer_in', 'transfer_out']);
  });

  it('emits an explicit revised total without losing transfer actions', () => {
    const result = composeReprogrammingEventV1(
      reprogram({ sourceAfter: money('95'), destinationAfter: money('55') }),
    );
    expect(result.actions).toHaveLength(2);
    expect(result.revisedPositions).toHaveLength(2);
    expect(result.revisedPositions.every((p) => p.field === 'reprogrammed')).toBe(true);
    expect(result.revisedPositions.every((p) => p.directOrDerived === 'direct')).toBe(true);
  });

  it('preserves multiple transfer actions instead of netting', () => {
    const first = composeReprogrammingEventV1(reprogram({ eventId: 'rp-1', amount: money('5') }));
    const second = composeReprogrammingEventV1(reprogram({ eventId: 'rp-2', amount: money('2') }));
    expect([...first.actions, ...second.actions]).toHaveLength(4);
  });

  it('keeps obligations and outlays as different execution metrics', () => {
    const obligations = composeExecutionRecordV1(
      executionProfile('obligations'),
      executionRecord('obligations'),
    );
    const outlays = composeExecutionRecordV1(executionProfile('outlays'), executionRecord('outlays'));
    expect(obligations.metricFact.metric).toBe('obligations');
    expect(outlays.metricFact.metric).toBe('outlays');
    expect(obligations.executedPosition?.metric).not.toBe(outlays.executedPosition?.metric);
  });

  it('preserves cumulative versus period execution', () => {
    expect(
      composeExecutionRecordV1(
        executionProfile('obligations'),
        executionRecord('obligations', true),
      ).metricFact.cumulative,
    ).toBe(true);
    expect(
      composeExecutionRecordV1(
        executionProfile('obligations'),
        executionRecord('obligations', false),
      ).metricFact.cumulative,
    ).toBe(false);
  });

  it('rejects execution without an as-of date', () => {
    const bad = { ...executionRecord('obligations'), asOfDate: undefined };
    expect(() => composeExecutionRecordV1(executionProfile('obligations'), bad)).toThrow();
  });

  it('rejects an ambiguous execution metric', () => {
    expect(() =>
      composeExecutionRecordV1(executionProfile('obligations'), executionRecord('outlays')),
    ).toThrow(/ambiguous execution metric/);
  });

  it('blocks cross-FY lifecycle mismatch', () => {
    const from = lifecyclePositionV1Schema.parse({
      positionId: 'p1',
      stage: 'enacted',
      identity: A,
      fiscalYear: 2027,
      money: money('100'),
      scopeKey: 'line',
    });
    const to = lifecyclePositionV1Schema.parse({
      positionId: 'p2',
      stage: 'reprogrammed',
      identity: A,
      fiscalYear: 2028,
      money: money('105'),
      scopeKey: 'line',
    });
    expect(reconcileLifecyclePairV1(from, to)).toMatchObject({
      status: 'BLOCKED',
      reason: 'fiscal-year mismatch',
    });
  });

  it('computes an exact lifecycle delta', () => {
    const from = lifecyclePositionV1Schema.parse({
      positionId: 'p1',
      stage: 'enacted',
      identity: A,
      fiscalYear: 2027,
      money: money('100.25'),
      scopeKey: 'line',
    });
    const to = lifecyclePositionV1Schema.parse({
      positionId: 'p2',
      stage: 'reprogrammed',
      identity: A,
      fiscalYear: 2027,
      money: money('105.75'),
      scopeKey: 'line',
    });
    expect(reconcileLifecyclePairV1(from, to)).toMatchObject({ status: 'PASS', deltaMillions: '5.5' });
  });

  it('returns NOT_RUN for a missing comparison stage rather than zero', () => {
    const from = lifecyclePositionV1Schema.parse({
      positionId: 'p1',
      stage: 'enacted',
      identity: A,
      fiscalYear: 2027,
      money: money('100'),
      scopeKey: 'line',
    });
    expect(reconcileLifecyclePairV1(from, undefined)).toMatchObject({
      status: 'NOT_RUN',
      reason: expect.stringContaining('missing is not zero'),
    });
  });
});
