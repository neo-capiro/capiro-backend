import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from './meri-tools.service.js';

// Keep unrelated provider graphs out of this no-I/O query test.
jest.mock('../clients/client-capabilities.service.js', () => ({ ClientCapabilitiesService: jest.fn() }));
jest.mock('../clients/client-people.service.js', () => ({ ClientPeopleService: jest.fn() }));
jest.mock('../clients/client-facilities.service.js', () => ({ ClientFacilitiesService: jest.fn() }));
jest.mock('../engagement/mail-sender.service.js', () => ({ EngagementMailSender: jest.fn() }));
jest.mock('../regulatory-docket/regulatory-docket.service.js', () => ({ RegulatoryDocketService: jest.fn() }));
jest.mock('../lda-intel/lda-intel.service.js', () => ({ LdaIntelService: jest.fn() }));
jest.mock('../lobby-intel/lobby-intel.service.js', () => ({ LobbyIntelService: jest.fn() }));
jest.mock('../federal-spending/federal-spending.service.js', () => ({ FederalSpendingService: jest.fn() }));
jest.mock('./analytics/analytics-db.service.js', () => ({ AnalyticsDbService: jest.fn() }));
jest.mock('../intelligence/actions/action-recommendation-read.service.js', () => ({ ActionRecommendationReadService: jest.fn() }));
jest.mock('../intelligence/intelligence.service.js', () => ({ IntelligenceService: jest.fn() }));
jest.mock('../clients/clients.service.js', () => ({ ClientsService: jest.fn() }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: jest.fn() }));
jest.mock('../program-element/program-element-read.service.js', () => ({ ProgramElementReadService: jest.fn() }));
jest.mock('../acquisition-personnel/acquisition-personnel-read.service.js', () => ({ AcquisitionPersonnelReadService: jest.fn() }));
jest.mock('../memory/memory-candidate.service.js', () => ({ MemoryCandidateService: jest.fn() }));
jest.mock('../memory/memory-ingest.service.js', () => ({ MemoryIngestService: jest.fn() }));
jest.mock('../memory/memory-store.service.js', () => ({ MemoryStoreService: jest.fn() }));
jest.mock('../clients/representation-resolver.service.js', () => ({ RepresentationResolverService: jest.fn() }));
jest.mock('./meri-docgen.service.js', () => ({ MeriDocgenService: jest.fn() }));
jest.mock('./meri-context-plane.service.js', () => ({ MeriContextPlaneService: jest.fn() }));
jest.mock('../funding-opportunities/meri-opportunity-tools.adapter.js', () => ({ MeriOpportunityToolsAdapter: jest.fn() }));
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: jest.fn() }));
jest.mock('./meri-defense-budget-tool.helpers.js', () => ({}));
jest.mock('../research-portfolios/research-portfolio-meri-tools.service.js', () => ({
  isResearchPortfolioMeriTool: () => false,
  ResearchPortfolioMeriToolsService: jest.fn(),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ACTOR = 'actor-1';
const OTHER_ACTOR = 'actor-2';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const OTHER_CLIENT = '44444444-4444-4444-8444-444444444444';
const ctx = { tenantId: TENANT, userId: ACTOR } as TenantContext;

type MeetingRow = {
  id: string;
  tenantId: string;
  clientId: string;
  createdByUserId: string | null;
  connection: { createdByUserId: string } | null;
  subject: string;
  description: string | null;
  location: string | null;
  organizerEmail: string | null;
  organizerName: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
  isVirtual: boolean;
  joinLink: string | null;
  isInternal: boolean;
  client: { id: string; name: string };
  attendees: unknown[];
};

/** Only Prisma's filters used by these two meeting reads; the rows remain in memory. */
function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') {
      return (condition as Record<string, unknown>[]).every((part) => matchesWhere(row, part));
    }
    if (key === 'OR') {
      return (condition as Record<string, unknown>[]).some((part) => matchesWhere(row, part));
    }
    const value = row[key];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const filter = condition as Record<string, unknown>;
      if ('notIn' in filter) return !(filter.notIn as string[]).includes(value as string);
      if ('contains' in filter) {
        const haystack = typeof value === 'string' ? value : '';
        const needle = filter.contains as string;
        return filter.mode === 'insensitive'
          ? haystack.toLowerCase().includes(needle.toLowerCase())
          : haystack.includes(needle);
      }
      if ('gte' in filter || 'lt' in filter) {
        if (!(value instanceof Date)) return false;
        return (!filter.gte || value >= (filter.gte as Date)) &&
          (!filter.lt || value < (filter.lt as Date));
      }
      return value !== null && typeof value === 'object' &&
        matchesWhere(value as Record<string, unknown>, filter);
    }
    return value === condition;
  });
}

