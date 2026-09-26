/**
 * Business Development Phase 5 — REAL PostgreSQL/Prisma rehearsal for the
 * resumable watch scan runner (federal_award paging), against the disposable
 * LOCAL database "capiro_bizdev_watch_paging_20260926".
 *
 * Delegation bounds (from root):
 *   * This is a NEW, standalone file only — never imported by app code.
 *   * No network providers, no ingestion, no production or default DATABASE_URL.
 *   * Requires BIZDEV_WATCH_REHEARSAL_DATABASE_URL; parses it BEFORE any
 *     PrismaClient construction; refuses any host except localhost /
 *     127.0.0.1 and any database except the dedicated one above. Never
 *     prints URLs, credentials, or environment values.
 *   * Runs the REAL evaluator (runBizDevWatchEvaluation) over REAL Prisma
 *     projection delegates and the REAL transactional
 *     watch/source-state/alert/delivery/activity tables — no in-memory mock.
 *     withTenant/withSystem mirror the repository semantics (SET LOCAL ROLE
 *     capiro_app, app.bypass_rls, app.current_tenant), with capiro_app
 *     asserted non-superuser/non-BYPASSRLS exactly once up front.
 *   * All fixture data is LOCAL synthetic test data with unique UUID / UEI /
 *     award-id prefixes; cleanup removes ONLY those exact generated ids,
 *     FK-ordered. Prisma disconnects even on failure. Failures exit 1 with
 *     concise sanitized count/assertion messages (never full rows or raw
 *     driver errors that could embed credentials).
 *
 * Bounded scenario (root checkpoint — one safe minimal sequence):
 *   Stage 1  Quiet resumable initial scan: 292 awards / 50 per page → 6
 *            pages per cycle; drive bounded runs until BOTH tenants'
 *            sources complete. Every earlier page keeps baselinedAt /
 *            watermark NULL (real checkpoint constraint accepts the staged
 *            JSON), zero alerts/deliveries; final initialized records maps
 *            each hold exactly 292 entries.
 *   Stage 2  ONE material amount change on the first-page record: the page
 *            that reads it produces EXACTLY 1 alert + 1 in-app delivery + 1
 *            alert activity for tenant A (material_update/high, unique
 *            dedupe key) and a persisted watch_paused suppression for
 *            tenant B (0 alerts / 0 deliveries). Watermark unchanged on the
 *            non-final page.
 *   Stage 3  Unchanged replay: full cycles complete with ZERO additional
 *            alert/delivery/activity records.
 *
 *   Stage 4  A→B→A→B across complete cycles with unchanged replays: three
 *            unique alerts/deliveries/activities, paused tenant still zero.
 *   Stage 5  Owner revoked between pages: pending, checkpoint and completion
 *            markers unchanged, no extra delivery, lease released.
 *   Stage 6  Actual app-role cross-tenant reads see zero foreign alerts and
 *            deliveries; tenant A sees its own three deliveries only.
 * Behind-cursor insertion is covered by the unit suite, not this rehearsal.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  runBizDevWatchEvaluation,
  type BizDevWatchRunConfig,
  type BizDevWatchRunnerDb,
  type BizDevProjectionDb,
} from '../../src/business-development/bizdev-watch-runner.js';

const ALLOWED_DATABASE = 'capiro_bizdev_watch_paging_20260926';
const MAX_RUNS = 80;
const AWARD_ROWS = 292;
const PAGE_SIZE = 50;

class RehearsalFailure extends Error {}

function fail(message: string): never {
  throw new RehearsalFailure(message);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(`assertion failed: ${message}`);
}

/** Sanitized error text: our own messages verbatim; anything else reduced to
 * a class name + Prisma error code — never a driver message (credentials). */
function sanitize(error: unknown): string {
  if (error instanceof RehearsalFailure) return error.message;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return `unexpected ${name}${typeof code === 'string' ? ` (${code})` : ''}`;
}

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// ── Environment guard (BEFORE any PrismaClient construction) ──────────────

