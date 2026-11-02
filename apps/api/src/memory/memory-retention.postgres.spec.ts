import { randomUUID } from 'node:crypto';
import { MemoryPurgeService } from './memory-purge.service.js';
import { purgeExpiredMemoryInTx } from './memory-embedding-lifecycle.js';
import { retentionDatabase } from './memory-retention.postgres-fixture.js';

const url = process.env.MEMORY_RETENTION_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('memory retention with actual PostgreSQL holds, lineage and transactions', () => {
  let db: Awaited<ReturnType<typeof retentionDatabase>>;
  const tenant = randomUUID(),
    client = randomUUID(),
    otherTenant = randomUUID();
  const actor = { userId: null, role: 'user_admin' };
  beforeAll(async () => {
    db = await retentionDatabase(url!);
  });
  beforeEach(async () => {
    await db.reset();
  });
  afterAll(async () => {
    await db?.close();
  });
  const purge = (dryRun = false) =>
    new MemoryPurgeService(db.prisma).purgeClient(tenant, client, actor, {
      dryRun,
      reason: 'synthetic retention test',
    });
  async function memory(held = false, owner = tenant, scopeClient = client) {
    const id = randomUUID(),
      clio = randomUUID();
    await db.admin.query(
      `INSERT INTO memory_items VALUES($1,$2,$3,$4,$5,now()-interval '1 day');
    `,
      [id, owner, scopeClient, `clio:${clio}`, held],
    );
    await db.admin.query(
      "INSERT INTO clio_memory VALUES($1,$2,$3,'client',now()-interval '1 day')",
      [clio, owner, scopeClient],
    );
    await db.admin.query("INSERT INTO context_embeddings VALUES($1,$2,'memory_item',$3)", [
      owner,
      scopeClient,
      id,
    ]);
    await db.admin.query('INSERT INTO memory_edges VALUES($1,$2)', [owner, id]);
    return { id, clio };
  }
  async function candidate(
    held = false,
    item?: Awaited<ReturnType<typeof memory>>,
    scopeClient = client,
  ) {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO memory_candidate(id,tenant_id,client_id,legal_hold,committed_memory_item_id,committed_memory_id)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [id, tenant, scopeClient, held, item?.id ?? null, item?.clio ?? null],
    );
    return id;
  }
  const ids = async (table: 'memory_items' | 'memory_candidate' | 'clio_memory') =>
    (await db.admin.query(`SELECT id FROM ${table} ORDER BY id`)).rows.map((row) => row.id);

  it('preserves a held candidate, its revision family and canonical content while purging unrelated client data', async () => {
    const kept = await memory(),
      removed = await memory(),
      other = await memory(false, otherTenant);
    const root = await candidate(false, kept),
      held = await candidate(true);
    await candidate(false, removed);
    await db.admin.query(
      'UPDATE memory_candidate SET revision_root_id=$1,predecessor_candidate_id=$1 WHERE id=$2',
      [root, held],
    );
    await db.admin.query('UPDATE memory_candidate SET superseded_by_id=$1 WHERE id=$2', [
      held,
      root,
    ]);
    await db.admin.query('INSERT INTO client_memory_access VALUES($1,$2),($3,$2)', [
      tenant,
      client,
      otherTenant,
    ]);
    await db.admin.query('INSERT INTO memory_access_grant VALUES($1,$2),($3,$2)', [
      tenant,
      client,
      otherTenant,
    ]);
    const before = await purge(true);
    expect(await ids('memory_items')).toHaveLength(3);
    const result = await purge();
    expect(result.deleted).toEqual(before.deleted);
    expect(result.deleted).toEqual({
      memoryItems: 1,
      embeddings: 1,
      edges: 1,
      clioMemory: 1,
      candidates: 1,
      grants: 1,
      accessGrants: 1,
    });
    expect(result.heldBack).toBe(1);
    expect(result.retainedCandidates).toBe(2);
    expect(await ids('memory_items')).toEqual([kept.id, other.id].sort());
    expect(await ids('memory_candidate')).toEqual([root, held].sort());
    expect(await ids('clio_memory')).toEqual([kept.clio, other.clio].sort());
    for (const table of ['client_memory_access', 'memory_access_grant'])
      expect((await db.admin.query(`SELECT tenant_id FROM ${table}`)).rows).toEqual([
        { tenant_id: otherTenant },
      ]);
    await db.admin.query('UPDATE memory_candidate SET legal_hold=false');
    const released = await purge();
    expect(released.retainedCandidates).toBe(0);
    expect(await ids('memory_candidate')).toEqual([]);
    expect(await ids('memory_items')).toEqual([other.id]);
  });

  it('scheduled expiry preserves item holds, candidate holds and their expired clio sources', async () => {
    const direct = await memory(true),
      inherited = await memory(),
      removed = await memory();
    await candidate(true, inherited);
    // A malformed other-tenant projection is not deleted by a source-id-only join.
    await db.admin.query("INSERT INTO context_embeddings VALUES($1,$2,'memory_item',$3)", [
      otherTenant,
      client,
      removed.id,
    ]);
    const result = await db.transaction((tx) => purgeExpiredMemoryInTx(tx));
    expect(result).toEqual({ embeddings: 1, items: 1, clio: 1 });
    expect(await ids('memory_items')).toEqual([direct.id, inherited.id].sort());
    expect(await ids('clio_memory')).toEqual([direct.clio, inherited.clio].sort());
    expect(
      (
        await db.admin.query(
          'SELECT count(*)::int AS n FROM context_embeddings WHERE tenant_id=$1',
          [otherTenant],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('keeps dependencies of revisions outside the requested client intact', async () => {
    const item = await memory(),
      root = await candidate(false, item);
    const outside = await candidate(false, undefined, randomUUID());
    await db.admin.query('UPDATE memory_candidate SET predecessor_candidate_id=$1 WHERE id=$2', [
      root,
      outside,
    ]);
    const result = await purge();
    expect(result.retainedCandidates).toBe(1);
    expect(result.deleted.candidates).toBe(0);
    expect(await ids('memory_items')).toEqual([item.id]);
    expect(await ids('memory_candidate')).toEqual([root, outside].sort());
  });

  it('preserves a held candidate clio payload even before a canonical item exists', async () => {
    const clio = randomUUID(),
      held = await candidate(true);
    await db.admin.query(
      "INSERT INTO clio_memory VALUES($1,$2,$3,'client',now()-interval '1 day')",
      [clio, tenant, client],
    );
    await db.admin.query('UPDATE memory_candidate SET committed_memory_id=$1 WHERE id=$2', [
      clio,
      held,
    ]);
    expect((await purge()).deleted.clioMemory).toBe(0);
    expect((await db.transaction((tx) => purgeExpiredMemoryInTx(tx))).clio).toBe(0);
    expect(await ids('clio_memory')).toEqual([clio]);
  });

  it('rolls every store back if the final audit write fails', async () => {
    const item = await memory();
    await candidate(false, item);
    const owner = {
      withSystem: (fn: Parameters<typeof db.transaction>[0]) =>
        db.transaction(async (tx, connection) => {
          tx.auditLog.create = () => {
            throw Error('synthetic audit failure');
          };
          return fn(tx, connection);
        }),
    };
    await expect(
      new MemoryPurgeService(owner as never).purgeClient(tenant, client, actor, {
        dryRun: false,
        reason: 'rollback fixture',
      }),
    ).rejects.toThrow('synthetic audit failure');
    expect(await ids('memory_items')).toEqual([item.id]);
    expect(await ids('memory_candidate')).toHaveLength(1);
    expect(await ids('clio_memory')).toEqual([item.clio]);
  });

  it.each(['client', 'expiry'])(
    '%s waits for an in-flight candidate hold before selecting deletions',
    async (kind) => {
      const item = await memory(),
        held = await candidate(false, item);
      const blocker = await db.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM memory_candidate WHERE id=$1 FOR UPDATE', [held]);
      let waitingPid: number | undefined;
      const operation = db.transaction(async (tx, connection) => {
        waitingPid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return kind === 'client'
          ? new MemoryPurgeService({
              withSystem: (fn: (value: typeof tx) => unknown) => fn(tx),
            } as never).purgeClient(tenant, client, actor, {
              dryRun: false,
              reason: 'hold race fixture',
            })
          : purgeExpiredMemoryInTx(tx);
      });
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          if (waitingPid)
            waiting =
              (
                await db.admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [
                  waitingPid,
                ])
              ).rows[0]?.wait_event_type === 'Lock';
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await blocker.query('UPDATE memory_candidate SET legal_hold=true WHERE id=$1', [held]);
        await blocker.query('COMMIT');
        await operation;
        expect(await ids('memory_items')).toEqual([item.id]);
        expect(await ids('clio_memory')).toEqual([item.clio]);
        expect(await ids('memory_candidate')).toEqual([held]);
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
        await operation;
      }
    },
  );
});