function meeting(id: string, changes: Partial<MeetingRow> = {}): MeetingRow {
  const startsAt = new Date(Date.now() + 24 * 60 * 60_000);
  return {
    id,
    tenantId: TENANT,
    clientId: CLIENT,
    createdByUserId: ACTOR,
    connection: null,
    subject: 'Budget review',
    description: null,
    location: null,
    organizerEmail: null,
    organizerName: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60_000),
    status: 'confirmed',
    isVirtual: false,
    joinLink: null,
    isInternal: false,
    client: { id: CLIENT, name: 'Client' },
    attendees: [],
    ...changes,
  };
}

function tools(rows: MeetingRow[]) {
  type OrderBy = Record<string, 'asc' | 'desc'>;
  type FindManyArgs = {
    where: Record<string, unknown>;
    orderBy?: OrderBy | OrderBy[];
    take?: number;
    cursor?: { id: string };
    skip?: number;
  };
  const findMany = jest.fn(async ({ where, orderBy, take, cursor, skip = 0 }: FindManyArgs) => {
    const ordered = rows
      .filter((row) => matchesWhere(row as unknown as Record<string, unknown>, where))
      .sort((left, right) => {
        for (const directive of orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : []) {
          const [field, direction] = Object.entries(directive)[0]!;
          const first = left[field as keyof MeetingRow];
          const second = right[field as keyof MeetingRow];
          const comparison = first instanceof Date && second instanceof Date
            ? first.getTime() - second.getTime()
            : String(first ?? '').localeCompare(String(second ?? ''));
          if (comparison !== 0) return direction === 'desc' ? -comparison : comparison;
        }
        return 0;
      });
    const cursorIndex = cursor ? ordered.findIndex((row) => row.id === cursor.id) : 0;
    if (cursorIndex < 0) return [];
    const start = cursorIndex + skip;
    return ordered.slice(start, take === undefined ? undefined : start + take);
  });
  const empty = { findMany: jest.fn(async () => []) };
  const tx = {
    client: empty,
    meeting: { findMany },
    mailThread: empty,
    mailMessage: empty,
    clioNote: empty,
    directoryContactNote: empty,
  };
  const withTenant = jest.fn(async (_tenantId: string, run: (arg: typeof tx) => unknown) => run(tx));
  const service = Object.assign(Object.create(MeriToolsService.prototype), {
    prisma: { withTenant },
    ensureClientVisible: jest.fn(async (_ctx: TenantContext, clientId: string) => clientId),
  }) as MeriToolsService;
  const call = (name: 'searchResearchSources' | 'listUpcomingMeetings', input: Record<string, unknown>) =>
    (service as unknown as Record<string, (c: TenantContext, i: Record<string, unknown>) => Promise<unknown>>)[name]!(ctx, input);
  return { call, findMany, withTenant };
}