function requireRehearsalUrl(): string {
  const raw = process.env.BIZDEV_WATCH_REHEARSAL_DATABASE_URL;
  if (typeof raw !== 'string' || raw.length === 0) {
    fail(
      'BIZDEV_WATCH_REHEARSAL_DATABASE_URL is required (local disposable rehearsal database only)',
    );
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    fail('rehearsal database URL is not a valid URL');
  }
  if (parsed === null) fail('rehearsal database URL is not a valid URL');
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    (parsed.port !== '' && parsed.port !== '5432') ||
    parsed.search ||
    parsed.hash
  ) {
    fail('rehearsal requires PostgreSQL on local port 5432 without URL options or fragments');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1') {
    fail('rehearsal database URL must target localhost or 127.0.0.1');
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (database !== ALLOWED_DATABASE) {
    fail(`rehearsal database URL must target the dedicated local database "${ALLOWED_DATABASE}"`);
  }
  return raw;
}

// ── Fixtures (exact generated ids only; unique prefixes per run) ──────────

interface Fixtures {
  stamp: string;
  prefix: string;
  uei: string;
  tenantA: string;
  tenantB: string;
  ownerA: string;
  ownerB: string;
  membershipA: string;
  membershipB: string;
  orgEntity: string;
  orgIdentifier: string;
  prospectA: string;
  prospectB: string;
  watchA: string;
  watchB: string;
  stateA: string;
  stateB: string;
  awardIds: string[];
  targetAwardId: string;
  targetRecordId: string;
}

function makePlan(): Fixtures {
  const stamp = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return {
    stamp,
    prefix: `CONT_BDWR${stamp}`,
    // 12-char unique synthetic UEI (exact-identifier anchor; never a real UEI)
    uei: `R${randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase()}`,
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    ownerA: randomUUID(),
    ownerB: randomUUID(),
    membershipA: randomUUID(),
    membershipB: randomUUID(),
    orgEntity: randomUUID(),
    orgIdentifier: randomUUID(),
    prospectA: randomUUID(),
    prospectB: randomUUID(),
    watchA: randomUUID(),
    watchB: randomUUID(),
    stateA: randomUUID(),
    stateB: randomUUID(),
    awardIds: Array.from({ length: AWARD_ROWS }, () => randomUUID()),
    targetAwardId: '',
    targetRecordId: '',
  };
}

