import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  normalizeOpportunitySearchCriteria,
  OPPORTUNITY_LIFECYCLES_V2,
  OPPORTUNITY_SOURCES_V2,
  OPPORTUNITY_TYPES_V2,
  type OpportunityEligibilityV2,
  type OpportunityProfileGapsV2,
  type OpportunitySearchCriteriaV2,
  type OpportunitySearchRecordV2,
  type OpportunitySearchResponseV2,
  type OpportunitySourceFreshnessV2,
  type OpportunitySourceHealthResponseV2,
  type OpportunitySourceV2,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { readEnabledFundingSources } from './funding-opportunity-source-access.js';
import { readVisibleClientIds } from './funding-opportunity-access.js';
import {
  asProfileReadClient,
  readAwardHistoryByBasis,
  readClientProfileFacts,
  resolveContractorUeis,
} from './client-opportunity-profile.repository.js';
import { buildAwardHistoryIdentity, contractorIdsToResolve } from './award-history-identity.js';
import { buildClientOpportunityProfile, emptyAwardHistory } from './client-opportunity-profile.builder.js';
import { searchSourceSql, healthSql } from './funding-opportunity-v2-search.sql.js';
import { FundingOpportunityV2DecoratorService } from './funding-opportunity-v2-decorator.service.js';
import { Optional } from '@nestjs/common';

export type OpportunitySearchContext = { tenantId: string; userId: string };

export type OpportunityClientProfile = {
  clientId: string;
  naicsCodes: string[];
  pscCodes: string[];
  agencies: string[];
  sectors: string[];
  /** Actual client capability phrases, not a source title or generic sector. */
  capabilityPhrases?: string[];
  fundingPriorities?: string[];
  applicantTypes: string[];
  geography?: string[];
};

export type CatalogOpportunityRecord = OpportunitySearchRecordV2 & {
  sectors: string[];
  funding: string[];
  costShare: string[];
  methods: string[];
  disbursement: string[];
  grantPrerequisites: string[];
  codes: string[];
  internalEligibility: OpportunityEligibilityV2;
  internalEligibilityReason: string;
  syncedAt: string | null;
  updatedAt: string | null;
  /** SQL-computed locale-independent keys; populated by the SQL adapter only. */
  _sqlTitleKey?: string | null;
  _sqlAgencyKey?: string | null;
};

export type OpportunityCatalogSearchResult = {
  records: CatalogOpportunityRecord[];
  count: number | null;
  grantsCount?: number | null;
  contractsCount?: number | null;
  activeCount?: number | null;
  closedCount?: number | null;
  actualUnscoredCount?: number | null;
};
export type OpportunityCatalogHealth = {
  state: OpportunitySourceFreshnessV2['state'];
  recordCount: number | null;
  activeRecordCount: number | null;
  lastSyncedAt: string | null;
  latestAttemptAt?: string | null;
  lastSuccessAt?: string | null;
};

export interface OpportunityCatalogAdapter {
  source: OpportunitySourceV2;
  search(criteria: OpportunitySearchCriteriaV2, profile?: OpportunityClientProfile | null): Promise<OpportunityCatalogSearchResult>;
  health(): Promise<OpportunityCatalogHealth>;
}

export interface OpportunityClientProfileReader {
  visibleClientIds(context: OpportunitySearchContext): Promise<string[]>;
  read(context: OpportunitySearchContext, clientId: string): Promise<OpportunityClientProfile | null>;
}

export const FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS = Symbol('FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS');
export const FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER = Symbol('FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER');
const SOURCE_ORDER = [...OPPORTUNITY_SOURCES_V2] as OpportunitySourceV2[];

function date(value: string | null): number | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Match PostgreSQL's bytewise `convert_to(lower(value), 'UTF8')` ordering used
 * by the SQL catalog query. JS's relational string comparison is UTF-16 based,
 * which puts astral characters and private-use characters in a different order
 * and can make page boundaries change with page size. */
function compareSqlText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left.toLowerCase(), 'utf8'), Buffer.from(right.toLowerCase(), 'utf8'));
}

function compareOpaqueId(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}


function toPublicRecord(record: CatalogOpportunityRecord): OpportunitySearchRecordV2 {
  return {
    id: record.id,
    source: record.source,
    sourceRecordId: record.sourceRecordId,
    title: record.title,
    agency: record.agency,
    sourceUrl: record.sourceUrl,
    type: record.type,
    lifecycle: record.lifecycle,
    postedDate: record.postedDate,
    deadline: record.deadline,
    closeOrArchiveDate: record.closeOrArchiveDate,
    isPursuable: record.isPursuable,
    summary: record.summary,
    naicsCodes: record.naicsCodes,
    pscCodes: record.pscCodes,
    setAside: record.setAside,
    applicantTypes: record.applicantTypes,
    geography: record.geography,
    value: record.value,
    valueBasis: record.valueBasis,
    sourceFacts: record.sourceFacts,
    relevanceScore: record.relevanceScore,
    matchedSignals: record.matchedSignals,
    eligibility: record.eligibility,
    clientId: record.clientId,
    clientCapability: record.clientCapability,
  };
}