describe('Meri meeting read query ownership', () => {
  it('intersects research text with meeting ownership, tenant, client and live status', async () => {
    const { call, findMany, withTenant } = tools([
      meeting('owned'),
      meeting('connection-owned', { createdByUserId: OTHER_ACTOR, connection: { createdByUserId: ACTOR } }),
      meeting('same-tenant-other-owner', { createdByUserId: OTHER_ACTOR }),
      meeting('owner-no-match', { subject: 'Unrelated subject' }),
      meeting('foreign-tenant', { tenantId: OTHER_TENANT }),
      meeting('other-client', { clientId: OTHER_CLIENT }),
      meeting('cancelled', { status: 'cancelled' }),
      meeting('canceled', { status: 'canceled' }),
      meeting('deleted', { status: 'deleted' }),
      meeting('mixed-case-cancelled', { status: 'Cancelled' }),
      meeting('padded-canceled', { status: ' CANCELED ' }),
      meeting('mixed-case-deleted', { status: 'Deleted' }),
    ]);
    const result = await call('searchResearchSources', { query: 'budget', clientId: CLIENT }) as {
      results: Array<{ id: string }>;
    };
    expect(result.results.map((item) => item.id).sort()).toEqual(['connection-owned', 'owned']);
    expect(withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: TENANT,
        clientId: CLIENT,
        status: { notIn: ['cancelled', 'canceled', 'deleted'] },
      }),
    }));
  });

  it('intersects upcoming owner/client/time filters with all cancelled and deleted variants', async () => {
    const { call, findMany, withTenant } = tools([
      meeting('owned'),
      meeting('connection-owned', { createdByUserId: OTHER_ACTOR, connection: { createdByUserId: ACTOR } }),
      meeting('same-tenant-other-owner', { createdByUserId: OTHER_ACTOR }),
      meeting('foreign-tenant', { tenantId: OTHER_TENANT }),
      meeting('other-client', { clientId: OTHER_CLIENT }),
      meeting('cancelled', { status: 'cancelled' }),
      meeting('canceled', { status: 'canceled' }),
      meeting('deleted', { status: 'deleted' }),
      meeting('mixed-case-cancelled', { status: 'Cancelled' }),
      meeting('padded-canceled', { status: ' CANCELED ' }),
      meeting('mixed-case-deleted', { status: 'Deleted' }),
      meeting('outside-window', { startsAt: new Date(Date.now() + 366 * 24 * 60 * 60_000) }),
    ]);
    const result = await call('listUpcomingMeetings', { clientId: CLIENT, withinDays: 30 }) as {
      meetings: Array<{ id: string }>;
      count: number;
    };
    expect(result.meetings.map((item) => item.id).sort()).toEqual(['connection-owned', 'owned']);
    expect(result.count).toBe(2);
    expect(withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: TENANT,
        clientId: CLIENT,
        status: { notIn: ['cancelled', 'canceled', 'deleted'] },
        startsAt: expect.objectContaining({ gte: expect.any(Date), lt: expect.any(Date) }),
      }),
    }));
  });

  it('continues research search past a full first page of noncanonical inactive meetings', async () => {
    const reference = Date.now() + 24 * 60 * 60_000;
    const inactive = Array.from({ length: 25 }, (_, index) =>
      meeting(`inactive-${String(index).padStart(2, '0')}`, {
        status: index % 2 === 0 ? ' CANCELLED ' : 'Deleted',
        startsAt: new Date(reference + (50 - index) * 60_000),
      }),
    );
    const { call, findMany } = tools([
      ...inactive,
      meeting('live-after-inactive', { startsAt: new Date(reference + 25 * 60_000) }),
    ]);
    const result = await call('searchResearchSources', { query: 'budget', limit: 1 }) as {
      results: Array<{ id: string }>;
    };
    expect(result.results.map((item) => item.id)).toEqual(['live-after-inactive']);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ take: 25 }));
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      take: 25,
      cursor: { id: 'inactive-24' },
      skip: 1,
    }));
  });

  it('continues upcoming meetings past a full first page of noncanonical inactive rows', async () => {
    const reference = Date.now() + 24 * 60 * 60_000;
    const inactive = Array.from({ length: 25 }, (_, index) =>
      meeting(`inactive-${String(index).padStart(2, '0')}`, {
        status: index % 2 === 0 ? ' CANCELED ' : 'Deleted',
        startsAt: new Date(reference + index * 60_000),
      }),
    );
    const { call, findMany } = tools([
      ...inactive,
      meeting('live-after-inactive', { startsAt: new Date(reference + 25 * 60_000) }),
    ]);
    const result = await call('listUpcomingMeetings', { limit: 1, withinDays: 30 }) as {
      meetings: Array<{ id: string }>;
      count: number;
    };
    expect(result.meetings.map((item) => item.id)).toEqual(['live-after-inactive']);
    expect(result.count).toBe(1);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ take: 25 }));
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      take: 25,
      cursor: { id: 'inactive-24' },
      skip: 1,
    }));
  });

  it('reports scan exhaustion rather than falsely claiming no upcoming meeting', async () => {
    const reference = Date.now() + 24 * 60 * 60_000;
    const inactive = Array.from({ length: 250 }, (_, index) =>
      meeting(`inactive-${String(index).padStart(3, '0')}`, {
        status: ' Cancelled ',
        startsAt: new Date(reference + index * 60_000),
      }),
    );
    const { call, findMany } = tools([
      ...inactive,
      meeting('live-beyond-cap', { startsAt: new Date(reference + 250 * 60_000) }),
    ]);
    await expect(call('listUpcomingMeetings', { limit: 1, withinDays: 30 }))
      .rejects.toMatchObject({ status: 503 });
    expect(findMany).toHaveBeenCalledTimes(10);
  });
});