async function seed(prisma: PrismaClient, f: Fixtures): Promise<void> {
  const orgName = `BD Watch Rehearsal ${f.stamp} Inc`;
  // Enrollment flags the runner's SYSTEM discovery requires (fail-closed SQL):
  // settings_jsonb.clioFeatureFlags ->> 'businessDevelopment.enabled' and
  // ->> 'businessDevelopment.watch.enabled' must both resolve 'true'.
  const settings = {
    clioFeatureFlags: {
      'businessDevelopment.enabled': true,
      'businessDevelopment.watch.enabled': true,
    },
  } as Prisma.InputJsonValue;

  await prisma.tenant.create({
    data: {
      id: f.tenantA,
      name: `BDWR A ${f.stamp}`,
      slug: `bdwr-a-${f.stamp.toLowerCase()}`,
      status: 'active',
      settings,
    },
    select: { id: true },
  });
  await prisma.tenant.create({
    data: {
      id: f.tenantB,
      name: `BDWR B ${f.stamp}`,
      slug: `bdwr-b-${f.stamp.toLowerCase()}`,
      status: 'active',
      settings,
    },
    select: { id: true },
  });
  await prisma.user.create({
    data: {
      id: f.ownerA,
      clerkUserId: `user_bdwr_a_${f.stamp.toLowerCase()}`,
      email: `bdwr-a-${f.stamp.toLowerCase()}@example.invalid`,
    },
    select: { id: true },
  });
  await prisma.user.create({
    data: {
      id: f.ownerB,
      clerkUserId: `user_bdwr_b_${f.stamp.toLowerCase()}`,
      email: `bdwr-b-${f.stamp.toLowerCase()}@example.invalid`,
    },
    select: { id: true },
  });
  await prisma.tenantMembership.create({
    data: {
      id: f.membershipA,
      tenantId: f.tenantA,
      userId: f.ownerA,
      role: 'standard_user',
      status: 'active',
      joinedAt: new Date(),
    },
    select: { id: true },
  });
  await prisma.tenantMembership.create({
    data: {
      id: f.membershipB,
      tenantId: f.tenantB,
      userId: f.ownerB,
      role: 'standard_user',
      status: 'active',
      joinedAt: new Date(),
    },
    select: { id: true },
  });
  // One GLOBAL_PUBLIC active organization carrying the exact UEI identifier.
  await prisma.canonicalEntity.create({
    data: {
      id: f.orgEntity,
      tenantId: null,
      identityScope: 'global_public',
      entityType: 'organization',
      canonicalName: orgName,
      normalizedName: orgName.toLowerCase(),
      status: 'active',
      resolutionConfidence: 1,
      resolutionMethod: 'uei_exact',
    },
    select: { id: true },
  });
  await prisma.entityIdentifier.create({
    data: {
      id: f.orgIdentifier,
      entityId: f.orgEntity,
      tenantId: null,
      identityScope: 'global_public',
      identifierType: 'uei',
      identifierValue: f.uei,
      normalizedValue: f.uei,
      sourceType: 'sam_entity',
      sourceId: f.uei,
      confidence: 1,
    },
    select: { id: true },
  });
  for (const [tenantId, prospectId, ownerId, label] of [
    [f.tenantA, f.prospectA, f.ownerA, 'A'],
    [f.tenantB, f.prospectB, f.ownerB, 'B'],
  ] as const) {
    await prisma.businessDevelopmentProspect.create({
      data: {
        id: prospectId,
        tenantId,
        canonicalEntityId: f.orgEntity,
        displayName: `${orgName} (${label})`,
        stage: 'researching',
        status: 'active',
        ownerUserId: ownerId,
        watchRequested: true,
      },
      select: { id: true },
    });
  }
  // Tenant A watch ACTIVE; tenant B watch PAUSED (suppression path).
  await prisma.businessDevelopmentWatch.create({
    data: {
      id: f.watchA,
      tenantId: f.tenantA,
      prospectId: f.prospectA,
      ownerUserId: f.ownerA,
      status: 'active',
      categories: [],
    },
    select: { id: true },
  });
  await prisma.businessDevelopmentWatch.create({
    data: {
      id: f.watchB,
      tenantId: f.tenantB,
      prospectId: f.prospectB,
      ownerUserId: f.ownerB,
      status: 'paused',
      categories: [],
    },
    select: { id: true },
  });
  await prisma.businessDevelopmentWatchSourceState.create({
    data: { id: f.stateA, tenantId: f.tenantA, watchId: f.watchA, sourceFamily: 'federal_award' },
    select: { id: true },
  });
  await prisma.businessDevelopmentWatchSourceState.create({
    data: { id: f.stateB, tenantId: f.tenantB, watchId: f.watchB, sourceFamily: 'federal_award' },
    select: { id: true },
  });

  // 292 LOCAL synthetic federal-award rows for this run's unique UEI:
  // immutable UUID ids, stable unique award ids, old EQUAL action dates with
  // every 7th NULL, same agency, exact same amount. Test fixture data ONLY.
  const actionDate = new Date('2020-03-15T00:00:00.000Z');
  await prisma.federalAward.createMany({
    data: f.awardIds.map((id, i) => ({
      id,
      awardUniqueId: `${f.prefix}_${String(i + 1).padStart(4, '0')}`,
      piid: `${f.prefix}-P${String(i + 1).padStart(4, '0')}`,
      awardingAgency: 'DEPT OF DEFENSE',
      awardingSubTier: 'ARMY',
      contractorName: orgName,
      recipientUei: f.uei,
      amount: 1000000,
      actionDate: (i + 1) % 7 === 0 ? null : actionDate,
    })),
  });
  const seeded = await prisma.federalAward.count({ where: { recipientUei: f.uei } });
  assert(seeded === AWARD_ROWS, `seeded award count ${seeded} != ${AWARD_ROWS}`);

  // The mutation target is the LOWEST award id — guaranteed on page 1 of
  // every cycle (ascending keyset over the immutable id). JS string ordering
  // over ASCII-hex UUIDs matches Postgres uuid ordering.
  let lowIdx = 0;
  for (let i = 1; i < f.awardIds.length; i += 1) {
    if (f.awardIds[i] < f.awardIds[lowIdx]) lowIdx = i;
  }
  f.targetAwardId = f.awardIds[lowIdx];
  f.targetRecordId = `${f.prefix}_${String(lowIdx + 1).padStart(4, '0')}`;
  log(
    `seed: 2 enrolled tenants, 2 owners (active memberships), 1 global org + uei, 2 prospects/watches/states (A active, B paused), ${AWARD_ROWS} awards`,
  );
}

