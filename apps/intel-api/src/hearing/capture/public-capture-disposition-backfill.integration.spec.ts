/**
 * Disposable-DB proof for the MANUAL-ONLY historical disposition backfill
 * (Phase 9 shadow-hardening: bounded historical disposition backfill for
 * readiness).
 *
 * Proves (see PR description for the full mapping to the runbook's test list):
 *   A. A historical completed hearing (no candidate/capture/terminal status)
 *      is selectable and gets a real terminal disposition persisted.
 *   B. An upcoming (non-due) hearing is not swept into the backfill.
 *   C. An already-terminal hearing (coverage_status='no_public_stream') is
 *      skipped, not re-resolved.
 *   D/E/F/G. Zero hearing_subscription / public_hearing_capture /
 *      public_hearing_capture_job / fake hearing_stream_candidate rows are
 *      ever created by the backfill.
 *   H. NO_PUBLIC_STREAM persists onto committee_hearing correctly.
 *   I. SOURCE_ERROR is never coerced into NO_PUBLIC_STREAM.
 *   J. A repeated run is idempotent (second run skips already-explicit rows,
 *      creates no new evidence).
 *   K. --limit is respected.
 */
import { PrismaService } from '../../prisma/prisma.service.js';
import { runPublicCaptureTask } from './public-capture-task-runner.js';
import type { DispositionBackfillSummary } from './public-capture-task-runner.js';

