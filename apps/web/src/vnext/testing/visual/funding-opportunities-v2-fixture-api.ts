import type { AxiosRequestConfig } from 'axios';
import type {
  OpportunitySearchCriteriaV2,
  OpportunitySearchRecordV2,
  OpportunitySearchResponseV2,
  OpportunitySourceFreshnessV2,
  OpportunitySourceV2,
  FundingOpportunityV2DetailRecord,
  FundingOpportunityV2DetailResponse,
  SavedSearchSummaryV2,
} from '@capiro/shared';
import {
  criteriaFromSearchParams,
  DEFAULT_V2_CRITERIA,
} from '../../pages/funding-opportunities/funding-opportunities-v2-state.js';
import type { FundingOpportunityResultRow } from '../../pages/funding-opportunities/FundingOpportunityV2ResultCard.js';
import type { SavedSearchRecordV2 } from '../../pages/funding-opportunities/FundingOpportunitiesV2Adapter.js';
import {
  referenceClients,
  referenceDetailExtras,
  referenceOpportunityRows,
  referenceProfileGaps,
  referenceReasons,
  referenceSavedSearches,
  referenceSourceHealth,
  referenceUnscored41Fixture,
} from './funding-opportunities-v2-reference-data.js';
import {
  createReferencePursuitFixtureApi,
  referencePursuitCards,
  referencePursuitSourceIdentity,
} from './funding-opportunities-v2-pursuit-fixtures.js';

const REFERENCE_NOW = '2026-09-16T12:00:00.000Z';
const REFERENCE_INGESTED_AT = '2026-09-16T12:05:00.000Z';
const FIXTURE_USER_ID = '11111111-1111-4111-8111-111111111111';
const FIXTURE_CLERK_USER_ID = 'user_fixture_neo_2026';
const FIXTURE_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const DEFAULT_ROUTE_QUERY =
  'client=overland&mode=matched&query=autonomous%20ground%20vehicle%20sustainment&type=grant,solicitation&sector=defense%20electronics,autonomous%20systems,logistics&deadlineWindow=90d&naics=541715&eligibility=eligible&lifecycle=active,forecast';

export const fundingOpportunitiesV2DefaultRoute = `/intelligence/opportunities?${DEFAULT_ROUTE_QUERY}`;
export const fundingOpportunitiesV2FixtureClock = REFERENCE_NOW;
export const fundingOpportunitiesV2FixtureUser = Object.freeze({
  id: FIXTURE_USER_ID,
  clerkUserId: FIXTURE_CLERK_USER_ID,
});
export function fundingOpportunitiesV2PreviewTarget(search: string): string {
  return `/intelligence/opportunities${search || `?${DEFAULT_ROUTE_QUERY}`}`;
}

export type FixtureApi = {
  get<T>(url: string, config?: AxiosRequestConfig): Promise<{ data: T }>;
  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<{ data: T }>;
  patch<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<{ data: T }>;
  delete<T>(url: string, config?: AxiosRequestConfig): Promise<{ data: T }>;
};

type FixtureError = { response: { status: number; data: { message: string } } };
export const referenceFixtureAuditEvents: Array<{
  source: OpportunitySourceV2;
  sourceRecordId: string;
  destinationKind: string;
  authoritativeUrl: string;
  at: string;
}> = [];

/** Wire identities are deliberately narrower than the reference display labels. */
export const referenceDestinationKinds: Record<string, string[]> = Object.fromEntries(
  referenceOpportunityRows.map((row) => [row.id, ['source_page']]),
);