// ── State / counter reads (plain client — assertions only) ────────────────

interface BaselineShape {
  initialized?: boolean;
  records?: Record<string, unknown> | null;
  scan?: {
    phase?: string;
    pagesDone?: number;
    stagedRecords?: Record<string, unknown> | null;
  } | null;
}

interface StateSnapshot {
  health: string;
  initialized: boolean;
  records: number;
  baselinedAt: Date | null;
  lastComplete: Date | null;
  watermark: Date | null;
  phase: string | null;
  pagesDone: number;
  staged: number;
  baseline: BaselineShape | null;
}

async function readState(
  prisma: PrismaClient,
  tenantId: string,
  label: string,
): Promise<StateSnapshot> {
  const row = await prisma.businessDevelopmentWatchSourceState.findFirst({
    where: { tenantId, sourceFamily: 'federal_award' },
    select: {
      health: true,
      baselineState: true,
      baselinedAt: true,
      lastSuccessfulCompleteCheckAt: true,
      sourceWatermark: true,
    },
  });
  if (!row) fail(`source state row missing (tenant ${label})`);
  const baseline = (row.baselineState ?? null) as unknown as BaselineShape | null;
  return {
    health: row.health,
    initialized: baseline?.initialized === true,
    records: Object.keys(baseline?.records ?? {}).length,
    baselinedAt: row.baselinedAt,
    lastComplete: row.lastSuccessfulCompleteCheckAt,
    watermark: row.sourceWatermark,
    phase: baseline?.scan?.phase ?? null,
    pagesDone: baseline?.scan?.pagesDone ?? 0,
    staged: Object.keys(baseline?.scan?.stagedRecords ?? {}).length,
    baseline,
  };
}

const completionTs = (s: StateSnapshot): number => {
  assert(s.lastComplete !== null, 'completion watermark unexpectedly null');
  return s.lastComplete.getTime();
};

// ── The rehearsal ──────────────────────────────────────────────────────────

