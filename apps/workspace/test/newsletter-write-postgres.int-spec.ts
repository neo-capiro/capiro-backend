import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { defaultNewsletterConfig, governmentAffairsNewsletter, parseNewsletterSaveRefusal } from '@capiro/shared/newsletter';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { NewsletterService } from '../src/newsletters/newsletter.service.js';

const repoRoot = resolve(__dirname, '../../..');
const BASE = '21f5fd3ebd2dce585e5c7e1b6267bf5b8f97b70c';
const migration = join(
  repoRoot,
  'apps/workspace/prisma/migrations/20261026070000_newsletter_write_receipt/migration.sql',
);
const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs')) as {
  disposableConfiguration(): { url: string; database: string } | null;
  nativePostgresReadiness(options: { repoRoot: string }): { available: boolean; reason: string };
  createDisposableSchema(options: {
    repoRoot: string;
    coreSchemaPath: string;
    workspaceSchemaPath: string;
  }): Promise<{ url: string; schema: string; cleanup(): Promise<void> }>;
};
const readiness = process.env.A1_NATIVE_PG_URL
  ? helper.nativePostgresReadiness({ repoRoot })
  : { available: false, reason: 'Release has not allocated disposable PG16' };
const native = readiness.available ? describe : describe.skip;
const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  clerkUserId: 'synthetic-newsletter-owner',
};
const foreign = '22222222-2222-4222-8222-222222222222';
const legacy = '33333333-3333-4333-8333-333333333333';
const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function barrier() {
  let enter!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (enter = r)),
    wait = new Promise<void>((r) => (release = r));
  return {
    ready,
    wait,
    enter,
    release,
    arrive: async () => {
      enter();
      await wait;
    },
  };
}
async function reached(gate: ReturnType<typeof barrier>, pending: Promise<unknown>) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      gate.ready,
      pending.then(() => {
        throw new Error('Operation ended before barrier');
      }),
      new Promise<never>(
        (_, reject) => (timer = setTimeout(() => reject(new Error('Barrier not reached')), 8000)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Actual NewsletterService + Prisma SQL. Only the external Core membership/client
 * port is synthetic. No provider, invitation or email calls. All cases remain NOT
 * RUN until Release allocates the exact source and runs this ordinary-role fixture. */
native(`WS15 atomic newsletter write receipts [${readiness.reason}]`, () => {
  let database: Awaited<ReturnType<typeof helper.createDisposableSchema>> | undefined;
  let baseFiles: string | undefined, db: PrismaService | undefined;
  const state = {
    member: true,
    denied: false,
    loseAck: false,
    badReceipt: false,
    deniedAfterRead: false,
  };
  let lockGate: ReturnType<typeof barrier> | undefined,
    secondLock: ReturnType<typeof barrier> | undefined;
  let saveGate: ReturnType<typeof barrier> | undefined;
  let locks = 0,
    saves = 0;
  beforeAll(async () => {
    const config = helper.disposableConfiguration();
    if (!config) throw new Error('Explicit disposable allocation required');
    const { Client } = require(require.resolve('pg', { paths: [join(repoRoot, 'apps/api')] }));
    const check = new Client({
      connectionString: config.url,
      connectionTimeoutMillis: 3000,
      query_timeout: 3000,
      ssl: false,
    });
    try {
      await check.connect();
      const { rows } =
        await check.query(`SELECT current_user AS name,session_user AS session,rolsuper,rolcreatedb,rolcreaterole,
        rolreplication,rolbypassrls,rolinherit,(SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships
        FROM pg_roles r WHERE rolname=current_user`);
      if (
        rows.length !== 1 ||
        rows[0].name !== 'capiro_app' ||
        rows[0].session !== rows[0].name ||
        rows[0].memberships !== 0 ||
        [
          'rolsuper',
          'rolcreatedb',
          'rolcreaterole',
          'rolreplication',
          'rolbypassrls',
          'rolinherit',
        ].some((k) => rows[0][k] !== false)
      )
        throw new Error(
          'Requires existing ordinary capiro_app role, no memberships and six elevated capabilities false',
        );
      const { rows: extensions } = await check.query(
        `SELECT e.extname AS name,n.nspname AS schema FROM pg_extension e
        JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname=ANY($1::text[])`,
        [['citext', 'vector', 'pg_trgm', 'uuid-ossp']],
      );
      if (
        ['citext', 'vector', 'pg_trgm', 'uuid-ossp'].some(
          (name) =>
            !extensions.some(
              (r: { name: string; schema: string }) => r.name === name && r.schema === 'pg_catalog',
            ),
        )
      )
        throw new Error(
          'Release must prepare base extensions in pg_catalog of the new disposable DB',
        );
    } finally {
      await check.end();
    }
    baseFiles = mkdtempSync(join(tmpdir(), 'ws15-base-'));
    for (const [source, target] of [
      ['apps/api/prisma/schema.prisma', 'core.prisma'],
      ['apps/workspace/prisma/schema.prisma', 'workspace.prisma'],
    ])
      writeFileSync(
        join(baseFiles, target!),
        execFileSync('git', ['show', `${BASE}:${source}`], { cwd: repoRoot }),
      );
    database = await helper.createDisposableSchema({
      repoRoot,
      coreSchemaPath: join(baseFiles, 'core.prisma'),
      workspaceSchemaPath: join(baseFiles, 'workspace.prisma'),
    });
    if (!/^a1_native_[a-f0-9]{24}$/.test(database.schema)) throw new Error('Invalid owned schema');
    const seed = new Client({
      connectionString: database.url,
      connectionTimeoutMillis: 3000,
      query_timeout: 10000,
      ssl: false,
    });
    try {
      await seed.connect();
      await seed.query(`SET search_path TO "${database.schema}"`);
      const bound = await seed.query(
        'SELECT current_schema() AS schema,current_database() AS database',
      );
      if (bound.rows[0].schema !== database.schema || bound.rows[0].database !== config.database)
        throw new Error('Wrong raw-session binding');
      await seed.query(
        `INSERT INTO ws_newsletter_document (id,tenant_id,owner_id,name,revision,status,config,design,updated_at)
        VALUES($1::uuid,$2::uuid,$3,'Existing newsletter',1,'draft',$4::jsonb,$5::jsonb,NOW())`,
        [
          legacy,
          ctx.tenantId,
          ctx.clerkUserId,
          JSON.stringify(defaultNewsletterConfig()),
          JSON.stringify(governmentAffairsNewsletter()),
        ],
      );
      await seed.query(readFileSync(migration, 'utf8'));
    } finally {
      await seed.end();
    }
    db = new PrismaService({ datasources: { db: { url: database.url } } });
    await db.$connect();
  }, 240000);
  afterAll(async () => {
    try {
      await db?.$disconnect();
    } finally {
      try {
        await database?.cleanup();
      } finally {
        if (
          baseFiles &&
          dirname(baseFiles) === resolve(tmpdir()) &&
          basename(baseFiles).startsWith('ws15-base-')
        )
          rmSync(baseFiles, { recursive: true });
      }
    }
  }, 60000);
  beforeEach(() => {
    Object.assign(state, {
      member: true,
      denied: false,
      loseAck: false,
      badReceipt: false,
      deniedAfterRead: false,
    });
    lockGate = undefined;
    secondLock = undefined;
    saveGate = undefined;
    locks = 0;
    saves = 0;
  });
  function service() {
    const observed = new Proxy(db!, {
      get(target, key) {
        if (key !== '$transaction') return Reflect.get(target, key, target);
        return async (fn: any, options: any) => {
          let wrote = false;
          const result = await target.$transaction(async (tx) => {
            const port = new Proxy(tx, {
              get(t, k) {
                if (k === '$executeRaw')
                  return async (sql: TemplateStringsArray, ...args: any[]) => {
                    const lock = sql.join('').includes('pg_advisory_xact_lock');
                    const index = lock ? ++locks : 0;
                    if (index === 2) secondLock?.enter();
                    const value = await (t.$executeRaw as any)(sql, ...args);
                    if (index === 1) await lockGate?.arrive();
                    return value;
                  };
                if (k === '$queryRaw')
                  return async (sql: TemplateStringsArray, ...args: any[]) => {
                    const insert = sql.join('').includes('INSERT INTO ws_newsletter_write_receipt');
                    if (insert && state.badReceipt) args[7] = 'invalid-hash';
                    const value = await (t.$queryRaw as any)(sql, ...args);
                    if (insert) wrote = true;
                    if (!insert && state.deniedAfterRead && value.length) state.member = false;
                    return value;
                  };
                if (k === 'wsNewsletterDocument')
                  return new Proxy(t.wsNewsletterDocument, {
                    get(model, m) {
                      if (m !== 'updateMany') return Reflect.get(model, m, model);
                      return async (args: any) => {
                        if (saveGate) {
                          if (++saves === 2) saveGate.enter();
                          await saveGate.wait;
                        }
                        return model.updateMany(args);
                      };
                    },
                  });
                return Reflect.get(t, k, t);
              },
            });
            return fn(port);
          }, options);
          if (wrote && state.loseAck) {
            state.loseAck = false;
            throw new Error('WS15_COMMIT_ACK_LOST');
          }
          return result;
        };
      },
    });
    const source = {
      newsletterMember: async () => (state.member ? { role: 'standard_user' } : null),
      resolveUserId: async () => foreign,
      getClient: async () => ({ wallAllowed: !state.denied }),
    };
    return new NewsletterService(
      observed,
      source as never,
      {} as never,
      { get: () => 'https://example.test' } as never,
    );
  }
  const createInput = () => ({
    requestId: randomUUID(),
    name: 'Synthetic newsletter',
    templateId: 'layout:1',
  });
  async function saveInput(id: string) {
    const row = await db!.wsNewsletterDocument.findUniqueOrThrow({ where: { id } });
    return {
      requestId: randomUUID(),
      revision: row.revision,
      name: 'Saved newsletter',
      design: json(row.design),
      config: json(row.config),
    };
  }
  async function receipts(tenant = ctx.tenantId) {
    return db!.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenant},true)`;
      return tx.$queryRaw<
        Array<{ request_id: string; document_id: string }>
      >`SELECT request_id,document_id FROM ws_newsletter_write_receipt`;
    });
  }

  it('applies the exact forward migration once without inventing legacy write receipts', async () => {
    expect((await db!.wsNewsletterDocument.findUniqueOrThrow({ where: { id: legacy } })).name).toBe(
      'Existing newsletter',
    );
    expect(await receipts()).toHaveLength(0);
    const flags = await db!.$queryRaw<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='ws_newsletter_write_receipt'::regclass`;
    expect(flags).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });
  it('serializes overlapping creates on the real request lock and commits one document/receipt', async () => {
    const input = createInput(),
      first = (lockGate = barrier()),
      second = (secondLock = barrier());
    const a = service().create(ctx, input);
    void a.catch(() => undefined);
    let b: ReturnType<NewsletterService['create']> | undefined;
    try {
      await reached(first, a);
      b = service().create(ctx, input);
      void b.catch(() => undefined);
      await reached(second, Promise.all([a, b]));
    } finally {
      first.release();
      second.release();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
    if (!b) throw new Error('Second create did not start');
    const result = await Promise.all([a, b]);
    expect(result[0]).toEqual(result[1]);
    expect((await receipts()).filter((r) => r.request_id === input.requestId)).toHaveLength(1);
    expect(await db!.wsNewsletterDocument.count({ where: { id: result[0].documentId } })).toBe(1);
  });
  it('recovers a real create commit after acknowledgement loss with a fresh service', async () => {
    const input = createInput();
    state.loseAck = true;
    await expect(service().create(ctx, input)).rejects.toThrow('WS15_COMMIT_ACK_LOST');
    const result = await service().writeReceipt(ctx, input.requestId);
    expect(result?.revision).toBe(1);
    expect(await service().create(ctx, input)).toEqual(result);
    expect((await receipts()).filter((r) => r.request_id === input.requestId)).toHaveLength(1);
  });
  it('refuses changed inputs and cross-operation reuse without another mutation', async () => {
    const input = createInput(),
      result = await service().create(ctx, input);
    await expect(service().create(ctx, { ...input, name: 'Changed' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      service().save(ctx, result.documentId, {
        ...(await saveInput(result.documentId)),
        requestId: input.requestId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await db!.wsNewsletterDocument.findUniqueOrThrow({ where: { id: result.documentId } }))
        .revision,
    ).toBe(1);
  });
  it('retains actual revision CAS when two different save requests overlap', async () => {
    const created = await service().create(ctx, createInput()),
      input = await saveInput(created.documentId),
      other = { ...input, requestId: randomUUID() },
      gate = (saveGate = barrier());
    const pending = Promise.allSettled([
      service().save(ctx, created.documentId, input),
      service().save(ctx, created.documentId, other),
    ]);
    try {
      await reached(gate, pending);
    } finally {
      gate.release();
      await pending;
    }
    const result = await pending;
    expect(saves).toBe(2);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.find((r) => r.status === 'rejected')).toMatchObject({
      reason: expect.any(ConflictException),
    });
    const rejected = result.findIndex((r) => r.status === 'rejected');
    const outcome = result[rejected];
    if (outcome?.status !== 'rejected') throw new Error('Missing native CAS refusal');
    const loser = [input, other][rejected]!;
    const binding = { requestId: loser.requestId, operation: 'save' as const,
      documentId: created.documentId, previousRevision: loser.revision };
    expect(outcome.reason.getResponse()).toEqual({ code: 'NEWSLETTER_SAVE_CAS_REFUSED',
      disposition: 'not_committed', ...binding });
    expect(parseNewsletterSaveRefusal(outcome.reason.getResponse(), binding).ok).toBe(true);
    expect(await service().writeReceipt(ctx, loser.requestId)).toBeNull();
    expect(
      (await db!.wsNewsletterDocument.findUniqueOrThrow({ where: { id: created.documentId } }))
        .revision,
    ).toBe(2);
  });
  it('recovers the original save after real commit loss and a later committed revision', async () => {
    const created = await service().create(ctx, createInput()),
      input = await saveInput(created.documentId);
    state.loseAck = true;
    await expect(service().save(ctx, created.documentId, input)).rejects.toThrow(
      'WS15_COMMIT_ACK_LOST',
    );
    const original = await service().writeReceipt(ctx, input.requestId);
    await service().save(ctx, created.documentId, {
      ...(await saveInput(created.documentId)),
      name: 'Later',
    });
    expect(await service().writeReceipt(ctx, input.requestId)).toEqual(original);
    expect(await service().save(ctx, created.documentId, input)).toEqual(original);
    expect(original).toMatchObject({ revision: 2, previousRevision: 1 });
    expect((await service().get(ctx, created.documentId)).revision).toBe(3);
  });
  it('rolls back both a create and a save when the actual receipt CHECK fails', async () => {
    const input = createInput(),
      before = await db!.wsNewsletterDocument.count();
    state.badReceipt = true;
    await expect(service().create(ctx, input)).rejects.toMatchObject({ code: 'P2010' });
    expect(await db!.wsNewsletterDocument.count()).toBe(before);
    expect(await service().writeReceipt(ctx, input.requestId)).toBeNull();
    state.badReceipt = false;
    const created = await service().create(ctx, createInput()),
      save = await saveInput(created.documentId);
    state.badReceipt = true;
    await expect(service().save(ctx, created.documentId, save)).rejects.toMatchObject({
      code: 'P2010',
    });
    expect(
      (await db!.wsNewsletterDocument.findUniqueOrThrow({ where: { id: created.documentId } }))
        .revision,
    ).toBe(1);
    expect(await service().writeReceipt(ctx, save.requestId)).toBeNull();
  });
  it('keeps the append-only fence after actual document deletion and never resurrects it', async () => {
    const input = createInput(),
      created = await service().create(ctx, input);
    await db!.wsNewsletterDocument.delete({ where: { id: created.documentId } });
    await expect(service().create(ctx, input)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service().writeReceipt(ctx, input.requestId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((await receipts()).filter((r) => r.request_id === input.requestId)).toHaveLength(1);
    expect(await db!.wsNewsletterDocument.count({ where: { id: created.documentId } })).toBe(0);
  });
  it('enforces actor binding and real tenant RLS without a bypass setting', async () => {
    const input = createInput();
    await service().create(ctx, input);
    expect(
      await service().writeReceipt({ ...ctx, clerkUserId: 'synthetic-other' }, input.requestId),
    ).toBeNull();
    expect(await service().writeReceipt({ ...ctx, tenantId: foreign }, input.requestId)).toBeNull();
    expect(await receipts(foreign)).toHaveLength(0);
    expect(await db!.$queryRaw`SELECT request_id FROM ws_newsletter_write_receipt`).toHaveLength(0);
    await expect(
      db!.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${foreign},true)`;
        return tx.$executeRaw`INSERT INTO ws_newsletter_write_receipt(tenant_id,actor_id,request_id,operation,document_id,revision,input_hash,content_hash,source_client_ids)
        VALUES(${ctx.tenantId}::uuid,${ctx.clerkUserId},${randomUUID()}::uuid,'create',${legacy}::uuid,1,${'a'.repeat(64)},${'b'.repeat(64)},ARRAY[]::uuid[])`;
      }),
    ).rejects.toMatchObject({ code: 'P2010' });
  });
  it('rechecks current membership, editor grant and retained source access on readback', async () => {
    const created = await service().create(ctx, createInput()),
      editor = { ...ctx, clerkUserId: 'synthetic-editor' };
    await db!.wsNewsletterReviewer.create({
      data: {
        tenantId: ctx.tenantId,
        documentId: created.documentId,
        userId: editor.clerkUserId,
        role: 'editor',
      },
    });
    const input = await saveInput(created.documentId);
    (input.design as any).sourceClientIds = [foreign];
    await service().save(editor, created.documentId, input);
    state.denied = true;
    await expect(service().writeReceipt(editor, input.requestId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    state.denied = false;
    await db!.wsNewsletterReviewer.deleteMany({
      where: { documentId: created.documentId, userId: editor.clerkUserId },
    });
    await expect(service().writeReceipt(editor, input.requestId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    state.deniedAfterRead = true;
    await expect(service().writeReceipt(ctx, created.requestId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('prevents UPDATE, DELETE and TRUNCATE of committed fences for the ordinary role', async () => {
    const created = await service().create(ctx, createInput());
    for (const sql of [
      'UPDATE ws_newsletter_write_receipt SET input_hash=input_hash',
      'DELETE FROM ws_newsletter_write_receipt',
      'TRUNCATE ws_newsletter_write_receipt',
    ])
      await expect(db!.$executeRawUnsafe(sql)).rejects.toMatchObject({ code: 'P2010' });
    expect(await service().writeReceipt(ctx, created.requestId)).toEqual(created);
    await expect(
      db!.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${ctx.tenantId},true)`;
        return tx.$executeRaw`INSERT INTO ws_newsletter_write_receipt SELECT * FROM ws_newsletter_write_receipt WHERE request_id=${created.requestId}::uuid`;
      }),
    ).rejects.toMatchObject({ code: 'P2010' });
    await expect(
      db!.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${ctx.tenantId},true)`;
        return tx.$executeRaw`INSERT INTO ws_newsletter_write_receipt(tenant_id,actor_id,request_id,operation,document_id,previous_revision,revision,input_hash,content_hash,source_client_ids)
        VALUES(${ctx.tenantId}::uuid,${ctx.clerkUserId},${randomUUID()}::uuid,'save',${legacy}::uuid,NULL,2,${'a'.repeat(64)},${'b'.repeat(64)},ARRAY[]::uuid[])`;
      }),
    ).rejects.toMatchObject({ code: 'P2010' });
  });
});
