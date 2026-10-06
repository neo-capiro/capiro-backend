import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PublicCapturePersistentQueueAdapter } from './public-capture-persistent-queue.adapter.js';

const describeDb =
  process.env.DATABASE_URL && process.env.CAPIRO_DISPOSABLE_PG === '1' ? describe : describe.skip;
describeDb('capture scheduling on native PostgreSQL', () => {
  const prisma = new PrismaService();
  afterAll(() => prisma.$disconnect());
  async function isolated(
    check: (
      queue: PublicCapturePersistentQueueAdapter,
      tx: any,
      input: { dedupeKey: string; hearingId: string; captureId: string; mustReresolve: true },
      now: Date,
    ) => Promise<void>,
  ) {
    const hearingId = `capture-start-${randomUUID()}`,
      captureId = randomUUID();
    const rollback = new Error('intentional timing fixture rollback');
    try {
      await prisma.withSystem(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO committee_hearing(id,chamber,committee_name,title,date,starts_at,type,url,visibility,event_status) VALUES($1,'senate','Timing QA','Timing',CURRENT_DATE,now()+interval '1 day','Open Hearing','https://www.senate.gov/hearing/timing','public','scheduled')`,
            hearingId,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO public_hearing_capture(id,hearing_id,status,domain_status) VALUES($1,$2,'scheduled','SCHEDULED')`,
            captureId,
            hearingId,
          );
          await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
          const clock = await tx.$queryRawUnsafe<Array<{ now: Date }>>('SELECT now() AS now');
          await check(
            new PublicCapturePersistentQueueAdapter(tx as never),
            tx,
            { dedupeKey: `timing:${hearingId}`, hearingId, captureId, mustReresolve: true },
            clock[0]!.now,
          );
          throw rollback;
        },
        { timeoutMs: 30_000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
    const remaining = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      'SELECT count(*)::int AS count FROM committee_hearing WHERE id=$1',
      hearingId,
    );
    expect(remaining[0]!.count).toBe(0);
  }
  const read = (tx: any, hearing: string) =>
    tx.$queryRawUnsafe('SELECT * FROM public_hearing_capture_job WHERE hearing_id=$1', hearing);
  it('never claims a future job and moves the same pending job both earlier and later', async () => {
    await isolated(async (queue, tx, input, now) => {
      const late = new Date(now.getTime() + 86_400_000),
        early = new Date(now.getTime() + 3_600_000);
      await queue.enqueue({ ...input, dueAt: late });
      const before = (await read(tx, input.hearingId))[0];
      expect(
        await queue.claimDue({ jobType: 'capture', workerId: 'timing-worker', now }),
      ).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ hearingId: input.hearingId })]),
      );
      await queue.enqueue({ ...input, dueAt: early });
      expect((await read(tx, input.hearingId))[0]).toMatchObject({
        id: before.id,
        due_at: early,
        attempts: 0,
      });
      await queue.enqueue({ ...input, dueAt: late });
      expect(await read(tx, input.hearingId)).toEqual([
        expect.objectContaining({ id: before.id, due_at: late, attempts: 0 }),
      ]);
    });
  });
  it('preserves leased and completed jobs when the scheduler changes the start', async () => {
    await isolated(async (queue, tx, input, now) => {
      await queue.enqueue({ ...input, dueAt: now });
      const job = (await read(tx, input.hearingId))[0];
      await tx.$executeRawUnsafe(
        `UPDATE public_hearing_capture_job SET status='leased',lease_owner='timing-worker',lease_expires_at=now()+interval '5 minutes',attempts=2 WHERE id=$1`,
        job.id,
      );
      const leased = await read(tx, input.hearingId);
      expect(await queue.enqueue({ ...input, dueAt: new Date(now.getTime() + 60_000) })).toEqual({
        enqueued: false,
      });
      expect(await read(tx, input.hearingId)).toEqual(leased);
      await queue.complete({ jobId: job.id, workerId: 'timing-worker', now });
      const completed = await read(tx, input.hearingId);
      await queue.enqueue({ ...input, dueAt: new Date(now.getTime() + 60_000) });
      expect(await read(tx, input.hearingId)).toEqual(completed);
    });
  });
  it('refunds only the current scheduling claim and preserves prior failure evidence', async () => {
    await isolated(async (queue, tx, input, now) => {
      await queue.enqueue({ ...input, dueAt: now });
      const job = (await read(tx, input.hearingId))[0];
      await tx.$executeRawUnsafe(
        `UPDATE public_hearing_capture_job SET status='leased',lease_owner='timing-worker',lease_expires_at=now()+interval '5 minutes',attempts=3,last_error='prior media failure' WHERE id=$1`,
        job.id,
      );
      const dueAt = new Date(now.getTime() + 3_600_000);
      const claim = {
        jobId: job.id,
        hearingId: input.hearingId,
        captureId: input.captureId,
        workerId: 'timing-worker',
        claimedAttempts: 3,
        now,
        dueAt,
      };
      await queue.deferUntilStart(claim);
      expect((await read(tx, input.hearingId))[0]).toMatchObject({
        status: 'pending',
        due_at: dueAt,
        attempts: 2,
        last_error: 'prior media failure',
        lease_owner: null,
        lease_expires_at: null,
      });
      await expect(queue.deferUntilStart(claim)).rejects.toThrow('deferral lost lease');
    });
  });
  it('refuses stale ownership, expired leases, mismatched capture and stale claim attempts', async () => {
    await isolated(async (queue, tx, input, now) => {
      await queue.enqueue({ ...input, dueAt: now });
      const job = (await read(tx, input.hearingId))[0];
      await tx.$executeRawUnsafe(
        `UPDATE public_hearing_capture_job SET status='leased',lease_owner='timing-worker',lease_expires_at=now()+interval '5 minutes',attempts=3 WHERE id=$1`,
        job.id,
      );
      const claim = {
        jobId: job.id,
        hearingId: input.hearingId,
        captureId: input.captureId,
        workerId: 'timing-worker',
        claimedAttempts: 3,
        now,
        dueAt: new Date(now.getTime() + 3_600_000),
      };
      const before = await read(tx, input.hearingId);
      for (const changed of [
        { workerId: 'other' },
        { captureId: randomUUID() },
        { hearingId: 'other' },
        { claimedAttempts: 2 },
      ])
        await expect(queue.deferUntilStart({ ...claim, ...changed })).rejects.toThrow(
          'deferral lost lease',
        );
      expect(await read(tx, input.hearingId)).toEqual(before);
      await tx.$executeRawUnsafe(
        `UPDATE public_hearing_capture_job SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
        job.id,
      );
      await expect(queue.deferUntilStart(claim)).rejects.toThrow('deferral lost lease');
    });
  });
});
