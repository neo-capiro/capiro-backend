import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { readMeriPaths } from './meri-graph-paths.js';
import {
  createQualificationDatabase,
  qualificationAdminUrl,
  QUALIFICATION_SCHEMA,
  type QualificationDatabase,
} from '../../test/memory-postgres-qualification/harness.js';
import { installGraphFixture } from '../../test/memory-postgres-qualification/graph-fixture.js';

const adminUrl = qualificationAdminUrl(),
  databaseIt = adminUrl ? it : it.skip;
const id = (group: number, n: number) =>
  `${String(group).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = id(1, 1),
  foreignTenant = id(1, 2),
  actor = id(2, 1),
  otherActor = id(2, 2);
const client = id(3, 1),
  otherClient = id(3, 2),
  walledClient = id(3, 3),
  foreignClient = id(3, 4);
const person = id(4, 1),
  hiddenPerson = id(4, 2),
  memory = id(5, 1);
const context = { tenantId: tenant, userId: actor, role: 'standard_user' } as TenantContext;

describe('current graph paths through PostgreSQL source authorization', () => {
  jest.setTimeout(120000);
  let db: QualificationDatabase | undefined, prisma: PrismaService;
  const retained = process.env.MEMORY_GRAPH_FIXTURE_FILE;
  beforeAll(async () => {
    if (!adminUrl) return;
    if (retained && existsSync(retained)) {
      const saved = JSON.parse(readFileSync(retained, 'utf8'));
      if (!/^meri_memory_qualification_[a-f0-9]{12}$/.test(saved.databaseName))
        throw Error('Unexpected retained graph fixture');
      const url = new URL(adminUrl);
      url.pathname = '/' + saved.databaseName;
      url.searchParams.set('schema', QUALIFICATION_SCHEMA);
      const admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      await admin.$connect();
      db = {
        ...saved,
        admin,
        dispose: async () => {
          await admin.$disconnect();
        },
      };
    } else {
      db = await createQualificationDatabase(adminUrl, false);
      await installGraphFixture(db);
      if (retained)
        writeFileSync(
          retained,
          JSON.stringify({
            databaseName: db.databaseName,
            appUrl: db.appUrl,
            appRole: db.appRole,
            ownerRole: db.ownerRole,
            vectorAvailable: db.vectorAvailable,
          }),
          { mode: 0o600 },
        );
    }
    prisma = new PrismaService({ datasources: { db: { url: db!.appUrl } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.dispose({ preserveDatabase: Boolean(retained) });
  });
  beforeEach(async () => {
    if (!db) return;
    await db.admin.$executeRawUnsafe(
      'TRUNCATE memory_edges, memory_items, tracked_bill, client_people, congress_bill, client_memory_access, clients, users, tenants CASCADE',
    );
    await db.admin.$executeRaw(
      Prisma.sql`INSERT INTO tenants(id) VALUES (${tenant}::uuid),(${foreignTenant}::uuid)`,
    );
    await db.admin.$executeRaw(
      Prisma.sql`INSERT INTO users(id) VALUES (${actor}::uuid),(${otherActor}::uuid)`,
    );
    await db.admin.$executeRaw(Prisma.sql`INSERT INTO clients(id,tenant_id,memory_wall,name) VALUES
      (${client}::uuid,${tenant}::uuid,false,'Selected client'),(${otherClient}::uuid,${tenant}::uuid,false,'Other client'),
      (${walledClient}::uuid,${tenant}::uuid,true,'Walled sentinel'),(${foreignClient}::uuid,${foreignTenant}::uuid,false,'Foreign sentinel')`);
    await db.admin
      .$executeRaw(Prisma.sql`INSERT INTO client_people(id,tenant_id,client_id,name) VALUES
      (${person}::uuid,${tenant}::uuid,${client}::uuid,'Authorized contact'),
      (${hiddenPerson}::uuid,${tenant}::uuid,${otherClient}::uuid,'Other contact'),
      (${id(4, 3)}::uuid,${tenant}::uuid,${walledClient}::uuid,'Walled person sentinel'),
      (${id(4, 4)}::uuid,${foreignTenant}::uuid,${foreignClient}::uuid,'Foreign person sentinel')`);
    await db.admin.$executeRaw(Prisma.sql`INSERT INTO congress_bill(id) VALUES ('119-hr-1')`);
    await db.admin
      .$executeRaw(Prisma.sql`INSERT INTO memory_items(id,tenant_id,client_id,type,slug,title,source,memory_class,memory_authority,memory_scope,governed_status,source_type,source_id,source_content_hash,source_version,approved_by_user_id,approved_at)
      VALUES (${memory}::uuid,${tenant}::uuid,${client}::uuid,'person',${person},'Authorized contact','fixture','client_steering','client_approved','client','active','approved_document_edit','source-1','synthetic-hash','v1',${actor}::uuid,now())`);
    await db.admin
      .$executeRaw(Prisma.sql`INSERT INTO memory_edges(tenant_id,src_item_id,relation,dst_type,dst_slug)
      VALUES (${tenant}::uuid,${memory}::uuid,'mentions','bill','119-hr-1')`);
  });
  const read = (to: string, clientId?: string) =>
    readMeriPaths(
      prisma,
      context,
      { to, depth: 3, ...(clientId ? { clientId } : {}) },
      'legacy',
      () => Date.parse('2026-10-29T09:00:00.000Z'),
    );
  databaseIt(
    'returns direct canonical references and a separate governed-memory mention',
    async () => {
      const out = await read('bill:119-hr-1', client);
      expect(out.paths).toHaveLength(1);
      expect(out.paths[0]?.basis).toBe('thematic');
      expect(out.paths[0]?.edges.map((edge) => edge.sources)).toEqual([
        [{ kind: 'client_person', id: person }],
        [{ kind: 'memory_item', id: memory }],
      ]);
      expect(out.coverage.state).toBe('complete');
      expect(out.coverage.clientsSearched).toBe(1);
      expect(out.temporalCoverage).toBe('current_only');
      expect(Number.isFinite(Date.parse(out.observedAt))).toBe(true);
      const expected = JSON.parse(
        readFileSync(join(__dirname, 'meri-graph-paths.wire.json'), 'utf8'),
      );
      expect(out).toEqual(expected.response);
      const general = {
        request: { to: 'bill:119-hr-1', depth: 3 },
        response: await read('bill:119-hr-1'),
      };
      expect(general).toEqual(expected.general);
      if (process.env.MEMORY_GRAPH_WIRE_FILE)
        writeFileSync(
          process.env.MEMORY_GRAPH_WIRE_FILE,
          JSON.stringify(
            {
              synthetic: true,
              request: { to: 'bill:119-hr-1', depth: 3, clientId: client },
              response: out,
              general,
            },
            null,
            2,
          ) + '\n',
        );
    },
  );
  databaseIt(
    'applies selected-client scope before loading target labels or source edges',
    async () => {
      const hidden = await read(`person:${hiddenPerson}`, client),
        missing = await read('person:absent', client);
      expect(hidden.paths).toEqual([]);
      expect(hidden.coverage).toEqual(missing.coverage);
      expect(hidden.summary).toEqual(missing.summary);
      expect(JSON.stringify(hidden)).not.toContain('Other contact');
    },
  );
  databaseIt(
    'filters tenant and wall boundaries in General and rejects inaccessible selected clients',
    async () => {
      const all = await read(`person:${person}`);
      expect(all.coverage.clientsSearched).toBe(2);
      for (const selected of [walledClient, foreignClient, id(3, 999)])
        await expect(read('bill:119-hr-1', selected)).rejects.toThrow(
          'client scope is unavailable',
        );
      const walled = await read(`person:${id(4, 3)}`),
        foreign = await read(`person:${id(4, 4)}`);
      expect(walled.paths).toEqual([]);
      expect(foreign.paths).toEqual([]);
      expect(JSON.stringify(all)).not.toMatch(/Walled|Foreign/);
    },
  );
  databaseIt('uses current wall grants on each read and fails after revocation', async () => {
    await db!.admin.$executeRaw(
      Prisma.sql`UPDATE clients SET memory_wall=true WHERE id=${client}::uuid`,
    );
    await db!.admin.$executeRaw(
      Prisma.sql`INSERT INTO client_memory_access(tenant_id,client_id,user_id,granted_by) VALUES (${tenant}::uuid,${client}::uuid,${actor}::uuid,${actor}::uuid)`,
    );
    expect((await read('bill:119-hr-1', client)).paths).toHaveLength(1);
    await db!.admin.$executeRaw(
      Prisma.sql`DELETE FROM client_memory_access WHERE client_id=${client}::uuid`,
    );
    await expect(read('bill:119-hr-1', client)).rejects.toThrow('client scope is unavailable');
  });
  databaseIt('excludes another actor private note and admits only the owner note', async () => {
    await db!.admin.$executeRaw(
      Prisma.sql`UPDATE memory_items SET visibility='user',owner_user_id=${otherActor}::uuid WHERE id=${memory}::uuid`,
    );
    expect((await read('bill:119-hr-1', client)).paths).toEqual([]);
    await db!.admin.$executeRaw(
      Prisma.sql`UPDATE memory_items SET owner_user_id=${actor}::uuid WHERE id=${memory}::uuid`,
    );
    expect((await read('bill:119-hr-1', client)).paths).toHaveLength(1);
  });
  databaseIt(
    'suppresses revoked and expired memory while retaining the direct source relationship',
    async () => {
      await db!.admin.$executeRaw(
        Prisma.sql`UPDATE memory_items SET status='revoked',revoked_at=now() WHERE id=${memory}::uuid`,
      );
      expect((await read('bill:119-hr-1', client)).paths).toEqual([]);
      expect((await read(`person:${person}`, client)).paths[0]?.basis).toBe('direct');
      await db!.admin.$executeRaw(
        Prisma.sql`UPDATE memory_items SET status='active',revoked_at=NULL,expires_at=now()-interval '1 second' WHERE id=${memory}::uuid`,
      );
      expect((await read('bill:119-hr-1', client)).paths).toEqual([]);
    },
  );
  databaseIt(
    'reports a bounded client projection as partial and still resolves an exact selected client beyond the page',
    async () => {
      for (let n = 10; n < 215; n++)
        await db!.admin.$executeRaw(
          Prisma.sql`INSERT INTO clients(id,tenant_id,memory_wall,name) VALUES (${id(3, n)}::uuid,${tenant}::uuid,false,'Synthetic bounded client')`,
        );
      const out = await read('person:absent');
      expect(out.coverage.clientsSearched).toBe(200);
      expect(out.coverage.state).toBe('partial');
      expect(out.coverage.reasons).toContain('clients_row_limit');
      const selected = await read(`client:${id(3, 214)}`, id(3, 214));
      expect(selected.paths).toHaveLength(1);
      expect(selected.coverage.state).toBe('complete');
    },
  );
  databaseIt(
    'propagates an unavailable cache instead of claiming the baseline is complete',
    async () => {
      await expect(
        readMeriPaths(prisma, context, { to: `person:${person}`, clientId: client }, 'cache'),
      ).rejects.toThrow('unavailable or incomplete');
    },
  );
});
