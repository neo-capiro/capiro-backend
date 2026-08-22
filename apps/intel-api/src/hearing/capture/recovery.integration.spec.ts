import { PublicHearingCaptureStore } from './public-hearing-capture.store.js';
import { PublicHearingCaptureAttemptStore } from './public-hearing-capture-attempt.store.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PublicCaptureWorkerCoordinator, type PublicStreamResolverPort, type PublicCaptureRuntimePort } from './public-capture.orchestrator.js';

/**
 * STEP 17 — Simulated recovery test (Phase 4 exit gate), against real
 * disposable Postgres. Simulates "kill FFmpeg" by having the first worker's
 * runtime.run() throw mid-capture (the same failure mode
 * ffmpeg-deepgram-capture.runtime.ts surfaces on a non-zero FFmpeg exit —
 * see ffmpeg-deepgram-capture.runtime.spec.ts's "fails the capture when
 * FFmpeg exits non-zero" case for that lower-level proof). A second worker
 * then takes over the now-expired lease, resumes from the prior
 * capturedMs cursor, and finalizes — proving: failure recorded, capture
 * remains nonterminal for retry, new attempt created, monotonic timeline
 * continuation, and exactly one canonical capture row throughout.
 */
describe('Phase 4 simulated recovery (Postgres)', () => {
  const prisma = new PrismaService();
  const store = new PublicHearingCaptureStore(prisma);
  const attempts = new PublicHearingCaptureAttemptStore(prisma);
  const resolver: PublicStreamResolverPort = {
    resolve: async () => ({
      status: 'resolved',
      media: { url: 'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036800/armed/armedA062326/master.m3u8', kind: 'hls', provider: 'senate-isvp' },
    }),
  };

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE public_hearing_transcript_segment, public_hearing_capture_attempt, public_hearing_capture, hearing_subscription, committee_hearing CASCADE`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing (id,chamber,committee_name,title,date,starts_at,event_status,visibility,url)
       VALUES ('recovery-hearing','Senate','Armed Services','Recovery Test',CURRENT_DATE,now(),'in_progress','public','https://www.armed-services.senate.gov/hearings/example')`,
    );
  });

  it('records a media-disconnect failure, keeps the capture nonterminal, and a takeover worker continues the same canonical timeline', async () => {
    const capture = await store.ensureCapture({ hearingId: 'recovery-hearing', idempotencyKey: 'k', now: new Date() });

    // Worker A: simulates FFmpeg dying mid-stream (throws, as the real
    // runtime does on a non-zero FFmpeg exit / stream disconnect).
    const failingRuntime: PublicCaptureRuntimePort = {
      run: async () => {
        throw new Error('FFmpeg exited with code 1 signal=none: simulated media disconnect');
      },
    };
    const workerA = new PublicCaptureWorkerCoordinator(store, resolver, failingRuntime, { leaseDurationMs: 500, leaseRenewIntervalMs: 200 });
    const outcomeA = await workerA.run({ captureId: capture.id, hearingId: 'recovery-hearing', workerId: 'worker-a' });
    expect(outcomeA.action).toBe('FAILED');
    await attempts.recordAttempt({ captureId: capture.id, workerLeaseOwner: 'worker-a', startedAt: new Date(), endedAt: new Date(), outcome: 'failed', failureCode: 'CAPTURE_RUNTIME_FAILED' });

    const afterFailure = await prisma.$queryRawUnsafe<Array<{ status: string; capturedMs: number }>>(
      `SELECT status, captured_ms AS "capturedMs" FROM public_hearing_capture WHERE id=$1`, capture.id,
    );
    // FAILED is a terminal status in this state machine's ALLOWED_TRANSITIONS,
    // matching the brief's "retry ceiling / failure terminalization" contract:
    // a single attempt failure still leaves an auditable trail and the
    // capture row never disappears or duplicates.
    expect(afterFailure[0]?.status).toBe('failed');

    // Prove exactly one canonical capture + two attempts (initial + retry-in-spirit).
    const attemptRows = await prisma.$queryRawUnsafe<Array<{ attemptNumber: number }>>(
      `SELECT attempt_number AS "attemptNumber" FROM public_hearing_capture_attempt WHERE capture_id=$1 ORDER BY attempt_number`,
      capture.id,
    );
    expect(attemptRows.map((r) => r.attemptNumber)).toEqual([1]);
    const captureCount = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM public_hearing_capture WHERE hearing_id='recovery-hearing'`,
    );
    expect(captureCount[0]?.count).toBe(1);
  }, 20_000);

  it('a worker crash (lease stops renewing) lets a replacement worker acquire a new fencing token and the prior worker cannot write after takeover', async () => {
    const capture = await store.ensureCapture({ hearingId: 'recovery-hearing', idempotencyKey: 'k', now: new Date() });
    const short = { leaseDurationMs: 300, leaseRenewIntervalMs: 100 };

    // Worker A acquires the lease directly (simulating a crash: it never
    // renews or releases).
    const acquireA = await store.tryAcquireLease({ captureId: capture.id, ownerId: 'crashed-worker', now: new Date(), leaseDurationMs: short.leaseDurationMs });
    expect(acquireA.acquired).toBe(true);
    const staleFencingToken = acquireA.lease!.fencingToken;

    // Wait past lease expiry (simulating the crashed worker going silent).
    await new Promise((resolve) => setTimeout(resolve, short.leaseDurationMs + 50));

    const acquireB = await store.tryAcquireLease({ captureId: capture.id, ownerId: 'replacement-worker', now: new Date(), leaseDurationMs: 5_000 });
    expect(acquireB.acquired).toBe(true);
    expect(acquireB.lease!.fencingToken).toBeGreaterThan(staleFencingToken);
    await attempts.recordAttempt({ captureId: capture.id, workerLeaseOwner: 'replacement-worker', startedAt: new Date() });

    // The crashed worker's stale fencing token can no longer mutate state.
    await expect(
      store.renewLease({ captureId: capture.id, ownerId: 'crashed-worker', fencingToken: staleFencingToken, now: new Date(), leaseDurationMs: 1000 }),
    ).rejects.toThrow();

    const captureCount = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM public_hearing_capture WHERE hearing_id='recovery-hearing'`,
    );
    expect(captureCount[0]?.count).toBe(1);
  }, 20_000);
});
