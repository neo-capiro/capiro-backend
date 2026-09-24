/** Pure, non-canonical certification for alternative-funding and execution facts. */
import type { ReprogrammingCompositionV1, ExecutionCompositionV1 } from '../stages/post-enactment/reprogramming-execution-v1.js';
import type { AlternativeFundingRoute } from '@capiro/defense-domain';
import { isCanonicalDecimalString, type MoneyUnitV1 } from '../contracts/decimal-string.js';
import { addDecimals, subtractDecimals, sumDecimals } from '../verification/rules/arithmetic/exact-arithmetic.js';

export type FundingDispositionV1 = 'proposed' | 'enacted';
export type AlternativeFundingMeasureTypeV1 = AlternativeFundingRoute['measureType'];
export type AlternativeFundingSourceStatusV1 = 'introduced' | 'draft' | 'pending' | 'active' | 'enacted' | 'rejected' | 'withdrawn' | 'expired';
export type AllocationReviewV1 = 'candidate' | 'verified' | 'unresolved' | 'rejected';

export interface AlternativeFundingSourceMeasureV1 {
  id: string;
  /** Explicit source/certification date; never derived from fiscalYear. */
  asOfDate: string;
  amountBasis: 'snapshot' | 'transaction_delta';
  measureType: AlternativeFundingMeasureTypeV1;
  status: AlternativeFundingSourceStatusV1;
  fiscalYear: number;
  sourceSystem: string;
  sourceDocumentId: string;
  sourceIdentity: string;
  amountMillions: string;
  originalAmount: string;
  originalUnit: MoneyUnitV1;
  evidenceIds: readonly string[];
}

export interface FundingScopeV1 {
  fiscalYear: number;
  account: string;
  measure: string;
  unit: string;
}

export interface FundingAllocationV1 {
  id: string;
  scope: FundingScopeV1;
  amountMillions: string;
  review: AllocationReviewV1;
  evidenceIds: readonly string[];
  targetIdentity?: string;
}

export interface FundingStatementV1 {
  id: string;
  scope: FundingScopeV1;
  statedAmountMillions: string;
  evidenceIds: readonly string[];
  allocations: readonly FundingAllocationV1[];
}

export interface FundingExecutionFactV1 {
  kind: 'alternative_funding' | 'reprogramming' | 'execution';
  disposition?: FundingDispositionV1;
  recordId: string;
  fiscalYear: number;
  measureType?: AlternativeFundingMeasureTypeV1;
  sourceStatus?: AlternativeFundingSourceStatusV1;
  originalAmount?: string;
  originalUnit?: string;
  metric?: string;
  amountMillions: string;
  factKind?: 'snapshot' | 'transaction_delta';
  asOfDate?: string;
  cumulative?: boolean;
  evidenceIds: readonly string[];
  sourceDocumentId: string;
  sourceSystem: string;
  transferGroupId?: string;
  transferDirection?: 'in' | 'out';
  actionType?: string;
  identity?: string;
}

export interface FundingExecutionCertificateV1 {
  schemaVersion: 'funding_execution_certificate_v1';
  canonicalAnnualPromotionAllowed: false;
  proposed: readonly FundingExecutionFactV1[];
  enacted: readonly FundingExecutionFactV1[];
  executionSnapshots: readonly FundingExecutionFactV1[];
  executionDeltas: readonly FundingExecutionFactV1[];
  reconciliation: readonly {
    statementId: string;
    scope: FundingScopeV1;
    verifiedAllocatedMillions: string;
    unallocatedOrUnresolvedMillions: string;
    candidateAllocationIds: readonly string[];
    unresolvedAllocationIds: readonly string[];
    incompatibleAllocationIds: readonly string[];
    evidenceIds: readonly string[];
  }[];
  findings: readonly string[];
}

const identityKey = (value: unknown): string => JSON.stringify(value);

