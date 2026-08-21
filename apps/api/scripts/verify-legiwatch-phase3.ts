/**
 * LegiWatch Live Hearings Phase 3 — behavioural verification against a REAL
 * Postgres with the full migration history applied.
 *
 *   docker exec <pg> psql -U capiro -d postgres -c 'CREATE DATABASE legiwatch_p3_verify'
 *   DATABASE_URL=postgresql://capiro:capiro@localhost:5432/legiwatch_p3_verify \
 *     pnpm --filter @capiro/api exec prisma migrate deploy
 *   DATABASE_URL=... pnpm --filter @capiro/api exec tsx scripts/verify-legiwatch-phase3.ts
 *
 * WHY THIS EXISTS AS A SCRIPT, not a jest spec: the production Aurora cluster is
 * private-subnet (ECS-only), and this checkout has no test database, so the
 * Phase 2 migration spec is a STATIC guard over the SQL text. Static guards
 * cannot prove that two official sources reporting the same hearing actually
 * converge on one row — only a real database can. This script is that proof, in
 * the same shape as the disposable-Postgres replay Phase 2 was verified with.
 *
 * It REFUSES to run against anything that does not look like a disposable
 * verification database, so it can never be pointed at real data by accident.
 */
import { PrismaClient } from '@prisma/client';
import { HearingReconcilerService } from '../src/hearing-discovery/hearing-reconciler.service.js';
import { CommitteeSourceRepository } from '../src/hearing-discovery/committee-source.repository.js';
import { CoverageAuditService } from '../src/hearing-discovery/coverage-audit.service.js';
import { SourceRegistryService } from '../src/hearing-discovery/source-registry.service.js';
import type { SourceEvent } from '../src/hearing-discovery/hearing-discovery.types.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SYSTEM_CODE = 'ssas00';
const CONGRESS = 119;
const EVENT_DAY = new Date(Date.UTC(2026, 8, 17));
/** 09:30 America/New_York on 2026-09-17 (EDT, UTC-4). */
const EVENT_START = new Date('2026-09-17T13:30:00.000Z');

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 66 - name.length))}`);
}

/** Guard: only ever run against an obviously disposable database. */
function assertDisposableTarget(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('DATABASE_URL is required');
  const dbName = url.split('/').pop()?.split('?')[0] ?? '';
  const localHost = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url);
  const disposableName = /verify|test|tmp|scratch|disposable/i.test(dbName);
  if (!localHost || !disposableName) {
    throw new Error(
      `refusing to run: DATABASE_URL must point at a LOCAL database whose name contains ` +
        `verify/test/tmp/scratch (got host-local=${localHost}, db="${dbName}")`,
    );
  }
}

/** The Congress.gov view of the hearing. */
function congressEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    externalEventId: '999001',
    congress: CONGRESS,
    chamber: 'senate',
    committeeSystemCode: SYSTEM_CODE,
    subcommitteeSystemCode: null,
    committeeName: 'Senate Committee on Armed Services',
    title: 'Oversight of the National Defense Strategy',
    eventType: 'Hearing',
    eventStatus: 'scheduled',
    visibility: 'public',
    startsAt: EVENT_START,
    calendarDate: EVENT_DAY,
    displayTime: '9:30 AM',
    location: 'SVC-217',
    officialPageUrl: `https://www.congress.gov/event/119th-Congress/senate-event/999001`,
    witnesses: ['Jane Doe, Secretary, DoD'],
    agendaBillIds: [],
    sourceUpdatedAt: new Date('2026-08-19T10:00:00.000Z'),
    streamCandidates: [],
    ...overrides,
  };
}

