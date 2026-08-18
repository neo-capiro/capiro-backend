import { describe, expect, test, afterEach, jest } from '@jest/globals';
import { SamEntityEnrichmentService } from './sam-entity.service.js';

/**
 * SAM gov-id enrichment matching guard. These IDs feed procurement/budget-exposure
 * matching, so attaching a WRONG UEI is worse than attaching none — the service
 * must only auto-assign on a single, active, exact-name match and skip anything
 * ambiguous. fetch is mocked; no network.
 */
function makeService(apiKey: string | undefined = 'TESTKEY', enabled = true) {
  const config = {
    get: (k: string) => (k === 'SAM_ENRICHMENT_ENABLED' ? enabled : apiKey),
  } as never;
  return new SamEntityEnrichmentService({} as never, config, {} as never);
}

function entity(opts: {
  name: string;
  uei: string;
  cage?: string | null;
  status?: string;
  state?: string | null;
  dba?: string | null;
  naics?: string[];
}) {
  return {
    entityRegistration: {
      legalBusinessName: opts.name,
      dbaName: opts.dba ?? null,
      ueiSAM: opts.uei,
      cageCode: opts.cage ?? null,
      registrationStatus: opts.status ?? 'Active',
    },
    coreData: { physicalAddress: { stateOrProvinceCode: opts.state ?? null } },
    assertions: {
      goodsAndServices: {
        primaryNaics: opts.naics?.[0] ?? null,
        naicsList: (opts.naics ?? []).map((n) => ({ naicsCode: n })),
        pscList: [{ pscCode: null }],
      },
    },
  };
}

function mockFetch(payload: unknown, ok = true, status = 200) {
  (global as { fetch?: unknown }).fetch = jest.fn(async () => ({
    ok,
    status,
    json: async () => payload,
  })) as never;
}

describe('SamEntityEnrichmentService.normalize', () => {
  const s = makeService();
  test('strips legal suffixes + punctuation, expands &', () => {
    expect(s.normalize('RTX Corporation, Inc.')).toBe('RTX');
    expect(s.normalize('Lockheed Martin Corporation')).toBe('LOCKHEED MARTIN');
    expect(s.normalize('A&B Co')).toBe('A AND B');
  });
  test('does NOT strip ambiguous words (GROUP/HOLDINGS/INTERNATIONAL)', () => {
    expect(s.normalize('Carlyle Group')).toBe('CARLYLE GROUP');
    expect(s.normalize('Acme Widgets International')).toBe('ACME WIDGETS INTERNATIONAL');
  });
});

describe('SamEntityEnrichmentService.lookupGovIds', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  test('returns null when no api key configured', async () => {
    expect(await makeService(undefined).lookupGovIds('Lockheed Martin Corporation')).toBeNull();
  });

  test('kill-switch: SAM_ENRICHMENT_ENABLED=false → null, no fetch', async () => {
    const fetchSpy = jest.fn();
    (global as { fetch?: unknown }).fetch = fetchSpy as never;
    const r = await makeService('TESTKEY', false).lookupGovIds('Lockheed Martin Corporation');
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('single active exact match → returns gov ids', async () => {
    mockFetch({
      entityData: [
        entity({
          name: 'LOCKHEED MARTIN CORPORATION',
          uei: 'KM99JJBNQ9M5',
          cage: '3V1F7',
          state: 'VA',
          naics: ['336411'],
        }),
      ],
    });
    const r = await makeService().lookupGovIds('Lockheed Martin Corporation');
    expect(r?.uei).toBe('KM99JJBNQ9M5');
    expect(r?.cageCode).toBe('3V1F7');
    expect(r?.naicsCodes).toContain('336411');
  });

  test('ambiguous: two distinct UEIs for the same name → null (never guesses)', async () => {
    mockFetch({
      entityData: [
        entity({ name: 'ACME CORPORATION', uei: 'AAAAAAAAAAAA', state: 'VA' }),
        entity({ name: 'ACME CORPORATION', uei: 'BBBBBBBBBBBB', state: 'TX' }),
      ],
    });
    expect(await makeService().lookupGovIds('ACME Corporation')).toBeNull();
  });

  test('state narrows an otherwise-ambiguous match to a single entity', async () => {
    mockFetch({
      entityData: [
        entity({ name: 'ACME CORPORATION', uei: 'AAAAAAAAAAAA', state: 'VA' }),
        entity({ name: 'ACME CORPORATION', uei: 'BBBBBBBBBBBB', state: 'TX' }),
      ],
    });
    const r = await makeService().lookupGovIds('ACME Corporation', 'TX');
    expect(r?.uei).toBe('BBBBBBBBBBBB');
  });

  test('no exact name match (only fuzzy) → null', async () => {
    mockFetch({ entityData: [entity({ name: 'ACME WIDGETS INTERNATIONAL', uei: 'AAAAAAAAAAAA' })] });
    expect(await makeService().lookupGovIds('ACME Corporation')).toBeNull();
  });

  test('inactive registration is ignored', async () => {
    mockFetch({
      entityData: [entity({ name: 'ACME CORPORATION', uei: 'AAAAAAAAAAAA', status: 'Inactive' })],
    });
    expect(await makeService().lookupGovIds('ACME Corporation')).toBeNull();
  });

  test('non-200 response → null (fail-safe)', async () => {
    mockFetch({}, false, 429);
    expect(await makeService().lookupGovIds('Lockheed Martin Corporation')).toBeNull();
  });

  test('malformed UEI is rejected', async () => {
    mockFetch({ entityData: [entity({ name: 'ACME CORPORATION', uei: 'SHORT' })] });
    expect(await makeService().lookupGovIds('ACME Corporation')).toBeNull();
  });
});

describe('SamEntityEnrichmentService.enrichGovIds', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  test('skips the SAM call entirely when all gov-ids are already populated', async () => {
    const fetchSpy = jest.fn();
    (global as { fetch?: unknown }).fetch = fetchSpy as never;
    const prisma = {
      withTenant: async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({
          client: {
            findUnique: async () => ({
              id: 'c1',
              name: 'X',
              uei: 'KM99JJBNQ9M5',
              cageCode: '3V1F7',
              naicsCodes: ['336411'],
              pscCodes: ['R425'],
              intakeData: {},
            }),
          },
        }),
    } as never;
    const s = new SamEntityEnrichmentService(prisma, { get: () => 'K' } as never, {} as never);
    const r = await s.enrichGovIds('t1', 'c1');
    expect(r.filled).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
