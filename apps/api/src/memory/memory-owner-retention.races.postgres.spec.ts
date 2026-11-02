import { randomUUID } from 'node:crypto';
import {
  ownerRetentionDatabase,
  ownerRetentionCase,
} from './memory-owner-retention.postgres-fixture.js';

const url = process.env.MEMORY_OWNER_TEST_DATABASE_URL;
(url ? describe : describe.skip)('memory ownership transition/write races', () => {
  let store: Awaited<ReturnType<typeof ownerRetentionDatabase>>;
  beforeAll(async () => {
    store = await ownerRetentionDatabase(url!);
  }, 60000);
  afterAll(async () => {
    await store?.db.$disconnect();
  });
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  async function waitForLock(pid: number) {
    for (let i = 0; i < 150; i++) {
      const rows = await store.db.$queryRaw<
        Array<{ waiting: boolean }>
      >`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${pid}`;
      if (rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error('Expected competing database lock was not observed');
  }
  it('a write committed before offboarding is included in the closed ownership period', async () => {
    const f = await ownerRetentionCase(store),
      ready = gate(),
      finish = gate(),
      closing = gate();
    let pid = 0;
    const write = store.scoped(f.tenantId, async (tx) => {
      const value = await tx.clioMemory.create({
        data: {
          tenantId: f.tenantId,
          scope: 'user_private',
          ownerUserId: f.userId,
          key: randomUUID(),
          value: 'Synthetic racing write',
        },
      });
      ready.release();
      await finish.promise;
      return value;
    });
    await ready.promise;
    const remove = store.scoped(f.tenantId, async (tx) => {
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      closing.release();
      return tx.tenantMembership.updateMany({
        where: { tenantId: f.tenantId, userId: f.userId },
        data: { status: 'removed' },
      });
    });
    try {
      await closing.promise;
      await waitForLock(pid);
      finish.release();
      const value = await write;
      await remove;
      expect(
        (
          await store.db.memoryRetentionSubject.findUniqueOrThrow({
            where: { id: value.retentionSubjectId! },
          })
        ).closedAt,
      ).not.toBeNull();
      expect(
        await store.scoped(f.tenantId, (tx) =>
          tx.clioMemory.count({ where: { tenantId: f.tenantId } }),
        ),
      ).toBe(0);
    } finally {
      finish.release();
      await Promise.allSettled([write, remove]);
    }
  });
  it('a write waiting behind offboarding is refused without a new period or content', async () => {
    const f = await ownerRetentionCase(store),
      ready = gate(),
      finish = gate(),
      writing = gate();
    let pid = 0;
    const remove = store.scoped(f.tenantId, async (tx) => {
      await tx.tenantMembership.updateMany({
        where: { tenantId: f.tenantId, userId: f.userId },
        data: { status: 'removed' },
      });
      ready.release();
      await finish.promise;
    });
    await ready.promise;
    const write = store
      .scoped(f.tenantId, async (tx) => {
        pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        writing.release();
        return tx.clioMemory.create({
          data: {
            tenantId: f.tenantId,
            scope: 'user_private',
            ownerUserId: f.userId,
            key: randomUUID(),
            value: 'Synthetic refused write',
          },
        });
      })
      .then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
    try {
      await writing.promise;
      await waitForLock(pid);
      finish.release();
      await remove;
      expect(String((await write).error)).toContain('memory_owner_unavailable');
      expect(await store.db.clioMemory.count({ where: { tenantId: f.tenantId } })).toBe(0);
      expect(await store.db.memoryRetentionSubject.count({ where: { tenantId: f.tenantId } })).toBe(
        0,
      );
    } finally {
      finish.release();
      await Promise.allSettled([remove, write]);
    }
  });
});
