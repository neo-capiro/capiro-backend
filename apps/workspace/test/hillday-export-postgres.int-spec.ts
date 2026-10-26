import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { HillDayDocumentService } from '../src/hillday/hillday-document.service.js';
import { HillDayExportService } from '../src/hillday/hillday-export.service.js';
import type { HillDayDocumentView } from '../src/hillday/hillday.types.js';

const repoRoot = resolve(__dirname, '../../..');
const BASE = 'dd03bc328f1aa3244aa7ea916202942fbfd57004';
const migration = join(repoRoot, 'apps/workspace/prisma/migrations/20261026060000_hillday_export_request/migration.sql');
const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs')) as {
  disposableConfiguration(): { url: string; database: string } | null;
  nativePostgresReadiness(options: { repoRoot: string }): { available: boolean; reason: string };
  createDisposableSchema(options: { repoRoot: string; coreSchemaPath: string; workspaceSchemaPath: string }): Promise<{ url: string; schema: string; cleanup(): Promise<void> }>;
};
// No default DATABASE_URL, connection or readiness probe when not allocated.
const readiness = process.env.A1_NATIVE_PG_URL ? helper.nativePostgresReadiness({ repoRoot }) : { available: false, reason: 'Release has not allocated disposable PG16' };
const native = readiness.available ? describe : describe.skip;
const ids = {
  tenant: '00000000-0000-4000-8000-0000000000a1',
  client: '00000000-0000-4000-8000-0000000000b1',
  document: '00000000-0000-4000-8000-0000000000c1',
  otherDocument: '00000000-0000-4000-8000-0000000000c2',
  legacy: '00000000-0000-4000-8000-0000000000d1',
  request: '00000000-0000-4000-8000-0000000000e1',
  rollback: '00000000-0000-4000-8000-0000000000e2',
};
const actor = 'synthetic-ws12-owner';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function barrier() {
  let signal!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { signal = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, arrive: async () => { signal(); await waiting; } };
}
async function reached(gate: ReturnType<typeof barrier>, operation: Promise<unknown>) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([gate.ready, operation.then(() => { throw new Error('operation ended before barrier'); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('barrier not reached')), 3000); })]);
  } finally { clearTimeout(timer); }
}

/**
 * Release-only real PG gate: accepted base schema -> legacy export -> exact
 * additive migration ONCE. Real Prisma, document admission/assembly, export
 * service and PDFKit execute. Only the external Core facts/access and Directory
 * branding ports are synthetic. Query extensions run the real SQL first, then
 * model a lost acknowledgement; they never fabricate committed query results.
 */