function fixtureError(status: number, message: string): FixtureError {
  return { response: { status, data: { message } } };
}
function reject(status: number, message: string): never {
  throw fixtureError(status, message);
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function decode(value: string): string {
  return decodeURIComponent(value);
}
function pathParts(url: string): string[] {
  return url.split('?')[0]!.split('/').filter(Boolean).map(decode);
}

const sourceNames: Record<OpportunitySourceV2, string> = {
  grants_gov: 'Grants.gov',
  sam_gov: 'SAM.gov',
  agency_forecast: 'Agency forecasts',
  dibbs: 'DLA bid board',
  sbir_sttr: 'SBIR / STTR',
  ca_portal: 'California Grants Portal',
};
const sourceState: Record<string, OpportunitySourceFreshnessV2['state']> = {
  Current: 'current',
  Degraded: 'degraded',
  Stale: 'stale',
  'Never synced': 'not_enabled',
};
const sourceCounts: Record<
  string,
  { recordCount: number | null; activeRecordCount: number | null; lastSyncedAt: string | null }
> = {
  grants_gov: {
    recordCount: 9610,
    activeRecordCount: 1284,
    lastSyncedAt: '2026-09-16T11:18:00.000Z',
  },
  sam_gov: {
    recordCount: 41208,
    activeRecordCount: 3914,
    lastSyncedAt: '2026-09-16T11:42:00.000Z',
  },
  ca_portal: { recordCount: 170, activeRecordCount: 170, lastSyncedAt: '2026-09-16T09:00:00.000Z' },
  dibbs: { recordCount: null, activeRecordCount: null, lastSyncedAt: '2026-09-16T06:10:00.000Z' },
  agency_forecast: {
    recordCount: 268,
    activeRecordCount: 268,
    lastSyncedAt: '2026-09-15T12:00:00.000Z',
  },
  sbir_sttr: { recordCount: null, activeRecordCount: null, lastSyncedAt: null },
};

const pursuitByTitle = new Map(referencePursuitCards.map((card) => [card.title, card]));
const pursuitIdentityByTitle = new Map(
  referencePursuitCards.map((card) => [card.title, referencePursuitSourceIdentity[card.rowId]]),
);
const rowByIdentity = new Map<string, (typeof referenceOpportunityRows)[number]>();
const rowIdsByReferenceId: Record<string, string> = {};

function identityForRow(row: (typeof referenceOpportunityRows)[number]): {
  source: OpportunitySourceV2;
  sourceRecordId: string;
  sourceReference: string | null;
  boardRowId: string | null;
} {
  const card = pursuitByTitle.get(row.title);
  const identity = pursuitIdentityByTitle.get(row.title);
  if (card && identity)
    return {
      source: identity.source as OpportunitySourceV2,
      sourceRecordId: identity.sourceRecordId!,
      sourceReference: identity.sourceReference,
      boardRowId: card.rowId,
    };
  return {
    source: row.source,
    sourceRecordId: `reference-${row.id}`,
    sourceReference: row.meta.split(' · ').at(-1) ?? null,
    boardRowId: null,
  };
}
for (const row of referenceOpportunityRows) {
  const identity = identityForRow(row);
  rowByIdentity.set(`${identity.source}:${identity.sourceRecordId}`, row);
  rowIdsByReferenceId[row.id] = identity.sourceRecordId;
}

function isoDate(value: string): string | null {
  const match = value.match(/([A-Z][a-z]{2}) (\d{1,2})/);
  if (!match) return null;
  const months: Record<string, string> = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12',
  };
  return `2026-${months[match[1]!]!}-${match[2]!.padStart(2, '0')}`;
}
function lifecycleFor(
  row: (typeof referenceOpportunityRows)[number],
): OpportunitySearchRecordV2['lifecycle'] {
  if (row.kind === 'forecast') return 'forecast';
  if (row.tags.some((tag) => tag.label === 'Closed')) return 'closed';
  return 'active';
}
function typeFor(
  row: (typeof referenceOpportunityRows)[number],
): OpportunitySearchRecordV2['type'] {
  if (row.kind === 'grant') return row.id === 'r6' ? 'grant' : 'grant';
  if (row.kind === 'forecast') return 'forecast';
  return 'solicitation';
}
function toneForMatch(tone: string): 'success' | 'moderate' | 'warning' | 'error' | 'muted' {
  if (tone === 'warn') return 'warning';
  if (tone === 'gray' || tone === 'muted') return 'muted';
  if (tone === 'error') return 'error';
  if (tone === 'success') return 'success';
  return 'moderate';
}
function numericValue(row: (typeof referenceOpportunityRows)[number]): number | null {
  const fact = row.facts.find((item) => ['Ceiling', 'Total available'].includes(item.label));
  const match = fact?.value.match(/\$([\d,]+)/);
  return match ? Number(match[1]!.replaceAll(',', '')) : null;
}
function factTone(tone: string): 'plain' | 'muted' | 'warning' | 'error' {
  return tone === 'warn'
    ? 'warning'
    : tone === 'error'
      ? 'error'
      : tone === 'muted' || tone === 'gray'
        ? 'muted'
        : 'plain';
}
function evidenceTone(tone: string): 'plain' | 'brand' | 'success' | 'warning' | 'error' | 'muted' {
  return tone === 'warn'
    ? 'warning'
    : tone === 'moderate'
      ? 'brand'
      : tone === 'gray'
        ? 'muted'
        : tone === 'error' || tone === 'success' || tone === 'muted'
          ? tone
          : 'plain';
}
function sourceUpdatedAt(row: (typeof referenceOpportunityRows)[number]): string | null {
  const fact = row.facts.find((item) => item.label === 'Last updated');
  if (!fact) return null;
  const match = fact.value.match(
    /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})(?: · (\d{2}:\d{2}) (ET|PT))?$/,
  );
  if (!match) return fact.value;
  const months: Record<string, string> = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12',
  };
  if (!match[4]) return `${match[3]}-${months[match[1]!]!}-${match[2]!.padStart(2, '0')}`;
  const offset = match[5] === 'ET' ? '-04:00' : '-07:00';
  return `${match[3]}-${months[match[1]!]!}-${match[2]!.padStart(2, '0')}T${match[4]}:00${offset}`;
}
function workflowKey(
  clientId: string | null,
  source: OpportunitySourceV2,
  sourceRecordId: string,
): string {
  return `${clientId ?? 'workspace'}:${source}:${sourceRecordId}`;
}
function referenceRecord(
  row: (typeof referenceOpportunityRows)[number],
  bookmarks: Set<string>,
  workflowOverrides: Map<string, string>,
  clientId: string | null,
  includeMatch = true,
): FundingOpportunityResultRow {
  const identity = identityForRow(row);
  const lifecycle = lifecycleFor(row);
  const extra = referenceDetailExtras[row.id as keyof typeof referenceDetailExtras];
  const value = numericValue(row);
  const pursuit = pursuitByTitle.get(row.title);
  const key = workflowKey(clientId, identity.source, identity.sourceRecordId);
  const workflowStatus = workflowOverrides.get(key) ?? pursuit?.stage ?? null;
  const record: FundingOpportunityResultRow = {
    id: `${identity.source}:${identity.sourceRecordId}`,
    source: identity.source,
    sourceRecordId: identity.sourceRecordId,
    sourceUrl: row.href,
    title: row.title,
    agency: row.meta.split(' · ').slice(0, -1).join(' · ') || row.meta,
    summary: row.summary,
    type: typeFor(row),
    lifecycle,
    deadline: row.when.value === 'Q2 FY27' ? null : isoDate(row.when.value),
    postedDate:
      isoDate(
        row.facts.find((item) => item.label === 'Posted' || item.label === 'Forecast published')
          ?.value ?? '',
      ) ?? null,
    closeOrArchiveDate: lifecycle === 'closed' ? isoDate(row.when.value) : null,
    geography: row.facts
      .filter((item) => ['Place of performance', 'Geography'].includes(item.label))
      .map((item) => item.value),
    naicsCodes: row.id === 'r1' ? ['541715'] : [],
    pscCodes: row.id === 'r1' ? ['AR15'] : [],
    setAside: row.facts.find((item) => item.label === 'Set-aside')?.value ?? null,
    applicantTypes: [],
    value,
    valueBasis: value == null ? 'not_stated_by_source' : 'source_backed',
    isPursuable: row.canPursue,
    matchedSignals: row.evidence.map((item) => ({
      signal: item.label,
      strength: item.tone === 'success' ? 'strong' : item.tone === 'weak' ? 'weak' : 'moderate',
      matchedOn: item.value,
    })),
    eligibility:
      row.id === 'r3'
        ? { state: 'ineligible', reason: row.reason }
        : lifecycle === 'forecast'
          ? {
              state: 'unknown',
              reason: 'The forecast source has not stated applicant eligibility.',
            }
          : lifecycle === 'closed'
            ? null
            : {
                state: 'eligible',
                reason:
                  row.facts.find(
                    (item) => item.label === 'Eligibility' || item.label === 'Eligible applicant',
                  )?.value ?? 'Source eligibility is not restricted.',
              },
    clientId,
    relevanceScore: includeMatch ? row.relevance : null,
    sourceFacts: {
      provenance: 'authoritative reference fixture',
      ...(identity.source === 'sam_gov'
        ? {
            solicitationNumber: identity.sourceReference,
            postedDate: row.facts.find((item) => item.label === 'Posted')?.value ?? null,
            responseDeadline: row.when.value,
            responseDeadLine: `${row.when.value} ${row.when.note}`,
            archiveDate: null,
            sourceUpdated: sourceUpdatedAt(row),
          }
        : {}),
      ...(identity.source === 'grants_gov'
        ? {
            opportunityNumber: identity.sourceReference,
            postingDate: row.facts.find((item) => item.label === 'Posted')?.value ?? null,
            responseDate: row.when.value,
            applicantEligibilityDesc:
              row.facts.find((item) => item.label === 'Eligible applicant')?.value ?? null,
            lastUpdatedDate: sourceUpdatedAt(row),
          }
        : {}),
      ...(row.id === 'r4'
        ? {
            anticipatedAwardDate: null,
            estimatedPeriod: row.when.value,
            externalId: identity.sourceReference,
            sourceUpdated: sourceUpdatedAt(row),
            ingestedAt: REFERENCE_INGESTED_AT,
          }
        : {}),
    },
    decoration: {
      workflow: {
        available: clientId != null,
        workflowId: null,
        status: workflowStatus,
        humanDecision: null,
        owner: null,
        nextAction: null,
        nextActionDueAt: null,
        stage: pursuit?.stage ?? null,
        stageBasis: pursuit?.stage ? 'legacy_override' : 'unstaged',
        version: null,
        source: identity.source,
        sourceRecordId: identity.sourceRecordId,
        sourceRecordType: row.kind,
        publicReference: identity.sourceReference,
        unavailableReason: clientId == null ? 'Select a client to use client workflow.' : null,
      },
      bookmark: {
        saved: bookmarks.has(workflowKey(clientId, identity.source, identity.sourceRecordId)),
        bookmarkId: null,
        scope: clientId ? 'client' : 'workspace',
        clientId,
      },
      capabilities: {
        pursue: {
          allowed: row.canPursue,
          reason: row.canPursue ? '' : row.note || 'This source record is not currently pursuable.',
        },
        save: { allowed: true, reason: '' },
      },
    },
    responseDeadline: row.when.value === 'Q2 FY27' ? null : isoDate(row.when.value),
    responseDeadlineDays: row.when.days ? Number.parseInt(row.when.days, 10) : null,
    clientName: referenceClients.find((client) => client.id === clientId)?.name ?? null,
    clientInitials: referenceClients.find((client) => client.id === clientId)?.init ?? null,
  };
  return record;
}

