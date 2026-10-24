import { beforeAll, afterAll, beforeEach, describe, it, expect } from '@jest/globals';
import {
  fixture,
  ctx,
  tenant,
  actor,
  broadcast,
  foreign,
  outsider,
  release,
  settled,
} from './fixture.js';
let h: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  h = await fixture('broadcasts');
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
});
describe('ST20 actual PostgreSQL16 + Prisma recipient owner', () => {
  it('lists only the exact recipient and returns one stable acknowledgement timestamp', async () => {
    expect(await h.broadcasts.listPendingForUser(ctx)).toHaveLength(1);
    const [a, b] = await Promise.all([
      h.broadcasts.acknowledge(ctx, broadcast),
      h.broadcasts.acknowledge(ctx, broadcast),
    ]);
    expect(a).toEqual(b);
    expect(a.broadcastId).toBe(broadcast);
    expect(a.acknowledgedAt).toBeInstanceOf(Date);
    expect(await h.broadcasts.listPendingForUser(ctx)).toEqual([]);
    const counts = await h.sql(
      'SELECT count(*)::int AS acknowledged FROM admin_broadcast_recipients WHERE acknowledged_at IS NOT NULL',
    );
    expect(counts.rows[0].acknowledged).toBe(1);
  });
  it('refuses foreign, nontargeted and removed recipients without acknowledging', async () => {
    for (const scope of [
      { ...ctx, tenantId: foreign },
      { ...ctx, userId: outsider, clerkUserId: 'a2-synthetic-other' },
    ])
      await expect(h.broadcasts.acknowledge(scope, broadcast)).rejects.toMatchObject({
        status: 404,
      });
    await h.sql(
      `UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2`,
      [tenant, actor],
    );
    await expect(h.broadcasts.acknowledge(ctx, broadcast)).rejects.toMatchObject({ status: 404 });
    expect(
      (await h.sql('SELECT acknowledged_at FROM admin_broadcast_recipients')).rows[0]
        .acknowledged_at,
    ).toBeNull();
  });
  it('archive committed while acknowledgement waits wins before receipt creation', async () => {
    const lock = await h.lock('UPDATE admin_broadcasts SET archived_at=now() WHERE id=$1', [
      broadcast,
    ]);
    const pending = settled(h.broadcasts.acknowledge(ctx, broadcast));
    try {
      await h.waitForLock('FROM admin_broadcasts');
    } finally {
      await release(lock);
    }
    expect((await pending).error).toMatchObject({ status: 404 });
    expect(
      (await h.sql('SELECT acknowledged_at FROM admin_broadcast_recipients')).rows[0]
        .acknowledged_at,
    ).toBeNull();
  });
  it('acknowledgement holds archive eligibility until its recipient write commits', async () => {
    const recipient = await h.lock(
      'SELECT id FROM admin_broadcast_recipients WHERE broadcast_id=$1 FOR UPDATE',
      [broadcast],
    );
    const pending = settled(h.broadcasts.acknowledge(ctx, broadcast));
    let archive: ReturnType<typeof settled> | undefined;
    try {
      await h.waitForLock('FROM admin_broadcast_recipients');
      // Archive under the same real app role/tenant transaction, so no admin bypass.
      archive = settled(
        h.prisma.withTenant(
          tenant,
          (tx) =>
            tx.$executeRaw`UPDATE admin_broadcasts SET archived_at=now() WHERE id=${broadcast}::uuid`,
        ),
      );
      await h.waitForLock('UPDATE admin_broadcasts');
    } finally {
      await release(recipient);
    }
    expect((await pending).error).toBeUndefined();
    expect((await archive!).error).toBeUndefined();
    expect(
      (await h.sql('SELECT acknowledged_at FROM admin_broadcast_recipients')).rows[0]
        .acknowledged_at,
    ).toBeInstanceOf(Date);
    expect(await h.broadcasts.listPendingForUser(ctx)).toEqual([]);
  });
  it('membership revocation is re-read after waiting, with no acknowledgement', async () => {
    const member = await h.lock(
      `UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2`,
      [tenant, actor],
    );
    const pending = settled(h.broadcasts.acknowledge(ctx, broadcast));
    try {
      await h.waitForLock('FROM tenant_memberships');
    } finally {
      await release(member);
    }
    expect((await pending).error).toMatchObject({ status: 404 });
    expect(
      (await h.sql('SELECT acknowledged_at FROM admin_broadcast_recipients')).rows[0]
        .acknowledged_at,
    ).toBeNull();
  });
});
