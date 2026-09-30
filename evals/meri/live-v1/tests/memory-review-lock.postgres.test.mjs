import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const configPath = process.env.MERI_FIXTURE_POSTGRES_CONFIG;

// Real application workflow, Prisma transactions and PostgreSQL row locks.
// Authorization is deliberately allowed here: this is not an RLS/policy test.
describe('canonical memory review candidate locking', { skip: !configPath }, () => {
  const schema = `meri_review_lock_${randomUUID().replaceAll('-', '')}`;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const ctx = { tenantId, userId, role: 'user_admin' };
  const priorUrl = process.env.DATABASE_URL;
  let pool, prisma, service;

  before(async () => {
    const database = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(database.host, '127.0.0.1');
    assert.equal(database.port, 55433);
    assert.equal(database.database, 'postgres');
    const { PrismaService } = require(
      fileURLToPath(new URL('../../../../apps/api/dist/prisma/prisma.service.js', import.meta.url)),
    );
    const { MemoryReviewWorkflowService } = require(
      fileURLToPath(
        new URL(
          '../../../../apps/api/dist/memory/memory-review-workflow.service.js',
          import.meta.url,
        ),
      ),
    );
    assert.match(schema, /^meri_review_lock_[a-f0-9]{32}$/u);
    pool = new Pool(database);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`
      CREATE TABLE "${schema}".memory_candidate (
        id uuid PRIMARY KEY, tenant_id uuid, proposed_by uuid, client_id uuid,
        source_kind text, scope text, payload_jsonb jsonb, status text,
        contradicts_memory_item_id uuid, conflict_status text
      );
      CREATE TABLE "${schema}".users (
        id uuid PRIMARY KEY, email text, first_name text, last_name text
      );
      CREATE TABLE "${schema}".tenant_memberships (
        tenant_id uuid, user_id uuid, role text, status text
      );
      CREATE TABLE "${schema}".review_request (
        id uuid PRIMARY KEY, tenant_id uuid, risk_tier text, surface text,
        subject_type text, subject_id text, client_id uuid, title text,
        reason text, payload_jsonb jsonb DEFAULT '{}', status text DEFAULT 'pending',
        requested_by uuid, assigned_to uuid, decided_by uuid, decided_at timestamptz,
        created_at timestamptz DEFAULT now()
      );
      CREATE TABLE "${schema}".audit_logs (
        id uuid PRIMARY KEY, tenant_id uuid, actor_user_id uuid, actor_role text,
        action text, entity_type text, entity_id text, before_jsonb jsonb,
        after_jsonb jsonb, ip text, user_agent text, request_id text,
        occurred_at timestamptz DEFAULT now()
      )`);
    await pool.query(
      `INSERT INTO "${schema}".users VALUES ($1,'synthetic@example.invalid','Test','Reviewer')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO "${schema}".tenant_memberships VALUES ($1,$2,'user_admin','active')`,
      [tenantId, userId],
    );
    const url = new URL(`postgresql://${database.host}:${database.port}/${database.database}`);
    url.username = database.user;
    url.password = database.password;
    url.searchParams.set('schema', schema);
    process.env.DATABASE_URL = url.href;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new MemoryReviewWorkflowService(prisma, {
      evaluateInTx: async () => ({ allowed: true, basis: 'admin' }),
    });
  });

  after(async () => {
    await prisma?.$disconnect();
    if (priorUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorUrl;
    if (pool) {
      assert.match(schema, /^meri_review_lock_[a-f0-9]{32}$/u);
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      console.info(`Removed owned local qualification schema ${schema}`);
      await pool.end();
    }
  });

  async function seed() {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO "${schema}".memory_candidate
      (id,tenant_id,proposed_by,source_kind,scope,payload_jsonb,status,conflict_status)
      VALUES ($1,$2,$3,'model_extraction','firm','{}','pending','none')`,
      [id, tenantId, userId],
    );
    return {
      id,
      tenantId,
      proposedByUserId: userId,
      clientId: null,
      sourceKind: 'model_extraction',
      scope: 'firm',
      candidateKind: 'standard',
      title: 'Synthetic pending candidate',
    };
  }

  function subject(candidate) {
    return {
      id: candidate.id,
      tenantId,
      clientId: null,
      proposedByUserId: userId,
      ownerUserId: userId,
      memoryClass: 'legacy_unclassified',
      scope: 'firm',
      status: 'suggested',
      legalHold: false,
      clientStatus: null,
    };
  }

  it('holds the candidate until the real review and audit transaction commits', async () => {
    const candidate = await seed();
    await prisma.withTenantUser(tenantId, userId, async (tx) => {
      const result = await service.ensureAndDescribeInTx(tx, ctx, candidate, subject(candidate));
      assert.equal(result.status, 'pending');
      await assert.rejects(
        pool.query(`SELECT id FROM "${schema}".memory_candidate WHERE id=$1 FOR UPDATE NOWAIT`, [
          candidate.id,
        ]),
        (error) => error.code === '55P03',
      );
    });
    const reviews = await pool.query(
      `SELECT id FROM "${schema}".review_request WHERE subject_id=$1`,
      [candidate.id],
    );
    assert.equal(reviews.rowCount, 1);
    const audit = await pool.query(`SELECT id FROM "${schema}".audit_logs WHERE entity_id=$1`, [
      reviews.rows[0].id,
    ]);
    assert.equal(audit.rowCount, 1);
  });

  for (const disposition of ['withdraw', 'delete']) {
    it(`does not create orphan review/audit records when concurrent ${disposition} wins`, async () => {
      const candidate = await seed();
      const blocker = await pool.connect();
      let waiting;
      try {
        await blocker.query('BEGIN');
        if (disposition === 'withdraw') {
          await blocker.query(
            `UPDATE "${schema}".memory_candidate SET status='withdrawn' WHERE id=$1`,
            [candidate.id],
          );
        } else {
          await blocker.query(`DELETE FROM "${schema}".memory_candidate WHERE id=$1`, [
            candidate.id,
          ]);
        }
        let resolveStarted;
        const started = new Promise((resolve) => {
          resolveStarted = resolve;
        });
        waiting = prisma.withTenantUser(
          tenantId,
          userId,
          async (tx) => {
            const [{ pid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
            resolveStarted(pid);
            return service.ensureAndDescribeInTx(tx, ctx, candidate, subject(candidate));
          },
          { timeoutMs: 10000 },
        );
        const outcome = waiting.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const pid = await started;
        let observedLock = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          const state = await pool.query(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
            [pid],
          );
          if (state.rows[0]?.wait_event_type === 'Lock') {
            observedLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await blocker.query('COMMIT');
        assert.equal((await outcome).error?.getStatus?.(), 404);
        assert.equal(
          observedLock,
          true,
          'the application must actually wait on the candidate lock',
        );
        const count = await pool.query(
          `SELECT count(*)::int AS count FROM "${schema}".review_request WHERE subject_id=$1`,
          [candidate.id],
        );
        assert.equal(count.rows[0].count, 0);
        const audit = await pool.query(
          `SELECT count(*)::int AS count FROM "${schema}".audit_logs
           WHERE before_jsonb->>'candidateId'=$1 OR after_jsonb->>'candidateId'=$1`,
          [candidate.id],
        );
        assert.equal(audit.rows[0].count, 0);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await waiting?.catch(() => {});
      }
    });
  }
});
