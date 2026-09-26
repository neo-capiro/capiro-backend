import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  adaptFundingExecutionV1,
  certifyFundingExecutionV1,
  type AlternativeFundingSourceMeasureV1,
  type FundingExecutionFactV1,
  type FundingStatementV1,
} from '../defense-budget/funding-execution/funding-execution.v1.js';
import type { ExecutionCompositionV1, ReprogrammingCompositionV1 } from '../defense-budget/stages/post-enactment/reprogramming-execution-v1.js';
import { isCanonicalDecimalString } from '../defense-budget/contracts/decimal-string.js';
import type { FundingSourceEventInput } from './funding-execution.store.js';

export interface FundingExecutionSourceAdapterInput {
  reprogramming?: readonly ReprogrammingCompositionV1[];
  execution?: readonly ExecutionCompositionV1[];
  alternativeFunding?: readonly AlternativeFundingSourceMeasureV1[];
  statements?: readonly FundingStatementV1[];
  /** Existing federal_funding_measure IDs keyed to native source records. */
  measureBindings: readonly { kind: FundingExecutionFactV1['kind']; sourceNativeId: string; measureId: string }[];
}

export interface FundingExecutionSourceEventStorePort {
  appendSourceEvents(events: readonly FundingSourceEventInput[]): Promise<Array<{ id: string; inserted: boolean }>>;
}

export interface FundingExecutionSourceAdapterResult {
  mode: 'DRY_RUN' | 'COMMIT';
  factCount: number;
  sourceEventCount: number;
  insertedCount: number;
  certificate: ReturnType<typeof certifyFundingExecutionV1>;
}

export class FundingExecutionSourceCertificationError extends Error {
  constructor(readonly findings: readonly string[]) {
    super(`funding/execution source batch failed certification: ${findings.join(', ')}`);
    this.name = 'FundingExecutionSourceCertificationError';
  }
}

/**
 * Converts source-composer output into immutable source events only. It never
 * creates or infers target allocations; publication remains a separate reviewed
 * operation on FundingExecutionStore.
 */
@Injectable()
export class FundingExecutionSourceAdapterService {
  constructor(private readonly store: FundingExecutionSourceEventStorePort) {}

  async run(
    input: FundingExecutionSourceAdapterInput,
    options: { commit: boolean; env?: NodeJS.ProcessEnv },
  ): Promise<FundingExecutionSourceAdapterResult> {
    const facts = adaptFundingExecutionV1(input.reprogramming ?? [], input.execution ?? [], input.alternativeFunding ?? []);
    validateFacts(facts);
    const bindings = validateMeasureBindings(input.measureBindings, facts, input);
    const certificate = certifyFundingExecutionV1({ facts, statements: input.statements });
    if (certificate.findings.length) throw new FundingExecutionSourceCertificationError(certificate.findings);

    const sourceDetails = collectSourceDetails(input);
    const events = facts.map((fact) => {
      const sourceDetailsForFact = sourceDetails.get(`${fact.kind}\u0000${fact.recordId}`) ?? {};
      const nativeId = typeof sourceDetailsForFact.sourceRecordId === 'string' ? sourceDetailsForFact.sourceRecordId : fact.recordId;
      const measureId = bindings.get(`${fact.kind}\u0000${nativeId}`)!;
      return toSourceEvent(fact, sourceDetailsForFact, measureId);
    });
    const enabled = options.commit && (options.env ?? process.env).FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED === 'true';
    const persisted = enabled ? await this.store.appendSourceEvents(events) : [];
    return {
      mode: enabled ? 'COMMIT' : 'DRY_RUN',
      factCount: facts.length,
      sourceEventCount: events.length,
      insertedCount: persisted.filter((row) => row.inserted).length,
      certificate,
    };
  }
}