native(`WS12 export request PostgreSQL16 [${readiness.reason}]`, () => {
  let database: Awaited<ReturnType<typeof helper.createDisposableSchema>> | undefined;
  let baseFiles: string | undefined;
  let db: PrismaService | undefined;
  let previousKey: string | undefined;
  const state = { denied: false, insertAckLost: false, readyAckLost: false, revokeAfterRead: false, renderFails: false };
  let readGate: (() => Promise<void>) | undefined;
  let renderGate: ReturnType<typeof barrier> | undefined;
  const rendered: HillDayDocumentView[] = [];

  beforeAll(async () => {
    previousKey = process.env.WORKSPACE_EXPORT_SIGNING_SECRET;
    process.env.WORKSPACE_EXPORT_SIGNING_SECRET = 'synthetic-ws12-signing';
    const config = helper.disposableConfiguration();
    if (!config) throw new Error('Explicit disposable allocation required');
    const { Client } = require(require.resolve('pg', { paths: [join(repoRoot, 'apps/api')] }));
    const check = new Client({ connectionString: config.url, connectionTimeoutMillis: 3000, query_timeout: 3000, ssl: false });
    try {
      await check.connect();
      const { rows: role } = await check.query(`SELECT current_user AS name, session_user AS session,
        rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit,
        (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships
        FROM pg_roles r WHERE rolname = current_user`);
      if (role.length !== 1 || role[0].name !== role[0].session || role[0].memberships !== 0 ||
        ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','rolinherit'].some(key => role[0][key] !== false))
        throw new Error('WS12 requires an ordinary no-membership role with six elevated capabilities false');
      const { rows } = await check.query(`SELECT e.extname AS name, n.nspname AS schema FROM pg_extension e
        JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = ANY($1::text[])`, [['citext','vector','pg_trgm','uuid-ossp']]);
      if (['citext','vector','pg_trgm','uuid-ossp'].some(name => !rows.some((r: { name: string; schema: string }) => r.name === name && r.schema === 'pg_catalog')))
        throw new Error('Release must prepare base extensions in pg_catalog of its fresh disposable DB');
    } finally { await check.end(); }
    baseFiles = mkdtempSync(join(tmpdir(), 'ws12-base-'));
    for (const [file, into] of [['apps/api/prisma/schema.prisma','core.prisma'],['apps/workspace/prisma/schema.prisma','workspace.prisma']])
      writeFileSync(join(baseFiles, into!), execFileSync('git', ['show', `${BASE}:${file}`], { cwd: repoRoot }));
    database = await helper.createDisposableSchema({ repoRoot, coreSchemaPath: join(baseFiles, 'core.prisma'), workspaceSchemaPath: join(baseFiles, 'workspace.prisma') });
    if (!/^a1_native_[a-f0-9]{24}$/.test(database.schema)) throw new Error('Invalid owned schema');
    const seed = new Client({ connectionString: database.url });
    try {
      await seed.connect();
      // Raw pg ignores Prisma ?schema=, so bind and prove it explicitly.
      await seed.query(`SET search_path TO "${database.schema}"`);
      const bound = await seed.query('SELECT current_schema() AS schema, current_database() AS database');
      if (bound.rows[0].schema !== database.schema || bound.rows[0].database !== config.database) throw new Error('Wrong raw-session binding');
      await seed.query(`INSERT INTO ws_hillday_document
        (id,tenant_id,owner_id,blueprint_slug,client_id,client_name,name,updated_at)
        VALUES ($1::uuid,$2::uuid,$3,'hill-day',$4::uuid,'Synthetic client','Original saved packet',NOW()),
               ($5::uuid,$2::uuid,$3,'hill-day',$4::uuid,'Synthetic client','Other packet',NOW())`,
      [ids.document, ids.tenant, actor, ids.client, ids.otherDocument]);
      await seed.query(`INSERT INTO ws_hillday_export
        (id,tenant_id,document_id,actor_id,status,filename,file,size_bytes)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'ready','legacy.pdf',$5,$6)`,
      [ids.legacy, ids.tenant, ids.document, actor, Buffer.from('%PDF-legacy'), 11]);
      await seed.query(readFileSync(migration, 'utf8'));
    } finally { await seed.end(); }
    db = new PrismaService({ datasources: { db: { url: database.url } } });
    await db.$connect();
  }, 240000);

  afterAll(async () => {
    try { await db?.$disconnect(); } finally {
      try { await database?.cleanup(); } finally {
        if (baseFiles && dirname(baseFiles) === resolve(tmpdir()) && basename(baseFiles).startsWith('ws12-base-')) rmSync(baseFiles, { recursive: true });
        if (previousKey === undefined) delete process.env.WORKSPACE_EXPORT_SIGNING_SECRET;
        else process.env.WORKSPACE_EXPORT_SIGNING_SECRET = previousKey;
      }
    }
  }, 60000);
  beforeEach(async () => {
    Object.assign(state, { denied: false, insertAckLost: false, readyAckLost: false, revokeAfterRead: false, renderFails: false });
    readGate = undefined; renderGate = undefined; rendered.length = 0;
    await db!.wsHillDayExport.deleteMany({ where: { id: { not: ids.legacy } } });
    await db!.wsHillDayDocument.update({ where: { id: ids.document }, data: { name: 'Original saved packet' } });
  });

  function service() {
    const observed = db!.$extends({ query: { wsHillDayExport: {
      async findFirst({ args, query }) { const row = await query(args); await readGate?.(); if (state.revokeAfterRead) state.denied = true; return row; },
      async create({ args, query }) { const row = await query(args); if (state.insertAckLost) throw new Error('WS12_INSERT_ACK_LOST'); return row; },
      async update({ args, query }) { const row = await query(args); if (args.data.status === 'ready' && state.readyAckLost) throw new Error('WS12_READY_ACK_LOST'); return row; },
    } } });
    const source = {
      requireClient: async () => { if (state.denied) throw new NotFoundException('Client unavailable'); return { hasLogo: false }; },
      tenantName: async () => 'Synthetic firm', userDisplays: async () => new Map(),
    };
    const documents = new HillDayDocumentService(db!, source as never, {} as never, {} as never);
    const result = new HillDayExportService(observed as unknown as PrismaService, documents, { branding: async () => ({ ok: false }) } as never);
    const render = result.renderPdf.bind(result);
    result.renderPdf = async (view, options) => {
      rendered.push(view); await renderGate?.arrive();
      if (state.renderFails) throw new Error('WS12_RENDER_FAILED');
      return render(view, options);
    };
    return result;
  }
  const create = (owner = service()) => owner.create(ids.tenant, actor, ids.document, 'letter', ids.request);
  const read = (owner = service()) => owner.getRequest(ids.tenant, ids.document, ids.request, actor);

  it('preserves the pre-migration export without inventing request or digest identity', async () => {
    const row = await db!.wsHillDayExport.findUniqueOrThrow({ where: { id: ids.legacy } });
    expect(Buffer.from(row.file!).toString()).toBe('%PDF-legacy');
    expect(row).toMatchObject({ requestId: null, requestHash: null, contentSha256: null, renderInputSha256: null });
    expect(await service().get(ids.tenant, ids.document, ids.legacy, actor)).toMatchObject({ requestId: null, status: 'ready' });
  });

  it('arbitrates two absent reads with the actual unique index and only one render', async () => {
    const both = barrier(), render = renderGate = barrier(); let reads = 0;
    readGate = async () => { if (++reads <= 2) { if (reads === 2) both.release(); await both.arrive(); } };
    const a = create(), b = create(); void a.catch(() => undefined); void b.catch(() => undefined);
    try {
      await reached(render, Promise.all([a,b]));
      expect(await Promise.race([a,b])).toMatchObject({ requestId: ids.request, status: 'queued' });
      expect(rendered).toHaveLength(1);
      expect(await db!.wsHillDayExport.count({ where: { requestId: ids.request } })).toBe(1);
    } finally { both.release(); render.release(); await Promise.allSettled([a,b]); }
    expect(await read()).toMatchObject({ status: 'ready' });
  });

  it('recovers actual ready commit after acknowledgement loss and saved document edits', async () => {
    state.readyAckLost = true;
    await expect(create()).rejects.toThrow('WS12_READY_ACK_LOST');
    const stored = await db!.wsHillDayExport.findFirstOrThrow({ where: { requestId: ids.request } });
    expect(stored.status).toBe('ready'); expect(stored.contentSha256).toBe(sha(Buffer.from(stored.file!)));
    await db!.wsHillDayDocument.update({ where: { id: ids.document }, data: { name: 'Later saved edit' } });
    const replay = await create();
    expect(replay).toMatchObject({ exportId: stored.id, contentSha256: stored.contentSha256, renderInputSha256: stored.renderInputSha256, filename: stored.filename });
    expect(rendered).toHaveLength(1);
    expect((await read())!.exportId).toBe(stored.id);
  });

  it('preserves an uncertain committed claim without automatic rendering or redispatch', async () => {
    state.insertAckLost = true;
    await expect(create()).rejects.toThrow('WS12_INSERT_ACK_LOST');
    expect(await read()).toMatchObject({ status: 'queued', contentSha256: null, url: null });
    expect(await create()).toMatchObject({ status: 'queued' }); expect(rendered).toHaveLength(0);
    expect(await db!.wsHillDayExport.count({ where: { requestId: ids.request } })).toBe(1);
  });

  it('refuses changed-input replay and foreign actor/document reads through actual document admission', async () => {
    await create();
    await expect(service().create(ids.tenant, actor, ids.document, 'a4', ids.request)).rejects.toMatchObject({ status: 409 });
    await expect(service().create(ids.tenant, actor, ids.otherDocument, 'letter', ids.request)).rejects.toMatchObject({ status: 409 });
    await expect(service().getRequest(ids.tenant, ids.document, ids.request, 'other-actor')).rejects.toMatchObject({ status: 404 });
    expect(await service().getRequest(ids.tenant, ids.otherDocument, ids.request, actor)).toBeNull();
    expect(rendered).toHaveLength(1);
  });

  it('enforces binding/hash constraints with real rollback while preserving historical rows', async () => {
    await expect(db!.$transaction(async tx => {
      await tx.wsHillDayExport.create({ data: { tenantId: ids.tenant, documentId: ids.document, actorId: actor, requestId: ids.rollback, requestHash: 'a'.repeat(64) } });
      await tx.wsHillDayExport.create({ data: { tenantId: ids.tenant, documentId: ids.document, actorId: actor, requestId: ids.request, requestHash: null } });
    })).rejects.toThrow();
    expect(await db!.wsHillDayExport.count({ where: { requestId: ids.rollback } })).toBe(0);
    await expect(db!.wsHillDayExport.create({ data: { tenantId: ids.tenant, documentId: ids.document, actorId: actor, contentSha256: 'invalid' } })).rejects.toThrow();
    expect(await db!.wsHillDayExport.count()).toBe(1);
  });

  it('clears release after access loss observed between real request read and response', async () => {
    await create(); state.revokeAfterRead = true;
    await expect(read()).rejects.toMatchObject({ status: 404 });
    expect(rendered).toHaveLength(1);
  });

  it('keeps a failed renderer result immutable on exact replay', async () => {
    state.renderFails = true;
    expect(await create()).toMatchObject({ status: 'failed', contentSha256: null, url: null });
    state.renderFails = false;
    expect(await create()).toMatchObject({ status: 'failed' }); expect(rendered).toHaveLength(1);
  });
});
