import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const configPath = process.env.MERI_FIXTURE_POSTGRES_CONFIG;

// Actual built store, Prisma transactions and database contention. The actor
// context and minimal schema isolate the legacy-compatible mutation boundary;
// these tests do not claim full governed authorization, migrations or RLS.
describe('canonical memory revocation locking', { skip: !configPath }, () => {
  const schema = `meri_revoke_lock_${randomUUID().replaceAll('-', '')}`;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const ctx = { tenantId, userId, role: 'user_admin' };
  const envNames = ['DATABASE_URL', 'MEMORY_GOVERNANCE_ENFORCE', 'MEMORY_GOVERNANCE_LIFECYCLE'];
  const priorEnv = envNames.map((name) => process.env[name]);
  let pool, prisma, Store;

  before(async () => {
    const database = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(database.host, '127.0.0.1');
    assert.equal(database.port, 55433);
    assert.equal(database.database, 'postgres');
    assert.match(schema, /^meri_revoke_lock_[a-f0-9]{32}$/u);
    pool = new Pool(database);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`
      CREATE TABLE "${schema}".memory_items (
        id uuid PRIMARY KEY, tenant_id uuid, title text, slug text, visibility text,
        owner_user_id uuid, client_id uuid, status text, legal_hold boolean,
        revoked_at timestamptz, revoked_by uuid, updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE "${schema}".context_embeddings (source_type text, source_id text);
      CREATE TABLE "${schema}".clio_memory (id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE "${schema}".audit_logs (
        id uuid PRIMARY KEY, tenant_id uuid, actor_user_id uuid, actor_role text,
        action text, entity_type text, entity_id text, before_jsonb jsonb,
        after_jsonb jsonb, ip text, user_agent text, request_id text,
        occurred_at timestamptz DEFAULT now()
      )`);
    const url = new URL(`postgresql://${database.host}:${database.port}/${database.database}`);
    url.username = database.user;
    url.password = database.password;
    url.searchParams.set('schema', schema);
    process.env.DATABASE_URL = url.href;
    delete process.env.MEMORY_GOVERNANCE_ENFORCE;
    delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    const { PrismaService } = require(
      fileURLToPath(new URL('../../../../apps/api/dist/prisma/prisma.service.js', import.meta.url)),
    );
    ({ MemoryStoreService: Store } = require(
      fileURLToPath(
        new URL('../../../../apps/api/dist/memory/memory-store.service.js', import.meta.url),
      ),
    ));
    prisma = new PrismaService();
    await prisma.$connect();
  });

  after(async () => {
    await prisma?.$disconnect();
    envNames.forEach((name, index) => {
      if (priorEnv[index] === undefined) delete process.env[name];
      else process.env[name] = priorEnv[index];
    });
    if (pool) {
      assert.match(schema, /^meri_revoke_lock_[a-f0-9]{32}$/u);
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      console.info(`Removed owned local revocation schema ${schema}`);
      await pool.end();
    }
  });

  function store(onStart = () => {}) {
    const observedPrisma = {
      withTenantUser: (tenant, actor, work) =>
        prisma.withTenantUser(
          tenant,
          actor,
          async (tx) => {
            const [{ pid }] = await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
            onStart(pid);
            return work(tx);
          },
          { timeoutMs: 10_000 },
        ),
    };
    return new Store(observedPrisma, { require: () => ctx });
  }

  async function seed() {
    const id = randomUUID();
    const clioId = randomUUID();
    await pool.query(
      `INSERT INTO "${schema}".memory_items
      (id,tenant_id,title,slug,visibility,status,legal_hold)
      VALUES ($1,$2,'Synthetic memory',$3,'tenant','active',false)`,
      [id, tenantId, `clio:${clioId}`],
    );
    await pool.query(`INSERT INTO "${schema}".context_embeddings VALUES ('memory_item',$1)`, [id]);
    await pool.query(`INSERT INTO "${schema}".clio_memory VALUES ($1,$2)`, [clioId, tenantId]);
    return { id, clioId };
  }

  async function read(id, clioId) {
    return {
      item: (
        await pool.query(`SELECT status,legal_hold FROM "${schema}".memory_items WHERE id=$1`, [id])
      ).rows[0],
      embeddings: (
        await pool.query(
          `SELECT source_id FROM "${schema}".context_embeddings WHERE source_id=$1`,
          [id],
        )
      ).rowCount,
      clio: (await pool.query(`SELECT id FROM "${schema}".clio_memory WHERE id=$1`, [clioId]))
        .rowCount,
      audits: (await pool.query(`SELECT id FROM "${schema}".audit_logs WHERE entity_id=$1`, [id]))
        .rowCount,
    };
  }

  for (const winner of ['hold', 'revoke']) {
    it(`rechecks the row after a concurrent ${winner} wins, without cleanup or duplicate audit`, async () => {
      const { id, clioId } = await seed();
      const blocker = await pool.connect();
      let outcome, pid;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          `UPDATE "${schema}".memory_items SET ${winner === 'hold' ? 'legal_hold=true' : "status='revoked'"} WHERE id=$1`,
          [id],
        );
        outcome = store((value) => {
          pid = value;
        })
          .forgetMemory(id, 'Synthetic race probe')
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
        let observedLock = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          if (pid) {
            const state = await pool.query(
              'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
              [pid],
            );
            if (state.rows[0]?.wait_event_type === 'Lock') {
              observedLock = true;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await blocker.query('COMMIT');
        const result = await outcome;
        assert.ifError(result.error);
        assert.equal(observedLock, true, 'application must encounter real database contention');
        console.info(
          JSON.stringify({
            probe: winner,
            returned: result.value,
            persisted: await read(id, clioId),
          }),
        );
        assert.deepEqual(
          result.value,
          winner === 'hold'
            ? { found: true, blockedByLegalHold: true, title: 'Synthetic memory' }
            : { found: false },
        );
        assert.deepEqual(await read(id, clioId), {
          item: { status: winner === 'hold' ? 'active' : 'revoked', legal_hold: winner === 'hold' },
          embeddings: 1,
          clio: 1,
          audits: 0,
        });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await outcome;
      }
    });
  }

  it('retains the canonical row while removing projections and recording the ordinary audit', async () => {
    const { id, clioId } = await seed();
    assert.deepEqual(await store().forgetMemory(id, 'Synthetic retirement'), {
      found: true,
      title: 'Synthetic memory',
    });
    assert.deepEqual(await read(id, clioId), {
      item: { status: 'revoked', legal_hold: false },
      embeddings: 0,
      clio: 0,
      audits: 1,
    });
  });

  it('rolls back revocation and projection cleanup if the ordinary audit insert fails', async () => {
    const { id, clioId } = await seed();
    await pool.query(`CREATE FUNCTION "${schema}".reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'controlled revocation audit failure'; END $$;
      CREATE TRIGGER reject_audit BEFORE INSERT ON "${schema}".audit_logs
      FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_audit()`);
    try {
      await assert.rejects(
        store().forgetMemory(id, 'Synthetic rollback'),
        /controlled revocation audit failure/u,
      );
      assert.deepEqual(await read(id, clioId), {
        item: { status: 'active', legal_hold: false },
        embeddings: 1,
        clio: 1,
        audits: 0,
      });
    } finally {
      await pool.query(
        `DROP TRIGGER reject_audit ON "${schema}".audit_logs; DROP FUNCTION "${schema}".reject_audit()`,
      );
    }
  });
});