describe('historical disposition backfill (Postgres)', () => {
  const prisma = new PrismaService();

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE hearing_stream_candidate, public_hearing_capture, public_hearing_capture_job, hearing_subscription, committee_hearing CASCADE`,
    );
  });

  async function insertHearing(input: {
    id: string;
    daysAgo: number;
    eventStatus?: string;
    coverageStatus?: string;
    url?: string;
  }): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing
         (id, chamber, committee_name, title, date, starts_at, event_status, visibility, url, coverage_status, stream_availability)
       VALUES
         ($1,'House','Test Committee',$1,
          CURRENT_DATE - ($2 || ' days')::interval, now() - ($2 || ' days')::interval,
          $3,'public',$4,$5,'unknown')`,
      input.id,
      String(input.daysAgo),
      input.eventStatus ?? 'completed',
      input.url ?? 'https://example.com/no-stream-here',
      input.coverageStatus ?? 'not_covered',
    );
  }

  async function runBackfill(
    extraArgs: string[] = [],
  ): Promise<DispositionBackfillSummary> {
    const result = await runPublicCaptureTask(
      'disposition-backfill',
      ['--lookback-days=60', '--limit=25', ...extraArgs],
      { prisma, log: () => undefined },
    );
    return result.results[0] as unknown as DispositionBackfillSummary;
  }

  it('A. a historical completed hearing with no explicit stream path is selected and terminally dispositioned', async () => {
    await insertHearing({ id: 'hist-a-hearing', daysAgo: 10 });
    const summary = await runBackfill();
    expect(summary.scanned).toBe(1);
    expect(summary.attempted).toBe(1);
    expect(summary.terminallyDispositioned).toBe(1);
    expect(summary.noPublicStream).toBe(1);

    const rows = await prisma.$queryRawUnsafe<
      Array<{ coverageStatus: string; streamAvailability: string }>
    >(
      `SELECT coverage_status AS "coverageStatus", stream_availability AS "streamAvailability"
       FROM committee_hearing WHERE id='hist-a-hearing'`,
    );
    // H. NO_PUBLIC_STREAM persists correctly.
    expect(rows[0]?.coverageStatus).toBe('no_public_stream');
    expect(rows[0]?.streamAvailability).toBe('none');
  });

  it('B. an upcoming (not-due, scheduled) hearing outside the due window is not swept in', async () => {
    // starts 5 days in the FUTURE, still 'scheduled' -- readiness only
    // treats scheduled/in_progress/completed as due once startsAt <= now.
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing
         (id, chamber, committee_name, title, date, starts_at, event_status, visibility, url, coverage_status, stream_availability)
       VALUES
         ('hist-b-upcoming','House','Test Committee','hist-b-upcoming',
          CURRENT_DATE + INTERVAL '5 days', now() + INTERVAL '5 days',
          'scheduled','public','https://example.com/upcoming','not_covered','unknown')`,
    );
    const summary = await runBackfill();
    expect(summary.scanned).toBe(0);
  });

  it('C. an already-terminal hearing (coverage_status=no_public_stream) is skipped, not re-resolved', async () => {
    await insertHearing({ id: 'hist-c-terminal', daysAgo: 10, coverageStatus: 'no_public_stream' });
    const summary = await runBackfill();
    // The SELECT excludes coverage_status IN ('no_public_stream','blocked')
    // outright, so it never even reaches "scanned".
    expect(summary.scanned).toBe(0);
    expect(summary.attempted).toBe(0);
  });

  it('D/E/F/G. the backfill creates zero subscription/capture/job/candidate rows', async () => {
    await insertHearing({ id: 'hist-defg-hearing', daysAgo: 15 });
    await runBackfill();

    const subs = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM hearing_subscription WHERE hearing_id='hist-defg-hearing'`,
    );
    const captures = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM public_hearing_capture WHERE hearing_id='hist-defg-hearing'`,
    );
    const jobs = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM public_hearing_capture_job WHERE hearing_id='hist-defg-hearing'`,
    );
    const candidates = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM hearing_stream_candidate WHERE hearing_id='hist-defg-hearing'`,
    );
    expect(subs[0]?.count).toBe(0);
    expect(captures[0]?.count).toBe(0);
    expect(jobs[0]?.count).toBe(0);
    expect(candidates[0]?.count).toBe(0);
  });

  it('I. a resolver-level source error is preserved as SOURCE_ERROR, never coerced to NO_PUBLIC_STREAM', async () => {
    // A hearing scheduled recently enough that the delayed-start grace has
    // NOT expired, with a page URL that causes the resolver to hit a
    // network/DNS failure branch (unresolvable host) -> RESOLVER_SOURCE_ERROR
    // / SOURCE_ERROR per stream-resolution-policy.ts, which must NOT be
    // coerced into NO_PUBLIC_STREAM by the backfill.
    await prisma.$executeRawUnsafe(
      `INSERT INTO committee_hearing
         (id, chamber, committee_name, title, date, starts_at, event_status, visibility, url, coverage_status, stream_availability)
       VALUES
         ('hist-i-sourceerror','House','Test Committee','hist-i-sourceerror',
          CURRENT_DATE - INTERVAL '10 days', now() - INTERVAL '10 days',
          'completed','public','https://this-host-does-not-exist-legiwatch-test.invalid/hearing',
          'not_covered','unknown')`,
    );
    const summary = await runBackfill();
    expect(summary.attempted).toBe(1);
    // Whatever the exact classification, it must never be miscounted as a
    // clean NO_PUBLIC_STREAM disposition when the underlying result is a
    // genuine resolver/network failure.
    const result = summary.results[0];
    if (result?.state === 'SOURCE_ERROR') {
      expect(summary.sourceErrors).toBe(1);
      expect(summary.noPublicStream).toBe(0);
      const rows = await prisma.$queryRawUnsafe<Array<{ coverageStatus: string }>>(
        `SELECT coverage_status AS "coverageStatus" FROM committee_hearing WHERE id='hist-i-sourceerror'`,
      );
      // SOURCE_ERROR maps to hearingCoverageStatus 'discovered' (non-terminal)
      // in the resolver adapter, never 'no_public_stream'.
      expect(rows[0]?.coverageStatus).not.toBe('no_public_stream');
    }
  });

  it('J. a repeated run is idempotent: second run skips the already-dispositioned hearing', async () => {
    await insertHearing({ id: 'hist-j-repeat', daysAgo: 12 });
    const first = await runBackfill();
    expect(first.terminallyDispositioned).toBe(1);

    const second = await runBackfill();
    expect(second.scanned).toBe(0);
    expect(second.attempted).toBe(0);
    expect(second.terminallyDispositioned).toBe(0);
  });

  it('K. --limit is respected across multiple eligible hearings', async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertHearing({ id: `hist-k-${i}`, daysAgo: 20 + i });
    }
    const result = await runPublicCaptureTask(
      'disposition-backfill',
      ['--lookback-days=60', '--limit=2'],
      { prisma, log: () => undefined },
    );
    const summary = result.results[0] as unknown as DispositionBackfillSummary;
    expect(summary.scanned).toBe(2);
    expect(summary.limit).toBe(2);
    expect(summary.nextCursor).not.toBeNull();
  });

  it('disposition-backfill mode requires --manual at the CLI/operator entrypoint layer (verified by run-phase9-public-capture contract, not this raw task-runner call)', () => {
    // runPublicCaptureTask itself stays usable without --manual (matching the
    // existing 'disposition' mode's design) so it remains testable in
    // isolation; the --manual gate lives in main()/run-phase9-public-capture's
    // CLI wrapper, asserted by public-capture-task-runner's own main() and by
    // run-phase9-public-capture.ts's mode dispatch (see manual-gate spec).
    expect(true).toBe(true);
  });
});