/** Adapt only composer outputs: source proof and evidence remain attached; no money is inferred. */
export function adaptFundingExecutionV1(
  reprogramming: readonly ReprogrammingCompositionV1[] = [],
  execution: readonly ExecutionCompositionV1[] = [],
  alternativeFunding: readonly AlternativeFundingSourceMeasureV1[] = [],
): FundingExecutionFactV1[] {
  const facts: FundingExecutionFactV1[] = [];
  for (const measure of alternativeFunding) {
    if (!measure.id.trim() || !measure.sourceSystem.trim() || !measure.sourceDocumentId.trim() ||
      !measure.sourceIdentity.trim() || !measure.evidenceIds.length ||
      !isCanonicalDecimalString(measure.amountMillions) || !isCanonicalDecimalString(measure.originalAmount)) {
      throw new Error(`invalid alternative-funding source measure: ${measure.id || '(missing id)'}`);
    }
    const disposition = measure.status === 'enacted' || measure.status === 'active'
      ? 'enacted'
      : measure.status === 'introduced' || measure.status === 'draft' || measure.status === 'pending'
        ? 'proposed'
        : undefined;
    facts.push({ kind: 'alternative_funding', recordId: measure.id, fiscalYear: measure.fiscalYear,
      ...(disposition ? { disposition } : {}), measureType: measure.measureType, sourceStatus: measure.status,
      amountMillions: measure.amountMillions, originalAmount: measure.originalAmount,
      originalUnit: measure.originalUnit, evidenceIds: [...measure.evidenceIds],
      sourceDocumentId: measure.sourceDocumentId, sourceSystem: measure.sourceSystem,
      factKind: measure.amountBasis, asOfDate: measure.asOfDate,
      actionType: measure.measureType === 'rescission' ? 'rescission' : undefined,
      identity: measure.sourceIdentity });
  }
  for (const composed of reprogramming) {
    const event = composed.event;
    const disposition = event.status === 'approved' ? 'enacted' : event.status === 'requested' ? 'proposed' : undefined;
    for (const action of composed.actions) {
      if (action.signedValueMillions == null) {
        throw new Error(`reprogramming action ${action.actionId} is missing its signed value`);
      }
      facts.push({
        kind: 'reprogramming', recordId: action.actionId, fiscalYear: action.fiscalYear,
        amountMillions: action.signedValueMillions, evidenceIds: [...action.evidenceIds],
        sourceDocumentId: event.sourceDocumentId, sourceSystem: 'reprogramming_document',
        ...(disposition ? { disposition } : {}),
        ...(action.transferGroupId ? { transferGroupId: action.transferGroupId } : {}),
        ...(action.direction === 'in' || action.direction === 'out' ? { transferDirection: action.direction } : {}),
        actionType: action.actionType, identity: identityKey(action.identity),
      });
    }
  }
  for (const composed of execution) {
    const record = composed.metricFact;
    facts.push({
      kind: 'execution', recordId: record.recordId, fiscalYear: record.budgetFiscalYear,
      metric: record.metric, amountMillions: record.amount.valueMillions,
      factKind: record.cumulative ? 'snapshot' : 'transaction_delta',
      asOfDate: record.asOfDate, cumulative: record.cumulative,
      evidenceIds: [...record.evidenceIds], sourceDocumentId: record.sourceDocumentId,
      sourceSystem: record.sourceSystem, identity: identityKey(record.identity),
    });
  }
  return facts;
}

function compatible(a: FundingScopeV1, b: FundingScopeV1): boolean {
  return a.fiscalYear === b.fiscalYear && a.account === b.account && a.measure === b.measure && a.unit === b.unit;
}

/** Certifies internal consistency only. Candidate/unresolved allocations do not reduce residuals. */
export function certifyFundingExecutionV1(input: {
  facts: readonly FundingExecutionFactV1[];
  statements?: readonly FundingStatementV1[];
}): FundingExecutionCertificateV1 {
  const findings: string[] = [];
  const proposed = input.facts.filter((x) => (x.kind === 'reprogramming' || x.kind === 'alternative_funding') && x.disposition === 'proposed');
  const enacted = input.facts.filter((x) => (x.kind === 'reprogramming' || x.kind === 'alternative_funding') && x.disposition === 'enacted');
  const executionSnapshots = input.facts.filter((x) => x.kind === 'execution' && x.factKind === 'snapshot');
  const executionDeltas = input.facts.filter((x) => x.kind === 'execution' && x.factKind === 'transaction_delta');

  const transferGroups = new Map<string, FundingExecutionFactV1[]>();
  for (const fact of input.facts.filter((x) => x.transferGroupId)) {
    const group = transferGroups.get(fact.transferGroupId!) ?? [];
    group.push(fact); transferGroups.set(fact.transferGroupId!, group);
  }
  for (const [id, group] of transferGroups) {
    if (group.length !== 2 || sumDecimals(group.map((x) => x.amountMillions)) !== '0' ||
      !group.some((x) => x.transferDirection === 'in' && !x.amountMillions.startsWith('-')) ||
      !group.some((x) => x.transferDirection === 'out' && x.amountMillions.startsWith('-'))) {
      findings.push(`transfer_not_balanced:${id}`);
    }
  }
  for (const fact of input.facts.filter((x) => x.actionType === 'rescission')) {
    if (!fact.amountMillions.startsWith('-')) findings.push(`rescission_not_negative:${fact.recordId}`);
    if (fact.factKind !== 'transaction_delta') findings.push(`rescission_not_transaction_delta:${fact.recordId}`);
  }
  for (const snapshot of executionSnapshots) {
    if (!snapshot.cumulative) findings.push(`snapshot_not_cumulative:${snapshot.recordId}`);
  }
  for (const delta of executionDeltas) {
    if (delta.cumulative) findings.push(`delta_marked_cumulative:${delta.recordId}`);
  }

  const reconciliation = (input.statements ?? []).map((statement) => {
    let verified = '0';
    const candidateAllocationIds: string[] = [];
    const unresolvedAllocationIds: string[] = [];
    const incompatibleAllocationIds: string[] = [];
    for (const allocation of statement.allocations) {
      if (!compatible(statement.scope, allocation.scope)) { incompatibleAllocationIds.push(allocation.id); continue; }
      if (allocation.review === 'verified') verified = addDecimals(verified, allocation.amountMillions);
      else if (allocation.review === 'candidate') candidateAllocationIds.push(allocation.id);
      else if (allocation.review === 'unresolved') unresolvedAllocationIds.push(allocation.id);
    }
    return {
      statementId: statement.id, scope: statement.scope, verifiedAllocatedMillions: verified,
      unallocatedOrUnresolvedMillions: subtractDecimals(statement.statedAmountMillions, verified),
      candidateAllocationIds, unresolvedAllocationIds, incompatibleAllocationIds,
      evidenceIds: [...statement.evidenceIds, ...statement.allocations.flatMap((x) => x.evidenceIds)],
    };
  });
  return { schemaVersion: 'funding_execution_certificate_v1', canonicalAnnualPromotionAllowed: false,
    proposed, enacted, executionSnapshots, executionDeltas, reconciliation, findings };
}