function validateFacts(facts: readonly FundingExecutionFactV1[]): void {
  if (facts.length === 0) throw new Error('funding/execution source batch must contain at least one fact');
  const identitySet = new Set<string>();
  for (const fact of facts) {
    if (!fact.recordId.trim() || !fact.sourceSystem.trim() || !fact.sourceDocumentId.trim() || fact.evidenceIds.length === 0) {
      throw new Error(`source fact ${fact.recordId || '(missing id)'} lacks source/evidence identity`);
    }
    if (!Number.isInteger(fact.fiscalYear) || fact.fiscalYear < 1900 || fact.fiscalYear > 2200) {
      throw new Error(`source fact ${fact.recordId} has an invalid fiscal year`);
    }
    if (!isCanonicalDecimalString(fact.amountMillions)) throw new Error(`source fact ${fact.recordId} has a noncanonical amount`);
    if (fact.evidenceIds.some((id) => !id.trim()) || new Set(fact.evidenceIds).size !== fact.evidenceIds.length) {
      throw new Error(`source fact ${fact.recordId} has invalid or duplicate evidence IDs`);
    }
    const identity = `${fact.kind}\u0000${fact.sourceSystem}\u0000${fact.recordId}`;
    if (identitySet.has(identity)) throw new Error(`duplicate source fact identity: ${fact.recordId}`);
    identitySet.add(identity);
  }
}

function collectSourceDetails(input: FundingExecutionSourceAdapterInput): Map<string, Record<string, unknown>> {
  const details = new Map<string, Record<string, unknown>>();
  for (const composed of input.reprogramming ?? []) {
    for (const action of composed.actions) details.set(`reprogramming\u0000${action.actionId}`, {
      sourceRecordId: composed.event.eventId,
      sourceSha256: composed.event.sourceSha256,
      sourceStatus: composed.event.status,
      occurredAt: composed.event.date,
      asOfDate: composed.event.date,
      controlNumber: composed.event.controlNumber,
      originalAmount: composed.event.amount.originalValue,
      originalUnit: composed.event.amount.originalUnit,
      sourceIdentity: composed.event.sourceIdentity ?? null,
      destinationIdentity: composed.event.destinationIdentity ?? null,
    });
  }
  for (const composed of input.execution ?? []) details.set(`execution\u0000${composed.metricFact.recordId}`, {
    sourceRecordId: composed.metricFact.recordId,
    sourceSha256: composed.metricFact.sourceSha256,
    sourceStatus: 'source_observation',
    occurredAt: composed.metricFact.asOfDate,
    asOfDate: composed.metricFact.asOfDate,
    originalAmount: composed.metricFact.amount.originalValue,
    originalUnit: composed.metricFact.amount.originalUnit,
  });
  for (const measure of input.alternativeFunding ?? []) details.set(`alternative_funding\u0000${measure.id}`, {
    sourceRecordId: measure.id,
    sourceStatus: measure.status,
    occurredAt: measure.asOfDate,
    asOfDate: measure.asOfDate,
    originalAmount: measure.originalAmount,
    originalUnit: measure.originalUnit,
  });
  return details;
}

function validateMeasureBindings(
  bindings: FundingExecutionSourceAdapterInput['measureBindings'],
  facts: readonly FundingExecutionFactV1[],
  input: FundingExecutionSourceAdapterInput,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const binding of bindings ?? []) {
    if (!binding.sourceNativeId.trim() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.measureId)) {
      throw new Error('every source measure binding requires a native source ID and UUID measureId');
    }
    const key = `${binding.kind}\u0000${binding.sourceNativeId}`;
    if (result.has(key)) throw new Error(`duplicate funding measure binding: ${binding.sourceNativeId}`);
    result.set(key, binding.measureId);
  }
  const details = collectSourceDetails(input);
  const required = new Set<string>();
  for (const fact of facts) {
    const sourceDetails = details.get(`${fact.kind}\u0000${fact.recordId}`) ?? {};
    const nativeId = typeof sourceDetails.sourceRecordId === 'string' ? sourceDetails.sourceRecordId : fact.recordId;
    const key = `${fact.kind}\u0000${nativeId}`;
    required.add(key);
    if (!result.has(key)) throw new Error(`source fact ${nativeId} has no explicit existing funding measureId binding`);
  }
  if (result.size !== required.size) throw new Error('funding measure bindings include source records outside this batch');
  return result;
}

