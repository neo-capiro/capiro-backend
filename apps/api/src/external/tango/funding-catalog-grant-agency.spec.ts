import { PrismaClient } from '@prisma/client';
import { FundingCatalogStore } from './funding-catalog.store.js';

const providerGrant = { grant_id: '90000001', title: 'Synthetic refreshed grant', status: 'P' };
function silenceObservationWrites(store: FundingCatalogStore) {
  jest.spyOn(store.observations, 'writeSnapshot').mockResolvedValue(undefined as never);
  jest.spyOn(store.observations, 'proposeLink').mockResolvedValue(undefined as never);
}
function mockStore(existing: { agency: string } | null) {
  const upsert = jest.fn(async () => ({}));
  const store = new FundingCatalogStore({ federalGrant: {
    findUnique: jest.fn(async () => existing), upsert,
  } } as never);
  silenceObservationWrites(store);
  return { store, upsert };
}

describe('grant upsert required create fields', () => {
  test('uses recorded agency for the required create arm without changing omitted update enrichment', async () => {
    const { store, upsert } = mockStore({ agency: 'Recorded Department' });
    await store.grant(providerGrant, true);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ agency: 'Recorded Department' }),
      update: expect.not.objectContaining({ agency: expect.anything() }),
    }));
  });
  test('explicit provider agency still takes precedence', async () => {
    const { store, upsert } = mockStore({ agency: 'Recorded Department' });
    await store.grant({ ...providerGrant, organization: { department_name: 'New Department' } }, true);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ agency: 'New Department' }),
      update: expect.objectContaining({ agency: 'New Department' }),
    }));
  });
  test('new grants without an agency remain refused', async () => {
    const { store, upsert } = mockStore(null);
    await expect(store.grant(providerGrant, true)).rejects.toThrow('New grant has no agency');
    expect(upsert).not.toHaveBeenCalled();
  });
  test('dry-run never upserts an existing partial grant', async () => {
    const { store, upsert } = mockStore({ agency: 'Recorded Department' });
    await store.grant(providerGrant, false);
    expect(upsert).not.toHaveBeenCalled();
  });
});

// Exact task-owned, synthetic loopback fixture only; never generic DATABASE_URL.
const fixtureUrl = 'postgresql://portfolio_qa@127.0.0.1:55492/portfolio_relevance_test?schema=public';
const databaseUrl = process.env.PORTFOLIO_RELEVANCE_TEST_DATABASE_URL;
if (databaseUrl && databaseUrl !== fixtureUrl) throw new Error('Refusing non-fixture grant integration database');
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('grant partial refresh with real Prisma and PostgreSQL', () => {
  let db: PrismaClient;
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await db.$executeRaw`CREATE TABLE IF NOT EXISTS federal_grant (
      id text PRIMARY KEY, title text NOT NULL, agency text NOT NULL, sub_agency text,
      opportunity_number text, category text, funding_instrument text,
      eligibility text[] NOT NULL DEFAULT '{}', cfda_numbers text[] NOT NULL DEFAULT '{}',
      award_ceiling double precision, award_floor double precision, estimated_funding double precision,
      expected_awards integer, open_date date, close_date date, status text,
      description text, url text, synced_at timestamptz NOT NULL DEFAULT now(),
      eligibility_text text, cost_sharing boolean, doc_type text, revision integer,
      response_date_desc text, amendment_count integer, last_updated_at timestamptz,
      raw jsonb, detail_synced_at timestamptz, embedded_content_hash text, embedded_at timestamptz
    )`;
    await db.federalGrant.create({ data: {
      id: providerGrant.grant_id, title: 'Synthetic original grant', agency: 'Recorded Department',
    } });
  }, 30_000);
  afterAll(async () => {
    if (db) {
      await db.federalGrant.deleteMany({ where: { id: providerGrant.grant_id } });
      await db.$disconnect();
    }
  });
  test('a partial provider refresh updates the existing grant rather than failing create validation', async () => {
    const store = new FundingCatalogStore(db);
    // Ancillary observation writes are not this regression; canonical upsert is real.
    silenceObservationWrites(store);
    await expect(store.grant(providerGrant, true)).resolves.toBeUndefined();
    const saved = await db.federalGrant.findUnique({ where: { id: providerGrant.grant_id } });
    expect(saved).toMatchObject({ title: providerGrant.title, agency: 'Recorded Department', status: 'posted' });
    expect(await db.federalGrant.count({ where: { id: providerGrant.grant_id } })).toBe(1);
  });
});
