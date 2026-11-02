import type { PrismaService } from '../../prisma/prisma.service.js';
import { BuyerWorkspaceService } from './buyer-workspace.service.js';
import { AcquisitionContinuityReadService, type AcquisitionContinuityRelationshipRow } from '../acquisition-continuity/acquisition-continuity-read.service.js';
import { FundingExecutionReadService, type FundingExecutionFact } from '../funding-execution/funding-execution-read.service.js';
import { FederalEvidenceReadService } from '../federal-evidence/federal-evidence-read.service.js';

export const buyerWireInput = { peCode: ' 0601234a ', asOfFy: 2027, knownAt: '2026-09-24T00:00:00Z' };
const at = '2026-09-24T00:00:00.000Z';
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const evidence = { sourceFamily: 'synthetic', sourceNativeId: 'record-1', sourceUrl: 'https://example.invalid/source',
  sourceVersion: 'v1', contentHash: 'a'.repeat(64), quote: 'Synthetic source passage' };
function relationship(status: AcquisitionContinuityRelationshipRow['status']): AcquisitionContinuityRelationshipRow {
  const entity = { entityType: 'notice', id: null, sourceNativeId: 'synthetic-notice', label: 'Synthetic notice' };
  return { stableKey: status, relationshipId: 'relation-' + status, relationshipKind: 'notice_to_vehicle', status,
    from: entity, to: { ...entity, entityType: 'vehicle' }, sourceNativeIds: { notice: 'synthetic-notice', order: null },
    path: [entity], parent: null, validity: { validFromFy: 2027, validToFy: null, knownFrom: at, knownTo: null },
    evidence: [{ kind: 'provider_identifier', sourceUrl: evidence.sourceUrl, sourceNativeId: evidence.sourceNativeId,
      sourceVersion: 'v1', pageNumber: 2, quote: evidence.quote, contentHash: evidence.contentHash }],
    unresolvedReasons: status === 'unresolved' ? ['Relationship has not been resolved'] : [],
    financialFact: { classification: status === 'accepted' ? 'source_stated_financial_allocation' : 'inferred_relevance',
      reviewState: status === 'accepted' ? 'verified' : 'candidate', sourceAmountUsd: '20.005',
      actionEffect: 'ordinary', evidencePresent: true }, authoritativeAmountUsd: 'untrusted',
  };
}
function fact(stableKey: string, patch: Partial<FundingExecutionFact> = {}): FundingExecutionFact {
  return { stableKey, factId: 'fact-' + stableKey, authorityState: 'enacted', measure: 'transaction_delta',
    fiscalYear: 2027, validFromFy: 2027, validToFy: null, availabilityStart: '2026-10-01', availabilityEnd: null,
    recordedAt: at, accountId: '0300', snapshotGroupId: null, amountUsd: '10.00', amountBasis: 'transaction_delta',
    executionMetric: 'obligations', asOfDate: '2026-09-24', periodStart: null, periodEnd: null,
    transferGroupId: null, transferLeg: null, allocationCertification: 'not_applicable', reviewState: 'verified',
    exactAccountLevel: false, evidence: [evidence], unresolvedReasons: [], authoritativeAmountUsd: 'untrusted', ...patch };
}
export function buyerWireFixture(unsupported = false) {
  const acquisition = new AcquisitionContinuityReadService({ readPage: async () => ({
    rows: unsupported ? [] : ['accepted', 'candidate', 'unresolved'].map(status => relationship(status as AcquisitionContinuityRelationshipRow['status'])),
    coverage: { state: unsupported ? 'unsupported' : 'complete', supportedRelationshipKinds: ['notice_to_vehicle'],
      unsupportedRelationshipKinds: [], unresolvedReasons: unsupported ? [{ code: 'source_unavailable', count: null, detail: 'Synthetic unavailable source' }] : [],
      sourceFreshness: [{ source: 'synthetic', sourceAsOf: '2026-09-24', lastObservedAt: at, state: unsupported ? 'unavailable' : 'current' }] },
  }) });
  const funding = new FundingExecutionReadService({ readPage: async () => ({
    rows: unsupported ? [] : [
      fact('a-snapshot', { measure: 'cumulative_snapshot', amountBasis: 'snapshot', snapshotGroupId: 'account-0300', amountUsd: '100.00' }),
      fact('b-negative', { amountUsd: '-12.50' }),
      fact('c-proposed', { authorityState: 'proposed', amountUsd: '30.00' }),
      fact('d-allocation', { measure: 'allocation', amountBasis: null, allocationCertification: 'certified', exactAccountLevel: true, amountUsd: '15.50' }),
      fact('e-residual', { measure: 'residual', amountBasis: null, amountUsd: null, unresolvedReasons: ['Unmatched source observation'] }),
      fact('f-transfer-out', { measure: 'transfer_leg', transferGroupId: 'pair-1', transferLeg: 'outflow', amountUsd: '-5.00' }),
      fact('g-transfer-in', { measure: 'transfer_leg', transferGroupId: 'pair-1', transferLeg: 'inflow', amountUsd: '5.00' }),
    ],
    coverage: { state: unsupported ? 'unsupported' : 'complete',
      unresolvedReasons: unsupported ? [{ code: 'source_unavailable', count: null, detail: 'Synthetic unavailable source' }] : [],
      sourceFreshness: [{ source: 'synthetic', sourceAsOf: at, state: unsupported ? 'unavailable' : 'current' }] },
  }) });
  const sourceKey = 'synthetic:BILLS:119-hr-42';
  const snapshot = { rawMention: 'PE 0601234A', canonicalPeCode: '0601234A', matchType: 'exact',
    qualificationState: 'qualified', confidence: 1, locator: 'characters:0-25',
    evidence: 'Synthetic source language.', languageHash: 'b'.repeat(64) };
  const revision = { revisionId: id(2), sourceKey, provider: 'govinfo', collection: 'BILLS', packageId: 'BILLS-119hr42',
    billId: '119-hr-42', versionCode: 'ih', lineageKey: '119-hr-42', contentHash: 'c'.repeat(64), extractionHash: 'd'.repeat(64),
    sourceUrl: 'https://example.invalid/bill', sourceModifiedAt: null, publishedAt: new Date(at), fetchedAt: new Date(at) };
  const revisionSide = { id: id(2), sourceKey, contentHash: revision.contentHash, extractionHash: revision.extractionHash,
    sourceUrl: revision.sourceUrl, publishedAt: revision.publishedAt, sourceModifiedAt: null };
  const federal = new FederalEvidenceReadService({ $queryRawUnsafe: async (sql: string) => {
    if (unsupported) return [];
    if (sql.includes('WITH current_observation')) return [{ id: id(1), ...snapshot, matcherVersion: 'synthetic/1',
      qualifiedBy: null, createdAt: new Date(at), ...revision }];
    return [{ id: id(3), eventKey: 'synthetic-event', eventType: 'added',
      candidateKey: 'synthetic-candidate', rawMention: snapshot.rawMention, canonicalPeCode: '0601234A',
      previousRevisionId: null, currentRevisionId: id(2), before: null, after: snapshot, historical: false,
      createdAt: new Date(at), ...revision, locator: snapshot.locator, evidence: snapshot.evidence,
      languageHash: snapshot.languageHash, matchType: snapshot.matchType, qualificationState: snapshot.qualificationState,
      confidence: 1, beforeRevision: { id: null }, afterRevision: revisionSide }];
  } } as unknown as PrismaService);
  return new BuyerWorkspaceService(acquisition, funding, federal);
}
