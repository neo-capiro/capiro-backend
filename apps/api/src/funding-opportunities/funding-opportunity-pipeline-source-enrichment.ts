import { normalizeOpportunitySearchCriteria, type OpportunityCurrentEvidenceV2, type OpportunitySourceV2 } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { readCanonicalOpportunityProfile } from './funding-opportunity-v2-search.service.js';
import { sourceRecordTypeFor } from './funding-opportunity-identity.js';
import { readExactSourceSql } from './funding-opportunity-v2-search.sql.js';
import { readEnabledFundingSources } from './funding-opportunity-source-access.js';
import type { CatalogOpportunityRecord } from './funding-opportunity-v2-search.service.js';

export type PipelineCatalogInput = {
  rowId: string;
  source: string;
  sourceRecordId: string | null;
  sourceRecordType: string | null;
};

export type PipelineCatalogEnrichment = {
  rowId: string;
  title: string | null;
  deadline: string | null;
  closeOrArchiveDate: string | null;
  lifecycle: 'active' | 'forecast' | 'closed' | 'post_award' | null;
  capability: { allowed: boolean; reason: string } | null;
  sourceReference: string | null;
  sourceRecordType: string | null;
  keyDate: { kind: 'response' | 'quote' | 'anticipated_award' | 'award' | 'closed'; date: string | null; displayLabel?: string } | null;
  value: { display: string; basis: string } | null;
  flag: { label: string; tone: string } | null;
  currentSourceAvailable: boolean;
  currentEvidence: OpportunityCurrentEvidenceV2 | null;
};


function sourceReference(record: CatalogOpportunityRecord): string | null {
  const facts = record.sourceFacts as Record<string, unknown>;
  for (const key of ['solicitationNumber', 'opportunityNumber', 'topicNumber', 'externalId', 'noticeId', 'portalId', 'solicitation']) {
    if (typeof facts[key] === 'string' && facts[key].trim()) return facts[key].trim();
  }
  return null;
}

function sourceValue(record: CatalogOpportunityRecord): PipelineCatalogEnrichment['value'] {
  if (record.value == null) return { display: 'Not stated by source', basis: record.valueBasis };
  return { display: `$${record.value.toLocaleString('en-US')}`, basis: record.valueBasis };
}

function keyDate(record: CatalogOpportunityRecord): PipelineCatalogEnrichment['keyDate'] {
  const facts = record.sourceFacts as Record<string, unknown>;
  if (record.lifecycle === 'forecast') {
    const date = typeof facts.anticipatedAwardDate === 'string' ? facts.anticipatedAwardDate : null;
    const period = typeof facts.estimatedPeriod === 'string' ? facts.estimatedPeriod.trim() : '';
    return { kind: 'anticipated_award', date, ...(date || !period ? {} : { displayLabel: period }) };
  }
  if (record.lifecycle === 'post_award') return { kind: 'award', date: null };
  if (record.lifecycle === 'closed') return { kind: 'closed', date: record.closeOrArchiveDate };
  return { kind: record.source === 'dibbs' ? 'quote' : 'response', date: record.deadline };
}

function sourceFlag(record: CatalogOpportunityRecord): PipelineCatalogEnrichment['flag'] {
  if (record.lifecycle === 'forecast') return { label: 'Forecast — no response path', tone: 'muted' };
  if (record.lifecycle === 'closed') return { label: 'Closed', tone: 'muted' };
  if (record.lifecycle === 'post_award') return { label: 'Award notice', tone: 'muted' };
  return null;
}

/** One bounded canonical source query per source; never one detail query per card. */
export async function enrichPipelineCatalogRows(
  prisma: PrismaService,
  tenantId: string,
  clientId: string,
  inputs: PipelineCatalogInput[],
): Promise<PipelineCatalogEnrichment[]> {
  const usable = inputs.filter((input): input is PipelineCatalogInput & { sourceRecordId: string } => Boolean(input.sourceRecordId));
  const unavailable = inputs.filter((input) => !input.sourceRecordId).map((input) => ({
    rowId: input.rowId, title: null, deadline: null, closeOrArchiveDate: null, lifecycle: null,
    capability: { allowed: false, reason: 'Current source identity is unavailable; pursuit is not authorized.' },
    sourceReference: null, sourceRecordType: input.sourceRecordType, keyDate: null, value: null,
    flag: { label: 'Current source facts unavailable', tone: 'muted' }, currentSourceAvailable: false, currentEvidence: null,
  }));
  if (!usable.length) return unavailable;
  const enabled = new Set(await readEnabledFundingSources(prisma, tenantId));
  const enabledUsable = usable.filter((input) => enabled.has(input.source as OpportunitySourceV2));
  const disabled = usable.filter((input) => !enabled.has(input.source as OpportunitySourceV2)).map((input) => ({
    rowId: input.rowId, title: null, deadline: null, closeOrArchiveDate: null, lifecycle: null,
    capability: { allowed: false, reason: 'The current source is unavailable, so pursuit is not authorized.' },
    sourceReference: null, sourceRecordType: input.sourceRecordType, keyDate: null, value: null,
    flag: { label: 'Current source facts unavailable', tone: 'muted' }, currentSourceAvailable: false, currentEvidence: null,
  }));
  if (!enabledUsable.length) return [...unavailable, ...disabled];
  const profile = await readCanonicalOpportunityProfile(prisma, { tenantId, userId: '' }, clientId);
  const criteria = normalizeOpportunitySearchCriteria({ mode: 'matched', clientId, lifecycle: ['active', 'forecast', 'closed', 'post_award'], page: 1, pageSize: 100 }).criteria;
  const bySource = new Map<string, typeof enabledUsable>();
  for (const input of enabledUsable) bySource.set(input.source, [...(bySource.get(input.source) ?? []), input]);
  const batches = await Promise.all([...bySource.entries()].map(async ([source, rows]) => ({
    source,
    rows,
    records: (await readExactSourceSql(prisma, source as OpportunitySourceV2, criteria, profile, rows.map((row) => row.sourceRecordId))).records,
  })));
  const output: PipelineCatalogEnrichment[] = [];
  for (const batch of batches) {
    for (const input of batch.rows) {
      const candidates = batch.records.filter((record) => record.sourceRecordId === input.sourceRecordId);
      const expectedType = input.sourceRecordType;
      const matching = expectedType
        ? candidates.filter((record) => sourceRecordTypeFor(record.source, record.sourceFacts) === expectedType)
        : candidates.length === 1 ? candidates : [];
      const record = matching.length === 1 ? matching[0] : null;
      output.push({
        rowId: input.rowId,
        title: record?.title ?? null,
        deadline: record?.deadline ?? null,
        closeOrArchiveDate: record?.closeOrArchiveDate ?? null,
        lifecycle: record?.lifecycle ?? null,
        capability: record?.clientCapability ?? (record ? { allowed: false, reason: 'Current client capability is unavailable.' } : { allowed: false, reason: 'The current source identity is unavailable or ambiguous.' }),
        sourceReference: record ? sourceReference(record) : null,
        sourceRecordType: record ? sourceRecordTypeFor(record.source, record.sourceFacts) : expectedType,
        keyDate: record ? keyDate(record) : null,
        value: record ? sourceValue(record) : null,
        flag: record ? sourceFlag(record) : { label: 'Current source facts unavailable', tone: 'muted' },
        currentSourceAvailable: record != null,
        currentEvidence: record ? { relevanceScore: record.relevanceScore, matchedSignals: record.matchedSignals, eligibility: record.eligibility } : null,
      });
    }
  }
  return [...unavailable, ...disabled, ...output];
}
