import type { PrismaService } from '../../prisma/prisma.service.js';
import { NewsCatcherDashboardService } from './news-catcher-dashboard.service.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

interface TestCapability {
  name: string;
  sector: string | null;
  tags: unknown;
  issueCodes: unknown;
  keywords: string[];
  peNumber: string | null;
  peNumbers: string[];
  appropriationAccount: string | null;
  serviceBranch: string | null;
  targetSubcommittee: string | null;
}

interface TestClient {
  id: string;
  name: string;
  intakeData: Record<string, unknown>;
  issueCodes: string[];
  capabilities: TestCapability[];
}

function capability(overrides: Partial<TestCapability> = {}): TestCapability {
  return {
    name: 'Ground Robotics',
    sector: null,
    tags: [],
    issueCodes: [],
    keywords: [],
    peNumber: null,
    peNumbers: [],
    appropriationAccount: null,
    serviceBranch: null,
    targetSubcommittee: null,
    ...overrides,
  };
}

function client(overrides: Partial<TestClient> & Pick<TestClient, 'id' | 'name'>): TestClient {
  return {
    intakeData: {},
    issueCodes: [],
    capabilities: [],
    ...overrides,
  };
}

function prismaWithClients(
  clients: TestClient[],
  options: {
    ldaMappings?: Array<{ clientId: string; externalId: string }>;
    ldaCodeRows?: Array<{ id: number; code: string }>;
    issueNameRows?: Array<{ code: string; name: string }>;
  } = {},
): PrismaService {
  const rawResults: unknown[] = [];
  if ((options.ldaMappings ?? []).some((mapping) => Number.isFinite(Number(mapping.externalId)))) {
    rawResults.push(options.ldaCodeRows ?? []);
  }
  const hasAnyIssueCode =
    clients.some(
      (row) =>
        row.issueCodes.length > 0 ||
        row.capabilities.some(
          (cap) => Array.isArray(cap.issueCodes) && cap.issueCodes.some((value) => typeof value === 'string'),
        ),
    ) || (options.ldaCodeRows?.length ?? 0) > 0;
  if (hasAnyIssueCode) rawResults.push(options.issueNameRows ?? []);

  const queryRaw = jest.fn();
  for (const result of rawResults) queryRaw.mockResolvedValueOnce(result);

  return {
    withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback({
        client: {
          findMany: jest.fn().mockResolvedValue(clients),
        },
        clientIntelMapping: {
          findMany: jest.fn().mockResolvedValue(options.ldaMappings ?? []),
        },
      }),
    ),
    $queryRaw: queryRaw,
  } as unknown as PrismaService;
}

function articleFixture() {
  return {
    _id: 'article-1',
    title: 'RTX wins new Pentagon procurement contract',
    link: 'https://example.test/rtx-contract',
    name_source: 'Example Defense News',
    published_date: '2026-08-08 12:00:00',
    description: 'The Department of Defense awarded RTX a procurement contract.',
    duplicate_count: 3,
    nlp: {
      summary: 'RTX received a new Pentagon contract.',
      ner_ORG: [{ entity_name: 'RTX', count: 3 }],
    },
  };
}

