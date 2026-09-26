import { FundingExecutionSourceAdapterService, FundingExecutionSourceCertificationError } from './funding-execution-source-adapter.service.js';
import type { FundingSourceEventInput } from './funding-execution.store.js';
import { composeExecutionRecordV1, composeReprogrammingEventV1 } from '../defense-budget/stages/post-enactment/reprogramming-execution-v1.js';
import type { FundingExecutionSourceEventStorePort } from './funding-execution-source-adapter.service.js';

const A = { lineKind: 'RDTE_PE' as const, peCode: '0605053A' };
const B = { lineKind: 'RDTE_PE' as const, peCode: '0603270A' };
const RP_MEASURE = '10000000-0000-4000-8000-000000000001';
const EXEC_MEASURE = '20000000-0000-4000-8000-000000000001';
const ALT_MEASURE = '30000000-0000-4000-8000-000000000001';
const money = (value: string) => ({ originalValue: value, originalUnit: 'millions' as const, valueMillions: value });

function transfer() {
  return composeReprogrammingEventV1({ schemaVersion: 'defense_budget_reprogramming_event_v1', eventId: 'RP-42',
    controlNumber: 'RP-42', status: 'approved', date: '2027-10-10', fiscalYear: 2027, sourceDocumentId: 'doc-rp',
    sourceSha256: 'a'.repeat(64), sourceIdentity: A, destinationIdentity: B, amount: money('5'),
    evidenceIds: ['line-out', 'line-in'] });
}

function execution() {
  const composed = composeExecutionRecordV1({ schemaVersion: 'execution_source_profile_v1', profileId: 'dfas-obligations',
    fiscalYear: 2027, metric: 'obligations', sourceSystem: 'DFAS', sourceDocumentId: 'dfas-doc',
    sourceSha256: 'b'.repeat(64), mapsToExecutedField: true }, { schemaVersion: 'execution_record_v1',
    recordId: 'DFAS-ROW-7', identity: A, metric: 'obligations', asOfDate: '2027-12-31', budgetFiscalYear: 2027,
    amount: money('-0.25'), sourceSystem: 'DFAS', sourceDocumentId: 'dfas-doc', sourceSha256: 'b'.repeat(64),
    evidenceIds: ['dfas-evidence'], cumulative: false });
  return composed;
}

function store() {
  const appended: FundingSourceEventInput[][] = [];
  const port: FundingExecutionSourceEventStorePort = {
    appendSourceEvents: jest.fn(async (events) => {
      appended.push([...events]);
      return events.map((_, index) => ({ id: `stored-${index}`, inserted: true }));
    }),
  };
  return { service: new FundingExecutionSourceAdapterService(port), port, appended };
}

