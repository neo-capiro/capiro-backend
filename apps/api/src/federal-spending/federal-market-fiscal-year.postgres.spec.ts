import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { TenantContext } from '@capiro/shared';
import { Client, types as pgTypes } from 'pg';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { FederalMarketGeographyService } from './federal-market-geography.service.js';
import { FederalMarketMeriToolsService } from './federal-market-meri-tools.service.js';
import { FederalMarketService } from './federal-market.service.js';
import type { FederalContractMarketRow, FederalMarketPage } from './federal-market.types.js';

/**
 * Opt in with MERI_FEDERAL_MARKET_PG_CONFIG pointing to an absolute JSON path.
 * Required private configuration: host, port, user, password, database,
 * dataDirectory, and scope: "owned local disposable test cluster; no AWS connection".
 * Only 127.0.0.1:55433 is admitted. This never falls back to DATABASE_URL or
 * shared credentials. All fixture DDL/data is rolled back in one transaction.
 */
const configPath = process.env.MERI_FEDERAL_MARKET_PG_CONFIG;
const postgresSuite = configPath ? describe : describe.skip;

interface DisposableConfig {
  host: '127.0.0.1';
  port: 55433;
  user: string;
  password: string;
  database: string;
  dataDirectory: string;
  scope: 'owned local disposable test cluster; no AWS connection';
}

function readDisposableConfig(path: string): DisposableConfig {
  if (!isAbsolute(path)) throw new Error('Disposable PostgreSQL config path must be absolute');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Malformed JSON errors can contain source snippets, including credentials.
    throw new Error('Disposable PostgreSQL config must be readable valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Disposable PostgreSQL config must be an object');
  }
  const config = parsed as Record<string, unknown>;
  if (
    config.host !== '127.0.0.1' ||
    config.port !== 55433 ||
    config.scope !== 'owned local disposable test cluster; no AWS connection'
  ) {
    throw new Error('Only the explicitly marked disposable loopback PostgreSQL target is allowed');
  }
  for (const key of ['user', 'password', 'database', 'dataDirectory']) {
    if (typeof config[key] !== 'string' || config[key].length === 0) {
      throw new Error('Disposable PostgreSQL config is missing required private fields');
    }
  }
  if (!isAbsolute(config.dataDirectory as string)) {
    throw new Error('Disposable PostgreSQL expected data directory must be absolute');
  }
  return config as unknown as DisposableConfig;
}

type ContractPage = FederalMarketPage<FederalContractMarketRow>;
interface ClientLookup {
  where: { id: string; status: { not: string }; profileStatus: string };
}
interface MappingLookup {
  where: { clientId: string; confirmed: boolean; reviewStatus: string; rollUpAwards: boolean };
}