function boardOnlyRecord(
  card: (typeof referencePursuitCards)[number],
  clientId: string | null,
): OpportunitySearchRecordV2 {
  const identity = referencePursuitSourceIdentity[card.rowId]!;
  const sourceRecordId = identity.sourceRecordId ?? card.sourceRecordId ?? card.rowId;
  return {
    id: `${identity.source}:${sourceRecordId}`,
    source: identity.source as OpportunitySourceV2,
    sourceRecordId,
    sourceUrl: null,
    title: card.title ?? 'Source record no longer in the catalog',
    agency: null,
    type:
      card.keyDate?.kind === 'quote'
        ? 'solicitation'
        : card.lifecycle === 'forecast'
          ? 'forecast'
          : 'solicitation',
    lifecycle: card.lifecycle ?? 'active',
    postedDate: null,
    deadline: card.keyDate?.date ?? card.responseDeadline,
    closeOrArchiveDate: card.lifecycle === 'closed' ? (card.keyDate?.date ?? null) : null,
    isPursuable: card.capability?.canPursue !== false,
    summary: null,
    naicsCodes: [],
    pscCodes: [],
    setAside: null,
    applicantTypes: [],
    geography: [],
    value: card.value ? null : null,
    valueBasis: 'not_stated_by_source',
    sourceFacts: {
      provenance: 'pursuit reference fixture',
      sourceReference: card.sourceReference,
      status: card.lifecycle,
      ingestedAt: REFERENCE_INGESTED_AT,
    },
    relevanceScore: null,
    matchedSignals: [],
    eligibility:
      card.capability?.canPursue === false
        ? { state: 'ineligible', reason: card.capability.reason ?? 'Eligibility gap' }
        : null,
    clientId,
  };
}

