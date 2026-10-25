import { beforeAll, afterAll, beforeEach, describe, it, expect } from '@jest/globals';
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
  command,
  id,
  settled,
} from './fixture.js';
import { hearingOwner } from './hearing-owner.js';
let h: Awaited<ReturnType<typeof fixture>>, owner: Awaited<ReturnType<typeof hearingOwner>>;
beforeAll(async () => {
  h = await fixture('hearing');
  owner = await hearingOwner(h);
});
beforeEach(async () => {
  await owner.seed();
});
afterAll(async () => {
  await owner?.close();
  await h?.close();
});
const move = (request = 20) => ({
  ...command(request),
  files: [
    { id: first, expectedRevision: 0 },
    { id: second, expectedRevision: 1 },
  ],
});
const state = async () => ({
  files: (await h.sql('SELECT id,folder,metadata_revision FROM engagement_attachments ORDER BY id'))
    .rows,
  receipts: (await h.sql('SELECT count(*)::int AS count FROM client_file_batch_move_receipts'))
    .rows[0].count,
});

describe('PF16 actual Core transaction + independent Intel owner HTTP read', () => {
  it('the old UPDATE authority lock blocks the actual remote owner until released', async () => {
    let unlock!: () => void;
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = h.prisma.withTenant(tenant, async (tx) => {
      await tx.$queryRaw`SELECT id FROM clients WHERE id=${client}::uuid FOR UPDATE`;
      locked();
      await released;
    });
    await ready;
    const reading = settled(
      owner.workflow.brief(
        { tenantId: tenant, clerkUserId: ctx.clerkUserId, role: null },
        'pf16-event',
        'pf16-brief',
      ),
    );
    try {
      await h.waitForLock('FROM clients');
    } finally {
      unlock();
    }
    await holder;
    expect((await reading).value?.current).toBe(true);
  });
  it('moves mixed files atomically, accepts a still-current older approval for read and rechecks exact historical replay', async () => {
    const result = await h.files.move(ctx, client, move());
    expect(result.files).toEqual([
      { id: first, previousRevision: 0, revision: 1, folder: 'Reviewed' },
      { id: second, previousRevision: 1, revision: 2, folder: 'Reviewed' },
    ]);
    expect(await h.files.move(ctx, client, move())).toEqual(result);
    expect(await h.files.receipt(ctx, client, move().requestId)).toEqual(result);
    expect(owner.calls).toBe(6);
    expect((await state()).receipts).toBe(1);
  });
  it('a queued client-wall revocation does not self-deadlock the independent SHARE read and applies after commit', async () => {
    let revoke: ReturnType<typeof settled> | undefined;
    owner.beforeRead(async (n) => {
      if (n !== 2) return;
      revoke = settled(
        h.prisma.withTenant(
          tenant,
          (tx) => tx.$executeRaw`UPDATE clients SET memory_wall=true WHERE id=${client}::uuid`,
        ),
      );
      await h.waitForLock('UPDATE clients');
    });
    const result = await h.files.move(ctx, client, move());
    expect(result.outcome).toBe('moved');
    expect((await revoke)!.error).toBeUndefined();
    owner.beforeRead(undefined);
    await expect(h.files.receipt(ctx, client, move().requestId)).rejects.toThrow();
    expect((await state()).receipts).toBe(1);
  });
  it('folder change committed before lock acquisition refuses the whole batch', async () => {
    owner.afterRead(async (n) => {
      if (n === 1)
        await h.sql(
          `UPDATE intel_legiwatch_folder SET archived=true,version=version+1 WHERE id='pf16-folder'`,
        );
    });
    await expect(h.files.move(ctx, client, move())).rejects.toThrow('ACCESS_OR_VERSION_CHANGED');
    expect((await state()).files.map((f) => f.folder)).toEqual([null, null]);
    expect((await state()).receipts).toBe(0);
  });
  it('folder revocation queued after the lock waits for the batch; replay then refuses current access', async () => {
    let revoke: ReturnType<typeof settled> | undefined;
    owner.beforeRead(async (n) => {
      if (n !== 2) return;
      revoke = settled(
        h.prisma.withTenant(
          tenant,
          (tx) =>
            tx.$executeRaw`UPDATE intel_legiwatch_folder SET archived=true,version=version+1 WHERE id='pf16-folder'`,
        ),
      );
      await h.waitForLock('UPDATE intel_legiwatch_folder');
    });
    expect((await h.files.move(ctx, client, move())).outcome).toBe('moved');
    expect((await revoke)!.error).toBeUndefined();
    owner.beforeRead(undefined);
    await expect(h.files.move(ctx, client, move())).rejects.toThrow('ACCESS_OR_VERSION_CHANGED');
    expect((await state()).receipts).toBe(1);
  });
  it('membership, feature, foreign principal, missing provenance, denied file and stale revision all preserve the other file', async () => {
    for (const kind of [
      'membership',
      'feature',
      'foreign',
      'actor',
      'provenance',
      'file',
      'revision',
    ]) {
      await owner.seed();
      if (kind === 'membership')
        await h.sql(`UPDATE tenant_memberships SET status='removed' WHERE user_id=$1`, [actor]);
      if (kind === 'feature')
        await h.sql(
          `UPDATE intel_feature_flag SET enabled=false WHERE feature='legiwatch_record_briefs_v1'`,
        );
      if (kind === 'provenance') await h.sql(`TRUNCATE legiwatch_record_document`);
      if (kind === 'file')
        await h.sql(
          `UPDATE engagement_attachments SET viewer_mode='restricted',viewer_user_ids=ARRAY[$1] WHERE id=$2`,
          [outsider, first],
        );
      const c =
        kind === 'foreign'
          ? { ...ctx, tenantId: foreign }
          : kind === 'actor'
            ? { ...ctx, userId: outsider, clerkUserId: 'a2-synthetic-other' }
            : ctx;
      await expect(
        h.files.move(c, client, kind === 'revision' ? command() : move()),
      ).rejects.toThrow();
      expect((await state()).files.map((f) => f.folder)).toEqual([null, null]);
      expect((await state()).receipts).toBe(['file', 'revision'].includes(kind) ? 1 : 0);
    }
  });
  it('revocation between owner discovery and lock/recheck refuses all files, as does owner unavailability', async () => {
    for (const kind of ['membership', 'wall', 'feature', 'unavailable']) {
      await owner.seed();
      owner.afterRead(async (n) => {
        if (n !== 1) return;
        if (kind === 'membership')
          await h.sql(`UPDATE tenant_memberships SET status='removed' WHERE user_id=$1`, [actor]);
        if (kind === 'wall')
          await h.sql(`UPDATE clients SET memory_wall=true WHERE id=$1`, [client]);
        if (kind === 'feature')
          await h.sql(
            `UPDATE intel_feature_flag SET enabled=false WHERE feature='legiwatch_record_briefs_v1'`,
          );
      });
      if (kind === 'unavailable')
        owner.beforeRead(async (n) => {
          if (n === 2) throw Error('Synthetic owner outage');
        });
      await expect(h.files.move(ctx, client, move())).rejects.toThrow();
      expect((await state()).files.map((f) => f.folder)).toEqual([null, null]);
      expect((await state()).receipts).toBe(0);
    }
  });
  it('refuses missing or foreign owner lock metadata and changed provenance before any batch write', async () => {
    for (const kind of ['missing', 'foreign-folder', 'too-many-folders', 'brief', 'hash']) {
      await owner.seed();
      owner.afterRead(async (_n, result) => {
        if (kind === 'missing') delete result.accessLocks;
        if (kind === 'foreign-folder')
          result.accessLocks = {
            folders: [{ id: 'pf16-folder', version: 0, clientId: foreign }],
            observation: null,
          };
        if (kind === 'too-many-folders')
          result.accessLocks = {
            folders: Array(21).fill({ id: 'pf16-folder', version: 0, clientId: client }),
            observation: null,
          };
        if (kind === 'brief') result.id = 'swapped-brief';
        if (kind === 'hash') result.sourceHash = 'f'.repeat(64);
      });
      await expect(h.files.move(ctx, client, move())).rejects.toThrow();
      expect((await state()).files.map((f) => f.folder)).toEqual([null, null]);
      expect((await state()).receipts).toBe(
        ['missing', 'foreign-folder', 'too-many-folders'].includes(kind) ? 1 : 0,
      );
    }
  });
  it('concurrent same-request replay commits once; competing folder moves have one winner', async () => {
    const [a, b] = await Promise.all([
      h.files.move(ctx, client, move()),
      h.files.move(ctx, client, move()),
    ]);
    expect(a).toEqual(b);
    expect((await state()).receipts).toBe(1);
    await owner.seed();
    const results = await Promise.all([
      settled(h.files.move(ctx, client, move())),
      settled(h.files.move(ctx, client, { ...move(21), folder: 'Other' })),
    ]);
    expect(results.filter((r) => r.value)).toHaveLength(1);
    expect(results.filter((r) => r.error?.status === 409)).toHaveLength(1);
    expect((await state()).receipts).toBe(2);
  });
});