describe('NewsCatcherDashboardService', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.NEWSCATCHER_API_KEY = 'test-news-key';
    process.env.NEWSCATCHER_BASE_URL = 'https://newscatcher.example.test/api';
    process.env.NEWSCATCHER_DASHBOARD_CACHE_MS = '1800000';
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  it('uses one portfolio policy+signal request and retains direct company coverage', async () => {
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ articles: [articleFixture()] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new NewsCatcherDashboardService(
      prismaWithClients([
        client({ id: 'client-1', name: 'RTX' }),
        client({
          id: 'client-2',
          name: 'Overland AI',
          intakeData: { dba: 'Overland' },
          capabilities: [
            capability({
              name: 'Autonomous Ground Vehicles',
              keywords: ['ground robotics'],
            }),
          ],
        }),
      ]),
    );

    const result = await service.getDashboard('tenant-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.ORG_entity_name).toBeUndefined();
    expect(body.exclude_duplicates).toBe(true);
    expect(body.include_nlp_data).toBe(true);
    expect(body.has_nlp).toBeUndefined();
    expect(body.ranked_only).toBe(false);
    expect(body.from_).toBe('48h');
    expect(String(body.q)).toContain('Congress');
    expect(String(body.q)).toContain('"Autonomous Ground Vehicles"');
    expect(String(body.q)).toContain('"RTX"');

    expect(result.available).toBe(true);
    expect(result.monitoredClientCount).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'article-1',
      title: 'RTX wins new Pentagon procurement contract',
      source: 'Example Defense News',
      clientMatches: [{ id: 'client-1', name: 'RTX' }],
      topics: expect.arrayContaining(['Procurement', 'Defense']),
      duplicateCount: 3,
    });
    expect(result.items[0]?.relevanceReason).toContain('Direct company coverage');
  });

  it('surfaces capability news even when the smaller client is never named', async () => {
    const article = {
      _id: 'capability-story',
      title: 'Army accelerates autonomous ground vehicles procurement',
      link: 'https://example.test/army-autonomy',
      name_source: 'Defense Example',
      published_date: '2026-08-08 13:00:00',
      description: 'The Army is expanding procurement for autonomous ground vehicles.',
      nlp: {
        summary: 'Army acquisition leaders outlined a faster autonomous ground vehicles program.',
        ner_ORG: [{ entity_name: 'United States Army', count: 2 }],
      },
    };
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ articles: [article] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const service = new NewsCatcherDashboardService(
      prismaWithClients([
        client({
          id: 'overland',
          name: 'Overland AI',
          capabilities: [
            capability({
              name: 'Autonomous Ground Vehicles',
              tags: ['ground robotics'],
              keywords: ['autonomous mobility'],
              serviceBranch: 'Army',
            }),
          ],
        }),
      ]),
    );

    const result = await service.getDashboard('tenant-1');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.clientMatches).toEqual([{ id: 'overland', name: 'Overland AI' }]);
    expect(result.items[0]?.relevanceReason).toContain('Autonomous Ground Vehicles');
    expect(result.items[0]?.relevanceReason).not.toContain('Direct company coverage');
  });

  it('surfaces a specific client issue without requiring a company mention', async () => {
    const article = {
      _id: 'aviation-rule',
      title: 'FAA proposes new aviation certification rule',
      link: 'https://example.test/faa-rule',
      name_source: 'Policy Example',
      published_date: '2026-08-08 11:00:00',
      description: 'A federal agency proposed a new aviation rulemaking and aircraft certification process.',
      nlp: {
        summary: 'The federal aviation rule would alter aircraft certification.',
        ner_ORG: [{ entity_name: 'Federal Aviation Administration', count: 3 }],
      },
    };
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ articles: [article] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const service = new NewsCatcherDashboardService(
      prismaWithClients(
        [client({ id: 'small-aero', name: 'Small Aero Co.', issueCodes: ['AVI'] })],
        { issueNameRows: [{ code: 'AVI', name: 'Aviation/Aircraft/Airlines' }] },
      ),
    );

    const result = await service.getDashboard('tenant-1');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.clientMatches).toEqual([{ id: 'small-aero', name: 'Small Aero Co.' }]);
    expect(result.items[0]?.relevanceReason).toContain('Aviation/Aircraft/Airlines');
  });

  it('uses confirmed LDA-derived issues as news signals without a per-client provider call', async () => {
    const article = {
      _id: 'communications-rule',
      title: 'FCC advances communications infrastructure rule',
      link: 'https://example.test/fcc-communications',
      name_source: 'Policy Example',
      published_date: '2026-08-08 10:00:00',
      description: 'The federal agency advanced a communications regulatory proposal.',
      nlp: { summary: 'The FCC communications rule moved forward.', ner_ORG: [] },
    };
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ articles: [article] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new NewsCatcherDashboardService(
      prismaWithClients(
        [client({ id: 'small-tech', name: 'Small Tech LLC' })],
        {
          ldaMappings: [{ clientId: 'small-tech', externalId: '42' }],
          ldaCodeRows: [{ id: 42, code: 'COM' }],
          issueNameRows: [{ code: 'COM', name: 'Communications/Broadcasting/Radio/TV' }],
        },
      ),
    );

    const result = await service.getDashboard('tenant-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.clientMatches).toEqual([{ id: 'small-tech', name: 'Small Tech LLC' }]);
  });

  it('does not map a broad issue or service branch by itself', async () => {
    const generic = {
      _id: 'generic-defense',
      title: 'Senate advances annual defense authorization bill',
      link: 'https://example.test/ndaa',
      name_source: 'Policy Example',
      published_date: '2026-08-08 09:00:00',
      description: 'The Senate advanced a broad Department of Defense authorization measure.',
      nlp: {
        summary: 'Congress moved the annual defense authorization bill.',
        ner_ORG: [{ entity_name: 'United States Senate', count: 2 }],
      },
    };
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ articles: [generic] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const service = new NewsCatcherDashboardService(
      prismaWithClients(
        [
          client({
            id: 'client-1',
            name: 'Tiny Defense Startup',
            issueCodes: ['DEF'],
            capabilities: [capability({ name: 'Ground Robotics', serviceBranch: 'Army' })],
          }),
        ],
        { issueNameRows: [{ code: 'DEF', name: 'Defense' }] },
      ),
    );

    const result = await service.getDashboard('tenant-1');

    expect(result.available).toBe(true);
    expect(result.items).toEqual([]);
  });

  it('adds a stripped legal-name alias so common press usage still resolves to the client', async () => {
    const article = articleFixture();
    article._id = 'article-shiftwave';
    article.title = 'Shiftwave receives federal research award';
    article.link = 'https://example.test/shiftwave-award';
    article.description = 'A federal agency selected Shiftwave for a research award.';
    article.nlp = {
      summary: 'Shiftwave was selected by a federal agency.',
      ner_ORG: [{ entity_name: 'Shiftwave', count: 2 }],
    };
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ articles: [article] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new NewsCatcherDashboardService(
      prismaWithClients([client({ id: 'client-1', name: 'Shiftwave, Inc.' })]),
    );
    const result = await service.getDashboard('tenant-1');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(String(body.q)).toContain('"Shiftwave Inc."');
    expect(String(body.q)).toContain('"Shiftwave"');
    expect(result.items[0]?.clientMatches).toEqual([
      { id: 'client-1', name: 'Shiftwave, Inc.' },
    ]);
  });

  it('reuses the tenant cache instead of calling NewsCatcher again', async () => {
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ articles: [articleFixture()] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new NewsCatcherDashboardService(
      prismaWithClients([client({ id: 'client-1', name: 'RTX' })]),
    );

    const first = await service.getDashboard('tenant-1');
    const second = await service.getDashboard('tenant-1');

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a provider key instead of breaking the dashboard', async () => {
    delete process.env.NEWSCATCHER_API_KEY;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new NewsCatcherDashboardService(
      prismaWithClients([client({ id: 'client-1', name: 'RTX' })]),
    );

    const result = await service.getDashboard('tenant-1');

    expect(result).toMatchObject({
      available: false,
      provider: 'newscatcher',
      reason: 'not_configured',
      items: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