function currentSources(): OpportunitySourceFreshnessV2[] {
  return referenceSourceHealth.map((health) => ({
    source: health.source,
    state: sourceState[health.state] ?? 'unknown',
    recordCount: sourceCounts[health.source]!.recordCount,
    activeRecordCount: sourceCounts[health.source]!.activeRecordCount,
    lastSyncedAt: sourceCounts[health.source]!.lastSyncedAt,
  }));
}
function criteriaForSaved(id: string): OpportunitySearchCriteriaV2 {
  const base = {
    ...DEFAULT_V2_CRITERIA,
    clientId: id === 's4' ? null : 'overland',
    mode: id === 's4' ? 'all' : 'matched',
  } satisfies OpportunitySearchCriteriaV2;
  if (id === 's1')
    return {
      ...base,
      query: 'autonomous ground vehicle sustainment',
      types: ['grant', 'solicitation'],
      sectors: ['defense electronics', 'autonomous systems'],
      deadlineWindow: '90d',
      naicsCodes: ['541715'],
      eligibility: ['eligible'],
    };
  if (id === 's2')
    return {
      ...base,
      query: 'sustainment OR recompete',
      types: ['contract'],
      agencies: ['army'],
      naicsCodes: ['541715'],
      funding: ['10to50'],
    };
  if (id === 's3')
    return {
      ...base,
      query: '',
      lifecycle: ['active'],
      types: ['grant'],
      sectors: ['climate resilience'],
      geography: ['california'],
      deadlineWindow: '180d',
    };
  return {
    ...base,
    query: 'zero trust, autonomy stack',
    lifecycle: ['forecast'],
    types: [],
    sectors: ['autonomous systems'],
  };
}
function savedRecord(id: string): SavedSearchRecordV2 {
  const source = referenceSavedSearches.find((item) => item.id === id)!;
  const criteria = criteriaForSaved(id);
  return {
    id: source.id,
    name: source.name,
    description: source.criteriaSentence,
    visibility: source.visibility === 'Private' ? 'private' : 'tenant',
    clientId: criteria.clientId,
    criteria,
    warnings: [],
    archivedAt: null,
    createdByUserId: FIXTURE_USER_ID,
    ownerId: FIXTURE_USER_ID,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: REFERENCE_NOW,
    clientName: criteria.clientId ? 'Overland AI' : null,
    isTenantWide: !criteria.clientId,
    lastAppliedAt:
      id === 's1'
        ? '2026-09-16T11:18:00.000Z'
        : id === 's2'
          ? '2026-09-15T12:00:00.000Z'
          : id === 's3'
            ? '2026-09-13T12:00:00.000Z'
            : '2026-09-16T06:00:00.000Z',
    lastRunResultCount: Number.parseInt(source.resultCount, 10),
    originalCriteriaJson: source.metadata.originalCriteriaRetained
      ? { reference: source.criteriaSentence }
      : null,
    alerts: {
      enabled: false,
      cadence: null,
      channels: [],
      deadlineThreshold: null,
      newVsChanged: false,
    },
  };
}

type MutableState = {
  bookmarks: Set<string>;
  workflowOverrides: Map<string, string>;
  searches: Map<string, SavedSearchRecordV2>;
  nextSearch: number;
  notFit: Array<{
    clientId: string;
    source: string;
    sourceRecordId: string;
    reason: string;
    note: string | null;
  }>;
  actions: Array<{ clientId: string; source: string; sourceRecordId: string; intent: string }>;
};
function initialState(): MutableState {
  const bookmarks = new Set<string>();
  for (const row of referenceOpportunityRows.filter((item) => item.saved)) {
    const identity = identityForRow(row);
    bookmarks.add(workflowKey('overland', identity.source, identity.sourceRecordId));
  }
  return {
    bookmarks,
    workflowOverrides: new Map(),
    searches: new Map(referenceSavedSearches.map((row) => [row.id, savedRecord(row.id)])),
    nextSearch: 5,
    notFit: [],
    actions: [],
  };
}
function response(
  criteria: OpportunitySearchCriteriaV2,
  state: MutableState,
): OpportunitySearchResponseV2 {
  if (criteria.mode === 'matched' && !criteria.clientId)
    reject(400, 'Matched search requires clientId.');
  const includeMatch = criteria.mode === 'matched' && criteria.clientId != null;
  const opportunities = referenceOpportunityRows.map((row) =>
    referenceRecord(row, state.bookmarks, state.workflowOverrides, criteria.clientId, includeMatch),
  );
  return {
    criteria,
    opportunities,
    page: criteria.page,
    pageSize: criteria.pageSize,
    total: 6,
    totalIsCapped: false,
    catalogComplete: true,
    counts: { grants: 1284, contracts: 3914, active: 5198, closed: 4 },
    mode: criteria.mode,
    clientId: criteria.clientId,
    freshness: currentSources(),
    provenance: currentSources().map((item) => ({
      source: item.source,
      queried: true,
      returned: opportunities.filter((row) => row.source === item.source).length,
      count: item.recordCount,
      capped: false,
    })),
    emptyReason: null,
    generatedAt: REFERENCE_NOW,
    profileGaps: includeMatch
      ? {
          items: referenceProfileGaps.map((item) => ({
            title: item.title,
            tag: item.tag,
            tone: item.tone,
            body: item.text,
          })),
          actualUnscoredCount: referenceUnscored41Fixture.count,
          profileLink: '/clients/overland/profile',
        }
      : null,
  };
}
function parseCriteria(url: string): OpportunitySearchCriteriaV2 {
  return criteriaFromSearchParams(new URLSearchParams(url.split('?')[1] ?? ''));
}
function savedList(state: MutableState, clientId: string | null): SavedSearchListResponse {
  return {
    searches: [...state.searches.values()].filter((search) =>
      clientId == null
        ? search.clientId == null
        : search.clientId === clientId || search.clientId == null,
    ),
  };
}
type SavedSearchListResponse = { searches: SavedSearchRecordV2[] };

