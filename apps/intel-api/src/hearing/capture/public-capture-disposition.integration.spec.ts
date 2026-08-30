/**
 * Disposable-DB proof for the demand-free stream-disposition path (Step 5-8
 * of the LegiWatch Phase 9 shadow-hardening plan).
 *
 * Proves:
 *   A. Existing capture demand behavior is UNCHANGED: zero subscriptions +
 *      captureAll=false -> PublicCaptureOrchestrator.reconcile() still
 *      returns NO_CAPTURE_DEMAND.
 *   B. Demand-free disposition: a completed public hearing with no
 *      subscriptions and no discoverable public media resolves to a
 *      NO_PUBLIC_STREAM-shaped disposition via the disposition task mode,
 *      reusing the SAME resolver/policy captures use.
 *   C. It creates 0 hearing_subscription rows, 0 public_hearing_capture
 *      rows, 0 capture jobs.
 *   D. Candidate integrity: no fake hearing_stream_candidate row is created.
 *   E. Safety: the disposition path cannot enqueue a capture job (there is
 *      no queue reference in its code path at all).
 */
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { SourceDataRepository } from '../../sourcedata/source-data.repository.js';
import { StreamResolverService } from '../stream-resolver.service.js';
import { PublicCaptureAutomaticResolverAdapter } from './public-capture-automatic-resolver.adapter.js';
import { PublicHearingCaptureStore } from './public-hearing-capture.store.js';
import { PublicCapturePersistentQueueAdapter } from './public-capture-persistent-queue.adapter.js';
import { PublicCaptureOrchestrator } from './public-capture.orchestrator.js';
import { runPublicCaptureTask } from './public-capture-task-runner.js';

describe('demand-free stream disposition (Postgres)', () => {
  const prisma = new PrismaService();
  const store = new PublicHearingCaptureStore(prisma);
  const queue = new PublicCapturePersistentQueueAdapter(prisma);

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE hearing_stream_candidate, public_hearing_capture, hearing_subscription, committee_hearing CASCADE`,
    );
    // A completed public hearing, well past any delayed-start grace, with NO
    // discoverable public media. The url must resolve to a REAL, reachable
    // public host (example.com) so the resolver reaches "page has no
    // player/embed" rather than an SSRF/DNS-failure branch — this is what
    // actually produces NO_PUBLIC_STREAM/NO_MEDIA_DISCOVERED, as opposed to
    // SOURCE_ERROR/RESOLVER_NETWORK_POLICY_BLOCK for an unreachable host.
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing
         (id, chamber, committee_name, title, date, starts_at, event_status, visibility, url, coverage_status, stream_availability)
       VALUES
         ('disposition-test-hearing','House','Test Committee','No Public Stream Test',
          CURRENT_DATE - INTERVAL '3 days', now() - INTERVAL '3 days',
          'completed','public','https://example.com/no-stream-here',
          'not_covered','unknown')`,
    );
  });

  function buildResolver(): PublicCaptureAutomaticResolverAdapter {
    const resolver = new StreamResolverService(new ConfigService(), new SourceDataRepository(prisma));
    return new PublicCaptureAutomaticResolverAdapter(prisma, resolver);
  }

  it('A. existing capture-demand behavior is unchanged: zero demand still returns NO_CAPTURE_DEMAND', async () => {
    const orchestrator = new PublicCaptureOrchestrator(store, buildResolver(), queue);
    const outcome = await orchestrator.reconcile('disposition-test-hearing');
    expect(outcome.action).toBe('NO_CAPTURE_DEMAND');

    // C. Confirm reconcile() itself (the pre-existing demand-gated path)
    // also creates nothing when demand is absent.
    const subs = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM hearing_subscription WHERE hearing_id='disposition-test-hearing'`,
    );
    const captures = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM public_hearing_capture WHERE hearing_id='disposition-test-hearing'`,
    );
    expect(subs[0]?.count).toBe(0);
    expect(captures[0]?.count).toBe(0);
  });

  it('B/C/D. the disposition task mode resolves a terminal disposition without any demand-side side effect', async () => {
    const result = await runPublicCaptureTask(
      'disposition',
      [`--hearingId=disposition-test-hearing`],
      { prisma, log: () => undefined },
    );

    expect(result.mode).toBe('disposition');
    expect(result.failed).toBe(0);
    expect(result.completed).toBe(1);

    // The disposition path returns the SAME shape the resolver always
    // returns (ResolverResultLike) — the classified terminal disposition
    // itself is verified below via the persisted committee_hearing row,
    // which is the actual durable outcome this path exists to produce.
    const resolved = result.results[0]?.resolved as { status: string } | undefined;
    expect(resolved?.status).toBe('unresolvable');

    // Persisted onto the canonical hearing row — the actual durable
    // disposition, not just a returned value.
    const hearingRows = await prisma.$queryRawUnsafe<
      Array<{ coverageStatus: string; streamAvailability: string }>
    >(
      `SELECT coverage_status AS "coverageStatus", stream_availability AS "streamAvailability"
       FROM committee_hearing WHERE id='disposition-test-hearing'`,
    );
    // NO_MEDIA_DISCOVERED / DELAYED_START_GRACE_EXPIRED both classify to the
    // SAME hearing-level disposition (coverage_status='no_public_stream',
    // stream_availability='none') — both are legitimate NO_PUBLIC_STREAM
    // outcomes for a completed hearing with no discovered stream. If the
    // resolver instead reports something resolved/ready, this assertion
    // intentionally fails loudly rather than silently accepting a wrong
    // disposition.
    expect(hearingRows[0]?.coverageStatus).toBe('no_public_stream');
    expect(hearingRows[0]?.streamAvailability).toBe('none');

    // C. Zero demand-side rows created by the disposition path.
    const subs = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM hearing_subscription WHERE hearing_id='disposition-test-hearing'`,
    );
    const captures = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM public_hearing_capture WHERE hearing_id='disposition-test-hearing'`,
    );
    const queuedJobs = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM public_hearing_capture_job WHERE hearing_id='disposition-test-hearing'`,
    );
    expect(subs[0]?.count).toBe(0);
    expect(captures[0]?.count).toBe(0);
    expect(queuedJobs[0]?.count).toBe(0);

    // D. Candidate integrity for a NO_PUBLIC_STREAM disposition: the path
    // never CREATES a candidate row when no stream was discovered. (A
    // READY_FOR_SERVER_CAPTURE result with a real first-party target DOES
    // insert one durable candidate — see adapter persistAudit — so that
    // STREAM_PATH_EXPLICIT can close; that is covered separately.)
    const candidates = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM hearing_stream_candidate WHERE hearing_id='disposition-test-hearing'`,
    );
    expect(candidates[0]?.count).toBe(0);
  });

  it('disposition mode requires an explicit --hearingId (never scans due hearings implicitly)', async () => {
    await expect(
      runPublicCaptureTask('disposition', [], { prisma, log: () => undefined }),
    ).rejects.toThrow(/requires --hearingId/);
  });

  it('E. after disposition, capture demand still correctly returns NO_CAPTURE_DEMAND (disposition never created demand)', async () => {
    await runPublicCaptureTask('disposition', [`--hearingId=disposition-test-hearing`], {
      prisma,
      log: () => undefined,
    });
    const orchestrator = new PublicCaptureOrchestrator(store, buildResolver(), queue);
    const outcome = await orchestrator.reconcile('disposition-test-hearing');
    expect(outcome.action).toBe('NO_CAPTURE_DEMAND');
  });
});
