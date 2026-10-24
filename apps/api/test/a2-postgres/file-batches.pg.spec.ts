import { beforeAll, afterAll, beforeEach, describe, it, expect } from '@jest/globals';
import { ClientFileBatchService } from '../../src/clients/client-file-batch.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  fixture,
  ctx,
  tenant,
  actor,
  client,
  first,
  second,
  foreign,
  outsider,
  id,
  command,
  batchMigration,
  release,
  settled,
} from './fixture.js';
let h: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  h = await fixture('files');
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
});
const files = () =>
  h.sql('SELECT id,folder,metadata_revision AS revision FROM engagement_attachments ORDER BY id');
const receipts = () => h.sql('SELECT count(*)::int AS count FROM client_file_batch_move_receipts');
describe('PF16 actual PostgreSQL16 + Prisma ordinary attachment owner', () => {
  it('commits all files and one receipt; repeat migration and exact replay preserve the historical result', async () => {
    const result = await h.files.move(ctx, client, command());
    expect(result.files).toEqual([
      { id: first, previousRevision: 0, revision: 1, folder: 'Reviewed' },
      { id: second, previousRevision: 0, revision: 1, folder: 'Reviewed' },
    ]);
    await h.sql(batchMigration());
    expect(await h.files.move(ctx, client, command())).toEqual(result);
    expect(await h.files.receipt(ctx, client, command().requestId)).toEqual(result);
    expect((await receipts()).rows[0].count).toBe(1);
    expect((await files()).rows.map((f) => f.revision)).toEqual([1, 1]);
    await expect(
      h.files.move(ctx, client, { ...command(), folder: 'Other' }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('one stale, denied, missing or hearing row changes no files; bounded denials retain one terminal outcome', async () => {
    for (const kind of ['stale', 'denied', 'missing', 'hearing'] as const) {
      await h.reset();
      if (kind === 'stale')
        await h.sql('UPDATE engagement_attachments SET file_name=$1 WHERE id=$2', [
          'Changed.pdf',
          second,
        ]);
      if (kind === 'denied')
        await h.sql(
          `UPDATE engagement_attachments SET viewer_mode='restricted',viewer_user_ids=ARRAY[$1] WHERE id=$2`,
          [outsider, second],
        );
      if (kind === 'missing')
        await h.sql('DELETE FROM engagement_attachments WHERE id=$1', [second]);
      if (kind === 'hearing')
        await h.sql(
          `UPDATE engagement_attachments SET source_entity_type='hearing_record_brief' WHERE id=$1`,
          [second],
        );
      const before = (await files()).rows;
      await expect(h.files.move(ctx, client, command())).rejects.toThrow();
      expect((await files()).rows).toEqual(before);
      expect((await receipts()).rows[0].count).toBe(kind === 'hearing' ? 0 : 1);
    }
  });
  it('a database failure on the second file rolls back the first update and receipt', async () => {
    await h.sql(
      `ALTER TABLE engagement_attachments ADD CONSTRAINT a2_second_file_failure CHECK(id<>'${second}'::uuid OR folder IS NULL)`,
    );
    try {
      await expect(h.files.move(ctx, client, command())).rejects.toThrow();
    } finally {
      await h.sql('ALTER TABLE engagement_attachments DROP CONSTRAINT a2_second_file_failure');
    }
    expect((await files()).rows.map((f) => ({ folder: f.folder, revision: f.revision }))).toEqual([
      { folder: null, revision: 0 },
      { folder: null, revision: 0 },
    ]);
    expect((await receipts()).rows[0].count).toBe(0);
  });
  it('serializes simultaneous request replay and rejects a conflicting concurrent command', async () => {
    const [a, b] = await Promise.all([
      h.files.move(ctx, client, command()),
      h.files.move(ctx, client, command()),
    ]);
    expect(a).toEqual(b);
    expect((await receipts()).rows[0].count).toBe(1);
    await h.reset();
    const results = await Promise.all([
      settled(h.files.move(ctx, client, command())),
      settled(h.files.move(ctx, client, { ...command(), folder: 'Other' })),
    ]);
    expect(results.filter((r) => r.value)).toHaveLength(1);
    expect(results.filter((r) => r.error?.status === 409)).toHaveLength(1);
    expect((await files()).rows.map((f) => f.revision)).toEqual([1, 1]);
    expect((await receipts()).rows[0].count).toBe(1);
  });
  it('concurrent refusals converge on one immutable outcome and later restored availability cannot execute the request', async () => {
    await h.sql('DELETE FROM engagement_attachments WHERE id=$1', [second]);
    const [a, b] = await Promise.all([
      settled(h.files.move(ctx, client, command())),
      settled(h.files.move(ctx, client, command())),
    ]);
    const refusal = a.error?.getResponse();
    expect(refusal).toMatchObject({
      code: 'FILE_BATCH_MOVE_REFUSED',
      requestId: command().requestId,
      clientId: client,
      status: 404,
    });
    expect(b.error?.getResponse()).toEqual(refusal);
    expect((await receipts()).rows[0].count).toBe(1);
    // Restored source has the original expected revision. The terminal request
    // still cannot execute, even though a new reviewed request could now succeed.
    await h.sql('INSERT INTO engagement_attachments(id,tenant_id,client_id) VALUES($1,$2,$3)', [
      second,
      tenant,
      client,
    ]);
    const later = await settled(h.files.move(ctx, client, command()));
    expect(later.error?.getResponse()).toEqual(refusal);
    expect((await files()).rows.map((row) => [row.folder, row.revision])).toEqual([
      [null, 0],
      [null, 0],
    ]);
    expect(
      (await settled(h.files.receipt(ctx, client, command().requestId))).error?.getResponse(),
    ).toEqual(refusal);
    expect((await h.files.move(ctx, client, command(21))).outcome).toBe('moved');
  });
  it('a concurrent exact commit winning after rollback is returned instead of a false refusal', async () => {
    await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
    let observed!: () => void, releaseAttempt!: () => void;
    const rolledBack = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const releaseRollback = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    let once = true;
    const delayed = new ClientFileBatchService({
      withTenant: async (...args: Parameters<PrismaService['withTenant']>) => {
        try {
          return await h.prisma.withTenant(...args);
        } catch (error) {
          if (once) {
            once = false;
            observed();
            await releaseRollback;
          }
          throw error;
        }
      },
    } as PrismaService);
    const pending = settled(delayed.move(ctx, client, command()));
    await rolledBack;
    let winner;
    try {
      await h.sql(
        'INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)',
        [tenant, client, actor],
      );
      winner = await h.files.move(ctx, client, command());
    } finally {
      releaseAttempt();
    }
    expect((await pending).value).toEqual(winner);
    expect((await receipts()).rows[0].count).toBe(1);
    expect((await files()).rows.map((row) => row.revision)).toEqual([1, 1]);
  });
  it('terminal refusal recovery needs current actor/client but no missing file and keeps immutable ordinary-role grants', async () => {
    await h.sql('DELETE FROM engagement_attachments WHERE id=$1', [second]);
    const original = await settled(h.files.move(ctx, client, command()));
    expect(
      (await settled(h.files.receipt(ctx, client, command().requestId))).error?.getResponse(),
    ).toEqual(original.error.getResponse());
    await expect(
      h.files.receipt(
        { ...ctx, userId: outsider, clerkUserId: 'a2-synthetic-other' },
        client,
        command().requestId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
    const denied = await settled(h.files.receipt(ctx, client, command().requestId));
    expect(denied.error?.getResponse()).not.toHaveProperty('code', 'FILE_BATCH_MOVE_REFUSED');
    await expect(
      h.prisma.withTenant(
        tenant,
        (tx) => tx.$executeRaw`UPDATE client_file_batch_move_receipts SET receipt='{}'::jsonb`,
      ),
    ).rejects.toThrow();
    await expect(
      h.prisma.withTenant(
        tenant,
        (tx) => tx.$executeRaw`DELETE FROM client_file_batch_move_receipts`,
      ),
    ).rejects.toThrow();
    expect((await receipts()).rows[0].count).toBe(1);
  });
  it('fresh per-file ACL after a row-lock wait prevents every move', async () => {
    const acl = await h.lock(
      `UPDATE engagement_attachments SET viewer_mode='restricted',viewer_user_ids=ARRAY[$1] WHERE id=$2`,
      [outsider, second],
    );
    const pending = settled(h.files.move(ctx, client, command()));
    try {
      await h.waitForLock('FROM engagement_attachments');
    } finally {
      await release(acl);
    }
    expect((await pending).error).toMatchObject({ status: 404 });
    expect((await files()).rows.map((f) => f.folder)).toEqual([null, null]);
    expect((await receipts()).rows[0].count).toBe(1);
  });
  it('fresh membership and client-wall grants are rechecked after waiting on the client', async () => {
    for (const revoke of ['membership', 'wall'] as const) {
      await h.reset();
      if (revoke === 'wall') {
        await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
        await h.sql(
          'INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)',
          [tenant, client, actor],
        );
      }
      const owner = await h.lock('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [client]);
      const pending = settled(h.files.move(ctx, client, command()));
      try {
        await h.waitForLock('FROM clients');
        if (revoke === 'membership')
          await h.sql(
            `UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2`,
            [tenant, actor],
          );
        else
          await h.sql(
            'DELETE FROM client_memory_access WHERE tenant_id=$1 AND client_id=$2 AND user_id=$3',
            [tenant, client, actor],
          );
      } finally {
        await release(owner);
      }
      expect((await pending).error).toBeDefined();
      expect((await receipts()).rows[0].count).toBe(0);
    }
  });
  it('every actual row ACL writer increments revision; same-value updates do not', async () => {
    const updates = [
      `viewer_mode='restricted'`,
      `viewer_user_ids=ARRAY['${actor}']`,
      `uploaded_by_user_id='${outsider}'::uuid`,
      `client_id=NULL`,
      `source_entity_type='hearing_record_brief'`,
      `folder='Changed'`,
    ];
    for (let i = 0; i < updates.length; i++) {
      await h.sql(`UPDATE engagement_attachments SET ${updates[i]} WHERE id=$1`, [first]);
      expect((await files()).rows.find((f) => f.id === first).revision).toBe(i + 1);
    }
    await h.sql(
      `UPDATE engagement_attachments SET folder='Changed',metadata_revision=0 WHERE id=$1`,
      [first],
    );
    expect((await files()).rows.find((f) => f.id === first).revision).toBe(updates.length);
  });
  it('historical receipt recovery still requires current file/client/member authority', async () => {
    await h.files.move(ctx, client, command());
    await h.sql(
      `UPDATE engagement_attachments SET viewer_mode='restricted',viewer_user_ids=ARRAY[$1] WHERE id=$2`,
      [outsider, second],
    );
    await expect(h.files.receipt(ctx, client, command().requestId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(h.files.move(ctx, client, command())).rejects.toMatchObject({ status: 404 });
    await expect(
      h.files.receipt({ ...ctx, tenantId: foreign }, client, command().requestId),
    ).rejects.toThrow();
    expect((await receipts()).rows[0].count).toBe(1);
  });
  it('forced receipt RLS, immutable grants, composite FK and integer overflow fail closed', async () => {
    await h.files.move(ctx, client, command());
    expect(
      await h.prisma.withTenant(
        foreign,
        (tx) => tx.$queryRaw`SELECT id FROM client_file_batch_move_receipts`,
      ),
    ).toEqual([]);
    await expect(
      h.prisma.withTenant(
        tenant,
        (tx) =>
          tx.$executeRaw`UPDATE client_file_batch_move_receipts SET payload_digest=${'a'.repeat(64)}`,
      ),
    ).rejects.toThrow();
    await expect(
      h.prisma.withTenant(
        tenant,
        (tx) => tx.$executeRaw`DELETE FROM client_file_batch_move_receipts`,
      ),
    ).rejects.toThrow();
    await expect(
      h.sql(
        `INSERT INTO client_file_batch_move_receipts(tenant_id,client_id,actor_user_id,request_id,payload_digest,command,receipt) VALUES($1,$2,$3,$4,$5,'{}','{}')`,
        [foreign, client, actor, id(80), 'a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // New insert starts at max revision: the next legacy metadata update must fail, never wrap.
    await h.sql(
      'INSERT INTO engagement_attachments(id,tenant_id,client_id,metadata_revision) VALUES($1,$2,$3,2147483647)',
      [id(81), tenant, client],
    );
    await expect(
      h.sql('UPDATE engagement_attachments SET folder=$1 WHERE id=$2', ['overflow', id(81)]),
    ).rejects.toMatchObject({ code: '22003' });
    expect(
      (await h.sql('SELECT metadata_revision FROM engagement_attachments WHERE id=$1', [id(81)]))
        .rows[0].metadata_revision,
    ).toBe(2147483647);
  });
});