function sortRecords(rows: CatalogOpportunityRecord[], criteria: OpportunitySearchCriteriaV2): CatalogOpportunityRecord[] {
  const direction = criteria.direction === 'desc' ? -1 : 1;
  const value = (row: CatalogOpportunityRecord): string | number | null => {
    if (criteria.sort === 'title') return row._sqlTitleKey ?? row.title.toLowerCase();
    if (criteria.sort === 'agency') return row._sqlAgencyKey ?? (row.agency ?? '').toLowerCase();
    if (criteria.sort === 'value') return row.value;
    if (criteria.sort === 'posted') return date(row.postedDate);
    if (criteria.sort === 'updated') return date(row.updatedAt);
    if (criteria.sort === 'relevance') return row.relevanceScore;
    return date(row.deadline);
  };
  return [...rows].sort((a, b) => {
    const av = value(a); const bv = value(b);
    if (av === null && bv !== null) return 1;
    if (av !== null && bv === null) return -1;
    if (av === null && bv === null) return compareOpaqueId(a.id, b.id);
    const left = av as string | number;
    const right = bv as string | number;
    const comparison = typeof left === 'string' && typeof right === 'string'
      ? compareSqlText(left, right)
      : left < right ? -1 : left > right ? 1 : 0;
    if (comparison !== 0) return comparison * direction;
    return compareOpaqueId(a.id, b.id);
  });
}

function profileGaps(profile: OpportunityClientProfile, actualUnscoredCount: number | null): OpportunityProfileGapsV2 {
  const items: OpportunityProfileGapsV2['items'] = [];
  if (profile.naicsCodes.length === 0) items.push({ title: 'NAICS coverage', tag: 'NAICS', tone: 'warn', body: 'Add the client’s NAICS codes to improve exact classification matches.' });
  if (profile.pscCodes.length === 0) items.push({ title: 'PSC coverage', tag: 'PSC', tone: 'warn', body: 'Add the client’s PSC codes to improve product and service matches.' });
  if (profile.applicantTypes.length === 0) items.push({ title: 'Applicant type', tag: 'Eligibility', tone: 'warn', body: 'Add the client’s applicant organization type to evaluate source eligibility.' });
  if (!(profile.geography?.length ?? 0)) items.push({ title: 'Geography', tag: 'Geography', tone: 'muted', body: 'Add a client facility or service location to evaluate geographic fit.' });
  return { items, actualUnscoredCount, profileLink: `/clients/${encodeURIComponent(profile.clientId)}` };
}

@Injectable()
export class FundingOpportunityV2SearchService {
  constructor(
    @Inject(FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS) private readonly adapters: OpportunityCatalogAdapter[],
    @Inject(FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER) private readonly profiles: OpportunityClientProfileReader,
    private readonly prisma: PrismaService,
    private readonly decorator: FundingOpportunityV2DecoratorService,
  ) {}