/** The Senate central schedule's view of the SAME hearing — no Congress.gov eventId. */
function senateEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    externalEventId: '338724',
    congress: CONGRESS,
    chamber: 'senate',
    committeeSystemCode: SYSTEM_CODE,
    subcommitteeSystemCode: null,
    committeeName: 'Armed Services',
    title: 'Oversight of the National Defense Strategy',
    eventType: 'Open Hearing',
    eventStatus: 'scheduled',
    visibility: 'public',
    startsAt: EVENT_START,
    calendarDate: EVENT_DAY,
    displayTime: '9:30 AM',
    location: 'SVC-217',
    officialPageUrl: 'https://www.senate.gov/general/committee_schedules/hearings.xml',
    witnesses: [],
    agendaBillIds: [],
    sourceUpdatedAt: new Date('2026-08-19T12:00:00.000Z'),
    streamCandidates: [
      { provider: 'senate-isvp', officialPageUrl: 'https://www.senate.gov/isvp/?comm=armed' },
    ],
    ...overrides,
  };
}

/**
 * Truncate everything this verification writes, so the script is re-runnable and
 * every count assertion below means what it says. Safe only because
 * assertDisposableTarget() has already refused any non-disposable database.
 */
async function reset(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    public_hearing_transcript_segment,
    public_hearing_capture_attempt,
    public_hearing_capture,
    hearing_stream_candidate,
    hearing_source_observation,
    committee_site_update,
    committee_source,
    hearing_subscription,
    hearing_auto_record_rule,
    committee_hearing
  CASCADE`);
}

async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.tenant.upsert({
    where: { id: TENANT_A },
    create: { id: TENANT_A, slug: 'p3-tenant-a', name: 'Phase 3 Tenant A', status: 'active' },
    update: {},
  });
  await prisma.tenant.upsert({
    where: { id: TENANT_B },
    create: { id: TENANT_B, slug: 'p3-tenant-b', name: 'Phase 3 Tenant B', status: 'active' },
    update: {},
  });
  await prisma.congressCommittee.upsert({
    where: { systemCode: SYSTEM_CODE },
    create: {
      systemCode: SYSTEM_CODE,
      thomasId: 'SSAS',
      name: 'Senate Committee on Armed Services',
      chamber: 'senate',
      parentSystemCode: null,
      url: 'https://www.armed-services.senate.gov',
      isCurrent: true,
    },
    update: {},
  });
  // A second body with NO official URL, so the coverage audit has something to
  // classify as unregisterable rather than only ever reporting the happy path.
  await prisma.congressCommittee.upsert({
    where: { systemCode: 'ssbk00' },
    create: {
      systemCode: 'ssbk00',
      thomasId: 'SSBK',
      name: 'Senate Committee on Banking, Housing, and Urban Affairs',
      chamber: 'senate',
      parentSystemCode: null,
      url: null,
      isCurrent: true,
    },
    update: {},
  });
}

async function main(): Promise<void> {
  assertDisposableTarget();
  const prisma = new PrismaClient();
  const now = new Date('2026-08-20T12:00:00.000Z');

  try {
    await reset(prisma);
    await seed(prisma);
    const sources = new CommitteeSourceRepository(prisma);
    const registry = new SourceRegistryService(prisma);
    const reconciler = new HearingReconcilerService(prisma);

    const central = await registry.ensureCentralSources(CONGRESS);
    const congressSource = central.find((s) => s.adapterKey === 'congress-gov');
    const senateSource = central.find((s) => s.adapterKey === 'senate-schedule');
    if (!congressSource || !senateSource) throw new Error('central sources were not registered');

    section('A. Source registry');
    check(
      'three central sources registered',
      central.length === 3,
      central.map((s) => s.adapterKey),
    );
    check(
      'congress-gov outranks senate-schedule (lower priority wins)',
      congressSource.priority < senateSource.priority,
      { congress: congressSource.priority, senate: senateSource.priority },
    );
    const reRegistered = await registry.ensureCentralSources(CONGRESS);
    check(
      're-registering is idempotent (same ids, no duplicates)',
      reRegistered.every((s, i) => s.id === central[i]?.id) &&
        (await prisma.committeeSource.count({ where: { committeeSystemCode: null } })) === 3,
    );

    section('B. Two official sources → ONE canonical hearing');
    const first = await reconciler.reconcileEvent(congressSource, congressEvent(), now);
    check('Congress.gov event creates a canonical hearing', first.hearingCreated, first);
    check(
      'canonical id uses the legacy cm-{congress}-{eventId} convention',
      first.hearingId === 'cm-119-999001',
      first.hearingId,
    );

    const second = await reconciler.reconcileEvent(senateSource, senateEvent(), now);
    check(
      'Senate feed MATCHES the existing hearing instead of creating a second one',
      !second.hearingCreated && second.hearingId === first.hearingId,
      { match: second.match, hearingId: second.hearingId },
    );
    check(
      'it matched on the natural (committee + day + ET clock) rung',
      second.match === 'natural',
      second.match,
    );
    const hearingCount = await prisma.committeeHearing.count();
    check('exactly ONE canonical hearing row exists', hearingCount === 1, { hearingCount });

    section('C. Provenance ledger');
    const observations = await prisma.hearingSourceObservation.findMany({
      where: { hearingId: first.hearingId },
      include: { source: { select: { adapterKey: true } } },
    });
    check('both sources left an observation', observations.length === 2, observations.length);
    check(
      'every observation is linked to the canonical hearing',
      observations.every((o) => o.hearingId === first.hearingId),
    );
    check(
      "each source's own words are preserved, not flattened",
      observations.some((o) => o.observedStatus === 'scheduled') &&
        new Set(observations.map((o) => o.source.adapterKey)).size === 2,
      observations.map((o) => ({ adapter: o.source.adapterKey, title: o.observedTitle })),
    );

    section('D. Projection authority');
    const projected = await prisma.committeeHearing.findUniqueOrThrow({
      where: { id: first.hearingId },
    });
    check(
      'the higher-authority committee name won',
      projected.committeeName === 'Senate Committee on Armed Services',
      projected.committeeName,
    );
    check(
      'the higher-authority witness list was not erased by the thinner source',
      projected.witnesses.length === 1 && (projected.witnesses[0] ?? '').startsWith('Jane Doe'),
      projected.witnesses,
    );
    check(
      'canonical Phase 2 columns are populated',
      projected.congress === CONGRESS && projected.committeeSystemCode === SYSTEM_CODE,
      {
        congress: projected.congress,
        systemCode: projected.committeeSystemCode,
      },
    );
    check(
      'the advertised Senate stream candidate was recorded',
      (await prisma.hearingStreamCandidate.count({ where: { hearingId: first.hearingId } })) === 1,
    );
    check(
      'the candidate is UNPROBED and NOT server-capturable',
      await (async () => {
        const c = await prisma.hearingStreamCandidate.findFirstOrThrow({
          where: { hearingId: first.hearingId },
        });
        return c.resolutionState === 'NOT_CHECKED' && c.capturePolicy !== 'SERVER_CAPTURE_ALLOWED';
      })(),
    );

    section('E. Idempotency — the acceptance property');
    const beforeCounts = {
      hearings: await prisma.committeeHearing.count(),
      observations: await prisma.hearingSourceObservation.count(),
      updates: await prisma.committeeSiteUpdate.count(),
      candidates: await prisma.hearingStreamCandidate.count(),
      revision: projected.sourceRevision,
    };
    await reconciler.reconcileEvent(congressSource, congressEvent(), now);
    await reconciler.reconcileEvent(senateSource, senateEvent(), now);
    const afterCounts = {
      hearings: await prisma.committeeHearing.count(),
      observations: await prisma.hearingSourceObservation.count(),
      updates: await prisma.committeeSiteUpdate.count(),
      candidates: await prisma.hearingStreamCandidate.count(),
      revision: (
        await prisma.committeeHearing.findUniqueOrThrow({ where: { id: first.hearingId } })
      ).sourceRevision,
    };
    check(
      'a repeat run of both sources adds NOTHING',
      JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
      { beforeCounts, afterCounts },
    );

    section('F. Schedule change updates the SAME hearing');
    const movedDay = new Date(Date.UTC(2026, 8, 24));
    await reconciler.reconcileEvent(
      congressSource,
      congressEvent({ calendarDate: movedDay, startsAt: new Date('2026-09-24T13:30:00.000Z') }),
      now,
    );
    check(
      'still exactly one canonical hearing after the reschedule',
      (await prisma.committeeHearing.count()) === 1,
    );
    const dateChanges = await prisma.committeeSiteUpdate.findMany({
      where: { hearingId: first.hearingId, updateType: 'date_changed' },
    });
    check('a date_changed signal was filed', dateChanges.length === 1, dateChanges.length);
    check(
      'the signal carries the actual previous and new values',
      dateChanges[0]?.previousValue === '2026-09-17' && dateChanges[0]?.newValue === '2026-09-24',
      { prev: dateChanges[0]?.previousValue, next: dateChanges[0]?.newValue },
    );
    const afterMove = await prisma.committeeHearing.findUniqueOrThrow({
      where: { id: first.hearingId },
    });
    check(
      'source_revision advanced because a previously-observed field changed',
      afterMove.sourceRevision > beforeCounts.revision,
      { before: beforeCounts.revision, after: afterMove.sourceRevision },
    );
    check(
      'the legacy-owned date column was NOT fought over (sync-hearings owns cm-* rows)',
      afterMove.date.toISOString().slice(0, 10) === '2026-09-17',
      afterMove.date.toISOString(),
    );
    const beforeDup = await prisma.committeeSiteUpdate.count();
    await reconciler.reconcileEvent(
      congressSource,
      congressEvent({ calendarDate: movedDay, startsAt: new Date('2026-09-24T13:30:00.000Z') }),
      now,
    );
    check(
      'the same change is not re-filed on a repeat run (contentHash dedupe)',
      (await prisma.committeeSiteUpdate.count()) === beforeDup,
    );

    section('G. Cancellation');
    await reconciler.reconcileEvent(
      congressSource,
      congressEvent({ eventStatus: 'canceled' }),
      now,
    );
    const canceled = await prisma.committeeHearing.findUniqueOrThrow({
      where: { id: first.hearingId },
    });
    check('event_status moved to canceled on the same row', canceled.eventStatus === 'canceled');
    check(
      'a canceled signal was filed',
      (await prisma.committeeSiteUpdate.count({
        where: { hearingId: first.hearingId, updateType: 'canceled' },
      })) === 1,
    );
    await reconciler.reconcileEvent(senateSource, senateEvent({ eventStatus: null }), now);
    check(
      'a source that says NOTHING about status does not resurrect the hearing',
      (await prisma.committeeHearing.findUniqueOrThrow({ where: { id: first.hearingId } }))
        .eventStatus === 'canceled',
    );

    section('H. A Senate-only event is owned by this phase');
    const senateOnly = await reconciler.reconcileEvent(
      senateSource,
      senateEvent({
        externalEventId: '338999',
        title: 'Nomination of a Deputy Under Secretary',
        calendarDate: new Date(Date.UTC(2026, 9, 1)),
        startsAt: new Date('2026-10-01T14:00:00.000Z'),
      }),
      now,
    );
    check('a Senate-only event creates its own canonical row', senateOnly.hearingCreated);
    check(
      'the id is keyed on the feed own stable identifier, NOT on the schedule',
      senateOnly.hearingId === 'sen-119-338999',
      senateOnly.hearingId,
    );
    const beforeReschedule = await prisma.committeeHearing.count();
    const rescheduled = await reconciler.reconcileEvent(
      senateSource,
      senateEvent({
        externalEventId: '338999',
        title: 'Nomination of a Deputy Under Secretary',
        calendarDate: new Date(Date.UTC(2026, 9, 8)),
        startsAt: new Date('2026-10-08T14:00:00.000Z'),
      }),
      now,
    );
    // REGRESSION GUARD. Before the observation rung existed, moving this hearing
    // changed its derived id, the reconciler saw an unknown event, and it FORKED
    // a second canonical row for the same official event.
    check(
      'moving a phase-owned hearing does NOT fork a duplicate row',
      (await prisma.committeeHearing.count()) === beforeReschedule &&
        rescheduled.hearingId === senateOnly.hearingId,
      {
        before: beforeReschedule,
        after: await prisma.committeeHearing.count(),
        reschedTo: rescheduled.hearingId,
      },
    );
    check(
      'and it matched on the observation rung (same source, same external id)',
      rescheduled.match === 'observation',
      rescheduled.match,
    );
    const senateRow = await prisma.committeeHearing.findUniqueOrThrow({
      where: { id: senateOnly.hearingId },
    });
    check(
      'a reschedule DOES rewrite the date on a phase-owned row',
      senateRow.date.toISOString().slice(0, 10) === '2026-10-08',
      senateRow.date.toISOString(),
    );

    section('I. One capture per hearing (Phase 2 invariant, re-verified)');
    await prisma.publicHearingCapture.create({
      data: { hearingId: first.hearingId, status: 'scheduled' },
    });
    let duplicateRejected = false;
    let duplicateError = '';
    try {
      await prisma.publicHearingCapture.create({
        data: { hearingId: first.hearingId, status: 'scheduled' },
      });
    } catch (err) {
      duplicateRejected = true;
      duplicateError = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
    }
    check(
      'the DB rejects a second capture for the same hearing',
      duplicateRejected,
      duplicateError,
    );
    check(
      'exactly one capture row survives',
      (await prisma.publicHearingCapture.count({ where: { hearingId: first.hearingId } })) === 1,
    );

    section('J. Two tenants, one capture, isolated overlays');
    for (const [tenantId, userId] of [
      [TENANT_A, 'user-a'],
      [TENANT_B, 'user-b'],
    ] as const) {
      await prisma.hearingSubscription.upsert({
        where: { tenantId_userId_hearingId: { tenantId, userId, hearingId: first.hearingId } },
        create: { tenantId, userId, hearingId: first.hearingId, clientIds: [`client-${userId}`] },
        update: {},
      });
    }
    check(
      'two tenants subscribed to the same hearing',
      (await prisma.hearingSubscription.count({ where: { hearingId: first.hearingId } })) === 2,
    );
    check(
      'and there is still exactly ONE capture and ONE hearing',
      (await prisma.publicHearingCapture.count({ where: { hearingId: first.hearingId } })) === 1 &&
        (await prisma.committeeHearing.count({ where: { id: first.hearingId } })) === 1,
    );

    // Behavioural RLS: the app role is NOT the table owner, so the policy must
    // fire. This is the part a static SQL guard cannot prove.
    // `DROP ROLE` fails while the role still holds grants from a previous run, so
    // its privileges are dropped first. Re-runnability matters: a verification
    // script that only works on a virgin database is a script nobody re-runs.
    await prisma.$executeRawUnsafe(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p3_app') THEN
          EXECUTE 'DROP OWNED BY p3_app';
          EXECUTE 'DROP ROLE p3_app';
        END IF;
      END
    $$`);
    await prisma.$executeRawUnsafe(`CREATE ROLE p3_app NOLOGIN`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO p3_app`);
    await prisma.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO p3_app`);
    const visibleToA = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM (
         SELECT set_config('app.current_tenant', '${TENANT_A}', true)
       ) cfg, hearing_subscription`,
    );
    // The count above runs as the owner; re-run under the restricted role.
    const rlsProbe = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE p3_app`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', '${TENANT_A}', true)`);
      const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM hearing_subscription`,
      );
      return Number(rows[0]?.n ?? -1);
    });
    check(
      'under a non-owner role, RLS shows tenant A exactly its own 1 subscription',
      rlsProbe === 1,
      { rlsProbe, ownerSaw: Number(visibleToA[0]?.n ?? -1) },
    );
    const rlsProbeOther = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE p3_app`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', '${TENANT_B}', true)`);
      const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM hearing_subscription WHERE tenant_id = '${TENANT_A}'::uuid`,
      );
      return Number(rows[0]?.n ?? -1);
    });
    check(
      "tenant B cannot see tenant A's subscription even when it asks for it by id",
      rlsProbeOther === 0,
      { rlsProbeOther },
    );
    check(
      'the global transcript/capture tables carry NO tenant column at all',
      await (async () => {
        const cols = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
          `SELECT table_name FROM information_schema.columns
            WHERE column_name = 'tenant_id'
              AND table_name IN ('public_hearing_capture','public_hearing_transcript_segment',
                                 'hearing_source_observation','hearing_stream_candidate',
                                 'committee_site_update','committee_source')`,
        );
        return cols.length === 0;
      })(),
    );

    section('K. Source health is observable');
    await sources.recordOutcome(senateSource.id, { ok: false, error: 'HTTP 503' }, now);
    const failing = await prisma.committeeSource.findUniqueOrThrow({
      where: { id: senateSource.id },
    });
    check(
      'a failure with no prior success is FAILING, not merely degraded',
      failing.sourceHealth === 'failing' && failing.lastError === 'HTTP 503',
      { health: failing.sourceHealth, error: failing.lastError },
    );
    await sources.recordOutcome(senateSource.id, { ok: true, observedEvents: 2 }, now);
    const healed = await prisma.committeeSource.findUniqueOrThrow({
      where: { id: senateSource.id },
    });
    check(
      'a success clears the stale error text as well as the state',
      healed.sourceHealth === 'healthy' && healed.lastError === null,
      { health: healed.sourceHealth, error: healed.lastError },
    );
    await sources.recordOutcome(senateSource.id, { ok: false, error: 'timeout' }, now);
    const degraded = await prisma.committeeSource.findUniqueOrThrow({
      where: { id: senateSource.id },
    });
    check(
      'a failure shortly after a success is DEGRADED, not failing',
      degraded.sourceHealth === 'degraded',
      degraded.sourceHealth,
    );

    section('L. Coverage audit reports measured, not assumed, coverage');
    const siteSources = await registry.ensureCommitteeSiteSources();
    check(
      'a body with an official URL gets a committee-site source',
      siteSources.registered === 1,
      siteSources.registered,
    );
    check(
      'a body with NO official URL is reported as unregisterable, not silently skipped',
      siteSources.skippedNoUrl.map((b) => b.systemCode).includes('ssbk00'),
      siteSources.skippedNoUrl.map((b) => b.systemCode),
    );
    const report = await new CoverageAuditService(prisma).run({ now, windowDays: 90 });
    check('every body gets exactly one status', report.totals.bodies === report.bodies.length);
    const armed = report.bodies.find((b) => b.systemCode === SYSTEM_CODE);
    const banking = report.bodies.find((b) => b.systemCode === 'ssbk00');
    check(
      'the body with discovered hearings is not reported as unavailable',
      armed != null && armed.hearingsDiscovered > 0 && armed.status !== 'UNAVAILABLE',
      { status: armed?.status, discovered: armed?.hearingsDiscovered },
    );
    check(
      'the body with no URL and no events is flagged for review, not called healthy',
      banking != null && banking.status !== 'HEALTHY',
      banking?.status,
    );
    check(
      'NO body is reported as server-capture-allowed in Phase 3',
      report.bodies.every((b) => b.serverCaptureAllowed === false),
    );
    console.log(
      `\n  coverage totals: ${JSON.stringify(report.totals)}\n` +
        report.bodies.map((b) => `    ${b.systemCode} ${b.status} — ${b.reason}`).join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Phase 3 verification: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(72));
  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[verify-legiwatch-phase3] FAILED', err);
    process.exit(1);
  });
}
