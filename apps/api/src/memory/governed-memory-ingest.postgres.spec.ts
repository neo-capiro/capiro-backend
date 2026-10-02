import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Client } from 'pg';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContextStore } from '../tenant/tenant-context.store.js';
import type { MeetingNotesCryptoService } from '../engagement/meeting-notes-crypto.service.js';
import type { MemoryStoreService } from './memory-store.service.js';
import type { StrictMemoryProjectorService } from './strict-memory-projector.service.js';
import { exactProjectionIdempotencyKey } from './exact-memory-cleanup-outbox.service.js';
import { GovernedMemoryIngestService } from './governed-memory-ingest.service.js';

// Explicit opt-in only. Never use DATABASE_URL or shared database credentials.
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
const postgresSuite = configPath ? describe : describe.skip;

postgresSuite('governed fast-path outbox with a real non-owner PostgreSQL role', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `meri_ingest_${suffix}`;
  const role = `meri_ingest_role_${suffix}`;
  const tenant = randomUUID();
  const foreignTenant = randomUUID();
  const clio = randomUUID();
  const item = randomUUID();
  const job = randomUUID();
  const otherJob = randomUUID();
  const version = '2026-10-02T12:00:00.000Z';
  const hash = 'a'.repeat(64);
  const key = exactProjectionIdempotencyKey(clio, version, hash);
  let owner: Client;
  let app: Client;
  let ownerConnected = false;
  let appConnected = false;
  let schemaCreated = false;
  let roleCreated = false;
  let service: GovernedMemoryIngestService;
  const projected = jest.fn();
  const scopes: string[] = [];

  beforeAll(async () => {
    if (!isAbsolute(configPath!)) throw new Error('Explicit absolute disposable config required');
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(readFileSync(configPath!, 'utf8'));
    } catch {
      throw new Error('Invalid disposable PostgreSQL configuration');
    }
    if (
      config.host !== '127.0.0.1' ||
      config.port !== 55433 ||
      config.scope !== 'owned local disposable test cluster; no AWS connection' ||
      !['user', 'password', 'database', 'dataDirectory'].every(
        (k) => typeof config[k] === 'string' && config[k],
      ) ||
      !isAbsolute(config.dataDirectory as string)
    )
      throw new Error('Unqualified PostgreSQL target');
    const connection = {
      host: '127.0.0.1',
      port: 55433,
      user: config.user as string,
      password: config.password as string,
      database: config.database as string,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    };
    owner = new Client(connection);
    app = new Client(connection);
    await owner.connect();
    ownerConnected = true;
    const actual = (
      await owner.query(
        "SELECT current_user=$1 AS owner_matches,host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('data_directory') AS directory",
        [config.user],
      )
    ).rows[0];
    expect(actual.owner_matches).toBe(true);
    expect(actual.host).toBe('127.0.0.1');
    expect(actual.port).toBe(55433);
    expect(actual.directory.replaceAll('\\', '/')).toBe(
      (config.dataDirectory as string).replaceAll('\\', '/'),
    );
    await owner.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    roleCreated = true;
    await owner.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await owner.query(`SET search_path TO "${schema}"`);
    await owner.query(`CREATE TABLE memory_cleanup_outbox (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, memory_item_id uuid, clio_memory_id uuid,
      operation text NOT NULL, idempotency_key text NOT NULL, expected_source_version timestamptz,
      expected_content_hash text, status text NOT NULL, completed_at timestamptz, superseded_at timestamptz,
      last_error text, lease_owner text, lease_expires_at timestamptz, created_at timestamptz DEFAULT now());
      ALTER TABLE memory_cleanup_outbox ENABLE ROW LEVEL SECURITY;
      ALTER TABLE memory_cleanup_outbox FORCE ROW LEVEL SECURITY;
      CREATE POLICY memory_cleanup_outbox_tenant_isolation ON memory_cleanup_outbox
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
      GRANT USAGE ON SCHEMA "${schema}" TO "${role}";
      GRANT SELECT,UPDATE ON memory_cleanup_outbox TO "${role}"`);
    await owner.query(
      `INSERT INTO memory_cleanup_outbox(id,tenant_id,memory_item_id,clio_memory_id,operation,idempotency_key,expected_source_version,expected_content_hash,status)
      VALUES($1,$2,$3,$4,'index_memory_item',$5,$6,$7,'pending'),($8,$9,$3,$4,'index_memory_item',$5,$6,$7,'pending')`,
      [job, tenant, item, clio, key, version, hash, otherJob, foreignTenant],
    );
    await app.connect();
    appConnected = true;
    await app.query(`SET search_path TO "${schema}"`);
    await app.query(`SET ROLE "${role}"`);
    expect(
      (await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
        .rows[0],
    ).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(
      (
        await app.query(
          "SELECT pg_get_userbyid(relowner)=current_user AS owns FROM pg_class WHERE oid='memory_cleanup_outbox'::regclass",
        )
      ).rows[0].owns,
    ).toBe(false);
    const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.reduce(
        (text, segment, index) => text + (index ? `$${index}` : '') + segment,
        '',
      );
      return app.query(sql, values);
    };
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        (await query(strings, ...values)).rows,
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        (await query(strings, ...values)).rowCount,
    };
    const prisma = {
      withTenant: async <T>(tenantId: string, work: (port: typeof tx) => Promise<T>) => {
        scopes.push(tenantId);
        await app.query('BEGIN');
        try {
          await app.query("SELECT set_config('app.current_tenant',$1,true)", [tenantId]);
          const value = await work(tx);
          await app.query('COMMIT');
          return value;
        } catch (error) {
          await app.query('ROLLBACK');
          throw error;
        }
      },
      withSystem: () => {
        throw new Error('Outbox must not use system-only scope');
      },
    } as unknown as PrismaService;
    projected.mockImplementation(
      async (tenantId: string, clioMemoryId: string, expected: Record<string, unknown>) => ({
        outcome: 'projected',
        tenantId,
        clioMemoryId,
        ...expected,
        embeddingRequired: true,
      }),
    );
    service = new GovernedMemoryIngestService(
      prisma,
      {} as MemoryStoreService,
      {} as TenantContextStore,
      {} as MeetingNotesCryptoService,
      { projectClioMemoryStrict: projected } as unknown as StrictMemoryProjectorService,
    );
  });

  afterAll(async () => {
    if (appConnected) await app.end();
    if (!ownerConnected) return;
    try {
      if (
        !/^meri_ingest_[a-f0-9]{32}$/.test(schema) ||
        !/^meri_ingest_role_[a-f0-9]{32}$/.test(role)
      )
        throw new Error('Invalid owned cleanup identity');
      if (schemaCreated) await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
      if (roleCreated) await owner.query(`DROP ROLE "${role}"`);
      expect(
        (
          await owner.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1', [
            schema,
          ])
        ).rows[0].n,
      ).toBe(0);
      expect(
        (await owner.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1', [role]))
          .rows[0].n,
      ).toBe(0);
    } finally {
      await owner.end();
    }
  });

  test('system-only scope cannot see the queued owned job on a fresh connection', async () => {
    await app.query('BEGIN READ ONLY');
    await app.query("SELECT set_config('app.bypass_rls','on',true)");
    expect(
      (
        await app.query(
          'SELECT id FROM memory_cleanup_outbox WHERE tenant_id=$1 AND clio_memory_id=$2',
          [tenant, clio],
        )
      ).rows,
    ).toEqual([]);
    await app.query('ROLLBACK');
  });

  test('actual service loads and completes the exact tenant job without changing another tenant', async () => {
    const otherBefore = (
      await owner.query('SELECT * FROM memory_cleanup_outbox WHERE id=$1', [otherJob])
    ).rows[0];
    await service.projectClioMemory(tenant, clio, {
      id: job,
      memoryItemId: item,
      sourceVersion: version,
      contentHash: hash,
      idempotencyKey: key,
    });
    expect(scopes).toEqual([tenant, tenant]);
    expect(projected).toHaveBeenCalledWith(tenant, clio, {
      sourceVersion: version,
      contentHash: hash,
      memoryItemId: item,
      idempotencyKey: key,
    });
    expect(
      (
        await owner.query('SELECT status,completed_at FROM memory_cleanup_outbox WHERE id=$1', [
          job,
        ])
      ).rows[0],
    ).toEqual({ status: 'completed', completed_at: expect.any(Date) });
    expect(
      (await owner.query('SELECT * FROM memory_cleanup_outbox WHERE id=$1', [otherJob])).rows[0],
    ).toEqual(otherBefore);
  });

  test('a newer pending job cannot replace the admitted job before provider dispatch', async () => {
    const newerVersion = '2026-10-02T12:01:00.000Z';
    const newerHash = 'b'.repeat(64);
    await owner.query(
      `INSERT INTO memory_cleanup_outbox(id,tenant_id,memory_item_id,clio_memory_id,operation,idempotency_key,expected_source_version,expected_content_hash,status)
      VALUES($1,$2,$3,$4,'index_memory_item',$5,$6,$7,'pending')`,
      [
        randomUUID(),
        tenant,
        item,
        clio,
        exactProjectionIdempotencyKey(clio, newerVersion, newerHash),
        newerVersion,
        newerHash,
      ],
    );
    const before = (await owner.query('SELECT * FROM memory_cleanup_outbox ORDER BY id')).rows;
    const calls = projected.mock.calls.length;
    await expect(
      service.projectClioMemory(tenant, clio, {
        id: job,
        memoryItemId: item,
        sourceVersion: version,
        contentHash: hash,
        idempotencyKey: key,
      }),
    ).rejects.toThrow('memory_projection_exact_job_changed');
    expect(projected.mock.calls).toHaveLength(calls);
    expect((await owner.query('SELECT * FROM memory_cleanup_outbox ORDER BY id')).rows).toEqual(
      before,
    );
  });

  test('missing or wrong tenant scope cannot project or complete any job; pooled empty scope reproduces 22P02', async () => {
    const before = (await owner.query('SELECT * FROM memory_cleanup_outbox ORDER BY id')).rows;
    const calls = projected.mock.calls.length;
    await expect(service.projectClioMemory(randomUUID(), clio)).rejects.toThrow(
      'memory_projection_exact_job_unavailable',
    );
    expect(projected.mock.calls).toHaveLength(calls);
    expect((await owner.query('SELECT * FROM memory_cleanup_outbox ORDER BY id')).rows).toEqual(
      before,
    );
    await app.query('BEGIN READ ONLY');
    await app.query("SELECT set_config('app.bypass_rls','on',true)");
    await expect(
      app.query('SELECT id FROM memory_cleanup_outbox WHERE tenant_id=$1 AND clio_memory_id=$2', [
        foreignTenant,
        clio,
      ]),
    ).rejects.toMatchObject({ code: '22P02' });
    await app.query('ROLLBACK');
  });
});