describe('FundingExecutionSourceAdapterService', () => {
  test('preserves source-native/evidence identity and never creates allocations', async () => {
    const { service, port, appended } = store();
    const result = await service.run({ reprogramming: [transfer()], execution: [execution()], measureBindings: [
      { kind: 'reprogramming', sourceNativeId: 'RP-42', measureId: RP_MEASURE },
      { kind: 'execution', sourceNativeId: 'DFAS-ROW-7', measureId: EXEC_MEASURE },
    ] }, {
      commit: true, env: { FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED: 'true' },
    });
    expect(result).toMatchObject({ mode: 'COMMIT', factCount: 3, sourceEventCount: 3, insertedCount: 3 });
    expect(port.appendSourceEvents).toHaveBeenCalledTimes(1);
    const events = appended[0]!;
    expect(events.map((event) => event.sourceRecordId)).toEqual(['RP-42', 'RP-42', 'DFAS-ROW-7']);
    expect(events[0]).toMatchObject({ measureId: RP_MEASURE, asOfDate: '2027-10-10', transferPairKey: 'RP-42', transferSide: 'out', sourceDocumentId: 'doc-rp' });
    expect(events[1]).toMatchObject({ transferPairKey: 'RP-42', transferSide: 'in', sourceDocumentId: 'doc-rp' });
    expect(events[2]).toMatchObject({ measureId: EXEC_MEASURE, asOfDate: '2027-12-31', amountBasis: 'transaction_delta', executionMetric: 'obligations', signedObligationDelta: '-250000.00' });
    expect((events[2]!.raw as { evidenceIds: string[] }).evidenceIds).toEqual(['dfas-evidence']);
    expect((events[2]!.raw as { sourceDetails: { sourceSha256: string } }).sourceDetails.sourceSha256).toBe('b'.repeat(64));
    expect((events[0]!.raw as { sourceDetails: { sourceSha256: string; originalAmount: string } }).sourceDetails)
      .toMatchObject({ sourceSha256: 'a'.repeat(64), originalAmount: '5' });
    expect(events.every((event) => !('allocationIds' in event))).toBe(true);
  });

  test('defaults to dry run unless both commit and the exact env gate are present', async () => {
    const { service, port } = store();
    const input = { reprogramming: [transfer()], measureBindings: [{ kind: 'reprogramming' as const, sourceNativeId: 'RP-42', measureId: RP_MEASURE }] };
    expect((await service.run(input, { commit: false, env: { FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED: 'true' } })).mode).toBe('DRY_RUN');
    expect((await service.run(input, { commit: true, env: { FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED: 'TRUE' } })).mode).toBe('DRY_RUN');
    expect(port.appendSourceEvents).not.toHaveBeenCalled();
  });

  test('rejects positive rescissions and unbalanced transfer facts before any write', async () => {
    const { service, port } = store();
    const positiveRescission = { id: 'resc-1', measureType: 'rescission' as const, status: 'enacted' as const,
      fiscalYear: 2027, asOfDate: '2027-10-01', amountBasis: 'transaction_delta' as const, sourceSystem: 'GovInfo', sourceDocumentId: 'pl-1', sourceIdentity: 'PL-1',
      amountMillions: '1', originalAmount: '1000000', originalUnit: 'dollars' as const, evidenceIds: ['e1'] };
    await expect(service.run({ alternativeFunding: [positiveRescission], measureBindings: [{ kind: 'alternative_funding', sourceNativeId: 'resc-1', measureId: ALT_MEASURE }] }, { commit: true, env: { FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED: 'true' } }))
      .rejects.toMatchObject({ constructor: FundingExecutionSourceCertificationError, findings: ['rescission_not_negative:resc-1'] });
    const unbalanced = { ...transfer(), actions: transfer().actions.slice(0, 1) };
    await expect(service.run({ reprogramming: [unbalanced], measureBindings: [{ kind: 'reprogramming', sourceNativeId: 'RP-42', measureId: RP_MEASURE }] }, { commit: true, env: { FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED: 'true' } }))
      .rejects.toMatchObject({ constructor: FundingExecutionSourceCertificationError, findings: ['transfer_not_balanced:RP-42'] });
    expect(port.appendSourceEvents).not.toHaveBeenCalled();
  });

  test('maps an explicit negative rescission basis into the persistence sign boundary', async () => {
    const { service, appended } = store();
    await service.run({
      alternativeFunding: [{
        id: 'resc-negative', measureType: 'rescission', status: 'enacted', fiscalYear: 2027,
        asOfDate: '2027-10-01', amountBasis: 'transaction_delta', sourceSystem: 'GovInfo',
        sourceDocumentId: 'pl-2', sourceIdentity: 'PL-2', amountMillions: '-1',
        originalAmount: '-1000000', originalUnit: 'dollars', evidenceIds: ['e2'],
      }],
      measureBindings: [{ kind: 'alternative_funding', sourceNativeId: 'resc-negative', measureId: ALT_MEASURE }],
    }, { commit: true, env: { FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED: 'true' } });
    expect(appended[0]![0]).toMatchObject({
      measureId: ALT_MEASURE,
      eventType: 'alternative_funding:rescission',
      amountBasis: 'transaction_delta',
      asOfDate: '2027-10-01',
      sourceAmountUsd: '-1000000.00',
    });
  });

  test('rejects unsupported execution metrics and sub-cent million amounts without rounding', async () => {
    const { service, port } = store();
    const badMetric = composeExecutionRecordV1({ schemaVersion: 'execution_source_profile_v1', profileId: 'other',
      fiscalYear: 2027, metric: 'commitments', sourceSystem: 'DFAS', sourceDocumentId: 'd', sourceSha256: 'c'.repeat(64),
      mapsToExecutedField: false }, { schemaVersion: 'execution_record_v1', recordId: 'r', identity: A,
      metric: 'commitments', asOfDate: '2027-12-31', budgetFiscalYear: 2027, amount: money('1'), sourceSystem: 'DFAS',
      sourceDocumentId: 'd', sourceSha256: 'c'.repeat(64), evidenceIds: ['e'], cumulative: false });
    await expect(service.run({ execution: [badMetric], measureBindings: [{ kind: 'execution', sourceNativeId: 'r', measureId: EXEC_MEASURE }] }, { commit: true, env: { FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED: 'true' } }))
      .rejects.toThrow('unsupported execution metric: commitments');
    const badPrecision = { ...execution(), metricFact: { ...execution().metricFact, amount: money('0.000000001') } };
    await expect(service.run({ execution: [badPrecision as never], measureBindings: [{ kind: 'execution', sourceNativeId: 'DFAS-ROW-7', measureId: EXEC_MEASURE }] }, { commit: true, env: { FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED: 'true' } }))
      .rejects.toThrow(/exceeds exact USD-cent precision/);
    expect(port.appendSourceEvents).not.toHaveBeenCalled();
  });

  test('requires a one-to-one binding to an existing funding measure', async () => {
    const { service, port } = store();
    await expect(service.run({ reprogramming: [transfer()], measureBindings: [] }, {
      commit: true, env: { FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED: 'true' },
    })).rejects.toThrow(/no explicit existing funding measureId binding/);
    expect(port.appendSourceEvents).not.toHaveBeenCalled();
  });
});
