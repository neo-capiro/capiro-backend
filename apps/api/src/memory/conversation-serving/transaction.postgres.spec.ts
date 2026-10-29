import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { Prisma } from '@prisma/client';
import { conversationMemoryRetentionFixture } from '../memory-conversation-retention.postgres-fixture.js';
import { ownerRetentionCase } from '../memory-owner-retention.postgres-fixture.js';
import { withMemoryConversationRetention } from './transaction.js';
import type { MemoryRetentionWitness } from './witness.js';
import * as witnessTransport from './witness.js';
import { MemoryCandidateService } from '../memory-candidate.service.js';

const url = process.env.MEMORY_RESTORE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('Core memory restore serving on ordinary-role PostgreSQL', () => {
  let store: Awaited<ReturnType<typeof conversationMemoryRetentionFixture>>;
  let admin: Client;
  let witness: MemoryRetentionWitness;
  beforeAll(async () => {
    store = await conversationMemoryRetentionFixture(url!);
    admin = new Client({ connectionString: url });
    await admin.connect();
    const nativeSource = process.env.MEMORY_RETENTION_NATIVE_SOURCE;
    if (!nativeSource) throw Error('Canonical native migration source required');
    await admin.query('CREATE SCHEMA IF NOT EXISTS meri_conversations');
    // Apply the exact relevant native table declarations, including constraints.
    // The other native SDK/run tables are outside this Core policy fixture.
    for (const [file, table] of [
      ['0001_conversations.sql', 'conversations'],
      ['0010_retention.sql', 'retention_subjects'],
      ['0013_retention_recovery_watermark.sql', 'retention_recovery_watermark'],
    ]) {
      if (
        (await admin.query('SELECT to_regclass($1) present', ['meri_conversations.' + table]))
          .rows[0].present
      )
        continue;
      const source = readFileSync(
        join(nativeSource, 'apps/control/conversations/migrations', file!),
        'utf8',
      );
      const start = source.indexOf('CREATE TABLE meri_conversations.' + table + ' (');
      if (start < 0) throw Error('Native table declaration missing');
      await admin.query(source.slice(start, source.indexOf(';', start) + 1));
    }
    // Existing canonical integration supplies these roles and schema. Recreate
    // those prerequisites only in the guarded task-owned fixture database.
    for (const name of ['meri_product_migrator', 'meri_core_admission_reader']) {
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name])).rowCount)
        await admin.query(`CREATE ROLE ${name} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`);
    }
    await admin.query(`GRANT USAGE ON SCHEMA meri_conversations TO meri_product_migrator,meri_core_admission_reader;
      CREATE SCHEMA IF NOT EXISTS meri_core_authority;
      REVOKE ALL ON SCHEMA meri_core_authority FROM PUBLIC;
      GRANT USAGE ON SCHEMA meri_core_authority TO meri_core_admission_reader,capiro_app;
      ALTER TABLE meri_conversations.conversations OWNER TO meri_product_migrator;
      ALTER TABLE meri_conversations.retention_subjects OWNER TO meri_product_migrator;
      ALTER TABLE meri_conversations.retention_recovery_watermark OWNER TO meri_product_migrator;`);
    const phase = readFileSync(
      join(nativeSource, 'infra/product-preview/first-chat-core-retention-serving.sql'),
      'utf8',
    );
    const body = phase.slice(phase.indexOf('BEGIN;'), phase.lastIndexOf('COMMIT;') + 7);
    // A committed phase may be retried before its outer ledger receipt exists.
    await admin.query(body);
    await admin.query(body);
    await admin.query(
      readFileSync(
        join(
          __dirname,
          '../../../prisma/migrations/20281029200000_memory_restore_serving/migration.sql',
        ),
        'utf8',
      ),
    );
  }, 60000);
  beforeEach(async () => {
    witness = { sequence: 0, entrySha256: null };
    await admin.query(
      'INSERT INTO meri_conversations.retention_recovery_watermark(singleton,sequence,entry_sha256) VALUES(true,0,NULL) ON CONFLICT(singleton) DO UPDATE SET sequence=0,entry_sha256=NULL',
    );
  });
  afterAll(async () => {
    await admin?.end();
    await store?.db.$disconnect();
  });
  const readWitness = async () => ({ ...witness });
  async function fixture() {
    const f = await ownerRetentionCase(store),
      conversationId = randomUUID();
    await store.scoped(f.tenantId, async (tx) => {
      await tx.clioConversation.create({
        data: {
          id: conversationId,
          tenantId: f.tenantId,
          userId: f.userId,
          title: 'Synthetic restored chat',
        },
      });
      await tx.clioConversationBootstrapReceipt.create({
        data: {
          tenantId: f.tenantId,
          actorUserId: f.userId,
          conversationId,
          requestId: randomUUID(),
          scopeKind: 'general',
          clientId: null,
        },
      });
    });
    await admin.query(
      'INSERT INTO meri_conversations.conversations(tenant_id,conversation_id,owner_actor_id,projection,projection_sha256) VALUES($1,$2,$3,$4,$5)',
      [f.tenantId, conversationId, f.userId, '{}', 'a'.repeat(64)],
    );
    const work = <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
      read: () => Promise<MemoryRetentionWitness | null> = readWitness,
    ) =>
      withMemoryConversationRetention(store.prisma, f.tenantId, f.userId, fn, {
        readWitness: read,
      });
    const data = {
      tenantId: f.tenantId,
      proposedBy: f.userId,
      sourceKind: 'explicit_user',
      scope: 'firm',
      payload: { key: 'Synthetic proposed title', value: 'Synthetic proposed content' },
      provenance: { tool: 'meri_memory_review', origin: { kind: 'conversation', conversationId } },
    };
    const candidate = await work((tx) => tx.memoryCandidate.create({ data }));
    return { ...f, conversationId, work, data, candidate };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const count = (f: Fixture) =>
    f.work((tx) => tx.memoryCandidate.count({ where: { tenantId: f.tenantId } }));
  async function suppress(f: Fixture) {
    witness = { sequence: 1, entrySha256: 'b'.repeat(64) };
    await admin.query(
      `INSERT INTO meri_conversations.retention_subjects(tenant_id,conversation_id,owner_actor_id,state,
      suppressed_at,ledger_sequence,entry_sha256,projection,projection_sha256) VALUES($1,$2,$3,'SUPPRESSED',now(),1,$4,$5,$6)`,
      [
        f.tenantId,
        f.conversationId,
        f.userId,
        witness.entrySha256,
        JSON.stringify({ state: 'SUPPRESSED', ledgerSequence: 1 }),
        'c'.repeat(64),
      ],
    );
    await admin.query(
      'UPDATE meri_conversations.retention_recovery_watermark SET sequence=1,entry_sha256=$1',
      [witness.entrySha256],
    );
  }

  it('reads pending content with a current witness and hides restored active Core rows after native suppression', async () => {
    const f = await fixture();
    expect(await count(f)).toBe(1);
    expect(await f.work((tx) => tx.reviewRequest.count({ where: { tenantId: f.tenantId } }))).toBe(
      1,
    );
    await suppress(f);
    // Core still has its old active conversation and exact bootstrap receipt.
    expect(
      await store.scoped(f.tenantId, (tx) =>
        tx.clioConversation.findUnique({ where: { id: f.conversationId } }),
      ),
    ).toMatchObject({ status: 'active' });
    expect(await count(f)).toBe(0);
    expect(await f.work((tx) => tx.reviewRequest.count({ where: { tenantId: f.tenantId } }))).toBe(
      0,
    );
    await expect(
      f.work((tx) => tx.memoryCandidate.create({ data: { ...f.data, status: 'approved' } })),
    ).rejects.toThrow('MEMORY_CONVERSATION_UNAVAILABLE');
  });

  it('guards the actual candidate service and both notification copies, while non-memory reviews remain independent', async () => {
    const f = await fixture();
    const reader = jest
      .spyOn(witnessTransport, 'readMemoryRetentionWitness')
      .mockImplementation(readWitness);
    try {
      const service = new MemoryCandidateService(store.prisma, {} as never, {} as never);
      expect((await service.listPending(f.tenantId, f.userId)).map((row) => row.id)).toEqual([
        f.candidate.id,
      ]);
      await f.work(async (tx) => {
        const review = await tx.reviewRequest.findFirstOrThrow({
          where: { subjectId: f.candidate.id },
        });
        await tx.$executeRaw`INSERT INTO memory_review_in_app_notification(tenant_id,recipient_user_id,review_request_id,candidate_id,event_type,title)
          VALUES(${f.tenantId}::uuid,${f.userId}::uuid,${review.id}::uuid,${f.candidate.id}::uuid,'review_assigned','Synthetic title')`;
        await tx.$executeRaw`INSERT INTO memory_review_notification_outbox(tenant_id,recipient_user_id,review_request_id,candidate_id,event_type,idempotency_key,payload_jsonb)
          VALUES(${f.tenantId}::uuid,${f.userId}::uuid,${review.id}::uuid,${f.candidate.id}::uuid,'review_assigned',${randomUUID()},'{"title":"Synthetic title"}')`;
      });
      const copies = () =>
        f.work(
          (tx) => tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT (SELECT count(*) FROM memory_review_in_app_notification WHERE tenant_id=${f.tenantId}::uuid)
          +(SELECT count(*) FROM memory_review_notification_outbox WHERE tenant_id=${f.tenantId}::uuid) AS n`,
        );
      expect(await copies()).toEqual([{ n: 2n }]);
      await suppress(f);
      expect(await service.listPending(f.tenantId, f.userId)).toEqual([]);
      expect(await copies()).toEqual([{ n: 0n }]);
      reader.mockResolvedValue(null);
      await expect(service.listPending(f.tenantId, f.userId)).rejects.toMatchObject({
        status: 503,
      });
      const independent = await store.scoped(f.tenantId, (tx) =>
        tx.reviewRequest.create({
          data: {
            tenantId: f.tenantId,
            riskTier: 'high',
            surface: 'research',
            subjectType: 'artifact',
            title: 'Synthetic independent review',
            reason: 'Synthetic',
            payload: {},
          },
        }),
      );
      expect(
        await store.scoped(f.tenantId, (tx) =>
          tx.reviewRequest.count({ where: { id: independent.id, surface: { not: 'memory' } } }),
        ),
      ).toBe(1);
    } finally {
      reader.mockRestore();
    }
  });

  it('refuses native owner mismatch and cross-tenant origin even when the Core conversation still matches', async () => {
    const f = await fixture(),
      other = await fixture();
    expect(
      await other.work((tx) => tx.memoryCandidate.count({ where: { id: f.candidate.id } })),
    ).toBe(0);
    await expect(
      other.work((tx) =>
        tx.memoryCandidate.create({ data: { ...other.data, provenance: f.data.provenance } }),
      ),
    ).rejects.toThrow('MEMORY_CONVERSATION_UNAVAILABLE');
    await admin.query(
      'UPDATE meri_conversations.conversations SET owner_actor_id=$1 WHERE tenant_id=$2 AND conversation_id=$3',
      [other.userId, f.tenantId, f.conversationId],
    );
    expect(await count(f)).toBe(0);
    await expect(
      f.work((tx) => tx.memoryCandidate.create({ data: { ...f.data, status: 'approved' } })),
    ).rejects.toThrow('MEMORY_CONVERSATION_UNAVAILABLE');
  });

  it('refuses a restored native watermark, absent witness and missing native table explicitly instead of returning empty results', async () => {
    const f = await fixture();
    await suppress(f);
    await admin.query(
      'UPDATE meri_conversations.retention_recovery_watermark SET sequence=0,entry_sha256=NULL',
    );
    await expect(count(f)).rejects.toMatchObject({ status: 503 });
    await expect(
      f.work(
        (tx) => tx.memoryCandidate.count(),
        async () => null,
      ),
    ).rejects.toMatchObject({ status: 503 });
    await admin.query(
      'ALTER TABLE meri_conversations.retention_recovery_watermark RENAME TO missing_watermark',
    );
    try {
      await expect(count(f)).rejects.toMatchObject({ status: 503 });
    } finally {
      await admin.query(
        'ALTER TABLE meri_conversations.missing_watermark RENAME TO retention_recovery_watermark',
      );
    }
  });

  it('keeps independently approved and surface memory readable without a conversation witness; cleanup can still remove suppressed copies', async () => {
    const f = await fixture(),
      published = await f.create('firm');
    const approved = await f.work((tx) =>
      tx.memoryCandidate.create({
        data: { ...f.data, status: 'approved', committedMemoryId: published.id },
      }),
    );
    const surface = await f.work((tx) =>
      tx.memoryCandidate.create({
        data: {
          ...f.data,
          provenance: { tool: 'meri_memory_review', origin: { kind: 'surface' } },
        },
      }),
    );
    const ids = [approved.id, surface.id];
    expect(
      (
        await f.work(
          (tx) => tx.memoryCandidate.findMany({ where: { id: { in: ids } } }),
          async () => null,
        )
      )
        .map((x) => x.id)
        .sort(),
    ).toEqual(ids.sort());
    await suppress(f);
    await store.scoped(null, (tx) => tx.memoryCandidate.delete({ where: { id: f.candidate.id } }));
    expect(
      await f.work(
        (tx) => tx.memoryCandidate.count({ where: { tenantId: f.tenantId } }),
        async () => null,
      ),
    ).toBe(2);
  });

  it('rolls back activation when the final external witness changes or becomes unavailable', async () => {
    for (const unavailable of [false, true]) {
      const f = await fixture();
      let reads = 0;
      await expect(
        f.work(
          (tx) => tx.memoryCandidate.create({ data: { ...f.data, status: 'approved' } }),
          async () => {
            if (++reads === 1) return { ...witness };
            return unavailable ? null : { sequence: 2, entrySha256: 'd'.repeat(64) };
          },
        ),
      ).rejects.toMatchObject({ status: 503 });
      expect(
        await store.scoped(null, (tx) =>
          tx.memoryCandidate.count({ where: { tenantId: f.tenantId } }),
        ),
      ).toBe(1);
    }
  });

  it('holds canonical shared transition/recovery exclusion through the final read and refuses a losing activation without waiting', async () => {
    const f = await fixture(),
      competitor = new Client({ connectionString: url });
    await competitor.connect();
    const key = 'meri_retention_transition:' + f.tenantId + ':conversation:' + f.conversationId;
    try {
      await f.work(async (tx) => {
        await tx.memoryCandidate.findUniqueOrThrow({ where: { id: f.candidate.id } });
        await competitor.query('BEGIN');
        expect(
          (
            await competitor.query(
              'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',
              [key],
            )
          ).rows[0].locked,
        ).toBe(false);
        expect(
          (
            await competitor.query(
              "SELECT pg_try_advisory_xact_lock(hashtextextended('meri_retention_recovery',0)) locked",
            )
          ).rows[0].locked,
        ).toBe(false);
        await competitor.query('ROLLBACK');
      });
      await competitor.query('BEGIN');
      await competitor.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      await expect(
        f.work((tx) => tx.memoryCandidate.create({ data: { ...f.data, status: 'approved' } })),
      ).rejects.toMatchObject({ status: 503 });
      await competitor.query('ROLLBACK');
      expect(await count(f)).toBe(1);
    } finally {
      await competitor.query('ROLLBACK');
      await competitor.end();
    }
  });

  it('refuses a bypassing runtime role or disabled FORCE RLS before executing application work', async () => {
    const f = await fixture(),
      work = jest.fn(async () => 'must not run');
    const unsafe = {
      ...store.prisma,
      withTenantUser: async (
        _t: string,
        _u: string,
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) => store.db.$transaction(fn),
    };
    await expect(
      withMemoryConversationRetention(unsafe as never, f.tenantId, f.userId, work, { readWitness }),
    ).rejects.toMatchObject({ status: 503 });
    await admin.query('ALTER TABLE memory_candidate NO FORCE ROW LEVEL SECURITY');
    try {
      await expect(f.work(work)).rejects.toMatchObject({ status: 503 });
    } finally {
      await admin.query('ALTER TABLE memory_candidate FORCE ROW LEVEL SECURITY');
    }
    expect(work).not.toHaveBeenCalled();
  });

  it('uses the existing non-login reader without giving Core raw native table reads or leaving installer membership behind', async () => {
    const f = await fixture();
    await expect(
      store.scoped(
        f.tenantId,
        (tx) => tx.$queryRaw`SELECT state FROM meri_conversations.retention_subjects`,
      ),
    ).rejects.toThrow('permission denied');
    const grants = (
      await admin.query(`SELECT
      (SELECT rolname FROM pg_roles WHERE oid=(SELECT proowner FROM pg_proc WHERE oid='meri_core_authority.retention_serving_v1(uuid,uuid,uuid,bigint,text)'::regprocedure)) owner,
      has_schema_privilege('meri_core_admission_reader','meri_core_authority','CREATE') can_create,
      EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='meri_core_admission_reader'::regrole) member`)
    ).rows[0];
    expect(grants).toEqual({
      owner: 'meri_core_admission_reader',
      can_create: false,
      member: false,
    });
    await admin.query(
      'REVOKE SELECT (singleton,sequence,entry_sha256) ON meri_conversations.retention_recovery_watermark FROM meri_core_admission_reader',
    );
    try {
      await expect(count(f)).rejects.toMatchObject({ status: 503 });
    } finally {
      await admin.query(
        'GRANT SELECT (singleton,sequence,entry_sha256) ON meri_conversations.retention_recovery_watermark TO meri_core_admission_reader',
      );
    }
  });
});