async function rehearse(prisma: PrismaClient, f: Fixtures): Promise<void> {
  // App-role assertion, exactly once: capiro_app must exist and be a plain
  // non-superuser / non-BYPASSRLS role for the RLS semantics to be real.
  const roleRows = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'capiro_app'`;
  assert(roleRows.length === 1, 'capiro_app role must exist');
  assert(
    roleRows[0].rolsuper === false && roleRows[0].rolbypassrls === false,
    'capiro_app must be non-superuser and non-BYPASSRLS',
  );

  // withTenant/withSystem over Prisma interactive transactions with the
  // repository's audited semantics: SET LOCAL ROLE capiro_app, then
  // app.bypass_rls off + app.current_tenant (tenant) / app.bypass_rls on
  // (system). The projection delegates read the existing GLOBAL tables
  // through the same client handle (the CLI's direct-delegate pattern).
  const db: BizDevWatchRunnerDb = {
    withTenant: <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE capiro_app`;
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'off', true)`;
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
    withSystem: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE capiro_app`;
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
  };
  const projections = prisma as unknown as BizDevProjectionDb;
  const config: BizDevWatchRunConfig = {
    enabled: true,
    sourceFamilies: ['federal_award'],
    maxWatchesPerRun: 2,
    maxRecordsPerSource: PAGE_SIZE,
    leaseSeconds: 300,
  };
  const runOnce = async () => {
    const metrics = await runBizDevWatchEvaluation(db, projections, config);
    assert(metrics.failed === 0, `runner reported ${metrics.failed} failed sources`);
    assert(
      metrics.checked === 2,
      `runner claimed ${metrics.checked} sources instead of the two fixtures`,
    );
    return metrics;
  };

  const alertsOf = (t: string) => prisma.businessDevelopmentAlert.count({ where: { tenantId: t } });
  const deliveriesOf = (t: string) =>
    prisma.businessDevelopmentAlertDelivery.count({ where: { tenantId: t } });
  const watchActivitiesOf = (t: string) =>
    prisma.businessDevelopmentProspectActivity.count({ where: { tenantId: t, kind: 'watch' } });

  let runs = 0;
  let a = await readState(prisma, f.tenantA, 'A');
  let b = await readState(prisma, f.tenantB, 'B');

  // ── Stage 1: quiet resumable initial scan (both sources) ─────────────────
  while (!(a.initialized && b.initialized)) {
    assert(runs < MAX_RUNS, `initial scan exceeded the run budget (${MAX_RUNS})`);
    assert(
      a.baselinedAt === null && a.watermark === null,
      'tenant A: pre-completion page carried a completion marker',
    );
    assert(
      b.baselinedAt === null && b.watermark === null,
      'tenant B: pre-completion page carried a completion marker',
    );
    const m = await runOnce();
    runs += 1;
    a = await readState(prisma, f.tenantA, 'A');
    b = await readState(prisma, f.tenantB, 'B');
    if (!a.initialized) {
      // Real constraint proof: staged checkpoint JSON persisted with
      // baselinedAt NULL, staged records growing page by page.
      assert(
        a.baselinedAt === null && a.watermark === null,
        'tenant A: mid-cycle page advanced a completion marker',
      );
      if (a.pagesDone > 0) {
        assert(
          a.staged === Math.min(a.pagesDone * PAGE_SIZE, AWARD_ROWS),
          `tenant A: staged records ${a.staged} after ${a.pagesDone} pages`,
        );
      }
    }
    if (!b.initialized) {
      assert(
        b.baselinedAt === null && b.watermark === null,
        'tenant B: mid-cycle page advanced a completion marker',
      );
    }
    assert(
      (await alertsOf(f.tenantA)) === 0 && (await alertsOf(f.tenantB)) === 0,
      'quiet initial scan produced an alert',
    );
    log(
      `run ${runs}: A pages=${a.pagesDone} staged=${a.staged} health=${a.health} | B pages=${b.pagesDone} staged=${b.staged} health=${b.health} | metrics=${JSON.stringify({ checked: m.checked, partial: m.partial, delivered: m.delivered, suppressed: m.suppressed })}`,
    );
  }
  for (const [s, label] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    assert(
      s.initialized && s.records === AWARD_ROWS,
      `tenant ${label}: initialized records ${s.records} != ${AWARD_ROWS}`,
    );
    assert(
      s.health === 'healthy' && s.baselinedAt !== null && s.watermark !== null,
      `tenant ${label}: final initial-cycle completion shape`,
    );
    assert(s.phase === 'cycle', `tenant ${label}: scan phase after initial cycle`);
  }
  assert(
    (await alertsOf(f.tenantA)) === 0 && (await alertsOf(f.tenantB)) === 0,
    'baseline pass produced alerts',
  );
  assert(
    (await deliveriesOf(f.tenantA)) === 0 && (await deliveriesOf(f.tenantB)) === 0,
    'baseline pass produced deliveries',
  );
  assert(
    (await watchActivitiesOf(f.tenantA)) === 0 && (await watchActivitiesOf(f.tenantB)) === 0,
    'baseline pass produced activities',
  );
  log(
    `PASS stage 1: both sources quietly baselined with ${AWARD_ROWS} records each (${runs} runs)`,
  );

  // ── Stage 2: one material amount change (A→B) on the first-page record ──
  const watermarkBeforeChange = a.lastComplete;
  assert(watermarkBeforeChange !== null, 'tenant A watermark missing before change');
  await prisma.federalAward.update({ where: { id: f.targetAwardId }, data: { amount: 1000001 } });
  let alertsA = await alertsOf(f.tenantA);
  while (alertsA === 0) {
    assert(runs < MAX_RUNS, 'material change not detected within the run budget');
    await runOnce();
    runs += 1;
    a = await readState(prisma, f.tenantA, 'A');
    b = await readState(prisma, f.tenantB, 'B');
    alertsA = await alertsOf(f.tenantA);
  }
  assert(
    alertsA === 1,
    `tenant A: expected exactly 1 alert after one material change (got ${alertsA})`,
  );
  assert((await deliveriesOf(f.tenantA)) === 1, 'tenant A: expected exactly 1 in-app delivery');
  assert((await watchActivitiesOf(f.tenantA)) === 1, 'tenant A: expected exactly 1 alert activity');
  const alert = await prisma.businessDevelopmentAlert.findFirst({
    where: { tenantId: f.tenantA },
    select: {
      changeKind: true,
      materiality: true,
      sourceFamily: true,
      recordId: true,
      fingerprint: true,
      dedupeKey: true,
    },
  });
  assert(alert !== null, 'tenant A alert row missing');
  assert(
    alert.changeKind === 'material_update' &&
      alert.materiality === 'high' &&
      alert.sourceFamily === 'federal_award',
    'alert classification (material_update/high/federal_award)',
  );
  assert(alert.recordId === f.targetRecordId, 'alert recordId mismatch');
  assert(/^[0-9a-f]{64}$/.test(alert.fingerprint), 'alert fingerprint shape');
  assert(
    alert.dedupeKey === `federal_award:${f.targetRecordId}:${alert.fingerprint}`,
    'alert dedupe key shape',
  );
  assert(
    (await alertsOf(f.tenantB)) === 0 && (await deliveriesOf(f.tenantB)) === 0,
    'tenant B: paused watch must produce zero alerts/deliveries',
  );
  const bRecord = (
    b.baseline?.records as Record<string, { suppressionReason?: string } | undefined> | undefined
  )?.[f.targetRecordId];
  assert(
    bRecord?.suppressionReason === 'watch_paused',
    'tenant B: persisted watch_paused suppression missing on the changed record',
  );
  assert(
    a.lastComplete !== null && a.lastComplete.getTime() === watermarkBeforeChange.getTime(),
    'tenant A: watermark advanced on a non-final reconciliation page',
  );
  log(
    `PASS stage 2: material change detected at run ${runs} (A: 1 alert/1 delivery/1 activity; B: suppressed watch_paused, 0 alerts/deliveries)`,
  );

  // ── Stage 3: unchanged replay — full cycles, zero additional records ────
  let wm = completionTs(a);
  while (completionTs(a) === wm) {
    assert(runs < MAX_RUNS, 'post-change cycle did not complete within the run budget');
    await runOnce();
    runs += 1;
    a = await readState(prisma, f.tenantA, 'A');
  }
  assert(
    (await alertsOf(f.tenantA)) === 1 &&
      (await deliveriesOf(f.tenantA)) === 1 &&
      (await watchActivitiesOf(f.tenantA)) === 1,
    'post-change cycle duplicated records for tenant A',
  );
  wm = completionTs(a);
  while (completionTs(a) === wm) {
    assert(runs < MAX_RUNS, 'replay cycle did not complete within the run budget');
    await runOnce();
    runs += 1;
    a = await readState(prisma, f.tenantA, 'A');
  }
  assert(
    (await alertsOf(f.tenantA)) === 1,
    'unchanged replay produced additional alerts for tenant A',
  );
  assert(
    (await alertsOf(f.tenantB)) === 0 && (await deliveriesOf(f.tenantB)) === 0,
    'unchanged replay produced records for tenant B',
  );
  assert(runs <= MAX_RUNS, `run budget exceeded (${runs} > ${MAX_RUNS})`);
  log(`PASS stage 3: unchanged replay complete, zero additional records (total runs ${runs})`);

  async function completeCycle(): Promise<void> {
    const priorA = await readState(prisma, f.tenantA, 'A');
    const priorB = await readState(prisma, f.tenantB, 'B');
    for (let page = 0; page < 20; page += 1) {
      assert(runs < MAX_RUNS, 'extended scenarios exceeded the bounded run budget');
      await runOnce();
      runs += 1;
      a = await readState(prisma, f.tenantA, 'A');
      b = await readState(prisma, f.tenantB, 'B');
      for (const [current, prior] of [
        [a, priorA],
        [b, priorB],
      ]) {
        if (current.health !== 'healthy') {
          assert(
            current.lastComplete?.getTime() === prior.lastComplete?.getTime(),
            'extended cycle advanced last-complete marker before final page',
          );
          assert(
            current.watermark?.getTime() === prior.watermark?.getTime(),
            'extended cycle advanced source watermark before final page',
          );
        }
      }
      if (a.health === 'healthy' && b.health === 'healthy') return;
    }
    fail('extended reconciliation cycle exceeded 20 pages');
  }
  for (const [index, amount] of [1000000, 1000001].entries()) {
    await prisma.federalAward.update({
      where: { id: f.targetAwardId },
      data: { amount },
      select: { id: true },
    });
    await completeCycle();
    const expected = index + 2;
    assert(
      (await alertsOf(f.tenantA)) === expected &&
        (await deliveriesOf(f.tenantA)) === expected &&
        (await watchActivitiesOf(f.tenantA)) === expected,
      'legitimate recurring material change was lost or duplicated',
    );
    await completeCycle();
    assert(
      (await alertsOf(f.tenantA)) === expected &&
        (await deliveriesOf(f.tenantA)) === expected &&
        (await watchActivitiesOf(f.tenantA)) === expected,
      'unchanged recurring-state replay duplicated records',
    );
    assert(
      (await alertsOf(f.tenantB)) === 0 && (await deliveriesOf(f.tenantB)) === 0,
      'paused tenant received a recurring material change',
    );
  }
  const ledger = await prisma.businessDevelopmentAlert.findMany({
    where: { tenantId: f.tenantA },
    select: { dedupeKey: true },
  });
  assert(
    new Set(ledger.map((row) => row.dedupeKey)).size === 3,
    'recurring changes reused a dedupe key',
  );
  log(
    'PASS stage 4: A→B→A→B = 3 unique alerts/deliveries/activities; replays quiet, paused tenant zero',
  );

  await runOnce(); // Page 1 accepted before the owner loses access.
  runs += 1;
  const beforeRevoke = await readState(prisma, f.tenantA, 'A');
  assert(beforeRevoke.health === 'partial', 'revocation scenario must start between pages');
  const secondPageId = [...f.awardIds].sort()[60];
  assert(Boolean(secondPageId), 'second-page fixture missing');
  await prisma.federalAward.update({
    where: { id: secondPageId },
    data: { amount: 2000000 },
    select: { id: true },
  });
  await prisma.tenantMembership.update({
    where: { id: f.membershipA },
    data: { status: 'removed' },
    select: { id: true },
  });
  await runOnce();
  runs += 1;
  const afterRevoke = await readState(prisma, f.tenantA, 'A');
  assert(afterRevoke.health === 'pending', 'revoked owner did not put source pending');
  assert(
    JSON.stringify(afterRevoke.baseline) === JSON.stringify(beforeRevoke.baseline),
    'revoked owner advanced or changed accepted checkpoint',
  );
  assert(
    afterRevoke.lastComplete?.getTime() === beforeRevoke.lastComplete?.getTime() &&
      afterRevoke.watermark?.getTime() === beforeRevoke.watermark?.getTime(),
    'revoked owner advanced a completion marker',
  );
  assert(
    (await alertsOf(f.tenantA)) === 3 && (await deliveriesOf(f.tenantA)) === 3,
    'revoked owner received a new alert or delivery',
  );
  const released = await prisma.businessDevelopmentWatchSourceState.findUnique({
    where: { id: f.stateA },
    select: { leaseToken: true, leaseUntil: true },
  });
  assert(
    released?.leaseToken === null && released.leaseUntil === null,
    'pending source retained its lease',
  );
  log(
    'PASS stage 5: owner revocation preserves progress and completion markers, delivers nothing, releases lease',
  );

  for (const [own, foreign, expected] of [
    [f.tenantA, f.tenantB, 3],
    [f.tenantB, f.tenantA, 0],
  ] as const) {
    await db.withTenant(own, async (tx) => {
      assert(
        (await tx.businessDevelopmentAlert.count({ where: { tenantId: foreign } })) === 0,
        'application role saw a foreign tenant alert',
      );
      assert(
        (await tx.businessDevelopmentAlertDelivery.count({ where: { tenantId: foreign } })) === 0,
        'application role saw a foreign tenant delivery',
      );
      assert(
        (await tx.businessDevelopmentAlertDelivery.count()) === expected,
        'application-role unfiltered delivery visibility was not tenant scoped',
      );
    });
  }
  log(`PASS stage 6: real app-role reads are tenant isolated (total bounded runs ${runs})`);
}