function toSourceEvent(fact: FundingExecutionFactV1, sourceDetails: Record<string, unknown>, measureId: string): FundingSourceEventInput {
  const sourceRecordId = typeof sourceDetails.sourceRecordId === 'string' ? sourceDetails.sourceRecordId : fact.recordId;
  const sourceStatus = typeof sourceDetails.sourceStatus === 'string' ? sourceDetails.sourceStatus : null;
  const asOfDate = fact.asOfDate ?? (typeof sourceDetails.asOfDate === 'string' ? sourceDetails.asOfDate : null);
  if (!asOfDate || !isValidDate(asOfDate)) throw new Error(`source fact ${sourceRecordId} requires an explicit valid asOfDate`);
  const event: FundingSourceEventInput = {
    sourceEventKey: `funding-execution-v1:${fact.kind}:${createHash('sha256').update(`${fact.sourceSystem}\u0000${fact.recordId}`).digest('hex')}`,
    sourceSystem: fact.sourceSystem,
    sourceRecordId,
    sourceDocumentId: fact.sourceDocumentId,
    measureId,
    eventType: [fact.kind, fact.actionType ?? fact.measureType ?? sourceStatus ?? fact.sourceStatus ?? fact.disposition ?? fact.metric ?? fact.factKind ?? 'source_fact'].join(':'),
    occurredAt: typeof sourceDetails.occurredAt === 'string' ? sourceDetails.occurredAt : null,
    amountBasis: fact.kind === 'execution' || fact.kind === 'alternative_funding'
      ? (fact.factKind === 'snapshot' ? 'snapshot' : 'transaction_delta')
      : 'transaction_delta',
    sourceAmountUsd: fact.kind === 'execution' && fact.factKind === 'transaction_delta' ? null : millionsToUsd(fact.amountMillions),
    executionMetric: fact.kind === 'execution' ? executionMetric(fact.metric) : null,
    asOfDate,
    signedObligationDelta: fact.kind === 'execution' && fact.factKind === 'transaction_delta' && fact.metric === 'obligations'
      ? millionsToUsd(fact.amountMillions)
      : null,
    signedOutlayDelta: fact.kind === 'execution' && fact.factKind === 'transaction_delta' && fact.metric === 'outlays'
      ? millionsToUsd(fact.amountMillions)
      : null,
    transferPairKey: fact.transferGroupId ?? null,
    transferSide: fact.transferDirection === 'out' ? 'out' : fact.transferDirection === 'in' ? 'in' : null,
    raw: {
      adapterSchemaVersion: 'funding_execution_source_batch_v1',
      sourceNativeId: sourceRecordId,
      sourceDocumentId: fact.sourceDocumentId,
      sourceDetails,
      evidenceIds: [...fact.evidenceIds],
      identity: fact.identity ?? null,
      originalAmount: fact.originalAmount ?? null,
      originalUnit: fact.originalUnit ?? null,
      fact,
    },
  };
  return event;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function executionMetric(metric: string | undefined): 'obligations' | 'outlays' | null {
  if (metric === 'obligations' || metric === 'outlays') return metric;
  if (metric) throw new Error(`unsupported execution metric: ${metric}`);
  return null;
}

/** Exact million-dollar to USD conversion; sub-cent precision is rejected, never rounded. */
function millionsToUsd(value: string): string {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`invalid canonical million-dollar amount: ${value}`);
  const fraction = match[3] ?? '';
  if (fraction.length > 8 && /[^0]/.test(fraction.slice(8))) {
    throw new Error(`million-dollar amount exceeds exact USD-cent precision: ${value}`);
  }
  const cents = BigInt(match[2]!) * 100_000_000n + BigInt(fraction.slice(0, 8).padEnd(8, '0') || '0');
  const signed = match[1] ? -cents : cents;
  const sign = signed < 0n ? '-' : '';
  const absolute = signed < 0n ? -signed : signed;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