  async search(context: OpportunitySearchContext, criteria: OpportunitySearchCriteriaV2): Promise<OpportunitySearchResponseV2> {
    this.validateCriteria(criteria);
    const requestedSources = criteria.sources.length ? criteria.sources : SOURCE_ORDER;
    const enabledSources = new Set(await readEnabledFundingSources(this.prisma, context.tenantId));
    const querySources = requestedSources.filter((source) => enabledSources.has(source));
    const adapterBySource = new Map(this.adapters.map((adapter) => [adapter.source, adapter]));
    const requestedAdapters = querySources.map((source) => adapterBySource.get(source)).filter((adapter): adapter is OpportunityCatalogAdapter => Boolean(adapter));
    let client: OpportunityClientProfile | null = null;
    if (criteria.clientId) {
      const visible = await this.profiles.visibleClientIds(context);
      if (!visible.includes(criteria.clientId)) throw new NotFoundException('Client not found.');
      client = await this.profiles.read(context, criteria.clientId);
      if (!client) throw new NotFoundException('Client not found.');
    }
    if (criteria.mode === 'matched' && !criteria.clientId) throw new BadRequestException('Matched search requires clientId.');
    const settled = await Promise.all(requestedAdapters.map(async (adapter) => {
      try {
        const result = await adapter.search(criteria, client);
        let health: OpportunityCatalogHealth | null = null;
        try { health = await adapter.health(); } catch { /* rows remain usable; freshness is unavailable */ }
        return { adapter, result, health, error: null as Error | null };
      } catch (error) {
        return { adapter, result: null, health: null, error: error instanceof Error ? error : new Error(String(error)) };
      }
    }));
    if (querySources.length > 0 && !settled.some((item) => item.result)) throw new ServiceUnavailableException('All requested opportunity sources are unavailable.');
    const rows: CatalogOpportunityRecord[] = [];
    for (const item of settled) {
      if (!item.result) continue;
      for (const sourceRow of item.result.records) {
        rows.push({ ...sourceRow, clientId: criteria.clientId });
      }
    }
    const sorted = sortRecords(rows, criteria);
    const queryComplete = querySources.every((source) => adapterBySource.has(source)) && settled.every((item) => item.result && item.result.count != null);
    const catalogComplete = queryComplete && settled.every((item) => item.result && item.health?.state === 'current');
    const successful = settled.filter((item) => item.result);
    const count = (key: 'count' | 'grantsCount' | 'contractsCount' | 'activeCount' | 'closedCount') => successful.reduce((sum, item) => sum + (item.result?.[key] ?? 0), 0);
    const start = (criteria.page - 1) * criteria.pageSize;
    const freshness: OpportunitySourceFreshnessV2[] = requestedSources.map((source) => {
      const item = settled.find((candidate) => candidate.adapter.source === source);
      if (!enabledSources.has(source)) return { source, state: 'not_enabled', recordCount: null, activeRecordCount: null, lastSyncedAt: null };
      return { source, state: item?.error ? 'unavailable' : item?.health?.state ?? 'unavailable', recordCount: item?.health?.recordCount ?? null, activeRecordCount: item?.health?.activeRecordCount ?? null, lastSyncedAt: item?.health?.lastSyncedAt ?? null };
    });
    return {
      criteria, opportunities: await this.decorator.decorate(sorted.slice(start, start + criteria.pageSize).map(toPublicRecord), { tenantId: context.tenantId, actorUserId: context.userId, clientId: criteria.clientId }), page: criteria.page, pageSize: criteria.pageSize,
      total: queryComplete ? count('count') : null, totalIsCapped: false, catalogComplete,
      counts: { grants: queryComplete ? count('grantsCount') : null, contracts: queryComplete ? count('contractsCount') : null, active: queryComplete ? count('activeCount') : null, closed: queryComplete ? count('closedCount') : null },
      mode: criteria.mode, clientId: criteria.clientId, freshness,
      profileGaps: criteria.mode === 'matched' && client
        ? profileGaps(client, querySources.length === successful.length && successful.every((item) => item.result?.actualUnscoredCount != null)
          ? successful.reduce((sum, item) => sum + (item.result?.actualUnscoredCount ?? 0), 0)
          : null)
        : null,
      provenance: requestedSources.map((source) => { const item = settled.find((candidate) => candidate.adapter.source === source); return { source, queried: Boolean(item?.result), returned: item?.result?.records.length ?? 0, count: item?.result?.count ?? null, capped: false }; }),
      emptyReason: sorted.length ? (sorted.slice(start, start + criteria.pageSize).length ? null : 'page_empty') : 'no_matches', generatedAt: new Date().toISOString(),
    };
  }

  /** Shell/header health read; intentionally independent of selected search sources. */
  async readSourceHealth(context: OpportunitySearchContext): Promise<OpportunitySourceHealthResponseV2> {
    const enabled = new Set(await readEnabledFundingSources(this.prisma, context.tenantId));
    const sources = await Promise.all(SOURCE_ORDER.map(async (source) => {
      if (!enabled.has(source)) return { source, state: 'not_enabled', recordCount: null, activeRecordCount: null, lastSyncedAt: null, latestAttemptAt: null, lastSuccessAt: null } as OpportunitySourceFreshnessV2;
      const adapter = this.adapters.find((item) => item.source === source);
      if (!adapter) return { source, state: 'unavailable', recordCount: null, activeRecordCount: null, lastSyncedAt: null, latestAttemptAt: null, lastSuccessAt: null } as OpportunitySourceFreshnessV2;
      try {
        const health = await adapter.health();
        return { source, ...health, lastSuccessAt: health.lastSuccessAt ?? health.lastSyncedAt } as OpportunitySourceFreshnessV2;
      } catch {
        return { source, state: 'unavailable', recordCount: null, activeRecordCount: null, lastSyncedAt: null, latestAttemptAt: null, lastSuccessAt: null } as OpportunitySourceFreshnessV2;
      }
    }));
    return { sources, generatedAt: new Date().toISOString() };
  }