// ── Cleanup: ONLY exact generated fixture ids, FK-ordered ──────────────────

async function cleanup(prisma: PrismaClient, f: Fixtures): Promise<void> {
  const parts: string[] = [];
  parts.push(
    `awards=${(await prisma.federalAward.deleteMany({ where: { id: { in: f.awardIds } } })).count}`,
  );
  // Tenant cascade removes memberships, prospects, watches, source states,
  // alerts, deliveries and activities of these two tenants only.
  parts.push(
    `tenants=${(await prisma.tenant.deleteMany({ where: { id: { in: [f.tenantA, f.tenantB] } } })).count}`,
  );
  parts.push(
    `identifiers=${(await prisma.entityIdentifier.deleteMany({ where: { id: f.orgIdentifier } })).count}`,
  );
  parts.push(
    `entities=${(await prisma.canonicalEntity.deleteMany({ where: { id: f.orgEntity } })).count}`,
  );
  parts.push(
    `users=${(await prisma.user.deleteMany({ where: { id: { in: [f.ownerA, f.ownerB] } } })).count}`,
  );
  log(`cleanup: ${parts.join(' ')}`);
}

// ── Driver ────────────────────────────────────────────────────────────────

async function orchestrate(): Promise<void> {
  const url = requireRehearsalUrl(); // BEFORE PrismaClient construction
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const plan = makePlan();
  try {
    const database = await prisma.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_database() AS name`;
    assert(
      database[0]?.name === ALLOWED_DATABASE,
      'connected database identity differs from the local allowlist',
    );
    assert(
      (await prisma.businessDevelopmentWatchSourceState.count()) === 0,
      'dedicated rehearsal database already contains watch source states; refusing concurrent/unrelated scans',
    );
    await seed(prisma, plan);
    await rehearse(prisma, plan);
    log('PASS: watch paging rehearsal completed all bounded assertions');
  } finally {
    try {
      await cleanup(prisma, plan);
    } catch (error) {
      process.stderr.write(`cleanup incomplete: ${sanitize(error)}\n`);
      process.exitCode = 1;
    }
    await prisma.$disconnect();
  }
}

void orchestrate().then(
  () => {
    if (process.exitCode !== 1) process.exitCode = 0;
  },
  (error: unknown) => {
    process.stderr.write(`FAIL: ${sanitize(error)}\n`);
    process.exitCode = 1;
  },
);