postgresSuite('Federal Market fiscal year and paging against disposable PostgreSQL', () => {
  const schema = `meri_fy_probe_${randomUUID().replaceAll('-', '')}`;
  if (!/^meri_fy_probe_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid owned schema');
  const tenantId = 'meri-fy-disposable-tenant';
  const clientId = 'meri-fy-disposable-client';
  const uei = 'QM4EZDV15JL8';
  const id = (suffix: number) => `11111111-1111-4111-8111-${String(suffix).padStart(12, '0')}`;
  const rows = [
    { id: id(1), date: '2025-09-30', uei },
    { id: id(2), date: '2025-10-01', uei },
    { id: id(3), date: '2026-06-15', uei },
    { id: id(4), date: '2026-06-15', uei },
    { id: id(5), date: '2026-09-30', uei },
    { id: id(6), date: '2026-10-01', uei },
    { id: id(7), date: null, uei },
    { id: id(8), date: '2026-08-01', uei: 'ZZZZZZZZZZZZ' },
  ];
  let db: Client | undefined;
  let service: FederalMarketService;
  let tools: FederalMarketMeriToolsService;
  let connected = false;
  let transactionOpen = false;
  let schemaCreated = false;

  beforeAll(async () => {
    const config = readDisposableConfig(configPath!);
    db = new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      // Prisma represents @db.Date as UTC Date objects. Keep the actual DATE
      // column semantics while matching Prisma's result transport type.
      types: {
        getTypeParser: (oid, format) =>
          oid === 1082
            ? (value: string) => new Date(`${value}T00:00:00.000Z`)
            : pgTypes.getTypeParser(oid, format),
      },
    });
    try {
      await db.connect();
      connected = true;
    } catch {
      throw new Error('Could not connect to the explicit disposable PostgreSQL target');
    }
    const actual = (
      await db.query<{
        owner_matches: boolean;
        address: string;
        port: number;
        data_directory: string;
      }>(
        'SELECT current_user = $1 AS owner_matches, host(inet_server_addr()) AS address, ' +
          'inet_server_port() AS port, current_setting($2) AS data_directory',
        [config.user, 'data_directory'],
      )
    ).rows[0]!;
    // Assert booleans, not credential-bearing configuration values.
    expect({
      ownerMatches: actual.owner_matches,
      loopbackOnly: actual.address === config.host,
      portMatches: actual.port === config.port,
      dataDirectoryMatches:
        actual.data_directory.replaceAll('\\', '/') === config.dataDirectory.replaceAll('\\', '/'),
    }).toEqual({
      ownerMatches: true,
      loopbackOnly: true,
      portMatches: true,
      dataDirectoryMatches: true,
    });
    await db.query('BEGIN');
    transactionOpen = true;
    await db.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    // Exclude public and every pre-existing application schema.
    await db.query(`SET LOCAL search_path TO "${schema}"`);
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    expect(
      (await db.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]?.schema,
    ).toBe(schema);
    await db.query(`CREATE TABLE federal_award (
      id uuid PRIMARY KEY, award_unique_id text, contractor_name text,
      recipient_uei text, awarding_agency text, amount numeric,
      description text, action_date date, latest_action_date date,
      base_award_signed_date date, source_last_modified_date date,
      pop_start_date date, pop_end_date date,
      pop_state text, pop_congressional_district text, last_synced_at timestamptz
    )`);
    await db.query(
      'CREATE TABLE probe_client (id text PRIMARY KEY, tenant_id text, uei text, status text, profile_status text)',
    );
    await db.query('INSERT INTO probe_client VALUES ($1,$2,$3,$4,$5)', [
      clientId,
      tenantId,
      uei,
      'active',
      'ACTIVE',
    ]);
    for (const row of rows) {
      await db.query(
        `INSERT INTO federal_award
        (id, award_unique_id, contractor_name, recipient_uei, awarding_agency,
         amount, description, action_date, pop_state, pop_congressional_district, last_synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          row.id,
          `synthetic-award-${row.id}`,
          'Identical Synthetic Name',
          row.uei,
          'Synthetic Agency',
          100,
          'Disposable FY boundary fixture',
          row.date,
          'VA',
          '10',
          '2026-09-30T12:00:00.000Z',
        ],
      );
    }
    const client = db;
    const identityPort = (requestedTenant: string) => ({
      client: {
        findFirst: async (args: ClientLookup) => {
          expect(args.where.status).toEqual({ not: 'archived' });
          expect(args.where.profileStatus).toBe('ACTIVE');
          return (
            (
              await client.query<{ id: string; uei: string }>(
                'SELECT id, uei FROM probe_client WHERE id = $1 AND tenant_id = $2 ' +
                  'AND status <> $3 AND profile_status = $4',
                [args.where.id, requestedTenant, args.where.status.not, args.where.profileStatus],
              )
            ).rows[0] ?? null
          );
        },
      },
      clientIntelMapping: {
        findMany: async (args: MappingLookup) => {
          expect(args.where).toMatchObject({
            clientId,
            confirmed: true,
            reviewStatus: 'confirmed',
            rollUpAwards: true,
          });
          return [];
        },
      },
    });
    const prisma = {
      $queryRaw: async (sql: { text: string; values: unknown[] }) => {
        expect(sql.text.trimStart()).toMatch(/^SELECT\b/);
        expect(sql.text).toContain('FROM federal_award');
        // Execute the real service's SQL and bound values unchanged.
        return (await client.query(sql.text, sql.values)).rows;
      },
      withTenant: async <T>(
        requestedTenant: string,
        run: (tx: ReturnType<typeof identityPort>) => Promise<T>,
      ): Promise<T> => run(identityPort(requestedTenant)),
    };
    service = new FederalMarketService(prisma as unknown as PrismaService);
    tools = new FederalMarketMeriToolsService(service, {} as FederalMarketGeographyService);
  }, 15000);

  afterAll(async () => {
    try {
      if (connected && db && transactionOpen) {
        await db.query('ROLLBACK');
        transactionOpen = false;
        if (schemaCreated) {
          expect(
            (
              await db.query<{ existing: string | null }>(
                'SELECT to_regnamespace($1) AS existing',
                [schema],
              )
            ).rows[0]?.existing,
          ).toBeNull();
        }
      }
    } finally {
      if (db) await db.end();
    }
  }, 10000);

  const itemIds = (result: ContractPage) => result.items.map((row) => row.id);

  test('FY2026 filters actual count and rows at both October boundaries and excludes null dates', async () => {
    const result = await service.listContracts(tenantId, { fiscalYear: 2026 });
    expect(result.total).toBe(5);
    expect(itemIds(result)).toEqual([id(5), id(8), id(4), id(3), id(2)]);
    expect(result.items.map((row) => row.actionDate)).toContain('2025-10-01T00:00:00.000Z');
    expect(result.items.map((row) => row.actionDate)).toContain('2026-09-30T00:00:00.000Z');
  });

  test('explicit dates intersect fiscal-year boundaries rather than replacing them', async () => {
    const result = await service.listContracts(tenantId, {
      fiscalYear: 2026,
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30T23:59:59.999Z',
    });
    expect(result.total).toBe(2);
    expect(itemIds(result)).toEqual([id(4), id(3)]);
    const outside = await service.listContracts(tenantId, {
      fiscalYear: 2026,
      dateFrom: '2026-10-01',
      dateTo: '2026-10-02',
    });
    expect(outside.total).toBe(0);
    expect(outside.items).toEqual([]);
  });

  test('FY pages retain count and return distinct deterministic rows including equal-date ties', async () => {
    const pages: ContractPage[] = [];
    for (const page of [1, 2, 3]) {
      pages.push(await service.listContracts(tenantId, { fiscalYear: 2026, page, pageSize: 2 }));
    }
    expect(pages.map((page) => page.total)).toEqual([5, 5, 5]);
    expect(pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(pages.map(itemIds)).toEqual([[id(5), id(8)], [id(4), id(3)], [id(2)]]);
    expect(new Set(pages.flatMap(itemIds)).size).toBe(5);
  });

  test('without FY filter the null-date record is retained and ordered last', async () => {
    const result = await service.listContracts(tenantId, {});
    expect(result.total).toBe(8);
    expect(itemIds(result)).toEqual([id(6), id(5), id(8), id(4), id(3), id(2), id(1), id(7)]);
    expect(result.items.at(-1)?.actionDate).toBeNull();
  });

  test('current client scope intersects exact UEI with FY and rejects same-name foreign UEI', async () => {
    const result = await service.listContracts(tenantId, { clientId, fiscalYear: 2026 });
    expect(result.total).toBe(4);
    expect(itemIds(result)).toEqual([id(5), id(4), id(3), id(2)]);
    expect(result.items.every((row) => row.recipientUei === uei)).toBe(true);
    await expect(
      service.listContracts('other-synthetic-tenant', { clientId, fiscalYear: 2026 }),
    ).rejects.toThrow('Client not found');
  });

  test('Meri tool page reaches the real owner SQL and preserves fiscal-year filtering', async () => {
    const ctx = { tenantId, userId: 'synthetic-user' } as TenantContext;
    const one = (await tools.execute(ctx, 'search_federal_contract_awards', {
      fiscalYear: 2026,
      limit: 2,
      page: 1,
    })) as ContractPage;
    const two = (await tools.execute(ctx, 'search_federal_contract_awards', {
      fiscalYear: 2026,
      limit: 2,
      page: 2,
    })) as ContractPage;
    expect(itemIds(one)).toEqual([id(5), id(8)]);
    expect(itemIds(two)).toEqual([id(4), id(3)]);
    expect(one).toMatchObject({ page: 1, total: 5, pageSize: 2 });
    expect(two).toMatchObject({ page: 2, total: 5, pageSize: 2 });
  });
});