  private validateCriteria(criteria: OpportunitySearchCriteriaV2): void {
    if (criteria.schemaVersion !== 2 || !['all', 'matched'].includes(criteria.mode)) throw new BadRequestException('Invalid opportunity search criteria.');
    if (!criteria.lifecycle.every((value) => OPPORTUNITY_LIFECYCLES_V2.includes(value))) throw new BadRequestException('Invalid lifecycle criteria.');
    if (!criteria.sources.every((value) => OPPORTUNITY_SOURCES_V2.includes(value))) throw new BadRequestException('Invalid source criteria.');
    if (!criteria.types.every((value) => OPPORTUNITY_TYPES_V2.includes(value))) throw new BadRequestException('Invalid type criteria.');
    if (!Number.isInteger(criteria.page) || criteria.page < 1 || !Number.isInteger(criteria.pageSize) || criteria.pageSize < 1 || criteria.pageSize > 100) throw new BadRequestException('Invalid page criteria.');
    if (criteria.deadlineFrom && date(criteria.deadlineFrom) == null) throw new BadRequestException('Invalid deadlineFrom.');
    if (criteria.deadlineTo && date(criteria.deadlineTo) == null) throw new BadRequestException('Invalid deadlineTo.');
  }
}

export function createOpportunityClientProfileReader(prisma: PrismaService): OpportunityClientProfileReader {
  return {
    visibleClientIds: (context) => prisma.withTenant(context.tenantId, (tx) => readVisibleClientIds(tx, context.tenantId, context.userId)),
    read: (context, clientId) => readCanonicalOpportunityProfile(prisma, context, clientId),
  };
}

/**
 * The one profile read used by v2 search/detail/workflow and Pipeline.
 *
 * Tenant facts are read in the tenant transaction. Award tables and
 * federal_contractor are global reference data and are read only after that
 * transaction closes. In particular, mapping.externalName is never exposed as
 * agency evidence: it is only an input to the reviewed identity fallback.
 */
export async function readCanonicalOpportunityProfile(
  prisma: PrismaService,
  context: OpportunitySearchContext,
  clientId: string,
): Promise<OpportunityClientProfile | null> {
  const facts = await prisma.withTenant(context.tenantId, (tx) =>
    readClientProfileFacts(asProfileReadClient(tx), { clientId }),
  );
  if (!facts) return null;

  const contractorUeis = await resolveContractorUeis(prisma, contractorIdsToResolve([facts]));
  const identity = buildAwardHistoryIdentity(facts, contractorUeis);
  let history = emptyAwardHistory();
  try {
    history = await readAwardHistoryByBasis(prisma, identity);
  } catch {
    // Search/detail remain usable when the optional global history rail is
    // unavailable. The profile still contains all tenant-owned facts.
  }
  const profile = buildClientOpportunityProfile(facts, history);
  return {
    clientId,
    naicsCodes: profile.sam.naicsCodes,
    pscCodes: profile.sam.pscCodes,
    agencies: [...profile.sam.priorAgencies, ...profile.grant.priorAgencies],
    sectors: [facts.sectorTag].filter((value): value is string => Boolean(value)),
    capabilityPhrases: profile.sam.capabilityKeywords,
    fundingPriorities: profile.sam.fundingPriorities ?? [],
    applicantTypes: facts.applicantTypes,
    geography: profile.sam.facilityStates,
  };
}

export function createPrismaOpportunityCatalogAdapters(prisma: PrismaService): OpportunityCatalogAdapter[] {
  return OPPORTUNITY_SOURCES_V2.map((source) => ({
    source,
    search: (criteria: OpportunitySearchCriteriaV2, profile?: OpportunityClientProfile | null) => searchSourceSql(prisma, source, criteria, profile ?? null),
    health: () => healthSql(prisma, source),
  }));
}

export function normalizeOpportunitySearchQuery(query: Record<string, unknown>): OpportunitySearchCriteriaV2 {
  const aliases: Record<string, string> = { source: 'sources', type: 'types', agency: 'agencies', sector: 'sectors', naics: 'naicsCodes', psc: 'pscCodes', setAside: 'setAsideCodes', applicantType: 'applicantTypes', method: 'methods', grantPrereq: 'grantPrerequisites', grantPrerequisite: 'grantPrerequisites', code: 'codes', q: 'query', size: 'pageSize', dir: 'direction' };
  const listKeys = new Set(['sources', 'types', 'lifecycle', 'agencies', 'sectors', 'naicsCodes', 'pscCodes', 'setAsideCodes', 'eligibility', 'posted', 'geography', 'applicantTypes', 'funding', 'costShare', 'methods', 'disbursement', 'grantPrerequisites', 'codes']);
  const input: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(query)) {
    const key = aliases[rawKey] ?? rawKey;
    input[key] = listKeys.has(key) && typeof value === 'string' && value.includes(',') ? value.split(',') : value;
  }
  const normalized = normalizeOpportunitySearchCriteria(input);
  if (normalized.warnings.length) throw new BadRequestException('Invalid or unsupported opportunity search criteria.');
  return normalized.criteria;
}

export type { OpportunitySearchRecordV2 };
