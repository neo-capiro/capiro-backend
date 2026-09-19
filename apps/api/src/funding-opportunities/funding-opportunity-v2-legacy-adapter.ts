import type {
  OpportunitySearchRecordV2,
  OpportunityTypeV2,
  FundingOpportunityV2DetailRecord,
} from '@capiro/shared';
import type { FundingOpportunity, HumanDecision, OpportunityKind, OpportunitySource } from './funding-opportunities.types.js';

const KIND_BY_TYPE: Record<OpportunityTypeV2, OpportunityKind> = {
  grant: 'grant', cooperative_agreement: 'cooperative_agreement', loan_assistance: 'other',
  contract: 'solicitation', solicitation: 'solicitation', task_order_vehicle: 'other',
  presolicitation: 'presolicitation', sources_sought: 'sources_sought', forecast: 'other',
  award: 'award_notice', other: 'other',
};

export type LegacyWorkflowProjection = {
  id: string | null; status: string | null; owner: FundingOpportunity['workflow'] extends infer T ? T extends { owner: infer O } ? O : never : never;
  nextAction: string | null; nextActionDueAt: string | null; userCreated: boolean | null; createdAt: string | null; updatedAt: string | null;
};
export type LegacyDecisionProjection = {
  decision: HumanDecision;
  reason: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
};
export type LegacyOpportunityProjection = Omit<FundingOpportunity, 'relevanceScore' | 'matchedSignals' | 'workflow' | 'decision' | 'missingProfileFields'> & {
  relevanceScore: number | null;
  matchedSignals: Array<Omit<FundingOpportunity['matchedSignals'][number], 'weight'> & { weight?: number }>;
  workflow: LegacyWorkflowProjection | null; decision: LegacyDecisionProjection | null; missingProfileFields: FundingOpportunity['missingProfileFields'] | null;
};

/**
 * Compatibility projection only. It performs no matching, ranking, filtering, or
 * reads. Legacy scored consumers receive an explicit nullable score; callers that
 * require the old rank semantics decide how to render an unavailable score.
 */
export function v2RecordToFundingOpportunity(
  row: OpportunitySearchRecordV2 | FundingOpportunityV2DetailRecord,
): LegacyOpportunityProjection {
  if (row.source !== 'grants_gov' && row.source !== 'sam_gov') {
    throw new Error(`Legacy FundingOpportunity does not support source ${row.source}.`);
  }
  const source: OpportunitySource = row.source;
  const detail = 'dates' in row ? row : null;
  const facts = row.sourceFacts ?? { provenance: 'source_facts_unavailable' };
  const detailFacts = detail?.provenance.sourceFacts ?? facts;
  const numberFact = (key: string): number | null => {
    const value = detailFacts[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const sourceReference = detail?.displayReference?.value
    ?? (typeof facts.opportunityNumber === 'string' ? facts.opportunityNumber : typeof facts.solicitationNumber === 'string' ? facts.solicitationNumber : null);
  const sourceUpdatedAt = detail?.sourceReference.sourceUpdatedAt
    ?? (typeof facts.sourceUpdated === 'string' ? facts.sourceUpdated : null);
  const eligibility = row.eligibility ?? { state: 'unknown' as const, reason: 'The source did not state enough eligibility facts.' };
  const detailWorkflow = detail?.decoration?.workflow ?? row.decoration?.workflow ?? null;
  const base: LegacyOpportunityProjection = {
    id: row.id, source, sourceRecordId: row.sourceRecordId, sourceReference, sourceUrl: row.sourceUrl,
    kind: KIND_BY_TYPE[row.type], kindRaw: null, baseKind: null, title: row.title, agency: row.agency,
    subAgency: null, office: null, status: row.lifecycle, postedDate: row.postedDate,
    responseDeadline: row.deadline, responseDeadlineNote: null, closeOrArchiveDate: row.closeOrArchiveDate,
    isActive: row.lifecycle === 'active', isPursuable: row.isPursuable, summary: row.summary, summaryIsLink: false,
    naicsCodes: row.naicsCodes, pscCodes: row.pscCodes, setAside: row.setAside, setAsideCode: null,
    eligibleApplicantTypes: row.applicantTypes, assistanceListings: [], fundingInstrument: null, category: null,
    grantFunding: source === 'grants_gov' ? {
      estimatedProgramFunding: numberFact('estimatedFunding'), awardFloor: numberFact('awardFloor'),
      awardCeiling: numberFact('awardCeiling'), expectedAwardCount: numberFact('expectedAwards'),
      costSharingRequired: typeof detailFacts.costSharing === 'boolean' ? detailFacts.costSharing : null,
    } : null,
    contractValue: source === 'sam_gov' ? { estimatedValue: row.value, basis: row.value == null ? 'not_stated_by_source' : 'source_backed' } : null,
    placeOfPerformance: typeof facts.placeOfPerformance === 'object' && facts.placeOfPerformance != null && !Array.isArray(facts.placeOfPerformance)
      ? { city: null, state: null, zip: null, country: null, ...(facts.placeOfPerformance as Record<string, string | null>) } : null,
    districtKey: null, districtBasis: null, relevanceScore: row.relevanceScore,
    eligibility, matchedSignals: row.matchedSignals.map((signal) => ({ ...signal, weight: undefined })), recommendation: null,
    acquisitionPosition: null, sourceUpdatedAt,
    workflow: detailWorkflow?.available ? { id: detailWorkflow.workflowId, status: detailWorkflow.status, owner: detailWorkflow.owner, nextAction: detailWorkflow.nextAction, nextActionDueAt: detailWorkflow.nextActionDueAt, userCreated: null, createdAt: null, updatedAt: null } : null,
    decision: detailWorkflow?.humanDecision && ['pursue', 'monitor', 'pass'].includes(detailWorkflow.humanDecision)
      ? { decision: detailWorkflow.humanDecision as HumanDecision, reason: null, decidedAt: null, decidedByUserId: null, nextAction: detailWorkflow.nextAction, nextActionDueAt: detailWorkflow.nextActionDueAt }
      : null,
    missingProfileFields: null,
    clientId: row.clientId,
  };
  return base;
}