function detailFor(
  source: OpportunitySourceV2,
  sourceRecordId: string,
  state: MutableState,
  clientId: string | null,
): OpportunitySearchRecordV2 {
  const row = rowByIdentity.get(`${source}:${sourceRecordId}`);
  if (row)
    return referenceRecord(
      row,
      state.bookmarks,
      state.workflowOverrides,
      clientId,
      clientId != null,
    );
  const card = referencePursuitCards.find(
    (item) =>
      referencePursuitSourceIdentity[item.rowId]?.source === source &&
      referencePursuitSourceIdentity[item.rowId]?.sourceRecordId === sourceRecordId,
  );
  if (card) return boardOnlyRecord(card, clientId);
  reject(404, 'The opportunity is no longer available in the catalog.');
}

function richDetailFor(
  source: OpportunitySourceV2,
  sourceRecordId: string,
  state: MutableState,
  clientId: string | null,
  mode: 'matched' | 'all',
): FundingOpportunityV2DetailRecord {
  const base = detailFor(source, sourceRecordId, state, clientId) as OpportunitySearchRecordV2 & {
    decoration?: FundingOpportunityV2DetailRecord['decoration'];
  };
  const row = rowByIdentity.get(`${source}:${sourceRecordId}`);
  const extra = row ? referenceDetailExtras[row.id as keyof typeof referenceDetailExtras] : null;
  const detailExtra = extra as {
    applyLabel?: string;
    contact?: { name: string; email: string; phone: string; role: string };
    notices?: readonly (readonly [string, string, string, string])[];
    similar?: readonly (readonly [string, string, string])[];
    scope?: readonly (readonly [string, string, string, string])[];
    activity?: readonly (readonly [string, string, string, string])[];
    evalFacts?: readonly (readonly [string, string, string])[];
    howTo?: readonly (readonly [string, string, string, string])[];
    docs?: readonly (readonly [string, string, string, string])[];
  } | null;
  const date = (value: string | null, raw: string | null) => ({
    value,
    precision: value
      ? raw && /\d{1,2}:\d{2}/.test(raw)
        ? ('raw' as const)
        : ('date' as const)
      : raw
        ? ('raw' as const)
        : null,
    timezone: raw?.match(/(ET|PT|EDT|PDT)/)?.[1] ?? null,
    sourceRaw: raw,
    unavailableReason: value ? null : 'The source did not state this date.',
  });
  const sourcePage = base.sourceUrl
    ? [
        {
          kind: 'source_page' as const,
          label: detailExtra?.applyLabel ?? `Open ${sourceNames[source]} source`,
          authoritativeUrl: base.sourceUrl,
        },
      ]
    : [];
  const documentDestinations = (detailExtra?.docs ?? []).map((item, i) => ({
    kind: `document:document_${i + 1}` as const,
    label: item[0],
    authoritativeUrl: base.sourceUrl!,
  }));
  const contactDestinations = detailExtra?.contact?.email
    ? [
        {
          kind: 'contact_email:primary' as const,
          label: 'Source contact email',
          authoritativeUrl: `mailto:${detailExtra.contact.email}`,
        },
      ]
    : [];
  const destinations = [...sourcePage, ...documentDestinations, ...contactDestinations];
  if (row) referenceDestinationKinds[row.id] = destinations.map((item) => item.kind);
  const contacts = detailExtra?.contact
    ? [
        {
          key: 'primary',
          name: detailExtra.contact.name,
          email: detailExtra.contact.email || null,
          phone: detailExtra.contact.phone || null,
          description: detailExtra.contact.role,
        },
      ]
    : [];
  const changes =
    detailExtra?.notices?.map((item, i) => ({
      key: `change_${i + 1}`,
      text: `${item[0]} — ${item[1]}`,
      occurredAt: item[0].split(' — ')[0] ?? null,
    })) ?? [];
  const similar =
    detailExtra?.similar?.map((item) => ({
      source,
      sourceRecordId: `similar-${item[0].toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      title: item[0],
      agency: null,
      sourceUrl: null,
      type: item[1] === 'Grant' ? ('grant' as const) : ('solicitation' as const),
      deadline: isoDate(item[2]) ?? null,
      similarity: 'moderate' as const,
      matchedOn: ['source criteria'],
    })) ?? [];
  return {
    ...base,
    relevanceScore: mode === 'matched' ? base.relevanceScore : null,
    matchedSignals: mode === 'matched' ? base.matchedSignals : [],
    eligibility: mode === 'matched' ? base.eligibility : null,
    decoration: base.decoration!,
    sourceReference: {
      source,
      recordType: row?.kind ?? base.type,
      sourceRecordId,
      providerRecordId: row?.meta.split(' · ').at(-1) ?? null,
      sourceUpdatedAt: row ? sourceUpdatedAt(row) : null,
      ingestedAt: REFERENCE_INGESTED_AT,
      sourceUpdatedPrecision: 'date',
      sourceUpdatedRaw: row ? sourceUpdatedAt(row) : null,
    },
    displayReference: row
      ? {
          label: 'Source reference',
          value: row.meta.split(' · ').at(-1) ?? sourceRecordId,
          sourceField: 'reference',
        }
      : null,
    dates: {
      posted: date(base.postedDate, null),
      responseDeadline: date(
        base.deadline,
        row ? `${row.when.value}${row.when.note ? ` · ${row.when.note}` : ''}` : null,
      ),
      closeOrArchive: date(base.closeOrArchiveDate, null),
      forecast: {
        anticipatedAwardDate: date(
          null,
          row?.id === 'r4' ? 'Q2 FY27' : null,
        ),
        estimatedPeriod: row?.id === 'r4' ? 'Q2 FY27' : null,
        unavailableReason: null,
      },
    },
    scope: {
      agencies: base.agency ? [base.agency] : [],
      geography: base.geography,
      naicsCodes: base.naicsCodes,
      pscCodes: base.pscCodes,
      sectors: [],
      setAside: base.setAside,
      content: (detailExtra?.scope ?? []).map((item) => ({
        label: item[0],
        kind: item[2] ? 'source_requirement' : 'source_description',
        statement: item[1],
        sourceExcerpt: item[3] || null,
        sourceDocument: null,
        sourceField: item[3] ? 'requirement.sourceExcerpt' : 'description',
        sourcePage: null,
        reviewStatus: item[2] === 'Evidence-bound' ? 'pending' : null,
        supersededAt: null,
      })),
      unavailableReason: detailExtra?.scope?.length
        ? null
        : 'The cached source did not provide a structured scope description.',
    },
    eligibilityDetail: {
      applicantTypes: base.applicantTypes,
      restrictions: [],
      sourceText: base.eligibility?.reason ?? null,
      clientState: mode === 'matched' ? (base.eligibility?.state ?? null) : null,
      clientReason: mode === 'matched' ? (base.eligibility?.reason ?? null) : null,
      unavailableReason: null,
    },
    evaluation: {
      criteria: detailExtra?.evalFacts?.map((item) => `${item[0]}: ${item[1]}`).join('; ') ?? null,
      costShare: [],
      prerequisites: [],
      awardCategory: null,
      unavailableReason: null,
    },
    responseInstructions: {
      steps: detailExtra?.howTo?.map((item) => `${item[0]}: ${item[1]}`) ?? [],
      details: (detailExtra?.howTo ?? []).map((item) => ({
        label: item[0],
        kind:
          (
            {
              Prerequisite: 'prerequisite',
              Deadline: 'question_deadline',
              Response: 'submission',
            } as Record<string, string>
          )[item[2]] ?? 'response_guidance',
        statement: item[1],
        sourceExcerpt: item[3] || null,
        sourceDocument: null,
        sourceField: item[3] ? 'requirement.sourceExcerpt' : 'response_guidance',
        sourcePage: null,
        reviewStatus: item[2] === 'Evidence-bound' ? 'pending' : null,
        supersededAt: null,
      })),
      unavailableReason: detailExtra?.howTo?.length
        ? null
        : 'The cached source did not state response instructions.',
    },
    activity: changes.map((item) => ({
      kind: 'notice_history',
      statement: item.text,
      sourceExcerpt: null,
      sourceDocument: null,
      sourceField: 'timeline.entries',
      sourcePage: null,
      reviewStatus: null,
      supersededAt: null,
      occurredAt: item.occurredAt,
      title: item.text,
      severity: 'informational' as const,
      changedDimensions: [],
      sourceUrl: null,
    })),
    activityCoverage: changes.length
      ? null
      : 'Notice history is not available in this fixture state.',
    destinations,
    documents:
      detailExtra?.docs?.map((item, i) => ({
        key: `document_${i + 1}`,
        label: item[0],
        url: base.sourceUrl ?? '',
        documentType: item[2] || null,
      })) ?? [],
    contacts,
    changeNotes: changes,
    provenance: {
      sourceModel: 'cached source record',
      cached: true,
      sourceFacts: { ...base.sourceFacts },
      unavailableReason: null,
    },
    similarOpportunities: similar,
    similarOpportunitiesUnavailableReason: null,
    workflow: {
      available: Boolean(clientId),
      status: base.decoration?.workflow.status ?? null,
      humanDecision: null,
      unavailableReason: clientId ? null : 'Select a client to use client workflow.',
    },
    capabilities: {
      view: { allowed: true, reason: '' },
      sourceClick: { allowed: destinations.length > 0, reason: '' },
      pursue: base.decoration?.capabilities.pursue ?? { allowed: false, reason: 'Unavailable' },
      save: { allowed: true, reason: '' },
      submit: { allowed: false, reason: 'Capiro does not submit applications.' },
    },
  };
}

export function createReferenceFixtureApi(): FixtureApi {
  const state = initialState();
  let pursuitApi = createReferencePursuitFixtureApi();
  const listSearches = (clientId: string | null) => savedList(state, clientId);
  const api: FixtureApi = {
    async get<T>(url: string) {
      if (url === '/api/clients')
        return {
          data: referenceClients.map((client) => ({
            id: client.id,
            name: client.name,
            status: 'active',
            meta: client.meta,
            count: client.count,
          })) as T,
        };
      if (url === '/api/tenant-members')
        return {
          data: [
            {
              id: 'user_fixture_neo_2026',
              clerkUserId: 'clerk_fixture_neo_2026',
              email: 'neo@capiro.ai',
              name: 'Neo Martinez',
            },
            {
              id: 'user_fixture_maya_2026',
              clerkUserId: 'clerk_fixture_maya_2026',
              email: 'maya@capiro.ai',
              name: 'Maya Chen',
            },
          ] as T,
        };
      if (url === '/api/me')
        return {
          data: {
            user: {
              id: FIXTURE_USER_ID,
              clerkUserId: FIXTURE_CLERK_USER_ID,
              email: 'neo@capiro.ai',
              firstName: 'Neo',
              lastName: 'Martinez',
              title: 'Government Affairs',
              emailSignatureEnabled: false,
              hasEmailSignature: false,
              tourCompleted: true,
              legiwatchIntroSeen: true,
            },
            tenant: { id: FIXTURE_TENANT_ID, slug: 'capiro-internal', name: 'Capiro Internal' },
            role: 'user_admin',
            billingAdmin: true,
            features: { meetingsV2: false, meriDockUndockUi: true },
          } as T,
        };
      if (url === '/api/notifications') return { data: { unread: 2, items: [] } as T };
      if (url === '/intel-api/feature-flags')
        return {
          data: {
            funding_opportunities: true,
            funding_opportunities_inbox: true,
            funding_opportunities_pipeline_v2: true,
          } as T,
        };
      if (url === '/api/intelligence/opportunities/v2/sources')
        return { data: { sources: currentSources(), generatedAt: REFERENCE_NOW } as T };
      if (url.startsWith('/api/intelligence/opportunities/v2/search?'))
        return { data: response(parseCriteria(url), state) as T };
      if (url.startsWith('/api/intelligence/opportunities/v2/searches')) {
        const parts = pathParts(url);
        if (parts.length === 6 && parts[5])
          return {
            data: clone(
              state.searches.get(parts[5]) ?? reject(404, 'Saved search not found.'),
            ) as T,
          };
        return {
          data: listSearches(new URLSearchParams(url.split('?')[1] ?? '').get('clientId')) as T,
        };
      }
      if (url.startsWith('/api/intelligence/opportunities/v2/detail/')) {
        const parts = pathParts(url);
        const source = parts[5] as OpportunitySourceV2;
        const sourceRecordId = parts.slice(6).join('/');
        if (!sourceNames[source]) reject(404, 'Opportunity not found.');
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        const clientId = params.get('clientId') || null;
        const mode = params.get('mode') === 'matched' ? 'matched' : 'all';
        const opportunity = richDetailFor(source, sourceRecordId, state, clientId, mode);
        return {
          data: {
            opportunity,
            generatedAt: REFERENCE_NOW,
            source,
            sourceRecordId,
            authoritativeSourceUrl:
              opportunity.destinations.find((item) => item.kind === 'source_page')
                ?.authoritativeUrl ?? null,
          } as FundingOpportunityV2DetailResponse as T,
        };
      }
      if (url.includes('/pipeline')) return pursuitApi.get<T>(url);
      return reject(404, `Unexpected visual fixture GET ${url}`);
    },
    async post<T>(url: string, data?: unknown) {
      const parts = pathParts(url);
      if (url === '/api/intelligence/opportunities/v2/searches') {
        const input = data as Partial<SavedSearchRecordV2>;
        if (!input.name?.trim() || !input.criteria || !('clientId' in input))
          reject(400, 'Saved search name, criteria, and scope are required.');
        const id = `s${state.nextSearch++}`;
        const record: SavedSearchRecordV2 = {
          ...savedRecord('s1'),
          id,
          name: input.name.trim(),
          description: input.description ?? null,
          visibility: input.visibility === 'tenant' ? 'tenant' : 'private',
          clientId: input.clientId ?? null,
          criteria: clone(input.criteria),
          clientName: input.clientId ? 'Overland AI' : null,
          isTenantWide: !input.clientId,
          createdByUserId: FIXTURE_USER_ID,
          ownerId: FIXTURE_USER_ID,
          warnings: [],
        };
        state.searches.set(id, record);
        return { data: clone(record) as T };
      }
      if (url.includes('/source-clicks')) {
        const input = data as {
          source?: OpportunitySourceV2;
          sourceRecordId?: string;
          destinationKind?: string;
        };
        if (!input.source || !input.sourceRecordId || !input.destinationKind)
          reject(400, 'source, sourceRecordId, and destinationKind are required.');
        const row = rowByIdentity.get(`${input.source}:${input.sourceRecordId}`);
        const extra = row && referenceDetailExtras[row.id as keyof typeof referenceDetailExtras];
        if (!row || !extra || !referenceDestinationKinds[row.id]?.includes(input.destinationKind))
          reject(404, 'That authoritative destination is not available.');
        const destinationUrl = input.destinationKind.startsWith('contact_email:')
          ? `mailto:${extra.contact?.email}`
          : row.href;
        referenceFixtureAuditEvents.push({
          source: input.source,
          sourceRecordId: input.sourceRecordId,
          destinationKind: input.destinationKind,
          authoritativeUrl: destinationUrl,
          at: REFERENCE_NOW,
        });
        return { data: { audited: true, authoritativeUrl: destinationUrl } as T };
      }
      if (url.includes('/searches/') && url.endsWith('/duplicate')) {
        const source = state.searches.get(parts[5]!);
        if (!source) reject(404, 'Saved search not found.');
        const id = `s${state.nextSearch++}`;
        const record: SavedSearchRecordV2 = {
          ...clone(source),
          id,
          name: (data as { name?: string } | undefined)?.name?.trim() || `${source.name} copy`,
          createdAt: REFERENCE_NOW,
          updatedAt: REFERENCE_NOW,
        };
        state.searches.set(id, record);
        return { data: clone(record) as T };
      }
      if (url.includes('/searches/') && url.endsWith('/apply')) {
        const source = state.searches.get(parts[5]!);
        if (!source || source.archivedAt) reject(404, 'Saved search cannot be applied.');
        return {
          data: {
            ...response(source.criteria, state),
            search: clone(source),
            criteria: clone(source.criteria),
          } as T,
        };
      }
      if (url.includes('/not-fit')) {
        const input = data as { reason?: string; note?: string | null };
        const clientId = parts[3]!;
        const source = parts[5] as OpportunitySourceV2;
        const sourceRecordId = parts[6]!;
        const reason = input.reason;
        if (
          !clientId ||
          !reason ||
          !['capability', 'eligibility', 'economics', 'capacity'].includes(reason)
        )
          reject(400, 'A valid reason is required.');
        detailFor(source, sourceRecordId, state, clientId);
        state.notFit.push({ clientId, source, sourceRecordId, reason, note: input.note ?? null });
        return { data: { recorded: true, reason } as T };
      }
      if (url.endsWith('/action')) {
        const input = data as { intent?: string };
        const clientId = parts[3]!;
        const source = parts[5] as OpportunitySourceV2;
        const sourceRecordId = parts[6]!;
        if (!['review', 'pursuit', 'save', 'not_fit'].includes(input?.intent ?? ''))
          reject(400, 'Only review, pursuit, save, or not_fit actions are supported.');
        detailFor(source, sourceRecordId, state, clientId);
        state.actions.push({ clientId, source, sourceRecordId, intent: input.intent! });
        state.workflowOverrides.set(
          workflowKey(clientId, source, sourceRecordId),
          input.intent === 'pursuit'
            ? 'pursuing'
            : input.intent === 'save'
              ? 'saved'
              : input.intent === 'not_fit'
                ? 'not_fit'
                : 'review',
        );
        return { data: { recorded: true, intent: input.intent } as T };
      }
      if (url.endsWith('/save')) {
        const input = data as { status?: string };
        const source = parts.at(-3) as OpportunitySourceV2;
        const sourceRecordId = parts.at(-2)!;
        const row = rowByIdentity.get(`${source}:${sourceRecordId}`);
        if (!row || input.status !== 'saved')
          reject(400, 'A valid saved status and opportunity identity are required.');
        const clientId = parts[2] === 'clients' ? parts[3]! : null;
        state.bookmarks.add(workflowKey(clientId, source, sourceRecordId));
        return { data: { saved: true, source, sourceRecordId } as T };
      }
      if (url.includes('/searches/')) return reject(400, `Unexpected visual fixture POST ${url}`);
      if (url.includes('/pipeline')) return pursuitApi.post<T>(url, data);
      return reject(400, `Unexpected visual fixture POST ${url}`);
    },
    async patch<T>(url: string, data?: unknown) {
      const parts = pathParts(url);
      if (url.includes('/searches/')) {
        const current = state.searches.get(parts[5]!);
        if (!current) reject(404, 'Saved search not found.');
        const input = data as Partial<SavedSearchRecordV2> & { archived?: boolean };
        const next = {
          ...current,
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.clientId !== undefined
            ? {
                clientId: input.clientId,
                isTenantWide: !input.clientId,
                clientName: input.clientId ? 'Overland AI' : null,
              }
            : {}),
          ...(input.criteria !== undefined ? { criteria: clone(input.criteria) } : {}),
          ...(input.archived === true
            ? { archivedAt: REFERENCE_NOW }
            : input.archived === false
              ? { archivedAt: null }
              : {}),
          updatedAt: REFERENCE_NOW,
        };
        state.searches.set(parts[5]!, next);
        return { data: clone(next) as T };
      }
      if (/\/api\/intelligence\/clients\/[^/]+\/opportunities\/[^/]+\/[^/]+$/.test(url)) {
        const clientId = parts[3]!;
        const source = parts[5] as OpportunitySourceV2;
        const sourceRecordId = parts[6]!;
        const input = data as Record<string, unknown>;
        const allowed = new Set(['ownerUserId', 'notes', 'nextAction', 'nextActionDueAt']);
        if (Object.keys(input).some((key) => !allowed.has(key)))
          reject(400, 'Unsupported workflow fields.');
        const row = detailFor(source, sourceRecordId, state, clientId);
        const decoration = row.decoration;
        if (!decoration?.workflow.available)
          reject(403, 'Workflow is unavailable for this client.');
        return {
          data: {
            ...row,
            workflow: { ...decoration.workflow, ...input },
            decoration: { ...decoration, workflow: { ...decoration.workflow, ...input } },
          } as T,
        };
      }
      return reject(400, `Unexpected visual fixture PATCH ${url}`);
    },
    async delete<T>(url: string) {
      const parts = pathParts(url);
      if (url.endsWith('/save')) {
        const source = parts.at(-3) as OpportunitySourceV2;
        const sourceRecordId = parts.at(-2)!;
        const row = rowByIdentity.get(`${source}:${sourceRecordId}`);
        if (!row) reject(404, 'Opportunity not found.');
        const clientId = parts[2] === 'clients' ? parts[3]! : null;
        state.bookmarks.delete(workflowKey(clientId, source, sourceRecordId));
        return { data: { saved: false } as T };
      }
      if (url.includes('/searches/')) {
        const id = parts[5]!;
        if (!state.searches.has(id)) reject(404, 'Saved search not found.');
        state.searches.delete(id);
        return { data: { deleted: true, id } as T };
      }
      return reject(400, `Unexpected visual fixture DELETE ${url}`);
    },
  };
  return api;
}

let defaultApi = createReferenceFixtureApi();
export function resetReferenceFixtureState(): void {
  referenceFixtureAuditEvents.length = 0;
  defaultApi = createReferenceFixtureApi();
}

export const useApi = (): FixtureApi => defaultApi;

export const referenceFixtureMapping = Object.freeze({
  rowIdsByReferenceId,
  referencePursuitCards,
  referenceReasons,
});
export const referenceFixtureInventory = Object.freeze({
  opportunities: referenceOpportunityRows.length,
  clients: referenceClients.length,
  savedSearches: referenceSavedSearches.length,
  pursuitCards: referencePursuitCards.length,
  sourceHealth: referenceSourceHealth.length,
});
export type ReferenceFixtureRecord = OpportunitySearchRecordV2;
export type ReferenceFixtureSavedSearch = SavedSearchSummaryV2;
export { FIXTURE_USER_ID };
